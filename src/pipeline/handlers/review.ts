import { parseReviewerOutput } from "../reviewer-parser.js";
import { buildReviewerPrompt } from "../prompts/reviewer.js";
import { resolveRepo } from "../repo-resolver.js";
import { blockHuman, type HandlerContext, type HandlerResult } from "./types.js";
import type { TicketAttachment, TicketComment } from "../types.js";

const REVIEWER_OUTPUT_HEAD = /```json\s*\{[\s\S]*?"verdict"\s*:/;
// Any spawn-log on an In Review ticket implies a reviewer is in flight.
// (Drafting/pickup/merge spawns happen in earlier states, not In Review.)
// The actual spawn-log comment format written by mutex.logSpawn is
// `tick-spawn-log: runId=<id> agentId=<id>` — no `kind=` field.
const SPAWN_REVIEWER_PREFIX = /^tick-spawn-log:/;

function findPrAttachment(attachments: TicketAttachment[]): TicketAttachment | undefined {
  return attachments.find((a) => /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(a.url));
}

function findReviewerOutput(comments: TicketComment[]): string | undefined {
  // Most recent comment with a JSON verdict block wins.
  for (let i = comments.length - 1; i >= 0; i--) {
    if (REVIEWER_OUTPUT_HEAD.test(comments[i].body)) return comments[i].body;
  }
  return undefined;
}

function hasReviewerSpawnLog(comments: TicketComment[]): boolean {
  return comments.some((c) => SPAWN_REVIEWER_PREFIX.test(c.body.trim()));
}

/**
 * Review handler — handles `code-review` for In Progress and In Review states.
 *
 *   In Progress + no PR → wait (skip with detail).
 *   In Progress + PR → transition to In Review.
 *   In Review + no reviewer spawn-log → launch reviewer.
 *   In Review + reviewer output present → parse:
 *     APPROVE → mark for merge (caller routes to merge handler).
 *     REQUEST CHANGES → block:human (Phase 1 keeps the loop simple — the
 *       fix-inline / file-follow-up routing is Phase 2).
 */
export async function handleReview(ctx: HandlerContext): Promise<HandlerResult> {
  if (ctx.ticket.state === "In Progress") {
    const pr = findPrAttachment(ctx.ticket.attachments);
    if (!pr) {
      return { outcome: "skipped", detail: "in progress — no PR attached yet" };
    }
    await ctx.client.setState(ctx.ticket.id, "In Review");
    return { outcome: "transitioned", detail: "PR attached → In Review" };
  }

  // In Review
  const reviewerOutput = findReviewerOutput(ctx.ticket.comments);
  if (!reviewerOutput) {
    if (hasReviewerSpawnLog(ctx.ticket.comments)) {
      return { outcome: "skipped", detail: "reviewer in flight — waiting for output" };
    }
    const repo = resolveRepo(ctx.ticket, ctx.config);
    if (!repo) {
      return blockHuman(ctx.client, ctx.ticket, "could not resolve repo for reviewer");
    }
    const pr = findPrAttachment(ctx.ticket.attachments);
    if (!pr) {
      return blockHuman(ctx.client, ctx.ticket, "ticket is In Review but has no PR attachment");
    }
    const prompt = buildReviewerPrompt({
      ticketId: ctx.ticket.identifier,
      repoPath: repo.path,
      prUrl: pr.url,
    });
    const spawnResult = await ctx.spawn({
      kind: "code-review",
      prompt,
      repoPath: repo.path,
      ticketId: ctx.ticket.identifier,
    });
    return { outcome: "spawned", detail: "reviewer launched", agentId: spawnResult.agentId };
  }

  // Reviewer output present → parse and decide.
  const parsed = parseReviewerOutput(reviewerOutput);
  if (parsed.verdict === "APPROVE") {
    // Caller (tick-runner) sees this outcome+detail and routes to merge handler.
    return { outcome: "transitioned", detail: "APPROVE — ready to merge" };
  }
  // REQUEST CHANGES → Phase 1: block:human with finding summary.
  const summary = parsed.findings
    .map((f, i) => `  ${i + 1}. [${f.severity}] ${f.body}${f.disposition ? ` (${f.disposition})` : ""}`)
    .join("\n");
  return blockHuman(
    ctx.client,
    ctx.ticket,
    `reviewer requested changes:\n${summary}`,
  );
}
