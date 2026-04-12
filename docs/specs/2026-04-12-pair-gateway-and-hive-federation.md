# Pair Gateway & Hive Federation — Design Spec

**Date:** 2026-04-12
**Status:** Draft
**Repos affected:** `relay` (this repo), `hive`, `keepur-ios`

## Problem

Today, device pairing and WebSocket auth are fragmented across services:

- **Hive** runs its own WS adapter on `*:3200` with its own `/pair` endpoint, its own JWT secret, its own Mongo-backed `devices` collection. `dodi-shop-ios` pairs against `https://shop.dodihome.com/pair` and talks to this.
- **Beekeeper** (the Claude Code session gateway, pre-extraction copy living at `hive/src/beekeeper/`) runs a *separate* server with its own `/pair`, its own JWT secret, its own Mongo-backed `devices` collection. `keepur-ios`'s Chat tab pairs against `http://beekeeper.dodihome.com/pair` and talks to this.
- **Relay** (this repo) is the extracted, standalone version of Beekeeper with SQLite + AES column encryption. Not yet deployed.

From the user's perspective, a mac mini running Hive + Beekeeper is "one server," but pairing it requires two independent flows, two tokens, two trust domains. Adding a Team tab to Keepur surfaced this: the client has no way to produce a Hive-valid token from a Beekeeper pairing, and vice versa.

There is also a naming insight worth capturing: **there can be a Beekeeper without a Hive, but never a Hive without a Beekeeper.** Beekeeper is the always-present service on any box where Claude Code work happens; Hive is an optional agent runtime that sits alongside it. This invariant shapes the whole design.

## Goals

1. **One pair, one code, per hostname.** A user installing Keepur enters a server address, receives one pairing code from that server's admin surface, enters it on the phone, and is done. No second pair flow for Team, no second token.
2. **Capability-driven tabs.** The server advertises which services it runs (`beekeeper`, and optionally `hive`). Keepur renders tabs based on that manifest. A box running only Beekeeper shows the Beekeeper tab. A box running Beekeeper + Hive shows Beekeeper + Team.
3. **Hive becomes stateless about devices.** Beekeeper is the sole device registry on a box. Hive has no `devices` collection, no pairing endpoint, no JWT secret of its own.
4. **Hive's WS adapter moves to localhost-only.** The public WS endpoint on `*:3200` goes away. Beekeeper is the only process that accepts external connections for Hive-bound traffic.
5. **`hive/src/beekeeper/` is deleted.** Its duplicated Mongo-backed Claude Code session gateway is replaced by this repo (Relay/Beekeeper), running as a sibling process.

## Non-goals

- **Renaming `@keepur/relay` → `@keepur/beekeeper`.** The package/repo rename is a cosmetic follow-up, not part of this spec. Throughout this doc, "Beekeeper" refers to the service identity exposed to users and clients; the npm package name can stay `@keepur/relay` for now.
- **Multi-server in Keepur.** The client will eventually need to store a list of paired servers for power users (e.g. one phone paired to dodi + personal instances), but this spec assumes a single-server client. The token/storage model should not preclude multi-server, but UI and keychain-list management are out of scope.
- **Migrating existing paired devices.** When this ships, all current Keepur and dodi-shop-ios devices re-pair once. No data migration from Hive's `devices` collection or Beekeeper's current Mongo store.

## Architecture

### Service topology (after this change)

```
                    ┌─────────────────────────────────┐
                    │         mac mini                │
                    │                                 │
  wss://host/  ──▶  │  Beekeeper (this repo)          │
                    │   :<public port>                │
                    │   ─ /pair                       │
                    │   ─ /capabilities               │
                    │   ─ WS upgrade (auth + route)   │
                    │   ─ SQLite device registry      │
                    │   ─ Claude Code sessions        │
                    │           │                     │
                    │           │ localhost proxy     │
                    │           ▼                     │
                    │  Hive (optional)                │
                    │   127.0.0.1:3200                │
                    │   ─ WS adapter (localhost only) │
                    │   ─ no /pair, no devices coll.  │
                    │   ─ verify tokens via Beekeeper │
                    └─────────────────────────────────┘
```

### Capability registration

On startup, Hive calls `POST http://127.0.0.1:<beekeeper>/internal/register-capability`:

```json
{
  "name": "hive",
  "localWsUrl": "ws://127.0.0.1:3200",
  "healthUrl": "http://127.0.0.1:3200/health"
}
```

