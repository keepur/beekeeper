# KPR-21: Server-Asserted User Identity Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Bind every beekeeper device to a server-asserted `user` identity so agents (Claude Code via `channel=beekeeper`, Hive via `channel=team`) always know *who* is on the other end of a WebSocket, independent of the cosmetic device label the client supplies.

**Architecture:**
- New SQLite `users` table lives alongside `devices` in `devices.db`. `devices.user_id` is a foreign key. `beekeeper user add|list|rm` CLI manages the list; `beekeeper pair <user>` validates and binds.
- JWTs gain a `user` claim baked in at pair time. The WS upgrade handler resolves `user` from the verified token and hands it to both the `SessionManager` (beekeeper channel) and `proxyTeamConnection` (team channel).
- Team channel asserts `&user=` on the upstream URL to Hive — frames stay opaque. Beekeeper channel prepends an identity header to each inbound message before the SDK sees it.
- Schema migration is **drop-and-recreate** (Mokie is the only client; two paired devices will re-pair). No legacy preservation code.

**Tech Stack:** Node 22, TypeScript, `better-sqlite3`, `ws`, `@anthropic-ai/claude-agent-sdk`, `jsonwebtoken`, Vitest. Ticket: https://linear.app/keepur/issue/KPR-21

**Out of scope:**
- Hive-side changes (separate repo `bot-dodi/hive`) — we define the wire contract (`?user=<id>` on upstream URL) and coordinate in a follow-up.
- iOS clients — the label path already exists as `name` in `POST /pair`. No required client change.
- YAML config for users (rejected in brainstorm).

---

## File map

| File | Change |
|---|---|
| `src/device-registry.ts` | Drop-and-recreate schema. New `users` table + methods. Rename `devices.name` → `devices.label`. Add `devices.user_id` NOT NULL. JWT payload gains `user`. `verifyToken` returns `{ device, user }`. `createDevice(userId, label)`. |
| `src/device-registry.test.ts` | Update existing tests for the new signatures. Add tests for users CRUD, pair flow validates user, verifyToken surfaces user. |
| `src/cli.ts` | New `user` subcommand (`add`/`list`/`rm`). `pair <user>` validates user. Help text updated. |
| `src/index.ts` | `verifyDeviceToken` now returns `{ device, user }`. Upgrade handler passes `user` into `wss.emit("connection", ...)`. `POST /pair` accepts `label` (backcompat: also `name`). HTTP responses use `label` going forward. |
| `src/session-manager.ts` | `addClient(deviceId, user, ws)`. `sendMessage(sessionId, text, user)` prepends an identity header to the prompt before handing it to the SDK. |
| `src/session-manager.test.ts` | Update signatures in existing tests. Add one test asserting the identity header gets prepended. |
| `src/team-proxy.ts` | `ProxyTeamConnectionOptions.user` → appended as `&user=` on upstream URL. |
| `src/team-proxy.test.ts` | Add test asserting `user` lands in the upstream URL. |
| `src/types.ts` | No change — identity is server-stamped, never trusted from client. |

No new packages. No YAML parser. No new runtime dependency.

---

## Task 1: Users table + DeviceRegistry surface

**Files:**
- Modify: `src/device-registry.ts`
- Test: `src/device-registry.test.ts`

### Step 1: Schema + types

Replace the top of `src/device-registry.ts` (down through `CREATE_TABLE`) with:

```typescript
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
```

### Step 2: Drop-and-recreate in `open()`

Replace the body of `open()`:

```typescript
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
```

### Step 3: User CRUD methods

Append to `DeviceRegistry` (after `rowToDevice`, before `createDevice`):

```typescript
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
```

### Step 4: Rewrite device methods

Replace `rowToDevice`, `createDevice`, `verifyPairingCode`, `verifyToken`, and `updateDevice`:

```typescript
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
```

### Step 5: Update existing tests

In `src/device-registry.test.ts`, every test that calls `registry.createDevice("...")` must first create a user and pass its id. Add the user setup to `beforeEach`:

```typescript
  const USER_ID = "mokie";
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    registry = new DeviceRegistry(DB_PATH, JWT_SECRET, TEST_DIR);
    registry.open();
    registry.addUser(USER_ID, "Mokie Huang");
  });
```

Then:
- Replace every `createDevice("X")` with `createDevice(USER_ID, "X")`.
- Replace assertions on `device.name` with `device.label`.
- For `verifyToken` tests, unwrap the new shape: `const result = registry.verifyToken(token); expect(result).not.toBeNull(); expect(result!.user).toBe("mokie");`.

