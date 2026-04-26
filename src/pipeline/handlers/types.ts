import type { LinearClient } from "../linear-client.js";
import type { ActionDecision, PipelineLabel, TicketState } from "../types.js";
import type { PipelineConfig } from "../../types.js";
import type { SpawnInput, SpawnResult } from "../subagent-spawn.js";

export interface HandlerResult {
  outcome: "spawned" | "transitioned" | "blocked" | "skipped";
  detail?: string;
  /** Returned when a subagent was launched, for `tick-spawn-log` audit. */
  agentId?: string;
}

/**
 * Common context every handler receives. The `spawn` function is injected so
 * tests can substitute a mock without spinning up `claude`.
 */
export interface HandlerContext {
  client: LinearClient;
  ticket: TicketState;
  decision: ActionDecision;
  config: PipelineConfig;
  spawn: (input: SpawnInput) => Promise<SpawnResult>;
}

/** Helper: apply `block:human` with a comment. Used by every handler on hard failures. */
export async function blockHuman(
  client: LinearClient,
  ticket: TicketState,
  reason: string,
): Promise<HandlerResult> {
  const label: PipelineLabel = "block:human";
  if (!ticket.labels.includes(label)) {
    await client.addLabel(ticket.id, label);
  }
  await client.addComment(ticket.id, `block:human — ${reason}`);
  return { outcome: "blocked", detail: reason };
}
