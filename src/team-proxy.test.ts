import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer, WebSocket as WsWebSocket, type RawData } from "ws";
import type { AddressInfo } from "net";
import { createServer, type Server } from "http";
import { proxyTeamConnection } from "./team-proxy.js";
import type { CapabilityEntry } from "./capabilities.js";

interface HiveHarness {
  wss: WebSocketServer;
  httpServer: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
  lastInternalUrl?: string;
  connections: WsWebSocket[];
}

async function startHive(options: { failAccept?: boolean } = {}): Promise<HiveHarness> {
  const httpServer = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const connections: WsWebSocket[] = [];
  const harness: HiveHarness = {
    wss,
    httpServer,
    port: 0,
    url: "",
    connections,
    close: async () => {
      for (const c of connections) {
        try {
          c.terminate();
        } catch {
          /* ignore */
        }
      }
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };

  httpServer.on("upgrade", (req, socket, head) => {
    if (options.failAccept) {
      socket.destroy();
      return;
    }
    harness.lastInternalUrl = req.url;
    wss.handleUpgrade(req, socket, head, (ws) => {
      connections.push(ws);
      wss.emit("connection", ws, req);
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = httpServer.address() as AddressInfo;
  harness.port = addr.port;
  harness.url = `ws://127.0.0.1:${addr.port}`;
  return harness;
}

interface ClientPairHarness {
  clientServer: WebSocketServer;
  clientHttp: Server;
  clientUrl: string;
  close: () => Promise<void>;
  acceptNext: () => Promise<WsWebSocket>;
}

async function startClientAcceptor(): Promise<ClientPairHarness> {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const addr = httpServer.address() as AddressInfo;
  return {
    clientServer: wss,
    clientHttp: httpServer,
    clientUrl: `ws://127.0.0.1:${addr.port}`,
    acceptNext: () =>
      new Promise<WsWebSocket>((resolve) => {
        wss.once("connection", (ws) => resolve(ws));
      }),
    close: async () => {
      wss.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function makeHiveEntry(localWsUrl: string): CapabilityEntry {
  return {
    name: "hive",
    localWsUrl,
    healthUrl: localWsUrl.replace(/^ws/, "http") + "/health",
    consecutiveFailures: 0,
    lastCheckedAt: null,
    addedAt: Date.now(),
  };
}

const DEVICE = { _id: "dev-123", name: "Test Device" };

function waitOpen(ws: WsWebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WsWebSocket.OPEN) return resolve();
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitClose(ws: WsWebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code: number, reason: Buffer) => {
      resolve({ code, reason: reason.toString("utf8") });
    });
  });
}

describe("proxyTeamConnection", () => {
  let hive: HiveHarness | undefined;
  let acceptor: ClientPairHarness | undefined;

  afterEach(async () => {
    if (hive) {
      await hive.close();
      hive = undefined;
    }
    if (acceptor) {
      await acceptor.close();
      acceptor = undefined;
    }
  });

  it("passes device identity in upstream URL with ?internal=1", async () => {
    hive = await startHive();
    acceptor = await startClientAcceptor();

    const clientSidePromise = acceptor.acceptNext();
    const outgoing = new WsWebSocket(acceptor.clientUrl);
    await waitOpen(outgoing);
    const serverClient = await clientSidePromise;

    proxyTeamConnection(serverClient, DEVICE, makeHiveEntry(hive.url));
    // wait for upstream to appear
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (hive && hive.connections.length > 0) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });

    expect(hive.lastInternalUrl).toBeDefined();
    expect(hive.lastInternalUrl).toContain("internal=1");
    expect(hive.lastInternalUrl).toContain("deviceId=dev-123");
    expect(hive.lastInternalUrl).toContain("name=Test%20Device");

    outgoing.close();
  });

  it("forwards text messages in both directions verbatim", async () => {
    hive = await startHive();
    acceptor = await startClientAcceptor();

    const clientSidePromise = acceptor.acceptNext();
    const outgoing = new WsWebSocket(acceptor.clientUrl);
    await waitOpen(outgoing);
    const serverClient = await clientSidePromise;

    proxyTeamConnection(serverClient, DEVICE, makeHiveEntry(hive.url));
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (hive && hive.connections.length > 0) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });

    const upstream = hive.connections[0]!;

    // upstream -> client
    const gotFromUpstream = new Promise<string>((resolve) => {
      outgoing.once("message", (data: RawData, isBinary: boolean) => {
        expect(isBinary).toBe(false);
        resolve(data.toString());
      });
    });
    upstream.send("hello-client");
    expect(await gotFromUpstream).toBe("hello-client");

    // client -> upstream
    const gotFromClient = new Promise<string>((resolve) => {
      upstream.once("message", (data: RawData, isBinary: boolean) => {
        expect(isBinary).toBe(false);
        resolve(data.toString());
      });
    });
    outgoing.send("hello-upstream");
    expect(await gotFromClient).toBe("hello-upstream");

    outgoing.close();
  });

  it("forwards binary messages preserving the binary flag", async () => {
    hive = await startHive();
    acceptor = await startClientAcceptor();

    const clientSidePromise = acceptor.acceptNext();
    const outgoing = new WsWebSocket(acceptor.clientUrl);
    await waitOpen(outgoing);
    const serverClient = await clientSidePromise;

    proxyTeamConnection(serverClient, DEVICE, makeHiveEntry(hive.url));
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (hive && hive.connections.length > 0) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });

    const upstream = hive.connections[0]!;

    const payload = Buffer.from([1, 2, 3, 4, 250, 255]);
    const got = new Promise<{ buf: Buffer; isBinary: boolean }>((resolve) => {
      outgoing.once("message", (data: RawData, isBinary: boolean) => {
        resolve({ buf: Buffer.from(data as Buffer), isBinary });
      });
    });
    upstream.send(payload, { binary: true });
    const res = await got;
    expect(res.isBinary).toBe(true);
    expect(Buffer.compare(res.buf, payload)).toBe(0);

    outgoing.close();
  });

  it("propagates close code + reason from client to upstream", async () => {
    hive = await startHive();
    acceptor = await startClientAcceptor();

    const clientSidePromise = acceptor.acceptNext();
    const outgoing = new WsWebSocket(acceptor.clientUrl);
    await waitOpen(outgoing);
    const serverClient = await clientSidePromise;

    proxyTeamConnection(serverClient, DEVICE, makeHiveEntry(hive.url));
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (hive && hive.connections.length > 0) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });

    const upstream = hive.connections[0]!;
    const upstreamClosed = waitClose(upstream);

    outgoing.close(4010, "client-bye");
    const res = await upstreamClosed;
    expect(res.code).toBe(4010);
    expect(res.reason).toBe("client-bye");
  });

  it("propagates close code + reason from upstream to client", async () => {
    hive = await startHive();
    acceptor = await startClientAcceptor();

    const clientSidePromise = acceptor.acceptNext();
    const outgoing = new WsWebSocket(acceptor.clientUrl);
    await waitOpen(outgoing);
    const serverClient = await clientSidePromise;

    proxyTeamConnection(serverClient, DEVICE, makeHiveEntry(hive.url));
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (hive && hive.connections.length > 0) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });

    const upstream = hive.connections[0]!;
    const outgoingClosed = waitClose(outgoing);
    upstream.close(4020, "upstream-bye");

    const res = await outgoingClosed;
    expect(res.code).toBe(4020);
    expect(res.reason).toBe("upstream-bye");
  });

  it("closes client with 1011 hive-unavailable when upstream connect fails", async () => {
    acceptor = await startClientAcceptor();

    const clientSidePromise = acceptor.acceptNext();
    const outgoing = new WsWebSocket(acceptor.clientUrl);
    await waitOpen(outgoing);
    const serverClient = await clientSidePromise;

    // Point at a closed port — pick 1 which should refuse.
    const badEntry = makeHiveEntry("ws://127.0.0.1:1");
    proxyTeamConnection(serverClient, DEVICE, badEntry);

    const res = await waitClose(outgoing);
    expect(res.code).toBe(1011);
    expect(res.reason).toBe("hive-unavailable");
  });

  it("handles backpressure by pausing without losing messages", async () => {
    hive = await startHive();
    acceptor = await startClientAcceptor();

    const clientSidePromise = acceptor.acceptNext();
    const outgoing = new WsWebSocket(acceptor.clientUrl);
    await waitOpen(outgoing);
    const serverClient = await clientSidePromise;

    // Tiny threshold so backpressure kicks in immediately.
    proxyTeamConnection(serverClient, DEVICE, makeHiveEntry(hive.url), {
      backpressureThresholdBytes: 128,
      backpressureResumePollMs: 5,
    });

    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (hive && hive.connections.length > 0) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });
    const upstream = hive.connections[0]!;

    const received: string[] = [];
    outgoing.on("message", (data: RawData) => {
      received.push(data.toString());
    });

    const N = 50;
    const big = "x".repeat(512);
    for (let i = 0; i < N; i++) {
      upstream.send(`${i}:${big}`);
    }

    // wait until all messages received (eventual delivery despite backpressure)
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error("timeout waiting for delivery")), 3000);
      const tick = setInterval(() => {
        if (received.length >= N) {
          clearInterval(tick);
          clearTimeout(deadline);
          resolve();
        }
      }, 10);
    });

    expect(received.length).toBe(N);
    for (let i = 0; i < N; i++) {
      expect(received[i]!.startsWith(`${i}:`)).toBe(true);
    }

    outgoing.close();
  });

  it("dispose() closes both sides", async () => {
    hive = await startHive();
    acceptor = await startClientAcceptor();

    const clientSidePromise = acceptor.acceptNext();
    const outgoing = new WsWebSocket(acceptor.clientUrl);
    await waitOpen(outgoing);
    const serverClient = await clientSidePromise;

    const handle = proxyTeamConnection(serverClient, DEVICE, makeHiveEntry(hive.url));
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (hive && hive.connections.length > 0) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });
    const upstream = hive.connections[0]!;

    const outgoingClosed = waitClose(outgoing);
    const upstreamClosed = waitClose(upstream);
    handle.dispose();
    await outgoingClosed;
    await upstreamClosed;
  });
});