### Step 6: New tests for users + identity

Append to `src/device-registry.test.ts`:

```typescript
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
```

### Step 7: Verify

Run: `npm run test -- device-registry`
Expected: all tests green, including the new `users` block.

### Step 8: Commit

Use the commit skill or:

```
git add src/device-registry.ts src/device-registry.test.ts
git commit -m "feat(registry): users table + device→user binding in JWT (KPR-21)"
```

---

## Task 2: CLI — `user` subcommand + `pair <user>` validation

**Files:**
- Modify: `src/cli.ts` (the `pair` case, and add a new `user` case in the same switch)

### Step 1: Rewrite `pair` and add `user` subcommand

Replace the `case "pair":` block with a user-validated flow, and add a `case "user":` block for `add`/`list`/`rm`.

`pair` new shape:
- Usage: `beekeeper pair <user> [label]`
- Opens the registry, calls `getUser(userId)`, errors with a friendly "unknown user" message that points at `beekeeper user list` / `beekeeper user add`.
- Calls `createDevice(user.id, label || "Unnamed device")`.
- Prints `user.id`, `device._id`, `device.label`, `device.pairingCode`, and the 10-minute TTL hint.

`user` new shape:
- `beekeeper user add <id> <display>` → calls `addUser(id, display)`, prints `Added user: <id> (<display>)`. Errors bubble up from the registry (invalid id format, duplicate).
- `beekeeper user list` → prints tab-separated `id\tdisplay\t[active|inactive]`. Prints a helpful empty-state if the table is empty.
- `beekeeper user rm <id>` → calls `removeUser(id)`. On success, warns: "all of their devices' tokens are now invalid — they'll need to re-pair if reactivated." On miss, errors with non-zero exit.
- Opens the registry once via a small local helper that mirrors the existing `pair` open/close pattern. Always closes in a `finally`.

Both blocks must match the existing `pair` case's error handling shape: `pairExitCode`/`userExit` local, process.exit only after the `finally`, swallow close errors.

### Step 2: Verify manually

```
npm run build
mkdir -p /tmp/kpr21-smoke
cat > /tmp/kpr21-smoke/env <<EOF
BEEKEEPER_DATA_DIR=/tmp/kpr21-smoke/data
BEEKEEPER_JWT_SECRET=smoke-jwt-secret-0000000000000000
BEEKEEPER_ADMIN_SECRET=smoke-admin-secret
BEEKEEPER_PORT=8421
EOF
BEEKEEPER_ENV_FILE=/tmp/kpr21-smoke/env node dist/cli.js user list
BEEKEEPER_ENV_FILE=/tmp/kpr21-smoke/env node dist/cli.js user add mokie "Mokie Huang"
BEEKEEPER_ENV_FILE=/tmp/kpr21-smoke/env node dist/cli.js user list
BEEKEEPER_ENV_FILE=/tmp/kpr21-smoke/env node dist/cli.js pair mokie "Smoke iPad"
BEEKEEPER_ENV_FILE=/tmp/kpr21-smoke/env node dist/cli.js pair ghost
```

Expected:
- `user list` → `(no users — ...)` then `mokie\tMokie Huang\t[active]`.
- `pair mokie` → prints a 6-digit pair code.
- `pair ghost` → non-zero exit, prints `unknown user "ghost"` and points at `beekeeper user list`.

### Step 3: Commit

```
git add src/cli.ts
git commit -m "feat(cli): beekeeper user add|list|rm and user-validated pair (KPR-21)"
```

---

## Task 3: HTTP + WS wiring — surface `user` everywhere

**Files:**
- Modify: `src/index.ts`

### Step 1: `verifyDeviceToken` returns `{ device, user }`

Change the return type of `verifyDeviceToken` in `src/index.ts` to `{ device: BeekeeperDevice; user: string } | null` and return `deviceRegistry.verifyToken(token)` directly.

### Step 2: Update every `verifyDeviceToken` call site

Each of the `/capabilities`, `GET /me`, `PUT /me` handlers destructures the result:

```typescript
const auth = verifyDeviceToken(req);
if (!auth) { /* 401 */ return; }
const { device, user } = auth;
```

Replace `device.name` → `device.label` in the JSON responses. `GET /me` response becomes:

