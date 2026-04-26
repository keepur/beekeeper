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
    drafting:    { soft: 300_000, hard: 900_000 },
    review:      { soft: 300_000, hard: 900_000 },
    implementer: { soft: 600_000, hard: 1_800_000 },
  },
  pipelineModel: {
    drafting: "claude-opus-4-7",
    review: "claude-opus-4-7",
    implementer: "claude-sonnet-4-6",
  },
  bashAllowlist: ["^gh ", "^git ", "^npm "],
  jobTtlMs: 60_000,
};

const linearStub = () => ({
  addComment: vi.fn().mockResolvedValue({ id: "c", createdAt: "" }),
  addLabel: vi.fn().mockResolvedValue(undefined),
  listTeamPipelineIssues: vi.fn().mockResolvedValue([]),
  getTicketState: vi.fn(),
});

function makeIter(messages: unknown[] = []) {
  let interrupted = false;
  return {
    interrupt: vi.fn(async () => { interrupted = true; }),
    async *[Symbol.asyncIterator]() {
      for (const m of messages) {
        if (interrupted) return;
        yield m;
      }
    },
  };
}

/** Iterator that never produces a value and only ends when interrupted. */
function makePendingIter() {
  let resolveInterrupt: () => void = () => {};
  const interruptPromise = new Promise<void>((resolve) => { resolveInterrupt = resolve; });
  return {
    interrupt: vi.fn(async () => { resolveInterrupt(); }),
    async *[Symbol.asyncIterator]() {
      await interruptPromise;
      // never yield; just return
    },
  };
}

describe("PipelineOrchestrator", () => {
  beforeEach(() => queryMock.mockReset());

  it("spawn() returns immediately with agentId + status: started", async () => {
    queryMock.mockReturnValue(makeIter([{ type: "result", subtype: "success" }]));
    const linear = linearStub();
    const o = new PipelineOrchestrator({ config, linear: linear as never, resolveIssueId: async () => "iid-1" });
    const r = await o.spawn({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "KPR-1" });
    expect(r.status).toBe("started");
    expect(r.agentId).toMatch(/^agent-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(r.ticketId).toBe("KPR-1");
  });

  it("getActiveByTicket returns the running job", async () => {
    // Iterator that never yields — keeps job in "running" state for the assertion.
    queryMock.mockReturnValue(makePendingIter());
    const o = new PipelineOrchestrator({ config, linear: linearStub() as never, resolveIssueId: async () => "iid" });
    const r = await o.spawn({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "KPR-2" });
    // Allow the void consumeMessages to start (first await tick).
    await new Promise((res) => setImmediate(res));
    expect(o.getActiveByTicket("KPR-2")).not.toBeNull();
    expect(o.get(r.agentId)).not.toBeNull();
  });

  it("throws TicketBusyError on second spawn for same ticketId while first is running", async () => {
    // First iter never finishes during the test; second should reject.
    queryMock.mockReturnValueOnce(makePendingIter()).mockReturnValueOnce(makePendingIter());
    const o = new PipelineOrchestrator({ config, linear: linearStub() as never, resolveIssueId: async () => "iid" });
    await o.spawn({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "KPR-3" });
    await expect(
      o.spawn({ kind: "draft-spec", prompt: "p2", repoPath: "/r", ticketId: "KPR-3" }),
    ).rejects.toBeInstanceOf(TicketBusyError);
  });

  it("cancel() interrupts and sets _terminalReason=interrupted", async () => {
    const iter = makePendingIter();
    queryMock.mockReturnValue(iter);
    const o = new PipelineOrchestrator({ config, linear: linearStub() as never, resolveIssueId: async () => "iid" });
    const r = await o.spawn({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "KPR-4" });
    await o.cancel(r.agentId);
    expect(iter.interrupt).toHaveBeenCalled();
    // The cancel sets _terminalReason synchronously; final job.state lands when consumeMessages's finally block runs.
    const job = o.get(r.agentId);
    expect(job?._terminalReason).toBe("interrupted");
    expect(job?.cancelRequested).toBe(true);
  });

  it("listActive returns only running jobs", async () => {
    queryMock.mockReturnValueOnce(makeIter([{ type: "result", subtype: "success" }]));
    queryMock.mockReturnValueOnce(makePendingIter());
    const o = new PipelineOrchestrator({ config, linear: linearStub() as never, resolveIssueId: async () => "iid" });
    const r1 = await o.spawn({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-5" });
    await o.spawn({ kind: "draft-plan", prompt: "p", repoPath: "/r", ticketId: "K-6" });
    // Wait for r1 (the result-emitting iter) to reach a terminal state.
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && o.get(r1.agentId)?.state === "running") {
      await new Promise((res) => setImmediate(res));
    }
    const active = o.listActive();
    for (const j of active) {
      expect(j.state).toBe("running");
    }
    // Exactly one (K-6) should still be running; K-5 completed.
    expect(active.map((j) => j.ticketId)).toEqual(["K-6"]);
  });

  it("activeAgentIds returns the set of running agentIds", async () => {
    queryMock.mockReturnValue(makePendingIter());
    const o = new PipelineOrchestrator({ config, linear: linearStub() as never, resolveIssueId: async () => "iid" });
    const r1 = await o.spawn({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-7" });
    const set = o.activeAgentIds();
    expect(set.has(r1.agentId)).toBe(true);
  });
});
