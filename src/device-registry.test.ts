import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("./logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { DeviceRegistry } from "./device-registry.js";

const TEST_DIR = join(tmpdir(), `beekeeper-test-${Date.now()}`);
const DB_PATH = join(TEST_DIR, "devices.db");
const JWT_SECRET = "test-secret-key-for-beekeeper";

describe("DeviceRegistry", () => {
  let registry: DeviceRegistry;

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    registry = new DeviceRegistry(DB_PATH, JWT_SECRET, TEST_DIR);
    registry.open();
  });

  afterEach(() => {
    registry.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("createDevice", () => {
    it("creates device with expected shape", () => {
      const device = registry.createDevice("My iPad");

      expect(device._id).toBeDefined();
      expect(device.name).toBe("My iPad");
      expect(device.pairingCode).toMatch(/^\d{6}$/);
      expect(device.pairingCodeExpiresAt).toBeInstanceOf(Date);
      expect(device.createdAt).toBeInstanceOf(Date);
      expect(device.lastSeenAt).toBeInstanceOf(Date);
      expect(device.active).toBe(true);
      expect(device.pairedAt).toBeUndefined();
    });
  });

  describe("getDevice", () => {
    it("retrieves device by ID", () => {
      const created = registry.createDevice("Test");
      const found = registry.getDevice(created._id);

      expect(found).not.toBeNull();
      expect(found!._id).toBe(created._id);
      expect(found!.name).toBe("Test");
    });

    it("returns null for unknown ID", () => {
      expect(registry.getDevice("nonexistent")).toBeNull();
    });
  });

  describe("verifyPairingCode", () => {
    it("pairs device and returns JWT", () => {
      const created = registry.createDevice("Test");
      const result = registry.verifyPairingCode(created.pairingCode!);

      expect(result).not.toBeNull();
      expect(result!.token).toBeDefined();
      expect(result!.device._id).toBe(created._id);
      expect(result!.device.pairedAt).toBeInstanceOf(Date);
      expect(result!.device.pairingCode).toBeUndefined();
    });

    it("applies optional name override", () => {
      const created = registry.createDevice("Old Name");
      const result = registry.verifyPairingCode(created.pairingCode!, "New Name");

      expect(result!.device.name).toBe("New Name");
    });

    it("returns null for invalid code", () => {
      registry.createDevice("Test");
      expect(registry.verifyPairingCode("000000")).toBeNull();
    });

    it("clears pairing code after successful pairing", () => {
      const created = registry.createDevice("Test");
      registry.verifyPairingCode(created.pairingCode!);

      const after = registry.getDevice(created._id);
      expect(after!.pairingCode).toBeUndefined();
      expect(after!.pairingCodeExpiresAt).toBeUndefined();
    });
  });

  describe("verifyToken", () => {
    it("returns device for valid token", () => {
      const created = registry.createDevice("Test");
      const paired = registry.verifyPairingCode(created.pairingCode!);
      const device = registry.verifyToken(paired!.token);

      expect(device).not.toBeNull();
      expect(device!._id).toBe(created._id);
    });

    it("returns null for invalid token", () => {
      expect(registry.verifyToken("garbage")).toBeNull();
    });

    it("returns null for deactivated device", () => {
      const created = registry.createDevice("Test");
      const paired = registry.verifyPairingCode(created.pairingCode!);
      registry.deactivateDevice(created._id);

      expect(registry.verifyToken(paired!.token)).toBeNull();
    });
  });

  describe("refreshPairingCode", () => {
    it("returns new code for existing device", () => {
      const created = registry.createDevice("Test");
      const code = registry.refreshPairingCode(created._id);

      expect(code).toMatch(/^\d{6}$/);
    });

    it("returns null for unknown device", () => {
      expect(registry.refreshPairingCode("nonexistent")).toBeNull();
    });
  });

  describe("updateDevice", () => {
    it("updates name", () => {
      const created = registry.createDevice("Old");
      const updated = registry.updateDevice(created._id, { name: "New" });

      expect(updated!.name).toBe("New");
    });
  });

  describe("deactivateDevice", () => {
    it("returns true for active device", () => {
      const created = registry.createDevice("Test");
      expect(registry.deactivateDevice(created._id)).toBe(true);
    });

    it("returns false for unknown device", () => {
      expect(registry.deactivateDevice("nonexistent")).toBe(false);
    });
  });

  describe("listDevices", () => {
    it("returns all devices", () => {
      registry.createDevice("One");
      registry.createDevice("Two");

      const devices = registry.listDevices();
      expect(devices).toHaveLength(2);
    });
  });

  describe("encryption", () => {
    it("pairing codes are encrypted at rest", async () => {
      const created = registry.createDevice("Test");

      // Read raw DB — pairing_code column should NOT be the plaintext code
      const Database = (await import("better-sqlite3")).default;
      const rawDb = new Database(DB_PATH, { readonly: true });
      const row = rawDb.prepare("SELECT pairing_code FROM devices WHERE id = ?").get(created._id) as any;
      rawDb.close();

      expect(row.pairing_code).not.toBe(created.pairingCode);
      expect(row.pairing_code).toBeTruthy(); // encrypted, not null
    });
  });
});