```typescript
res.end(JSON.stringify({ deviceId: device._id, label: device.label, user }));
```

`PUT /me` accepts `label` in the body (backcompat also reads `name`):

```typescript
const rawLabel = typeof parsed.label === "string"
  ? parsed.label
  : (typeof parsed.name === "string" ? parsed.name : "");
const label = rawLabel.trim();
if (!label) { /* 400: "Missing required field: label" */ return; }
const updated = deviceRegistry.updateDevice(device._id, { label });
res.end(JSON.stringify({ deviceId: device._id, label: updated?.label ?? label, user }));
```

Update the `parsed` type accordingly: `let parsed: { label?: string; name?: string };`.

### Step 3: `POST /pair` body — `label` field with backcompat `name`

In the `POST /pair` handler (around the current `name` parsing):

```typescript
let parsed: { code?: string; label?: string; name?: string };
// ...
const rawLabel = typeof parsed.label === "string"
  ? parsed.label
  : (typeof parsed.name === "string" ? parsed.name : undefined);
const label = typeof rawLabel === "string" ? rawLabel.trim() : undefined;
const result = deviceRegistry.verifyPairingCode(parsed.code, label || undefined);
```

Response:

```typescript
res.end(
  JSON.stringify({
    token: result.token,
    deviceId: result.device._id,
    label: result.device.label,
    user: result.device.userId,
    capabilities: capabilities.list(),
  }),
);
```

### Step 4: Admin API — `POST /devices` takes `userId` + `label`

Replace the `POST /devices` body-handling block:

```typescript
let parsed: { userId?: string; label?: string };
try { parsed = JSON.parse(body); } catch { /* 400 Invalid JSON */ return; }
if (!parsed.userId || typeof parsed.userId !== "string") {
  /* 400 "Missing required field: userId" */
  return;
}
const label = parsed.label || "Unnamed device";
let device;
try {
  device = deviceRegistry.createDevice(parsed.userId, label);
} catch (err) {
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  return;
}
res.writeHead(201, { "Content-Type": "application/json" });
res.end(
  JSON.stringify({
    deviceId: device._id,
    label: device.label,
    user: device.userId,
    pairingCode: device.pairingCode,
    expiresAt: device.pairingCodeExpiresAt,
  }),
);
```

`GET /devices` and `GET /devices/:id` emit `label` + `user` instead of `name`. `PUT /devices/:id` (admin) accepts `label` (backcompat `name`), calls `updateDevice(deviceId, { label })`, returns `{ deviceId, label, user: device.userId }`.

### Step 5: WS upgrade stamps `user` on the connection

Around the current `deviceRegistry.verifyToken(token)` call in the upgrade handler:

```typescript
const authResult = deviceRegistry.verifyToken(token);
if (!authResult) { /* 401 + destroy */ return; }
const { device, user } = authResult;
```

And pass `user` through `wss.handleUpgrade`:

```typescript
wss.handleUpgrade(req, socket, head, (ws) => {
  wss.emit("connection", ws, device, user, channel, origin);
});
```

Update the `wss.on("connection", ...)` signature:

```typescript
wss.on("connection", (
  ws: WebSocket,
  device: BeekeeperDevice,
  user: string,
  channel: "beekeeper" | "team" = "beekeeper",
  origin?: string,
) => {
  log.info("Client connected", { deviceId: device._id, label: device.label, user, channel });
```

### Step 6: Pass `user` to SessionManager and team-proxy

In the `channel === "team"` branch:

```typescript
const handle = proxyTeamConnection(ws, device, hiveEntry, { origin, user });
```

In the `channel === "beekeeper"` path:

```typescript
sessionManager.addClient(device._id, user, ws);
```

Inside the `ws.on("message", ...)` switch, update the three `sendMessage` call sites (`message`, `image`, `file`) to pass `user`:

```typescript
await sessionManager.sendMessage(msg.sessionId, msg.text, user);
// ...
await sessionManager.sendMessage(msg.sessionId, prompt, user);
```

### Step 7: Verify build + typecheck

Run: `npm run typecheck`
Expected: clean. Any leftover `device.name` references get flagged here — rename to `device.label`.

### Step 8: Commit

```
git add src/index.ts
git commit -m "feat(server): thread user identity through HTTP and WS upgrade (KPR-21)"
```

---

## Task 4: SessionManager surfaces `user` to the agent

**Files:**
- Modify: `src/session-manager.ts`
- Test: `src/session-manager.test.ts`

