import { WebSocket as WsWebSocket, type RawData } from "ws";
import { createLogger } from "./logging/logger.js";
import type { CapabilityEntry } from "./capabilities.js";
import type { BeekeeperDevice } from "./device-registry.js";

const log = createLogger("beekeeper-team-proxy");

export interface ProxyDevice {
  _id: string;
  name: string;
}

export interface ProxyHandle {
  upstreamWs: WsWebSocket;
  dispose: () => void;
}

export interface ProxyTeamConnectionOptions {
  /** Backpressure threshold in bytes (default 4 MiB). */
  backpressureThresholdBytes?: number;
  /** Interval in ms for polling bufferedAmount when paused (default 50ms). */
  backpressureResumePollMs?: number;
  /** Upstream keepalive ping interval in ms (default 30_000). */
  upstreamPingIntervalMs?: number;
}

const DEFAULT_BACKPRESSURE_THRESHOLD = 4 * 1024 * 1024;
const DEFAULT_RESUME_POLL_MS = 50;
const DEFAULT_PING_INTERVAL_MS = 30_000;

/**
 * Proxy a client WebSocket to the Hive "team" upstream WebSocket.
 *
 * Opens an internal upstream connection (with `?internal=1`) that carries the
 * device identity in the URL. Bidirectionally pipes message/close frames, with
 * a backpressure mechanism that pauses the opposite side's underlying socket
 * when the receiver's send buffer grows beyond the threshold.
 *
 * On upstream connect failure, closes the client with code 1011
 * (`hive-unavailable`). Returns a handle so the caller can track the upstream
 * socket and dispose of both sides on revocation.
 */
