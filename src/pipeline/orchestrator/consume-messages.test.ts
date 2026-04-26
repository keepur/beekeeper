import { describe, it, expect, vi } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { consumeMessages } from "./consume-messages.js";
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

function makeIter(messages: unknown[]) {
  let interrupted = false;
  const iter: { interrupt: () => Promise<void>; [Symbol.asyncIterator]: () => AsyncGenerator<unknown> } = {
    interrupt: vi.fn(async () => { interrupted = true; }),
    async *[Symbol.asyncIterator]() {
      for (const m of messages) {
        if (interrupted) return;
        yield m;
      }
    },
  };
  return iter;
}

function makeIterThrowing(messages: unknown[], err: Error) {
  const iter = {
    interrupt: vi.fn(async () => {}),
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m;
      throw err;
    },
  };
  return iter;
}

const linearMock = () => ({
  addComment: vi.fn().mockResolvedValue({ id: "c", createdAt: "" }),
  addLabel: vi.fn().mockResolvedValue(undefined),
});

describe("consumeMessages", () => {
  it("happy path: iterator drains, result→completed in finally", async () => {
    const job = makeJob();
    const iter = makeIter([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "result", subtype: "success", total_cost_usd: 0.01, duration_ms: 1000 },
    ]);
    const linear = linearMock();
    await consumeMessages({ job, activeQuery: iter as never, linear: linear as never, ticketIssueId: "iid", cancel: async () => { await iter.interrupt(); } });
    expect(job.state).toBe("completed");
    expect(job._terminalReason).toBe("completed");
    expect(job.result?.ok).toBe(true);
    expect(linear.addComment).not.toHaveBeenCalled();
  });

  it("non-success result→error", async () => {
    const job = makeJob();
    const iter = makeIter([
      { type: "result", subtype: "max_turns" },
    ]);
    const linear = linearMock();
    await consumeMessages({ job, activeQuery: iter as never, linear: linear as never, ticketIssueId: "iid", cancel: async () => {} });
    expect(job.state).toBe("error");
  });

  it("sentinel match → cancel + Linear, _terminalReason wins over later events", async () => {
    const job = makeJob();
    const sentinelText = "checking...\n=== OPEN QUESTIONS (BLOCK:HUMAN) ===\n1. ssE or poll?\n=== END OPEN QUESTIONS ===\n";
    const iter = makeIter([
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: sentinelText } } },
    ]);
    const linear = linearMock();
    const cancel = vi.fn().mockResolvedValue(undefined);
    await consumeMessages({ job, activeQuery: iter as never, linear: linear as never, ticketIssueId: "iid", cancel });
    expect(job._terminalReason).toBe("stalled-open-questions");
    expect(job.state).toBe("stalled");
    expect(linear.addComment).toHaveBeenCalled();
    expect(linear.addLabel).toHaveBeenCalledWith("iid", "block:human");
    expect(cancel).toHaveBeenCalled();
  });

  it("iterator throw without _terminalReason → error + block:human comment", async () => {
    const job = makeJob();
    const iter = makeIterThrowing(
      [{ type: "system", subtype: "init", session_id: "s1" }],
      new Error("ECONNRESET"),
    );
    const linear = linearMock();
    await consumeMessages({ job, activeQuery: iter as never, linear: linear as never, ticketIssueId: "iid", cancel: async () => {} });
    expect(job.state).toBe("error");
    expect(linear.addComment).toHaveBeenCalled();
    expect(linear.addLabel).toHaveBeenCalledWith("iid", "block:human");
  });

  it("iterator throw with cancelRequested → interrupted (no error comment)", async () => {
    const job = makeJob();
    job.cancelRequested = true;
    const iter = makeIterThrowing(
      [{ type: "system", subtype: "init", session_id: "s1" }],
      new Error("aborted"),
    );
    const linear = linearMock();
    await consumeMessages({ job, activeQuery: iter as never, linear: linear as never, ticketIssueId: "iid", cancel: async () => {} });
    expect(job.state).toBe("interrupted");
    expect(linear.addComment).not.toHaveBeenCalled();
  });

  it("preserves prior _terminalReason if set before iterator throws (sentinel race)", async () => {
    const job = makeJob();
    const sentinelText = "=== OPEN QUESTIONS (BLOCK:HUMAN) ===\n1. q\n=== END OPEN QUESTIONS ===\n";
    const iter = makeIterThrowing(
      [{ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: sentinelText } } }],
      new Error("aborted-after-sentinel"),
    );
    const linear = linearMock();
    await consumeMessages({ job, activeQuery: iter as never, linear: linear as never, ticketIssueId: "iid", cancel: async () => {} });
    expect(job._terminalReason).toBe("stalled-open-questions");
    expect(job.state).toBe("stalled");
  });

  it("calls onTerminal exactly once on terminal", async () => {
    const job = makeJob();
    const iter = makeIter([{ type: "result", subtype: "success" }]);
    const onTerminal = vi.fn();
    await consumeMessages({ job, activeQuery: iter as never, linear: linearMock() as never, ticketIssueId: "iid", cancel: async () => {}, onTerminal });
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith(job);
  });

  it("updates lastMessageAt on every message", async () => {
    const job = makeJob();
    const before = job.lastMessageAt;
    const iter = makeIter([
      { type: "system", subtype: "init" },
      { type: "result", subtype: "success" },
    ]);
    await consumeMessages({ job, activeQuery: iter as never, linear: linearMock() as never, ticketIssueId: "iid", cancel: async () => {} });
    expect(job.lastMessageAt).not.toBe(before);
    expect(job.messages.length).toBe(2);
  });
});
