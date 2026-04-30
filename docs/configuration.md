# Configuration

`beekeeper install` seeds a default config; this doc covers what each piece is for, in case you need to edit by hand.

## `~/.beekeeper/beekeeper.yaml`

```yaml
# WebSocket server port. 8420 is the public-facing port and the default;
# Hive (and other siblings) bind their loopback WS separately and federate
# via `?channel=`. See docs/federation.md.
port: 8420

# Claude model used for sessions inside `channel=beekeeper`.
model: claude-opus-4-6

# Default workspace path (optional)
default_workspace: ~/code/my-project

# Named workspaces (optional)
workspaces:
  my-project: ~/code/my-project
  docs: ~/code/docs

# Operations the server intercepts at PreToolUse and asks the device to
# approve before running.
confirm_operations:
  - "git push --force"
  - "git branch -D"
  - "git reset --hard"
  - "rm -rf"
  - "rm -r"
  - "git checkout -- ."
  - "git clean -f"
```

## Environment variables

`loadConfig()` auto-sources `$BEEKEEPER_ENV_FILE` (default `~/.beekeeper/env`) before reading these. Existing shell env wins over the file, so per-invocation overrides still work.

| Variable | Required | Purpose |
|---|---|---|
| `BEEKEEPER_JWT_SECRET` | Yes | Signing key for device JWTs (≥ 32 chars) |
| `BEEKEEPER_ADMIN_SECRET` | Yes | Bearer token for admin API + CLI loopback (≥ 32 chars) |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key (Claude Agent SDK uses it) |
| `BEEKEEPER_CONFIG` | No | Path to `beekeeper.yaml` (default: `./beekeeper.yaml`) |
| `BEEKEEPER_DATA_DIR` | No | SQLite + session storage (default: `~/.beekeeper`) |
| `BEEKEEPER_ENV_FILE` | No | Path to env file (default: `~/.beekeeper/env`) |

The recommended setup writes the secrets to `~/.beekeeper/env` (mode 600) once and never touches them again:

```bash
install -m 600 /dev/null ~/.beekeeper/env
cat > ~/.beekeeper/env <<'EOF'
BEEKEEPER_JWT_SECRET=...
BEEKEEPER_ADMIN_SECRET=...
ANTHROPIC_API_KEY=sk-ant-...
EOF
```

## LaunchAgent details

`beekeeper install` writes `~/Library/LaunchAgents/io.keepur.beekeeperd.plist` and bootstraps it. It picks one of two modes automatically:

- **Wrapper mode** (preferred): if `~/.beekeeper/env` exists at install time, install generates `~/.beekeeper/bin/start.sh` that sources the env file and execs node, and points the plist at the wrapper. Secrets stay out of the plist + launchctl state. Re-running install regenerates the wrapper from scratch.
- **Direct mode**: if no env file exists, the plist runs node directly with just `BEEKEEPER_CONFIG=beekeeper.yaml`. Secrets must be added to the plist's `EnvironmentVariables` dict by hand. Wrapper mode is recommended.

Pre-1.2 installs used the label `io.keepur.beekeeper` (no trailing "d"); install/uninstall both clean up that legacy plist if present, so two LaunchAgents never fight for `:8420`.

To uninstall: `beekeeper uninstall`. To tail logs:

```bash
log stream --predicate 'process == "beekeeperd"' --level debug
```

## Optional file-processing dependencies

For richer file content extraction (PDF, Word, Excel) on uploads:

```bash
npm install pdf-parse mammoth xlsx
```

- `pdf-parse` — text + metadata from PDFs
- `mammoth` — DOCX → clean HTML
- `xlsx` — Excel workbooks

Without these, beekeeper accepts uploads but returns minimal metadata. With them, full content is extracted and inlined in the session.
