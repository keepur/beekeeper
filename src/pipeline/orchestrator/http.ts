import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createLogger } from "../../logging/logger.js";
import { TicketBusyError, type SpawnInput } from "./types.js";
import type { PipelineOrchestrator } from "./index.js";
import type { SubagentKind } from "../subagent-spawn.js";

const log = createLogger("pipeline-http");

const VALID_KINDS: SubagentKind[] = ["draft-spec", "draft-plan", "code-review", "implementer"];

export interface PipelineAdminContext {
  orchestrator: PipelineOrchestrator;
  /** Bearer secret — same as Beekeeper's adminSecret. */
  adminSecret: string;
  readBody: (req: IncomingMessage) => Promise<string>;
}

function isLoopback(req: IncomingMessage): boolean {
  const r = req.socket.remoteAddress;
  return r === "127.0.0.1" || r === "::1" || r === "::ffff:127.0.0.1";
}

function verifyAdmin(req: IncomingMessage, expected: string): boolean {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return false;
  const provided = Buffer.from(auth.slice(7));
  const exp = Buffer.from(expected);
  if (provided.length !== exp.length) return false;
  return timingSafeEqual(provided, exp);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Dispatch admin pipeline endpoints. Returns true if the request was matched
 * and handled (caller should NOT continue handling). Returns false if the URL
 * doesn't match any pipeline admin route.
 */
export async function handlePipelineAdminRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: PipelineAdminContext,
): Promise<boolean> {
  const url = req.url ?? "/";
  const path = url.split("?")[0];
  if (!path.startsWith("/admin/pipeline/jobs")) return false;

  if (!isLoopback(req)) {
    log.warn("Rejected non-loopback /admin/pipeline/jobs", { remote: req.socket.remoteAddress ?? "unknown" });
    send(res, 403, { error: "Forbidden" });
    return true;
  }
  if (!verifyAdmin(req, ctx.adminSecret)) {
    send(res, 401, { error: "Unauthorized" });
    return true;
  }

  // POST /admin/pipeline/jobs
  if (req.method === "POST" && path === "/admin/pipeline/jobs") {
    let body: string;
    try { body = await ctx.readBody(req); }
    catch (err) { send(res, 413, { error: String(err) }); return true; }
    let parsed: SpawnInput;
    try {
      const obj = JSON.parse(body) as Partial<SpawnInput>;
      if (typeof obj.kind !== "string" || !VALID_KINDS.includes(obj.kind as SubagentKind)) {
        send(res, 400, { error: `kind must be one of ${VALID_KINDS.join(", ")}` });
        return true;
      }
      if (typeof obj.prompt !== "string" || !obj.prompt) {
        send(res, 400, { error: "prompt required" }); return true;
      }
      if (typeof obj.repoPath !== "string" || !obj.repoPath) {
        send(res, 400, { error: "repoPath required" }); return true;
      }
      if (typeof obj.ticketId !== "string" || !obj.ticketId) {
        send(res, 400, { error: "ticketId required" }); return true;
      }
      parsed = obj as SpawnInput;
    } catch {
      send(res, 400, { error: "invalid JSON" });
      return true;
    }
    try {
      const result = await ctx.orchestrator.spawn(parsed);
      send(res, 202, result);
    } catch (err) {
      if (err instanceof TicketBusyError) {
        send(res, 409, { error: "ticket-busy", existingAgentId: err.existingAgentId });
        return true;
      }
      log.error("spawn failed", { error: err instanceof Error ? err.message : String(err) });
      send(res, 500, { error: "spawn failed" });
    }
    return true;
  }

  // GET /admin/pipeline/jobs/:id
  const getMatch = path.match(/^\/admin\/pipeline\/jobs\/([^/]+)$/);
  if (req.method === "GET" && getMatch) {
    const job = ctx.orchestrator.get(getMatch[1]);
    if (!job) { send(res, 404, { error: "unknown agentId" }); return true; }
    send(res, 200, job);
    return true;
  }

  // POST /admin/pipeline/jobs/:id/cancel
  const cancelMatch = path.match(/^\/admin\/pipeline\/jobs\/([^/]+)\/cancel$/);
  if (req.method === "POST" && cancelMatch) {
    const agentId = cancelMatch[1];
    const job = ctx.orchestrator.get(agentId);
    if (!job) { send(res, 404, { error: "unknown agentId" }); return true; }
    await ctx.orchestrator.cancel(agentId);
    send(res, 200, { agentId, state: "interrupted" });
    return true;
  }

  send(res, 404, { error: "not found" });
  return true;
}
