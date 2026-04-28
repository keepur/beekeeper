import { describe, it, expect, vi } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { StallScanner } from "./stall-scanner.js";
import type { PipelineJob } from "./types.js";
import type { OrchestratorStallThresholds } from "../../types.js";

const T: OrchestratorStallThresholds = {
  drafting:    { soft: 300_000,  hard: 900_000  },
  review:      { soft: 300_000,  hard: 900_000  },
  implementer: { soft: 600_000,  hard: 1_800_000 },
};

function job(overrides: Partial<PipelineJob> = {}): PipelineJob {
  return {
    agentId: "agent-X",
    ticketId: "KPR-79",
    kind: "draft-spec",
    cwd: "/tmp",
    startedAt: "2026-04-26T00:00:00.000Z",
    state: "running",
    lastMessageAt: "2026-04-26T00:00:00.000Z",
    messages: [],
    ...overrides,
  };
}

const linearMock = () => ({
  addComment: vi.fn().mockResolvedValue({ id: "c", createdAt: "" }),
  addLabel: vi.fn().mockResolvedValue(undefined),
});

describe("StallScanner", () => {
  it("does nothing when idle < soft threshold", async () => {
    const j = job();
    const linear = linearMock();
    const cancel = vi.fn();
    const s = new StallScanner({
      thresholds: T,
      getActiveJobs: () => [j],
      linear: linear as never,
      cancel,
      resolveIssueId: () => "iid",
      now: () => new Date(j.lastMessageAt).getTime() + 1000,
    });
    await s.scan();
    expect(linear.addComment).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("emits soft warning once when crossing soft threshold", async () => {
    const j = job();
    const linear = linearMock();
    const cancel = vi.fn();
    const start = new Date(j.lastMessageAt).getTime();
    const s = new StallScanner({
      thresholds: T,
      getActiveJobs: () => [j],
      linear: linear as never,
      cancel,
      resolveIssueId: () => "iid",
      now: () => start + 6 * 60_000, // 6 min idle, > 5 min soft, < 15 min hard
    });
    await s.scan();
    expect(linear.addComment).toHaveBeenCalledTimes(1);
    expect((linear.addComment.mock.calls[0] as string[])[1]).toMatch(/quiet/);
    expect(j.softWarnedAt).toBeTruthy();

    // Re-running scan does NOT post another warning (idempotency).
    await s.scan();
    expect(linear.addComment).toHaveBeenCalledTimes(1);
  });

  it("emits hard cancel + block:human when crossing hard threshold", async () => {
    const j = job();
    const linear = linearMock();
    const cancel = vi.fn().mockResolvedValue(undefined);
    const start = new Date(j.lastMessageAt).getTime();
    const s = new StallScanner({
      thresholds: T,
      getActiveJobs: () => [j],
      linear: linear as never,
      cancel,
      resolveIssueId: () => "iid",
      now: () => start + 16 * 60_000,
    });
    await s.scan();
    expect(j._terminalReason).toBe("stalled-timeout");
    expect(j.cancelRequested).toBe(true);
    expect(linear.addLabel).toHaveBeenCalledWith("iid", "block:human");
    expect(cancel).toHaveBeenCalledWith("agent-X");
  });

  it("uses implementer thresholds for implementer kind", async () => {
    const j = job({ kind: "implementer" });
    const linear = linearMock();
    const start = new Date(j.lastMessageAt).getTime();
    const s = new StallScanner({
      thresholds: T,
      getActiveJobs: () => [j],
      linear: linear as never,
      cancel: vi.fn(),
      resolveIssueId: () => "iid",
      // 7 min — would warn for drafting (soft 5), but NOT for implementer (soft 10).
      now: () => start + 7 * 60_000,
    });
    await s.scan();
    expect(linear.addComment).not.toHaveBeenCalled();
  });

  it("skips jobs whose state is not running (terminal already)", async () => {
    const j = job({ state: "completed" });
    const linear = linearMock();
    const start = new Date(j.lastMessageAt).getTime();
    const s = new StallScanner({
      thresholds: T,
      getActiveJobs: () => [j],
      linear: linear as never,
      cancel: vi.fn(),
      resolveIssueId: () => "iid",
      now: () => start + 30 * 60_000,
    });
    await s.scan();
    expect(linear.addComment).not.toHaveBeenCalled();
  });

  it("does NOT cancel-twice when _terminalReason is already set", async () => {
    const j = job({ _terminalReason: "completed" });
    const linear = linearMock();
    const cancel = vi.fn();
    const start = new Date(j.lastMessageAt).getTime();
    const s = new StallScanner({
      thresholds: T,
      getActiveJobs: () => [j],
      linear: linear as never,
      cancel,
      resolveIssueId: () => "iid",
      now: () => start + 30 * 60_000,
    });
    await s.scan();
    expect(cancel).not.toHaveBeenCalled();
  });
});
