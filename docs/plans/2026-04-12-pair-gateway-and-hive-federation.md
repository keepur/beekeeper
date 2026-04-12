# Pair Gateway & Hive Federation — Implementation Plan

**Date:** 2026-04-12
**Spec:** `docs/specs/2026-04-12-pair-gateway-and-hive-federation.md`
**Scope:** Beekeeper (this repo) work only. Hive and keepur-ios changes are tracked here for sequencing but land in their own repos.

## Overview

This plan focuses on the Beekeeper-side deliverables. The spec splits the overall migration into 8 steps; Beekeeper work concentrates in migration steps 2 (deploy) and, implicitly, all the code changes that must be ready before step 2. Beekeeper has **no Phase A/Phase B split** — everything ships in a single release and is feature-complete on deploy. The phased rollout is entirely on the Hive side.

## Work breakdown (Beekeeper repo)

Ordered by dependency. Each step is a single commit boundary unless noted.

### 1. Capability manifest module — `src/capabilities.ts` (new)

- In-memory manifest: `Map<string, CapabilityEntry>` where entry is `{ name, localWsUrl, healthUrl, consecutiveFailures, lastCheckedAt, addedAt }`.
- Exported API:
  - `register(entry)` — idempotent upsert, resets failure count, logs add transition.
  - `unregister(name)` — removes + logs drop transition.
  - `list()` — returns `["beekeeper", ...registered names sorted]`. `beekeeper` always first and always present.
  - `get(name)` — returns entry or undefined (used by WS proxy to resolve `localWsUrl`).
- Health checker: `startHealthLoop()` begins a `setInterval` polling every 10s. On fetch failure or non-2xx, increment `consecutiveFailures`; at 2, call `unregister`. On success, reset.
- Graceful shutdown: expose `stopHealthLoop()` for the main shutdown handler.
- Unit tests (`src/capabilities.test.ts`): register/unregister idempotency, `list()` ordering, failure-threshold drop, success-resets-failure-count, parallel register of two capabilities.

### 2. HTTP endpoints — modify `src/index.ts`

Add three route handlers alongside the existing ones:

- **`POST /internal/register-capability`**
  - Loopback enforcement: check `req.socket.remoteAddress` ∈ `{"127.0.0.1", "::1", "::ffff:127.0.0.1"}`. On mismatch, 403 and log warn.
  - Parse `{ name, localWsUrl, healthUrl }` from body (reuse `readBody` + 16KB cap). Validate all three are non-empty strings.
  - Call `capabilities.register(...)`. Return 200 `{ ok: true }`.
- **`GET /capabilities`**
  - Token-authed via existing `verifyDeviceToken(req)` helper. 401 on missing/invalid.
  - Return `{ capabilities: capabilities.list() }`.
- **`POST /pair` response shape change**
  - Add `capabilities: capabilities.list()` to the existing response body at `src/index.ts:116`. Keep `deviceName` — do not rename to `name`.

### 3. WS channel routing — modify `src/index.ts` upgrade handler

- Parse `channel` query param from the upgrade URL. Default `"beekeeper"`.
- Reject with `400` if channel is not one of `{"beekeeper", "team"}`.
- If `channel === "team"` and `capabilities.get("hive")` is undefined, reject upgrade with `503 hive-unavailable` before `wss.handleUpgrade`.
- On successful upgrade, pass `channel` through to the `connection` handler (extend the emitted context).

### 4. Team-channel proxy — `src/team-proxy.ts` (new)

- Exported `proxyTeamConnection(clientWs, device, hiveEntry)`:
  - Opens `new WebSocket(hiveEntry.localWsUrl + "/?internal=1&deviceId=..&name=..")` with URL-encoded device fields.
  - On upstream `error` before `open`: close client with code `1011`, reason `hive-unavailable`.
  - On upstream `open`: wire up bidirectional pipe.
- Pipe semantics:
  - Forward `message` events in both directions verbatim. Use `ws.send(data, { binary: typeof data !== 'string' })` to preserve binary frames.
  - Forward `close` events in both directions, propagating code + reason.
  - Forward `error` events as best-effort close with 1011.
