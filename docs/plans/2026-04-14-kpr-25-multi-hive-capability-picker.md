# KPR-25: Multi-Hive Fan-Out & Capability Picker Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Let a single beekeeper front multiple registered hives simultaneously, addressed by name, with per-client fan-out across them. Client (keepur-ios) picks which hive(s) to talk to via the WebSocket `channel` param; beekeeper stays an opaque pass-through proxy.

**Architecture:**
- `channel=<capability-name>` is the only upgrade form. `channel=beekeeper` → in-process Claude sessions (unchanged). Any other value → `capabilities.get(name)` → proxy, or error.
- The single `capabilities.get("hive")` literal is removed. Name resolution happens once at the top of the upgrade handler.
- Each hive process must register under a distinct name via `POST /internal/register-capability`. Name constraints enforced by beekeeper: `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` with max length 32, `beekeeper` reserved. (No leading digit, no leading/trailing hyphen, no consecutive hyphens. See Task 1 for the exact implementation.)
- Two distinct rejection codes: `404 unknown-capability` (never registered) vs `503 capability-unavailable` (registered but currently health-dropped). Replaces today's single `503 hive-unavailable`.
- Fan-out is a **client-side** concern: keepur-ios opens N concurrent `channel=<name>` sockets, one per hive, and merges UI-side. Beekeeper's existing per-device `Set<ClientConn>` connection tracking already supports this and correctly fans out revocation-driven closes. No multiplexing, no frame parsing — the "team-proxy is opaque on purpose" invariant from CLAUDE.md stays intact.
- No user↔capability ACL in this release. Every active user sees every registered capability. Multi-tenancy (multiple businesses sharing one mac mini, users who don't see `beekeeper` at all) is explicitly deferred to a future ticket.

**Tech Stack:** Node 22, TypeScript, `better-sqlite3`, `ws`, Vitest. Ticket: https://linear.app/keepur/issue/KPR-25

**Out of scope:**
- **Hive-repo changes.** Each hive deployment must make its registration name configurable with no default. Tracked as a companion change in `bot-dodi/hive`. Beekeeper will reject registration with a missing/invalid name, so a hive running the current `"hive"`-hardcoded code keeps working as long as no second hive is registered — but the multi-hive use case requires the hive-repo change landed first.
- **iOS clients.** keepur-ios will ship the capability-picker UX + concurrent-socket fan-out after this lands. Since all existing callers will be updated, there is **no `channel=team` backwards-compat alias** in beekeeper. The literal `team` string is deleted from the upgrade handler.
- **User↔capability ACL.** Default-allow. No `user_capabilities` table, no grant/revoke CLI, no per-user filtering of `GET /capabilities`, no upgrade-time grant check. Forward-compatibility notes below describe how to add it later without re-plumbing.
- **Multi-tenant deployment model.** The "multiple businesses, one mac mini, users-without-beekeeper-access" scenario is deferred. When it's picked up, it will almost certainly want its own schema and its own notion of user classes.
- **Fan-out multiplexing inside beekeeper.** Considered and rejected. Would require parsing upstream-hive frames, break CLAUDE.md's "don't log or inspect team frames" invariant, and duplicate work that keepur-ios can do with less complexity.

---

## Forward-compat notes (leave these in the plan so future-you doesn't re-derive them)

When multi-tenant ACL work is picked up:

1. **Single resolution point.** All channel → capability lookups must continue to go through `capabilities.get(name)` called in exactly one place in `src/index.ts`. Don't scatter name lookups. Adding a per-user filter later is then a one-line diff: `capabilities.get(name) && userCanSee(user, name)`.
2. **`beekeeper` channel bypasses any future ACL.** The hypothesis is that multi-tenant users won't see `beekeeper` at all, which means the reserved name is always hard-coded-allow for single-tenant and hard-coded-deny for multi-tenant. Either way, it never becomes a grant row. Don't tempt yourself into making it one.
3. **Never embed capability grants into the JWT.** Tempting at pair time ("just bake the list into the token"), but it freezes permissions at pair time and makes revocation impossible without token rotation. Grants, when they exist, must be resolved live against SQLite on every upgrade.
4. **Capability registration should stay ACL-unaware.** Don't add `ownerUser` or similar hints to the register payload. Registration is loopback-only but still a privilege-grant path we don't want. Admin CLI is the right place for grants when the time comes.

---

## File map

| File | Change |
|---|---|
| `src/capabilities.ts` | Add name regex validation at `register()`. Reject invalid names with a thrown error (caller translates to HTTP 400). `beekeeper` reservation stays. No structural change — the manifest is already name-keyed. |
| `src/capabilities.test.ts` | New tests for name regex rejection, `beekeeper` reservation (already present — keep), multi-capability registration coexisting. |
| `src/index.ts` | Upgrade handler: parse `channel`, resolve via `capabilities.get(channel)` once, branch into `404 unknown-capability` / proxy / in-process session. Delete the literal `"team"` and `"hive"` strings. Delete the `channel !== "beekeeper" && channel !== "team"` 400 path (replaced by lookup). **Change the `wss.on("connection", ...)` callback's `channel` parameter type from `"beekeeper" \| "team"` (src/index.ts:569) to `string` — TypeScript will reject the `wss.emit(...)` call otherwise.** `POST /pair` response no longer includes `capabilities`. (Note: `POST /internal/register-capability` already wraps `capabilities.register()` in a try/catch at src/index.ts:179–185 — name-regex errors surface as 400 automatically once Task 1 throws them. No change to that handler.) |
| `src/index.test.ts` | **New file.** There is no upgrade-handler test coverage today. Cost of creating this: must spin up a real HTTP server + `WebSocketServer` + mock upstream `WebSocketServer` for hive, wire them up the way `src/index.ts:main()` does, and drive connections through the upgrade handler. Non-trivial setup — budget for it. Tests for: two hives registered, each addressable via `channel=<name>`; unknown name → 404; `channel=beekeeper` still hits the in-process session path; name-regex rejection at `POST /internal/register-capability`. The "one device, two concurrent team sockets → `DELETE /devices/:id` closes both" revocation-fanout case is **deferred to manual/live smoke test** — integration-testing the full admin-API + upgrade + proxy path together is more than KPR-25 should bite off. |
| `src/team-proxy.ts` | Small change: the close reason string `"hive-unavailable"` at line 189 and line 209 is now semantically wrong (it fires for any capability, not just hive). Change to `"capability-unavailable"` so the iOS client sees a consistent signal regardless of which capability name failed. No other change — the function already takes `hiveEntry: CapabilityEntry` per-connection; `&user=` forwarding is already correct. |
| `src/team-proxy.test.ts` | Update any assertions that expect the `"hive-unavailable"` reason string to expect `"capability-unavailable"`. |
| `README.md` | Update channel-routing description. Document the error-code split. Document that each hive must register with a unique name. Remove any lingering reference to `channel=team`. |
| `CLAUDE.md` | Update the "Two channels, one port" section to drop `channel=team` as a concept and describe the `channel=<capability-name>` model. Keep the "team-proxy is opaque on purpose" gotcha verbatim — it still applies. |

No new packages. No schema migrations. No config changes.

---

## Task 1: Capability name validation

**Files:**
- Modify: `src/capabilities.ts`
- Test: `src/capabilities.test.ts`

### Step 1: Regex constant + validation in `register()`

Add near the top of `src/capabilities.ts`:

```typescript
// Lowercase alphanumeric + internal hyphens only. No leading digit, no leading
// or trailing hyphen, no consecutive hyphens. Length 1–32.
const CAPABILITY_NAME_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const CAPABILITY_NAME_MAX_LENGTH = 32;
```

In `register()`, after the `BEEKEEPER_NAME` check:

```typescript
if (input.name.length > CAPABILITY_NAME_MAX_LENGTH || !CAPABILITY_NAME_REGEX.test(input.name)) {
  throw new Error(
    `Invalid capability name: ${JSON.stringify(input.name)}. ` +
    `Must be 1–${CAPABILITY_NAME_MAX_LENGTH} chars, lowercase alphanumeric + internal hyphens.`,
  );
}
```

Rationale: capability names land in URLs (`channel=...`), logs, and client pickers. Enforcing a tight charset at the one registration entry point means no downstream component has to worry about escaping.

### Step 2: Tests

In `src/capabilities.test.ts`, add:

- Registering `"hive-work"` succeeds.
- Registering `"HIVE"`, `"hive_work"`, `"1hive"`, `""`, `"hive/work"`, `"hive-"`, `"-hive"`, `"hive--work"`, or a 33-char name throws.
- Registering two distinct valid names and calling `list()` returns `["beekeeper", "hive-personal", "hive-work"]` (sorted, `beekeeper` first — this assertion probably exists already; keep it).
- `beekeeper` reservation error still thrown (existing test, keep).

### Verification

```bash
npm run test -- capabilities
```

**Commit:** `feat(capabilities): validate capability names at registration (KPR-25)`

---

## Task 2: Upgrade-handler channel routing

**Files:**
- Modify: `src/index.ts`
- Test: `src/index.test.ts` or the existing upgrade-handler test file (match what's already there)

### Step 1: Widen the connection-handler `channel` type

`src/index.ts:569` currently declares the `wss.on("connection", ...)` callback with `channel: "beekeeper" | "team" = "beekeeper"`. Widen to `channel: string = "beekeeper"`. Without this, every other change below fails typecheck because `wss.emit("connection", ..., "hive-work", ...)` passes a string the callback signature rejects. Do this first so the later edits compile as you go.

### Step 2: Resolve the channel once in the upgrade handler

Today's upgrade handler (`src/index.ts` ~line 529) looks roughly like:

```typescript
// ~line 529
if (channel !== "beekeeper" && channel !== "team") { /* 400 */ }
// ~line 546–548
if (channel === "team" && capabilities.get("hive") === undefined) {
  log.warn("WebSocket upgrade rejected — hive-unavailable", { deviceId });
  socket.write("HTTP/1.1 503 hive-unavailable\r\n\r\n");
  socket.destroy();
  return;
}
```

**Both of these early-exit blocks are deleted in their entirety** and replaced by the single resolution block shown below. The 400-on-unknown-channel block becomes dead — any name is now a candidate for `capabilities.get(name)`. The 503 `hive-unavailable` block also becomes dead — a missing registration now falls through to `404 unknown-capability` in the new resolution branch. This is the only place in the upgrade handler that emits the 503 string, so removing it also removes the last `hive-unavailable` literal from the upgrade path.

Replace with a single resolution block, early in the handler, after the device token has been verified and `channel` has been parsed from the URL:

```typescript
const channel = parsedUrl.searchParams.get("channel") ?? "beekeeper";

if (channel === "beekeeper") {
  // Fall through to in-process session path as today.
} else {
  const entry = capabilities.get(channel);
  if (entry === undefined) {
    // Distinguish "never registered" from "registered but dropped".
    // The manifest doesn't keep tombstones, so we can't reliably tell the
    // two apart after the fact — but the common health-dropped case is
    // handled by the loop re-registering quickly, and for the picker UX
    // the distinction matters most at the moment of the attempt.
    // Return 404 here; anything currently registered would have been
    // found by the get() call above.
    log.warn("WebSocket upgrade rejected — unknown capability", {
      deviceId: device._id,
      channel,
    });
    socket.write("HTTP/1.1 404 unknown-capability\r\n\r\n");
    socket.destroy();
    return;
  }
  // Attach the resolved entry to the upgrade context so the connection
  // handler doesn't re-look-it-up. If the entry gets dropped between
  // upgrade and connection (~instant window), the connection handler
  // will see a disconnected upstream on `open` and close with 503
  // via the existing onEarlyUpstreamError path.
}
```

### Step 3: Deciding 404 vs 503

The manifest currently exposes no "was this ever registered?" view — entries vanish on health drop. Two options:

- **(a) Always 404 on missing name.** Simpler. Health-dropped capability looks identical to typo. Client retry re-checks.
- **(b) Keep a short-lived "recently dropped" set** in the manifest so dropped names return 503 for, say, 60 seconds after unregistration. Gives the picker UX a better signal.

**Recommendation: (a)** for this release. (b) is a UX nicety, not a correctness fix, and the health loop's 20s drop window already makes flaps rare enough that the distinction is mostly academic. Revisit if the iOS team reports confusing behavior.

The code comment in Step 2 already reflects choice (a). If (b) wins on reflection, the manifest grows a `recentlyDropped: Map<string, number>` and the upgrade handler checks it after `get()` returns undefined.

**503 is NOT emitted by KPR-25.** The README (Task 3) will mention it only as "reserved for future use." Do not document it as a live error code the iOS picker can expect today — `404 unknown-capability` is the only failure mode the client will see for missing/dropped capabilities in this release.

### Step 4: Connection handler

The existing `if (channel === "team")` branch at ~`src/index.ts:595` resolves `capabilities.get("hive")` again. Replace with: re-resolve by `channel` name (cheap map lookup). Drop the `"hive"` literal entirely. Keep the defensive `if (!entry)` guard for the race window where a capability drops between upgrade resolution and connection handler, but match the new error naming: **change `ws.close(1011, "hive-unavailable")` at `src/index.ts:601` and `src/index.ts:615` to `ws.close(1011, "capability-unavailable")`**. These are two distinct `"hive-unavailable"` literals in the connection handler (the defensive guard path and the `proxyTeamConnection` catch block) — update both. Also update the adjacent `log.warn("team channel connection with no hive capability — closing", ...)` at `src/index.ts:600` to a capability-neutral message like `log.warn("Connection with no capability entry — closing", { deviceId, channel })`.

### Step 5: `POST /pair` response

Remove the `capabilities` field from the response body. Single source of truth is `GET /capabilities`. Update any existing pair-response assertions in `src/device-registry.test.ts` or wherever they live.

### Step 6: Update `src/team-proxy.ts` close reason + doc sweep

At `src/team-proxy.ts:189` and `:209` (both on the early-upstream-error / early-upstream-close paths), change the close reason string `"hive-unavailable"` to `"capability-unavailable"`. Close code 1011 stays. Also update the JSDoc block at `src/team-proxy.ts:44` which reads "closes the client with code 1011 (`hive-unavailable`)" — change to `"capability-unavailable"` so the doc matches the code.

Then update `src/team-proxy.test.ts`: both the `.it(...)` description string at `:297` (contains the literal `"hive-unavailable"`) AND the `.toBe("hive-unavailable")` assertion at `:311`. The description is not technically an assertion but will show up in test output and must be kept consistent.

**Final sweep.** Combined with Step 4's fix to `src/index.ts:600`, `:601`, and `:615`, the substring `hive-unavailable` should be absent from the entire source tree. Run `grep -rn 'hive-unavailable' src/` before commit and confirm zero matches. Also run `grep -rn 'hive capability' src/` to catch any other stale prose — if the log message update in Step 4 lands, this should also be zero.

### Step 7: Tests

Create a new `src/index.test.ts` (see file-map note — there is no existing upgrade-handler test coverage). Setup requires a real HTTP server + `WebSocketServer` (the way `main()` wires them) plus a mock hive `WebSocketServer` bound to a loopback port that beekeeper's capability points at. Budget real time for this setup.

Tests:

- Two capabilities registered (`hive-a`, `hive-b`); device opens `channel=hive-a` → proxied to hive-a's mock upstream. Opens `channel=hive-b` → proxied to hive-b.
- `channel=nonexistent` → 404 response on the upgrade HTTP write, client connection not upgraded.
- `channel=beekeeper` still hits the in-process session path (regression guard; may require mocking `SessionManager` since this file won't otherwise need it).
- `POST /internal/register-capability` with name `"HIVE"` → 400 with a message mentioning the name constraints.
- Close-reason regression guard: wire a mock hive upstream that fails immediately on connect, open `channel=<name>`, assert the client sees close code 1011 with reason `"capability-unavailable"` (never `"hive-unavailable"`). Covers both `src/index.ts`'s defensive guard paths and `team-proxy.ts`'s early-error paths.

**Explicitly deferred to manual/live smoke test:** the revocation fan-out case ("one device, two concurrent sockets to `hive-a` and `hive-b`, `DELETE /devices/:id` closes both"). Driving it through a test requires the admin-API auth path + two mock upstreams + the whole connection-tracking dance, and the logic it exercises (iterate `connectedClients.get(deviceId)` and close each `ClientConn.upstreamWs`) is already identical to what today's single-hive path does — the multi-hive behavior falls out of the existing `Set<ClientConn>` tracking for free. A manual test against a live two-hive deploy is a better use of effort than an integration test that mostly re-asserts today's invariant.

### Verification

```bash
npm run check
```

**Commit:** `feat(server): route channel=<capability-name> directly; drop hive/team literals (KPR-25)`

---

## Task 3: Docs

**Files:**
- Modify: `README.md`, `CLAUDE.md`

### README

Update the "Channel routing" or equivalent section:

- `channel=beekeeper` → in-process Claude Code sessions (default when omitted for backcompat? confirm — probably drop the default too; explicit is better now that there's no one "right" answer).
- `channel=<capability-name>` → proxied to the named capability if registered.
- Error codes: `404 unknown-capability` is the only failure the upgrade handler emits in KPR-25. `503 capability-unavailable` and `403 forbidden` are **reserved names for future work** (health-dropped distinction and ACL respectively) and are explicitly NOT used in this release — do not document them as live behavior.
- Name regex, `beekeeper` reserved.
- "Running multiple hives" section: each hive's registration name must be unique; the hive repo's registration code makes this configurable.

### CLAUDE.md

Update "Two channels, one port" to describe the `channel=<capability-name>` model. The "team-proxy is opaque on purpose" gotcha paragraph stays verbatim. Add a note under Gotchas: "Capability names are validated at register time; don't skip the regex if adding a new caller."

### Verification

Manual review only.

**Commit:** `docs: describe channel=<capability-name> routing and multi-hive (KPR-25)`

---

## Task 4: Full verification

Run:

```bash
npm run check
```

Then smoke-test against a live two-hive deployment if one is reachable. The unit tests cover routing; the live test is the only way to verify real multi-hive `&user=` forwarding end-to-end (per CLAUDE.md "unit tests mock the SDK"). If no live two-hive deployment exists yet, call out that this ticket's verification is blocked on the hive-repo companion change landing.

**No commit** — verification only.

---

## Sequencing with the hive repo

| Step | What | Who |
|---|---|---|
| 1 | Land beekeeper KPR-25 PR | beekeeper repo |
| 2 | Land hive-repo change: registration name becomes required config | hive repo |
| 3 | Redeploy existing hive on the mac mini under name `hive` (or rename to `hive-main` or similar) | ops |
| 4 | Deploy second hive process under a distinct name | ops |
| 5 | Update keepur-ios picker + fan-out UX | keepur-ios repo |

Steps 1 and 2 can be parallelized. **Step 2 is only required before step 4** (deploying a second hive under a distinct name). Step 3 — redeploying the existing single hive — can happen as soon as step 1 lands, because the existing hive already registers under the literal name `"hive"` which remains a valid capability name under the new regex. Step 5 can start once step 1 ships, but won't be useful until step 4.

## Risks + mitigations

- **Deleting `channel=team` breaks any caller we forgot about.** Mokie has confirmed keepur-ios and dodi-shop-ios will be updated after beekeeper ships, so this is accepted. Mitigation: search both client repos for `channel=team` before merging, and make sure the deploy to the mac mini waits until clients are ready. If ordering gets out of hand, the fallback is to reintroduce a `channel=team` alias that resolves to the single registered capability when exactly one exists — three lines of code, easy to add back.
- **Health-drop race window.** A capability that gets health-dropped between upgrade resolution and connection-handler proxy open will close with 503-equivalent. The window is milliseconds wide and the existing `onEarlyUpstreamError` in `team-proxy.ts` already handles it. No new code needed — just aware of it when debugging future flake reports.
- **Forward-compat discipline.** Single-resolution-point and no-capabilities-in-JWT rules from the forward-compat notes are easy to violate under time pressure. Mitigation: a comment above the `capabilities.get(channel)` line in `src/index.ts` saying "single resolution point — see docs/plans/2026-04-14-kpr-25-*.md" so the next person touching it sees the intent.

## Open items to resolve before starting

- [ ] Confirm with the hive repo that making registration name configurable is scoped and tracked. Without that, KPR-25 ships but can't be exercised in production with more than one hive.
- [ ] Decide whether `channel` omitted-in-URL still defaults to `beekeeper` or is now an error. Current behavior defaults to `beekeeper` for backcompat with clients that predate the `channel` param at all. Given all clients are being updated, making it explicit (reject empty channel) is cleaner, but "default to `beekeeper`" is also defensible as "the in-process path is the distinguished one." Low-stakes call — pick during implementation.
