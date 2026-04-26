import type { SubagentKind } from "../subagent-spawn.js";

export type JobState = "running" | "completed" | "interrupted" | "stalled" | "error";

/** One-way reason set by handlers; finally block translates to JobState. */
export type TerminalReason =
  | "completed"
  | "error"
  | "interrupted"
  | "stalled-open-questions"
  | "stalled-ask-user-question"
  | "stalled-timeout";

/** Buffered per-job message — minimal projection of SDKMessage we keep around. */
export interface PipelineJobMessage {
  type: string;            // SDKMessage `type` field
  receivedAt: string;      // ISO
  /** Raw SDK payload (typed loosely — full structure preserved for live-tail). */
  payload: Record<string, unknown>;
}

export interface PipelineJob {
  agentId: string;          // "agent-${ulid()}"
  ticketId: string;         // e.g., "KPR-79"
  kind: SubagentKind;
  cwd: string;
  startedAt: string;        // ISO
  state: JobState;
  lastMessageAt: string;    // ISO
  messages: PipelineJobMessage[];
  /** Set by handlers; `state` is derived from this in the finally block. */
  _terminalReason?: TerminalReason;
  /** True when an explicit cancel() was requested (so iterator-throw becomes "interrupted", not "error"). */
  cancelRequested?: boolean;
  /** Tracks soft-tier stall warning idempotency: when set, a fresh message resets it. */
  softWarnedAt?: string;
  /** Final result, populated by the SDK `result` message. */
  result?: { ok: boolean; reason: string };
}

export interface SpawnInput {
  kind: SubagentKind;
  prompt: string;
  repoPath: string;
  ticketId: string;
}

export interface SpawnResult {
  agentId: string;
  status: "started";
  ticketId: string;
  startedAt: string;
}

export class TicketBusyError extends Error {
  constructor(public readonly ticketId: string, public readonly existingAgentId: string) {
    super(`Ticket ${ticketId} already has running job ${existingAgentId}`);
    this.name = "TicketBusyError";
  }
}
