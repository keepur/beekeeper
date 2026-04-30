# API reference

Beekeeper's HTTP surface, organized by who calls it.

## Public

### `GET /health`

```bash
curl http://localhost:8420/health
```

Returns `{ status, sessions, connectedDevices }`. No auth.

### `POST /pair`

```bash
curl -X POST http://beekeeper-host:8420/pair \
  -H "Content-Type: application/json" \
  -d '{"code": "ABCD1234", "label": "My iPhone"}'
```

Exchanges a pairing code for a JWT. Response includes `token`, `deviceId`, `label`, and the current `capabilities` list.

## Device self-service (Bearer device JWT)

### `GET /me`

Returns the calling device's record.

```bash
curl http://localhost:8420/me \
  -H "Authorization: Bearer $DEVICE_TOKEN"
```

### `PUT /me`

Update the device's display label.

```bash
curl -X PUT http://localhost:8420/me \
  -H "Authorization: Bearer $DEVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label": "New Name"}'
```

### `GET /capabilities`

Capability names available on this gateway.

```bash
curl http://localhost:8420/capabilities \
  -H "Authorization: Bearer $DEVICE_TOKEN"
```

Response: `{ "capabilities": ["beekeeper", "hive"] }`.

`beekeeper` is always present. Other names appear when a sibling has registered itself via `/internal/register-capability` and is passing health checks. Clients should call this on app foreground and on WebSocket reconnect.

## Admin (Bearer `BEEKEEPER_ADMIN_SECRET`)

These endpoints are also reachable from the loopback-only `/admin/*` paths used by the CLI.

### `POST /devices`

Create a device + pairing code.

```bash
curl -X POST http://localhost:8420/devices \
  -H "Authorization: Bearer $BEEKEEPER_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"userId": "alice", "label": "iPhone"}'
```

### `GET /devices`

List all devices with status. (CLI: `beekeeper devices list`.)

### `GET /devices/:id` / `PUT /devices/:id` / `DELETE /devices/:id`

Get / rename / deactivate a device.

### `POST /devices/:id/refresh-code`

Issue a new pairing code for an existing device.

## Loopback-only admin

Gated by both `BEEKEEPER_ADMIN_SECRET` AND a loopback `remoteAddress` check; non-loopback callers get 403 even with a valid secret. The CLI calls these.

### `GET /admin/sessions`

Active SDK sessions with timing fields.

### `GET /admin/capabilities`

Full capability entries (URLs, last health check, consecutive failures).

## Internal (loopback only, no auth)

### `POST /internal/register-capability`

Used by sibling processes (Hive) to register themselves. See [federation.md](federation.md).
