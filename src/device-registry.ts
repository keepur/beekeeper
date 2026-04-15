import Database from "better-sqlite3";
import { randomUUID, randomInt } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import jwt from "jsonwebtoken";
import { createLogger } from "./logging/logger.js";
import { createCryptoContext, type CryptoContext } from "./crypto.js";

const log = createLogger("beekeeper-device-registry");

export interface BeekeeperUser {
  id: string;
  display: string;
  active: boolean;
  createdAt: Date;
}

export interface BeekeeperDevice {
  _id: string;
  label: string;
  userId: string;
  pairingCode?: string;
  pairingCodeExpiresAt?: Date;
  createdAt: Date;
  lastSeenAt: Date;
  pairedAt?: Date;
  active: boolean;
}

interface UserRow {
  id: string;
  display: string;
  active: number;
  created_at: string;
}

interface DeviceRow {
  id: string;
  label: string;
  user_id: string;
  active: number;
  created_at: string;
  paired_at: string | null;
  last_seen: string;
  pairing_code: string | null;
  pairing_code_exp: string | null;
}

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;

const CREATE_USERS_TABLE = `
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  display    TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
)`;

const CREATE_DEVICES_TABLE = `
CREATE TABLE IF NOT EXISTS devices (
  id               TEXT PRIMARY KEY,
  label            TEXT NOT NULL,
  user_id          TEXT NOT NULL REFERENCES users(id),
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  paired_at        TEXT,
  last_seen        TEXT NOT NULL,
  pairing_code     TEXT,
  pairing_code_exp TEXT
)`;

export class DeviceRegistry {
  private db!: Database.Database;
  private jwtSecret: string;
  private dbPath: string;
  private dataDir: string;
  private crypto!: CryptoContext;

  constructor(dbPath: string, jwtSecret: string, dataDir: string) {
    this.dbPath = dbPath;
    this.jwtSecret = jwtSecret;
    this.dataDir = dataDir;
  }

  open(): void {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    chmodSync(this.dbPath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    // KPR-21: hard reset. Only Mokie's devices exist; they will re-pair.
    // Safe because: (a) sole operator, (b) JWTs become invalid on schema
    // change anyway, (c) re-pair flow is one CLI command per device.
    const hasOldDevices = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='devices'")
      .get() as { name?: string } | undefined;
    if (hasOldDevices) {
      const cols = this.db.prepare("PRAGMA table_info(devices)").all() as Array<{ name: string }>;
      const hasUserId = cols.some((c) => c.name === "user_id");
      if (!hasUserId) {
        log.warn("Dropping pre-KPR-21 devices table; devices must re-pair");
        this.db.exec("DROP TABLE devices");
      }
    }

    this.db.exec(CREATE_USERS_TABLE);
    this.db.exec(CREATE_DEVICES_TABLE);
    this.crypto = createCryptoContext(this.jwtSecret, this.dataDir);
    log.info("Device registry opened", { path: this.dbPath });
  }

  private rowToUser(row: UserRow): BeekeeperUser {
    return {
      id: row.id,
      display: row.display,
      active: row.active === 1,
      createdAt: new Date(row.created_at),
    };
  }

  addUser(id: string, display: string): BeekeeperUser {
    if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(id)) {
      throw new Error("User id must be 1-31 chars, lowercase alnum + _ -");
    }
    const existing = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as
      | UserRow
      | undefined;
    if (existing) {
      if (existing.active === 1) throw new Error(`User already exists: ${id}`);
      this.db
        .prepare("UPDATE users SET active = 1, display = ? WHERE id = ?")
        .run(display, id);
      return this.rowToUser({ ...existing, active: 1, display });
    }
    const row: UserRow = {
      id,
      display,
      active: 1,
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO users (id, display, active, created_at) VALUES (@id, @display, @active, @created_at)")
      .run(row);
    log.info("User added", { id });
    return this.rowToUser(row);
  }

  getUser(id: string): BeekeeperUser | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return row ? this.rowToUser(row) : null;
  }

  listUsers(): BeekeeperUser[] {
    const rows = this.db
      .prepare("SELECT * FROM users ORDER BY created_at ASC")
      .all() as UserRow[];
    return rows.map((r) => this.rowToUser(r));
  }

  /** Soft delete — sets active=0. Fails if the user doesn't exist. */
  removeUser(id: string): boolean {
    const result = this.db
      .prepare("UPDATE users SET active = 0 WHERE id = ? AND active = 1")
      .run(id);
    if (result.changes > 0) {
      log.info("User soft-deleted", { id });
      return true;
    }
    return false;
  }

  private rowToDevice(row: DeviceRow): BeekeeperDevice {
    return {
      _id: row.id,
      label: row.label,
      userId: row.user_id,
      active: row.active === 1,
      createdAt: new Date(row.created_at),
      pairedAt: row.paired_at ? new Date(row.paired_at) : undefined,
      lastSeenAt: new Date(row.last_seen),
      pairingCode: row.pairing_code ? this.crypto.decrypt(row.pairing_code) : undefined,
      pairingCodeExpiresAt: row.pairing_code_exp ? new Date(row.pairing_code_exp) : undefined,
    };
  }

  /** Create a device bound to `userId`. Caller must validate the user is active. */
  createDevice(userId: string, label: string): BeekeeperDevice {
    const user = this.db.prepare("SELECT * FROM users WHERE id = ? AND active = 1").get(userId) as
      | UserRow
      | undefined;
    if (!user) throw new Error(`Unknown or inactive user: ${userId}`);

    const now = new Date();
    const code = randomInt(100000, 1000000).toString();
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS);

