# KPR-134 — Beekeeper as the hive operator's control plane

## Why now

Prospective customers are waiting on the beta. Today's install path is two
npm packages (`@keepur/beekeeper` + `@keepur/hive`), then `hive init`, then a
Slack workspace dance — a real "first 30 minutes" experience that the
operator has to navigate alone with a README. The original install-bee idea
(KPR-130) was to put a Claude Code session in front of that — a guided
installer that knows hive — but framed only the install moment.

The actual product shape is **beekeeper as the operator's lifecycle control
plane for hive**: setup, list, update, ops-time Claude Code, status. Setup
is the urgent piece (gates the invite email); the rest matters for
ongoing trust.

## Phase A scope (this sprint)

Two commands. Everything else punts to Phase B.

### `beekeeper hive setup`

The guided installer. Flow:

1. Resolve latest `@keepur/hive` version via `npm view @keepur/hive version`.
2. Skip if already installed: read `~/services/hive/*/` — if any directory
   contains a populated `.hive/` engine, print a pointer to
   `beekeeper hive list` / `claude <id>` / `update` and exit. `--force`
   bypasses.
3. Fetch `npm view @keepur/hive dist.tarball` URL.
4. Download tarball to `~/.beekeeper/hive-cache/<version>/.tarball.tgz`.
5. Extract to `~/.beekeeper/hive-cache/<version>/package/` (npm tarballs
   always extract to a `package/` subdir — that's the convention).
6. Write the install-bee overlay `CLAUDE.md` at
   `~/.beekeeper/hive-cache/<version>/CLAUDE.md`. Static content for now,
   templated with the version string.
7. Evict cached versions other than the new one and the operator's
   currently-installed version (if any).
8. Spawn `claude` (Claude Code CLI) with `cwd =
   ~/.beekeeper/hive-cache/<version>/`. Inherit stdio so the operator
   takes over the terminal. Don't wait — exec-style.

Failure modes:
- No internet → "Failed to reach npm registry. Check your connection and
  re-run."
- `claude` not on PATH → "Claude Code CLI not found. Install it from
  https://docs.claude.com/en/docs/agents-and-tools/claude-code/quickstart
  and re-run."
- Tarball checksum mismatch (npm gives us the integrity hash) →
  "Tarball verification failed. Did the download get truncated?"

### `beekeeper hive list`

Enumerate `~/services/hive/*/` and report:

```
INSTANCE  VERSION  RUNNING  PORT  PATH
dodi      0.3.0    yes      3200  /Users/mokie/services/hive/dodi
keepur    0.3.0    yes      —     /Users/mokie/services/hive/keepur
```

- **VERSION**: read from `<instance>/.hive/package.json#version`. If
  `.hive/` is missing, report `incomplete`.
- **RUNNING**: query launchd via `launchctl print
  gui/<uid>/com.hive.<id>.agent`; non-zero exit → `no`.
- **PORT**: read from `<instance>/.env` (`WS_PORT=<n>`, the dodi pattern)
  with fallback to `<instance>/hive.yaml` (`ws.port`); `—` if neither is
  set. We deliberately do not compute from `portBase` — the operator's
  mental model is "what's actually configured," not "what would the
  default be if I started fresh."

`--json` flag dumps a structured array. No filter flags in v1.

## Cache layout

```
~/.beekeeper/hive-cache/
└── 0.3.2/
    ├── CLAUDE.md          # beekeeper-supplied install-bee overlay
    ├── .tarball.tgz       # the downloaded tarball (kept for retry/audit)
    └── package/           # extracted tarball contents
        ├── CLAUDE.md       # hive's own engine-side docs
        ├── README.md
        ├── pkg/server.min.js
        ├── plugins/
        ├── seeds/
        └── ...
```

`~/.beekeeper/hive-cache/` is created on first `setup` and is fully
disposable — `rm -rf` is the supported nuclear button.

Eviction: `setup` keeps the new version + the version of any currently
running engine (queried via `beekeeper hive list`). Older directories are
removed. Worst case, an operator can always re-fetch.

## Install-bee overlay CLAUDE.md

The overlay tells Claude Code its job is the install. Static template,
substituted with `<version>` at write time.

```markdown
# Install-bee — guide the operator through a fresh hive install

You are running inside `~/.beekeeper/hive-cache/<version>/`. The hive engine
source for `@keepur/hive@<version>` is extracted at `./package/` — read
`./package/CLAUDE.md` and `./package/README.md` for everything you need to
know about the engine. The skills under `./package/plugins/*/skills/` and
`./package/seeds/` are the agent definitions and operator skills the
operator will use after install.

## Your job

Walk the operator through getting hive running on this Mac:

1. **Verify dependencies.** Node 24 LTS, MongoDB, Ollama, Qdrant. Ask
   before you install anything; never sudo without permission.
2. **Install the hive CLI.** `npm i -g @keepur/hive@<version>`.
3. **Run `hive init`.** It's an interactive wizard — let it run, answer
   questions alongside the operator, explain what each prompt means.
4. **Pair Slack.** The init wizard generates a manifest the operator
   pastes into Slack's app config. Walk them through that.
5. **First conversation.** Once agents are seeded, suggest sending a
   first message to their CoS to confirm the loop.
6. **Hand off.** Tell them where logs live, how to message agents, and
   that `beekeeper hive claude <instance>` will reopen a Claude Code
   session against the running instance for ongoing tuning.

## Posture

- This is the operator's first-ever hive. Be patient. Explain what each
  component does before installing it.
- Verify before claiming. Read `./package/` for ground truth, not your
  training data.
- Conservative by default. Confirm before destructive actions.
- The operator's machine state is unknown. Probe — don't assume.
- If something is broken or unclear, say so. The operator can email
  beta@keepur.io.
```

## Detection

`beekeeper hive setup` checks `~/services/hive/*/.hive/` before fetching:
- Found → print existing-install pointer + exit 0.
- Not found → proceed.
- `--force` → proceed regardless.

`beekeeper hive list` is detection-only — never installs.

## State boundary

- **Beekeeper owns**: is hive installed, where, which version, are the
  binaries on PATH, has the user paired Slack. Facts about the *machine*
  and the operator's *setup state*.
- **Hive owns**: is the daemon running, are agents healthy, are tools
  provisioned, is memory tier hygiene right. Facts about the *running
  engine*.

Beekeeper queries hive over loopback (or by reading instance directory
state) for cross-boundary questions; never reaches into hive's MongoDB
directly.

## Implementation notes

- Tarball download via `node:https` with redirect-following (npm registry
  uses 30x to the CDN).
- Verify SHA-512 integrity from `npm view @keepur/hive dist.integrity`
  before extraction.
- Extract via `tar` from `node:zlib` + `tar` userland... actually node has
  no built-in tar. Use the existing `tar` npm dep if hive uses one;
  otherwise, shell out to `/usr/bin/tar -xzf <path> -C <dest>` (it's
  always present on macOS).
- The `claude` CLI is on the operator's PATH if they have Claude Code
  installed. Spawn with `child_process.spawn("claude", [], { cwd:
  cacheDir, stdio: "inherit" })`. Don't await — let the parent exit and
  Claude Code take over the TTY.

## Files touched

- `src/cli.ts` — add `hive` subcommand dispatcher (sub-subcommands `setup`,
  `list`).
- `src/hive/lifecycle.ts` (new) — main lifecycle logic: cache dir
  resolution, npm-view, tarball fetch + extract, eviction, Claude Code
  spawn.
- `src/hive/discover.ts` (new) — enumerate `~/services/hive/`, read
  per-instance state, query launchd for run state.
- `src/hive/install-bee-claude-md.ts` (new) — the overlay template +
  version substitution.
- `src/hive/lifecycle.test.ts` + `src/hive/discover.test.ts` — unit tests
  with mocked HTTP / fs / launchctl runner.
- README.md — add a "Setting up hive" section pointing at
  `beekeeper hive setup`.

## Acceptance (Phase A)

- `beekeeper hive setup` on a clean Mac:
  - Fetches tarball within 30s on a typical connection.
  - Lands the operator in a Claude Code session that produces a working
    `hive init` flow.
  - Re-running detects the now-existing instance and points to
    `claude <id>` / `update`.
- `beekeeper hive list` on this machine (dodi + keepur installed):
  - Reports both, their engine versions, running state, and ports.
  - JSON output via `--json`.
- `npm run check` passes.
- New tests cover tarball fetch (mocked HTTP), cache layout, install-bee
  overlay content, and list enumeration with a mocked services dir.

## Out of scope (Phase B follow-ups)

- `beekeeper hive update [<instance>]` — wraps engine-side `hive update`.
- `beekeeper hive claude <instance>` — Claude Code session against a
  running instance with an ops overlay, not the install overlay.
- `beekeeper hive status [<instance>]` — live health rollup.
- Multi-host installs.
- Auto-installing Node / Mongo / Ollama / Qdrant without operator
  confirmation.
