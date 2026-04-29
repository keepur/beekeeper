import { describe, it, expect, vi } from "vitest";

vi.mock("./logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { handleAdminRequest, isLoopback } from "./admin-handler.js";

interface MockRes {
  statusCode: number | null;
  headers: Record<string, string> | null;
  body: string | null;
  writeHead: (status: number, headers?: Record<string, string>) => void;
  end: (body?: string) => void;
}

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: null,
    headers: null,
    body: null,
    writeHead: (status, headers) => {
      res.statusCode = status;
      res.headers = headers ?? null;
    },
    end: (body) => {
      res.body = body ?? null;
    },
  };
  return res;
}

interface MakeReqOptions {
  url: string;
  method?: string;
  // Pass `undefined` explicitly to test the "no remoteAddress" path — the
  // helper preserves it rather than defaulting, so loopback rejection tests
  // can cover that case without a separate sentinel.
  remoteAddress?: string;
  authorization?: string;
}

function makeReq(opts: MakeReqOptions): import("node:http").IncomingMessage {
  // Default only when the caller omitted the key entirely; preserve an
  // explicit `undefined` so tests can simulate node's no-socket-info case.
  const remoteAddress = "remoteAddress" in opts ? opts.remoteAddress : "127.0.0.1";
  return {
    url: opts.url,
    method: opts.method ?? "GET",
    socket: { remoteAddress },
    headers: opts.authorization ? { authorization: opts.authorization } : {},
  } as unknown as import("node:http").IncomingMessage;
}

const ADMIN_SECRET = "test-admin-secret-32-chars-aaaaaa";

function makeDeps() {
  return {
    sessionManager: {
      getAdminSessions: vi.fn(() => [
        {
          sessionId: "sess-a",
          path: "/home/user/a",
          state: "idle" as const,
          queryStartedAt: null,
          lastActivityAt: 1_700_000_000_000,
        },
      ]),
    },
    capabilities: {
      listAdmin: vi.fn(() => [
        {
          name: "hive",
          localWsUrl: "ws://127.0.0.1:3200/ws",
          healthUrl: "http://127.0.0.1:3200/health",
          consecutiveFailures: 0,
          lastCheckedAt: 1_700_000_000_000,
          addedAt: 1_700_000_000_000 - 60_000,
        },
      ]),
    },
    adminSecret: ADMIN_SECRET,
  };
}

describe("isLoopback", () => {
  it("accepts the three localhost forms node may report", () => {
    for (const remote of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const req = makeReq({ url: "/x", remoteAddress: remote });
      expect(isLoopback(req)).toBe(true);
    }
  });

  it("rejects non-loopback addresses", () => {
    for (const remote of ["10.0.0.1", "192.168.1.1", "::ffff:10.0.0.1", undefined]) {
      const req = makeReq({ url: "/x", remoteAddress: remote });
      expect(isLoopback(req)).toBe(false);
    }
  });
});

describe("handleAdminRequest — routing", () => {
  it("returns false (lets the dispatcher continue) for non-/admin paths", () => {
    const res = makeRes();
    const req = makeReq({ url: "/health" });
    expect(handleAdminRequest(req, res, makeDeps())).toBe(false);
    expect(res.statusCode).toBeNull();
  });

  it("returns true and 404s for unknown /admin/* paths", () => {
    const res = makeRes();
    const req = makeReq({
      url: "/admin/bogus",
      authorization: `Bearer ${ADMIN_SECRET}`,
    });
    expect(handleAdminRequest(req, res, makeDeps())).toBe(true);
    expect(res.statusCode).toBe(404);
  });
});