### Step 1: `addClient` accepts `user`

New signature:

```typescript
addClient(deviceId: string, user: string, ws: WebSocket): void {
```

Body unchanged, but add `user` to the info log:

```typescript
clientSet.add(ws);
log.info("Session client attached", { deviceId, user });
```

We do **not** store a per-ws `user` map. The identity is re-asserted on every `sendMessage` by the WS handler using the same token-verified value, so there is no drift and no new data structure.

### Step 2: `sendMessage(sessionId, text, user)` prepends identity header

Replace the body of `sendMessage`:

```typescript
async sendMessage(sessionId: string, text: string, user: string): Promise<void> {
  const slot = this.sessions.get(sessionId);
  if (!slot) {
    this.send({ type: "error", message: `Unknown session: ${sessionId}`, sessionId });
    return;
  }

  // Slash commands run locally and don't go to the SDK — no header.
  if (text.startsWith("/")) {
    const parts = text.trimEnd().split(/\s+/);
    const name = parts[0].slice(1).toLowerCase();
    const cmd = this.commands.get(name);
    if (cmd) {
      log.info("Running slash command", { sessionId, user, command: name });
      await cmd.handler(sessionId, parts.slice(1), slot);
      return;
    }
    // Unknown command — fall through to the SDK as normal text (with header).
  }

  if (slot.state === "busy") {
    this.send({ type: "status", state: "busy", sessionId });
    return;
  }

  // KPR-21: server-asserted identity header. This is the ONLY place the
  // agent learns who it's talking to; the client cannot influence `user`
  // because it's re-asserted from the WS auth context on every message.
  const prompt = `<from user="${user}">\n${text}`;
  const done = this.runQuery(slot, prompt);
  slot.queryDone = done;
  await done;
}
```

**Why a text-prepended header and not SDK metadata:**
- Zero protocol change in `@anthropic-ai/claude-agent-sdk` — survives SDK upgrades.
- The agent sees it inline, so any system prompt can reference it naturally.
- If we want to move this into a system prompt later, it's one localized change.

### Step 3: Update session-manager tests

In `src/session-manager.test.ts`:
- Every `sessionManager.addClient(deviceId, ws)` → `addClient(deviceId, "mokie", ws)`.
- Every `sendMessage(sessionId, text)` → `sendMessage(sessionId, text, "mokie")`.
- Add one test: since the SDK is mocked via `vi.mock("@anthropic-ai/claude-agent-sdk", ...)`, find the existing spy on `query()` (or the prompt it receives) and assert the prompt passed to the SDK equals `` `<from user="mokie">\nhello` `` after `sendMessage(sessionId, "hello", "mokie")`. Match the file's existing capture pattern rather than inventing a new one.

### Step 4: Verify

Run: `npm run test -- session-manager`
Expected: green.

### Step 5: Commit

```
git add src/session-manager.ts src/session-manager.test.ts
git commit -m "feat(sessions): prepend server-asserted user header to agent prompts (KPR-21)"
```

---

## Task 5: team-proxy passes `user` on the upstream URL

**Files:**
- Modify: `src/team-proxy.ts`
- Test: `src/team-proxy.test.ts`

### Step 1: Accept `user` in options

Add to `ProxyTeamConnectionOptions`:

```typescript
/** Server-asserted user id forwarded to hive via the upstream URL. */
user?: string;
```

### Step 2: Append `&user=` to upstream URL

In the URL builder:

```typescript
const base = hiveEntry.localWsUrl.replace(/\/+$/, "");
let upstreamUrl =
  base +
  "/?internal=1&deviceId=" +
  encodeURIComponent(deviceId) +
  "&label=" +
  encodeURIComponent(deviceLabel);
if (options.origin) {
  upstreamUrl += "&origin=" + encodeURIComponent(options.origin);
}
if (options.user) {
  upstreamUrl += "&user=" + encodeURIComponent(options.user);
}
```

**Hive-side wire contract change:** the URL param `name` becomes `label`, and a new `user` param is added. Hive currently reads `name` from this URL — we ship the beekeeper side first, coordinate the Hive consumer change in a follow-up PR against `bot-dodi/hive`. If the Hive-side change can't land in the same window, fall back temporarily to keeping the URL param name `name` (one-line revert here). Mark this explicitly in the PR description.

Rename `ProxyDevice.name` → `ProxyDevice.label`:

