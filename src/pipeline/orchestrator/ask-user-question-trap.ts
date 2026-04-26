import type { HookInput, HookJSONOutput, HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../../logging/logger.js";
import type { LinearClient } from "../linear-client.js";
import type { PipelineJob } from "./types.js";

const log = createLogger("pipeline-ask-trap");

export interface AskUserQuestionTrapOptions {
  /** Linear client for posting block:human comment + label. */
  linear: LinearClient;
  /** Linear ticket ID (e.g., "issue-id" UUID, not the human identifier). */
  ticketIssueId: string;
  /** The PipelineJob this trap is bound to. The trap mutates `_terminalReason` and `cancelRequested`. */
  job: PipelineJob;
  /** Called when the trap fires; orchestrator uses this to interrupt the active query. */
  onTrap: () => Promise<void>;
}

/**
 * Pipeline subagents have no human-in-the-loop client. AskUserQuestion means
 * "I'm stuck on a decision". The trap:
 *  1. Records the question(s).
 *  2. Sets `job._terminalReason = "stalled-ask-user-question"` (one-way state).
 *  3. Sets `job.cancelRequested = true` so the iterator-throw becomes "interrupted" not "error".
 *  4. Posts a Linear `block:human` comment listing the questions.
 *  5. Adds the `block:human` label.
 *  6. Calls onTrap() to interrupt the active query.
 *  7. Returns a `block` decision with a reason explaining the trap.
 */
export function createAskUserQuestionTrap(opts: AskUserQuestionTrapOptions): HookCallback {
  return async (
    input: HookInput,
    _toolUseId: string | undefined,
    _options: { signal: AbortSignal },
  ): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return { decision: "approve" };
    if (input.tool_name !== "AskUserQuestion") return { decision: "approve" };

    const toolInput = input.tool_input as {
      questions?: Array<{ question: string; multiSelect?: boolean; options?: Array<{ label: string }> }>;
    };
    const questions = toolInput?.questions ?? [];
    log.info("AskUserQuestion trapped", {
      agentId: opts.job.agentId,
      ticketId: opts.job.ticketId,
      count: questions.length,
    });

    // One-way: only set if not already terminal.
    if (!opts.job._terminalReason) {
      opts.job._terminalReason = "stalled-ask-user-question";
      opts.job.cancelRequested = true;
    }

    const lines = [
      `pipeline-tick: subagent ${opts.job.agentId} hit AskUserQuestion; ticket flagged block:human.`,
      "",
      "Subagent questions:",
      ...questions.map((q, i) => `  ${i + 1}. ${q.question}`),
    ];

    try {
      await opts.linear.addComment(opts.ticketIssueId, lines.join("\n"));
      await opts.linear.addLabel(opts.ticketIssueId, "block:human");
    } catch (err) {
      log.error("Failed to write block:human signals to Linear", {
        agentId: opts.job.agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      await opts.onTrap();
    } catch (err) {
      log.error("onTrap (interrupt) failed", {
        agentId: opts.job.agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return {
      decision: "block",
      reason: "AskUserQuestion is not available for pipeline subagents — the question has been routed to Linear as block:human. This subagent is being interrupted.",
    };
  };
}
