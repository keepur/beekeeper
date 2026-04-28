import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../../logging/logger.js";
import type { LinearClient } from "../linear-client.js";
import { detectOpenQuestions } from "./sentinel.js";
import type { PipelineJob, JobState, TerminalReason } from "./types.js";

const log = createLogger("pipeline-consume");

export interface ConsumeMessagesContext {
  job: PipelineJob;
  activeQuery: Query;
  linear: LinearClient;
  ticketIssueId: string;
  /** Cancel hook called by the sentinel handler (delegates to PipelineOrchestrator.cancel). */
  cancel: () => Promise<void>;
  /** Called once when state transitions to terminal (any reason). Used by orchestrator to schedule TTL eviction. */
  onTerminal?: (job: PipelineJob) => void;
}

const TERMINAL_TO_STATE: Record<TerminalReason, JobState> = {
  completed: "completed",
  error: "error",
  interrupted: "interrupted",
  "stalled-open-questions": "stalled",
  "stalled-ask-user-question": "stalled",
  "stalled-timeout": "stalled",
};

/**
 * Drain the SDKMessage iterator. Updates lastMessageAt on every message. On
 * `assistant`/`stream_event` text, accumulates into a per-job text buffer and
 * runs the open-questions sentinel matcher. On `result`, captures success/cost.
 *
 * State assignment is ONE-WAY: handlers set `_terminalReason`; the finally
 * block reads `_terminalReason` and writes `state` exactly once. This is the
 * race-free fix for cancel-induced iterator throws clashing with sentinel
 * handlers.
 */
export async function consumeMessages(ctx: ConsumeMessagesContext): Promise<void> {
  const { job, activeQuery, linear, ticketIssueId } = ctx;

  // Per-job accumulated assistant text (rolling buffer for sentinel matching).
  // Keep the last 32 KB to avoid unbounded growth on long runs.
  let assistantTextBuffer = "";
  const BUFFER_CAP = 32 * 1024;
  let sentinelHandled = false;

  async function feedSentinelBuffer(text: string): Promise<void> {
    assistantTextBuffer += text;
    if (assistantTextBuffer.length > BUFFER_CAP) {
      assistantTextBuffer = assistantTextBuffer.slice(-BUFFER_CAP);
    }
    if (!sentinelHandled) {
      const m = detectOpenQuestions(assistantTextBuffer);
      if (m.complete) {
        sentinelHandled = true;
        // Awaited so the cancel + Linear writes complete before the loop
        // proceeds (or the iterator throws from interrupt — caught below).
        await handleSentinel(ctx, m.questions ?? []);
      }
    }
  }

  try {
    for await (const message of activeQuery) {
      const msg = message as SDKMessage;
      const now = new Date().toISOString();

      // Always buffer + update lastMessageAt — finest granularity available.
      job.messages.push({ type: msg.type, receivedAt: now, payload: msg as unknown as Record<string, unknown> });
      job.lastMessageAt = now;
      // Soft-warn idempotency: a fresh message clears softWarnedAt so the next
      // quiet period earns its own warning.
      if (job.softWarnedAt) job.softWarnedAt = undefined;

      // stream_event / assistant text accumulation for sentinel matching
      if (msg.type === "stream_event") {
        const event = (msg as unknown as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
        if (event?.type === "content_block_delta" && event?.delta?.type === "text_delta" && typeof event.delta.text === "string") {
          await feedSentinelBuffer(event.delta.text);
        }
      }

      if (msg.type === "assistant") {
        const content = (msg as unknown as { message?: { content?: Array<{ type?: string; text?: string }> } }).message?.content ?? [];
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            await feedSentinelBuffer(block.text);
          }
        }
      }

      if (msg.type === "result") {
        // Single decision site: success → completed, anything else → error.
        // Only set if no prior terminal reason (sentinel/trap/cancel preserved).
        const r = msg as unknown as { subtype?: string; total_cost_usd?: number; duration_ms?: number };
        if (!job._terminalReason) {
          job._terminalReason = r.subtype === "success" ? "completed" : "error";
          job.result = { ok: r.subtype === "success", reason: r.subtype ?? "unknown" };
        }
        log.info("Subagent result", {
          agentId: job.agentId,
          subtype: r.subtype,
          cost: r.total_cost_usd,
          durationMs: r.duration_ms,
        });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Iterator threw", { agentId: job.agentId, error: msg });
    if (!job._terminalReason) {
      job._terminalReason = job.cancelRequested ? "interrupted" : "error";
      if (!job.cancelRequested) {
        // Genuine error (not cancel) — write Linear comment + block:human label.
        try {
          await linear.addComment(
            ticketIssueId,
            `pipeline-tick: subagent ${job.agentId} errored mid-stream: ${msg}; ticket flagged for human review`,
          );
          await linear.addLabel(ticketIssueId, "block:human");
        } catch (e) {
          log.error("Failed to write Linear iterator-throw signals", { agentId: job.agentId, error: String(e) });
        }
      }
    }
  } finally {
    // SINGLE WRITER of job.state. Reads _terminalReason; defaults to "error" if
    // somehow unset (defensive — should never happen).
    const reason: TerminalReason = job._terminalReason ?? "error";
    job.state = TERMINAL_TO_STATE[reason];
    log.info("Subagent terminal", { agentId: job.agentId, state: job.state, reason });
    if (ctx.onTerminal) ctx.onTerminal(job);
  }
}

async function handleSentinel(ctx: ConsumeMessagesContext, questions: string[]): Promise<void> {
  const { job, linear, ticketIssueId, cancel } = ctx;
  if (!job._terminalReason) {
    job._terminalReason = "stalled-open-questions";
    job.cancelRequested = true;
  }
  const lines = [
    `pipeline-tick: subagent ${job.agentId} emitted open-questions sentinel; ticket flagged block:human.`,
    "",
    "Open questions:",
    ...questions.map((q, i) => `  ${i + 1}. ${q}`),
  ];
  try {
    await linear.addComment(ticketIssueId, lines.join("\n"));
    await linear.addLabel(ticketIssueId, "block:human");
  } catch (err) {
    log.error("Failed to write block:human on sentinel", { agentId: job.agentId, error: String(err) });
  }
  try {
    await cancel();
  } catch (err) {
    log.error("cancel after sentinel failed", { agentId: job.agentId, error: String(err) });
  }
}
