# Pair Gateway & Hive Federation — Design Spec

**Date:** 2026-04-12
**Status:** Draft
**Repos affected:** `beekeeper` (this repo), `hive`, `keepur-ios`

## Problem

Today, device pairing and WebSocket auth are fragmented across services:

- **Hive** runs its own WS adapter on `*:3200` with its own `/pair` endpoint, its own JWT secret, its own Mongo-backed `devices` collection. `dodi-shop-ios` pairs against `https://shop.dodihome.com/pair` and talks to this.
- **Beekeeper** (the Claude Code session gateway, pre-extraction copy living at `hive/src/beekeeper/`) runs a *separate* server with its own `/pair`, its own JWT secret, its own Mongo-backed `devices` collection. `keepur-ios`'s Chat tab pairs against `http://beekeeper.dodihome.com/pair` and talks to this.
- **`@keepur/beekeeper`** (this repo) is the extracted, standalone version of the session gateway with SQLite + AES column encryption. Not yet deployed.

From the user's perspective, a mac mini running Hive + Beekeeper is "one server," but pairing it requires two independent flows, two tokens, two trust domains. Adding a Team tab to Keepur surfaced this: the client has no way to produce a Hive-valid token from a Beekeeper pairing, and vice versa.

There is also a naming insight worth capturing: **there can be a Beekeeper without a Hive, but never a Hive without a Beekeeper.** Beekeeper is the always-present service on any box where Claude Code work happens; Hive is an optional agent runtime that sits alongside it. This invariant shapes the whole design.

## Goals

1. **One pair, one code, per hostname.** A user installing Keepur enters a server address, receives one pairing code from that server's admin surface, enters it on the phone, and is done. No second pair flow for Team, no second token.
2. **Capability-driven tabs.** The server advertises which services it runs (`beekeeper`, and optionally `hive`). Keepur renders tabs based on that manifest. A box running only Beekeeper shows the Beekeeper tab. A box running Beekeeper + Hive shows Beekeeper + Team.
3. **Hive becomes stateless about devices.** Beekeeper is the sole device registry on a box. Hive has no `devices` collection, no pairing endpoint, no JWT secret of its own.
4. **Hive's WS adapter moves to localhost-only.** The public WS endpoint on `*:3200` goes away. Beekeeper is the only process that accepts external connections for Hive-bound traffic.
5. **`hive/src/beekeeper/` is deleted.** Its duplicated Mongo-backed Claude Code session gateway is replaced by this repo, running as a sibling process.

## Non-goals

- **Any user-visible rebranding beyond the npm/repo name.** The rename to `@keepur/beekeeper` has already happened. Throughout this doc, "Beekeeper" is both the service identity and the package name.
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
                    │   ─ no JWT secret; trusts       │
                    │     loopback + ?internal=1      │
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

**Loopback enforcement.** Beekeeper rejects this endpoint with 403 unless `req.socket.remoteAddress` is `127.0.0.1` or `::1`. No other auth — the loopback check is the auth.