- Backpressure: before forwarding a frame to side X, if `X.bufferedAmount > 4 * 1024 * 1024`, call `Y.pause()` (the `ws` library uses `socket.pause()` on the underlying stream — reach through via `(Y as any)._socket.pause()`). Resume on `drain`-equivalent (poll `bufferedAmount` on a short timer; `ws` doesn't emit `drain`).
- Pings: do NOT forward client pings through the proxy. Beekeeper's `ws` library auto-responds to pings. For upstream, start a 30s keepalive `setInterval` that calls `upstreamWs.ping()`; clear on close.
- Return `{ upstreamWs, dispose }` so the connection tracking layer (step 5) can close both sides on revocation.
- Unit tests (`src/team-proxy.test.ts`): mock Hive WS server, assert text + binary passthrough, close-code propagation, `1011 hive-unavailable` on connect failure, backpressure pause under synthetic load.

### 5. Connection tracking extension — modify `src/index.ts`

Change the existing `connectedClients: Map<string, Set<WebSocket>>` shape to store an object per connection so the upstream proxy socket can be tracked alongside the client socket:

```ts
type ClientConn = { clientWs: WebSocket; upstreamWs?: WebSocket };
const connectedClients = new Map<string, Set<ClientConn>>();
```

- Update `wss.on("connection", ...)` to construct a `ClientConn` and add to the set.
- For `channel === "team"` connections, call `proxyTeamConnection` and set `conn.upstreamWs` on the entry.
- `DELETE /devices/:id` handler at `src/index.ts:324` iterates the set and closes both `clientWs` and `upstreamWs` (if present).
- Client `ws.on("close", ...)` removes the specific `ClientConn` from the set, and if it had an upstream, closes the upstream cleanly (the proxy's own close handler should already do this, but belt-and-suspenders).
- Update `sessionManager.addClient` / `removeClient` call sites to take `clientWs` from the conn.

### 6. Config changes — `src/config.ts` + `beekeeper.yaml.example`

- Change default `port` to `8420` in `beekeeper.yaml.example`.
- Add `capabilitiesHealthIntervalMs` (default 10000) and `capabilitiesFailureThreshold` (default 2) to config, plumbed into `startHealthLoop`. This makes the health loop testable with short intervals.
- No new required config fields — all changes are additive with defaults.

### 7. Wire everything into `main()`

- Construct the capabilities module after `deviceRegistry.open()`.
- Call `capabilities.startHealthLoop(config.capabilitiesHealthIntervalMs, config.capabilitiesFailureThreshold)` before `server.listen`.
- Add `capabilities.stopHealthLoop()` to the `shutdown` handler.

### 8. `beekeeper pair <name>` CLI subcommand — modify `src/cli.ts`

Add a new `case "pair":` alongside the existing `install`/`uninstall`/`migrate` commands.

- Usage: `beekeeper pair <device-name>` (name required, may contain spaces — take `process.argv.slice(3).join(" ")` so quoting works).
- Load config via `loadConfig()` to resolve `dataDir` and `jwtSecret`.
- Open `DeviceRegistry` directly against `join(config.dataDir, "devices.db")`, same as `src/index.ts:30`. WAL mode makes this safe while the server is running.
- Call `deviceRegistry.createDevice(name)`. Print:

  ```
  Created device: <name>
  Device ID:  <id>
  Pair code:  <6-digit code>
  Expires in: 10 minutes
  ```

- Call `deviceRegistry.close()` on exit (both success and error paths).
- Error cases: missing name → usage message + exit 1; config load failure → error + exit 1; any DeviceRegistry error → print + exit 1.
- Add a short section to README documenting the command.
- Unit test (`src/cli.test.ts`, new if absent): spawn the CLI in a child process against a temp data dir, assert a code appears in stdout and a row lands in the SQLite file. If test-setup cost is too high, defer to manual smoke test and rely on the DeviceRegistry unit tests for correctness.

### 9. README + `beekeeper.yaml.example` docs

- Document `GET /capabilities` and `POST /internal/register-capability` in README.
- Document the new default port and the rationale for 8420.
- Add a section: "Running alongside Hive" explaining that Hive registers itself on startup and Beekeeper needs no manual wiring.

### 10. Full test + typecheck + build

- `npm test` (vitest), `npm run build` (tsc), manual smoke test of the new endpoints with `curl`.

## What's explicitly NOT in this plan (other repos)

- **Hive Phase A** (`hive` repo): `src/beekeeper-client.ts` register loop, `?internal=1` WS acceptance with loopback check. Ships independently once this Beekeeper plan is merged and deployed.
- **Hive Phase B** (`hive` repo): deletions, rebind to `127.0.0.1`. Ships after migration step 6 cloudflared flip.
- **keepur-ios**: single pair screen, capabilities refresh, two-socket Team manager, Keychain blob shape. Ships after Beekeeper is deployed and Hive Phase A is registering.
- **cloudflared / ops**: tunnel updates. Done manually on the mac mini in sequence with the releases.

## Sequencing with the migration plan (spec §Migration plan)

| Spec step | What gates it | Who executes |
|---|---|---|
| 1. Re-sync beekeeper | Already done (`dac70b7`, `2220d58`) | — |
| 2. Deploy beekeeper on :8420 | **This plan's steps 1–9 merged** | ops (mac mini) |
| 3. Hive Phase A | Beekeeper deployed & `/internal/register-capability` reachable | hive repo |
| 4. keepur-ios TestFlight | Hive registering successfully | keepur-ios repo |
| 5. dodi-shop-ios migrate | keepur-ios validated | dodi-shop-ios repo |
| 6. Flip cloudflared | ≥95% dodi-shop-ios on new build | ops |
| 7. Hive Phase B | Cloudflared flipped | hive repo |
| 8. Retire legacy tunnel entry | Phase B deployed | ops |

## Risks + mitigations

- **Backpressure implementation via `_socket.pause()` is reaching into `ws` internals.** If this proves unstable in testing, fall back to a simpler "if bufferedAmount > 4MB, drop the connection with 1013 `backpressure`." Mobile clients will reconnect. Documented as a fallback, not the default.
- **Health-check loop races with registration during startup.** If Hive registers at second 0 and the first health check at second 10 fails (e.g. Hive still warming up), we'd drop and re-add within 40 seconds. Acceptable — the manifest flaps briefly, clients just see Team tab vanish+reappear. If observed in practice, add a 30s grace period after first registration before health checks start counting failures.
- **`connectedClients` shape change is invasive.** Every existing use site (`src/index.ts:34, 242, 278, 333, 415, 421, 638`) needs updating. Risk of missing one. Mitigation: define the new type up front, let TypeScript's strict mode flag every mismatch, fix until green. Do this as a single commit to keep the diff reviewable.
- **Admin CLI (spec beekeeper item 9) resolved as no-op.** `src/cli.ts` has `install`/`uninstall`/`migrate` only. Device creation is covered by `POST /devices` admin HTTP endpoint; adding a CLI subcommand is pure sugar. Deferred unless a real need emerges.

## Open items to resolve before step 1

- [x] ~~Confirm current `src/cli.ts` has or lacks `device create`~~ — checked: no subcommand exists. Item 9 now covered by new `beekeeper pair <name>` CLI (plan step 8).
- [ ] Decide on backpressure strategy: `_socket.pause()` reach-through vs. drop-on-threshold. Pick during step 4 implementation after a quick experiment.
