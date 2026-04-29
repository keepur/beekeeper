import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "./logging/logger.js";
import type { CapabilityManifest } from "./capabilities.js";
import type { SessionManager } from "./session-manager.js";

const log = createLogger("beekeeper-admin");

export interface AdminHandlerDeps {
  sessionManager: Pick<SessionManager, "getAdminSessions">;
  capabilities: Pick<CapabilityManifest, "listAdmin">;
  adminSecret: string;
}

/**
 * Bearer-token check using constant-time comparison. Both sides are encoded
 * as buffers so a length mismatch can't leak through `timingSafeEqual` (which
 * throws on mismatched lengths).
 */
function verifyAdminBearer(req: IncomingMessage, adminSecret: string): boolean {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return false;
  const provided = Buffer.from(auth.slice(7));
  const expected = Buffer.from(adminSecret);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Loopback check used to gate /admin/* and /internal/* routes. Accepts the
 * three forms node reports for localhost connections — IPv4, IPv6, and the
 * IPv4-mapped IPv6 form (`::ffff:127.0.0.1`) that surfaces on dual-stack
 * sockets.
 */
export function isLoopback(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress;
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

/**
 * Handle a request under `/admin/*`. Returns true if the request was matched
 * (handled or rejected); false if the path doesn't start with `/admin/` so
 * the outer dispatcher can continue.
 *
 * Auth posture: BOTH loopback origin AND Bearer admin-secret are required.
 * A leaked admin secret cannot be used from off-box; a process on the same
 * box without the secret cannot read admin state.
 */
export function handleAdminRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminHandlerDeps,
): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/admin/")) return false;

  if (!isLoopback(req)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Loopback-only endpoint" }));
    return true;
  }
  if (!verifyAdminBearer(req, deps.adminSecret)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/admin/sessions") {
    try {
      const sessions = deps.sessionManager.getAdminSessions();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessions }));
    } catch (err) {
      log.error("GET /admin/sessions error", { error: String(err) });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/admin/capabilities") {
    try {
      const entries = deps.capabilities.listAdmin();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ capabilities: entries }));
    } catch (err) {
      log.error("GET /admin/capabilities error", { error: String(err) });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
    return true;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
  return true;
}
