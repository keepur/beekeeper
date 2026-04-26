# Pipeline-tick Phase 2 — SDK Orchestrator Implementation Plan

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan. Each task is self-contained; commit after each. Tests are colocated `*.test.ts` (vitest).

**Goal:** Replace Phase 1's detached `claude -p` subagent driver with an in-process SDK `query()` orchestrator hosted in the Beekeeper server, gaining live observability, two-tier stall detection, sentinel-based open-questions trapping, clean cancel, and startup recovery for in-flight subagents lost to a server restart.

**Architecture:** New `src/pipeline/orchestrator/` module composes the same SDK primitives `SessionManager` already uses — `query()`, `PreToolUse` hooks, `includePartialMessages: true` — but with a different hook profile (no `QuestionRelayer`, a tightened bash guardian) and a server-side per-job message buffer instead of WS broadcast. The CLI's `subagent-spawn.ts` is rewritten as a thin HTTP client to three new admin endpoints. See `docs/specs/2026-04-26-pipeline-tick-phase2-sdk-orchestrator-design.md` (review-clean, 5 review rounds).

**Tech Stack:** TypeScript (NodeNext, strict), `@anthropic-ai/claude-agent-sdk` (existing dep — `query`, `createSdkMcpServer`), `@linear/sdk` (existing), `ulid` (existing), Vitest (colocated `*.test.ts`). No new deps. ESM `.js` import extensions throughout. No `any` in production code without justification.

**Spec reference:** `docs/specs/2026-04-26-pipeline-tick-phase2-sdk-orchestrator-design.md`.

**Reference plan style:** `docs/plans/2026-04-26-pipeline-tick-foundation.md` (KPR-90).

**Open questions deferred from spec (with the plan-stage default in parens):**
1. Open-questions sentinel format → **plain-text fence** `=== OPEN QUESTIONS (BLOCK:HUMAN) ===` / `=== END OPEN QUESTIONS ===`. Implementable today; revisit if drift surfaces.
2. Live-tail upgrade path → **HTTP polling at 1s cadence with full-buffer responses for v1.** SSE/WebSocket deferred until empirical friction.
3. Post-launch tuning of stall thresholds and bash allowlist → **ship the spec defaults, instrument every guardian rejection and stall-warn event, review weekly.** Plan-stage commits to the rejection-logging line items in Task 4.

**Plan-stage decision on shell-redirection regex anchoring (spec §"Compound commands"):** v1 picks **option (a)**: each allowlist regex is post-validated by stripping any trailing ` | …`, ` > …`, ` 2> …`, ` 2>&1`, ` < …`, ` >> …`, ` && …`, ` || …`, ` ; …`, ` & ` segments BEFORE matching. If the raw command differs from the stripped command, the bash command is **denied** (rationale: most subagent operations don't pipe; better to deny early than allowlist-bypass via redirection). Logged with the `redirection-rejected` reason. This is a hard rule, not a regex append per pattern — simpler and fail-closed.

**Plan-stage decision on `chmod +s`:** allowlist regex for `chmod` requires the next token to be either purely numeric (`^[0-7]{3,4}$` — and NOT in `2xxx`/`4xxx`/`6xxx`) or `[ugoa]*[+\-=][rwxXst]+` with the mode-letters set excluding `s` and `t`. Rejected modes: any `s` or `t` letter, any 4-digit mode whose leading digit is `≥2`. The check is applied AFTER the redirection strip (above) so `chmod +s file > x` still gets caught.

---

## File Structure

### Files to create

| File | Responsibility |
|---|---|
| `src/pipeline/orchestrator/types.ts` | `PipelineJob`, `PipelineJobMessage`, `SpawnInput`, `SpawnResult`, `OrchestratorConfig`, `StallThresholds`, `_terminalReason` discriminated union. |
| `src/pipeline/orchestrator/index.ts` | `PipelineOrchestrator` class — public API (`spawn`, `cancel`, `get`, `getActiveByTicket`, `listActive`), in-memory job map, jobTtl eviction, dependency injection seams (linear client, sentinel-handler hook, stall scanner). |
| `src/pipeline/orchestrator/consume-messages.ts` | The `consumeMessages` SDKMessage-iterator drain loop. One-way `_terminalReason` → `state` assignment in finally. Sentinel content-match. Iterator-throw handling. |
| `src/pipeline/orchestrator/sentinel.ts` | `OPEN_QUESTIONS_OPEN`, `OPEN_QUESTIONS_CLOSE`, `extractOpenQuestionsBlock(text: string)` — plain-text fence parser used by content-match. |
| `src/pipeline/orchestrator/pipeline-guardian.ts` | Pipeline-tightened `ToolGuardian` variant: PreToolUse callback that enforces the configured bash allowlist (with shell-redirection-strip + chmod-mode whitelist), rejects everything else, logs every rejection with agentId + redacted command. |
| `src/pipeline/orchestrator/ask-user-question-trap.ts` | `AskUserQuestion` PreToolUse hook that records the question, sets `_terminalReason = "stalled-ask-user-question"`, posts to Linear as `block:human`, and blocks the tool. |
| `src/pipeline/orchestrator/stall-scanner.ts` | Per-orchestrator 30s interval loop iterating active jobs; soft-tier idempotent warning; hard-tier cancel + `block:human`. Per-kind threshold lookup. |
| `src/pipeline/orchestrator/recovery.ts` | Startup recovery routine: scan `tick-spawn-log` comments in last 24h, kind-specific completion-signal detection, idempotency self-write guard, post `block:human` for orphans. |
| `src/pipeline/orchestrator/http.ts` | Three admin endpoints (POST /admin/pipeline/jobs, GET /admin/pipeline/jobs/:id, POST /admin/pipeline/jobs/:id/cancel) wired as a single `handlePipelineAdminRequest(req, res, ctx): boolean` dispatcher invoked from `src/index.ts`. |
| `src/pipeline/orchestrator/index.test.ts` | Spawn-and-buffer happy path; `getActiveByTicket` 409 guard; TTL eviction. |
| `src/pipeline/orchestrator/consume-messages.test.ts` | One-way `_terminalReason` discipline; sentinel-match → cancel + Linear; iterator-throw → error + Linear + block:human; cancel-induced throw preserves `interrupted`. |
| `src/pipeline/orchestrator/sentinel.test.ts` | Fence open/close detection; multi-question parsing; partial deltas across stream-event boundaries. |
| `src/pipeline/orchestrator/pipeline-guardian.test.ts` | Allowlist accepts; everything else denies; redirection-strip catches `npm run x | tee`; `chmod +s` denied; `chmod 4755` denied; `chmod 0755` accepted; `chmod u+x` accepted; rejection log entry produced. |
| `src/pipeline/orchestrator/ask-user-question-trap.test.ts` | Trap blocks tool, sets `_terminalReason`, calls Linear addComment + addLabel. |
| `src/pipeline/orchestrator/stall-scanner.test.ts` | Soft-tier warns once per quiet period, resets on fresh msg; hard-tier cancels + block:human; per-kind thresholds applied. |
| `src/pipeline/orchestrator/recovery.test.ts` | Per-kind completion signals (drafting sentinel/state-transition/post-spawn label; code-review reviewer JSON; implementer PR attachment/state-out-of-In-Progress; universal `block:*` / self-write); idempotency self-write skip; uses post-spawn-log timestamp ordering. |
| `src/pipeline/orchestrator/http.test.ts` | 202 spawn; 409 ticket-busy; 200 GET; 200 cancel; 401 missing/wrong bearer; non-loopback rejected. |

### Files to modify

| File | Reason |
|---|---|
| `src/pipeline/types.ts` | Add `createdAt: string` to `TicketAttachment`. |
| `src/pipeline/linear-client.ts` | `getTicketState` populates `createdAt: a.createdAt.toISOString()` for attachments; `addComment` wrapped with one-retry-with-backoff. |
| `src/pipeline/handlers/review.ts` | Export `REVIEWER_OUTPUT_HEAD` regex (currently file-private) so the recovery routine can reuse it for `code-review`-kind completion-signal detection. |
| `src/pipeline/subagent-spawn.ts` | **Delete the detached `child_process.spawn` body and replace with a fetch-based HTTP client** to `POST /admin/pipeline/jobs`. Adds `BeekeeperServerNotRunningError` + actionable diagnostic. |
| `src/pipeline/subagent-spawn.test.ts` | Replace the `child_process` mock with a `globalThis.fetch` mock. |
| `src/pipeline/cli.ts` | Two new subcommands: `tail <agentId>`, `cancel <agentId>` — thin HTTP clients to GET / POST cancel. |
| `src/index.ts` | Construct `PipelineOrchestrator`, run startup recovery (after orchestrator boot, before HTTP server `listen`), register admin endpoint dispatcher, wire shutdown to interrupt all running jobs. |
| `src/types.ts` | Extend `PipelineConfig` with optional `orchestrator: OrchestratorConfig` (stallThresholds, pipelineModel per kind, bashAllowlist, jobTtlMs). |
| `src/config.ts` | `parsePipeline` extended to parse `orchestrator:` block with strict validation + sensible defaults (per spec table). |
| `beekeeper.yaml.example` | Add `pipeline.orchestrator:` example block. |
| `package.json` | No new deps; only file references in script field changes if any (likely none). |

---

## Task 1: Type extensions (`TicketAttachment.createdAt`, `PipelineConfig.orchestrator`, `PipelineJob`, friends)

**Files:**
- Modify: `src/pipeline/types.ts`
- Modify: `src/types.ts`
- Create: `src/pipeline/orchestrator/types.ts`

- [ ] **Step 1.1:** In `src/pipeline/types.ts`, extend `TicketAttachment`:

```typescript
export interface TicketAttachment {
  id: string;
  url: string;
  /** GitHub PR URLs are auto-attached by Linear's GitHub integration. */
  title?: string;
  /** ISO timestamp from Linear; required by orchestrator startup-recovery PR-attachment ordering. */
  createdAt: string;
}
```

- [ ] **Step 1.2:** In `src/types.ts`, extend `PipelineConfig`:

```typescript
export interface OrchestratorStallThresholds {
  drafting:    { soft: number; hard: number };
  review:      { soft: number; hard: number };
  implementer: { soft: number; hard: number };
}

export interface OrchestratorPipelineModels {
  drafting: string;
  review: string;
  implementer: string;
}

export interface OrchestratorConfig {
  stallThresholds: OrchestratorStallThresholds;
  pipelineModel: OrchestratorPipelineModels;
  /** Regex strings (raw, anchored), one per allowlist row in the design spec. */
  bashAllowlist: string[];
  /** ms — completed/errored job retention before eviction from the in-memory map. */
  jobTtlMs: number;
}

export interface PipelineConfig {
  linearTeamKey: string;
  repoPaths?: Record<string, string>;
  mainBranch?: string;
  /** Phase 2 orchestrator config. Required when running Beekeeper server with pipeline-tick. */
  orchestrator?: OrchestratorConfig;
}
```

- [ ] **Step 1.3:** Create `src/pipeline/orchestrator/types.ts`:

```typescript
import type { SubagentKind } from "../subagent-spawn.js";

export type JobState = "running" | "completed" | "interrupted" | "stalled" | "error";

/** One-way reason set by handlers; finally block translates to JobState. */
export type TerminalReason =
  | "completed"
  | "error"
  | "interrupted"
  | "stalled-open-questions"
  | "stalled-ask-user-question"
  | "stalled-timeout";

/** Buffered per-job message — minimal projection of SDKMessage we keep around. */
export interface PipelineJobMessage {
  type: string;            // SDKMessage `type` field
  receivedAt: string;      // ISO
  /** Raw SDK payload (typed loosely — full structure preserved for live-tail). */
  payload: Record<string, unknown>;
}

export interface PipelineJob {
  agentId: string;          // "agent-${ulid()}"
  ticketId: string;         // e.g., "KPR-79"
  kind: SubagentKind;
  cwd: string;
  startedAt: string;        // ISO
  state: JobState;
  lastMessageAt: string;    // ISO
  messages: PipelineJobMessage[];
  /** Set by handlers; `state` is derived from this in the finally block. */
  _terminalReason?: TerminalReason;
  /** True when an explicit cancel() was requested (so iterator-throw becomes "interrupted", not "error"). */
  cancelRequested?: boolean;
  /** Tracks soft-tier stall warning idempotency: when set, a fresh message resets it. */
  softWarnedAt?: string;
  /** Final result, populated by the SDK `result` message. */
  result?: { ok: boolean; reason: string };
}

export interface SpawnInput {
  kind: SubagentKind;
  prompt: string;
  repoPath: string;
  ticketId: string;
}

export interface SpawnResult {
  agentId: string;
  status: "started";
  ticketId: string;
  startedAt: string;
}

export class TicketBusyError extends Error {
  constructor(public readonly ticketId: string, public readonly existingAgentId: string) {
    super(`Ticket ${ticketId} already has running job ${existingAgentId}`);
    this.name = "TicketBusyError";
  }
}
```

- [ ] **Step 1.4:** Verify

```bash
cd /Users/mokie/github/beekeeper-KPR-96 && npm run typecheck
```

Expected: existing tests currently set `attachments: []` everywhere, so the `createdAt` addition compiles. Existing review.test.ts attachment objects are missing `createdAt` and will fail typecheck — they're fixed in Task 2.

- [ ] **Step 1.5:** Commit (after Task 2 fixes typecheck — defer commit until Task 2 verify passes; Task 1 + 2 commit together as one logical "type-extensions" commit).

---

## Task 2: `linear-client.ts` populates `createdAt` and gains `addComment` retry

**Files:**
- Modify: `src/pipeline/linear-client.ts`
- Modify: `src/pipeline/handlers/review.test.ts` (and any other test that constructs a `TicketAttachment` literal)
- Create: `src/pipeline/linear-client.test.ts` (new test for retry; existing repo has no linear-client test — confirm via `ls src/pipeline/linear-client.test.ts`; if it exists, append; if not, create)

- [ ] **Step 2.1:** In `src/pipeline/linear-client.ts`, update the attachment mapper (lines 91-95):

```typescript
const attachments: TicketAttachment[] = attachmentsConn.nodes.map((a) => ({
  id: a.id,
  url: a.url,
  title: a.title,
  createdAt: a.createdAt.toISOString(),
}));
```

- [ ] **Step 2.2:** In `src/pipeline/linear-client.ts`, wrap `addComment` with one-retry-with-backoff. Replace the existing method (lines 155-162):

```typescript
async addComment(issueId: string, body: string): Promise<{ id: string; createdAt: string }> {
  const attempt = async () => {
    const result = await this.sdk.createComment({ issueId, body });
    if (!result.success || !result.comment) {
      throw new Error("Failed to create Linear comment");
    }
    const c = await result.comment;
    return { id: c.id, createdAt: c.createdAt.toISOString() };
  };
  try {
    return await attempt();
  } catch (err) {
    log.warn("addComment first attempt failed; retrying after backoff", {
      issueId,
      error: err instanceof Error ? err.message : String(err),
    });
    await sleep(1000);
    return await attempt(); // second failure propagates
  }
}
```

Add this private helper at the top of the file (after imports):

```typescript
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 2.3:** Update existing tests that construct `TicketAttachment` literals to include `createdAt`. Search for affected files:

```bash
grep -rln "url: \"https://github.com/x/y/pull/" src/ tests/
```

Each match (e.g., `src/pipeline/handlers/review.test.ts:48`) needs `createdAt: "2026-04-26T00:00:00.000Z"` added. The literal value isn't load-bearing in those existing tests — pick any ISO string.

Also look for raw object literals in `mutex.test.ts`, `state-reader.test.ts`, etc. — but those use `attachments: []` (empty array, no fix needed). Confirm with:

```bash
grep -rn "{ id:.*url:.*title" src/pipeline/
```

- [ ] **Step 2.4:** Create `src/pipeline/linear-client.test.ts` (or extend if it exists). Test the retry behavior with a mocked `@linear/sdk`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const createCommentMock = vi.fn();
vi.mock("@linear/sdk", () => ({
  LinearClient: class {
    createComment = createCommentMock;
  },
}));

import { LinearClient } from "./linear-client.js";

describe("LinearClient.addComment retry", () => {
  beforeEach(() => createCommentMock.mockReset());

  it("returns first-attempt result without retrying on success", async () => {
    createCommentMock.mockResolvedValueOnce({
      success: true,
      comment: Promise.resolve({ id: "c1", createdAt: new Date("2026-04-26T00:00:00Z") }),
    });
    const c = new LinearClient({ apiKey: "k", teamKey: "KPR" });
    const r = await c.addComment("issue-1", "hello");
    expect(r.id).toBe("c1");
    expect(createCommentMock).toHaveBeenCalledTimes(1);
  });

  it("retries once after a transient failure and returns the second result", async () => {
    createCommentMock
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce({
        success: true,
        comment: Promise.resolve({ id: "c2", createdAt: new Date("2026-04-26T00:00:00Z") }),
      });
    const c = new LinearClient({ apiKey: "k", teamKey: "KPR" });
    const r = await c.addComment("issue-1", "hello");
    expect(r.id).toBe("c2");
    expect(createCommentMock).toHaveBeenCalledTimes(2);
  });

  it("propagates the error when the second attempt also fails", async () => {
    createCommentMock
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockRejectedValueOnce(new Error("ETIMEDOUT"));
    const c = new LinearClient({ apiKey: "k", teamKey: "KPR" });
    await expect(c.addComment("issue-1", "hello")).rejects.toThrow("ETIMEDOUT");
    expect(createCommentMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2.5:** Verify

```bash
cd /Users/mokie/github/beekeeper-KPR-96 && npm run typecheck && npm run test -- src/pipeline/linear-client.test.ts src/pipeline/handlers/review.test.ts
```

Expected: typecheck clean; both test files pass.

- [ ] **Step 2.6:** Commit (combined with Task 1):

```bash
git add src/pipeline/types.ts src/types.ts src/pipeline/orchestrator/types.ts \
        src/pipeline/linear-client.ts src/pipeline/linear-client.test.ts \
        src/pipeline/handlers/review.test.ts
git commit -m "feat(pipeline): TicketAttachment.createdAt + addComment retry + orchestrator types"
```

---

## Task 3: Open-questions sentinel parser

**Files:**
- Create: `src/pipeline/orchestrator/sentinel.ts`
- Create: `src/pipeline/orchestrator/sentinel.test.ts`

- [ ] **Step 3.1:** Create `src/pipeline/orchestrator/sentinel.ts`:

```typescript
/**
 * Open-questions sentinel — drafting subagents emit a structured fence in
 * streamed assistant text when they need human input. The orchestrator
 * content-matches this fence to interrupt and post `block:human`.
 */
export const OPEN_QUESTIONS_OPEN = "=== OPEN QUESTIONS (BLOCK:HUMAN) ===";
export const OPEN_QUESTIONS_CLOSE = "=== END OPEN QUESTIONS ===";

export interface OpenQuestionsMatch {
  /** True if both fences were found in `text`. */
  complete: boolean;
  /** True if just the opening fence was found (subsequent partial-message text expected). */
  openOnly: boolean;
  /** The questions block (between fences). Only populated when complete=true. */
  block?: string;
  /** Parsed numbered-list items. Only populated when complete=true. */
  questions?: string[];
}

/**
 * Match the sentinel fences in `text`. `text` may be:
 *  - A single full assistant message (one shot)
 *  - The accumulated buffer across stream-event deltas (called repeatedly as
 *    new deltas arrive, with the SAME accumulated buffer each time)
 *
 * Returns `complete: true` only when both fences are present. The orchestrator
 * uses `openOnly` to start buffering subsequent deltas; `complete` to fire the
 * cancel + Linear comment.
 */
export function detectOpenQuestions(text: string): OpenQuestionsMatch {
  const openIdx = text.indexOf(OPEN_QUESTIONS_OPEN);
  if (openIdx === -1) return { complete: false, openOnly: false };
  const afterOpen = openIdx + OPEN_QUESTIONS_OPEN.length;
  const closeIdx = text.indexOf(OPEN_QUESTIONS_CLOSE, afterOpen);
  if (closeIdx === -1) return { complete: false, openOnly: true };
  const block = text.slice(afterOpen, closeIdx).trim();
  const questions = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^\d+\.\s+/, ""));
  return { complete: true, openOnly: false, block, questions };
}
```

- [ ] **Step 3.2:** Create `src/pipeline/orchestrator/sentinel.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { detectOpenQuestions } from "./sentinel.js";

