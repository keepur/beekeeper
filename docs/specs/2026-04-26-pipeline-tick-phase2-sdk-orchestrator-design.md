# Pipeline-tick — In-Server SDK-Native Orchestrator — Design Spec

**Date:** 2026-04-26
**Author:** May (CEO) + Mokie (Opus)
**Linear:** KPR-96
**Triggered by:** Pipeline-tick Phase 1 (KPR-90) shipped with `child_process.spawn("claude", ["-p", prompt], { detached: true, stdio: ["ignore", "ignore", "ignore"] })`. The very first dogfood run hit the predictable failure: a drafter ran 14+ minutes with no progress signal, and the operator had no way to tell if it was doing work or stalled. May's distrust of "patch on top of opaque CLI subprocesses with timer-based callbacks" is well-founded; Beekeeper is already a Claude Agent SDK consumer (`SessionManager` imports `query` from `@anthropic-ai/claude-agent-sdk`), so the right architecture is to use that primitive directly for pipeline subagents — same observability we already get for paired WS sessions.

## Problem

Phase 1's subagent spawn driver is structurally a blackbox:

1. **No progress signal.** `stdio: "ignore"` discards stdout/stderr. The detached child can be running, blocked, looping, or crashed — the operator has no signal until the subagent posts a Linear comment (or doesn't).
2. **No tool-call visibility.** The subagent calls `gh`, `git`, `mongo`, file-write tools without anyone watching. Tool-guardian protections that exist for paired sessions don't apply.
3. **No clean cancel.** SIGTERM to the pid works in principle, but the orchestrator doesn't track pids reliably across tick boundaries (the spawning tick exits immediately after `child.unref()`).
4. **No cost telemetry.** Token usage / model cost per subagent is unknown.
5. **Open-questions detection lags.** The Phase 1 design polls Linear comments to detect open-questions blocks; if the subagent stalls before posting the comment, the next tick can't tell. With streamed `SDKMessage` we could content-match in real time.
6. **CI-mode friction.** A future cron-driven mode (Phase 3 of the original pipeline-tick design) needs a way to enforce per-job timeouts; managing that against detached pids is fragile.

Beekeeper already has the primitive that fixes all six: `SessionManager` calls `query()` from the SDK, registers hooks (`ToolGuardian` for Bash confirmation, `QuestionRelayer` for `AskUserQuestion`), and consumes the streamed `SDKMessage` iterator. Paired WS sessions get full observability via this path. Pipeline subagents should ride the same primitive instead of forking off into the dark.

## Goals

1. **In-process subagent spawn via SDK `query()`.** The Beekeeper server (already running as a LaunchAgent) hosts the orchestrator; pipeline subagents run as in-process iterations of the SDK message stream — not as detached `claude -p` children.
2. **Live observability.** Tool calls, thinking, message text, cost, and lifecycle events are observable in real time. CLI surfaces a "live tail" by streaming/polling the server.
3. **Cancel.** `pipeline-tick cancel <agentId>` calls `activeQuery.interrupt()` on the orchestrator and the subagent stops cleanly.
4. **Stall detection.** Stream-idle timeout (e.g., 5 min without a message) → mark `block:human` on the ticket with a diagnostic comment. Replaces the Phase 1 "if a Linear comment hasn't shown up after N minutes assume it's stuck" implicit assumption with an active liveness check.
5. **Real-time open-questions detection.** Content-match the streamed assistant text for the open-questions sentinel; transition the ticket to `block:human` and post the question list as a Linear comment immediately, without waiting for the subagent to finish.
6. **CLI returns immediately.** The Phase 1 OQ-1 contract — "tick returns without waiting" — survives. The CLI POSTs a job, gets a job-id back, exits. The job runs in the server.
7. **Linear comment audit trail intact.** Lock-claim, spawn-log, lock-release comments continue to be written exactly as today. The SDK orchestrator is additive observability, not a replacement for the comment-based mutex.
8. **No new daemon.** All work happens inside the existing Beekeeper server process; nothing new to install, nothing new to keep running.

## Non-goals

- **Multi-instance orchestrator pool.** A single Beekeeper server runs all pipeline subagents. Phase 4 may revisit if compute saturates.
- **Cron-driven autonomous mode.** Phase 3 of the original pipeline-tick design — separate concern, separate ticket if/when it lands.
- **Replacing `SessionManager`.** This work reuses SDK primitives but does NOT route pipeline subagents through `SessionManager`. SessionManager is built around paired interactive sessions (clients connect via WS, see messages, approve tools). Pipeline subagents have no human-in-the-loop client; they need a different hook profile (no `QuestionRelayer`) and a different message-routing model (server-side buffer, not client-broadcast). A new `PipelineOrchestrator` module composes the same SDK primitives differently.
- **Synchronous wait-for-completion CLI mode.** CLI is fire-and-forget; the live-tail endpoint is the way to watch progress. A `--wait` flag that blocks until the job finishes is out of scope (operator runs the next tick to see the result).
- **Replacing Linear as the persistent state machine.** Linear remains source of truth for ticket state. The orchestrator's per-job message buffer is ephemeral (lives in the server process, lost on restart); for durable audit, the existing Linear comment writes still happen.

## Design

### Module: `src/pipeline/orchestrator/`

New module composing the SDK primitives. Public API:

```ts
export interface PipelineJob {
  agentId: string;          // e.g., "agent-01HW...."
  ticketId: string;         // e.g., "KPR-79"
  kind: SubagentKind;       // "draft-spec" | "draft-plan" | "code-review" | "implementer"
  cwd: string;              // resolved repo path
  startedAt: string;        // ISO
  state: "running" | "completed" | "interrupted" | "stalled" | "error";
  lastMessageAt: string;    // ISO; updated on every SDKMessage received
  messages: PipelineJobMessage[]; // streamed buffer (see below)
  result?: { ok: boolean; reason: string };
}

export class PipelineOrchestrator {
  spawn(input: SpawnInput): PipelineJob;                   // returns immediately; throws TicketBusyError if a running job exists for input.ticketId
  cancel(agentId: string): void;                            // interrupts the active query
  get(agentId: string): PipelineJob | null;                 // for live-tail endpoint
  getActiveByTicket(ticketId: string): PipelineJob | null;  // concurrent-spawn guard
  listActive(): PipelineJob[];                              // for diagnostics
}
```

`SpawnInput` matches today's `subagent-spawn.ts` shape (`kind`, `prompt`, `repoPath`, `ticketId`) — same drop-in surface, different implementation underneath.

### Subagent spawn flow

When `PipelineOrchestrator.spawn(input)` is called:

1. **Allocate** a fresh `agentId` (`agent-${ulid()}`).
2. **Compose hooks** for this job:
   - `ToolGuardian`-equivalent: a pipeline-tightened guardian that approves a configured allowlist (`gh`, `git`, `npm run *`, etc.) and rejects everything else by default. **Pipeline subagents have no human in the loop** — they must run with a more conservative guardian than paired sessions, since there's no operator to approve unusual operations interactively. Open Question: exact allowlist (see below).
   - **No `QuestionRelayer`.** Pipeline subagents that hit `AskUserQuestion` should be treated as a stuck-on-decision case: the hook records the question, transitions the job to `state: "stalled"`, posts the question to Linear as `block:human`, and interrupts the query. (Different from paired sessions where the question is relayed to the connected client.)
   - **Stream-watcher hook**: synthetic (not an SDK hook — a wrapper around the message iterator) that updates `lastMessageAt` on every message and content-matches assistant text for the open-questions sentinel.
3. **Start the query**:
   ```ts
   const activeQuery = query({
     prompt: input.prompt,
     options: {
       pathToClaudeCodeExecutable: config.claudeCliPath,
       model: config.pipelineModel,         // per kind, configurable
       permissionMode: "bypassPermissions",
       includePartialMessages: true,        // emits SDKPartialAssistantMessage stream events — required for liveness during long tool calls
       cwd: input.repoPath,
       hooks: { PreToolUse: [pipelineGuardian.createHookCallback(agentId)] },
       env: {
         ...process.env,                     // inherits LINEAR_API_KEY etc.
         PIPELINE_AGENT_ID: agentId,
         PIPELINE_TICKET_ID: input.ticketId,
         PIPELINE_KIND: input.kind,
       },
     },
   });
   ```

   **`includePartialMessages: true` is load-bearing for stall detection.** Without it, the SDK only emits `tool_use` at start and `tool_result` at end of a long bash call — silence between them can easily exceed the soft stall threshold for a legitimate test-suite run. With the flag enabled, the SDK emits `stream_event` (`SDKPartialAssistantMessage`) for assistant text deltas AND the CLI emits `tool_progress` (`SDKToolProgressMessage`) periodically during long-running tool calls, both of which update `lastMessageAt` and prevent false soft-stalls. SessionManager uses the same flag (`session-manager.ts`) for the same reason.

   **Cost implications:** the flag has **no token-cost impact** — partial messages are SDK-side fan-out of already-counted assistant/tool events, not new billed inference. The cost surface is **memory**: each stream event becomes one entry in `job.messages`, so a 30-min implementer can buffer tens of thousands of entries (estimated tens of MB per job). With a 24h `jobTtlMs` and even 10 retained jobs, the orchestrator's RSS climbs noticeably. Acceptable for v1 single-operator usage; multi-tenant operation would need eviction-on-completion or buffer-truncation, which is deferred.

   **`permissionMode: "bypassPermissions"` and the strict guardian both apply.** `bypassPermissions` disables the SDK's interactive permission UI (no operator is connected to confirm via WS); `PreToolUse` hooks still execute and can return `permissionDecision: "deny"`, which is how the pipeline guardian enforces its allowlist. SessionManager uses the same combination for paired sessions and it works as intended — the bypass affects only the SDK's built-in UI, not hook callbacks.
4. **Spawn a background message-loop task** (not awaited by `spawn()`):
   ```ts
   void this.consumeMessages(job, activeQuery);
   ```
   The job is registered in the orchestrator's job map and `spawn()` returns immediately with the job descriptor.
5. **`consumeMessages` loop** drains the SDKMessage iterator inside a `try`/`catch`/`finally`. **State transitions are one-way and idempotent — once a terminal state is set, subsequent transition attempts are no-ops** (the orchestrator logs them but does not change `job.state`). This resolves races between cancel-induced iterator-throws, sentinel-handler explicit transitions, and the finally block's safety net.

   - **`try` body** — `for await (const msg of activeQuery)`:
     - On every message: append to `job.messages`, update `job.lastMessageAt`. If `softWarnedAt` is set, record receipt (so the next stall-scan crossing earns a fresh warning).
     - On `assistant` messages: content-match against the open-questions sentinel; if matched → set `job._terminalReason = "stalled-open-questions"`, call `cancel(agentId)`, post the question list to Linear as a `block:human` comment.
     - On `result` messages: set `job._terminalReason = "completed"`, capture the result.
     - On error-typed `SDKMessage`: set `job._terminalReason = "error"`, log diagnostics, post Linear comment.
   - **`catch` block** — handles iterator throws (network drop, SDK bug, killed subprocess, cancel-triggered interrupt). If `job._terminalReason` is already set (e.g., sentinel handler set it before calling `cancel`), preserve it. Otherwise set `job._terminalReason = "error"` (or `"interrupted"` if the throw was caused by an explicit `cancel` call — the orchestrator tracks a `cancelRequested` flag), log the exception, and for genuine errors post a Linear comment summarizing the failure (`pipeline-tick: subagent <agentId> errored mid-stream: <message>; ticket flagged for human review`) + add `block:human` label.
   - **`finally` block** — single canonical state-assignment site. Reads `job._terminalReason` and sets `job.state` accordingly (the only writer to the terminal state). Translates: `"completed"` → `state: "completed"`, `"error"` → `state: "error"`, `"interrupted"` → `state: "interrupted"`, `"stalled-open-questions"` or `"stalled-timeout"` → `state: "stalled"`. Removes the job from the active-jobs map (so stall scanning skips it); the job descriptor itself stays in the orchestrator's map for `GET /admin/pipeline/jobs/:id` until TTL eviction.

### Stall detection (two-tier: warn, then cancel)

Stall detection is **liveness-checking**, not work-cancelling-by-default. The risk we're managing: a legitimately long-running implementer (e.g., running a test suite that takes 10+ minutes between `tool_use` and `tool_result`) must NOT be cancelled prematurely. The risk we're not managing: an actually-stuck subagent that hangs forever.

**`lastMessageAt` updates on every SDK message received** — `system/init`, `stream_event` (text deltas + content-block events from `includePartialMessages: true`), `tool_use`, `tool_progress` (CLI's periodic emission during long tool calls), `tool_result`, `assistant`, `result`. This is the finest granularity the SDK exposes; updating on every message means even silent long bash calls register as live (via `tool_progress`), and partial assistant text registers as live well before the full `assistant` message lands.

A single per-orchestrator interval (every 30s) iterates active jobs and applies a two-tier policy:

- **Soft tier (warn).** If `now - lastMessageAt > softThreshold`, post a Linear comment: `pipeline-tick: subagent <agentId> has been quiet for <X>min, monitoring`. Do NOT cancel; do NOT add `block:human`. Idempotent rule: track a per-job `softWarnedAt` timestamp; emit a warning only when (a) `softWarnedAt` is unset OR (b) at least one fresh message arrived since `softWarnedAt` was set (resetting the silence period). This means each *fresh* quiet period earns one warning — a flapping subagent that occasionally emits a heartbeat doesn't suppress warnings forever, but a continuously-silent subagent doesn't spam comments either.
- **Hard tier (cancel).** If `now - lastMessageAt > hardThreshold` (always > softThreshold), cancel: `cancel(agentId)`, set `job.state = "stalled"`, post Linear comment: `pipeline-tick: subagent <agentId> stalled (no messages for <X>min); cancelling and flagging block:human`, add `block:human` label.

Per-kind thresholds (configurable):

| Kind          | Soft  | Hard  | Reasoning                                                  |
|---------------|-------|-------|------------------------------------------------------------|
| `draft-spec`  | 5 min | 15 min | Drafters produce text continuously; gaps are unusual      |
| `draft-plan`  | 5 min | 15 min | Same as draft-spec                                         |
| `code-review` | 5 min | 15 min | Reviewers also produce text continuously                   |
| `implementer` | 10 min | 30 min | Implementers run tests, builds, npm installs — sparse SDK traffic during long tool calls |

Override via `pipeline.orchestrator.stallThresholds.<kind>.{soft,hard}` in `beekeeper.yaml`. Defaults can be tuned post-launch from observed run durations; the two-tier model means a wrong-by-50% threshold produces a benign warning, not a destroyed run.

### IPC: admin HTTP endpoints

The CLI talks to the server over loopback HTTP. Three new endpoints, all gated by `Bearer ${BEEKEEPER_ADMIN_SECRET}` (existing admin auth):

```
POST /admin/pipeline/jobs
  Body: { kind, prompt, repoPath, ticketId }
  Response: 202 { agentId, status: "started", ticketId, startedAt }
            409 { error: "ticket-busy", existingAgentId }  // concurrent-spawn guard, see below
  Semantics: orchestrator.spawn() — returns immediately on success.

GET /admin/pipeline/jobs/:agentId
  Response: 200 { ...PipelineJob, messages: [...] }  // full job state + buffered messages
           404 if agentId unknown (or evicted post-TTL)
  Semantics: orchestrator.get() — for live-tail (poll-based for v1; full buffer per response).

POST /admin/pipeline/jobs/:agentId/cancel
  Response: 200 { agentId, state: "interrupted" }
           404 if unknown
  Semantics: orchestrator.cancel() — fires query.interrupt().
```

Loopback-only is enforced the same way `/internal/register-capability` is today (origin check + admin secret). The CLI runs on the same machine as the server (operator's Mac Mini); no remote access.

**Concurrent-spawn guard.** `POST /admin/pipeline/jobs` checks `orchestrator.getActiveByTicket(ticketId)` first. If a job is already `running` for that ticketId, returns 409 Conflict with the existing agentId. This is defense-in-depth: the Linear comment-based mutex (`mutex.ts`) is the primary serialization mechanism, but if a bug or operator action POSTs twice for the same ticket, the orchestrator refuses cleanly rather than running two subagents in the same repo path.

**Why HTTP and not WebSocket:** request-response semantics fit the CLI's one-shot invocation pattern. Live-tail via polling is "good enough" for v1 — a 1s poll cadence is fine for human consumption. The `GET` endpoint returns the full message buffer per request (no cursor); cursor-based incremental fetch and SSE/WS streaming are the natural upgrade if/when polling-buffer-size becomes a problem (a 30-minute implementer might buffer thousands of messages — several MB per poll, which is fine on loopback for v1).

### CLI thin client

`subagent-spawn.ts` is rewritten to POST to the orchestrator instead of spawning `claude -p`:

```ts
export async function spawnSubagent(input: SpawnInput): Promise<SpawnResult> {
  const response = await fetch(`http://localhost:${config.port}/admin/pipeline/jobs`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.BEEKEEPER_ADMIN_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  if (response.status === 502 || response.status === 503 || /* connection refused */ ...) {
    throw new BeekeeperServerNotRunningError(
      "Pipeline-tick requires Beekeeper server to be running. " +
      "Start it via the LaunchAgent (already configured on your Mac) " +
      "or `beekeeper serve` for foreground operation.",
    );
  }
  if (!response.ok) throw new Error(`Spawn failed: ${response.status} ${await response.text()}`);
  return await response.json(); // { agentId, status: "started" }
}
```

A new CLI command `pipeline-tick tail <agentId>` polls `GET /admin/pipeline/jobs/:agentId` at 1s cadence and renders the streaming message buffer to stdout. `pipeline-tick cancel <agentId>` POSTs the cancel endpoint.

### Server-not-running diagnostic

The CLI's failure mode when Beekeeper isn't running must be loud and actionable. The fetch fails with `ECONNREFUSED` (the OS-level rejection); the CLI catches it and prints:

```
Error: Cannot reach Beekeeper server at http://localhost:<port>.

Pipeline-tick Phase 2 runs orchestration in-server. Start the server first:
  - On your Mac (LaunchAgent installed): `launchctl kickstart -k gui/$(id -u)/com.keepur.beekeeper`
  - Foreground/dev: `beekeeper serve`

Once running, retry your command.
```

No silent fallback to Phase 1's detached spawn — that's the failure mode we're explicitly leaving behind.

### Open-questions content-match

The `consumeMessages` loop watches assistant text for a sentinel pattern. Drafting subagents already commit to a structured "open questions" output per the Phase 1 spec; we formalize the sentinel:

```
=== OPEN QUESTIONS (BLOCK:HUMAN) ===
1. <question>
2. <question>
=== END OPEN QUESTIONS ===
```

When the orchestrator detects the opening sentinel in streamed assistant text:
1. Buffer subsequent text until the closing sentinel.
2. `cancel(agentId)` — the subagent has flagged a block; no further useful work.
3. Post a Linear comment with the question list (formatted as numbered items per the Phase 1 unblock contract).
4. Add `block:human` label to the ticket.
5. Set `job.state = "stalled"`.

This is a v1 implementation. Plan stage may evolve the sentinel format (e.g., to a structured tool call).

### Job state lifecycle

Transitions are written **only by `consumeMessages`'s finally block**, reading the `_terminalReason` field. Handlers (sentinel-match, AskUserQuestion-trap, hard-stall timeout) set `_terminalReason` but never write `state` directly. Once a terminal state is set, subsequent transition attempts are no-ops (logged but not applied). This is the one-way state-assignment discipline that prevents races between explicit handler-triggered transitions and the cancel-induced iterator-throw path.

```
running --[_terminalReason="completed"]--> completed
running --[_terminalReason="error"]--> error
running --[_terminalReason="interrupted"]--> interrupted
running --[_terminalReason="stalled-open-questions" | "stalled-timeout"]--> stalled
```

`completed`, `error`, `interrupted`, `stalled` are all terminal — the job stays in the orchestrator's map for `GET /admin/pipeline/jobs/:agentId` to serve, with a TTL (24h, configurable) before it's evicted to free memory.

### Server restart behavior

The orchestrator's job map is in-memory. **On Beekeeper server restart, all in-flight jobs are lost.** This is a real backward-compat regression from Phase 1 (where detached children survived a Beekeeper restart). Without active recovery, the lost ticket sits in its pre-restart state forever — Phase 1's decision handlers (`src/pipeline/handlers/review.ts:43-46`) treat "In Progress + no PR" as "skipped: in progress, no PR attached yet" (wait), which is the correct call when a subagent is genuinely working but the *wrong* call when the subagent is dead. The orchestrator must surface the loss explicitly because Phase 1's decision matrix has no "subagent disappeared" branch.

**Startup recovery routine** (in scope for this work):

On Beekeeper boot, after the orchestrator's HTTP endpoints are wired but before the first incoming request, run a one-time recovery scan:

1. Query Linear (via `linear-client.ts`) for issues on the configured team that have a `tick-spawn-log: runId=... agentId=... kind=...` comment posted within the last 24h. (24h matches the orchestrator's job TTL.)
2. For each such ticket: parse the agentId AND kind from the most recent `tick-spawn-log`. Note the spawn-log timestamp. Check `orchestrator.get(agentId)` — since the orchestrator just started, this will return `null` for ALL pre-restart agentIds.
3. Check whether a **kind-specific subagent-completion signal** exists on the ticket *after* the spawn-log timestamp. The Phase 1 `tick-lock-release` comment is NOT a completion signal — it fires within ms of `tick-spawn-log` and proves only that the calling tick exited cleanly, not that the subagent finished. Use these instead:
   - **`kind=draft-spec` or `kind=draft-plan`:** a comment containing the open-questions sentinel (`=== OPEN QUESTIONS (BLOCK:HUMAN) ===`), OR a state transition off the drafting state (Spec Drafting → Plan Drafting / Spec Drafting → Done / Plan Drafting → Ready), OR any `block:*` label set after the spawn-log.
   - **`kind=code-review`:** a comment matching the reviewer JSON verdict block (`REVIEWER_OUTPUT_HEAD` regex — same one Phase 1's `handlers/review.ts` uses).
   - **`kind=implementer`:** a PR attachment created after the spawn-log timestamp, OR a state transition out of "In Progress" set after the spawn-log.
   - **Universal fallback:** any `block:*` label, or a comment with the `pipeline-tick: subagent <agentId> was lost` self-write sentinel (covers idempotent re-scan).
4. **Idempotency guard:** also skip if the ticket already has a `pipeline-tick: subagent <agentId> was lost` comment posted by a prior recovery scan for this same agentId. This makes the scan safe to re-run (e.g., during a debug cycle that restarts Beekeeper repeatedly) without spamming `block:human` posts.
5. Otherwise: post a Linear comment (`pipeline-tick: subagent <agentId> was lost in a Beekeeper server restart at <timestamp>; ticket marked block:human for operator review.`) and add the `block:human` label.

The scan reads attachments in addition to comments (PR detection for the implementer kind), and uses post-spawn-log timestamp ordering throughout. **Type extension required:** `TicketAttachment` (in `src/pipeline/types.ts`) currently captures `{ id, url, title? }` and discards `createdAt`. This work extends the type with `createdAt: string` and updates `linear-client.ts:getTicketState` to populate it (`a.createdAt.toISOString()`). Without this, the implementer-kind PR-attachment detection couldn't distinguish "PR attached after this spawn" from "PR attached before this spawn" (a re-implementation cycle on a re-opened PR would falsely register as completion).

**Single-instance assumption:** recovery is safe because the LaunchAgent enforces one Beekeeper process at a time on the operator's machine, and operators running `beekeeper serve` in foreground for dev are responsible for not concurrently invoking the LaunchAgent. The step-4 idempotency guard is the primary defense against duplicate-scan side effects in the rare case where two processes overlap briefly during a manual restart.

This gives:
- `GET /admin/pipeline/jobs/:agentId` returns 404 for pre-restart agentIds (no resurrection — the orchestrator has no record).
- Operator-visible signal on every ticket affected, via Linear notifications and the next tick's "blocked" output.
- No silent loss; no relying on Phase 1 decision logic that doesn't exist.

The startup scan is bounded (24h spawn-log window, single team), idempotent (re-running it on a clean instance is a no-op), and runs independent of any tick — operator doesn't need to invoke pipeline-tick to get recovery.

### Backward compat with Linear comment audit trail

Lock-claim, spawn-log, lock-release writes (today done by the calling tick code) are unchanged. The orchestrator does NOT take over those writes. The tick continues to:
- Write `tick-lock-claim` before calling `orchestrator.spawn()`.
- Write `tick-spawn-log` after `spawn()` returns with the agentId.
- Write `tick-lock-release` after the spawn-decision is made (the lock covers the spawn-call duration, not the subagent's work).

The orchestrator additionally writes:
- `block:human` comments on stall / open-questions / `AskUserQuestion`-trap (these are NEW; not in Phase 1 because Phase 1 had no liveness signal).

### Configuration additions to `beekeeper.yaml`

```yaml
pipeline:
  # Existing keys unchanged
  linearTeamKey: KPR
  repoPaths:
    hive: ~/github/hive
    beekeeper: ~/github/beekeeper
  mainBranch: main
  # NEW (Phase 2):
  orchestrator:
    stallThresholds:
      drafting:    { soft: 300000,  hard: 900000  }   # 5 min / 15 min
      review:      { soft: 300000,  hard: 900000  }   # 5 min / 15 min
      implementer: { soft: 600000,  hard: 1800000 }   # 10 min / 30 min
    pipelineModel:
      drafting: claude-opus-4-7
      review: claude-opus-4-7
      implementer: claude-sonnet-4-6
    bashAllowlist:                     # patterns matched against the full bash command string (raw form, before shell parsing)
      # GitHub CLI (PR/issue/repo/api/workflow management)
      - "^gh (issue|pr|repo|api|workflow|auth status|run) "
      # Git (read + standard mutate; force-push and history-rewriting deliberately excluded)
      - "^git (status|diff|log|show|add|commit|push|fetch|pull|rebase|merge|checkout|switch|branch|worktree|stash|tag|remote|reset --soft|cherry-pick) "
      # npm / npx (build, test, lint, format)
      - "^npm (run|install|ci|test|version|pack) "
      - "^npx (tsc|vitest|eslint|prettier|tsx|@anthropic-ai) "
      # Node + filesystem reads
      - "^node "
      - "^cat "
      - "^ls "
      - "^pwd"
      - "^which "
      - "^find "
      # Filesystem mutate (scoped — plan stage will tighten the path-anchoring on these)
      - "^mkdir "
      - "^cp "
      - "^mv "
      - "^chmod "                      # required for npm setup steps creating executables, test fixture mode fixes
      # Keychain reads (Honeypot)
      - "^security find-generic-password "
      # MongoDB CLI (read-mostly; mutations TBD per kind)
      - "^mongosh "
      - "^mongo "
    jobTtlMs: 86400000                 # 24h — completed/errored job retention before eviction
```

**Allowlist rubric:** patterns must match a known pipeline operation (drafting, plan-writing, code-review, implementation work observed in Phase 1 dogfood runs). Anything outside the allowlist is denied AND logged with the agentId + the rejected command, so post-launch instrumentation produces the data needed to add legitimate misses without operator-tuning blindness. The list above is an initial commit; OQ #3 below covers post-launch tuning.

**Explicit denials (rationale):**
- **`rm`, `rmdir`** — denied by default. Worktree cleanup is the only legitimate need we've observed, and that runs from the orchestrator process (or `git worktree remove`), not from inside the subagent. If a subagent needs to delete files, route through `git rm` (allowlisted) so the deletion is tracked.
- **`curl`, `wget`, `tar`, `unzip`** — denied. Pipeline subagents should not be fetching arbitrary network artifacts; if a legitimate use surfaces (e.g., downloading a known release tarball), route through `gh` (allowlisted) or a wrapper rather than opening the door.
- **`chmod +s` or any setuid/setgid mode change** — denied even though `chmod ` is allowlisted. Plan stage should anchor `chmod` to numeric or `[ugo][+-=][rwx]` mode args, rejecting `+s` / `g+s` / `4xxx` / `2xxx` patterns.
- **`pnpm`, `yarn`** — denied unless added by post-launch tuning. Hive standardizes on npm; Beekeeper does too. The rubric says "matches a known pipeline operation"; non-npm package managers are not currently a known operation.
- **Compound commands with shell redirection / pipes** — the regex prefix model matches against the raw command string, so `npm run build 2>&1 | tee build.log` matches `^npm run` but the trailing `| tee` is part of the same string. Plan stage should decide: either (a) anchor the regex to disallow ` | ` / ` > ` / ` 2>` etc. by appending a negative-lookahead to each allowlist pattern, or (b) parse and validate each pipeline segment independently against the allowlist. Lean: (a) for v1 simplicity (most subagent operations don't pipe).

**Phase 1 path removed in this work.** No `enabled` flag, no fallback to `claude -p` detached spawn. If the in-server orchestrator hits a bug, the response is to fix the bug, not to flip back to a code path that has the very observability gaps this work exists to close. Two-code-paths-with-flag is maintenance burden for negligible insurance value given the single-operator setup. Plan stage deletes `subagent-spawn.ts`'s detached-spawn body and replaces it with the HTTP client.

**Linear-client retry (small scope addition):** today's `linear-client.ts:addComment` throws on any non-success response. The orchestrator needs at least basic resilience for stall-warning and `block:human` writes (otherwise a transient Linear API blip silently drops a recovery signal). Plan stage adds one-retry-with-backoff to `addComment` (e.g., 1s delay on first failure, then propagate). This benefits Phase 1 tick code too, but the change is required by Phase 2's reliance on those writes.

## Acceptance criteria

- [ ] `PipelineOrchestrator` module exists at `src/pipeline/orchestrator/` with `spawn`/`cancel`/`get`/`getActiveByTicket`/`listActive` public API
- [ ] `spawn()` invokes SDK `query()` in-process and returns immediately with `{ agentId, status: "started" }`
- [ ] Every SDKMessage from the iterator (init, stream events, tool_use, tool_result, assistant, result) is buffered into the per-job message list with timestamp; `lastMessageAt` is updated on every message
- [ ] Pipeline-tightened `ToolGuardian` enforces a strict bash allowlist via `PreToolUse` hook (`permissionMode: bypassPermissions` does not defeat the hook); guardian rejections are logged for post-launch tuning
- [ ] `AskUserQuestion` hook traps the question, transitions job to `stalled`, posts to Linear as `block:human`, interrupts the query
- [ ] Two-tier stall detection: soft threshold posts a warning Linear comment (idempotent per crossing); hard threshold cancels the query, sets `job.state = "stalled"`, posts a `block:human` comment, applies the `block:human` label
- [ ] Open-questions sentinel match in streamed assistant text triggers cancel + Linear comment + `block:human` label
- [ ] `POST /admin/pipeline/jobs` returns 202 with agentId; `GET /admin/pipeline/jobs/:id` returns full job state + message buffer; `POST /admin/pipeline/jobs/:id/cancel` interrupts; all three Bearer-admin-auth gated
- [ ] CLI `subagent-spawn.ts` POSTs to the orchestrator instead of spawning `claude -p`; clear error if server unreachable
- [ ] CLI `pipeline-tick tail <agentId>` and `pipeline-tick cancel <agentId>` work end-to-end
- [ ] Phase 1's detached `claude -p` spawn body in `subagent-spawn.ts` is removed (replaced by the HTTP client to the orchestrator)
- [ ] Linear comment audit trail (lock-claim, spawn-log, lock-release) unchanged from Phase 1; the orchestrator's stall-warning and `block:human` writes go through `linear-client.ts`, which is upgraded in this work to wrap `addComment` with one-retry-with-backoff (transient-failure resilience required by the recovery paths)
- [ ] Startup recovery: on Beekeeper boot, scan recent `tick-spawn-log` comments (last 24h on the configured team); for any agentId not in the orchestrator's job map AND no kind-specific completion signal after the spawn-log timestamp (drafting → open-questions sentinel comment OR drafting-state→next-state transition OR post-spawn `block:*` label; code-review → reviewer JSON verdict block matching `REVIEWER_OUTPUT_HEAD`; implementer → PR attachment OR state-out-of-In-Progress; universal fallback → `block:*` label or prior `pipeline-tick: subagent <agentId> was lost` self-write), post a Linear comment + add `block:human` label. Idempotency guard: skip if a prior `was lost` self-write for this agentId exists.
- [ ] State transitions are one-way: terminal-state assignment happens only in `consumeMessages`'s finally block, reading a `_terminalReason` flag; sentinel/AskUserQuestion/timeout handlers set the reason but do not write `state` directly
- [ ] Iterator-throw recovery: SDK iterator throwing mid-stream sets `job.state = "error"`, posts a Linear comment, and applies `block:human` (not silent failure)
- [ ] Concurrent-spawn guard: `POST /admin/pipeline/jobs` for a `ticketId` that already has a `running` job returns 409 Conflict (defense-in-depth alongside the comment-mutex)
- [ ] Tests: vitest, mocked SDK `query()`, cover spawn → message-stream → completed and the failure paths: stalled-soft (warn-only), stalled-hard (cancel + block:human), sentinel-match, AskUserQuestion-trap, iterator-throw, cancel-from-CLI, concurrent-spawn-409

## Coordination with sibling tickets

- **KPR-90** (pipeline-tick Phase 1) — what Phase 2 sits on top of. Phase 2 reuses Phase 1's CLI surface, ticket-resolution logic, lock-claim/spawn-log conventions, and decision matrix. Only the spawn driver changes (and its observability companions).
- **KPR-94, KPR-95** — sibling fixes from the dogfood session that surfaced this work. Both already shipped.
- **KPR-79** (engine team-API) — independent; no coupling.

## Open design questions

1. **Open-questions sentinel format.** Plain-text fence (proposed in the Design section) or a structured tool-call (a hypothetical `pipeline_block_with_questions` tool the subagent invokes)? Plain text is implementable today with no SDK changes; structured tool-call is more robust to subagent prose drift but requires defining a custom tool that the subagent's prompt teaches it to use. Lean: **plain-text fence for v1**, revisit if drift becomes an issue. The sentinel literal (`=== OPEN QUESTIONS (BLOCK:HUMAN) ===` / `=== END OPEN QUESTIONS ===`) is also up for naming-bikeshed if a more memorable convention surfaces.

2. **Live-tail upgrade path.** v1 commits to polling `GET /admin/pipeline/jobs/:id` at 1s cadence with full-buffer responses. SSE or WebSocket would give true streaming with lower latency and incremental delivery. Lean: **poll for v1**, SSE/WS as a follow-up if the latency or buffer size hurts in practice. The decision is genuinely deferred — observed friction will inform the call.

3. **Tuning the stall thresholds and the bash allowlist post-launch.** The defaults in this spec are best-guesses from one dogfood session. Both will need empirical tuning. Specifically: (a) what soft/hard thresholds match real implementer test-suite runtimes? (b) which bash commands legitimately fall outside `gh|git|npm run|mongo|security` and need to be added? Lean: **ship the defaults, log every guardian rejection and stall-warn event, review weekly for the first few weeks**, tune the config from observed data. This is more an operational followup than a design-spec question, but flagged so plan-stage knows to instrument the rejection-logging.

## Path to implementation

Once spec is review-clean → KPR-96 advances to Plan Drafting. Plan covers:

1. `PipelineOrchestrator` module: types, job map, `spawn`/`cancel`/`get`/`getActiveByTicket`/`listActive` (~170 LOC + tests)
2. `consumeMessages` loop with one-way terminal-state assignment in finally: SDK iterator drain, `lastMessageAt` update on every message (incl. `stream_event`/`tool_progress` from `includePartialMessages: true`), sentinel content-match, `_terminalReason` plumbing (~100 LOC + tests)
3. Pipeline-tightened `ToolGuardian` variant + allowlist config + rejection-logging (~70 LOC + tests)
4. `AskUserQuestion`-trap hook (~30 LOC + tests)
5. Two-tier stall-detection interval + soft/hard Linear comment posting + idempotent `softWarnedAt` (~60 LOC + tests)
6. Linear-client retry: wrap `addComment` with one-retry-with-backoff in `linear-client.ts` (~20 LOC + tests, benefits Phase 1 tick code too)
7. Startup recovery routine: scan recent `tick-spawn-log` comments, post `block:human` for orphans (~80 LOC + tests)
8. Three admin HTTP endpoints (POST /jobs, GET /jobs/:id, POST /jobs/:id/cancel) including 409 concurrent-spawn guard (~90 LOC + tests)
9. CLI `subagent-spawn.ts` rewrite to fetch-based client; delete the `claude -p` detached-spawn body; server-not-running diagnostic (~50 LOC + tests)
10. CLI `pipeline-tick tail <agentId>` + `pipeline-tick cancel <agentId>` (~70 LOC + tests)
11. Config schema updates in `beekeeper.yaml` parser (~20 LOC + tests)
12. End-to-end smoke test: spawn a real (mocked-SDK) subagent through the orchestrator; verify happy path + the failure paths (stalled-soft, stalled-hard, sentinel, AskUserQuestion-trap, iterator-throw, cancel, concurrent-spawn-409, startup-recovery)

Estimated 3-4 days of focused work after plan-clean.
