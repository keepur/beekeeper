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
  const USER_ID = "mokie";

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    registry = new DeviceRegistry(DB_PATH, JWT_SECRET, TEST_DIR);
    registry.open();
    registry.addUser(USER_ID, "Mokie Huang");
  });

  afterEach(() => {
    registry.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("createDevice", () => {
    it("creates device with expected shape", () => {
      const device = registry.createDevice(USER_ID, "My iPad");

      expect(device._id).toBeDefined();
      expect(device.label).toBe("My iPad");
      expect(device.userId).toBe(USER_ID);
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
      const created = registry.createDevice(USER_ID, "Test");
      const found = registry.getDevice(created._id);

      expect(found).not.toBeNull();
      expect(found!._id).toBe(created._id);
      expect(found!.label).toBe("Test");
    });

    it("returns null for unknown ID", () => {
      expect(registry.getDevice("nonexistent")).toBeNull();
    });
  });

  describe("verifyPairingCode", () => {
    it("pairs device and returns JWT", () => {
      const created = registry.createDevice(USER_ID, "Test");
      const result = registry.verifyPairingCode(created.pairingCode!);

      expect(result).not.toBeNull();
      expect(result!.token).toBeDefined();
      expect(result!.device._id).toBe(created._id);
      expect(result!.device.pairedAt).toBeInstanceOf(Date);
      expect(result!.device.pairingCode).toBeUndefined();
    });

    it("applies optional label override", () => {
      const created = registry.createDevice(USER_ID, "Old Name");
      const result = registry.verifyPairingCode(created.pairingCode!, "New Name");

      expect(result!.device.label).toBe("New Name");
    });

    it("returns null for invalid code", () => {
      registry.createDevice(USER_ID, "Test");
      expect(registry.verifyPairingCode("000000")).toBeNull();
    });

    it("clears pairing code after successful pairing", () => {
      const created = registry.createDevice(USER_ID, "Test");
      registry.verifyPairingCode(created.pairingCode!);

      const after = registry.getDevice(created._id);
      expect(after!.pairingCode).toBeUndefined();
      expect(after!.pairingCodeExpiresAt).toBeUndefined();
    });
  });

  describe("verifyToken", () => {
    it("returns device and user for valid token", () => {
      const created = registry.createDevice(USER_ID, "Test");
      const paired = registry.verifyPairingCode(created.pairingCode!);
      const result = registry.verifyToken(paired!.token);

      expect(result).not.toBeNull();
      expect(result!.device._id).toBe(created._id);
      expect(result!.user).toBe(USER_ID);
    });

    it("returns null for invalid token", () => {
      expect(registry.verifyToken("garbage")).toBeNull();
    });

    it("returns null for deactivated device", () => {
      const created = registry.createDevice(USER_ID, "Test");
      const paired = registry.verifyPairingCode(created.pairingCode!);
      registry.deactivateDevice(created._id);

      expect(registry.verifyToken(paired!.token)).toBeNull();
    });
  });

  describe("refreshPairingCode", () => {
    it("returns new code for existing device", () => {
      const created = registry.createDevice(USER_ID, "Test");
      const code = registry.refreshPairingCode(created._id);

      expect(code).toMatch(/^\d{6}$/);
    });

    it("returns null for unknown device", () => {
      expect(registry.refreshPairingCode("nonexistent")).toBeNull();
    });
  });

  describe("updateDevice", () => {
    it("updates label", () => {
      const created = registry.createDevice(USER_ID, "Old");
      const updated = registry.updateDevice(created._id, { label: "New" });

      expect(updated!.label).toBe("New");
    });
  });

  describe("deactivateDevice", () => {
    it("returns true for active device", () => {
      const created = registry.createDevice(USER_ID, "Test");
      expect(registry.deactivateDevice(created._id)).toBe(true);
    });

    it("returns false for unknown device", () => {
      expect(registry.deactivateDevice("nonexistent")).toBe(false);
    });
  });

  describe("listDevices", () => {
    it("returns all devices", () => {
      registry.createDevice(USER_ID, "One");
      registry.createDevice(USER_ID, "Two");

      const devices = registry.listDevices();
      expect(devices).toHaveLength(2);
    });
  });

  describe("encryption", () => {
    it("pairing codes are encrypted at rest", async () => {
      const created = registry.createDevice(USER_ID, "Test");

      // Read raw DB — pairing_code column should NOT be the plaintext code
      const Database = (await import("better-sqlite3")).default;
      const rawDb = new Database(DB_PATH, { readonly: true });
      const row = rawDb.prepare("SELECT pairing_code FROM devices WHERE id = ?").get(created._id) as any;
      rawDb.close();

      expect(row.pairing_code).not.toBe(created.pairingCode);
      expect(row.pairing_code).toBeTruthy(); // encrypted, not null
    });
  });

  describe("users", () => {
    it("addUser + getUser round trip", () => {
      const u = registry.addUser("may", "May");
      expect(u.id).toBe("may");
      expect(u.active).toBe(true);
      expect(registry.getUser("may")?.display).toBe("May");
    });

    it("rejects invalid user ids", () => {
      expect(() => registry.addUser("Mokie", "x")).toThrow(/1-31 chars/);
      expect(() => registry.addUser("", "x")).toThrow();
      expect(() => registry.addUser("a b", "x")).toThrow();
    });

    it("rejects duplicate active user", () => {
      registry.addUser("may", "May");
      expect(() => registry.addUser("may", "May H")).toThrow(/already exists/);
    });

    it("removeUser soft-deletes; addUser reactivates with new display", () => {
      registry.addUser("may", "May");
      expect(registry.removeUser("may")).toBe(true);
      expect(registry.removeUser("may")).toBe(false);
      const reactivated = registry.addUser("may", "May 2.0");
      expect(reactivated.active).toBe(true);
      expect(reactivated.display).toBe("May 2.0");
    });

    it("createDevice rejects unknown or inactive user", () => {
      expect(() => registry.createDevice("ghost", "iPad")).toThrow(/Unknown or inactive/);
      registry.removeUser(USER_ID);
      expect(() => registry.createDevice(USER_ID, "iPad")).toThrow(/Unknown or inactive/);
    });

    it("verifyToken returns null once user is soft-deleted", () => {
      const device = registry.createDevice(USER_ID, "iPad");
      const paired = registry.verifyPairingCode(device.pairingCode!);
      expect(paired).not.toBeNull();
      expect(registry.verifyToken(paired!.token)?.user).toBe(USER_ID);
      registry.removeUser(USER_ID);
      expect(registry.verifyToken(paired!.token)).toBeNull();
    });
  });
});