export function proxyTeamConnection(
  clientWs: WsWebSocket,
  device: ProxyDevice | BeekeeperDevice,
  hiveEntry: CapabilityEntry,
  options: ProxyTeamConnectionOptions = {},
): ProxyHandle {
  const threshold = options.backpressureThresholdBytes ?? DEFAULT_BACKPRESSURE_THRESHOLD;
  const resumePollMs = options.backpressureResumePollMs ?? DEFAULT_RESUME_POLL_MS;
  const pingIntervalMs = options.upstreamPingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;

  const deviceId = (device as BeekeeperDevice)._id ?? (device as ProxyDevice)._id;
  const deviceName = device.name;

  const base = hiveEntry.localWsUrl.replace(/\/+$/, "");
  const upstreamUrl =
    base +
    "/?internal=1&deviceId=" +
    encodeURIComponent(deviceId) +
    "&name=" +
    encodeURIComponent(deviceName);

  log.info("Opening team upstream", { deviceId, hive: hiveEntry.name, url: base });

  const upstreamWs = new WsWebSocket(upstreamUrl);

  let opened = false;
  let disposed = false;
  let pingTimer: NodeJS.Timeout | null = null;
  const resumeTimers = new Set<NodeJS.Timeout>();

  const clearResumeTimers = (): void => {
    for (const t of resumeTimers) clearInterval(t);
    resumeTimers.clear();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    clearResumeTimers();
    try {
      if (
        clientWs.readyState === WsWebSocket.OPEN ||
        clientWs.readyState === WsWebSocket.CONNECTING
      ) {
        clientWs.close();
      }
    } catch {
      /* ignore */
    }
    try {
      if (
        upstreamWs.readyState === WsWebSocket.OPEN ||
        upstreamWs.readyState === WsWebSocket.CONNECTING
      ) {
        upstreamWs.close();
      }
    } catch {
      /* ignore */
    }
  };

  // Reach through ws internals to pause/resume underlying TCP socket.
  const pauseSocket = (side: WsWebSocket): void => {
    const sock = (side as unknown as { _socket?: { pause?: () => void; isPaused?: () => boolean } })
      ._socket;
    if (sock && typeof sock.pause === "function") {
      try {
        sock.pause();
      } catch {
        /* ignore */
      }
    }
  };
  const resumeSocket = (side: WsWebSocket): void => {
    const sock = (side as unknown as { _socket?: { resume?: () => void } })._socket;
    if (sock && typeof sock.resume === "function") {
      try {
        sock.resume();
      } catch {
        /* ignore */
      }
    }
  };

  /**
   * Forward a frame from `source` to `sink`. If `sink.bufferedAmount` is above
   * the threshold, pause `source`'s underlying socket and poll until drained,
   * then resume.
   */
  const forward = (source: WsWebSocket, sink: WsWebSocket, data: RawData, isBinary: boolean): void => {
    if (sink.readyState !== WsWebSocket.OPEN) return;
    try {
      sink.send(data, { binary: isBinary });
    } catch (err) {
      log.warn("Forward send failed", { err: (err as Error).message });
      return;
    }
    if (sink.bufferedAmount > threshold) {
      pauseSocket(source);
      const timer = setInterval(() => {
        if (disposed || sink.readyState !== WsWebSocket.OPEN) {
          clearInterval(timer);
          resumeTimers.delete(timer);
          resumeSocket(source);
          return;
        }
        if (sink.bufferedAmount <= threshold / 2) {
          clearInterval(timer);
          resumeTimers.delete(timer);
          resumeSocket(source);
        }
      }, resumePollMs);
      if (typeof timer.unref === "function") timer.unref();
      resumeTimers.add(timer);
    }
  };

  // ---- Upstream connect failure (before open) ----
  const onEarlyUpstreamError = (err: Error): void => {
    if (opened) return;
    log.warn("Upstream connect failed", { deviceId, err: err.message });
    try {
      if (
        clientWs.readyState === WsWebSocket.OPEN ||
        clientWs.readyState === WsWebSocket.CONNECTING
      ) {
        clientWs.close(1011, "hive-unavailable");
      }
    } catch {
      /* ignore */
    }
    dispose();
  };
  upstreamWs.once("error", onEarlyUpstreamError);

  // Also handle the case where upstream closes before opening.
  const onEarlyUpstreamClose = (code: number, reason: Buffer): void => {
    if (opened) return;
    log.warn("Upstream closed before open", { deviceId, code });
    try {
      if (
        clientWs.readyState === WsWebSocket.OPEN ||
        clientWs.readyState === WsWebSocket.CONNECTING
      ) {
        clientWs.close(1011, "hive-unavailable");
      }
    } catch {
      /* ignore */
    }
    dispose();
    void reason;
  };
  upstreamWs.once("close", onEarlyUpstreamClose);

  upstreamWs.once("open", () => {
    opened = true;
    upstreamWs.off("error", onEarlyUpstreamError);
    upstreamWs.off("close", onEarlyUpstreamClose);
    log.info("Team upstream open", { deviceId });

    // Keepalive ping upstream (do NOT forward client pings).
    pingTimer = setInterval(() => {
      if (upstreamWs.readyState === WsWebSocket.OPEN) {
        try {
          upstreamWs.ping();
        } catch {
          /* ignore */
        }
      }
    }, pingIntervalMs);
    if (typeof pingTimer.unref === "function") pingTimer.unref();

    // Client -> Upstream
    clientWs.on("message", (data: RawData, isBinary: boolean) => {
      forward(clientWs, upstreamWs, data, isBinary);
    });

    // Upstream -> Client
    upstreamWs.on("message", (data: RawData, isBinary: boolean) => {
      forward(upstreamWs, clientWs, data, isBinary);
    });

    // Close propagation: client -> upstream
    clientWs.on("close", (code: number, reason: Buffer) => {
      if (disposed) return;
      log.debug("Client closed, propagating to upstream", { deviceId, code });
      try {
        if (upstreamWs.readyState === WsWebSocket.OPEN) {
          upstreamWs.close(sanitizeCloseCode(code), reason);
        }
      } catch {
        /* ignore */
      }
      dispose();
    });

    // Close propagation: upstream -> client
    upstreamWs.on("close", (code: number, reason: Buffer) => {
      if (disposed) return;
      log.debug("Upstream closed, propagating to client", { deviceId, code });
      try {
        if (clientWs.readyState === WsWebSocket.OPEN) {
          clientWs.close(sanitizeCloseCode(code), reason);
        }
      } catch {
        /* ignore */
      }
      dispose();
    });

    // Error handlers (best-effort close with 1011)
    clientWs.on("error", (err: Error) => {
      log.warn("Client error", { deviceId, err: err.message });
      try {
        if (upstreamWs.readyState === WsWebSocket.OPEN) upstreamWs.close(1011);
      } catch {
        /* ignore */
      }
      dispose();
    });
    upstreamWs.on("error", (err: Error) => {
      log.warn("Upstream error", { deviceId, err: err.message });
      try {
        if (clientWs.readyState === WsWebSocket.OPEN) clientWs.close(1011);
      } catch {
        /* ignore */
      }
      dispose();
    });
  });

  return { upstreamWs, dispose };
}

/**
 * Close codes outside the valid range (or in the reserved 1005/1006 band) can't
 * be sent on the wire — normalize them to 1000 so close propagation doesn't
 * throw.
 */
function sanitizeCloseCode(code: number): number {
  if (code === 1005 || code === 1006) return 1000;
  if (code < 1000 || code > 4999) return 1000;
  return code;
}