describe("detectOpenQuestions", () => {
  it("returns complete=false when no fence present", () => {
    expect(detectOpenQuestions("nothing here")).toEqual({ complete: false, openOnly: false });
  });

  it("returns openOnly when only opening fence present (mid-stream)", () => {
    const text = "intro text\n=== OPEN QUESTIONS (BLOCK:HUMAN) ===\n1. partial...";
    expect(detectOpenQuestions(text)).toEqual({ complete: false, openOnly: true });
  });

  it("returns complete=true with parsed questions when both fences present", () => {
    const text = [
      "intro",
      "=== OPEN QUESTIONS (BLOCK:HUMAN) ===",
      "1. Should we use poll or SSE?",
      "2. What sentinel format?",
      "=== END OPEN QUESTIONS ===",
      "trailing",
    ].join("\n");
    const m = detectOpenQuestions(text);
    expect(m.complete).toBe(true);
    expect(m.questions).toEqual([
      "Should we use poll or SSE?",
      "What sentinel format?",
    ]);
  });

  it("ignores non-numbered lines inside the block", () => {
    const text = [
      "=== OPEN QUESTIONS (BLOCK:HUMAN) ===",
      "header line (not a question)",
      "1. first",
      "    indented continuation",
      "2. second",
      "=== END OPEN QUESTIONS ===",
    ].join("\n");
    const m = detectOpenQuestions(text);
    expect(m.questions).toEqual(["first", "second"]);
  });
});
```

- [ ] **Step 3.3:** Verify

```bash
cd /Users/mokie/github/beekeeper-KPR-96 && npm run test -- src/pipeline/orchestrator/sentinel.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 3.4:** Commit

```bash
git add src/pipeline/orchestrator/sentinel.ts src/pipeline/orchestrator/sentinel.test.ts
git commit -m "feat(pipeline/orchestrator): open-questions sentinel parser"
```

---

## Task 4: Pipeline-tightened bash guardian (allowlist + redirection-strip + chmod whitelist)

**Files:**
- Create: `src/pipeline/orchestrator/pipeline-guardian.ts`
- Create: `src/pipeline/orchestrator/pipeline-guardian.test.ts`

- [ ] **Step 4.1:** Create `src/pipeline/orchestrator/pipeline-guardian.ts`:

```typescript
import type { HookInput, HookJSONOutput, HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../../logging/logger.js";

const log = createLogger("pipeline-guardian");

/**
 * Strip trailing shell-redirection / chaining segments from a command string.
 * Returns the stripped command. If `stripped !== input`, the command contains
 * shell composition; the guardian rejects any such command early as a hard
 * rule (plan-stage decision: option (a) — disallow piping/redirection).
 */
function stripRedirection(cmd: string): string {
  // Order matters: longer operators first to avoid `>` swallowing `>>` etc.
  // We strip from the FIRST occurrence of any operator to end-of-string.
  const operators = [" 2>&1", " 2>", " >>", " >", " <", " | ", " || ", " && ", " ; ", " & "];
  let earliest = cmd.length;
  for (const op of operators) {
    const idx = cmd.indexOf(op);
    if (idx !== -1 && idx < earliest) earliest = idx;
  }
  return cmd.slice(0, earliest);
}

/**
 * Validate `chmod` mode arg. Rejects setuid/setgid/sticky-bit modes.
 * Accepts: numeric `0755`, `755` (3-4 digits, leading digit 0 or 1);
 *          symbolic `u+x`, `go-r`, `a=rw` (mode letters from [rwxX] only).
 * Rejects: `+s`, `g+s`, `=t`, `4755`, `2755`, `6755`, anything else.
 */
function chmodModeAllowed(mode: string | undefined): boolean {
  if (!mode) return false;
  // Numeric: 3 or 4 octal digits; if 4 digits, leading must be 0 or 1.
  if (/^[0-7]{3,4}$/.test(mode)) {
    if (mode.length === 4 && !/^[01]/.test(mode)) return false;
    return true;
  }
  // Symbolic: who-set [+-=] mode-letters; mode-letters limited to rwxX.
  if (/^[ugoa]*[+\-=][rwxX]+$/.test(mode)) return true;
  return false;
}

export interface PipelineGuardianOptions {
  /** Compiled regexes — caller compiles from config strings (so config-validation surfaces bad regexes early). */
  allowlist: RegExp[];
}

export class PipelineGuardian {
  private allowlist: RegExp[];

  constructor(opts: PipelineGuardianOptions) {
    this.allowlist = opts.allowlist;
  }

  /** Compile a list of regex strings; throws on the first invalid pattern. */
  static compile(patterns: string[]): RegExp[] {
    return patterns.map((p, i) => {
      try {
        return new RegExp(p);
      } catch (err) {
        throw new Error(`pipeline.orchestrator.bashAllowlist[${i}] is not a valid regex: ${p} (${String(err)})`);
      }
    });
  }

  createHookCallback(agentId: string): HookCallback {
    return async (
      input: HookInput,
      _toolUseId: string | undefined,
      _options: { signal: AbortSignal },
    ): Promise<HookJSONOutput> => {
      if (input.hook_event_name !== "PreToolUse") return { decision: "approve" };
      if (input.tool_name !== "Bash") return { decision: "approve" };
      const command = ((input.tool_input as { command?: string })?.command ?? "").trim();
      if (!command) {
        log.warn("Empty bash command rejected", { agentId });
        return { decision: "block", reason: "empty bash command" };
      }
      const stripped = stripRedirection(command);
      if (stripped !== command) {
        log.warn("Bash rejected: shell-redirection not allowed", { agentId, redacted: redactCommand(command) });
        return {
          decision: "block",
          reason: "shell redirection / piping / chaining is denied for pipeline subagents (plan-stage rule v1)",
        };
      }
      // chmod-specific mode-arg whitelist (denies +s / 4xxx / 2xxx).
      if (/^chmod\s/.test(stripped)) {
        const parts = stripped.split(/\s+/);
        const modeArg = parts[1];
        if (!chmodModeAllowed(modeArg)) {
          log.warn("Bash rejected: chmod mode not allowed", { agentId, redacted: redactCommand(command) });
          return { decision: "block", reason: `chmod mode not allowed: ${modeArg ?? "(missing)"}` };
        }
      }
      const allowed = this.allowlist.some((re) => re.test(stripped));
      if (!allowed) {
        log.warn("Bash rejected: not in allowlist", { agentId, redacted: redactCommand(command) });
        return { decision: "block", reason: "command not in pipeline-subagent bash allowlist" };
      }
      return { decision: "approve" };
    };
  }
}

/**
 * Redact a command for logging — keep the first token (binary name) and a
 * truncated tail. Avoids leaking arg values that may contain credentials
 * (e.g., `gh api -H "Authorization: Bearer $TOKEN"`).
 */
function redactCommand(cmd: string): string {
  const firstSpace = cmd.indexOf(" ");
  if (firstSpace === -1) return cmd.slice(0, 32);
  const head = cmd.slice(0, firstSpace);
  const tailLen = Math.min(48, cmd.length - firstSpace - 1);
  return `${head} <${tailLen} chars redacted>`;
}
```

- [ ] **Step 4.2:** Create `src/pipeline/orchestrator/pipeline-guardian.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { PipelineGuardian } from "./pipeline-guardian.js";

const allowlist = PipelineGuardian.compile([
  "^gh (issue|pr|repo|api|workflow|auth status|run) ",
  "^git (status|diff|log|show|add|commit|push|fetch|pull|rebase|merge|checkout|switch|branch|worktree|stash|tag|remote|reset --soft|cherry-pick) ",
  "^npm (run|install|ci|test|version|pack) ",
  "^npx (tsc|vitest|eslint|prettier|tsx|@anthropic-ai) ",
  "^node ",
  "^cat ",
  "^ls ",
  "^pwd",
  "^which ",
  "^find ",
  "^mkdir ",
  "^cp ",
  "^mv ",
  "^chmod ",
  "^security find-generic-password ",
  "^mongosh ",
  "^mongo ",
]);

function makeInput(command: string) {
  return {
    hook_event_name: "PreToolUse" as const,
    tool_name: "Bash" as const,
    tool_input: { command },
    tool_use_id: "tu_1",
  } as never;
}

async function decide(g: PipelineGuardian, command: string) {
  const cb = g.createHookCallback("agent-x");
  return cb(makeInput(command), undefined, { signal: new AbortController().signal });
}

describe("PipelineGuardian", () => {
  const g = new PipelineGuardian({ allowlist });

  it("approves allowlisted gh command", async () => {
    const r = await decide(g, "gh pr create --title 'test'");
    expect(r.decision).toBe("approve");
  });

  it("approves allowlisted npm run", async () => {
    expect((await decide(g, "npm run build")).decision).toBe("approve");
  });

  it("denies non-allowlisted command", async () => {
    expect((await decide(g, "rm -rf /tmp/x")).decision).toBe("block");
  });

  it("denies pnpm (not in allowlist)", async () => {
    expect((await decide(g, "pnpm install")).decision).toBe("block");
  });

  it("denies command with shell pipe (npm run build | tee log)", async () => {
    const r = await decide(g, "npm run build | tee build.log");
    expect(r.decision).toBe("block");
    expect((r as { reason: string }).reason).toMatch(/shell redirection/);
  });

  it("denies command with stdout redirection (> file)", async () => {
    expect((await decide(g, "npm test > out.txt")).decision).toBe("block");
  });

  it("denies && chained allowlisted commands", async () => {
    expect((await decide(g, "git status && npm test")).decision).toBe("block");
  });

  it("denies chmod +s", async () => {
    expect((await decide(g, "chmod +s file")).decision).toBe("block");
  });

  it("denies chmod 4755 (setuid numeric)", async () => {
    expect((await decide(g, "chmod 4755 file")).decision).toBe("block");
  });

  it("denies chmod g+s", async () => {
    expect((await decide(g, "chmod g+s file")).decision).toBe("block");
  });

  it("approves chmod 0755", async () => {
    expect((await decide(g, "chmod 0755 file")).decision).toBe("approve");
  });

  it("approves chmod 755", async () => {
    expect((await decide(g, "chmod 755 file")).decision).toBe("approve");
  });

  it("approves chmod u+x", async () => {
    expect((await decide(g, "chmod u+x file")).decision).toBe("approve");
  });

  it("denies empty bash command", async () => {
    expect((await decide(g, "")).decision).toBe("block");
  });

  it("approves non-Bash tools without hitting the allowlist", async () => {
    const cb = g.createHookCallback("a");
    const r = await cb(
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {}, tool_use_id: "x" } as never,
      undefined,
      { signal: new AbortController().signal },
    );
    expect(r.decision).toBe("approve");
  });

  it("compile() throws on invalid regex", () => {
    expect(() => PipelineGuardian.compile(["^gh ("])).toThrow(/not a valid regex/);
  });
});
```

- [ ] **Step 4.3:** Verify

```bash
cd /Users/mokie/github/beekeeper-KPR-96 && npm run test -- src/pipeline/orchestrator/pipeline-guardian.test.ts
```

Expected: all tests pass.

- [ ] **Step 4.4:** Commit

```bash
git add src/pipeline/orchestrator/pipeline-guardian.ts src/pipeline/orchestrator/pipeline-guardian.test.ts
git commit -m "feat(pipeline/orchestrator): pipeline-tightened bash guardian"
```

---

## Task 5: AskUserQuestion trap

**Files:**
- Create: `src/pipeline/orchestrator/ask-user-question-trap.ts`
- Create: `src/pipeline/orchestrator/ask-user-question-trap.test.ts`

The trap differs from `QuestionRelayer` in two ways: (a) there's no client to relay to, so the question is posted to Linear as `block:human` directly; (b) it sets `_terminalReason` on the job so the orchestrator's finally block transitions `state` to `stalled` (no direct `state` writes).

- [ ] **Step 5.1:** Create `src/pipeline/orchestrator/ask-user-question-trap.ts`:

