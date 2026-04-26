import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const queryMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

import { PipelineOrchestrator } from "./index.js";
import { TicketBusyError } from "./types.js";
import type { OrchestratorConfig } from "../../types.js";

const config: OrchestratorConfig = {
  stallThresholds: {
    drafting:    { soft: 1000, hard: 3000 },
    review:      { soft: 1000, hard: 3000 },
    implementer: { soft: 2000, hard: 5000 },
  },
  pipelineModel: { drafting: "m", review: "m", implementer: "m" },
  bashAllowlist: ["^gh ", "^git ", "^npm "],
  jobTtlMs: 60_000,
};

const linearStub = () => ({
  addComment: vi.fn().mockResolvedValue({ id: "c", createdAt: "" }),
  addLabel: vi.fn().mockResolvedValue(undefined),
  getTicketState: vi.fn().mockResolvedValue({ id: "iid" }),
  listTeamPipelineIssues: vi.fn().mockResolvedValue([]),
});

function iter(messages: unknown[]) {
  let interrupted = false;
  return {
    interrupt: vi.fn(async () => { interrupted = true; }),
    async *[Symbol.asyncIterator]() {
      for (const m of messages) { if (interrupted) return; yield m; }
    },
  };
}

function iterThrowing(messages: unknown[], err: Error) {
  return {
    interrupt: vi.fn(async () => {}),
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m;
      throw err;
    },
  };
}

function pendingIter() {
  let resolveInterrupt: () => void = () => {};
  const interruptPromise = new Promise<void>((resolve) => { resolveInterrupt = resolve; });
  return {
    interrupt: vi.fn(async () => { resolveInterrupt(); }),
    async *[Symbol.asyncIterator]() {
      await interruptPromise;
    },
  };
}

/** Wait until the orchestrator marks `agentId` terminal (any non-running state). */
async function waitTerminal(o: PipelineOrchestrator, agentId: string, timeoutMs = 1000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const j = o.get(agentId);
    if (j && j.state !== "running") return j.state;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`agent ${agentId} did not reach terminal state within ${timeoutMs}ms`);
}

describe("Orchestrator smoke — happy + failure paths", () => {
  beforeEach(() => queryMock.mockReset());

  it("HAPPY PATH: spawn → result → completed", async () => {
    queryMock.mockReturnValue(iter([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "result", subtype: "success", total_cost_usd: 0.1, duration_ms: 500 },
    ]));
    const linear = linearStub();
    const o = new PipelineOrchestrator({ config, linear: linear as never, resolveIssueId: async () => "iid" });
    const r = await o.spawn({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-1" });
    expect(await waitTerminal(o, r.agentId)).toBe("completed");
  });

  it("SENTINEL: open-questions fence triggers cancel + Linear block:human", async () => {
    const text = "thinking\n=== OPEN QUESTIONS (BLOCK:HUMAN) ===\n1. q?\n=== END OPEN QUESTIONS ===\n";
    queryMock.mockReturnValue(iter([
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } },
    ]));
    const linear = linearStub();
    const o = new PipelineOrchestrator({ config, linear: linear as never, resolveIssueId: async () => "iid" });
    const r = await o.spawn({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-2" });
    expect(await waitTerminal(o, r.agentId)).toBe("stalled");
    expect(linear.addLabel).toHaveBeenCalledWith("iid", "block:human");
  });

  it("ITERATOR THROW: error path posts block:human", async () => {
    queryMock.mockReturnValue(iterThrowing([{ type: "system", subtype: "init" }], new Error("ECONNRESET")));
    const linear = linearStub();
    const o = new PipelineOrchestrator({ config, linear: linear as never, resolveIssueId: async () => "iid" });
    const r = await o.spawn({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-3" });
    expect(await waitTerminal(o, r.agentId)).toBe("error");
    expect(linear.addLabel).toHaveBeenCalledWith("iid", "block:human");
  });

  it("CANCEL: explicit cancel → interrupted, no error comment", async () => {
    const it = iterThrowing([{ type: "system", subtype: "init" }], new Error("aborted"));
    queryMock.mockReturnValue(it);
    const linear = linearStub();
    const o = new PipelineOrchestrator({ config, linear: linear as never, resolveIssueId: async () => "iid" });
    const r = await o.spawn({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-4" });
    await o.cancel(r.agentId);
    expect(await waitTerminal(o, r.agentId)).toBe("interrupted");
    expect(linear.addComment).not.toHaveBeenCalled();
  });

  it("CONCURRENT-SPAWN: same ticketId while running → TicketBusyError", async () => {
    queryMock.mockReturnValue(pendingIter()); // never yields
    const o = new PipelineOrchestrator({ config, linear: linearStub() as never, resolveIssueId: async () => "iid" });
    await o.spawn({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-5" });
    await expect(
      o.spawn({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-5" }),
    ).rejects.toBeInstanceOf(TicketBusyError);
  });
});
