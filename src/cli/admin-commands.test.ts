import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AdminContext } from "./admin-client.js";
import {
  runStatus,
  runSessionsList,
  runDevicesList,
  runCapabilitiesList,
} from "./admin-commands.js";

const CTX: AdminContext = { url: "http://localhost:8420", adminSecret: "secret-32-aaaaaaaaaaaaaaaaaaaaaa" };

interface MockResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body?: unknown;
  textBody?: string;
}

function mockFetch(responses: MockResponse | MockResponse[] = { ok: true, status: 200, statusText: "OK", body: {} }): import("vitest").MockInstance {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const r = queue.shift() ?? { ok: true, status: 200, statusText: "OK", body: {} };
    return {
      ok: r.ok,
      status: r.status,
      statusText: r.statusText,
      json: async () => r.body,
      text: async () => r.textBody ?? (r.body !== undefined ? JSON.stringify(r.body) : ""),
    } as unknown as Response;
  });
}

function mockFetchReject(err: unknown): import("vitest").MockInstance {
  return vi.spyOn(globalThis, "fetch").mockRejectedValue(err);
}

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function logged(): string {
  return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

describe("runStatus", () => {
  it("hits /health WITHOUT admin auth and prints a one-liner", async () => {
    const fetchSpy = mockFetch({
      ok: true,
      status: 200,
      statusText: "OK",
      body: { status: "ok", sessions: 3, connectedDevices: 1 },
    });
    const code = await runStatus([], CTX);
    expect(code).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8420/health");
    // /health is public — no Authorization header.
    expect(init.headers).toEqual({});
    expect(logged()).toContain("gateway: ok");
    expect(logged()).toContain("sessions: 3");
    expect(logged()).toContain("devices: 1");
  });

  it("--json dumps the raw response body", async () => {
    mockFetch({
      ok: true,
      status: 200,
      statusText: "OK",
      body: { status: "ok", sessions: 0, connectedDevices: 0 },
    });
    await runStatus(["--json"], CTX);
    const out = logged();
    expect(out).toContain("\"sessions\": 0");
    expect(out).not.toContain("gateway:");
  });

  it("surfaces ECONNREFUSED with an actionable kickstart message", async () => {
    // Node's fetch wraps low-level errors in a TypeError with `cause.code`.
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:8420") as Error & { code?: string };
    cause.code = "ECONNREFUSED";
    const err = new TypeError("fetch failed") as TypeError & { cause?: unknown };
    err.cause = cause;
    mockFetchReject(err);
    await expect(runStatus([], CTX)).rejects.toThrow(/Gateway not running/);
    await expect(runStatus([], CTX)).rejects.toThrow(/launchctl kickstart/);
  });
});

describe("runSessionsList", () => {
  it("hits /admin/sessions with admin Bearer and renders a table", async () => {
    const fetchSpy = mockFetch({
      ok: true,
      status: 200,
      statusText: "OK",
      body: {
        sessions: [
          {
            sessionId: "sess-a",
            path: "/home/user/a",
            state: "idle",
            queryStartedAt: null,
            lastActivityAt: Date.now() - 5000,
          },
        ],
      },
    });
    const code = await runSessionsList([], CTX);
    expect(code).toBe(0);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8420/admin/sessions");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${CTX.adminSecret}`);
    const out = logged();
    expect(out).toContain("SESSION");
    expect(out).toContain("sess-a");
    expect(out).toContain("idle");
  });

  it("renders '(none)' when sessions array is empty", async () => {
    mockFetch({
      ok: true,
      status: 200,
      statusText: "OK",
      body: { sessions: [] },
    });
    await runSessionsList([], CTX);
    expect(logged()).toContain("(none)");
  });

  it("--json dumps the raw response", async () => {
    mockFetch({
      ok: true,
      status: 200,
      statusText: "OK",
      body: { sessions: [{ sessionId: "x", path: "/p", state: "idle", queryStartedAt: null, lastActivityAt: 0 }] },
    });
    await runSessionsList(["--json"], CTX);
    expect(logged()).toContain("\"sessionId\": \"x\"");
  });

  it("surfaces non-200 status with body", async () => {
    mockFetch({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      body: { error: "Unauthorized" },
      textBody: "{\"error\":\"Unauthorized\"}",
    });
    await expect(runSessionsList([], CTX)).rejects.toThrow(/401 Unauthorized/);
  });
});

describe("runDevicesList", () => {
  it("hits /devices (NOT /admin/devices) and renders ISO-string ages", async () => {
    // Important: devices list goes through the existing /devices admin
    // endpoint, not /admin/devices — and that endpoint returns lastSeenAt
    // as an ISO string. Without formatAge handling strings, age renders NaN.
    const fetchSpy = mockFetch({
      ok: true,
      status: 200,
      statusText: "OK",
      body: [
        {
          deviceId: "d1",
          label: "iPhone",
          name: "iPhone",
          user: "may",
          active: true,
          paired: true,
          pairedAt: "2026-04-29T19:00:00.000Z",
          lastSeenAt: "2026-04-29T19:59:55.000Z",
          connected: false,
          hasPendingCode: false,
        },
      ],
    });
    await runDevicesList([], CTX);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:8420/devices");
    const out = logged();
    expect(out).toContain("d1");
    expect(out).toContain("may");
    expect(out).not.toContain("NaN");
  });
});

describe("runCapabilitiesList", () => {
  it("hits /admin/capabilities and renders status + url", async () => {
    mockFetch({
      ok: true,
      status: 200,
      statusText: "OK",
      body: {
        capabilities: [
          {
            name: "hive",
            localWsUrl: "ws://127.0.0.1:3200/ws",
            healthUrl: "http://127.0.0.1:3200/health",
            consecutiveFailures: 0,
            lastCheckedAt: Date.now() - 1000,
            addedAt: Date.now() - 60_000,
          },
          {
            name: "archive",
            localWsUrl: "ws://127.0.0.1:3300/ws",
            healthUrl: "http://127.0.0.1:3300/health",
            consecutiveFailures: 1,
            lastCheckedAt: Date.now() - 1000,
            addedAt: Date.now() - 60_000,
          },
        ],
      },
    });
    await runCapabilitiesList([], CTX);
    const out = logged();
    expect(out).toContain("hive");
    expect(out).toContain("archive");
    expect(out).toContain("healthy");
    // Failing capabilities annotate the failure count so the operator sees
    // they are mid-eviction rather than just "down".
    expect(out).toContain("failing(1)");
  });
});