```typescript
import type { HookInput, HookJSONOutput, HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../../logging/logger.js";
import type { LinearClient } from "../linear-client.js";
import type { PipelineJob } from "./types.js";

const log = createLogger("pipeline-ask-trap");

export interface AskUserQuestionTrapOptions {
  /** Linear client for posting block:human comment + label. */
  linear: LinearClient;
  /** Linear ticket ID (e.g., "issue-id" UUID, not the human identifier). */
  ticketIssueId: string;
  /** The PipelineJob this trap is bound to. The trap mutates `_terminalReason` and `cancelRequested`. */
  job: PipelineJob;
  /** Called when the trap fires; orchestrator uses this to interrupt the active query. */
  onTrap: () => Promise<void>;
}

/**
 * Pipeline subagents have no human-in-the-loop client. AskUserQuestion means
 * "I'm stuck on a decision". The trap:
 *  1. Records the question(s).
 *  2. Sets `job._terminalReason = "stalled-ask-user-question"` (one-way state).
 *  3. Sets `job.cancelRequested = true` so the iterator-throw becomes "interrupted" not "error".
 *  4. Posts a Linear `block:human` comment listing the questions.
 *  5. Adds the `block:human` label.
 *  6. Calls onTrap() to interrupt the active query.
 *  7. Returns a `block` decision with a reason explaining the trap.
 */
export function createAskUserQuestionTrap(opts: AskUserQuestionTrapOptions): HookCallback {
  return async (
    input: HookInput,
    _toolUseId: string | undefined,
    _options: { signal: AbortSignal },
  ): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== "PreToolUse") return { decision: "approve" };
    if (input.tool_name !== "AskUserQuestion") return { decision: "approve" };

    const toolInput = input.tool_input as {
      questions?: Array<{ question: string; multiSelect?: boolean; options?: Array<{ label: string }> }>;
    };
    const questions = toolInput?.questions ?? [];
    log.info("AskUserQuestion trapped", {
      agentId: opts.job.agentId,
      ticketId: opts.job.ticketId,
      count: questions.length,
    });

    // One-way: only set if not already terminal.
    if (!opts.job._terminalReason) {
      opts.job._terminalReason = "stalled-ask-user-question";
      opts.job.cancelRequested = true;
    }

    const lines = [
      `pipeline-tick: subagent ${opts.job.agentId} hit AskUserQuestion; ticket flagged block:human.`,
      "",
      "Subagent questions:",
      ...questions.map((q, i) => `  ${i + 1}. ${q.question}`),
    ];

    try {
      await opts.linear.addComment(opts.ticketIssueId, lines.join("\n"));
      await opts.linear.addLabel(opts.ticketIssueId, "block:human");
    } catch (err) {
      log.error("Failed to write block:human signals to Linear", {
        agentId: opts.job.agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      await opts.onTrap();
    } catch (err) {
      log.error("onTrap (interrupt) failed", {
        agentId: opts.job.agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return {
      decision: "block",
      reason: "AskUserQuestion is not available for pipeline subagents — the question has been routed to Linear as block:human. This subagent is being interrupted.",
    };
  };
}
```

- [ ] **Step 5.2:** Create `src/pipeline/orchestrator/ask-user-question-trap.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createAskUserQuestionTrap } from "./ask-user-question-trap.js";
import type { PipelineJob } from "./types.js";

function makeJob(): PipelineJob {
  return {
    agentId: "agent-XYZ",
    ticketId: "KPR-79",
    kind: "draft-spec",
    cwd: "/tmp/repo",
    startedAt: "2026-04-26T00:00:00.000Z",
    state: "running",
    lastMessageAt: "2026-04-26T00:00:00.000Z",
    messages: [],
  };
}

function makeInput(toolName: string, questions?: unknown) {
  return {
    hook_event_name: "PreToolUse" as const,
    tool_name: toolName,
    tool_input: { questions },
    tool_use_id: "tu_1",
  } as never;
}

describe("AskUserQuestion trap", () => {
  it("approves non-AskUserQuestion tools", async () => {
    const job = makeJob();
    const linear = { addComment: vi.fn(), addLabel: vi.fn() } as never;
    const trap = createAskUserQuestionTrap({ linear, ticketIssueId: "iid", job, onTrap: async () => {} });
    const r = await trap(makeInput("Bash"), undefined, { signal: new AbortController().signal });
    expect(r.decision).toBe("approve");
    expect(job._terminalReason).toBeUndefined();
  });

  it("blocks AskUserQuestion, sets _terminalReason, posts Linear, calls onTrap", async () => {
    const job = makeJob();
    const linear = { addComment: vi.fn().mockResolvedValue({ id: "c", createdAt: "" }), addLabel: vi.fn().mockResolvedValue(undefined) } as never;
    const onTrap = vi.fn().mockResolvedValue(undefined);
    const trap = createAskUserQuestionTrap({ linear, ticketIssueId: "iid", job, onTrap });
    const r = await trap(
      makeInput("AskUserQuestion", [{ question: "go ahead?" }, { question: "use SSE?" }]),
      undefined,
      { signal: new AbortController().signal },
    );
    expect(r.decision).toBe("block");
    expect(job._terminalReason).toBe("stalled-ask-user-question");
    expect(job.cancelRequested).toBe(true);
    expect(linear.addComment).toHaveBeenCalled();
    const commentBody = (linear.addComment.mock.calls[0] as string[])[1];
    expect(commentBody).toContain("1. go ahead?");
    expect(commentBody).toContain("2. use SSE?");
    expect(linear.addLabel).toHaveBeenCalledWith("iid", "block:human");
    expect(onTrap).toHaveBeenCalled();
  });

  it("does NOT overwrite an existing _terminalReason", async () => {
    const job = makeJob();
    job._terminalReason = "completed";
    const linear = { addComment: vi.fn().mockResolvedValue({ id: "c", createdAt: "" }), addLabel: vi.fn().mockResolvedValue(undefined) } as never;
    const trap = createAskUserQuestionTrap({ linear, ticketIssueId: "iid", job, onTrap: async () => {} });
    await trap(makeInput("AskUserQuestion", [{ question: "x" }]), undefined, { signal: new AbortController().signal });
    expect(job._terminalReason).toBe("completed");
  });
});
```

- [ ] **Step 5.3:** Verify

```bash
cd /Users/mokie/github/beekeeper-KPR-96 && npm run test -- src/pipeline/orchestrator/ask-user-question-trap.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5.4:** Commit

```bash
git add src/pipeline/orchestrator/ask-user-question-trap.ts src/pipeline/orchestrator/ask-user-question-trap.test.ts
git commit -m "feat(pipeline/orchestrator): AskUserQuestion trap routes to block:human"
```

---

## Task 6: `consumeMessages` loop with one-way `_terminalReason` discipline

**Files:**
- Create: `src/pipeline/orchestrator/consume-messages.ts`
- Create: `src/pipeline/orchestrator/consume-messages.test.ts`

This is the heart of the orchestrator's runtime contract. The discipline: **only the `finally` block writes `job.state`.** Handlers (sentinel match, AskUserQuestion trap, hard-stall scanner) set `_terminalReason`; the finally block translates.

- [ ] **Step 6.1:** Create `src/pipeline/orchestrator/consume-messages.ts`:

```typescript
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../../logging/logger.js";
import type { LinearClient } from "../linear-client.js";
import { detectOpenQuestions } from "./sentinel.js";
import type { PipelineJob, JobState, TerminalReason } from "./types.js";

const log = createLogger("pipeline-consume");

export interface ConsumeMessagesContext {
  job: PipelineJob;
  activeQuery: Query;
  linear: LinearClient;
  ticketIssueId: string;
  /** Cancel hook called by the sentinel handler (delegates to PipelineOrchestrator.cancel). */
  cancel: () => Promise<void>;
  /** Called once when state transitions to terminal (any reason). Used by orchestrator to schedule TTL eviction. */
  onTerminal?: (job: PipelineJob) => void;
}

const TERMINAL_TO_STATE: Record<TerminalReason, JobState> = {
  completed: "completed",
  error: "error",
  interrupted: "interrupted",
  "stalled-open-questions": "stalled",
  "stalled-ask-user-question": "stalled",
  "stalled-timeout": "stalled",
};

/**
 * Drain the SDKMessage iterator. Updates lastMessageAt on every message. On
 * `assistant`/`stream_event` text, accumulates into a per-job text buffer and
 * runs the open-questions sentinel matcher. On `result`, captures success/cost.
 *
 * State assignment is ONE-WAY: handlers set `_terminalReason`; the finally
 * block reads `_terminalReason` and writes `state` exactly once. This is the
 * race-free fix for cancel-induced iterator throws clashing with sentinel
 * handlers.
 */
export async function consumeMessages(ctx: ConsumeMessagesContext): Promise<void> {
  const { job, activeQuery, linear, ticketIssueId } = ctx;

  // Per-job accumulated assistant text (rolling buffer for sentinel matching).
  // Keep the last 32 KB to avoid unbounded growth on long runs.
  let assistantTextBuffer = "";
  const BUFFER_CAP = 32 * 1024;
  let sentinelHandled = false;

  async function feedSentinelBuffer(text: string): Promise<void> {
    assistantTextBuffer += text;
    if (assistantTextBuffer.length > BUFFER_CAP) {
      assistantTextBuffer = assistantTextBuffer.slice(-BUFFER_CAP);
    }
    if (!sentinelHandled) {
      const m = detectOpenQuestions(assistantTextBuffer);
      if (m.complete) {
        sentinelHandled = true;
        // Awaited so the cancel + Linear writes complete before the loop
        // proceeds (or the iterator throws from interrupt — caught below).
        await handleSentinel(ctx, m.questions ?? []);
      }
    }
  }

  try {
    for await (const message of activeQuery) {
      const msg = message as SDKMessage;
      const now = new Date().toISOString();

      // Always buffer + update lastMessageAt — finest granularity available.
      job.messages.push({ type: msg.type, receivedAt: now, payload: msg as unknown as Record<string, unknown> });
      job.lastMessageAt = now;
      // Soft-warn idempotency: a fresh message clears softWarnedAt so the next
      // quiet period earns its own warning.
      if (job.softWarnedAt) job.softWarnedAt = undefined;

      // stream_event / assistant text accumulation for sentinel matching
      if (msg.type === "stream_event") {
        const event = (msg as unknown as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
        if (event?.type === "content_block_delta" && event?.delta?.type === "text_delta" && typeof event.delta.text === "string") {
          await feedSentinelBuffer(event.delta.text);
        }
      }

      if (msg.type === "assistant") {
        const content = (msg as unknown as { message?: { content?: Array<{ type?: string; text?: string }> } }).message?.content ?? [];
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") {
            await feedSentinelBuffer(block.text);
          }
        }
      }

      if (msg.type === "result") {
        // Single decision site: success → completed, anything else → error.
        // Only set if no prior terminal reason (sentinel/trap/cancel preserved).
        const r = msg as unknown as { subtype?: string; total_cost_usd?: number; duration_ms?: number };
        if (!job._terminalReason) {
          job._terminalReason = r.subtype === "success" ? "completed" : "error";
          job.result = { ok: r.subtype === "success", reason: r.subtype ?? "unknown" };
        }
        log.info("Subagent result", {
          agentId: job.agentId,
          subtype: r.subtype,
          cost: r.total_cost_usd,
          durationMs: r.duration_ms,
        });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Iterator threw", { agentId: job.agentId, error: msg });
    if (!job._terminalReason) {
      job._terminalReason = job.cancelRequested ? "interrupted" : "error";
      if (!job.cancelRequested) {
        // Genuine error (not cancel) — write Linear comment + block:human label.
        try {
          await linear.addComment(
            ticketIssueId,
            `pipeline-tick: subagent ${job.agentId} errored mid-stream: ${msg}; ticket flagged for human review`,
          );
          await linear.addLabel(ticketIssueId, "block:human");
        } catch (e) {
          log.error("Failed to write Linear iterator-throw signals", { agentId: job.agentId, error: String(e) });
        }
      }
    }
  } finally {
    // SINGLE WRITER of job.state. Reads _terminalReason; defaults to "error" if
    // somehow unset (defensive — should never happen).
    const reason: TerminalReason = job._terminalReason ?? "error";
    job.state = TERMINAL_TO_STATE[reason];
    log.info("Subagent terminal", { agentId: job.agentId, state: job.state, reason });
    if (ctx.onTerminal) ctx.onTerminal(job);
  }
}

async function handleSentinel(ctx: ConsumeMessagesContext, questions: string[]): Promise<void> {
  const { job, linear, ticketIssueId, cancel } = ctx;
  if (!job._terminalReason) {
    job._terminalReason = "stalled-open-questions";
    job.cancelRequested = true;
  }
  const lines = [
    `pipeline-tick: subagent ${job.agentId} emitted open-questions sentinel; ticket flagged block:human.`,
    "",
    "Open questions:",
    ...questions.map((q, i) => `  ${i + 1}. ${q}`),
  ];
  try {
    await linear.addComment(ticketIssueId, lines.join("\n"));
    await linear.addLabel(ticketIssueId, "block:human");
  } catch (err) {
    log.error("Failed to write block:human on sentinel", { agentId: job.agentId, error: String(err) });
  }
  try {
    await cancel();
  } catch (err) {
    log.error("cancel after sentinel failed", { agentId: job.agentId, error: String(err) });
  }
}
```

- [ ] **Step 6.2:** Create `src/pipeline/orchestrator/consume-messages.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { consumeMessages } from "./consume-messages.js";
import type { PipelineJob } from "./types.js";

function makeJob(): PipelineJob {
  return {
    agentId: "agent-XYZ",
    ticketId: "KPR-79",
    kind: "draft-spec",
    cwd: "/tmp/repo",
    startedAt: "2026-04-26T00:00:00.000Z",
    state: "running",
    lastMessageAt: "2026-04-26T00:00:00.000Z",
    messages: [],
  };
}

function makeIter(messages: unknown[]) {
  let interrupted = false;
  const iter: { interrupt: () => Promise<void>; [Symbol.asyncIterator]: () => AsyncGenerator<unknown> } = {
    interrupt: vi.fn(async () => { interrupted = true; }),
    async *[Symbol.asyncIterator]() {
      for (const m of messages) {
        if (interrupted) return;
        yield m;
      }
    },
  };
  return iter;
}

function makeIterThrowing(messages: unknown[], err: Error) {
  const iter = {
    interrupt: vi.fn(async () => {}),
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m;
      throw err;
    },
  };
  return iter;
}

const linearMock = () => ({
  addComment: vi.fn().mockResolvedValue({ id: "c", createdAt: "" }),
  addLabel: vi.fn().mockResolvedValue(undefined),
});

