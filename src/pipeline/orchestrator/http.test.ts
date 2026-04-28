import { describe, it, expect, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { handlePipelineAdminRequest } from "./http.js";
import { TicketBusyError } from "./types.js";

function makeReq(opts: { method: string; url: string; auth?: string; remote?: string }): IncomingMessage {
  const req = new Readable({ read() {} }) as unknown as IncomingMessage;
  req.method = opts.method;
  req.url = opts.url;
  (req.headers as Record<string, string>) = {};
  if (opts.auth) req.headers.authorization = `Bearer ${opts.auth}`;
  (req.socket as unknown as { remoteAddress: string }) = { remoteAddress: opts.remote ?? "127.0.0.1" } as never;
  return req;
}

function makeRes() {
  const chunks: string[] = [];
  let status = 0;
  const res = {
    writeHead: vi.fn((s: number) => { status = s; return res; }),
    end: vi.fn((b: string) => { chunks.push(b); return res; }),
    get status() { return status; },
    get body() { return JSON.parse(chunks.join("") || "{}"); },
  };
  return res as unknown as ServerResponse & { status: number; body: Record<string, unknown> };
}

const orchStub = (over: Record<string, unknown> = {}) => ({
  spawn: vi.fn(),
  get: vi.fn(),
  cancel: vi.fn(),
  getActiveByTicket: vi.fn(),
  listActive: vi.fn(),
  activeAgentIds: vi.fn(() => new Set()),
  ...over,
});

const readBody = (s: string) => async () => s;

describe("handlePipelineAdminRequest", () => {
  it("returns false for non-pipeline paths", async () => {
    const o = orchStub();
    const req = makeReq({ method: "GET", url: "/health" });
    const res = makeRes();
    const handled = await handlePipelineAdminRequest(req, res, { orchestrator: o as never, adminSecret: "s", readBody: readBody("") });
    expect(handled).toBe(false);
  });

  it("rejects non-loopback with 403", async () => {
    const o = orchStub();
    const req = makeReq({ method: "POST", url: "/admin/pipeline/jobs", auth: "s", remote: "203.0.113.7" });
    const res = makeRes();
    await handlePipelineAdminRequest(req, res, { orchestrator: o as never, adminSecret: "s", readBody: readBody("{}") });
    expect((res as unknown as { status: number }).status).toBe(403);
  });

  it("rejects missing/wrong bearer with 401", async () => {
    const o = orchStub();
    const req = makeReq({ method: "POST", url: "/admin/pipeline/jobs", auth: "wrong" });
    const res = makeRes();
    await handlePipelineAdminRequest(req, res, { orchestrator: o as never, adminSecret: "s", readBody: readBody("{}") });
    expect((res as unknown as { status: number }).status).toBe(401);
  });

  it("POST jobs with valid body returns 202 and SpawnResult", async () => {
    const o = orchStub({
      spawn: vi.fn().mockResolvedValue({ agentId: "agent-A", status: "started", ticketId: "K-1", startedAt: "x" }),
    });
    const body = JSON.stringify({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-1" });
    const req = makeReq({ method: "POST", url: "/admin/pipeline/jobs", auth: "s" });
    const res = makeRes();
    await handlePipelineAdminRequest(req, res, { orchestrator: o as never, adminSecret: "s", readBody: readBody(body) });
    expect((res as unknown as { status: number }).status).toBe(202);
    expect((res as unknown as { body: { agentId: string } }).body.agentId).toBe("agent-A");
  });

  it("POST jobs returns 409 on TicketBusyError", async () => {
    const o = orchStub({
      spawn: vi.fn().mockRejectedValue(new TicketBusyError("K-1", "agent-EXISTING")),
    });
    const body = JSON.stringify({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-1" });
    const req = makeReq({ method: "POST", url: "/admin/pipeline/jobs", auth: "s" });
    const res = makeRes();
    await handlePipelineAdminRequest(req, res, { orchestrator: o as never, adminSecret: "s", readBody: readBody(body) });
    expect((res as unknown as { status: number }).status).toBe(409);
    expect((res as unknown as { body: { error: string; existingAgentId: string } }).body.existingAgentId).toBe("agent-EXISTING");
  });

  it("POST jobs returns 400 on invalid kind", async () => {
    const o = orchStub();
    const body = JSON.stringify({ kind: "draft-foo", prompt: "p", repoPath: "/r", ticketId: "K-1" });
    const req = makeReq({ method: "POST", url: "/admin/pipeline/jobs", auth: "s" });
    const res = makeRes();
    await handlePipelineAdminRequest(req, res, { orchestrator: o as never, adminSecret: "s", readBody: readBody(body) });
    expect((res as unknown as { status: number }).status).toBe(400);
  });

  it("GET jobs/:id returns 200 + job, 404 if unknown", async () => {
    const o = orchStub({
      get: vi.fn().mockReturnValueOnce({ agentId: "X", state: "running" }).mockReturnValueOnce(null),
    });
    const ok = makeRes();
    await handlePipelineAdminRequest(
      makeReq({ method: "GET", url: "/admin/pipeline/jobs/X", auth: "s" }),
      ok,
      { orchestrator: o as never, adminSecret: "s", readBody: readBody("") },
    );
    expect((ok as unknown as { status: number }).status).toBe(200);

    const nf = makeRes();
    await handlePipelineAdminRequest(
      makeReq({ method: "GET", url: "/admin/pipeline/jobs/Y", auth: "s" }),
      nf,
      { orchestrator: o as never, adminSecret: "s", readBody: readBody("") },
    );
    expect((nf as unknown as { status: number }).status).toBe(404);
  });

  it("POST jobs/:id/cancel returns 200 and calls orchestrator.cancel", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const o = orchStub({
      get: vi.fn().mockReturnValue({ agentId: "X", state: "running" }),
      cancel,
    });
    const res = makeRes();
    await handlePipelineAdminRequest(
      makeReq({ method: "POST", url: "/admin/pipeline/jobs/X/cancel", auth: "s" }),
      res,
      { orchestrator: o as never, adminSecret: "s", readBody: readBody("") },
    );
    expect((res as unknown as { status: number }).status).toBe(200);
    expect(cancel).toHaveBeenCalledWith("X");
  });
});