Beekeeper stores this in memory (not SQLite — it's runtime state).

**Health check cadence.** Beekeeper polls `healthUrl` every **10s**. Two consecutive failures drop the capability from the manifest.

**Hive re-registration cadence.** Because Beekeeper's manifest is in-memory, a Beekeeper restart silently loses Hive's registration. Hive therefore re-registers on a **30s interval** regardless of prior state — the call is idempotent (re-register overwrites), cheap, and makes start order between the two processes irrelevant. Hive also calls register immediately on its own startup so the tab doesn't wait up to 30s for first registration.

If no Hive registers, Beekeeper's capability manifest contains only `beekeeper`. This is the "Beekeeper-only box" deployment — a dev laptop with Claude Code sessions but no agent runtime.

### Pair flow

1. Client: `POST https://<host>/pair { code, name }` (request body uses `name`; response below uses `deviceName` — intentional asymmetry matching today's Beekeeper API, kept for `dodi-shop-ios` back-compat).
2. Beekeeper verifies the pairing code against its SQLite `devices` table.
3. Beekeeper mints **one JWT** signed with its own secret. Claims are minimal: `deviceId` and `name` only. **Capabilities are NOT baked into the JWT** — they're dynamic runtime state (Hive may start/stop after pairing) and staleness would force needless re-pairs.
4. Beekeeper returns (additive to today's response — `deviceName` is kept for `dodi-shop-ios` back-compat, `capabilities` is new):
   ```json
   {
     "token": "...",
     "deviceId": "...",
     "deviceName": "...",
     "capabilities": ["beekeeper", "hive"]
   }
   ```
5. Client stores the token in Keychain. Client uses `capabilities` from the pair response for the initial tab set, then refreshes via `GET /capabilities` (token-authed) on app foreground and on WS reconnect so the tab set tracks Hive availability without re-pairing.

**Admin surface for minting pair codes:** unchanged from Beekeeper today. A CLI or admin API (`POST /devices` with Bearer admin secret) produces a 6-digit code, which the operator reads from the terminal and gives to the phone owner. No new GUI needed for v1.

### WebSocket routing

Client opens one socket: `wss://<host>/?token=<jwt>`. Optionally `&channel=team` to select a non-default channel at upgrade time.

Beekeeper's WS upgrade handler:

1. Validates the JWT with its own secret.
2. Reads `channel` from the query string. Default is `beekeeper` (preserves `dodi-shop-ios` back-compat — existing clients send no channel and get the Beekeeper session manager, exactly as today).
3. If `channel=team` but Hive is not in the current capability manifest, reject the upgrade with HTTP 503 and reason `hive-unavailable` before calling `handleUpgrade`.
4. Accepts the upgrade. Based on channel:
   - `beekeeper` → handled locally (existing Claude Code session manager).
   - `team` → Beekeeper opens a sibling socket to `ws://127.0.0.1:3200/?internal=1&deviceId=<id>&name=<name>` and proxies frames bidirectionally between client and Hive until either side closes.

**Rationale for query-string channel selection over a join frame:** no timeout state machine, no ambiguity about what the first frame means, and — critically — no change to `dodi-shop-ios`'s current upgrade path (it just keeps working as the default `beekeeper` channel).

The `internal=1` query flag tells Hive "this connection is coming from Beekeeper, don't try to verify a device JWT." Hive honors the flag **only** when `req.socket.remoteAddress` is loopback (`127.0.0.1`/`::1`); rejected otherwise. Combined with Hive binding its WS adapter to `127.0.0.1` only, this is defense-in-depth at the OS level and the application level. `deviceId` and `name` are passed in so Hive has device metadata without needing its own registry.

**Frame proxy implementation requirements:**

- **Binary and text frames** both forwarded verbatim (no JSON parsing — the proxy is opaque).
- **Close-code propagation** in both directions: if either side closes with code/reason, forward to the other.
- **Error handling on upstream connect:** if the sibling socket to Hive fails to open (Hive just died between manifest check and connect), close the client socket with 1011 `hive-unavailable`.
- **Backpressure:** when `ws.bufferedAmount` on the downstream side exceeds 4 MB, pause reading on the upstream side until it drains. Unbounded buffering on a slow mobile client would otherwise OOM the gateway.
- **Ping/pong:** Beekeeper answers client pings itself (to keep the public socket alive independent of Hive latency) and does not forward them. The upstream socket to Hive gets its own keepalive ping loop from Beekeeper.
- **Tracking for revocation:** each proxied pair (`clientWs`, `upstreamWs`) is registered in `connectedClients` so that `DELETE /devices/:id` can close both sides. Today's map only tracks `clientWs` — this needs to be extended (see §Changes by repo / beekeeper item 8).

**Rationale for proxying frames rather than returning a direct URL to Hive:** keeps Hive's WS adapter off the public network, makes Beekeeper the single choke point for device auth/revocation, and means the client only ever maintains one WebSocket per server.

### Trust model between Beekeeper and Hive (Option B from design chat)

Hive does **not** hold a JWT secret. Hive does **not** maintain a device registry. Hive trusts exactly two things:

1. **The localhost loopback.** Any connection to `127.0.0.1:3200` with `?internal=1` is trusted to be Beekeeper. (Binding the WS adapter to `127.0.0.1` only, not `0.0.0.0`, enforces this at the OS level.)
2. **The `deviceId` and `name` passed in the internal connection query string.** Beekeeper is the authority for these; Hive just echoes them into its log lines and work items.

When a device is revoked, Beekeeper deactivates it in SQLite and closes any open upstream sockets tied to that device. Because Hive's socket to the client is actually Beekeeper's proxied socket, closing from Beekeeper's side closes the Hive-side connection too. **Revocation is instant and has no Hive-side dependency.**

This means Hive needs **no** `/internal/verify` endpoint on Beekeeper — the design collapses to "Beekeeper proxies, Hive trusts localhost." Simpler than the earlier chat framing, same security properties.

## Changes by repo

### `beekeeper` (this repo)

1. **Re-sync from `hive/src/beekeeper/`.** ✅ **Done** as of commits `dac70b7` (broadcast to all connected devices) and `2220d58` (session reaper). Listed here for history; no further action.
2. **Add `GET /capabilities` endpoint.** Token-authed (Bearer device JWT). Returns `{ capabilities: string[] }` where the list is `["beekeeper", ...registered]`. `beekeeper` is always first and always present.
3. **Add `POST /internal/register-capability` endpoint.** Loopback-enforced (`remoteAddress` ∈ {`127.0.0.1`, `::1`}, else 403). Body: `{ name, localWsUrl, healthUrl }`. In-memory manifest map keyed by `name`. Idempotent — a re-register overwrites.
4. **Capability health checker.** Per entry: poll `healthUrl` every 10s; drop after 2 consecutive failures. Log add/drop transitions.
5. **Pair response adds `capabilities`.** Keep `deviceName` (not `name`) to match the current response shape that `dodi-shop-ios` depends on. Do **not** add `caps` to the JWT claims.
6. **WS upgrade handler reads `?channel=` from query string.** Default `beekeeper` (back-compat with today's clients). `team` → open upstream proxy to Hive. If `team` requested while Hive is not in the manifest, reject upgrade with 503 before `handleUpgrade`.
7. **Frame proxy implementation** per §WebSocket routing requirements: binary+text passthrough, close-code propagation, backpressure at 4 MB `bufferedAmount`, beekeeper-terminated pings, upstream keepalive, `1011 hive-unavailable` on upstream connect failure.
8. **Extend `connectedClients` tracking to cover proxied pairs.** Today the map is `Map<deviceId, Set<WebSocket>>` of client sockets only (`src/index.ts:34`). Change the value shape (or add a sibling map) so each entry can carry an optional upstream `WebSocket` reference. `DELETE /devices/:id` iterates and closes both sides. Spec-level requirement; implementation picks the exact data structure.
9. **Admin CLI: `beekeeper pair <name>` subcommand.** Operator runs `beekeeper pair "Alice's iPhone"` on the host; the command opens the local SQLite device registry directly (same path the server uses), creates a device row, and prints the pairing code to stdout in a human-readable format. No HTTP, no admin Bearer secret, no running server required — it's a local filesystem operation gated by Unix file permissions on `devices.db`. Output format:

   ```
   Created device: Alice's iPhone
   Device ID:  abc123...
   Pair code:  482917
   Expires in: 10 minutes
   ```

   Runs concurrently with the server thanks to SQLite WAL mode. This replaces the "curl the admin API" workflow as the default operator UX.
10. **Config: public port.** Default to **8420** in `beekeeper.yaml.example`. Not 3200 — that stays forever as Hive's loopback binding so there's no collision risk on boxes running both.

### `hive`

Changes split into two phases so the additive migration window (plan steps 3–6) stays functional. Both phases share a numbered change list; each item is tagged **[A]** (ships in Phase A, migration step 3) or **[B]** (ships in Phase B, migration step 7).

**Phase A is additive:** Hive still accepts its old token-authed public connections on `*:3200` and its `/pair` endpoint still works for existing `dodi-shop-ios` installs. The Phase A changes coexist with the legacy code paths — `?internal=1` takes precedence when the flag is present, otherwise the legacy token check runs. This lets keepur-ios validate the unified pair + Team channel against real infrastructure before anything is destroyed.

**Phase B is destructive** and ships after the cloudflared flip.

1. **[A] Register with Beekeeper on an interval.** New module `src/beekeeper-client.ts` (or similar) calls `POST http://127.0.0.1:<beekeeper>/internal/register-capability` immediately on boot and then every 30s forever. Idempotent (Beekeeper overwrites on re-register). Makes process start order irrelevant and survives Beekeeper restarts without a notification channel. Beekeeper port comes from Hive's config.
2. **[A] Accept `?internal=1` connections without token auth,** **only** when `req.socket.remoteAddress` ∈ {`127.0.0.1`, `::1`}. Read `deviceId` and `name` from query string instead of the device registry. **Security note:** this loopback check is load-bearing during Phase A, when Hive's WS adapter is still bound to `*:3200` and reachable from the public tunnel. A missing check would be a full auth bypass for the team channel. After Phase B rebinds to `127.0.0.1`, the OS-level bind is a second layer; the code-level check stays as defense-in-depth.
3. **[B] Delete `src/beekeeper/`.** Entire directory. Includes its tests, config, device registry, session manager, question relayer, tool guardian, file handler. These all live in `@keepur/beekeeper` now.
4. **[B] Delete Hive's device registry.** `src/channels/ws/device-registry.ts`, the `devices` Mongo collection, any admin REST endpoints under `/devices` in `src/channels/ws/ws-adapter.ts`. Hive is no longer a device registry.
5. **[B] Delete `/pair` from `ws-adapter.ts`.** Pairing is Beekeeper's job.
6. **[B] Bind Hive WS adapter to `127.0.0.1` only.** Previously `*:3200`. Update `WsAdapter` constructor + `createServer().listen(port, "127.0.0.1")`.
7. **[B] Delete `WS_ADMIN_SECRET` handling, device pairing code generation, JWT signing.** Gone.
8. **[B] Deploy script / LaunchAgent.** No strict dependency needed — Hive's 30s re-register loop absorbs any start-order skew. Just ensure both LaunchAgents are installed; order doesn't matter.
9. **[ops, not code] Cloudflared tunnel.** `shop.dodihome.com` moves off Hive's 3200 and onto Beekeeper's public port (8420) at migration step 6. Hive's 3200 becomes loopback-only when Phase B lands. See §Migration plan for the cutover sequence.

### `keepur-ios`

1. **Single pair screen,** posts to `https://<host>/pair` with code + name, stores token in Keychain.
2. **Read capabilities from pair response** for the initial tab set. Refresh via `GET /capabilities` (Bearer token) on app foreground and on WS reconnect so Hive start/stop is reflected without re-pairing.
3. **Delete `TeamWebSocketManager.swift` as a separate URL/auth boundary.** Both tabs connect to the same host with the same token. Implementation choice: either one shared socket with per-message routing, or two sockets to the same host distinguished by `?channel=team` vs the default. Spec recommends **two sockets** — simpler, lets the Team socket die independently when Hive is down without tearing down Beekeeper sessions. The legacy Hive WS URL goes away entirely.
4. **First-run UX:** prompt for server hostname (e.g. `shop.dodihome.com`), then pairing code. Persist `{ hostname, token, deviceId, deviceName, capabilities }` as a single JSON blob in one Keychain slot — leaves room for a future multi-server list without a migration.
5. **`dodi-shop-ios` is unaffected** functionally — its existing pair flow continues to work because Beekeeper's `/pair` endpoint is API-compatible with Hive's current one (`deviceName` field preserved). The `capabilities` field is additive; older clients ignore it. Existing `dodi-shop-ios` WS upgrades send no `channel` query param and land on the default `beekeeper` channel — no client change required.

### cloudflared / ops

1. Add `beekeeper.dodihome.com` (or chosen new hostname) → `localhost:8420` during the additive phase of migration (step 2).
2. At migration step 6, flip `shop.dodihome.com` from `localhost:3200` to `localhost:8420`. Both hostnames now resolve to Beekeeper; `dodi-shop-ios` users keep their existing URL forever. See Open Q #2 for the long-term hostname strategy.
3. Retire any legacy `beekeeper.dodihome.com` → legacy-beekeeper (Hive's old pre-extraction Beekeeper) mapping once clients have migrated.

## Migration plan

Ordered to avoid downtime on `dodi-shop-ios` (which real users depend on):

1. **Re-sync beekeeper from hive/src/beekeeper.** ✅ Done (`dac70b7`, `2220d58`).
2. **Deploy beekeeper as a sibling process** on the mac mini, on port **8420**. Expose via a new cloudflared hostname (e.g. `beekeeper.dodihome.com`). Verify with a test device.
3. **Ship Hive Phase A (additive).** Hive registers with Beekeeper on a 30s interval AND accepts `?internal=1` loopback connections without token auth. Hive keeps its own public WS adapter on `*:3200`, its own device registry, and its own `/pair` endpoint. Both old and new pair flows work concurrently. This is the window where keepur-ios can validate the Team channel against Beekeeper's proxy end-to-end.
4. **Update keepur-ios** to pair against the new beekeeper hostname. Ship to TestFlight. Verify both Team and Beekeeper tabs work through the unified token.
5. **Migrate dodi-shop-ios** to pair against the new beekeeper hostname on next App Store release. **Gate:** do not proceed to step 6 until the new `dodi-shop-ios` build is on ≥95% of active installs (checked via App Store Connect analytics). Older installs still hitting the Hive pair flow must have a migration path or be explicitly drained first.
6. **Flip cloudflared:** `shop.dodihome.com` now routes to beekeeper's public port (8420), not Hive's 3200. At this point, the old Hive-served `/pair` is no longer externally reachable.
7. **Ship Hive Phase B (destructive).** Delete `src/beekeeper/`, device registry, `/pair`, admin secret. Rebind WS adapter to `127.0.0.1`. No LaunchAgent dependency needed — Hive's 30s re-register loop handles start-order.
8. **Delete legacy `beekeeper.dodihome.com` → legacy-beekeeper tunnel entry** if it existed.

Steps 1–4 are additive and reversible. Steps 5–8 are one-way but scoped to a single deploy each. Step 5's gate is the only time-bound one — everything else can proceed as soon as the previous step is verified.

## Resolved decisions

- **Public port:** **8420**. Hive's 3200 stays forever as a loopback-only binding; no external collision.
- **Pair code UX:** CLI-only for v1. Defer web admin UI until there's a second non-terminal user.
- **Broadcast-to-all-devices** (commit `abd616e`): already landed in `@keepur/beekeeper` (`dac70b7`).
- **Capabilities in JWT:** no — served via `GET /capabilities` instead (see §Pair flow).
- **Channel selection:** query-string `?channel=`, not an in-band join frame (back-compat with `dodi-shop-ios`).
- **Hive admin operations** (agent CRUD, model overrides): unchanged. They stay inside Hive, triggered by agents or Claude Code CLI sessions via MCP. This spec does not surface any admin UI to Keepur.

## Open questions

1. **Multi-instance on one mac mini** (dodi + personal). Current thinking: each Hive instance has its own Beekeeper, separate hostnames, separate tunnels, separate ports. Confirm before deploying a personal instance behind this architecture.
2. **Cloudflared cutover hostname strategy:** do we reuse `shop.dodihome.com` after the flip (keeps existing `dodi-shop-ios` URLs working forever) or retire it in favor of `beekeeper.dodihome.com` once `dodi-shop-ios` has fully migrated? Leaning: keep `shop.dodihome.com` as an alias indefinitely — cheap and avoids a second forced client migration.

## References

- Prior extraction plan: `hive/docs/plans/2026-04-11-relay-extraction.md`
- Prior extraction spec: `hive/docs/specs/2026-04-11-relay-extraction-design.md`
- Hive WS adapter: `hive/src/channels/ws/ws-adapter.ts`
- Hive beekeeper (to be deleted): `hive/src/beekeeper/`
- dodi-shop-ios pair client: `dodi-shop-ios/DodiShop/Views/PairingView.swift`, `dodi-shop-ios/DodiShop/Managers/WebSocketManager.swift`
- keepur-ios Team client: `keepur-ios/Managers/TeamWebSocketManager.swift` (currently points at Hive WS on port 3200; goes away in this spec)
