import { createLogger } from "../../logging/logger.js";
import type { LinearClient } from "../linear-client.js";
import { REVIEWER_OUTPUT_HEAD } from "../handlers/review.js";
import { OPEN_QUESTIONS_OPEN } from "./sentinel.js";
import type { TicketState, TicketComment, TicketAttachment } from "../types.js";
import type { SubagentKind } from "../subagent-spawn.js";

const log = createLogger("pipeline-recovery");

const TICK_SPAWN_LOG_RE = /^tick-spawn-log:\s+runId=(\S+)\s+agentId=(\S+)\s+kind=(\S+)/;
const SELF_WRITE_RE = /^pipeline-tick: subagent (\S+) was lost in a Beekeeper server restart/;

const PR_URL_RE = /github\.com\/[^/]+\/[^/]+\/pull\/\d+/;
const BLOCK_LABEL_RE = /^block:/;

export interface RecoveryOptions {
  linear: LinearClient;
  /** Now() — tests inject a fixed clock. */
  now?: () => number;
  /** ms — spawn-log lookback window (default 24h). */
  windowMs?: number;
  /** Active orchestrator job map at boot — used to skip resurrection. */
  activeAgentIds: Set<string>;
}

export interface ParsedSpawnLog {
  comment: TicketComment;
  runId: string;
  agentId: string;
  kind: SubagentKind;
}

/**
 * Run the startup recovery scan exactly once on Beekeeper boot, before HTTP
 * server.listen(). For each ticket on the configured team with a recent
 * `tick-spawn-log` whose agentId is NOT in `activeAgentIds`, check for a
 * kind-specific completion signal posted AFTER the spawn-log timestamp; if
 * none and not already self-written, post `block:human` and label.
 */
export async function runStartupRecovery(opts: RecoveryOptions): Promise<{ scanned: number; orphaned: number }> {
  const now = opts.now ? opts.now() : Date.now();
  const windowMs = opts.windowMs ?? 24 * 60 * 60_000;
  const cutoffMs = now - windowMs;

  const tickets = await opts.linear.listTeamPipelineIssues();
  log.info("recovery: scanning team pipeline tickets", { count: tickets.length, windowHours: windowMs / 3_600_000 });

  let orphaned = 0;
  for (const id of tickets) {
    let ticket: TicketState;
    try {
      ticket = await opts.linear.getTicketState(id);
    } catch (err) {
      log.warn("recovery: failed to read ticket; skipping", { id, error: String(err) });
      continue;
    }
    const spawn = mostRecentSpawnLog(ticket.comments, cutoffMs);
    if (!spawn) continue;
    if (opts.activeAgentIds.has(spawn.agentId)) continue;
    if (alreadySelfWritten(ticket.comments, spawn.agentId)) {
      log.debug("recovery: idempotency self-write present, skip", { ticketId: id, agentId: spawn.agentId });
      continue;
    }
    const spawnAt = new Date(spawn.comment.createdAt).getTime();
    if (hasCompletionSignal(ticket, spawn, spawnAt)) continue;

    log.info("recovery: orphan detected", { ticketId: id, agentId: spawn.agentId, kind: spawn.kind });
    try {
      await opts.linear.addComment(
        ticket.id,
        `pipeline-tick: subagent ${spawn.agentId} was lost in a Beekeeper server restart at ${new Date(now).toISOString()}; ticket marked block:human for operator review.`,
      );
      if (!ticket.labels.includes("block:human")) {
        await opts.linear.addLabel(ticket.id, "block:human");
      }
      orphaned++;
    } catch (err) {
      log.error("recovery: write failed", { ticketId: id, agentId: spawn.agentId, error: String(err) });
    }
  }

  log.info("recovery: complete", { scanned: tickets.length, orphaned });
  return { scanned: tickets.length, orphaned };
}

function mostRecentSpawnLog(comments: TicketComment[], cutoffMs: number): ParsedSpawnLog | undefined {
  let best: ParsedSpawnLog | undefined;
  for (const c of comments) {
    const m = c.body.trim().match(TICK_SPAWN_LOG_RE);
    if (!m) continue;
    const at = new Date(c.createdAt).getTime();
    if (at < cutoffMs) continue;
    if (!best || new Date(best.comment.createdAt).getTime() < at) {
      best = { comment: c, runId: m[1], agentId: m[2], kind: m[3] as SubagentKind };
    }
  }
  return best;
}

function alreadySelfWritten(comments: TicketComment[], agentId: string): boolean {
  for (const c of comments) {
    const m = c.body.trim().match(SELF_WRITE_RE);
    if (m && m[1] === agentId) return true;
  }
  return false;
}

function hasCompletionSignal(
  ticket: TicketState,
  spawn: ParsedSpawnLog,
  spawnAtMs: number,
): boolean {
  // Universal fallback: any block:* label set after spawn-log? (We only know
  // current label set, not when it was set, so we treat ANY current `block:*`
  // as "operator already engaged" — conservative, prevents spam.)
  if (ticket.labels.some((l) => BLOCK_LABEL_RE.test(l))) return true;

  const postSpawnComments = ticket.comments.filter(
    (c) => new Date(c.createdAt).getTime() > spawnAtMs,
  );

  // Self-write sentinel (from a prior recovery run for this same agentId)
  if (postSpawnComments.some((c) => {
    const m = c.body.trim().match(SELF_WRITE_RE);
    return !!m && m[1] === spawn.agentId;
  })) return true;

  switch (spawn.kind) {
    case "draft-spec":
    case "draft-plan": {
      // Sentinel comment OR drafting-state transition (state already off the
      // drafting state) after spawn-log.
      if (postSpawnComments.some((c) => c.body.includes(OPEN_QUESTIONS_OPEN))) return true;
      // State-out-of-drafting: if current state is something other than
      // "Spec Drafting" or "Plan Drafting", the drafter probably finished and
      // a transition fired. (We don't have state-history; current-state is
      // best-effort.)
      if (ticket.state !== "Spec Drafting" && ticket.state !== "Plan Drafting") return true;
      return false;
    }
    case "code-review": {
      // Reviewer JSON verdict block (REVIEWER_OUTPUT_HEAD regex) in any post-spawn comment.
      if (postSpawnComments.some((c) => REVIEWER_OUTPUT_HEAD.test(c.body))) return true;
      return false;
    }
    case "implementer": {
      // PR attachment created after spawn-log
      const recentPr = ticket.attachments.some(
        (a: TicketAttachment) =>
          PR_URL_RE.test(a.url) && new Date(a.createdAt).getTime() > spawnAtMs,
      );
      if (recentPr) return true;
      // OR state-out-of "In Progress"
      if (ticket.state !== "In Progress") return true;
      return false;
    }
    default:
      return false;
  }
}
