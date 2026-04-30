# Architecture

```
┌─────────────────┐
│  Client (iOS,   │
│   web, etc.)    │
└────────┬────────┘
         │ WebSocket + JWT
         │
    ┌────▼──────┐         ┌────────────────────┐
    │ beekeeperd│ ←──────→│  ?channel=<name>   │
    │  (gateway)│         │  routes to sibling │
    └────┬──────┘         │  (e.g. Hive)       │
         │                └────────────────────┘
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

## Components

- **WebSocket Server** — multiplexes device connections; JWT auth.
- **Session Manager** (`src/session-manager.ts`) — Claude Code session per workspace; persists slot metadata to `sessions.json`. Slash commands intercept BEFORE the SDK call. ToolGuardian + QuestionRelayer hook PreToolUse.
- **Device Registry** (`src/device-registry.ts`) — SQLite (better-sqlite3, WAL). Pairing codes, JWTs, devices.
- **Tool Guardian** (`src/tool-guardian.ts`) — intercepts dangerous commands listed in `confirm_operations`; relays approval prompts to the client.
- **Question Relayer** (`src/question-relayer.ts`) — handles interactive prompts the SDK emits; sends to the client, awaits the response, hands back to the SDK.
- **File Handler** (`src/file-handler.ts`) — uploaded images / PDFs / docs. Optional deps (`pdf-parse`, `mammoth`, `xlsx`) extract content; without them, returns minimal metadata.
- **Capability Manifest** (`src/capabilities.ts`) — registered siblings + 10s health loop. See [federation.md](federation.md).
- **Admin handler** (`src/admin-handler.ts`) — loopback-only `/admin/*` routes used by the operator CLI. Dual gate: loopback origin AND Bearer `BEEKEEPER_ADMIN_SECRET`.

## State

Sessions and the device registry persist under `BEEKEEPER_DATA_DIR` (default: `~/.beekeeper`):

- `devices.db` — better-sqlite3 file with WAL. Concurrent-safe between the daemon and the CLI (`beekeeper pair` opens the same DB).
- `sessions.json` — slot metadata; on restart, the manager restores slots (not in-flight queries).

Session history (for `list_workspace_sessions`) is scanned from Claude Code's on-disk project directory, not beekeeper state.

## Two channels, one port

The upgrade handler reads `?channel=` and routes:

- **`channel=beekeeper`** (default) → in-process Session Manager. Protocol: `new_session` → `message` → `clear_session` / `interrupt`. Streams SDK partial messages back.
- **`channel=team`** (or any registered sibling) → transparent pass-through to the sibling's loopback WS. Frames forwarded byte-for-byte; beekeeper does not parse or log their contents. `team-proxy.ts` owns this.

A single deployment can simultaneously host Claude Code sessions AND proxy team chat for the same devices.
