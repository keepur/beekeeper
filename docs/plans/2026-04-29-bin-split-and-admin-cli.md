# KPR-132 — Split beekeeper bin: beekeeperd daemon + beekeeper operator CLI

## Goal

`beekeeper` is the operator CLI. `beekeeperd` is the daemon launchd runs.
The CLI never starts the daemon; it can introspect the running daemon over
loopback HTTP. No more accidental EADDRINUSE on `beekeeper`-no-args.

## Phase 1 — Bin split + CLI hygiene

### Files

- `package.json`
  - `bin.beekeeperd: dist/index.js` (new)
  - `bin.beekeeper: dist/cli.js` (unchanged)
  - `scripts.start` keeps `node dist/index.js` (redundant with `beekeeperd` after build, but harmless)

- `src/cli.ts`
  - Drop the `default:` that imports `./index.js`. Replace with help.
  - Add `help` and `--help`/`-h` aliases → print help.
  - Add `version` and `--version`/`-v` → read `package.json` version, print.
  - Add `serve` → spawn the daemon in foreground (`await import("./index.js")`). For dev convenience.
  - Unknown commands → `Unknown command: <x>` to stderr, print help, exit 1.

- `src/service/generate-plist.ts`
  - Rename `LABEL` constant to `io.keepur.beekeeperd`. Keep old label as `LEGACY_LABEL = "io.keepur.beekeeper"`.
  - `install()`: before writing the new plist, unload + remove the legacy `io.keepur.beekeeper.plist` if it exists (so we don't leave an orphan or get a double-bind).
  - `uninstall()`: remove both new and legacy plists.
  - `generatePlist`/`writeWrapperScript` keep working — both still resolve `dist/index.js` directly (the daemon entry). We don't switch to invoking `beekeeperd` via PATH because the wrapper already has the resolved node + index path; no benefit, more failure modes.

- `README.md` + `CLAUDE.md`
  - Document `beekeeperd` as the daemon binary, `beekeeper` as the operator CLI.
  - Update LaunchAgent label references.
  - Add the `serve`/`help`/`version` commands.

### Acceptance (Phase 1)

- `beekeeper` (no args) prints help, exits 0. No EADDRINUSE.
- `beekeeper serve` runs the daemon in foreground (manual smoke test).
- `beekeeper install` produces `~/Library/LaunchAgents/io.keepur.beekeeperd.plist` and removes any existing `io.keepur.beekeeper.plist`.
- `npm run typecheck && npm run test` pass.

## Phase 2 — Admin HTTP + CLI commands

### New daemon endpoints (admin Bearer + loopback)

- `GET /admin/sessions` — `[{ sessionId, path, state, lastActivityAt, queryStartedAt }]` from `SessionManager.getActiveSessions()` extended.
- `GET /admin/capabilities` — `[{ name, healthUrl, lastHealthyAt, healthy }]` from `CapabilityManifest.list()` (extend if necessary).
- `POST /admin/reload` — re-source `~/.beekeeper/env` and reload config-driven things that can be reloaded safely. For now: re-read pipeline config, rebuild capabilities health loop. Returns `{ ok: true, reloaded: [...] }`.

Existing admin endpoints stay where they are (`GET /devices`, etc.); CLI uses them directly.

All new endpoints:
- Require `verifyAdmin(req)` → 401 if missing/wrong.
- Require `req.socket.remoteAddress` is loopback (127.0.0.1 / ::1 / ::ffff:127.0.0.1) → 403 if not.

### CLI subcommands

CLI shares an `adminClient.ts` helper:
```
loadAdminConfig() → { url: "http://localhost:<port>", adminSecret: string }
```
Reads from `loadConfig()`. If `adminSecret` is missing or daemon unreachable, prints actionable error.

Subcommands:
- `beekeeper status` → `GET /health` (no admin secret needed). Pretty: `gateway: ok | sessions: 2 | devices: 1`.
- `beekeeper sessions list` → `GET /admin/sessions`. Pretty table.
- `beekeeper devices list` → `GET /devices`. Pretty table.
- `beekeeper capabilities` → `GET /admin/capabilities`. Pretty table.
- `beekeeper reload` → `POST /admin/reload`. Print summary.

All subcommands accept `--json` to emit raw response.

### Acceptance (Phase 2)

- All four new/existing admin endpoints respond correctly with valid auth.
- All admin endpoints return 401/403 with bad auth or non-loopback origin.
- CLI subcommands reach the daemon and print pretty + `--json` output.
- CLI prints actionable error when daemon unreachable.
- Unit tests for endpoint authn + loopback gating + happy-path response shape.
- `npm run check` passes.

## Migration (the one existing user, mokie@mokiemon)

```
npm i -g @keepur/beekeeper@<new>     # installs both bins
beekeeper install                     # generates new plist, removes legacy
launchctl kickstart -k gui/$(id -u)/io.keepur.beekeeperd
beekeeper status                      # smoke test
```

## Out of scope

- `beekeeper sessions kill` / `interrupt` / `tail` — needs design discussion on session manipulation IPC. Punt to follow-up.
- Replacing WebSocket protocol with HTTP for any client-facing path.
- Migrating client SDK consumers off the existing protocol.
