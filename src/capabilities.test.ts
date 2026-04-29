import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { CapabilityManifest } from "./capabilities.js";

describe("CapabilityManifest", () => {
  let manifest: CapabilityManifest;

  beforeEach(() => {
    manifest = new CapabilityManifest();
  });

  afterEach(() => {
    manifest.stopHealthLoop();
    vi.restoreAllMocks();
  });

  describe("register / unregister", () => {
    it("registers a capability and returns the entry", () => {
      const entry = manifest.register({
        name: "hive",
        localWsUrl: "ws://127.0.0.1:4001/ws",
        healthUrl: "http://127.0.0.1:4001/health",
      });

      expect(entry.name).toBe("hive");
      expect(entry.consecutiveFailures).toBe(0);
      expect(entry.addedAt).toBeGreaterThan(0);
      expect(manifest.get("hive")).toBeDefined();
    });

    it("register is idempotent and resets failure count", () => {
      manifest.register({
        name: "hive",
        localWsUrl: "ws://127.0.0.1:4001/ws",
        healthUrl: "http://127.0.0.1:4001/health",
      });
      const first = manifest.get("hive")!;
      first.consecutiveFailures = 5;
      const originalAddedAt = first.addedAt;

      const updated = manifest.register({
        name: "hive",
        localWsUrl: "ws://127.0.0.1:4002/ws",
        healthUrl: "http://127.0.0.1:4002/health",
      });

      expect(updated.consecutiveFailures).toBe(0);
      expect(updated.localWsUrl).toBe("ws://127.0.0.1:4002/ws");
      // addedAt preserved across re-registration
      expect(updated.addedAt).toBe(originalAddedAt);
    });

    it("unregister removes the capability and returns true", () => {
      manifest.register({
        name: "hive",
        localWsUrl: "ws://127.0.0.1:4001/ws",
        healthUrl: "http://127.0.0.1:4001/health",
      });
      expect(manifest.unregister("hive")).toBe(true);
      expect(manifest.get("hive")).toBeUndefined();
      expect(manifest.unregister("hive")).toBe(false);
    });

    it("rejects registering the reserved beekeeper name", () => {
      expect(() =>
        manifest.register({
          name: "beekeeper",
          localWsUrl: "ws://127.0.0.1:4000/ws",
          healthUrl: "http://127.0.0.1:4000/health",
        }),
      ).toThrow(/reserved/);
    });
  });

  describe("list()", () => {
    it("always includes beekeeper first when empty", () => {
      expect(manifest.list()).toEqual(["beekeeper"]);
    });

    it("returns beekeeper followed by registered names sorted", () => {
      manifest.register({
        name: "hive",
        localWsUrl: "ws://127.0.0.1:4001/ws",
        healthUrl: "http://127.0.0.1:4001/health",
      });
      manifest.register({
        name: "archive",
        localWsUrl: "ws://127.0.0.1:4002/ws",
        healthUrl: "http://127.0.0.1:4002/health",
      });
      manifest.register({
        name: "memory",
        localWsUrl: "ws://127.0.0.1:4003/ws",
        healthUrl: "http://127.0.0.1:4003/health",
      });

      expect(manifest.list()).toEqual(["beekeeper", "archive", "hive", "memory"]);
    });

    it("supports parallel registration of two capabilities", async () => {
      await Promise.all([
        Promise.resolve().then(() =>
          manifest.register({
            name: "hive",
            localWsUrl: "ws://127.0.0.1:4001/ws",
            healthUrl: "http://127.0.0.1:4001/health",
          }),
        ),
        Promise.resolve().then(() =>
          manifest.register({
            name: "archive",
            localWsUrl: "ws://127.0.0.1:4002/ws",
            healthUrl: "http://127.0.0.1:4002/health",
          }),
        ),
      ]);

      expect(manifest.list()).toEqual(["beekeeper", "archive", "hive"]);
    });
  });

  describe("listAdmin()", () => {
    it("returns empty array when nothing registered", () => {
      // Unlike `list()`, listAdmin omits the implicit `beekeeper` entry —
      // operators using this know beekeeper is the host.
      expect(manifest.listAdmin()).toEqual([]);
    });

    it("returns full entries sorted by name", () => {
      manifest.register({
        name: "hive",
        localWsUrl: "ws://127.0.0.1:4001/ws",
        healthUrl: "http://127.0.0.1:4001/health",
      });
      manifest.register({
        name: "archive",
        localWsUrl: "ws://127.0.0.1:4002/ws",
        healthUrl: "http://127.0.0.1:4002/health",
      });

      const entries = manifest.listAdmin();
      expect(entries.map((e) => e.name)).toEqual(["archive", "hive"]);
      // Carries the operational metadata the CLI renders.
      expect(entries[0]).toMatchObject({
        name: "archive",
        localWsUrl: "ws://127.0.0.1:4002/ws",
        healthUrl: "http://127.0.0.1:4002/health",
        consecutiveFailures: 0,
      });
      expect(entries[0].addedAt).toBeGreaterThan(0);
    });
  });

  describe("health loop", () => {
    it("drops capability after reaching failure threshold", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false });
      vi.stubGlobal("fetch", fetchMock);

      manifest.register({
        name: "hive",
        localWsUrl: "ws://127.0.0.1:4001/ws",
        healthUrl: "http://127.0.0.1:4001/health",
      });

      await manifest.runHealthChecks(2);
      expect(manifest.get("hive")?.consecutiveFailures).toBe(1);

      await manifest.runHealthChecks(2);
      expect(manifest.get("hive")).toBeUndefined();
      expect(manifest.list()).toEqual(["beekeeper"]);
    });

    it("treats fetch rejection the same as non-2xx", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      vi.stubGlobal("fetch", fetchMock);

      manifest.register({
        name: "hive",
        localWsUrl: "ws://127.0.0.1:4001/ws",
        healthUrl: "http://127.0.0.1:4001/health",
      });

      await manifest.runHealthChecks(2);
      await manifest.runHealthChecks(2);
      expect(manifest.get("hive")).toBeUndefined();
    });

    it("successful probe resets failure count", async () => {
      let shouldFail = true;
      const fetchMock = vi.fn().mockImplementation(async () => {
        if (shouldFail) return { ok: false };
        return { ok: true };
      });
      vi.stubGlobal("fetch", fetchMock);

      manifest.register({
        name: "hive",
        localWsUrl: "ws://127.0.0.1:4001/ws",
        healthUrl: "http://127.0.0.1:4001/health",
      });

      await manifest.runHealthChecks(3);
      expect(manifest.get("hive")?.consecutiveFailures).toBe(1);

      shouldFail = false;
      await manifest.runHealthChecks(3);
      expect(manifest.get("hive")?.consecutiveFailures).toBe(0);
      expect(manifest.get("hive")?.lastCheckedAt).not.toBeNull();
    });

    it("ignores probe result if entry was re-registered during the await", async () => {
      // Race: health check fires, probe() takes a while, hive re-registers
      // mid-probe (resets failure count to 0), probe returns failure.
      // The stale probe result must NOT be applied to the freshly registered
      // entry — otherwise two such overlaps could evict a healthy Hive.
      let resolveProbe: (value: { ok: boolean }) => void;
      const probePromise = new Promise<{ ok: boolean }>((r) => {
        resolveProbe = r;
      });
      const fetchMock = vi.fn().mockReturnValue(probePromise);
      vi.stubGlobal("fetch", fetchMock);

      manifest.register({
        name: "hive",
        localWsUrl: "ws://127.0.0.1:4001/ws",
        healthUrl: "http://127.0.0.1:4001/health",
      });
      // Pre-existing failure from a prior round we want preserved-or-reset
      // correctly by the re-registration, not clobbered by the stale probe.
      manifest.get("hive")!.consecutiveFailures = 1;

      const checkRun = manifest.runHealthChecks(2);

      // Hive re-registers while probe is pending — fresh entry, failures=0.
      manifest.register({
        name: "hive",
        localWsUrl: "ws://127.0.0.1:4001/ws",
        healthUrl: "http://127.0.0.1:4001/health",
      });
      expect(manifest.get("hive")?.consecutiveFailures).toBe(0);

      // Probe finally returns failure — should be dropped on the floor.
      resolveProbe!({ ok: false });
      await checkRun;

      expect(manifest.get("hive")).toBeDefined();
      expect(manifest.get("hive")?.consecutiveFailures).toBe(0);
    });

    it("startHealthLoop is idempotent and stopHealthLoop is safe to call twice", () => {
      manifest.startHealthLoop(60_000, 2);
      manifest.startHealthLoop(60_000, 2);
      manifest.stopHealthLoop();
      manifest.stopHealthLoop();
    });
  });
});
