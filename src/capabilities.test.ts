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

    it("startHealthLoop is idempotent and stopHealthLoop is safe to call twice", () => {
      manifest.startHealthLoop(60_000, 2);
      manifest.startHealthLoop(60_000, 2);
      manifest.stopHealthLoop();
      manifest.stopHealthLoop();
    });
  });
});
