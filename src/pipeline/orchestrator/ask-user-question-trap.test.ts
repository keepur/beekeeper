import { describe, it, expect, vi } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createAskUserQuestionTrap } from "./ask-user-question-trap.js";
import type { PipelineJob } from "./types.js";

function makeJob(): PipelineJob {
  return {
    agentId: "agent-XYZ",
    ticketId: "KPR-79",
    kind: "draft-spec",
    cwd: "/tmp/repo",
    startedAt: "2026-04-26T00:00:00.000Z",
    state: "running",
    lastMessageAt: "2026-04-26T00:00:00.000Z",
    messages: [],
  };
}

function makeInput(toolName: string, questions?: unknown) {
  return {
    hook_event_name: "PreToolUse" as const,
    tool_name: toolName,
    tool_input: { questions },
    tool_use_id: "tu_1",
  } as never;
}

describe("AskUserQuestion trap", () => {
  it("approves non-AskUserQuestion tools", async () => {
    const job = makeJob();
    const linear = { addComment: vi.fn(), addLabel: vi.fn() } as never;
    const trap = createAskUserQuestionTrap({ linear, ticketIssueId: "iid", job, onTrap: async () => {} });
    const r = await trap(makeInput("Bash"), undefined, { signal: new AbortController().signal });
    expect(r.decision).toBe("approve");
    expect(job._terminalReason).toBeUndefined();
  });

  it("blocks AskUserQuestion, sets _terminalReason, posts Linear, calls onTrap", async () => {
    const job = makeJob();
    const linear = { addComment: vi.fn().mockResolvedValue({ id: "c", createdAt: "" }), addLabel: vi.fn().mockResolvedValue(undefined) } as never;
    const onTrap = vi.fn().mockResolvedValue(undefined);
    const trap = createAskUserQuestionTrap({ linear, ticketIssueId: "iid", job, onTrap });
    const r = await trap(
      makeInput("AskUserQuestion", [{ question: "go ahead?" }, { question: "use SSE?" }]),
      undefined,
      { signal: new AbortController().signal },
    );
    expect(r.decision).toBe("block");
    expect(job._terminalReason).toBe("stalled-ask-user-question");
    expect(job.cancelRequested).toBe(true);
    expect(linear.addComment).toHaveBeenCalled();
    const commentBody = (linear.addComment.mock.calls[0] as string[])[1];
    expect(commentBody).toContain("1. go ahead?");
    expect(commentBody).toContain("2. use SSE?");
    expect(linear.addLabel).toHaveBeenCalledWith("iid", "block:human");
    expect(onTrap).toHaveBeenCalled();
  });

  it("does NOT overwrite an existing _terminalReason", async () => {
    const job = makeJob();
    job._terminalReason = "completed";
    const linear = { addComment: vi.fn().mockResolvedValue({ id: "c", createdAt: "" }), addLabel: vi.fn().mockResolvedValue(undefined) } as never;
    const trap = createAskUserQuestionTrap({ linear, ticketIssueId: "iid", job, onTrap: async () => {} });
    await trap(makeInput("AskUserQuestion", [{ question: "x" }]), undefined, { signal: new AbortController().signal });
    expect(job._terminalReason).toBe("completed");
  });
});
