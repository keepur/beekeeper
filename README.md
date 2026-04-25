# Beekeeper

Claude Code session gateway — real development from your phone (or any device).

**Beekeeper** is a WebSocket-based server that wraps the Claude Code Agent SDK, letting you run full-featured development sessions on remote devices. Write code, run commands, approve tool use — all from an iOS app, web client, or any WebSocket-capable device.

## Prerequisites

- **Node 22 or newer** — enforced by `engines.node` in `package.json`.
- **TLS termination in front of Beekeeper, if you plan to reach it from anywhere other than `localhost`.** Beekeeper serves plain `http` + `ws` by design — it assumes you already have a way to expose its port as an HTTPS/WSS endpoint. How you do that is up to you: Cloudflare Tunnel, Tailscale Funnel, Caddy, nginx, Traefik, stunnel, an ALB, whatever fits your setup. Remote clients including the Keepur iOS app will *not* connect over plain `ws://` — App Transport Security blocks it on iOS, and you don't want unencrypted device tokens on the open internet anyway. **Localhost-only** setups (e.g. testing on the same machine) need nothing extra.

## Quick Start

Beekeeper is distributed two ways, depending on whether you want auto-updates via `scripts/update.sh`:

- **npm** (simpler, good for casual use) — `npm install -g @keepur/beekeeper`. You get a `beekeeper` binary on your `$PATH`. Upgrades are `npm install -g @keepur/beekeeper@latest`.
- **From source** (recommended if you plan to run as a long-lived service) — `git clone && npm ci && npm run build`. This is what the `scripts/update.sh` auto-updater in the [Updating](#updating) section expects, since it runs `git pull` + rebuild in-place.

Both install paths require Node **22 or newer** (`engines.node` in `package.json`).

### 1a. Install via npm

```bash
npm install -g @keepur/beekeeper
```

This gives you a `beekeeper` command globally. All commands in the rest of this README (`beekeeper pair`, `beekeeper install`, etc.) work as shown.

### 1b. Install from source

```bash
git clone https://github.com/keepur/beekeeper.git
cd beekeeper
npm ci
npm run build
```

The build compiles TypeScript to `dist/` and produces the `dist/cli.js` entry point.

> When you see `beekeeper <subcommand>` in the docs after a source install, substitute `node dist/cli.js <subcommand>` — or `npm link` in the checkout to get a real `beekeeper` on your `$PATH`.

### 2. Create a config directory

If you plan to run beekeeper as a LaunchAgent (see [macOS LaunchAgent Setup](#macos-launchagent-setup)), `beekeeper install` will seed `~/.beekeeper/beekeeper.yaml` from the bundled example for you — you can skip this step and edit the file afterward.

Otherwise, create the config manually:

```bash
mkdir -p ~/.beekeeper
cp beekeeper.yaml.example ~/.beekeeper/beekeeper.yaml
# edit ~/.beekeeper/beekeeper.yaml as needed (port, model, workspaces)
```

> Installed via `npm install -g @keepur/beekeeper`? The example ships inside the package, so use `beekeeper install` to seed the config, or copy from `$(npm root -g)/@keepur/beekeeper/beekeeper.yaml.example`.

### 3. Set environment variables

Required:
```bash
export BEEKEEPER_JWT_SECRET="your-secret-key-min-32-chars"
export BEEKEEPER_ADMIN_SECRET="your-admin-secret-min-32-chars"
export ANTHROPIC_API_KEY="sk-ant-..."
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
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key used by the Claude Agent SDK |
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

## Optional: sibling-process federation

Beekeeper exposes an internal loopback API that lets a second process running on the same machine register itself as an additional capability served over the same public port. Clients then opt into that capability via a `?channel=` query param on the WebSocket URL. The mechanism is generic — any sibling process that can bind loopback and POST JSON can participate — but the concrete use case today is [Hive](https://github.com/keepur/hive), a team/Slack channel served as `channel=team`.

**Beekeeper-only deployments need no setup for this.** `GET /capabilities` will simply return `{ "capabilities": ["beekeeper"] }` and `channel=team` upgrades will return `503 no-such-channel`. You can ignore this entire section unless you're running a sibling.

**How it works (for sibling authors):**

1. Beekeeper listens on its public port (default `8420`). The sibling binds its own WebSocket adapter to a loopback-only port (Hive uses `127.0.0.1:3200`).
2. On boot — and every 30s thereafter, to survive Beekeeper restarts — the sibling calls `POST http://127.0.0.1:8420/internal/register-capability` with its `name`, `localWsUrl`, and `healthUrl`. Auth is enforced purely by the loopback check (`remoteAddress` must be `127.0.0.1` or `::1`); no bearer token is required.
3. Beekeeper records the registration in memory and health-checks `healthUrl` every 10s. Two consecutive failures drop the entry.
4. Clients connect to Beekeeper with `wss://<host>/?token=<jwt>&channel=<name>`. Beekeeper proxies the socket to the sibling's loopback WS. Omitting `channel` (or passing `channel=beekeeper`) routes to Beekeeper's own Claude Code session manager.
5. Start order is irrelevant: the sibling's re-registration loop makes the system self-heal across restarts of either process. Nothing in `beekeeper.yaml` needs to mention the sibling.

## macOS LaunchAgent Setup

To run Beekeeper as a background service on macOS:

```bash
beekeeper install ~/.beekeeper
```

This generates and installs a LaunchAgent plist at `~/Library/LaunchAgents/io.keepur.beekeeper.plist`. The service auto-starts on login (`RunAtLoad`+`KeepAlive`).

On a fresh machine, `beekeeper install` also seeds `<configDir>/beekeeper.yaml` from the bundled example if no config exists yet — so you don't have to find the example file inside the npm package. It never overwrites an existing config, so re-running install is still safe.

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

## Updating

### Manual update

From your source checkout:

```bash
git pull --ff-only
npm ci
npm run build
beekeeper install ~/.beekeeper        # regenerates wrapper + plist
launchctl kickstart -k gui/$(id -u)/io.keepur.beekeeper
```

`beekeeper install` is idempotent — it always regenerates `bin/start.sh` and the plist from scratch, so it's safe to re-run on every update. `launchctl kickstart -k` restarts the service in place without unloading the plist.

### Automated update

The repo ships a `scripts/update.sh` helper that wraps all of the above. It's **idempotent** — if there are no new commits upstream it exits `0` without rebuilding, so it's cheap to run on a schedule.

```bash
scripts/update.sh                    # defaults to ~/.beekeeper
scripts/update.sh /path/to/config    # or pass a config dir
```

Environment overrides:

| Variable | Default | Purpose |
|----------|---------|---------|
| `BEEKEEPER_LABEL` | `io.keepur.beekeeper` | LaunchAgent label to restart |
| `BEEKEEPER_UPDATE_BRANCH` | `main` | Required current branch (safety guard) |

By default the script refuses to run unless you're on `main`, so a local branch you forgot to switch off of won't get silently clobbered.

### Scheduling auto-updates

You can wire `scripts/update.sh` into any scheduler. The two obvious choices on macOS:

**Option 1 — cron** (simple, but cron runs outside the user's `launchd` session so `launchctl kickstart gui/$UID/...` may not have permission to touch a GUI-session LaunchAgent; prefer Option 2 on modern macOS):

```cron
# crontab -e  — check for updates every 15 minutes
*/15 * * * * /Users/you/beekeeper/scripts/update.sh >> /Users/you/.beekeeper/logs/update.log 2>&1
```

**Option 2 — a second LaunchAgent** (recommended on macOS — runs inside your user `gui/` session so `launchctl kickstart` works, and survives reboots):

Create `~/Library/LaunchAgents/io.keepur.beekeeper-updater.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.keepur.beekeeper-updater</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/beekeeper/scripts/update.sh</string>
  </array>
  <key>StartInterval</key>
  <integer>900</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/you/.beekeeper/logs/update.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/.beekeeper/logs/update.err</string>
</dict>
</plist>
```

Then load it:

```bash
launchctl load ~/Library/LaunchAgents/io.keepur.beekeeper-updater.plist
```

`StartInterval` is in seconds — `900` = 15 minutes. Use `StartCalendarInterval` instead if you want fixed-time updates (e.g. daily at 04:00) rather than a rolling interval.

**Tail the update log** to see what the scheduler is doing:

```bash
tail -f ~/.beekeeper/logs/update.log
```

On a no-op tick you'll see `[beekeeper-update] already up to date`. On an actual update you'll see the full pull → build → install → kickstart sequence.

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

## Contributing

Issues and pull requests welcome. CI (typecheck + full test suite) runs on a self-hosted macOS runner for every PR and every push to `main`, so please run `npm run check` locally before opening a PR — it runs the same steps the CI does.

`main` is a protected branch: all changes land via PR, no force-pushes, linear history only.

### Releasing a new version

Releases to [`@keepur/beekeeper` on npm](https://www.npmjs.com/package/@keepur/beekeeper) are automated via the `Publish to npm` GitHub Actions workflow, triggered by pushing a `v*.*.*` semver tag. The typical flow is:

```bash
# from a clean checkout on main
npm version patch       # or 'minor' / 'major'; edits package.json AND creates a git tag
git push origin main    # push the version-bump commit (via PR if branch protection blocks it)
git push origin --tags  # pushing the tag kicks off the publish workflow
```

The workflow verifies that `package.json`'s version matches the tag, runs the full typecheck + test + build pipeline, and only then publishes. A mistyped tag fails fast instead of publishing a wrong version. npm auth is picked up from the self-hosted runner's ambient `~/.npmrc`; if you ever move the runner to a different host or user, add an `NPM_TOKEN` repo secret and write it to a workspace `.npmrc` before the `Publish` step.

## License

Apache License 2.0 — See [LICENSE](LICENSE) for details.
