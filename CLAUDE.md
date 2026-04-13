# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm ci                      # install (always prefer over `npm install` in this repo — lockfile-exact)
npm run build               # tsc → dist/
npm run dev                 # tsx src/index.ts — runs the server without a build
npm run typecheck           # tsc --noEmit
npm run test                # vitest run — full suite
npm run test -- <pattern>   # run tests whose file matches <pattern>, e.g. `npm run test -- session-manager`
npm run test:watch          # vitest in watch mode
npm run check               # typecheck + test — run this before opening a PR, CI runs the same steps
```

Tests live beside the source they cover (`src/foo.ts` ↔ `src/foo.test.ts`). Node 22+ required (`engines.node` in `package.json`). There is no lint or format step — don't add one without discussion.

## Architecture

Beekeeper is a WebSocket gateway fronting two protocols over a single public port (default 8420). Entry point `src/index.ts` owns the HTTP server (REST API for pairing / device admin / capability registration) and the `WebSocketServer` that handles upgrades.

### Two channels, one port

The upgrade handler at `src/index.ts` reads `?channel=` from the WebSocket URL and routes accordingly:

- **`channel=beekeeper`** (default, for backwards compat when clients omit the param) → in-process `SessionManager` that wraps `@anthropic-ai/claude-agent-sdk`'s `query()`. Protocol uses explicit `sessionId`s (`new_session` → `message` → `clear_session` / `interrupt`) and streams SDK partial messages back.
- **`channel=team`** → transparent pass-through proxy to a sibling process (today: Hive) that has registered itself via `POST /internal/register-capability`. The client's frames are forwarded byte-for-byte to the sibling's loopback WS and vice versa; beekeeper does **not** parse or log their contents. `team-proxy.ts` owns this.

A single deployment can simultaneously host Claude Code sessions AND proxy team chat for the same devices. When `channel=team` is requested but no sibling has registered, the upgrade handler responds `503 hive-unavailable`. `CapabilityManifest` (`src/capabilities.ts`) polls each registered sibling's `healthUrl` every 10s and drops it after two consecutive failures; siblings re-register on a 30s loop.

### Session manager (`src/session-manager.ts`)

Wraps the Agent SDK. A session is a `SessionSlot` keyed by SDK-assigned `sessionId` with a `pending-<uuid>` interim ID while the SDK is still initializing. Sessions persist to `sessions.json` in `config.dataDir`; on restart, the manager restores slot metadata (not in-flight queries). Slash commands intercept BEFORE the SDK call. `ToolGuardian` and `QuestionRelayer` hook `PreToolUse` to intercept dangerous commands and route approval prompts back to the client. Session history (for `list_workspace_sessions`) is scanned from Claude Code's on-disk project directory, not beekeeper state.

### Device registry (`src/device-registry.ts`)

SQLite via `better-sqlite3` (WAL mode, synchronous). Schema lives in `open()`. JWT-based auth: devices pair via a short-lived code, the `/pair` endpoint mints a JWT signed with `config.jwtSecret`. The `beekeeper pair <name>` CLI subcommand (`src/cli.ts`) opens the same DB file with WAL, so it's safe to run concurrently with the server. Admin-API routes under `/devices/*` require `Authorization: Bearer <config.adminSecret>`.

### Config loading (`src/config.ts`)

`loadConfig()` auto-sources `$BEEKEEPER_ENV_FILE` (default `~/.beekeeper/env`) before reading required env vars — existing shell env wins over the file, so per-invocation overrides still work. Blank lines, `#` comments, and `KEY="quoted"` / `KEY='single'` values are all handled. Both the long-lived server and one-shot CLI commands like `beekeeper pair` share this path, so neither needs a manual `source ~/.beekeeper/env` gymnastic.

### LaunchAgent install (`src/service/generate-plist.ts`)

`beekeeper install <configDir>` generates a macOS LaunchAgent plist at `~/Library/LaunchAgents/io.keepur.beekeeper.plist`. If `<configDir>/env` exists at install time, install operates in **wrapper mode**: writes a shell wrapper to `<repoRoot>/bin/start.sh` that sources the env file and execs node, and points `ProgramArguments` at the wrapper. Otherwise, **direct mode**: the plist runs node directly with just `BEEKEEPER_CONFIG` in `EnvironmentVariables`. Wrapper mode is strongly preferred because it keeps secrets out of the plist and is safely idempotent. Install is always safe to re-run — both the wrapper and the plist are regenerated from scratch.

## Gotchas / traps (write these down, don't re-learn them)

- **Claude Agent SDK's `exports` regression.** `@anthropic-ai/claude-agent-sdk` (observed on ≥0.2.101) bundles its Claude Code binary at `./cli.js` but doesn't list that subpath in its `package.json` `exports`. Its own internal `require.resolve("./cli.js")` then throws `ERR_PACKAGE_PATH_NOT_EXPORTED`, which surfaces as `"Claude Code executable not found at .../cli.js. Is options.pathToClaudeCodeExecutable set?"`. `session-manager.ts` computes the path manually (`require.resolve` of the package main, then `join(dirname, "cli.js")`) and passes it explicitly. **Do not remove this workaround** until either the SDK fixes its `exports` field or it switches its internal resolver to an `import.meta.url`-relative URL.

- **launchd's minimal `gui/` PATH.** When the LaunchAgent starts the wrapper, the inherited PATH is `/usr/bin:/bin:/usr/sbin:/sbin` — no `/opt/homebrew/bin`. Any `spawn("node", ...)` / `spawn("git", ...)` call fails with `ENOENT`. `writeWrapperScript` in `generate-plist.ts` exports a sane PATH BEFORE sourcing the env file so this never bites. The export order matters: default PATH first, then env-file source, so a user-provided `PATH=...` line still overrides.

- **`vi.mock("@anthropic-ai/claude-agent-sdk", ...)`** in `session-manager.test.ts` stubs out the SDK at module level, so the real SDK's spawn / resolve path is NOT exercised by the unit tests. If you change how beekeeper calls the SDK, smoke-test it against the live service — unit tests will not catch a broken SDK configuration.

- **Team-proxy is opaque on purpose.** `team-proxy.ts` forwards raw frames. Don't add logging that assumes frame contents (it'd require JSON-parsing arbitrary third-party payloads), and don't reach into the team channel from `SessionManager` or vice versa — they share nothing but the device identity and the port.

## Workflow

- `main` is a **protected branch**. All changes land via PR; no force-pushes, no deletions, linear history only. PRs must pass the `Typecheck + Test + Build` check before merging. `enforce_admins: false`, so emergency direct-push is still possible if something's on fire.
- **CI runs on a self-hosted macOS ARM64 runner** (`.github/workflows/ci.yml`, `runs-on: [self-hosted, macOS, ARM64]`). Don't switch to `ubuntu-latest` or a GitHub-hosted runner without discussion — the runner hosts the same stack the production deploy uses.
- **Releases are tag-triggered** (`.github/workflows/publish.yml`). Push a `v*.*.*` tag and the workflow verifies `package.json` version matches the tag, runs the full CI pipeline, then publishes `@keepur/beekeeper` to npm. Auth is picked up from the self-hosted runner's ambient `~/.npmrc` (no secret). Flow: `npm version <patch|minor|major>` → PR the version bump → merge → `git push origin --tags`.
- **`scripts/update.sh`** is the idempotent auto-update helper for source deployments (clone → build → install → kickstart). It's what the updater LaunchAgent runs on an interval, but you can call it manually. It exits 0 cleanly when already at HEAD, so it's cheap to run unconditionally.

## Before shipping changes

- Run `npm run check` locally. It runs exactly what CI runs.
- For changes that touch `src/service/generate-plist.ts`, `src/session-manager.ts`, or anything related to spawning subprocesses, **test against a live deploy** — the unit tests' SDK mocks hide real integration problems (see Gotchas above).
- For protocol changes in the `channel=beekeeper` path, remember there are two official clients (`keepur-ios`, `dodi-shop-ios`) and the latter speaks the legacy Hive agent protocol over `channel=team`. Don't conflate the two protocols in the same PR.
