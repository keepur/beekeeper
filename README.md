# Beekeeper

Claude Code session gateway — real development from your phone (or any device).

**Beekeeper** is a WebSocket-based server that wraps the Claude Code Agent SDK, letting you run full-featured development sessions on remote devices. Write code, run commands, approve tool use — all from an iOS app, web client, or any WebSocket-capable device.

## Quick Start

### 1. Install globally

```bash
npm install -g @keepur/beekeeper
```

### 2. Create a config file

Copy `beekeeper.yaml.example` to `beekeeper.yaml` in your project directory:

```bash
beekeeper  # Starts the server (reads beekeeper.yaml from current directory or BEEKEEPER_CONFIG env var)
```

Or explicitly pass a config directory:

```bash
beekeeper install ~/my-beekeeper-config
```

### 3. Set environment variables

Required:
```bash
export BEEKEEPER_JWT_SECRET="your-secret-key-min-32-chars"
export BEEKEEPER_ADMIN_SECRET="your-admin-secret-min-32-chars"
```

Optional:
```bash
export BEEKEEPER_CONFIG="/path/to/beekeeper.yaml"  # Default: ./beekeeper.yaml
export BEEKEEPER_DATA_DIR="/path/to/data"          # Default: ~/.beekeeper
export BEEKEEPER_ENV_FILE="/path/to/env"           # Default: ~/.beekeeper/env
```

**Or, instead of exporting them in every shell,** drop the secrets into `~/.beekeeper/env` (or whichever `BEEKEEPER_ENV_FILE` you prefer) as `KEY=VALUE` lines:

```bash
install -m 600 /dev/null ~/.beekeeper/env
cat > ~/.beekeeper/env <<'EOF'
BEEKEEPER_JWT_SECRET=your-secret-key-min-32-chars
BEEKEEPER_ADMIN_SECRET=your-admin-secret-min-32-chars
BEEKEEPER_CONFIG=/Users/you/.beekeeper/beekeeper.yaml
BEEKEEPER_DATA_DIR=/Users/you/.beekeeper/data
EOF
```

`loadConfig()` auto-sources this file on startup (both server and CLI), so `beekeeper pair "Alice's iPhone"` works from any shell without manually `source`-ing first. Existing shell env vars always win over the file, so you can override per-run. Blank lines, `#` comments, and `KEY="quoted"` / `KEY='quoted'` values are all supported.

### 4. Start the server

```bash
beekeeper
# Or with options:
beekeeper --port 8420 --model claude-opus-4-6
```

The server listens on the configured port (default `8420`). Health check: `GET http://localhost:8420/health`

**Why 8420?** 8420 is the shared public-facing port that fronts both Beekeeper and (optionally) Hive. Clients open one socket to Beekeeper and pick a channel via the `?channel=` query param (`beekeeper` is the default; `team` proxies to a registered Hive). Hive's own loopback binding stays on `127.0.0.1:3200` forever, so a box running both has no port collision. Cloudflared tunnels should point at `localhost:8420`.

## Configuration Reference

### beekeeper.yaml

```yaml
# WebSocket server port (default: 8420)
port: 8420

# Claude model to use for sessions (default: claude-opus-4-6)
model: claude-opus-4-6

# Default workspace path (optional)
default_workspace: ~/code/my-project

# Named workspaces
workspaces:
  my-project: ~/code/my-project
  docs: ~/code/docs

# Dangerous operations that require explicit approval from client
# Before running any of these, the server asks the device for confirmation
confirm_operations:
  - "git push --force"
  - "git branch -D"
  - "git reset --hard"
  - "rm -rf"
  - "rm -r"
  - "git checkout -- ."
  - "git clean -f"
```

### Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `BEEKEEPER_JWT_SECRET` | Yes | Secret key for signing device JWTs (min 32 chars) |
| `BEEKEEPER_ADMIN_SECRET` | Yes | Bearer token for admin API access (min 32 chars) |
| `BEEKEEPER_CONFIG` | No | Path to `beekeeper.yaml` (default: `./beekeeper.yaml`) |
| `BEEKEEPER_DATA_DIR` | No | SQLite database & session storage (default: `~/.beekeeper`) |

## Device Pairing Flow

Devices authenticate with JWT tokens. The pairing process is two-step:

### Step 1: Admin creates a pairing code

```bash
curl -X POST http://localhost:8420/devices \
  -H "Authorization: Bearer $BEEKEEPER_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"name": "iPhone"}'
```

Response:
```json
{
  "deviceId": "device-uuid",
  "name": "iPhone",
  "pairingCode": "ABCD1234",
  "expiresAt": "2026-04-11T18:00:00Z"
}
```

### Step 2: Device exchanges pairing code for JWT

From the device client:
```bash
curl -X POST http://beekeeper-server:8420/pair \
  -H "Content-Type: application/json" \
  -d '{"code": "ABCD1234", "name": "My iPhone"}'
```