describe("handleAdminRequest — auth gating", () => {
  it("403s non-loopback callers BEFORE checking the bearer", () => {
    // Loopback comes first so a leaked admin secret can't be used remotely.
    const res = makeRes();
    const deps = makeDeps();
    const req = makeReq({
      url: "/admin/sessions",
      remoteAddress: "10.0.0.1",
      authorization: `Bearer ${ADMIN_SECRET}`,
    });
    handleAdminRequest(req, res, deps);
    expect(res.statusCode).toBe(403);
    // Crucially, the handler must not have called the domain methods.
    expect(deps.sessionManager.getAdminSessions).not.toHaveBeenCalled();
  });

  it("401s when authorization header is missing", () => {
    const res = makeRes();
    const deps = makeDeps();
    const req = makeReq({ url: "/admin/sessions" });
    handleAdminRequest(req, res, deps);
    expect(res.statusCode).toBe(401);
    expect(deps.sessionManager.getAdminSessions).not.toHaveBeenCalled();
  });

  it("401s when bearer is the wrong secret (same length)", () => {
    const res = makeRes();
    const deps = makeDeps();
    const wrong = "x".repeat(ADMIN_SECRET.length);
    const req = makeReq({
      url: "/admin/sessions",
      authorization: `Bearer ${wrong}`,
    });
    handleAdminRequest(req, res, deps);
    expect(res.statusCode).toBe(401);
  });

  it("401s when bearer is the wrong length (timingSafeEqual would throw)", () => {
    // Length mismatch is short-circuited inside verifyAdminBearer — without
    // that guard, timingSafeEqual would throw and we'd 500.
    const res = makeRes();
    const deps = makeDeps();
    const req = makeReq({
      url: "/admin/sessions",
      authorization: "Bearer short",
    });
    handleAdminRequest(req, res, deps);
    expect(res.statusCode).toBe(401);
  });

  it("401s for non-Bearer schemes", () => {
    const res = makeRes();
    const req = makeReq({
      url: "/admin/sessions",
      authorization: `Basic ${Buffer.from("a:b").toString("base64")}`,
    });
    handleAdminRequest(req, res, makeDeps());
    expect(res.statusCode).toBe(401);
  });
});

describe("handleAdminRequest — GET /admin/sessions", () => {
  it("returns 200 with sessions array on the happy path", () => {
    const res = makeRes();
    const deps = makeDeps();
    const req = makeReq({
      url: "/admin/sessions",
      authorization: `Bearer ${ADMIN_SECRET}`,
    });
    handleAdminRequest(req, res, deps);
    expect(res.statusCode).toBe(200);
    expect(deps.sessionManager.getAdminSessions).toHaveBeenCalledTimes(1);
    const body = JSON.parse(res.body ?? "{}");
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].sessionId).toBe("sess-a");
  });

  it("404s for non-GET methods on the same path", () => {
    const res = makeRes();
    const req = makeReq({
      url: "/admin/sessions",
      method: "POST",
      authorization: `Bearer ${ADMIN_SECRET}`,
    });
    handleAdminRequest(req, res, makeDeps());
    expect(res.statusCode).toBe(404);
  });

  it("500s when sessionManager.getAdminSessions throws", () => {
    const res = makeRes();
    const deps = makeDeps();
    deps.sessionManager.getAdminSessions = vi.fn(() => {
      throw new Error("boom");
    });
    const req = makeReq({
      url: "/admin/sessions",
      authorization: `Bearer ${ADMIN_SECRET}`,
    });
    handleAdminRequest(req, res, deps);
    expect(res.statusCode).toBe(500);
  });
});

describe("handleAdminRequest — GET /admin/capabilities", () => {
  it("returns 200 with capabilities array on the happy path", () => {
    const res = makeRes();
    const deps = makeDeps();
    const req = makeReq({
      url: "/admin/capabilities",
      authorization: `Bearer ${ADMIN_SECRET}`,
    });
    handleAdminRequest(req, res, deps);
    expect(res.statusCode).toBe(200);
    expect(deps.capabilities.listAdmin).toHaveBeenCalledTimes(1);
    const body = JSON.parse(res.body ?? "{}");
    expect(body.capabilities).toHaveLength(1);
    expect(body.capabilities[0].name).toBe("hive");
  });

  it("500s when capabilities.listAdmin throws", () => {
    const res = makeRes();
    const deps = makeDeps();
    deps.capabilities.listAdmin = vi.fn(() => {
      throw new Error("boom");
    });
    const req = makeReq({
      url: "/admin/capabilities",
      authorization: `Bearer ${ADMIN_SECRET}`,
    });
    handleAdminRequest(req, res, deps);
    expect(res.statusCode).toBe(500);
  });
});
