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
```

### 4. Start the server

```bash
beekeeper
# Or with options:
beekeeper --port 3099 --model claude-opus-4-6
```

The server listens on the configured port (default `3099`). Health check: `GET http://localhost:3099/health`

## Configuration Reference

### beekeeper.yaml

```yaml
# WebSocket server port (default: 3099)
port: 3099

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
curl -X POST http://localhost:3099/devices \
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
curl -X POST http://beekeeper-server:3099/pair \
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
ws://beekeeper-server:3099/?token=eyJhbGc...
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

## macOS LaunchAgent Setup

To run Beekeeper as a background service on macOS:

```bash
beekeeper install /path/to/config
```

This generates and installs a LaunchAgent plist at `~/Library/LaunchAgents/com.keepur.beekeeper.plist`. The service auto-starts on login.

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
curl http://localhost:3099/me \
  -H "Authorization: Bearer $DEVICE_TOKEN"
```

**PUT /me** — Update device name
```bash
curl -X PUT http://localhost:3099/me \
  -H "Authorization: Bearer $DEVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "New Name"}'
```

### Admin API (Bearer Token)

**POST /devices** — Create new device and pairing code
```bash
curl -X POST http://localhost:3099/devices \
  -H "Authorization: Bearer $BEEKEEPER_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"name": "Device Name"}'
```

**GET /devices** — List all devices with status
```bash
curl http://localhost:3099/devices \
  -H "Authorization: Bearer $BEEKEEPER_ADMIN_SECRET"
```

**GET /devices/:id** — Get device details
```bash
curl http://localhost:3099/devices/device-uuid \
  -H "Authorization: Bearer $BEEKEEPER_ADMIN_SECRET"
```

**PUT /devices/:id** — Update device name
```bash
curl -X PUT http://localhost:3099/devices/device-uuid \
  -H "Authorization: Bearer $BEEKEEPER_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"name": "New Name"}'
```

**DELETE /devices/:id** — Deactivate device
```bash
curl -X DELETE http://localhost:3099/devices/device-uuid \
  -H "Authorization: Bearer $BEEKEEPER_ADMIN_SECRET"
```

**POST /devices/:id/refresh-code** — Generate new pairing code
```bash
curl -X POST http://localhost:3099/devices/device-uuid/refresh-code \
  -H "Authorization: Bearer $BEEKEEPER_ADMIN_SECRET"
```

### Public

**GET /health** — Health check
```bash
curl http://localhost:3099/health
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