Response:
```json
{
  "token": "eyJhbGc...",
  "deviceId": "device-uuid",
  "deviceName": "My iPhone"
}
```

The device stores the token and passes it on every WebSocket connection:
```
ws://beekeeper-server:8420/?token=eyJhbGc...
```

Or via the `Authorization` header:
```
Authorization: Bearer eyJhbGc...
```

## Plugin Loading

Beekeeper automatically discovers plugins from two sources:

1. **Installed plugins** — read from `~/.claude/plugins/installed_plugins.json`
   ```json
   {
     "plugins": [
       { "path": "~/.claude/plugins/my-plugin" }
     ]
   }
   ```

2. **Config-specified plugins** — in `beekeeper.yaml`
   ```yaml
   plugins:
     - ~/custom-plugins/my-plugin
     - ~/custom-plugins/another
   ```

Plugins are loaded into each session, extending available tools and commands. See the Claude Code SDK docs for plugin development.

## Running alongside Hive

Beekeeper is the single public-facing gateway on a box that may also run [Hive](https://github.com/keepur/hive). There is **no manual wiring** between the two processes — Hive registers itself with Beekeeper on startup.

**How it works:**

1. Beekeeper listens on its public port (default `8420`). Hive binds its WebSocket adapter to `127.0.0.1:3200` — loopback only.
2. On boot (and every 30s thereafter), Hive calls `POST http://127.0.0.1:8420/internal/register-capability` with its `localWsUrl` and `healthUrl`. The loopback check is the auth.
3. Beekeeper stores the registration in memory and health-checks it every 10s. Two consecutive failures drop the entry.
4. Clients connect to Beekeeper with `wss://<host>/?token=<jwt>&channel=team`. Beekeeper proxies the socket to Hive's loopback WS. Omitting `channel` (or passing `channel=beekeeper`) routes to Beekeeper's own Claude Code session manager.
5. If Hive is not currently registered, `channel=team` upgrades are rejected with `503 hive-unavailable` and Hive does not appear in `GET /capabilities`.

**Start order is irrelevant.** Beekeeper can start before or after Hive; the 30s re-registration loop on Hive's side makes the system self-heal across restarts of either process. Nothing in `beekeeper.yaml` needs to mention Hive.

**Beekeeper-only boxes** (e.g. a dev laptop with Claude Code sessions but no Hive) just see `{ "capabilities": ["beekeeper"] }` forever. No extra configuration required.

## macOS LaunchAgent Setup

To run Beekeeper as a background service on macOS:

```bash
beekeeper install ~/.beekeeper
```

This generates and installs a LaunchAgent plist at `~/Library/LaunchAgents/com.keepur.beekeeper.plist`. The service auto-starts on login (`RunAtLoad`+`KeepAlive`).

**Two install modes, auto-selected:**

- **Wrapper mode** (preferred): if `<configDir>/env` exists at install time, `beekeeper install` generates a wrapper shell script at `<repoRoot>/bin/start.sh` that sources the env file and execs node. The plist runs the wrapper. This keeps secrets out of the plist and out of `launchctl` state, and lets you rotate secrets by editing the env file + restarting the service. This is the recommended mode.
- **Direct mode** (fallback): if no env file exists, the plist runs node directly with `BEEKEEPER_CONFIG=beekeeper.yaml` as its only env var. You'd need to add `BEEKEEPER_JWT_SECRET` and `BEEKEEPER_ADMIN_SECRET` to the plist's `EnvironmentVariables` dict manually, which is why wrapper mode is the default recommendation.

Re-running `beekeeper install` is idempotent and will regenerate both the wrapper script and the plist from scratch — any manual plist edits you made will be clobbered, so keep your source of truth in the env file and/or re-run install after changes.

To uninstall:
```bash
beekeeper uninstall
```

View logs:
```bash
log stream --predicate 'process == "beekeeper"' --level debug
```

## Pairing a Device

To create a new device and generate a one-time pairing code from the command line:

```bash
beekeeper pair "My iPhone"
```

Output:

```
Created device: My iPhone
Device ID:  <uuid>
Pair code:  123456
Expires in: 10 minutes
```

The pair code is valid for 10 minutes. Enter it in the Keepur client to complete pairing. This command opens the device registry directly (SQLite WAL mode) and is safe to run while the Beekeeper server is running.

## Optional File Processing Dependencies

For rich file content extraction (PDF, Word, Excel, images), install optional dependencies:

```bash
npm install pdf-parse mammoth xlsx
```

- **pdf-parse** — extract text and metadata from PDFs
- **mammoth** — convert DOCX to clean HTML
- **xlsx** — parse Excel workbooks

Without these, Beekeeper accepts file uploads but returns minimal metadata. With them, full content is extracted and inlined in the session.

## API Reference

### Device Self-Service (JWT Auth)

**GET /me** — Get current device info
```bash
curl http://localhost:8420/me \
  -H "Authorization: Bearer $DEVICE_TOKEN"
```

**PUT /me** — Update device name
```bash
curl -X PUT http://localhost:8420/me \
  -H "Authorization: Bearer $DEVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "New Name"}'
```

**GET /capabilities** — List runtime capabilities available on this server
```bash
curl http://localhost:8420/capabilities \
  -H "Authorization: Bearer $DEVICE_TOKEN"
```

Response:
```json
{ "capabilities": ["beekeeper", "hive"] }
```

`beekeeper` is always first and always present. Additional names (e.g. `hive`) appear when a sibling process has registered itself via `/internal/register-capability` and is passing health checks. Clients should call this on app foreground and on WebSocket reconnect so the UI tracks Hive availability without re-pairing. The same list is also returned in the `POST /pair` response body as `capabilities`, so first-run clients have it immediately.

### Internal API (Loopback Only)

**POST /internal/register-capability** — Register a sibling capability (e.g. Hive)
```bash
curl -X POST http://127.0.0.1:8420/internal/register-capability \
  -H "Content-Type: application/json" \
  -d '{
    "name": "hive",
    "localWsUrl": "ws://127.0.0.1:3200",
    "healthUrl": "http://127.0.0.1:3200/health"
  }'
```

Auth is enforced by loopback only: the endpoint returns `403` unless `remoteAddress` is `127.0.0.1` or `::1`. No bearer token is required. The call is idempotent — re-registering overwrites the existing entry and resets the failure counter. Beekeeper polls `healthUrl` every 10s and drops the entry after two consecutive failures, so siblings should re-register on a short interval (Hive uses 30s) to survive Beekeeper restarts.

### Admin API (Bearer Token)

**POST /devices** — Create new device and pairing code
```bash
curl -X POST http://localhost:8420/devices \
  -H "Authorization: Bearer $BEEKEEPER_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"name": "Device Name"}'
```

**GET /devices** — List all devices with status
```bash
curl http://localhost:8420/devices \
  -H "Authorization: Bearer $BEEKEEPER_ADMIN_SECRET"
```

**GET /devices/:id** — Get device details
```bash
curl http://localhost:8420/devices/device-uuid \
  -H "Authorization: Bearer $BEEKEEPER_ADMIN_SECRET"
```

**PUT /devices/:id** — Update device name
```bash
curl -X PUT http://localhost:8420/devices/device-uuid \
  -H "Authorization: Bearer $BEEKEEPER_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"name": "New Name"}'
```

**DELETE /devices/:id** — Deactivate device
```bash
curl -X DELETE http://localhost:8420/devices/device-uuid \
  -H "Authorization: Bearer $BEEKEEPER_ADMIN_SECRET"
```

**POST /devices/:id/refresh-code** — Generate new pairing code
```bash
curl -X POST http://localhost:8420/devices/device-uuid/refresh-code \
  -H "Authorization: Bearer $BEEKEEPER_ADMIN_SECRET"
```

### Public

**GET /health** — Health check
```bash
curl http://localhost:8420/health
```

## Architecture

```
┌─────────────────┐
│  Client (iOS/  │
│   Web Browser)  │
└────────┬────────┘
         │ WebSocket + JWT
         │
    ┌────▼──────┐
    │ Beekeeper │
    │  (Gateway)│
    └────┬──────┘
         │
    ┌────▼─────────────────────────┐
    │  Claude Code Agent SDK       │
    │  • Session Manager           │
    │  • Tool Guardian             │
    │  • Question Relayer          │
    │  • File Handler              │
    └────┬──────────────────────────┘
         │
    ┌────▼──────────┐
    │  Claude API   │
    └───────────────┘
```

### Key Components

- **WebSocket Server** — Multiplexes multiple device connections; authenticates with JWT
- **Session Manager** — Maintains Claude Code sessions per workspace; persists history to SQLite
- **Device Registry** — SQLite-backed device store with pairing codes and JWT tokens
- **Tool Guardian** — Intercepts dangerous commands (force-push, rm -rf, etc.); relays approval requests to client
- **Question Relayer** — Handles interactive prompts from Claude; sends to client, receives response
- **File Handler** — Processes uploaded images, PDFs, and documents; extracts content if optional deps installed

### Session Persistence

Sessions are stored in SQLite under `BEEKEEPER_DATA_DIR`:
- `devices.db` — Device registry, pairing codes, tokens
- `sessions/` — Per-workspace session history (searchable by date/path)

Sessions survive server restarts and device disconnects. Multiple clients can attach to the same session.

## Database Migration (MongoDB → SQLite)

If upgrading from an older version backed by MongoDB:

```bash
MONGO_URI="mongodb://..." beekeeper migrate --from-mongo
```

This exports all devices from the `hive.beekeeper_devices` collection to SQLite. Pairing codes are ephemeral and not migrated; re-pair devices after migration.

## License

Apache License 2.0 — See [LICENSE](LICENSE) for details.
