import { describe, expect, it, vi, beforeEach } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const fakeChild = { unref: vi.fn(), pid: 12345 };

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockReturnValue(fakeChild);
  fakeChild.unref.mockClear();
});

describe("spawnSubagent", () => {
  it("invokes claude -p with the prompt and detaches the child", async () => {
    const { spawnSubagent } = await import("./subagent-spawn.js");
    const result = await spawnSubagent({
      kind: "draft-plan",
      prompt: "draft me a plan",
      repoPath: "/tmp/repo",
      ticketId: "KPR-90",
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: unknown },
    ];
    expect(bin).toBe("claude");
    expect(args).toEqual(["-p", "draft me a plan"]);
    expect(opts.cwd).toBe("/tmp/repo");
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toEqual(["ignore", "ignore", "ignore"]);
    expect(opts.env.PIPELINE_AGENT_ID).toBe(result.agentId);
    expect(opts.env.PIPELINE_TICKET_ID).toBe("KPR-90");
    expect(opts.env.PIPELINE_KIND).toBe("draft-plan");
    expect(fakeChild.unref).toHaveBeenCalled();
    expect(result.status).toBe("started");
    expect(result.agentId).toMatch(/^agent-[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("propagates the LINEAR_API_KEY through inherited env", async () => {
    const prev = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "lin_api_test";
    try {
      const { spawnSubagent } = await import("./subagent-spawn.js");
      await spawnSubagent({
        kind: "code-review",
        prompt: "review",
        repoPath: "/tmp/r",
        ticketId: "KPR-1",
      });
      const opts = spawnMock.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.LINEAR_API_KEY).toBe("lin_api_test");
    } finally {
      if (prev === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = prev;
    }
  });
});