    const row: DeviceRow = {
      id: randomUUID(),
      label,
      user_id: userId,
      active: 1,
      created_at: now.toISOString(),
      paired_at: null,
      last_seen: now.toISOString(),
      pairing_code: this.crypto.encrypt(code),
      pairing_code_exp: expiresAt.toISOString(),
    };

    this.db
      .prepare(
        `INSERT INTO devices (id, label, user_id, active, created_at, paired_at, last_seen, pairing_code, pairing_code_exp)
         VALUES (@id, @label, @user_id, @active, @created_at, @paired_at, @last_seen, @pairing_code, @pairing_code_exp)`,
      )
      .run(row);

    log.info("Device created", { id: row.id, label, userId });
    return { ...this.rowToDevice(row), pairingCode: code, pairingCodeExpiresAt: expiresAt };
  }

  getDevice(deviceId: string): BeekeeperDevice | null {
    const row = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId) as DeviceRow | undefined;
    return row ? this.rowToDevice(row) : null;
  }

  verifyPairingCode(
    code: string,
    label?: string,
  ): { device: BeekeeperDevice; token: string } | null {
    const now = new Date();
    const rows = this.db
      .prepare(
        "SELECT * FROM devices WHERE active = 1 AND pairing_code IS NOT NULL AND pairing_code_exp > ?",
      )
      .all(now.toISOString()) as DeviceRow[];

    const matchRow = rows.find((row) => {
      try {
        return this.crypto.decrypt(row.pairing_code!) === code;
      } catch {
        return false;
      }
    });

    if (!matchRow) {
      log.warn("Pairing code invalid or expired");
      return null;
    }

    const updates: Record<string, unknown> = {
      paired_at: now.toISOString(),
      pairing_code: null,
      pairing_code_exp: null,
    };
    if (label) updates.label = label;

    const setClauses = Object.keys(updates).map((k) => `${k} = @${k}`).join(", ");
    this.db
      .prepare(`UPDATE devices SET ${setClauses} WHERE id = @id`)
      .run({ ...updates, id: matchRow.id });

    const finalLabel = label ?? matchRow.label;
    // JWT carries both deviceId and user so WS auth is a single DB hit.
    const token = jwt.sign(
      { deviceId: matchRow.id, user: matchRow.user_id },
      this.jwtSecret,
      { expiresIn: "90d" },
    );
    log.info("Device paired", { id: matchRow.id, label: finalLabel, user: matchRow.user_id });

    const device: BeekeeperDevice = {
      _id: matchRow.id,
      label: finalLabel,
      userId: matchRow.user_id,
      active: true,
      createdAt: new Date(matchRow.created_at),
      pairedAt: now,
      lastSeenAt: new Date(matchRow.last_seen),
      pairingCode: undefined,
      pairingCodeExpiresAt: undefined,
    };
    return { device, token };
  }

  /**
   * Returns the device and the server-asserted user id from the token.
   * The user id is read from the JWT (baked in at pair time), not re-derived
   * from the devices row, so a token stays coherent even if the device row
   * is mid-update. Also hard-fails if the user has been soft-deleted, so
   * removing a user revokes all of their devices immediately.
   */
  verifyToken(token: string): { device: BeekeeperDevice; user: string } | null {
    try {
      const payload = jwt.verify(token, this.jwtSecret) as { deviceId: string; user: string };
      if (!payload.deviceId || !payload.user) {
        log.warn("Token missing required claims");
        return null;
      }
      const row = this.db
        .prepare("SELECT * FROM devices WHERE id = ? AND active = 1")
        .get(payload.deviceId) as DeviceRow | undefined;
      if (!row) {
        log.warn("Token valid but device not found or inactive", { deviceId: payload.deviceId });
        return null;
      }
      const user = this.db
        .prepare("SELECT id FROM users WHERE id = ? AND active = 1")
        .get(payload.user) as { id?: string } | undefined;
      if (!user?.id) {
        log.warn("Token user no longer active", { user: payload.user });
        return null;
      }
      return { device: this.rowToDevice(row), user: payload.user };
    } catch (e: unknown) {
      log.warn("Token verification failed", {
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  refreshPairingCode(deviceId: string): string | null {
    const code = randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
    const result = this.db.prepare(
      "UPDATE devices SET pairing_code = ?, pairing_code_exp = ? WHERE id = ? AND active = 1"
    ).run(this.crypto.encrypt(code), expiresAt.toISOString(), deviceId);

    if (result.changes === 0) {
      log.warn("Refresh pairing code failed — device not found", { deviceId });
      return null;
    }
    log.info("Pairing code refreshed", { deviceId });
    return code;
  }

  updateLastSeen(deviceId: string): void {
    this.db.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").run(new Date().toISOString(), deviceId);
  }

  updateDevice(deviceId: string, fields: { label?: string }): BeekeeperDevice | null {
    const setClauses = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => `${k} = @${k}`)
      .join(", ");
    if (!setClauses) return this.getDevice(deviceId);

    this.db.prepare(`UPDATE devices SET ${setClauses} WHERE id = @id`).run({ ...fields, id: deviceId });
    const result = this.getDevice(deviceId);
    if (result) log.info("Device updated", { deviceId, ...fields });
    return result;
  }

  deactivateDevice(deviceId: string): boolean {
    const result = this.db.prepare("UPDATE devices SET active = 0 WHERE id = ? AND active = 1").run(deviceId);
    if (result.changes > 0) {
      log.info("Device deactivated", { deviceId });
      return true;
    }
    return false;
  }

  listDevices(): BeekeeperDevice[] {
    const rows = this.db.prepare("SELECT * FROM devices").all() as DeviceRow[];
    return rows.map((row) => this.rowToDevice(row));
  }

  close(): void {
    this.db.close();
    log.info("Device registry closed");
  }
}
