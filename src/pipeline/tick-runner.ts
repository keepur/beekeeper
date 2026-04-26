import { decideAction } from "./action-dispatcher.js";
import { Budget } from "./budget.js";
import { LinearClient } from "./linear-client.js";
import { claim, logSpawn, newRunId, release } from "./mutex.js";
import { spawnSubagent, type SpawnInput, type SpawnResult } from "./subagent-spawn.js";
import { handleDrafting } from "./handlers/drafting.js";
import { handlePickup } from "./handlers/pickup.js";
import { handleReview } from "./handlers/review.js";
import { handleMerge } from "./handlers/merge.js";
import type { HandlerContext, HandlerResult } from "./handlers/types.js";
import type { ActionDecision, TickReport, TickReportEntry, TicketState } from "./types.js";
import type { PipelineConfig } from "../types.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("pipeline-tick");

export interface RunTickOptions {
  /** "<EPIC-ID>" | "<TICKET-ID>" | "--all" */
  scope: string;
  dryRun: boolean;
  spawnBudget: number;
  actionBudget: number;
  includeBlocked: boolean;
  config: PipelineConfig;
  apiKey: string;
  /** Injected for tests; defaults to real LinearClient + real spawnSubagent. */
  clientFactory?: (apiKey: string, teamKey: string) => LinearClient;
  spawnFn?: (input: SpawnInput) => Promise<SpawnResult>;
}

const DEFAULT_SPAWN_BUDGET = 3;
const DEFAULT_ACTION_BUDGET = 25;

export async function runTick(opts: RunTickOptions): Promise<TickReport> {
  const runId = newRunId();
  const startedAt = new Date().toISOString();
  const client = (opts.clientFactory ?? defaultClientFactory)(opts.apiKey, opts.config.linearTeamKey);
  const spawn = opts.spawnFn ?? spawnSubagent;
  const budget = new Budget(
    opts.spawnBudget ?? DEFAULT_SPAWN_BUDGET,
    opts.actionBudget ?? DEFAULT_ACTION_BUDGET,
  );

  const identifiers = await resolveScope(client, opts.scope);
  log.info("Tick scope resolved", { runId, scope: opts.scope, ticketCount: identifiers.length });

  const entries: TickReportEntry[] = [];
  const blocked: TickReportEntry[] = [];

  for (const id of identifiers) {
    let ticket: TicketState;
    try {
      ticket = await client.getTicketState(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      entries.push({
        ticket: id,
        decision: { kind: "skip", reason: `read failed: ${msg}`, spawns: false },
        outcome: "skipped",
        detail: msg,
      });
      continue;
    }

    const decision = decideAction(ticket);

    if (decision.kind === "report-only") {
      const entry: TickReportEntry = { ticket: id, decision, outcome: "report-only", detail: decision.reason };
      if (opts.includeBlocked) blocked.push(entry);
      continue;
    }

    if (decision.kind === "skip") {
      entries.push({ ticket: id, decision, outcome: "skipped", detail: decision.reason });
      continue;
    }

    if (decision.spawns && !budget.tryConsumeSpawn()) {
      entries.push({
        ticket: id,
        decision,
        outcome: "skipped",
        detail: "spawn-budget exhausted",
      });
      continue;
    }
    if (!decision.spawns && !budget.tryConsumeAction()) {
      entries.push({
        ticket: id,
        decision,
        outcome: "skipped",
        detail: "action-budget exhausted",
      });
      break; // hard stop — no more action slots for any ticket.
    }

    if (opts.dryRun) {
      entries.push({ ticket: id, decision, outcome: "skipped", detail: "dry-run" });
      continue;
    }

    const claimResult = await claim(client, id, runId, decision.kind);
    if (!claimResult.acquired) {
      entries.push({
        ticket: id,
        decision,
        outcome: "skipped",
        detail: `lost lock contention (held by ${claimResult.contendedBy ?? "unknown"})`,
      });
      continue;
    }

    let result: HandlerResult;
    try {
      result = await runHandler(client, ticket, decision, opts.config, spawn);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Handler failed", { runId, ticket: id, error: msg });
      result = { outcome: "skipped", detail: `handler error: ${msg}` };
    }

    if (result.agentId) {
      try {
        await logSpawn(client, id, runId, result.agentId);
      } catch (err) {
        log.warn("Spawn-log write failed", { runId, ticket: id, error: String(err) });
      }
    }

    entries.push({ ticket: id, decision, outcome: result.outcome, detail: result.detail });
    // Best-effort release. If the release write itself fails (e.g., transient
    // Linear API blip after the handler ran), log and move on — the 60s claim
    // TTL bounds how long the lock persists. Do not let a release failure
    // mask the per-ticket outcome we already recorded.
    try {
      await release(client, id, runId, {
        outcome: result.outcome === "transitioned" ? "transitioned"
                : result.outcome === "spawned" ? "spawned"
                : "skipped",
      });
    } catch (err) {
      log.warn("Lock release write failed; lock will clear on TTL", {
        runId, ticket: id, error: String(err),
      });
    }
  }

  return {
    runId,
    scope: opts.scope,
    startedAt,
    endedAt: new Date().toISOString(),
    budget: budget.summary(),
    entries,
    blocked,
  };
}

function defaultClientFactory(apiKey: string, teamKey: string): LinearClient {
  return new LinearClient({ apiKey, teamKey });
}

async function resolveScope(client: LinearClient, scope: string): Promise<string[]> {
  if (scope === "--all") return client.listTeamPipelineIssues();
  // Treat any value with team-prefix-N pattern as a single ticket; for an
  // epic, expand to its children. We try children first; if the API returns
  // none, treat the scope as a single-ticket reference.
  const children = await safeListChildren(client, scope);
  // When scope is an epic, expand to its children only — do NOT include the
  // epic itself in the processed list. Epics typically have no PR of their own
  // and would otherwise consume an action-budget slot for a guaranteed skip,
  // and produce a spurious entry in the report.
  if (children.length > 0) return children;
  return [scope];
}

async function safeListChildren(client: LinearClient, identifier: string): Promise<string[]> {
  try {
    return await client.listChildren(identifier);
  } catch {
    return [];
  }
}

async function runHandler(
  client: LinearClient,
  ticket: TicketState,
  decision: ActionDecision,
  config: PipelineConfig,
  spawn: (input: SpawnInput) => Promise<SpawnResult>,
): Promise<HandlerResult> {
  const ctx: HandlerContext = { client, ticket, decision, config, spawn };

  switch (decision.kind) {
    case "draft-spec":
    case "draft-plan":
    case "spec-review":
    case "plan-review":
      return handleDrafting(ctx);
    case "pickup":
      return handlePickup(ctx);
    case "code-review": {
      const result = await handleReview(ctx);
      // APPROVE result → route immediately to merge in the same tick.
      if (result.outcome === "transitioned" && result.detail?.includes("APPROVE")) {
        return handleMerge(ctx);
      }
      return result;
    }
    case "merge":
      return handleMerge(ctx);
    case "advance": {
      const next = (decision.payload?.nextState as string) ?? "Ready";
      await client.setState(ticket.id, next as Parameters<typeof client.setState>[1]);
      return { outcome: "transitioned", detail: `advanced to ${next}` };
    }
    default:
      return { outcome: "skipped", detail: `no handler for ${decision.kind}` };
  }
}