Beekeeper stores this in memory (not SQLite — it's runtime state). If Hive dies, Beekeeper detects it via health check and drops the capability from the manifest. On Hive restart, Hive re-registers.

If no Hive registers, Beekeeper's capability manifest contains only `beekeeper`. This is the "relay-only box" deployment.

### Pair flow

1. Client: `POST https://<host>/pair { code, name }` (unchanged from `dodi-shop-ios` today)
2. Beekeeper verifies the pairing code against its SQLite `devices` table.
3. Beekeeper mints **one JWT** signed with its own secret. Claims include `deviceId`, `name`, and a `caps` array reflecting the current capability manifest (e.g. `["beekeeper", "hive"]`).
4. Beekeeper returns:
   ```json
   {
     "token": "...",
     "deviceId": "...",
     "name": "...",
     "capabilities": ["beekeeper", "hive"]
   }
   ```
5. Client stores the token in Keychain under a single slot. Client reads `capabilities` to decide which tabs to render.

**Admin surface for minting pair codes:** unchanged from Beekeeper today. A CLI or admin API (`POST /devices` with Bearer admin secret) produces a 6-digit code, which the operator reads from the terminal and gives to the phone owner. No new GUI needed for v1.

### WebSocket routing

Client opens one socket: `wss://<host>/?token=<jwt>`.

Beekeeper's WS upgrade handler:

1. Validates the JWT with its own secret.
2. Accepts the upgrade.
3. Reads the first client frame, which **must** be `{"type":"join","channel":"beekeeper"|"team"}`.
4. Based on channel:
   - `beekeeper` → handled locally (existing Claude Code session manager).
   - `team` → Beekeeper opens a sibling socket to `ws://127.0.0.1:3200/?internal=1&deviceId=<id>&name=<name>` and proxies frames bidirectionally between client and Hive until either side closes.

The `internal=1` query flag tells Hive "this connection is coming from Beekeeper, don't try to verify a device JWT." Hive trusts the connection because it's on localhost and the flag is only honored when the source address is `127.0.0.1`. `deviceId` and `name` are passed in so Hive has device metadata without needing its own registry.

**Rationale for proxying frames rather than returning a direct URL to Hive:** keeps Hive's WS adapter off the public network, makes Beekeeper the single choke point for device auth/revocation, and means the client only ever maintains one WebSocket per server.

### Trust model between Beekeeper and Hive (Option B from design chat)

Hive does **not** hold a JWT secret. Hive does **not** maintain a device registry. Hive trusts exactly two things:

1. **The localhost loopback.** Any connection to `127.0.0.1:3200` with `?internal=1` is trusted to be Beekeeper. (Binding the WS adapter to `127.0.0.1` only, not `0.0.0.0`, enforces this at the OS level.)
2. **The `deviceId` and `name` passed in the internal connection query string.** Beekeeper is the authority for these; Hive just echoes them into its log lines and work items.

When a device is revoked, Beekeeper deactivates it in SQLite and closes any open upstream sockets tied to that device. Because Hive's socket to the client is actually Beekeeper's proxied socket, closing from Beekeeper's side closes the Hive-side connection too. **Revocation is instant and has no Hive-side dependency.**

This means Hive needs **no** `/internal/verify` endpoint on Beekeeper — the design collapses to "Beekeeper proxies, Hive trusts localhost." Simpler than the earlier chat framing, same security properties.

## Changes by repo

### `relay` (this repo)

1. **Re-sync from `hive/src/beekeeper/`.** The extraction captured an older snapshot. Merge in changes since (notably commit `abd616e` "broadcast messages to all connected devices" and any auth/session fixes from commits since the extraction).
2. **Add `/capabilities` endpoint.** Returns `{ capabilities: string[] }` based on registered capabilities + the always-present `beekeeper`.
3. **Add `/internal/register-capability` endpoint.** Loopback-only. In-memory storage with health checks.
4. **Extend JWT claims to include `caps`.** Populated at pair time from the current capability manifest.
5. **WS upgrade handler reads channel join frame.** Routes `beekeeper` locally, proxies `team` to Hive's localhost WS.
6. **Frame proxy implementation.** Bidirectional pipe between client WS and Hive WS, propagating close codes and errors in both directions.
7. **Admin CLI update.** `relay device create <name>` outputs a pairing code for the operator to read to the user.

### `hive`

1. **Delete `src/beekeeper/`.** Entire directory. Includes its tests, config, device registry, session manager, question relayer, tool guardian, file handler. These all live in `relay` now.
2. **Delete Hive's device registry.** `src/channels/ws/device-registry.ts`, the `devices` Mongo collection, any admin REST endpoints under `/devices` in `src/channels/ws/ws-adapter.ts`. Hive is no longer a device registry.
3. **Delete `/pair` from `ws-adapter.ts`.** Pairing is Beekeeper's job.
4. **Bind Hive WS adapter to `127.0.0.1` only.** Previously `*:3200`. Update `WsAdapter` constructor + `createServer().listen(port, "127.0.0.1")`.
5. **Accept `?internal=1` connections without token auth,** only when the socket's remote address is loopback. Read `deviceId` and `name` from query string instead of the device registry.
6. **Register with Beekeeper on startup.** New module `src/beekeeper-client.ts` (or similar) that calls `POST http://127.0.0.1:<beekeeper>/internal/register-capability` on boot and retries on Beekeeper restart. Beekeeper port comes from config.
7. **Delete `WS_ADMIN_SECRET` handling, device pairing code generation, JWT signing.** Gone.
8. **Update deploy script and LaunchAgent.** Beekeeper must be running before Hive starts, or Hive must retry registration until Beekeeper is up. Hive's LaunchAgent gains a dependency on Beekeeper's LaunchAgent.
9. **Remove `WS_PORT=3200` tunneling concerns.** The cloudflared tunnel (`dodi-shop.config.yml`) keeps `shop.dodihome.com` → `localhost:3200` only if we decide Hive stays on 3200 *internally*. Alternative: move the tunnel to point at Beekeeper's public port and retire 3200 externally. This spec recommends the latter — one hostname, one port, one service exposed.

### `keepur-ios`

1. **Single pair screen,** posts to `https://<host>/pair` with code + name, stores one token in Keychain.
2. **Read capabilities from pair response,** store alongside token. Use to decide which tabs to render.
3. **Delete `TeamWebSocketManager.swift` as a separate URL/auth boundary.** Team and Beekeeper tabs share one underlying WebSocket (or two sockets to the same host with the same token — implementation detail). The `ws://hive.dodihome.com:3100` URL goes away entirely.
4. **First-run UX:** prompt for server hostname (e.g. `shop.dodihome.com`), then pairing code. Persist hostname in Keychain.
5. **`dodi-shop-ios` is unaffected** functionally — its existing pair flow continues to work because Beekeeper's `/pair` endpoint is API-compatible with Hive's current one. The capabilities field is additive; older clients ignore it.

### cloudflared / ops

1. Update `~/.cloudflared/config.yml` so `shop.dodihome.com` routes to Beekeeper's public port instead of Hive's 3200. (Or: keep `shop.dodihome.com` for backward compatibility with `dodi-shop-ios` and add `beekeeper.dodihome.com` as the canonical new name — decide based on how many `dodi-shop-ios` installs exist.)
2. Retire the `beekeeper.dodihome.com` → legacy-beekeeper mapping once clients have migrated.

## Migration plan

Ordered to avoid downtime on `dodi-shop-ios` (which real users depend on):

1. **Re-sync relay from hive/src/beekeeper.** Get parity with current Beekeeper behavior including recent broadcast commit.
2. **Deploy relay as a sibling process** on the mac mini, on a new port. Expose via a new cloudflared hostname. Verify with a test device.
3. **Add capability registration to Hive (additive).** Hive registers with relay on startup but keeps its own WS adapter on `*:3200` and its own device registry. Both old and new pair flows work concurrently.
4. **Update keepur-ios** to pair against the new relay hostname. Ship to TestFlight. Verify both Team and Beekeeper tabs work through the unified token.
5. **Migrate dodi-shop-ios** to pair against the new relay hostname on next release.
6. **Flip cloudflared:** `shop.dodihome.com` now routes to relay's public port, not Hive's 3200.
7. **Delete Hive's `src/beekeeper/`, device registry, pair endpoints, admin secret.** Rebind WS adapter to `127.0.0.1`.
8. **Delete legacy `beekeeper.dodihome.com` tunnel entry** if it existed.

Steps 1–4 are additive and reversible. Steps 5–8 are one-way but scoped to a single deploy each.

## Open questions

1. **Beekeeper's public port.** Does it keep `3200` (inheriting from Hive's retired WS adapter) or pick a new canonical port? Leaning: pick a new one, leave 3200 to Hive's loopback binding forever.
2. **Pair code UX.** Today it's CLI-only. Is a minimal web UI at `https://<host>/admin` worth building in v1, or defer until there's a second user who isn't on the terminal?
3. **Multi-instance on one mac mini** (dodi + personal). Current thinking: each Hive instance has its own Beekeeper, separate hostnames, separate tunnels. Confirm before deploying personal instance behind this architecture.
4. **Broadcast-to-all-devices** (commit `abd616e`). This currently lives in Hive's beekeeper copy. Confirm it moves cleanly into relay.
5. **Hive admin operations** (agent CRUD, model overrides) currently accessible via admin MCP tools run inside Hive. No change needed — they stay inside Hive, triggered by agents or Claude Code CLI sessions via MCP. This spec does not surface any admin UI to Keepur.

## References

- Prior extraction plan: `hive/docs/plans/2026-04-11-relay-extraction.md`
- Prior extraction spec: `hive/docs/specs/2026-04-11-relay-extraction-design.md`
- Hive WS adapter: `hive/src/channels/ws/ws-adapter.ts`
- Hive beekeeper (to be deleted): `hive/src/beekeeper/`
- dodi-shop-ios pair client: `dodi-shop-ios/DodiShop/Views/PairingView.swift`, `dodi-shop-ios/DodiShop/Managers/WebSocketManager.swift`
- keepur-ios Team client: `keepur-ios/Managers/TeamWebSocketManager.swift`