```typescript
export interface ProxyDevice {
  _id: string;
  label: string;
}
```

And:

```typescript
const deviceLabel = (device as BeekeeperDevice).label ?? (device as ProxyDevice).label;
```

### Step 3: Test

In `src/team-proxy.test.ts`, clone whichever existing test captures the upstream URL (look for assertions on `deviceId` in the URL). Add:

```typescript
it("forwards user on upstream URL when provided", async () => {
  // ...existing scaffolding for capturing upstream URL...
  proxyTeamConnection(clientWs, device, hiveEntry, { user: "mokie" });
  expect(capturedUrl).toContain("&user=mokie");
});
```

Also update any test that asserts `&name=` in the URL to assert `&label=` instead.

### Step 4: Document contract for Hive

Append to the JSDoc above `proxyTeamConnection`:

```
 * URL contract to hive (KPR-21):
 *   ?internal=1&deviceId=<uuid>&label=<cosmetic>&user=<server-asserted-id>[&origin=<slug>]
 * The `user` param is authoritative — hive MUST NOT trust any client-supplied
 * identity field inside forwarded frames and should attach this value to its
 * agent envelope as the sender.
```

### Step 5: Verify

Run: `npm run test -- team-proxy`
Expected: green.

### Step 6: Commit

```
git add src/team-proxy.ts src/team-proxy.test.ts
git commit -m "feat(team-proxy): assert user identity on upstream handshake (KPR-21)"
```

---

## Task 6: Full check + manual smoke + PR

### Step 1: `npm run check`

Run: `npm run check`
Expected: typecheck clean, all vitest green.

### Step 2: Local smoke against a built server

```
rm -rf /tmp/bee-kpr21 && mkdir -p /tmp/bee-kpr21/data
cat > /tmp/bee-kpr21/env <<EOF
BEEKEEPER_DATA_DIR=/tmp/bee-kpr21/data
BEEKEEPER_JWT_SECRET=smoke-jwt-secret-0000000000000000
BEEKEEPER_ADMIN_SECRET=smoke-admin-secret
BEEKEEPER_PORT=8421
EOF
npm run build
BEEKEEPER_ENV_FILE=/tmp/bee-kpr21/env node dist/cli.js user add mokie "Mokie Huang"
BEEKEEPER_ENV_FILE=/tmp/bee-kpr21/env node dist/cli.js pair mokie "Smoke iPad"
# in another shell:
BEEKEEPER_ENV_FILE=/tmp/bee-kpr21/env node dist/index.js
# then:
curl -sS -X POST http://localhost:8421/pair \
  -H 'content-type: application/json' \
  -d '{"code":"<paste-pair-code>","label":"Smoke iPad"}' | jq
```

Expected JSON body contains `"user":"mokie"`, `"label":"Smoke iPad"`, a `token`, and `capabilities`.

Kill the server (Ctrl-C) and clean up `/tmp/bee-kpr21`.

### Step 3: Deploy plan for the live mac mini

Run on the live beekeeper host, after merging:

```
cd /Users/mokie/services/beekeeper
bash scripts/update.sh   # picks up new version, rebuilds, kickstarts
beekeeper user add mokie "Mokie Huang"
beekeeper pair mokie "iPhone 17"     # enter the code on iOS
beekeeper pair mokie "dodi-shop sim"
```

Both existing devices re-pair — their old JWTs become invalid because the schema reset dropped them.

### Step 4: PR

Use `/commit-commands:commit-push-pr` (or manual flow). Title:

```
feat: bind beekeeper devices to server-asserted user identity (KPR-21)
```

Body should mention:
- new `users` table + `beekeeper user add|list|rm`
- JWT claim `user`, WS stamps it on every beekeeper-channel message
- `channel=team` forwards `user` to hive on the upstream handshake (hive follow-up required to consume it)
- migration: existing devices must re-pair
- coordinated hive change tracked separately

### Step 5: Mark KPR-21 done once merged and the live deploy is re-paired.

---

## Rollback

If the live deploy goes sideways:
1. `cd /Users/mokie/services/beekeeper && git checkout <previous-commit>` + `bash scripts/update.sh`.
2. `devices.db` will still have the KPR-21 schema — delete it (`rm ~/.beekeeper/data/devices.db`), restart, and re-pair with the pre-KPR-21 flow. Two devices.

The drop-and-recreate migration is one-way. That's fine — user is the sole operator and re-pair takes under a minute.
