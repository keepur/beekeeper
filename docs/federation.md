# Federation

Beekeeper exposes a loopback API that lets a second process running on the same machine register itself as a `?channel=<name>` capability. Clients then opt into that capability via the WebSocket URL. The mechanism is generic; the concrete use case today is [Hive](https://github.com/keepur/hive), which serves a Slack-shaped team channel as `channel=team`.

> **Beekeeper-only deployments need no setup for this.** `GET /capabilities` returns just `{ "capabilities": ["beekeeper"] }` and `channel=team` upgrades return `503 hive-unavailable`. Skip this doc unless you're authoring a sibling.

## How it works (sibling authors)

1. **Beekeeper listens on the public port** (default `8420`). The sibling binds its own WebSocket adapter to a loopback-only port (Hive uses `127.0.0.1:3200`).

2. **The sibling registers itself periodically.** On boot — and every 30s thereafter, to survive Beekeeper restarts — the sibling calls:

   ```bash
   curl -X POST http://127.0.0.1:8420/internal/register-capability \
     -H "Content-Type: application/json" \
     -d '{
       "name": "hive",
       "localWsUrl": "ws://127.0.0.1:3200",
       "healthUrl": "http://127.0.0.1:3200/health"
     }'
   ```

   Auth is enforced purely by the loopback check (`remoteAddress` must be `127.0.0.1` or `::1`). No bearer token. The call is idempotent — re-registering overwrites the existing entry and resets the failure counter.

3. **Beekeeper health-checks every 10s.** Two consecutive failures drop the entry from the manifest. Siblings should re-register on a short interval (Hive uses 30s) to survive Beekeeper restarts.

4. **Clients pick a channel on connect.** `wss://<host>/?token=<jwt>&channel=hive` proxies the socket to the sibling's loopback WS. Omitting `channel` (or passing `channel=beekeeper`) routes to Beekeeper's own Claude Code session manager.

5. **Start order is irrelevant.** The sibling's re-registration loop makes the system self-heal across restarts of either process. Nothing in `beekeeper.yaml` mentions the sibling.

## Visibility

- `GET /capabilities` (device-JWT-authed) returns the names available right now.
- `beekeeper capabilities` (operator CLI, loopback) returns the same list with health metadata.
- The `POST /pair` response embeds the current capability list, so first-run clients have it before they make a separate call.
