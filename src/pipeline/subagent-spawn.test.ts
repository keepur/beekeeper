import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("./honeypot-reader.js", () => ({
  resolveBeekeeperSecret: (k: string) => (k === "BEEKEEPER_ADMIN_SECRET" ? "s" : null),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("spawnSubagent (Phase 2 HTTP client)", () => {
  it("POSTs to /admin/pipeline/jobs and returns SpawnResult", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ agentId: "agent-A", status: "started" }),
    });
    const { spawnSubagent } = await import("./subagent-spawn.js");
    const r = await spawnSubagent({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-1" });
    expect(r.agentId).toBe("agent-A");
    expect(r.status).toBe("started");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/127\.0\.0\.1:\d+\/admin\/pipeline\/jobs$/);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer s");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-1" });
  });

  it("translates ECONNREFUSED to BeekeeperServerNotRunningError", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed: ECONNREFUSED"));
    const { spawnSubagent, BeekeeperServerNotRunningError } = await import("./subagent-spawn.js");
    await expect(spawnSubagent({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-1" }))
      .rejects.toBeInstanceOf(BeekeeperServerNotRunningError);
  });

  it("propagates 409 ticket-busy with the existing agentId in the message", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "ticket-busy", existingAgentId: "agent-EXISTING" }),
    });
    const { spawnSubagent } = await import("./subagent-spawn.js");
    await expect(spawnSubagent({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-1" }))
      .rejects.toThrow(/agent-EXISTING/);
  });

  it("propagates non-ok responses with status code", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "server-side oops",
    });
    const { spawnSubagent } = await import("./subagent-spawn.js");
    await expect(spawnSubagent({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-1" }))
      .rejects.toThrow(/500/);
  });
});