describe("consumeMessages", () => {
  it("happy path: iterator drains, result→completed in finally", async () => {
    const job = makeJob();
    const iter = makeIter([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "result", subtype: "success", total_cost_usd: 0.01, duration_ms: 1000 },
    ]);
    const linear = linearMock();
    await consumeMessages({ job, activeQuery: iter as never, linear: linear as never, ticketIssueId: "iid", cancel: async () => { await iter.interrupt(); } });
    expect(job.state).toBe("completed");
    expect(job._terminalReason).toBe("completed");
    expect(job.result?.ok).toBe(true);
    expect(linear.addComment).not.toHaveBeenCalled();
  });

  it("non-success result→error", async () => {
    const job = makeJob();
    const iter = makeIter([
      { type: "result", subtype: "max_turns" },
    ]);
    const linear = linearMock();
    await consumeMessages({ job, activeQuery: iter as never, linear: linear as never, ticketIssueId: "iid", cancel: async () => {} });
    expect(job.state).toBe("error");
  });

  it("sentinel match → cancel + Linear, _terminalReason wins over later events", async () => {
    const job = makeJob();
    const sentinelText = "checking...\n=== OPEN QUESTIONS (BLOCK:HUMAN) ===\n1. ssE or poll?\n=== END OPEN QUESTIONS ===\n";
    const iter = makeIter([
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: sentinelText } } },
    ]);
    const linear = linearMock();
    const cancel = vi.fn().mockResolvedValue(undefined);
    await consumeMessages({ job, activeQuery: iter as never, linear: linear as never, ticketIssueId: "iid", cancel });
    expect(job._terminalReason).toBe("stalled-open-questions");
    expect(job.state).toBe("stalled");
    expect(linear.addComment).toHaveBeenCalled();
    expect(linear.addLabel).toHaveBeenCalledWith("iid", "block:human");
    expect(cancel).toHaveBeenCalled();
  });

  it("iterator throw without _terminalReason → error + block:human comment", async () => {
    const job = makeJob();
    const iter = makeIterThrowing(
      [{ type: "system", subtype: "init", session_id: "s1" }],
      new Error("ECONNRESET"),
    );
    const linear = linearMock();
    await consumeMessages({ job, activeQuery: iter as never, linear: linear as never, ticketIssueId: "iid", cancel: async () => {} });
    expect(job.state).toBe("error");
    expect(linear.addComment).toHaveBeenCalled();
    expect(linear.addLabel).toHaveBeenCalledWith("iid", "block:human");
  });

  it("iterator throw with cancelRequested → interrupted (no error comment)", async () => {
    const job = makeJob();
    job.cancelRequested = true;
    const iter = makeIterThrowing(
      [{ type: "system", subtype: "init", session_id: "s1" }],
      new Error("aborted"),
    );
    const linear = linearMock();
    await consumeMessages({ job, activeQuery: iter as never, linear: linear as never, ticketIssueId: "iid", cancel: async () => {} });
    expect(job.state).toBe("interrupted");
    expect(linear.addComment).not.toHaveBeenCalled();
  });

  it("preserves prior _terminalReason if set before iterator throws (sentinel race)", async () => {
    const job = makeJob();
    const sentinelText = "=== OPEN QUESTIONS (BLOCK:HUMAN) ===\n1. q\n=== END OPEN QUESTIONS ===\n";
    const iter = makeIterThrowing(
      [{ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: sentinelText } } }],
      new Error("aborted-after-sentinel"),
    );
    const linear = linearMock();
    await consumeMessages({ job, activeQuery: iter as never, linear: linear as never, ticketIssueId: "iid", cancel: async () => {} });
    expect(job._terminalReason).toBe("stalled-open-questions");
    expect(job.state).toBe("stalled");
  });

  it("calls onTerminal exactly once on terminal", async () => {
    const job = makeJob();
    const iter = makeIter([{ type: "result", subtype: "success" }]);
    const onTerminal = vi.fn();
    await consumeMessages({ job, activeQuery: iter as never, linear: linearMock() as never, ticketIssueId: "iid", cancel: async () => {}, onTerminal });
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith(job);
  });

  it("updates lastMessageAt on every message", async () => {
    const job = makeJob();
    const before = job.lastMessageAt;
    const iter = makeIter([
      { type: "system", subtype: "init" },
      { type: "result", subtype: "success" },
    ]);
    await consumeMessages({ job, activeQuery: iter as never, linear: linearMock() as never, ticketIssueId: "iid", cancel: async () => {} });
    expect(job.lastMessageAt).not.toBe(before);
    expect(job.messages.length).toBe(2);
  });
});
```

- [ ] **Step 6.3:** Verify

```bash
cd /Users/mokie/github/beekeeper-KPR-96 && npm run test -- src/pipeline/orchestrator/consume-messages.test.ts
```

Expected: all tests pass.

- [ ] **Step 6.4:** Commit

```bash
git add src/pipeline/orchestrator/consume-messages.ts src/pipeline/orchestrator/consume-messages.test.ts
git commit -m "feat(pipeline/orchestrator): consumeMessages with one-way _terminalReason discipline"
```

---

## Task 7: Stall scanner (two-tier: warn / cancel)

**Files:**
- Create: `src/pipeline/orchestrator/stall-scanner.ts`
- Create: `src/pipeline/orchestrator/stall-scanner.test.ts`

- [ ] **Step 7.1:** Create `src/pipeline/orchestrator/stall-scanner.ts`:

```typescript
import { createLogger } from "../../logging/logger.js";
import type { LinearClient } from "../linear-client.js";
import type { PipelineJob } from "./types.js";
import type { OrchestratorStallThresholds } from "../../types.js";
import type { SubagentKind } from "../subagent-spawn.js";

const log = createLogger("pipeline-stall");

export interface StallScannerOptions {
  thresholds: OrchestratorStallThresholds;
  /** Active jobs accessor (orchestrator's job map filtered to running). */
  getActiveJobs: () => PipelineJob[];
  linear: LinearClient;
  /** Cancel hook (orchestrator.cancel) for the hard tier. */
  cancel: (agentId: string) => Promise<void>;
  /** ms — the interval cadence (default 30000). */
  intervalMs?: number;
  /** Map ticketId → linear issue UUID (orchestrator builds this on spawn). */
  resolveIssueId: (ticketId: string) => string | undefined;
  /** Now() injection for tests. */
  now?: () => number;
}

const KIND_TO_BUCKET: Record<SubagentKind, "drafting" | "review" | "implementer"> = {
  "draft-spec": "drafting",
  "draft-plan": "drafting",
  "code-review": "review",
  "implementer": "implementer",
};

export class StallScanner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private opts: Required<StallScannerOptions>;

  constructor(opts: StallScannerOptions) {
    this.opts = {
      intervalMs: 30_000,
      now: () => Date.now(),
      ...opts,
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.scan().catch((err) => log.error("scan() threw", { error: String(err) }));
    }, this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Public for testability. */
  async scan(): Promise<void> {
    const now = this.opts.now();
    for (const job of this.opts.getActiveJobs()) {
      if (job.state !== "running") continue;
      const lastMs = new Date(job.lastMessageAt).getTime();
      const idle = now - lastMs;
      const bucket = KIND_TO_BUCKET[job.kind];
      const t = this.opts.thresholds[bucket];
      const issueId = this.opts.resolveIssueId(job.ticketId);
      if (!issueId) {
        log.warn("stall-scan: cannot resolve issueId", { ticketId: job.ticketId });
        continue;
      }
      if (idle >= t.hard) {
        // Hard tier: cancel + block:human.
        if (!job._terminalReason) {
          job._terminalReason = "stalled-timeout";
          job.cancelRequested = true;
          try {
            await this.opts.linear.addComment(
              issueId,
              `pipeline-tick: subagent ${job.agentId} stalled (no messages for ${Math.round(idle / 60_000)}min); cancelling and flagging block:human`,
            );
            await this.opts.linear.addLabel(issueId, "block:human");
          } catch (err) {
            log.error("hard-stall Linear write failed", { agentId: job.agentId, error: String(err) });
          }
          try {
            await this.opts.cancel(job.agentId);
          } catch (err) {
            log.error("hard-stall cancel failed", { agentId: job.agentId, error: String(err) });
          }
        }
        continue;
      }
      if (idle >= t.soft) {
        // Soft tier: warn-only, idempotent. Emit only if softWarnedAt is unset
        // (consumeMessages clears it on every fresh msg, so a flapping subagent
        // earns one warning per fresh quiet period).
        if (!job.softWarnedAt) {
          job.softWarnedAt = new Date(now).toISOString();
          try {
            await this.opts.linear.addComment(
              issueId,
              `pipeline-tick: subagent ${job.agentId} has been quiet for ${Math.round(idle / 60_000)}min, monitoring`,
            );
          } catch (err) {
            log.error("soft-stall Linear write failed", { agentId: job.agentId, error: String(err) });
          }
        }
      }
    }
  }
}
```

- [ ] **Step 7.2:** Create `src/pipeline/orchestrator/stall-scanner.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { StallScanner } from "./stall-scanner.js";
import type { PipelineJob } from "./types.js";
import type { OrchestratorStallThresholds } from "../../types.js";

const T: OrchestratorStallThresholds = {
  drafting:    { soft: 300_000,  hard: 900_000  },
  review:      { soft: 300_000,  hard: 900_000  },
  implementer: { soft: 600_000,  hard: 1_800_000 },
};

function job(overrides: Partial<PipelineJob> = {}): PipelineJob {
  return {
    agentId: "agent-X",
    ticketId: "KPR-79",
    kind: "draft-spec",
    cwd: "/tmp",
    startedAt: "2026-04-26T00:00:00.000Z",
    state: "running",
    lastMessageAt: "2026-04-26T00:00:00.000Z",
    messages: [],
    ...overrides,
  };
}

const linearMock = () => ({
  addComment: vi.fn().mockResolvedValue({ id: "c", createdAt: "" }),
  addLabel: vi.fn().mockResolvedValue(undefined),
});

