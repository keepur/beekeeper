import Database from "better-sqlite3";
import { randomUUID, randomInt } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import jwt from "jsonwebtoken";
import { createLogger } from "./logging/logger.js";
import { createCryptoContext, type CryptoContext } from "./crypto.js";

const log = createLogger("relay-device-registry");

export interface RelayDevice {
  _id: string;
  name: string;
  pairingCode?: string;
  pairingCodeExpiresAt?: Date;
  createdAt: Date;
  lastSeenAt: Date;
  pairedAt?: Date;
  active: boolean;
}

interface DeviceRow {
  id: string;
  name: string;
  active: number;
  created_at: string;
  paired_at: string | null;
  last_seen: string;
  pairing_code: string | null;
  pairing_code_exp: string | null;
}

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS devices (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  active          INTEGER DEFAULT 1,
  created_at      TEXT NOT NULL,
  paired_at       TEXT,
  last_seen       TEXT NOT NULL,
  pairing_code    TEXT,
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
    this.db.exec(CREATE_TABLE);
    this.crypto = createCryptoContext(this.jwtSecret, this.dataDir);
    log.info("Device registry opened", { path: this.dbPath });
  }

  private rowToDevice(row: DeviceRow): RelayDevice {
    return {
      _id: row.id,
      name: row.name,
      active: row.active === 1,
      createdAt: new Date(row.created_at),
      pairedAt: row.paired_at ? new Date(row.paired_at) : undefined,
      lastSeenAt: new Date(row.last_seen),
      pairingCode: row.pairing_code ? this.crypto.decrypt(row.pairing_code) : undefined,
      pairingCodeExpiresAt: row.pairing_code_exp ? new Date(row.pairing_code_exp) : undefined,
    };
  }

  createDevice(name: string): RelayDevice {
    const now = new Date();
    const code = randomInt(100000, 1000000).toString();
    const expiresAt = new Date(now.getTime() + PAIRING_CODE_TTL_MS);

    const row: DeviceRow = {
      id: randomUUID(),
      name,
      active: 1,
      created_at: now.toISOString(),
      paired_at: null,
      last_seen: now.toISOString(),
      pairing_code: this.crypto.encrypt(code),
      pairing_code_exp: expiresAt.toISOString(),
    };

    this.db.prepare(
      `INSERT INTO devices (id, name, active, created_at, paired_at, last_seen, pairing_code, pairing_code_exp)
       VALUES (@id, @name, @active, @created_at, @paired_at, @last_seen, @pairing_code, @pairing_code_exp)`
    ).run(row);

    log.info("Device created", { id: row.id, name });
    return { ...this.rowToDevice(row), pairingCode: code, pairingCodeExpiresAt: expiresAt };
  }

  getDevice(deviceId: string): RelayDevice | null {
    const row = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(deviceId) as DeviceRow | undefined;
    return row ? this.rowToDevice(row) : null;
  }

  verifyPairingCode(code: string, name?: string): { device: RelayDevice; token: string } | null {
    const now = new Date();
    const rows = this.db.prepare(
      "SELECT * FROM devices WHERE active = 1 AND pairing_code IS NOT NULL AND pairing_code_exp > ?"
    ).all(now.toISOString()) as DeviceRow[];

    // Decrypt and match — can't query encrypted column directly
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
    if (name) updates.name = name;

    const setClauses = Object.keys(updates).map((k) => `${k} = @${k}`).join(", ");
    this.db.prepare(`UPDATE devices SET ${setClauses} WHERE id = @id`).run({ ...updates, id: matchRow.id });

    const finalName = name ?? matchRow.name;
    const token = jwt.sign({ deviceId: matchRow.id }, this.jwtSecret, { expiresIn: "90d" });
    log.info("Device paired", { id: matchRow.id, name: finalName });

    const device: RelayDevice = {
      _id: matchRow.id,
      name: finalName,
      active: true,
      createdAt: new Date(matchRow.created_at),
      pairedAt: now,
      lastSeenAt: new Date(matchRow.last_seen),
      pairingCode: undefined,
      pairingCodeExpiresAt: undefined,
    };
    return { device, token };
  }

  verifyToken(token: string): RelayDevice | null {
    try {
      const payload = jwt.verify(token, this.jwtSecret) as { deviceId: string };
      const row = this.db.prepare("SELECT * FROM devices WHERE id = ? AND active = 1").get(payload.deviceId) as DeviceRow | undefined;
      if (!row) {
        log.warn("Token valid but device not found or inactive", { deviceId: payload.deviceId });
        return null;
      }
      return this.rowToDevice(row);
    } catch (e: unknown) {
      log.warn("Token verification failed", { error: e instanceof Error ? e.message : String(e) });
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

  updateDevice(deviceId: string, fields: { name?: string }): RelayDevice | null {
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

  listDevices(): RelayDevice[] {
    const rows = this.db.prepare("SELECT * FROM devices").all() as DeviceRow[];
    return rows.map((row) => this.rowToDevice(row));
  }

  close(): void {
    this.db.close();
    log.info("Device registry closed");
  }
}
