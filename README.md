# Beekeeper

> **The operator CLI for Hive.** Drives Hive installs, manages devices, and serves Claude Code sessions to remote clients (iOS, web).

[![npm](https://img.shields.io/npm/v/@keepur/beekeeper?label=npm&style=flat)](https://www.npmjs.com/package/@keepur/beekeeper)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue?style=flat)](LICENSE)

The package ships two binaries:

- **`beekeeperd`** — gateway daemon, owned by launchd. WebSockets in, Claude Code sessions out.
- **`beekeeper`** — operator CLI. Installs the daemon, drives Hive lifecycle, manages devices.

## Install

```
sudo npm i -g @keepur/beekeeper
beekeeper install
```

`beekeeper install` is one-shot: writes a LaunchAgent plist, creates a config dir at `~/.beekeeper/`, and loads the daemon. Daemon's running on `:8420` by the time the command returns.

## Set up Hive

```
beekeeper hive setup
```

This fetches the latest [@keepur/hive](https://www.npmjs.com/package/@keepur/hive) release and opens a Claude Code session that walks you through `hive init`, Slack pairing, dependency setup (Node, MongoDB, Ollama, Qdrant), and your first conversation. Budget about 20 minutes. Re-running detects existing instances; pass `--force` to install fresh.

```
beekeeper hive list      # show installed instances + run state
beekeeper status         # gateway health
```

## Pair a device

```
beekeeper user add <id> "<display name>"     # one-time, register the user
beekeeper pair <id> "iPhone"                 # 6-digit code, 10-min TTL
```

Enter the code in the [Keepur iOS app](https://apps.apple.com) (or any client speaking the beekeeper protocol). Devices auth with JWTs from there.

## Common commands

```
beekeeper help                 # full command list
beekeeper status               # gateway health (sessions, connected devices)
beekeeper sessions list        # active Claude Code sessions
beekeeper devices list         # registered devices
beekeeper hive setup           # install/upgrade hive on this Mac
beekeeper hive list            # all hive instances + run state
beekeeper user list            # registered users
beekeeper pair <user> <label>  # issue a pairing code
beekeeper install              # install/reload the LaunchAgent
beekeeper uninstall            # remove the LaunchAgent
```

`--json` is accepted on `status`, `sessions list`, `devices list`, `capabilities`.

## Update

```
sudo npm i -g @keepur/beekeeper@latest
beekeeper install
```

`install` is idempotent: regenerates the wrapper + plist and bootout-then-bootstrap the LaunchAgent so the new daemon is running before the command returns.

## TLS / remote access

If you reach beekeeper from anything other than localhost, put TLS in front of `:8420`. Beekeeper serves plain HTTP/WS by design — bring your own Cloudflare Tunnel, Tailscale Funnel, Caddy, nginx, etc. iOS clients won't connect over plain `ws://` (App Transport Security blocks it). Localhost-only setups need nothing extra.

## Docs

For deeper reading or when you need the API surface:

- [Configuration](docs/configuration.md) — `beekeeper.yaml`, env vars, LaunchAgent details.
- [API reference](docs/api.md) — REST endpoints (device self-service, admin, internal).
- [Federation](docs/federation.md) — how Hive (or any sibling) registers as a `?channel=` capability.
- [Architecture](docs/architecture.md) — what's inside the gateway.
- [Development](docs/development.md) — contributing, running from source, releasing.

## License

Apache-2.0. See [LICENSE](LICENSE).