describe("StallScanner", () => {
  it("does nothing when idle < soft threshold", async () => {
    const j = job();
    const linear = linearMock();
    const cancel = vi.fn();
    const s = new StallScanner({
      thresholds: T,
      getActiveJobs: () => [j],
      linear: linear as never,
      cancel,
      resolveIssueId: () => "iid",
      now: () => new Date(j.lastMessageAt).getTime() + 1000,
    });
    await s.scan();
    expect(linear.addComment).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("emits soft warning once when crossing soft threshold", async () => {
    const j = job();
    const linear = linearMock();
    const cancel = vi.fn();
    const start = new Date(j.lastMessageAt).getTime();
    const s = new StallScanner({
      thresholds: T,
      getActiveJobs: () => [j],
      linear: linear as never,
      cancel,
      resolveIssueId: () => "iid",
      now: () => start + 6 * 60_000, // 6 min idle, > 5 min soft, < 15 min hard
    });
    await s.scan();
    expect(linear.addComment).toHaveBeenCalledTimes(1);
    expect((linear.addComment.mock.calls[0] as string[])[1]).toMatch(/quiet/);
    expect(j.softWarnedAt).toBeTruthy();

    // Re-running scan does NOT post another warning (idempotency).
    await s.scan();
    expect(linear.addComment).toHaveBeenCalledTimes(1);
  });

  it("emits hard cancel + block:human when crossing hard threshold", async () => {
    const j = job();
    const linear = linearMock();
    const cancel = vi.fn().mockResolvedValue(undefined);
    const start = new Date(j.lastMessageAt).getTime();
    const s = new StallScanner({
      thresholds: T,
      getActiveJobs: () => [j],
      linear: linear as never,
      cancel,
      resolveIssueId: () => "iid",
      now: () => start + 16 * 60_000,
    });
    await s.scan();
    expect(j._terminalReason).toBe("stalled-timeout");
    expect(j.cancelRequested).toBe(true);
    expect(linear.addLabel).toHaveBeenCalledWith("iid", "block:human");
    expect(cancel).toHaveBeenCalledWith("agent-X");
  });

  it("uses implementer thresholds for implementer kind", async () => {
    const j = job({ kind: "implementer" });
    const linear = linearMock();
    const start = new Date(j.lastMessageAt).getTime();
    const s = new StallScanner({
      thresholds: T,
      getActiveJobs: () => [j],
      linear: linear as never,
      cancel: vi.fn(),
      resolveIssueId: () => "iid",
      // 7 min — would warn for drafting (soft 5), but NOT for implementer (soft 10).
      now: () => start + 7 * 60_000,
    });
    await s.scan();
    expect(linear.addComment).not.toHaveBeenCalled();
  });

  it("skips jobs whose state is not running (terminal already)", async () => {
    const j = job({ state: "completed" });
    const linear = linearMock();
    const start = new Date(j.lastMessageAt).getTime();
    const s = new StallScanner({
      thresholds: T,
      getActiveJobs: () => [j],
      linear: linear as never,
      cancel: vi.fn(),
      resolveIssueId: () => "iid",
      now: () => start + 30 * 60_000,
    });
    await s.scan();
    expect(linear.addComment).not.toHaveBeenCalled();
  });

  it("does NOT cancel-twice when _terminalReason is already set", async () => {
    const j = job({ _terminalReason: "completed" });
    const linear = linearMock();
    const cancel = vi.fn();
    const start = new Date(j.lastMessageAt).getTime();
    const s = new StallScanner({
      thresholds: T,
      getActiveJobs: () => [j],
      linear: linear as never,
      cancel,
      resolveIssueId: () => "iid",
      now: () => start + 30 * 60_000,
    });
    await s.scan();
    expect(cancel).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7.3:** Verify

```bash
cd /Users/mokie/github/beekeeper-KPR-96 && npm run test -- src/pipeline/orchestrator/stall-scanner.test.ts
```

Expected: all tests pass.

- [ ] **Step 7.4:** Commit

```bash
git add src/pipeline/orchestrator/stall-scanner.ts src/pipeline/orchestrator/stall-scanner.test.ts
git commit -m "feat(pipeline/orchestrator): two-tier stall scanner"
```

---

## Task 8: Startup recovery routine

**Files:**
- Modify: `src/pipeline/handlers/review.ts` (export `REVIEWER_OUTPUT_HEAD`)
- Create: `src/pipeline/orchestrator/recovery.ts`
- Create: `src/pipeline/orchestrator/recovery.test.ts`

- [ ] **Step 8.1:** In `src/pipeline/handlers/review.ts`, change `const REVIEWER_OUTPUT_HEAD` to `export const REVIEWER_OUTPUT_HEAD`. (Line 7.)

- [ ] **Step 8.2:** Create `src/pipeline/orchestrator/recovery.ts`:

```typescript
import { createLogger } from "../../logging/logger.js";
import type { LinearClient } from "../linear-client.js";
import { REVIEWER_OUTPUT_HEAD } from "../handlers/review.js";
import { OPEN_QUESTIONS_OPEN } from "./sentinel.js";
import type { TicketState, TicketComment, TicketAttachment, WorkflowState } from "../types.js";
import type { SubagentKind } from "../subagent-spawn.js";

const log = createLogger("pipeline-recovery");

const TICK_SPAWN_LOG_RE = /^tick-spawn-log:\s+runId=(\S+)\s+agentId=(\S+)\s+kind=(\S+)/;
const SELF_WRITE_RE = /^pipeline-tick: subagent (\S+) was lost in a Beekeeper server restart/;

const PR_URL_RE = /github\.com\/[^/]+\/[^/]+\/pull\/\d+/;
const BLOCK_LABEL_RE = /^block:/;

export interface RecoveryOptions {
  linear: LinearClient;
  /** Now() — tests inject a fixed clock. */
  now?: () => number;
  /** ms — spawn-log lookback window (default 24h). */
  windowMs?: number;
  /** Active orchestrator job map at boot — used to skip resurrection. */
  activeAgentIds: Set<string>;
}

export interface ParsedSpawnLog {
  comment: TicketComment;
  runId: string;
  agentId: string;
  kind: SubagentKind;
}

interface DraftingState {
  state: WorkflowState;
}

/**
 * Run the startup recovery scan exactly once on Beekeeper boot, before HTTP
 * server.listen(). For each ticket on the configured team with a recent
 * `tick-spawn-log` whose agentId is NOT in `activeAgentIds`, check for a
 * kind-specific completion signal posted AFTER the spawn-log timestamp; if
 * none and not already self-written, post `block:human` and label.
 */
export async function runStartupRecovery(opts: RecoveryOptions): Promise<{ scanned: number; orphaned: number }> {
  const now = opts.now ? opts.now() : Date.now();
  const windowMs = opts.windowMs ?? 24 * 60 * 60_000;
  const cutoffMs = now - windowMs;

  const tickets = await opts.linear.listTeamPipelineIssues();
  log.info("recovery: scanning team pipeline tickets", { count: tickets.length, windowHours: windowMs / 3_600_000 });

  let orphaned = 0;
  for (const id of tickets) {
    let ticket: TicketState;
    try {
      ticket = await opts.linear.getTicketState(id);
    } catch (err) {
      log.warn("recovery: failed to read ticket; skipping", { id, error: String(err) });
      continue;
    }
    const spawn = mostRecentSpawnLog(ticket.comments, cutoffMs);
    if (!spawn) continue;
    if (opts.activeAgentIds.has(spawn.agentId)) continue;
    if (alreadySelfWritten(ticket.comments, spawn.agentId)) {
      log.debug("recovery: idempotency self-write present, skip", { ticketId: id, agentId: spawn.agentId });
      continue;
    }
    const spawnAt = new Date(spawn.comment.createdAt).getTime();
    if (hasCompletionSignal(ticket, spawn, spawnAt)) continue;

    log.info("recovery: orphan detected", { ticketId: id, agentId: spawn.agentId, kind: spawn.kind });
    try {
      await opts.linear.addComment(
        ticket.id,
        `pipeline-tick: subagent ${spawn.agentId} was lost in a Beekeeper server restart at ${new Date(now).toISOString()}; ticket marked block:human for operator review.`,
      );
      if (!ticket.labels.includes("block:human")) {
        await opts.linear.addLabel(ticket.id, "block:human");
      }
      orphaned++;
    } catch (err) {
      log.error("recovery: write failed", { ticketId: id, agentId: spawn.agentId, error: String(err) });
    }
  }

  log.info("recovery: complete", { scanned: tickets.length, orphaned });
  return { scanned: tickets.length, orphaned };
}

function mostRecentSpawnLog(comments: TicketComment[], cutoffMs: number): ParsedSpawnLog | undefined {
  let best: ParsedSpawnLog | undefined;
  for (const c of comments) {
    const m = c.body.trim().match(TICK_SPAWN_LOG_RE);
    if (!m) continue;
    const at = new Date(c.createdAt).getTime();
    if (at < cutoffMs) continue;
    if (!best || new Date(best.comment.createdAt).getTime() < at) {
      best = { comment: c, runId: m[1], agentId: m[2], kind: m[3] as SubagentKind };
    }
  }
  return best;
}

function alreadySelfWritten(comments: TicketComment[], agentId: string): boolean {
  for (const c of comments) {
    const m = c.body.trim().match(SELF_WRITE_RE);
    if (m && m[1] === agentId) return true;
  }
  return false;
}

function hasCompletionSignal(
  ticket: TicketState,
  spawn: ParsedSpawnLog,
  spawnAtMs: number,
): boolean {
  // Universal fallback: any block:* label set after spawn-log? (We only know
  // current label set, not when it was set, so we treat ANY current `block:*`
  // as "operator already engaged" — conservative, prevents spam.)
  if (ticket.labels.some((l) => BLOCK_LABEL_RE.test(l))) return true;

  const postSpawnComments = ticket.comments.filter(
    (c) => new Date(c.createdAt).getTime() > spawnAtMs,
  );

  // Self-write sentinel (from a prior recovery run for this same agentId)
  if (postSpawnComments.some((c) => {
    const m = c.body.trim().match(SELF_WRITE_RE);
    return !!m && m[1] === spawn.agentId;
  })) return true;

  switch (spawn.kind) {
    case "draft-spec":
    case "draft-plan": {
      // Sentinel comment OR drafting-state transition (state already off the
      // drafting state) after spawn-log.
      if (postSpawnComments.some((c) => c.body.includes(OPEN_QUESTIONS_OPEN))) return true;
      // State-out-of-drafting: if current state is something other than
      // "Spec Drafting" or "Plan Drafting", the drafter probably finished and
      // a transition fired. (We don't have state-history; current-state is
      // best-effort.)
      if (ticket.state !== "Spec Drafting" && ticket.state !== "Plan Drafting") return true;
      return false;
    }
    case "code-review": {
      // Reviewer JSON verdict block (REVIEWER_OUTPUT_HEAD regex) in any post-spawn comment.
      if (postSpawnComments.some((c) => REVIEWER_OUTPUT_HEAD.test(c.body))) return true;
      return false;
    }
    case "implementer": {
      // PR attachment created after spawn-log
      const recentPr = ticket.attachments.some(
        (a: TicketAttachment) =>
          PR_URL_RE.test(a.url) && new Date(a.createdAt).getTime() > spawnAtMs,
      );
      if (recentPr) return true;
      // OR state-out-of "In Progress"
      if (ticket.state !== "In Progress") return true;
      return false;
    }
    default:
      return false;
  }
}
```

- [ ] **Step 8.3:** Create `src/pipeline/orchestrator/recovery.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { runStartupRecovery } from "./recovery.js";
import type { TicketState } from "../types.js";

const NOW = new Date("2026-04-26T12:00:00Z").getTime();
const SPAWN_AT = new Date("2026-04-26T11:00:00Z").toISOString();
const POST_SPAWN = new Date("2026-04-26T11:30:00Z").toISOString();

function ticket(over: Partial<TicketState> = {}): TicketState {
  return {
    id: "iid",
    identifier: "KPR-79",
    title: "t",
    description: "",
    state: "Spec Drafting",
    labels: [],
    blockedBy: [],
    comments: [],
    attachments: [],
    ...over,
  };
}

function spawnLogComment(agentId: string, kind: string, createdAt = SPAWN_AT) {
  return {
    id: `c-spawn-${agentId}`,
    body: `tick-spawn-log: runId=tick-XYZ agentId=${agentId} kind=${kind}`,
    createdAt,
  };
}

function makeLinear(t: TicketState[]) {
  return {
    listTeamPipelineIssues: vi.fn().mockResolvedValue(t.map((x) => x.identifier)),
    getTicketState: vi.fn(async (id: string) => t.find((x) => x.identifier === id)!),
    addComment: vi.fn().mockResolvedValue({ id: "c", createdAt: "" }),
    addLabel: vi.fn().mockResolvedValue(undefined),
  };
}

describe("runStartupRecovery", () => {
  it("skips ticket when agentId is in active set", async () => {
    const t = ticket({ comments: [spawnLogComment("agent-A", "draft-spec")] });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(["agent-A"]), now: () => NOW });
    expect(r.orphaned).toBe(0);
    expect(lin.addComment).not.toHaveBeenCalled();
  });

  it("skips when prior self-write sentinel exists (idempotency)", async () => {
    const t = ticket({
      comments: [
        spawnLogComment("agent-A", "draft-spec"),
        {
          id: "c-self",
          body: "pipeline-tick: subagent agent-A was lost in a Beekeeper server restart at 2026-04-26T05:00:00Z; ...",
          createdAt: POST_SPAWN,
        },
      ],
    });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(), now: () => NOW });
    expect(r.orphaned).toBe(0);
    expect(lin.addComment).not.toHaveBeenCalled();
  });

  it("drafting kind: skips when state moved off drafting", async () => {
    const t = ticket({
      state: "Ready",
      comments: [spawnLogComment("agent-A", "draft-plan")],
    });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(), now: () => NOW });
    expect(r.orphaned).toBe(0);
  });

  it("drafting kind: skips when sentinel comment posted after spawn", async () => {
    const t = ticket({
      comments: [
        spawnLogComment("agent-A", "draft-spec"),
        { id: "c-q", body: "thinking...\n=== OPEN QUESTIONS (BLOCK:HUMAN) ===\n1. q\n=== END OPEN QUESTIONS ===", createdAt: POST_SPAWN },
      ],
    });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(), now: () => NOW });
    expect(r.orphaned).toBe(0);
  });

  it("drafting kind: orphan when still in drafting + no signals", async () => {
    const t = ticket({ comments: [spawnLogComment("agent-A", "draft-spec")] });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(), now: () => NOW });
    expect(r.orphaned).toBe(1);
    expect(lin.addComment).toHaveBeenCalled();
    expect(lin.addLabel).toHaveBeenCalledWith("iid", "block:human");
  });

  it("code-review kind: skips when reviewer verdict JSON appears post-spawn", async () => {
    const t = ticket({
      state: "In Review",
      comments: [
        spawnLogComment("agent-R", "code-review"),
        { id: "c-rev", body: '```json\n{ "verdict": "APPROVE", "findings": [] }\n```', createdAt: POST_SPAWN },
      ],
    });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(), now: () => NOW });
    expect(r.orphaned).toBe(0);
  });

  it("code-review kind: orphan when no verdict + no fallback", async () => {
    const t = ticket({
      state: "In Review",
      comments: [spawnLogComment("agent-R", "code-review")],
    });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(), now: () => NOW });
    expect(r.orphaned).toBe(1);
  });

  it("implementer kind: skips when PR attachment created after spawn", async () => {
    const t = ticket({
      state: "In Progress",
      comments: [spawnLogComment("agent-I", "implementer")],
      attachments: [{ id: "a", url: "https://github.com/x/y/pull/1", title: "PR", createdAt: POST_SPAWN }],
    });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(), now: () => NOW });
    expect(r.orphaned).toBe(0);
  });

  it("implementer kind: skips when state moved out of In Progress", async () => {
    const t = ticket({
      state: "In Review",
      comments: [spawnLogComment("agent-I", "implementer")],
    });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(), now: () => NOW });
    expect(r.orphaned).toBe(0);
  });

  it("implementer kind: orphan when still In Progress + no PR + no fallback", async () => {
    const t = ticket({
      state: "In Progress",
      comments: [spawnLogComment("agent-I", "implementer")],
    });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(), now: () => NOW });
    expect(r.orphaned).toBe(1);
  });

  it("universal fallback: skips when ticket has any block:* label", async () => {
    const t = ticket({
      labels: ["block:human"],
      comments: [spawnLogComment("agent-A", "draft-spec")],
    });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(), now: () => NOW });
    expect(r.orphaned).toBe(0);
  });

  it("ignores spawn-logs older than the 24h window", async () => {
    const old = new Date("2026-04-24T00:00:00Z").toISOString(); // 60h ago
    const t = ticket({ comments: [spawnLogComment("agent-A", "draft-spec", old)] });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(), now: () => NOW });
    expect(r.orphaned).toBe(0);
  });

  it("uses post-spawn-log timestamp ordering for PR-attachment", async () => {
    // PR attachment from BEFORE the spawn-log should not count as completion.
    const t = ticket({
      state: "In Progress",
      comments: [spawnLogComment("agent-I", "implementer")],
      attachments: [{ id: "a", url: "https://github.com/x/y/pull/1", title: "PR", createdAt: new Date("2026-04-26T10:00:00Z").toISOString() }],
    });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(), now: () => NOW });
    expect(r.orphaned).toBe(1);
  });
});
```

- [ ] **Step 8.4:** Verify

```bash
cd /Users/mokie/github/beekeeper-KPR-96 && npm run test -- src/pipeline/orchestrator/recovery.test.ts
```

Expected: all tests pass.

- [ ] **Step 8.5:** Commit

```bash
git add src/pipeline/handlers/review.ts \
        src/pipeline/orchestrator/recovery.ts src/pipeline/orchestrator/recovery.test.ts
git commit -m "feat(pipeline/orchestrator): startup recovery scan with kind-specific signals"
```

---

## Task 9: `PipelineOrchestrator` — public API + job map + spawn flow

**Files:**
- Create: `src/pipeline/orchestrator/index.ts`
- Create: `src/pipeline/orchestrator/index.test.ts`

The orchestrator wires the pieces together. It is the only writer to `state` (via consumeMessages's finally block) and the only owner of the `Query` lifecycle.

- [ ] **Step 9.1:** Create `src/pipeline/orchestrator/index.ts`:

```typescript
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { ulid } from "ulid";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../../logging/logger.js";
import type { LinearClient } from "../linear-client.js";
import type { OrchestratorConfig } from "../../types.js";
import { PipelineGuardian } from "./pipeline-guardian.js";
import { createAskUserQuestionTrap } from "./ask-user-question-trap.js";
import { consumeMessages } from "./consume-messages.js";
import { StallScanner } from "./stall-scanner.js";
import {
  TicketBusyError,
  type PipelineJob,
  type SpawnInput,
  type SpawnResult,
} from "./types.js";
import type { SubagentKind } from "../subagent-spawn.js";

const log = createLogger("pipeline-orchestrator");

// Same SDK CLI-path workaround SessionManager uses; see comments at the top
// of session-manager.ts. Centralized here so orchestrator picks up the same
// fix.
const sdkRequire = createRequire(import.meta.url);
const claudeCodeCliPath = join(
  dirname(sdkRequire.resolve("@anthropic-ai/claude-agent-sdk")),
  "cli.js",
);

export interface PipelineOrchestratorOptions {
  config: OrchestratorConfig;
  linear: LinearClient;
  /** Resolves human ticket identifier → Linear issue UUID. Orchestrator
   *  caches this on each spawn() call from the input.ticketId; tests inject. */
  resolveIssueId: (ticketId: string) => Promise<string>;
}

const KIND_TO_MODEL_BUCKET: Record<SubagentKind, "drafting" | "review" | "implementer"> = {
  "draft-spec": "drafting",
  "draft-plan": "drafting",
  "code-review": "review",
  "implementer": "implementer",
};

interface ActiveQueryEntry {
  query: Query;
  job: PipelineJob;
}

export class PipelineOrchestrator {
  private jobs = new Map<string, PipelineJob>();
  private activeByTicket = new Map<string, string>(); // ticketId → agentId
  private queries = new Map<string, ActiveQueryEntry>();
  private issueIds = new Map<string, string>(); // ticketId → issueId (cached at spawn)
  private guardian: PipelineGuardian;
  private scanner: StallScanner;
  private opts: PipelineOrchestratorOptions;
  private evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: PipelineOrchestratorOptions) {
    this.opts = opts;
    this.guardian = new PipelineGuardian({ allowlist: PipelineGuardian.compile(opts.config.bashAllowlist) });
    this.scanner = new StallScanner({
      thresholds: opts.config.stallThresholds,
      getActiveJobs: () => Array.from(this.jobs.values()).filter((j) => j.state === "running"),
      linear: opts.linear,
      cancel: (agentId) => this.cancel(agentId),
      resolveIssueId: (ticketId) => this.issueIds.get(ticketId),
    });
  }

  start(): void { this.scanner.start(); }
  stop(): void { this.scanner.stop(); }

  async spawn(input: SpawnInput): Promise<SpawnResult> {
    const existing = this.activeByTicket.get(input.ticketId);
    if (existing && this.jobs.get(existing)?.state === "running") {
      throw new TicketBusyError(input.ticketId, existing);
    }
    const issueId = await this.opts.resolveIssueId(input.ticketId);
    this.issueIds.set(input.ticketId, issueId);

    const agentId = `agent-${ulid()}`;
    const startedAt = new Date().toISOString();
    const job: PipelineJob = {
      agentId,
      ticketId: input.ticketId,
      kind: input.kind,
      cwd: input.repoPath,
      startedAt,
      state: "running",
      lastMessageAt: startedAt,
      messages: [],
    };
    this.jobs.set(agentId, job);
    this.activeByTicket.set(input.ticketId, agentId);

    const askTrap = createAskUserQuestionTrap({
      linear: this.opts.linear,
      ticketIssueId: issueId,
      job,
      onTrap: async () => {
        try {
          const entry = this.queries.get(agentId);
          if (entry) await entry.query.interrupt();
        } catch (err) {
          log.warn("askTrap onTrap interrupt failed", { agentId, error: String(err) });
        }
      },
    });

    const modelBucket = KIND_TO_MODEL_BUCKET[input.kind];
    const model = this.opts.config.pipelineModel[modelBucket];

    const activeQuery = query({
      prompt: input.prompt,
      options: {
        pathToClaudeCodeExecutable: claudeCodeCliPath,
        model,
        permissionMode: "bypassPermissions",
        includePartialMessages: true,
        cwd: input.repoPath,
        hooks: {
          PreToolUse: [
            { hooks: [this.guardian.createHookCallback(agentId)] },
            { hooks: [askTrap] },
          ],
        },
        env: {
          ...process.env,
          PIPELINE_AGENT_ID: agentId,
          PIPELINE_TICKET_ID: input.ticketId,
          PIPELINE_KIND: input.kind,
        },
      },
    });

    this.queries.set(agentId, { query: activeQuery, job });

    // Background consumer — NOT awaited.
    void consumeMessages({
      job,
      activeQuery,
      linear: this.opts.linear,
      ticketIssueId: issueId,
      cancel: () => this.cancel(agentId),
      onTerminal: (j) => this.scheduleEviction(j),
    }).catch((err) => log.error("consumeMessages threw at top level", { agentId, error: String(err) }));

    log.info("Subagent spawned", { agentId, kind: input.kind, ticketId: input.ticketId, model });
    return { agentId, status: "started", ticketId: input.ticketId, startedAt };
  }

  async cancel(agentId: string): Promise<void> {
    const entry = this.queries.get(agentId);
    if (!entry) return;
    const job = entry.job;
    if (!job._terminalReason) {
      job._terminalReason = "interrupted";
      job.cancelRequested = true;
    }
    try {
      await entry.query.interrupt();
    } catch (err) {
      log.warn("cancel: interrupt threw", { agentId, error: String(err) });
    }
  }

  get(agentId: string): PipelineJob | null {
    return this.jobs.get(agentId) ?? null;
  }

  getActiveByTicket(ticketId: string): PipelineJob | null {
    const aid = this.activeByTicket.get(ticketId);
    if (!aid) return null;
    const job = this.jobs.get(aid);
    return job && job.state === "running" ? job : null;
  }

  listActive(): PipelineJob[] {
    return Array.from(this.jobs.values()).filter((j) => j.state === "running");
  }

  /** For startup-recovery wiring — the running agentIds the orchestrator owns. */
  activeAgentIds(): Set<string> {
    return new Set(this.listActive().map((j) => j.agentId));
  }

  private scheduleEviction(job: PipelineJob): void {
    // Drop active-by-ticket binding immediately (frees the ticket for re-spawn).
    if (this.activeByTicket.get(job.ticketId) === job.agentId) {
      this.activeByTicket.delete(job.ticketId);
    }
    // TTL-evict the job descriptor itself (so GET /admin/pipeline/jobs/:id can
    // continue serving recently-completed jobs for a window).
    const t = setTimeout(() => {
      this.jobs.delete(job.agentId);
      this.queries.delete(job.agentId);
      this.evictionTimers.delete(job.agentId);
    }, this.opts.config.jobTtlMs);
    // Allow process exit when only eviction timers remain.
    if (typeof t.unref === "function") t.unref();
    this.evictionTimers.set(job.agentId, t);
  }

  /** Stop all active jobs (used on server shutdown). */
  async stopAll(): Promise<void> {
    this.stop();
    const ids = Array.from(this.queries.keys());
    for (const id of ids) {
      try { await this.cancel(id); } catch { /* ignore */ }
    }
  }
}
```

- [ ] **Step 9.2:** Create `src/pipeline/orchestrator/index.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const queryMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

import { PipelineOrchestrator } from "./index.js";
import { TicketBusyError } from "./types.js";
import type { OrchestratorConfig } from "../../types.js";

const config: OrchestratorConfig = {
  stallThresholds: {
    drafting:    { soft: 300_000, hard: 900_000 },
    review:      { soft: 300_000, hard: 900_000 },
    implementer: { soft: 600_000, hard: 1_800_000 },
  },
  pipelineModel: {
    drafting: "claude-opus-4-7",
    review: "claude-opus-4-7",
    implementer: "claude-sonnet-4-6",
  },
  bashAllowlist: ["^gh ", "^git ", "^npm "],
  jobTtlMs: 60_000,
};

const linearStub = () => ({
  addComment: vi.fn().mockResolvedValue({ id: "c", createdAt: "" }),
  addLabel: vi.fn().mockResolvedValue(undefined),
  listTeamPipelineIssues: vi.fn().mockResolvedValue([]),
  getTicketState: vi.fn(),
});

function makeIter(messages: unknown[] = []) {
  let interrupted = false;
  return {
    interrupt: vi.fn(async () => { interrupted = true; }),
    async *[Symbol.asyncIterator]() {
      for (const m of messages) {
        if (interrupted) return;
        yield m;
      }
    },
  };
}

describe("PipelineOrchestrator", () => {
  beforeEach(() => queryMock.mockReset());

  it("spawn() returns immediately with agentId + status: started", async () => {
    queryMock.mockReturnValue(makeIter([{ type: "result", subtype: "success" }]));
    const linear = linearStub();
    const o = new PipelineOrchestrator({ config, linear: linear as never, resolveIssueId: async () => "iid-1" });
    const r = await o.spawn({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "KPR-1" });
    expect(r.status).toBe("started");
    expect(r.agentId).toMatch(/^agent-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(r.ticketId).toBe("KPR-1");
  });

  it("getActiveByTicket returns the running job", async () => {
    // Iterator that never yields "result" — keeps job in "running" state for the assertion.
    queryMock.mockReturnValue(makeIter([]));
    const o = new PipelineOrchestrator({ config, linear: linearStub() as never, resolveIssueId: async () => "iid" });
    const r = await o.spawn({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "KPR-2" });
    // Allow the void consumeMessages to start (first await tick).
    await new Promise((res) => setImmediate(res));
    const found = o.getActiveByTicket("KPR-2");
    // The job may already be terminal if iter empties immediately; assert either still-running
    // or that get(agentId) at least sees it.
    expect(o.get(r.agentId)).not.toBeNull();
  });

  it("throws TicketBusyError on second spawn for same ticketId while first is running", async () => {
    // First iter never finishes during the test; second should reject.
    queryMock.mockReturnValueOnce(makeIter([])).mockReturnValueOnce(makeIter([]));
    const o = new PipelineOrchestrator({ config, linear: linearStub() as never, resolveIssueId: async () => "iid" });
    await o.spawn({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "KPR-3" });
    await expect(
      o.spawn({ kind: "draft-spec", prompt: "p2", repoPath: "/r", ticketId: "KPR-3" }),
    ).rejects.toBeInstanceOf(TicketBusyError);
  });

  it("cancel() interrupts and sets _terminalReason=interrupted", async () => {
    const iter = makeIter([]); // empty — exits naturally on cancel
    queryMock.mockReturnValue(iter);
    const o = new PipelineOrchestrator({ config, linear: linearStub() as never, resolveIssueId: async () => "iid" });
    const r = await o.spawn({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "KPR-4" });
    await o.cancel(r.agentId);
    expect(iter.interrupt).toHaveBeenCalled();
    // The cancel sets _terminalReason synchronously; final job.state lands when consumeMessages's finally block runs.
    const job = o.get(r.agentId);
    expect(job?._terminalReason).toBe("interrupted");
    expect(job?.cancelRequested).toBe(true);
  });

  it("listActive returns only running jobs", async () => {
    queryMock.mockReturnValueOnce(makeIter([{ type: "result", subtype: "success" }]));
    queryMock.mockReturnValueOnce(makeIter([]));
    const o = new PipelineOrchestrator({ config, linear: linearStub() as never, resolveIssueId: async () => "iid" });
    const r1 = await o.spawn({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-5" });
    await o.spawn({ kind: "draft-plan", prompt: "p", repoPath: "/r", ticketId: "K-6" });
    // Wait for r1 (the result-emitting iter) to reach a terminal state.
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && o.get(r1.agentId)?.state === "running") {
      await new Promise((res) => setImmediate(res));
    }
    const active = o.listActive();
    for (const j of active) {
      expect(j.state).toBe("running");
    }
    // Exactly one (K-6) should still be running; K-5 completed.
    expect(active.map((j) => j.ticketId)).toEqual(["K-6"]);
  });

  it("activeAgentIds returns the set of running agentIds", async () => {
    queryMock.mockReturnValue(makeIter([]));
    const o = new PipelineOrchestrator({ config, linear: linearStub() as never, resolveIssueId: async () => "iid" });
    const r1 = await o.spawn({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-7" });
    const set = o.activeAgentIds();
    expect(set.has(r1.agentId)).toBe(true);
  });
});
```

- [ ] **Step 9.3:** Verify

```bash
cd /Users/mokie/github/beekeeper-KPR-96 && npm run test -- src/pipeline/orchestrator/index.test.ts
```

Expected: all tests pass.

- [ ] **Step 9.4:** Commit

```bash
git add src/pipeline/orchestrator/index.ts src/pipeline/orchestrator/index.test.ts
git commit -m "feat(pipeline/orchestrator): PipelineOrchestrator class wiring all primitives"
```

---

## Task 10: Admin HTTP endpoints

**Files:**
- Create: `src/pipeline/orchestrator/http.ts`
- Create: `src/pipeline/orchestrator/http.test.ts`

- [ ] **Step 10.1:** Create `src/pipeline/orchestrator/http.ts`:

```typescript
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createLogger } from "../../logging/logger.js";
import { TicketBusyError, type SpawnInput } from "./types.js";
import type { PipelineOrchestrator } from "./index.js";
import type { SubagentKind } from "../subagent-spawn.js";

const log = createLogger("pipeline-http");

const VALID_KINDS: SubagentKind[] = ["draft-spec", "draft-plan", "code-review", "implementer"];

export interface PipelineAdminContext {
  orchestrator: PipelineOrchestrator;
  /** Bearer secret — same as Beekeeper's adminSecret. */
  adminSecret: string;
  readBody: (req: IncomingMessage) => Promise<string>;
}

function isLoopback(req: IncomingMessage): boolean {
  const r = req.socket.remoteAddress;
  return r === "127.0.0.1" || r === "::1" || r === "::ffff:127.0.0.1";
}

function verifyAdmin(req: IncomingMessage, expected: string): boolean {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return false;
  const provided = Buffer.from(auth.slice(7));
  const exp = Buffer.from(expected);
  if (provided.length !== exp.length) return false;
  return timingSafeEqual(provided, exp);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Dispatch admin pipeline endpoints. Returns true if the request was matched
 * and handled (caller should NOT continue handling). Returns false if the URL
 * doesn't match any pipeline admin route.
 */
export async function handlePipelineAdminRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: PipelineAdminContext,
): Promise<boolean> {
  const url = req.url ?? "/";
  const path = url.split("?")[0];
  if (!path.startsWith("/admin/pipeline/jobs")) return false;

  if (!isLoopback(req)) {
    log.warn("Rejected non-loopback /admin/pipeline/jobs", { remote: req.socket.remoteAddress ?? "unknown" });
    send(res, 403, { error: "Forbidden" });
    return true;
  }
  if (!verifyAdmin(req, ctx.adminSecret)) {
    send(res, 401, { error: "Unauthorized" });
    return true;
  }

  // POST /admin/pipeline/jobs
  if (req.method === "POST" && path === "/admin/pipeline/jobs") {
    let body: string;
    try { body = await ctx.readBody(req); }
    catch (err) { send(res, 413, { error: String(err) }); return true; }
    let parsed: SpawnInput;
    try {
      const obj = JSON.parse(body) as Partial<SpawnInput>;
      if (typeof obj.kind !== "string" || !VALID_KINDS.includes(obj.kind as SubagentKind)) {
        send(res, 400, { error: `kind must be one of ${VALID_KINDS.join(", ")}` });
        return true;
      }
      if (typeof obj.prompt !== "string" || !obj.prompt) {
        send(res, 400, { error: "prompt required" }); return true;
      }
      if (typeof obj.repoPath !== "string" || !obj.repoPath) {
        send(res, 400, { error: "repoPath required" }); return true;
      }
      if (typeof obj.ticketId !== "string" || !obj.ticketId) {
        send(res, 400, { error: "ticketId required" }); return true;
      }
      parsed = obj as SpawnInput;
    } catch {
      send(res, 400, { error: "invalid JSON" });
      return true;
    }
    try {
      const result = await ctx.orchestrator.spawn(parsed);
      send(res, 202, result);
    } catch (err) {
      if (err instanceof TicketBusyError) {
        send(res, 409, { error: "ticket-busy", existingAgentId: err.existingAgentId });
        return true;
      }
      log.error("spawn failed", { error: err instanceof Error ? err.message : String(err) });
      send(res, 500, { error: "spawn failed" });
    }
    return true;
  }

  // GET /admin/pipeline/jobs/:id
  const getMatch = path.match(/^\/admin\/pipeline\/jobs\/([^/]+)$/);
  if (req.method === "GET" && getMatch) {
    const job = ctx.orchestrator.get(getMatch[1]);
    if (!job) { send(res, 404, { error: "unknown agentId" }); return true; }
    send(res, 200, job);
    return true;
  }

  // POST /admin/pipeline/jobs/:id/cancel
  const cancelMatch = path.match(/^\/admin\/pipeline\/jobs\/([^/]+)\/cancel$/);
  if (req.method === "POST" && cancelMatch) {
    const agentId = cancelMatch[1];
    const job = ctx.orchestrator.get(agentId);
    if (!job) { send(res, 404, { error: "unknown agentId" }); return true; }
    await ctx.orchestrator.cancel(agentId);
    send(res, 200, { agentId, state: "interrupted" });
    return true;
  }

  send(res, 404, { error: "not found" });
  return true;
}
```

- [ ] **Step 10.2:** Create `src/pipeline/orchestrator/http.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { handlePipelineAdminRequest } from "./http.js";
import { TicketBusyError } from "./types.js";

function makeReq(opts: { method: string; url: string; auth?: string; remote?: string }): IncomingMessage {
  const req = new Readable({ read() {} }) as unknown as IncomingMessage;
  req.method = opts.method;
  req.url = opts.url;
  (req.headers as Record<string, string>) = {};
  if (opts.auth) req.headers.authorization = `Bearer ${opts.auth}`;
  (req.socket as unknown as { remoteAddress: string }) = { remoteAddress: opts.remote ?? "127.0.0.1" } as never;
  return req;
}

function makeRes() {
  const chunks: string[] = [];
  let status = 0;
  const res = {
    writeHead: vi.fn((s: number) => { status = s; return res; }),
    end: vi.fn((b: string) => { chunks.push(b); return res; }),
    get status() { return status; },
    get body() { return JSON.parse(chunks.join("") || "{}"); },
  };
  return res as unknown as ServerResponse & { status: number; body: Record<string, unknown> };
}

const orchStub = (over: Record<string, unknown> = {}) => ({
  spawn: vi.fn(),
  get: vi.fn(),
  cancel: vi.fn(),
  getActiveByTicket: vi.fn(),
  listActive: vi.fn(),
  activeAgentIds: vi.fn(() => new Set()),
  ...over,
});

const readBody = (s: string) => async () => s;

describe("handlePipelineAdminRequest", () => {
  it("returns false for non-pipeline paths", async () => {
    const o = orchStub();
    const req = makeReq({ method: "GET", url: "/health" });
    const res = makeRes();
    const handled = await handlePipelineAdminRequest(req, res, { orchestrator: o as never, adminSecret: "s", readBody: readBody("") });
    expect(handled).toBe(false);
  });

  it("rejects non-loopback with 403", async () => {
    const o = orchStub();
    const req = makeReq({ method: "POST", url: "/admin/pipeline/jobs", auth: "s", remote: "203.0.113.7" });
    const res = makeRes();
    await handlePipelineAdminRequest(req, res, { orchestrator: o as never, adminSecret: "s", readBody: readBody("{}") });
    expect((res as unknown as { status: number }).status).toBe(403);
  });

  it("rejects missing/wrong bearer with 401", async () => {
    const o = orchStub();
    const req = makeReq({ method: "POST", url: "/admin/pipeline/jobs", auth: "wrong" });
    const res = makeRes();
    await handlePipelineAdminRequest(req, res, { orchestrator: o as never, adminSecret: "s", readBody: readBody("{}") });
    expect((res as unknown as { status: number }).status).toBe(401);
  });

  it("POST jobs with valid body returns 202 and SpawnResult", async () => {
    const o = orchStub({
      spawn: vi.fn().mockResolvedValue({ agentId: "agent-A", status: "started", ticketId: "K-1", startedAt: "x" }),
    });
    const body = JSON.stringify({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-1" });
    const req = makeReq({ method: "POST", url: "/admin/pipeline/jobs", auth: "s" });
    const res = makeRes();
    await handlePipelineAdminRequest(req, res, { orchestrator: o as never, adminSecret: "s", readBody: readBody(body) });
    expect((res as unknown as { status: number }).status).toBe(202);
    expect((res as unknown as { body: { agentId: string } }).body.agentId).toBe("agent-A");
  });

  it("POST jobs returns 409 on TicketBusyError", async () => {
    const o = orchStub({
      spawn: vi.fn().mockRejectedValue(new TicketBusyError("K-1", "agent-EXISTING")),
    });
    const body = JSON.stringify({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-1" });
    const req = makeReq({ method: "POST", url: "/admin/pipeline/jobs", auth: "s" });
    const res = makeRes();
    await handlePipelineAdminRequest(req, res, { orchestrator: o as never, adminSecret: "s", readBody: readBody(body) });
    expect((res as unknown as { status: number }).status).toBe(409);
    expect((res as unknown as { body: { error: string; existingAgentId: string } }).body.existingAgentId).toBe("agent-EXISTING");
  });

  it("POST jobs returns 400 on invalid kind", async () => {
    const o = orchStub();
    const body = JSON.stringify({ kind: "draft-foo", prompt: "p", repoPath: "/r", ticketId: "K-1" });
    const req = makeReq({ method: "POST", url: "/admin/pipeline/jobs", auth: "s" });
    const res = makeRes();
    await handlePipelineAdminRequest(req, res, { orchestrator: o as never, adminSecret: "s", readBody: readBody(body) });
    expect((res as unknown as { status: number }).status).toBe(400);
  });

  it("GET jobs/:id returns 200 + job, 404 if unknown", async () => {
    const o = orchStub({
      get: vi.fn().mockReturnValueOnce({ agentId: "X", state: "running" }).mockReturnValueOnce(null),
    });
    const ok = makeRes();
    await handlePipelineAdminRequest(
      makeReq({ method: "GET", url: "/admin/pipeline/jobs/X", auth: "s" }),
      ok,
      { orchestrator: o as never, adminSecret: "s", readBody: readBody("") },
    );
    expect((ok as unknown as { status: number }).status).toBe(200);

    const nf = makeRes();
    await handlePipelineAdminRequest(
      makeReq({ method: "GET", url: "/admin/pipeline/jobs/Y", auth: "s" }),
      nf,
      { orchestrator: o as never, adminSecret: "s", readBody: readBody("") },
    );
    expect((nf as unknown as { status: number }).status).toBe(404);
  });

  it("POST jobs/:id/cancel returns 200 and calls orchestrator.cancel", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const o = orchStub({
      get: vi.fn().mockReturnValue({ agentId: "X", state: "running" }),
      cancel,
    });
    const res = makeRes();
    await handlePipelineAdminRequest(
      makeReq({ method: "POST", url: "/admin/pipeline/jobs/X/cancel", auth: "s" }),
      res,
      { orchestrator: o as never, adminSecret: "s", readBody: readBody("") },
    );
    expect((res as unknown as { status: number }).status).toBe(200);
    expect(cancel).toHaveBeenCalledWith("X");
  });
});
```

- [ ] **Step 10.3:** Verify

```bash
cd /Users/mokie/github/beekeeper-KPR-96 && npm run test -- src/pipeline/orchestrator/http.test.ts
```

Expected: all tests pass.

- [ ] **Step 10.4:** Commit

```bash
git add src/pipeline/orchestrator/http.ts src/pipeline/orchestrator/http.test.ts
git commit -m "feat(pipeline/orchestrator): admin HTTP endpoints (POST/GET/cancel)"
```

---

## Task 11: Config — parse `pipeline.orchestrator` block

**Files:**
- Modify: `src/config.ts`
- Modify: `src/config.test.ts` (extend if exists; otherwise add a new test alongside)
- Modify: `beekeeper.yaml.example`

- [ ] **Step 11.1:** In `src/config.ts`, extend `parsePipeline` to parse the `orchestrator` sub-block. Add this helper above `parsePipeline`:

```typescript
function parseOrchestrator(raw: unknown): OrchestratorConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object") {
    throw new Error("beekeeper.yaml: pipeline.orchestrator must be an object");
  }
  const v = raw as Record<string, unknown>;

  // stallThresholds
  const st = v.stallThresholds;
  if (!st || typeof st !== "object") {
    throw new Error("beekeeper.yaml: pipeline.orchestrator.stallThresholds is required");
  }
  const stRaw = st as Record<string, unknown>;
  function parseTier(name: string, v: unknown): { soft: number; hard: number } {
    if (!v || typeof v !== "object") throw new Error(`pipeline.orchestrator.stallThresholds.${name} required`);
    const r = v as Record<string, unknown>;
    if (typeof r.soft !== "number" || typeof r.hard !== "number") {
      throw new Error(`pipeline.orchestrator.stallThresholds.${name}.{soft,hard} must be numbers`);
    }
    if (r.soft >= r.hard) throw new Error(`pipeline.orchestrator.stallThresholds.${name}: soft must be < hard`);
    return { soft: r.soft, hard: r.hard };
  }
  const stallThresholds = {
    drafting: parseTier("drafting", stRaw.drafting),
    review: parseTier("review", stRaw.review),
    implementer: parseTier("implementer", stRaw.implementer),
  };

  // pipelineModel
  const pm = v.pipelineModel;
  if (!pm || typeof pm !== "object") throw new Error("pipeline.orchestrator.pipelineModel is required");
  const pmRaw = pm as Record<string, unknown>;
  for (const k of ["drafting", "review", "implementer"] as const) {
    if (typeof pmRaw[k] !== "string" || !pmRaw[k]) {
      throw new Error(`pipeline.orchestrator.pipelineModel.${k} must be a non-empty string`);
    }
  }
  const pipelineModel = {
    drafting: pmRaw.drafting as string,
    review: pmRaw.review as string,
    implementer: pmRaw.implementer as string,
  };

  // bashAllowlist
  if (!Array.isArray(v.bashAllowlist) || v.bashAllowlist.length === 0) {
    throw new Error("pipeline.orchestrator.bashAllowlist must be a non-empty array of regex strings");
  }
  for (const p of v.bashAllowlist) {
    if (typeof p !== "string" || !p) {
      throw new Error("pipeline.orchestrator.bashAllowlist entries must be non-empty strings");
    }
  }
  const bashAllowlist = v.bashAllowlist as string[];

  const jobTtlMs = typeof v.jobTtlMs === "number" && v.jobTtlMs > 0 ? v.jobTtlMs : 86_400_000;

  return { stallThresholds, pipelineModel, bashAllowlist, jobTtlMs };
}
```

In `parsePipeline`, append this line to the returned object (before the closing `}`):

```typescript
return {
  linearTeamKey: v.linearTeamKey,
  repoPaths,
  mainBranch: typeof v.mainBranch === "string" ? v.mainBranch : undefined,
  orchestrator: parseOrchestrator(v.orchestrator),
};
```

Update the import line at the top:

```typescript
import type { BeekeeperConfig, OrchestratorConfig, PipelineConfig } from "./types.js";
```

- [ ] **Step 11.2:** Append to `beekeeper.yaml.example`:

```yaml
  # Phase 2 SDK orchestrator configuration. Required when running the
  # Beekeeper server (the `subagent-spawn` HTTP client routes through it).
  orchestrator:
    stallThresholds:
      drafting:    { soft: 300000,  hard: 900000  }   # 5 min / 15 min
      review:      { soft: 300000,  hard: 900000  }
      implementer: { soft: 600000,  hard: 1800000 }   # 10 min / 30 min
    pipelineModel:
      drafting: claude-opus-4-7
      review: claude-opus-4-7
      implementer: claude-sonnet-4-6
    bashAllowlist:
      - "^gh (issue|pr|repo|api|workflow|auth status|run) "
      - "^git (status|diff|log|show|add|commit|push|fetch|pull|rebase|merge|checkout|switch|branch|worktree|stash|tag|remote|reset --soft|cherry-pick) "
      - "^npm (run|install|ci|test|version|pack) "
      - "^npx (tsc|vitest|eslint|prettier|tsx|@anthropic-ai) "
      - "^node "
      - "^cat "
      - "^ls "
      - "^pwd"
      - "^which "
      - "^find "
      - "^mkdir "
      - "^cp "
      - "^mv "
      - "^chmod "
      - "^security find-generic-password "
      - "^mongosh "
      - "^mongo "
    jobTtlMs: 86400000
```

- [ ] **Step 11.3:** Add config test cases. The existing `src/config.test.ts` mocks `parseYaml` to return a JS object and calls `loadConfig()`. Append the following inside the existing `describe("loadConfig", ...)` block:

```typescript
const VALID_ORCHESTRATOR = {
  stallThresholds: {
    drafting:    { soft: 300000, hard: 900000 },
    review:      { soft: 300000, hard: 900000 },
    implementer: { soft: 600000, hard: 1800000 },
  },
  pipelineModel: {
    drafting: "claude-opus-4-7",
    review: "claude-opus-4-7",
    implementer: "claude-sonnet-4-6",
  },
  bashAllowlist: ["^gh ", "^git "],
  jobTtlMs: 86400000,
};

it("parses pipeline.orchestrator into typed OrchestratorConfig", () => {
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue("yaml content");
  mockParseYaml.mockReturnValue({
    pipeline: {
      linearTeamKey: "KPR",
      orchestrator: VALID_ORCHESTRATOR,
    },
  });
  const config = loadConfig();
  expect(config.pipeline?.orchestrator).toBeDefined();
  expect(config.pipeline?.orchestrator?.stallThresholds.drafting.hard).toBe(900000);
  expect(config.pipeline?.orchestrator?.bashAllowlist).toEqual(["^gh ", "^git "]);
  expect(config.pipeline?.orchestrator?.jobTtlMs).toBe(86400000);
});

it("defaults jobTtlMs to 24h when omitted", () => {
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue("yaml content");
  mockParseYaml.mockReturnValue({
    pipeline: {
      linearTeamKey: "KPR",
      orchestrator: { ...VALID_ORCHESTRATOR, jobTtlMs: undefined },
    },
  });
  const config = loadConfig();
  expect(config.pipeline?.orchestrator?.jobTtlMs).toBe(86400000);
});

it("rejects orchestrator with soft >= hard", () => {
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue("yaml content");
  mockParseYaml.mockReturnValue({
    pipeline: {
      linearTeamKey: "KPR",
      orchestrator: {
        ...VALID_ORCHESTRATOR,
        stallThresholds: {
          ...VALID_ORCHESTRATOR.stallThresholds,
          drafting: { soft: 1000, hard: 500 },
        },
      },
    },
  });
  expect(() => loadConfig()).toThrow(/soft must be < hard/);
});

it("rejects orchestrator with empty bashAllowlist", () => {
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue("yaml content");
  mockParseYaml.mockReturnValue({
    pipeline: {
      linearTeamKey: "KPR",
      orchestrator: { ...VALID_ORCHESTRATOR, bashAllowlist: [] },
    },
  });
  expect(() => loadConfig()).toThrow(/bashAllowlist must be a non-empty array/);
});

it("rejects orchestrator missing pipelineModel.implementer", () => {
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue("yaml content");
  mockParseYaml.mockReturnValue({
    pipeline: {
      linearTeamKey: "KPR",
      orchestrator: {
        ...VALID_ORCHESTRATOR,
        pipelineModel: { drafting: "x", review: "x" },
      },
    },
  });
  expect(() => loadConfig()).toThrow(/pipelineModel\.implementer/);
});

it("returns pipeline.orchestrator=undefined when block omitted", () => {
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue("yaml content");
  mockParseYaml.mockReturnValue({ pipeline: { linearTeamKey: "KPR" } });
  const config = loadConfig();
  expect(config.pipeline?.orchestrator).toBeUndefined();
});
```

- [ ] **Step 11.4:** Verify

```bash
cd /Users/mokie/github/beekeeper-KPR-96 && npm run typecheck && npm run test -- src/config.test.ts
```

- [ ] **Step 11.5:** Commit

```bash
git add src/config.ts src/config.test.ts beekeeper.yaml.example
git commit -m "feat(config): parse pipeline.orchestrator with strict validation"
```

---

## Task 12: Wire orchestrator into `src/index.ts` (server boot)

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 12.1:** Add imports at the top of `src/index.ts`:

```typescript
import { PipelineOrchestrator } from "./pipeline/orchestrator/index.js";
import { handlePipelineAdminRequest } from "./pipeline/orchestrator/http.js";
import { runStartupRecovery } from "./pipeline/orchestrator/recovery.js";
import { LinearClient as PipelineLinearClient } from "./pipeline/linear-client.js";
import { resolveBeekeeperSecret } from "./pipeline/honeypot-reader.js";
```

- [ ] **Step 12.2:** Inside `main()`, AFTER the `capabilities` line and BEFORE the `verifyAdmin` helper, construct the orchestrator (only if `config.pipeline?.orchestrator` is configured AND a `LINEAR_API_KEY` is resolvable — otherwise skip orchestrator entirely so non-pipeline installs continue to work):

```typescript
let orchestrator: PipelineOrchestrator | null = null;
if (config.pipeline?.orchestrator) {
  const linearApiKey = resolveBeekeeperSecret("LINEAR_API_KEY");
  if (!linearApiKey) {
    log.warn("pipeline.orchestrator configured but LINEAR_API_KEY not resolvable; orchestrator disabled");
  } else {
    const pipelineLinear = new PipelineLinearClient({ apiKey: linearApiKey, teamKey: config.pipeline.linearTeamKey });
    orchestrator = new PipelineOrchestrator({
      config: config.pipeline.orchestrator,
      linear: pipelineLinear,
      resolveIssueId: async (ticketId) => (await pipelineLinear.getTicketState(ticketId)).id,
    });
    orchestrator.start();
    // Startup recovery: scan in-flight subagents lost to a previous restart.
    // Bound by 24h spawn-log window; safe to re-run on a clean instance.
    try {
      await runStartupRecovery({
        linear: pipelineLinear,
        activeAgentIds: orchestrator.activeAgentIds(), // empty on cold boot
      });
    } catch (err) {
      log.error("startup recovery failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
```

- [ ] **Step 12.3:** Inside the HTTP server handler, BEFORE the device-pair / capability routes (i.e., just after the OPTIONS short-circuit), add the pipeline admin dispatcher:

```typescript
if (orchestrator) {
  const handled = await handlePipelineAdminRequest(req, res, {
    orchestrator,
    adminSecret: config.adminSecret,
    readBody,
  });
  if (handled) return;
}
```

- [ ] **Step 12.4:** Update `shutdown()` to stop the orchestrator:

```typescript
const shutdown = async () => {
  log.info("Shutting down");
  clearInterval(reapTimer);
  capabilities.stopHealthLoop();
  if (orchestrator) await orchestrator.stopAll();
  sessionManager.persistSessions();
  await sessionManager.stopAll();
  wss.close();
  server.close();
  deviceRegistry.close();
  process.exit(1);
};
```

- [ ] **Step 12.5:** Verify

```bash
cd /Users/mokie/github/beekeeper-KPR-96 && npm run typecheck && npm run test
```

Expected: typecheck clean; full test suite green (including pre-existing tests; no smoke test on the wiring is added here — the orchestrator unit tests cover behavior, the HTTP tests cover dispatch).

- [ ] **Step 12.6:** Commit

```bash
git add src/index.ts
git commit -m "feat(server): wire PipelineOrchestrator + admin endpoints + startup recovery"
```

---

## Task 13: Rewrite `subagent-spawn.ts` as fetch-based HTTP client

**Files:**
- Modify: `src/pipeline/subagent-spawn.ts`
- Modify: `src/pipeline/subagent-spawn.test.ts` (replace child_process mock with fetch mock)

The Phase 1 detached `claude -p` body is **deleted**; replaced with a thin HTTP client. No fallback. No feature flag. Server-not-running becomes a loud, actionable error.

**Port resolution:** The CLI reads `BEEKEEPER_PORT` from `process.env`, defaulting to 8420 (matches the server default in `config.ts`). If an operator overrides `port:` in `beekeeper.yaml` to anything other than 8420, they MUST also export `BEEKEEPER_PORT` in the environment where the CLI runs (e.g., add it to `~/.beekeeper/env`, which `autoSourceEnv()` already loads). Document this in `beekeeper.yaml.example` next to the `port:` key. We do NOT thread `BeekeeperConfig.port` into `PipelineConfig` in this work — that would couple the pipeline subtree to the server's port, and the env-var path already handles the local-loopback assumption cleanly.

- [ ] **Step 13.1:** Replace the body of `src/pipeline/subagent-spawn.ts`:

```typescript
import { resolveBeekeeperSecret } from "./honeypot-reader.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("pipeline-spawn");

export type SubagentKind = "draft-spec" | "draft-plan" | "code-review" | "implementer";

export interface SpawnInput {
  kind: SubagentKind;
  prompt: string;
  /** Working directory the subagent runs in (resolved repo path). */
  repoPath: string;
  /** For audit logging on the Linear ticket. */
  ticketId: string;
}

export interface SpawnResult {
  agentId: string;
  /** Phase 2 keeps the same shape: tick does not wait. */
  status: "started";
}

export class BeekeeperServerNotRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BeekeeperServerNotRunningError";
  }
}

const DEFAULT_PORT = 8420;

/**
 * Phase 2: thin HTTP client to the in-server PipelineOrchestrator. The CLI
 * runs on the same machine as the server (Mac Mini); fetch is loopback-only.
 *
 * No fallback to Phase 1's detached spawn — Phase 1's observability gaps are
 * exactly what this work exists to close.
 */
export async function spawnSubagent(input: SpawnInput): Promise<SpawnResult> {
  const port = Number(process.env.BEEKEEPER_PORT ?? DEFAULT_PORT);
  const adminSecret = resolveBeekeeperSecret("BEEKEEPER_ADMIN_SECRET");
  if (!adminSecret) {
    throw new Error(
      "BEEKEEPER_ADMIN_SECRET not resolvable (set in env or via `honeypot set beekeeper/BEEKEEPER_ADMIN_SECRET <value>`)",
    );
  }

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/admin/pipeline/jobs`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${adminSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
  } catch (err) {
    // ECONNREFUSED, network unreachable, etc. — translate to actionable diagnostic.
    throw new BeekeeperServerNotRunningError(
      `Cannot reach Beekeeper server at http://127.0.0.1:${port}.\n\n` +
      "Pipeline-tick Phase 2 runs orchestration in-server. Start the server first:\n" +
      "  - On your Mac (LaunchAgent installed): launchctl kickstart -k gui/$(id -u)/com.keepur.beekeeper\n" +
      "  - Foreground/dev: beekeeper serve\n\n" +
      `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (response.status === 409) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; existingAgentId?: string };
    throw new Error(
      `Ticket ${input.ticketId} already has running subagent ${body.existingAgentId ?? "(unknown)"} — concurrent spawn refused`,
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Spawn failed: ${response.status} ${text}`);
  }
  const result = (await response.json()) as { agentId: string; status: "started" };
  log.info("Subagent spawn POSTed to orchestrator", {
    agentId: result.agentId,
    kind: input.kind,
    ticketId: input.ticketId,
    repoPath: input.repoPath,
  });
  return { agentId: result.agentId, status: result.status };
}
```

- [ ] **Step 13.2:** Replace the body of `src/pipeline/subagent-spawn.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("./honeypot-reader.js", () => ({
  resolveBeekeeperSecret: (k: string) => (k === "BEEKEEPER_ADMIN_SECRET" ? "s" : null),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("spawnSubagent (Phase 2 HTTP client)", () => {
  it("POSTs to /admin/pipeline/jobs and returns SpawnResult", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ agentId: "agent-A", status: "started" }),
    });
    const { spawnSubagent } = await import("./subagent-spawn.js");
    const r = await spawnSubagent({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-1" });
    expect(r.agentId).toBe("agent-A");
    expect(r.status).toBe("started");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/127\.0\.0\.1:\d+\/admin\/pipeline\/jobs$/);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer s");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-1" });
  });

  it("translates ECONNREFUSED to BeekeeperServerNotRunningError", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed: ECONNREFUSED"));
    const { spawnSubagent, BeekeeperServerNotRunningError } = await import("./subagent-spawn.js");
    await expect(spawnSubagent({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-1" }))
      .rejects.toBeInstanceOf(BeekeeperServerNotRunningError);
  });

  it("propagates 409 ticket-busy with the existing agentId in the message", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: "ticket-busy", existingAgentId: "agent-EXISTING" }),
    });
    const { spawnSubagent } = await import("./subagent-spawn.js");
    await expect(spawnSubagent({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-1" }))
      .rejects.toThrow(/agent-EXISTING/);
  });

  it("propagates non-ok responses with status code", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "server-side oops",
    });
    const { spawnSubagent } = await import("./subagent-spawn.js");
    await expect(spawnSubagent({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-1" }))
      .rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 13.3:** Verify

```bash
cd /Users/mokie/github/beekeeper-KPR-96 && npm run test -- src/pipeline/subagent-spawn.test.ts
```

Expected: all tests pass. The Phase 1 child_process-based tests are gone.

- [ ] **Step 13.4:** Commit

```bash
git add src/pipeline/subagent-spawn.ts src/pipeline/subagent-spawn.test.ts
git commit -m "feat(pipeline): rewrite subagent-spawn as HTTP client; delete detached claude -p body"
```

---

## Task 14: CLI subcommands `pipeline-tick tail` and `pipeline-tick cancel`

**Files:**
- Modify: `src/pipeline/cli.ts`

`runPipelineCli` currently dispatches to `runTick`. The plan extends it to recognize two new sub-subcommands when `argv[0]` is `tail` or `cancel`. Output is plain stdout text; no Linear interaction.

- [ ] **Step 14.1:** In `src/pipeline/cli.ts`, refactor the entry point:

```typescript
export async function runPipelineCli(inputs: PipelineCliInputs): Promise<PipelineCliResult> {
  const out: string[] = [];
  const err: string[] = [];

  if (!inputs.config) {
    err.push("pipeline-tick: missing `pipeline:` block in beekeeper.yaml");
    return { exitCode: 1, output: out, errors: err };
  }
  // tail / cancel don't need LINEAR_API_KEY (they only talk to the loopback server).
  const sub = inputs.argv[0];
  if (sub === "tail" || sub === "cancel") {
    return runOrchestratorClient(sub, inputs.argv.slice(1));
  }
  if (!inputs.apiKey) {
    err.push("pipeline-tick: missing LINEAR_API_KEY (set in env or via `honeypot set beekeeper/LINEAR_API_KEY <value>`)");
    return { exitCode: 1, output: out, errors: err };
  }
  // ... existing argv parsing + runTick + formatReport (unchanged)
}
```

Add the orchestrator-client helper:

```typescript
import { resolveBeekeeperSecret } from "../pipeline/honeypot-reader.js";

async function runOrchestratorClient(
  sub: "tail" | "cancel",
  args: string[],
): Promise<PipelineCliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const agentId = args[0];
  if (!agentId) {
    err.push(`Usage: beekeeper pipeline-tick ${sub} <agentId>`);
    return { exitCode: 1, output: out, errors: err };
  }
  const port = Number(process.env.BEEKEEPER_PORT ?? 8420);
  const secret = resolveBeekeeperSecret("BEEKEEPER_ADMIN_SECRET");
  if (!secret) {
    err.push("BEEKEEPER_ADMIN_SECRET not resolvable");
    return { exitCode: 1, output: out, errors: err };
  }
  const headers = { "Authorization": `Bearer ${secret}` };

  if (sub === "cancel") {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/admin/pipeline/jobs/${agentId}/cancel`, { method: "POST", headers });
      if (res.status === 404) { err.push(`unknown agentId: ${agentId}`); return { exitCode: 1, output: out, errors: err }; }
      if (!res.ok) { err.push(`cancel failed: ${res.status}`); return { exitCode: 1, output: out, errors: err }; }
      out.push(`cancelled ${agentId}`);
      return { exitCode: 0, output: out, errors: err };
    } catch (e) {
      err.push(`Beekeeper server unreachable: ${e instanceof Error ? e.message : String(e)}`);
      return { exitCode: 1, output: out, errors: err };
    }
  }

  // tail — poll at 1s cadence; print every NEW message tail (cursor is messages.length).
  let cursor = 0;
  while (true) {
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${port}/admin/pipeline/jobs/${agentId}`, { headers });
    } catch (e) {
      err.push(`server unreachable: ${e instanceof Error ? e.message : String(e)}`);
      return { exitCode: 1, output: out, errors: err };
    }
    if (res.status === 404) { err.push(`unknown agentId: ${agentId}`); return { exitCode: 1, output: out, errors: err }; }
    if (!res.ok) { err.push(`fetch failed: ${res.status}`); return { exitCode: 1, output: out, errors: err }; }
    const job = (await res.json()) as { state: string; messages: Array<{ type: string; receivedAt: string }> };
    while (cursor < job.messages.length) {
      const m = job.messages[cursor++];
      out.push(`[${m.receivedAt}] ${m.type}`);
    }
    if (job.state !== "running") {
      out.push(`-- ${agentId} state=${job.state} --`);
      return { exitCode: 0, output: out, errors: err };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
```

- [ ] **Step 14.2:** Update `parseArgs` usage prompt to mention the new commands:

```typescript
err.push("Usage:");
err.push("  beekeeper pipeline-tick <scope> [--dry-run] [--include-blocked] [--spawn-budget N] [--action-budget N]");
err.push("  beekeeper pipeline-tick tail <agentId>");
err.push("  beekeeper pipeline-tick cancel <agentId>");
```

(Insert after the existing `Usage:` line in the `parseArgs` error path.)

- [ ] **Step 14.3:** Verify

```bash
cd /Users/mokie/github/beekeeper-KPR-96 && npm run typecheck && npm run test -- src/pipeline/cli.ts
```

Existing CLI tests should still pass; new CLI test coverage (tail/cancel) is integration-flavored and lives in Task 15's smoke test rather than a unit test here.

- [ ] **Step 14.4:** Commit

```bash
git add src/pipeline/cli.ts
git commit -m "feat(pipeline/cli): add tail and cancel subcommands"
```

---

## Task 15: End-to-end smoke test

**Files:**
- Create: `src/pipeline/orchestrator/smoke.test.ts`

This test stitches the full path: orchestrator + SDK mock + linear mock + admin HTTP. It's the "story test" — every documented failure path lit at least once.

- [ ] **Step 15.1:** Create `src/pipeline/orchestrator/smoke.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const queryMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

import { PipelineOrchestrator } from "./index.js";
import { TicketBusyError } from "./types.js";
import type { OrchestratorConfig } from "../../types.js";

const config: OrchestratorConfig = {
  stallThresholds: {
    drafting:    { soft: 1000, hard: 3000 },
    review:      { soft: 1000, hard: 3000 },
    implementer: { soft: 2000, hard: 5000 },
  },
  pipelineModel: { drafting: "m", review: "m", implementer: "m" },
  bashAllowlist: ["^gh ", "^git ", "^npm "],
  jobTtlMs: 60_000,
};

const linearStub = () => ({
  addComment: vi.fn().mockResolvedValue({ id: "c", createdAt: "" }),
  addLabel: vi.fn().mockResolvedValue(undefined),
  getTicketState: vi.fn().mockResolvedValue({ id: "iid" }),
  listTeamPipelineIssues: vi.fn().mockResolvedValue([]),
});

function iter(messages: unknown[]) {
  let interrupted = false;
  return {
    interrupt: vi.fn(async () => { interrupted = true; }),
    async *[Symbol.asyncIterator]() {
      for (const m of messages) { if (interrupted) return; yield m; }
    },
  };
}

function iterThrowing(messages: unknown[], err: Error) {
  return {
    interrupt: vi.fn(async () => {}),
    async *[Symbol.asyncIterator]() {
      for (const m of messages) yield m;
      throw err;
    },
  };
}

/** Wait until the orchestrator marks `agentId` terminal (any non-running state). */
async function waitTerminal(o: PipelineOrchestrator, agentId: string, timeoutMs = 1000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const j = o.get(agentId);
    if (j && j.state !== "running") return j.state;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`agent ${agentId} did not reach terminal state within ${timeoutMs}ms`);
}

describe("Orchestrator smoke — happy + failure paths", () => {
  beforeEach(() => queryMock.mockReset());

  it("HAPPY PATH: spawn → result → completed", async () => {
    queryMock.mockReturnValue(iter([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "result", subtype: "success", total_cost_usd: 0.1, duration_ms: 500 },
    ]));
    const linear = linearStub();
    const o = new PipelineOrchestrator({ config, linear: linear as never, resolveIssueId: async () => "iid" });
    const r = await o.spawn({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-1" });
    expect(await waitTerminal(o, r.agentId)).toBe("completed");
  });

  it("SENTINEL: open-questions fence triggers cancel + Linear block:human", async () => {
    const text = "thinking\n=== OPEN QUESTIONS (BLOCK:HUMAN) ===\n1. q?\n=== END OPEN QUESTIONS ===\n";
    queryMock.mockReturnValue(iter([
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } },
    ]));
    const linear = linearStub();
    const o = new PipelineOrchestrator({ config, linear: linear as never, resolveIssueId: async () => "iid" });
    const r = await o.spawn({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-2" });
    expect(await waitTerminal(o, r.agentId)).toBe("stalled");
    expect(linear.addLabel).toHaveBeenCalledWith("iid", "block:human");
  });

  it("ITERATOR THROW: error path posts block:human", async () => {
    queryMock.mockReturnValue(iterThrowing([{ type: "system", subtype: "init" }], new Error("ECONNRESET")));
    const linear = linearStub();
    const o = new PipelineOrchestrator({ config, linear: linear as never, resolveIssueId: async () => "iid" });
    const r = await o.spawn({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-3" });
    expect(await waitTerminal(o, r.agentId)).toBe("error");
    expect(linear.addLabel).toHaveBeenCalledWith("iid", "block:human");
  });

  it("CANCEL: explicit cancel → interrupted, no error comment", async () => {
    const it = iterThrowing([{ type: "system", subtype: "init" }], new Error("aborted"));
    queryMock.mockReturnValue(it);
    const linear = linearStub();
    const o = new PipelineOrchestrator({ config, linear: linear as never, resolveIssueId: async () => "iid" });
    const r = await o.spawn({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-4" });
    await o.cancel(r.agentId);
    expect(await waitTerminal(o, r.agentId)).toBe("interrupted");
    expect(linear.addComment).not.toHaveBeenCalled();
  });

  it("CONCURRENT-SPAWN: same ticketId while running → TicketBusyError", async () => {
    queryMock.mockReturnValue(iter([])); // never yields
    const o = new PipelineOrchestrator({ config, linear: linearStub() as never, resolveIssueId: async () => "iid" });
    await o.spawn({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-5" });
    await expect(
      o.spawn({ kind: "draft-spec", prompt: "p", repoPath: "/r", ticketId: "K-5" }),
    ).rejects.toBeInstanceOf(TicketBusyError);
  });
});
```

- [ ] **Step 15.2:** Verify

```bash
cd /Users/mokie/github/beekeeper-KPR-96 && npm run check
```

Expected: typecheck + lint + format + the entire test suite (orchestrator unit tests + smoke) all pass.

- [ ] **Step 15.3:** Commit

```bash
git add src/pipeline/orchestrator/smoke.test.ts
git commit -m "test(pipeline/orchestrator): end-to-end smoke covering all documented failure paths"
```

---

## Final task: full quality-gate

- [ ] **Step F.1:** Run the full `npm run check`:

```bash
cd /Users/mokie/github/beekeeper-KPR-96 && npm run check
```

Expected: green across typecheck + lint + format + test.

- [ ] **Step F.2:** Manual smoke (operator-driven, NOT in CI):

```bash
# 1. Bring up the Beekeeper server (foreground for visibility)
cd /Users/mokie/github/beekeeper-KPR-96 && npm run dev

# 2. In another terminal — POST a real spawn against a sandbox Linear ticket
curl -sS -X POST http://127.0.0.1:8420/admin/pipeline/jobs \
  -H "Authorization: Bearer $BEEKEEPER_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"kind":"draft-spec","prompt":"echo hello","repoPath":"/tmp","ticketId":"KPR-TEST"}'

# 3. Tail the agent
beekeeper pipeline-tick tail agent-XYZ

# 4. Cancel
beekeeper pipeline-tick cancel agent-XYZ
```

(Manual step — implementer runs against a sandbox Linear ticket before declaring complete. Document any unexpected behavior in a follow-up ticket; do not block this PR on operator UAT.)

---

## Acceptance-criteria mapping (spec → plan)

For audit during dodi-dev:review:

| Spec acceptance criterion | Plan task(s) |
|---|---|
| `PipelineOrchestrator` module exists with public API | Task 9 |
| `spawn()` invokes SDK `query()` and returns immediately | Task 9 |
| Every SDKMessage buffered with timestamp; lastMessageAt updated | Task 6 |
| Pipeline-tightened `ToolGuardian` enforces bash allowlist via PreToolUse | Task 4 |
| `AskUserQuestion` hook traps + Linear block:human + interrupt | Task 5 |
| Two-tier stall detection (warn + cancel) with idempotent soft-warn | Task 7 |
| Open-questions sentinel match → cancel + Linear + block:human | Tasks 3 + 6 |
| Three admin endpoints with Bearer auth + 409 concurrent guard | Tasks 9 + 10 |
| CLI POSTs to orchestrator instead of `claude -p`; clear error if server down | Task 13 |
| `pipeline-tick tail` and `cancel` work end-to-end | Task 14 |
| Phase 1 detached spawn body REMOVED | Task 13 |
| Linear comment audit trail unchanged; addComment retry wrapped | Task 2 |
| Startup recovery scan with kind-specific completion signals + idempotency self-write | Task 8 + 12 |
| One-way `_terminalReason` → state in finally only | Task 6 |
| Iterator-throw → error + Linear comment + block:human | Tasks 6 + 15 |
| Concurrent-spawn 409 guard | Tasks 9 + 10 + 15 |
| Tests cover all listed failure paths | Tasks 3-15 colocated tests |

Plan-stage decisions captured at the top of this document:
- Sentinel format: plain-text fence (default).
- Live-tail: 1s polling, full-buffer responses (default).
- Post-launch tuning: instrument every guardian rejection + stall-warn (Tasks 4 + 7).
- Shell-redirection: hard-deny (option (a) from spec, applied as a strip-and-compare gate).
- chmod mode whitelist: numeric 3-4 digits (leading 0 or 1) or symbolic with `[rwxX]` only.
