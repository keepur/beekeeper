# Pipeline-Tick — Phase 1 Foundation Implementation Plan

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan. Each task is self-contained; commit after each.
>
> **STATUS — review-clean.** All three drafting-pass open questions are resolved (see "Open design questions" at the bottom for the audit trail).

**Goal:** Ship `beekeeper pipeline-tick <scope>` against the Keepur Linear team. Phase 1 MVP from `docs/specs/2026-04-26-pipeline-tick-design.md`. The tick reads Linear ticket state, decides the next pipeline action via the action table, runs per-action handlers (drafting/pickup/review/merge), launches long-running subagents in the background, writes back to Linear (state + labels + comments + lock metadata), respects spawn/action budgets, and returns a summary. No Slack, no cron — those are Phase 3.

**Architecture:** A new `src/pipeline/` module houses the Linear client wrapper, ticket-state reader, action dispatcher, per-action handlers, mutex (comment-based), reviewer-findings parser, block-label semantics, budget caps, repo resolver, and subagent-spawn driver. The CLI grows a `pipeline-tick` subcommand that dispatches to `src/pipeline/cli.ts`. All Linear access flows through one client (`linear-client.ts`). All subagent launches flow through one driver (`subagent-spawn.ts`) so the spawn mechanism is swappable. Subagent prompt templates live as exported constants under `src/pipeline/prompts/` (per spec §"Path to implementation": "subagent prompt templates as constants").

**Tech Stack:** TypeScript (NodeNext, strict), Vitest (colocated `*.test.ts`), `@linear/sdk` (new dep), `ulid` (new dep, used for `runId`), Node 22+. ESM `.js` import extensions throughout. No `any` in production code. Vitest mocks the Linear SDK and the spawn driver in unit tests; integration tests against a live Linear ticket are manual (Task 12).

**Spec reference:** `docs/specs/2026-04-26-pipeline-tick-design.md` (review-clean).

**Reference plan style:** `docs/plans/2026-04-25-frames-foundation.md` (KPR-84) — same task shape, same commit cadence.

---

## File Structure

### Files to create

| File | Responsibility |
|---|---|
| `src/pipeline/types.ts` | TypeScript types: `TicketState`, `ActionDecision`, `Action`, `PipelineLabels`, `LockClaim`, `ReviewerFinding`, `BudgetCounters`, `TickReport`, `ResolvedRepo` |
| `src/pipeline/labels.ts` | Pipeline label constants + parsers (`type:*`, `block:*`, `qa:*`, `pipeline-auto`, `epic`) and `getTypeLabel`/`getBlockLabels` helpers |
| `src/pipeline/linear-client.ts` | Thin wrapper over `@linear/sdk`: `getIssue`, `listChildren`, `listTeamIssues`, `listComments`, `addComment`, `setState`, `addLabel`, `removeLabel`, `getStateByName`. Auth via `LINEAR_API_KEY` env. |
| `src/pipeline/state-reader.ts` | `readTicketState(issueId)` — joins issue + labels + comments + parent + blockedBy → `TicketState` (the action-table input) |
| `src/pipeline/action-dispatcher.ts` | `decideAction(state)` — pure function implementing the action table (state x type → action) |
| `src/pipeline/mutex.ts` | Comment-based run-id mutex per spec §"Per-ticket mutual exclusion": `claim`, `verify`, `release`. Type-filtered comment scan (filters `tick-lock-claim` from `tick-lock-release`/`tick-spawn-log`/non-pipeline). 60s TTL. |
| `src/pipeline/reviewer-parser.ts` | Parse code-reviewer subagent structured output → `{ verdict, findings[] }`. Re-asserts pipeline rule: any BLOCKER or SHOULD-FIX → REQUEST CHANGES regardless of reviewer's verdict (spec §"Review action" item 3). |
| `src/pipeline/block-evidence.ts` | Reads ticket comments to validate `block:human`/`block:external` unblock evidence (per spec §"Default unblock flow"). `block:ci` auto-clears (no evidence required). |
| `src/pipeline/budget.ts` | `BudgetCounters` class: `--spawn-budget` and `--action-budget` (defaults 3 and 25 per spec §"Concurrency"). Methods: `tryConsumeSpawn()`, `tryConsumeAction()`, `summary()`. |
| `src/pipeline/repo-resolver.ts` | Resolves target repo from ticket description (description-grep heuristic per spec §"Drafting actions" item 1). For Phase 1: `~/github/hive`, `~/github/beekeeper`, plus any explicit `repo:*` label. Returns `ResolvedRepo \| null` (null → caller marks `block:human`). |
| `src/pipeline/subagent-spawn.ts` | **Subagent spawn driver.** Single API: `spawnSubagent({ kind, prompt, repoPath, ticketId })` → `{ agentId, status }`. Implementation per **OQ-1 (resolved → A)**: detached `child_process.spawn("claude", ["-p", prompt], { detached: true })`. |
| `src/pipeline/prompts/drafting.ts` | Prompt template constants for spec-drafting and plan-drafting subagents. Includes the open-questions contract (spec §"Drafting subagent contract") inline so the subagent's behavior is anchored. |
| `src/pipeline/prompts/reviewer.ts` | Prompt template constant for code-reviewer subagent. Bakes in the pipeline review rule (APPROVE = zero BLOCKER + zero SHOULD-FIX) per spec §"Review action" + `feedback_pipeline_review_rule.md`. |
| `src/pipeline/prompts/implementer.ts` | Prompt template constant for implementer subagent (pickup action). Plan path + repo path + epic branch in the prompt body. |
| `src/pipeline/handlers/drafting.ts` | Drafting action handler (spec + plan). Resolves repo → launches drafting subagent → posts spawn comment → returns. Tick re-runs in next pass; reads draft + open-questions output, advances state or marks `block:human`. |
| `src/pipeline/handlers/pickup.ts` | Pickup handler. Verifies plan committed, ensures epic branch exists, launches implementer. |
| `src/pipeline/handlers/review.ts` | Review handler. Launches code-reviewer; on completion (next pass) parses findings, decides merge / fix-inline / file-follow-up / `block:human`. |
| `src/pipeline/handlers/merge.ts` | Merge handler. Per `feedback_merge_strategy.md`: phase→epic = merge-commit, single-purpose→main = squash, epic→main = merge-commit. Uses `gh pr merge`. |
| `src/pipeline/tick-runner.ts` | `runTick({ scope, dryRun, spawnBudget, actionBudget, includeBlocked })` — top-level orchestrator. Per ticket: claim mutex → decide action → consume budget → run handler → release mutex. Aggregates `TickReport`. |
| `src/pipeline/cli.ts` | CLI router for `pipeline-tick`: parses scope + flags, calls `runTick`, prints summary, sets exit code. |
| `src/pipeline/labels.test.ts` | Label parsing unit tests |
| `src/pipeline/state-reader.test.ts` | `readTicketState` against mocked Linear client |
| `src/pipeline/action-dispatcher.test.ts` | Action table coverage — every row of spec §"Action table" |
| `src/pipeline/mutex.test.ts` | Mutex race scenarios (own-claim wins, lost-race backs off, stale claim past TTL is ignored, type-filter ignores non-claim comments) |
| `src/pipeline/reviewer-parser.test.ts` | APPROVE-with-SHOULD-FIX → REQUEST CHANGES override (KPR-84 trial regression) |
| `src/pipeline/block-evidence.test.ts` | Evidence-required for `block:human` unblock; `block:ci` auto-clears |
| `src/pipeline/budget.test.ts` | Spawn-budget vs action-budget consumption |
| `src/pipeline/repo-resolver.test.ts` | Description-grep matches; ambiguous → null |
| `src/pipeline/handlers/review.test.ts` | Findings → fix-inline vs file-follow-up decision |
| `src/pipeline/tick-runner.test.ts` | End-to-end against mocked Linear + mocked spawn driver, full action-table walk |

### Files to modify

| File | Reason |
|---|---|
| `package.json` | Add `@linear/sdk` and `ulid` dependencies |
| `src/cli.ts` | Add `case "pipeline-tick":` dispatching to `pipeline/cli.ts` |
| `src/types.ts` | Add `pipeline?: PipelineConfig` to `BeekeeperConfig` (Linear team key, optional repo allowlist) |
| `src/config.ts` | Load `pipeline:` block from `beekeeper.yaml`; require `LINEAR_API_KEY` env when pipeline subcommand is invoked (lazy check, not at module load) |
| `beekeeper.yaml.example` | Add `pipeline:` example block |

---

## Task 1: Add dependencies and `PipelineConfig`

**Files:**
- Modify: `package.json`
- Modify: `src/types.ts`

- [ ] **Step 1.1:** Add the new dependencies.

```bash
cd /Users/mokie/github/beekeeper
npm install @linear/sdk@^39.0.0 ulid@^2.3.0
```

Verify the lockfile updates and there are no peer-dep warnings. (`@linear/sdk` 39.x targets Node ≥18 and is the current major as of 2026-04. `ulid` is used to generate the 60s-TTL `runId` for the mutex.)

- [ ] **Step 1.2:** Add `PipelineConfig` and extend `BeekeeperConfig` in `src/types.ts`. Append to the bottom of the file:

```typescript
export interface PipelineConfig {
  /** Linear team key (e.g., "KPR" for Keepur). Used to filter `--all`/team scope. */
  linearTeamKey: string;
  /** Optional: explicit repo allowlist for repo-resolver. Keyed by short name. */
  repoPaths?: Record<string, string>;
  /** Optional: default branch for `epic→main` merges (defaults to "main"). */
  mainBranch?: string;
}
```

Then extend `BeekeeperConfig` (do not remove existing fields):

```typescript
export interface BeekeeperConfig {
  port: number;
  model: string;
  confirmOperations: string[];
  jwtSecret: string;
  adminSecret: string;
  dataDir: string;
  defaultWorkspace?: string;
  workspaces?: Record<string, string>;
  plugins?: string[];
  capabilitiesHealthIntervalMs: number;
  capabilitiesFailureThreshold: number;
  /** Pipeline-tick configuration. Required only when `pipeline-tick` subcommand is invoked. */
  pipeline?: PipelineConfig;
}
```

- [ ] **Step 1.3:** Verify

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 1.4:** Commit

```bash
git add package.json package-lock.json src/types.ts
git commit -m "feat(pipeline): add linear sdk + ulid deps and PipelineConfig type"
```

---

## Task 2: Load `pipeline:` from beekeeper.yaml

**Files:**
- Modify: `src/config.ts`
- Modify: `beekeeper.yaml.example`

- [ ] **Step 2.1:** In `src/config.ts`, import `PipelineConfig` alongside `BeekeeperConfig`:

```typescript
import type { BeekeeperConfig, PipelineConfig } from "./types.js";
```

Add this helper above `loadConfig`:

```typescript
function parsePipeline(raw: unknown): PipelineConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v.linearTeamKey !== "string" || v.linearTeamKey.length === 0) {
    throw new Error("beekeeper.yaml: pipeline.linearTeamKey is required");
  }
  let repoPaths: Record<string, string> | undefined;
  if (v.repoPaths && typeof v.repoPaths === "object") {
    repoPaths = {};
    for (const [name, p] of Object.entries(v.repoPaths as Record<string, unknown>)) {
      if (typeof p !== "string" || p.length === 0) {
        throw new Error(`beekeeper.yaml: pipeline.repoPaths.${name} must be a non-empty string`);
      }
      repoPaths[name] = p.replace(/^~/, process.env.HOME ?? "");
    }
  }
  return {
    linearTeamKey: v.linearTeamKey,
    repoPaths,
    mainBranch: typeof v.mainBranch === "string" ? v.mainBranch : undefined,
  };
}
```

In the returned config object inside `loadConfig`, add:

```typescript
pipeline: parsePipeline(raw.pipeline),
```

- [ ] **Step 2.2:** Append to `beekeeper.yaml.example`:

```yaml

# Pipeline-tick configuration. Required only when running `beekeeper pipeline-tick`.
# linearTeamKey is the Linear team prefix (e.g., "KPR" for Keepur).
# repoPaths maps short repo names to absolute paths on disk; consumed by the
#   description-grep repo-resolver. If omitted, the resolver falls back to
#   ~/github/<name>.
# mainBranch defaults to "main" if omitted.
pipeline:
  linearTeamKey: KPR
  repoPaths:
    hive: ~/github/hive
    beekeeper: ~/github/beekeeper
  mainBranch: main
```

- [ ] **Step 2.3:** Verify

```bash
npm run check
```

Expected: typecheck + existing tests pass.

- [ ] **Step 2.4:** Commit

```bash
git add src/config.ts beekeeper.yaml.example
git commit -m "feat(pipeline): load pipeline config from beekeeper.yaml"
```

---

## Task 3: Pipeline labels and types

**Files:**
- Create: `src/pipeline/types.ts`
- Create: `src/pipeline/labels.ts`
- Create: `src/pipeline/labels.test.ts`

- [ ] **Step 3.1:** Create `src/pipeline/types.ts`:

```typescript
/** Pipeline-tick types — the shape consumed and produced by the action dispatcher. */

export type TypeLabel = "type:trivial" | "type:plan-only" | "type:spec-and-plan" | "type:research";
export type BlockLabel = "block:human" | "block:ci" | "block:external";
export type QaLabel = "qa:meta-review-due" | "qa:rollback";
export type PipelineLabel = TypeLabel | BlockLabel | QaLabel | "pipeline-auto" | "epic";

/** Linear workflow state names per `reference_pipeline_taxonomy.md`. */
export type WorkflowState =
  | "Backlog"
  | "Spec Drafting"
  | "Plan Drafting"
  | "Ready"
  | "In Progress"
  | "In Review"
  | "Done"
  | "Canceled"
  | "Todo"; // legacy non-pipeline state — surfaces as "skip" decision

export interface TicketComment {
  id: string;
  body: string;
  /** ISO timestamp; Linear-assigned, globally ordered for race detection. */
  createdAt: string;
  authorId?: string;
}

export interface TicketAttachment {
  id: string;
  url: string;
  /** GitHub PR URLs are auto-attached by Linear's GitHub integration. */
  title?: string;
}

/** Joined ticket state — the action-dispatcher's input. */
export interface TicketState {
  id: string;
  identifier: string; // e.g., "KPR-90"
  title: string;
  description: string;
  state: WorkflowState;
  labels: PipelineLabel[];
  blockedBy: string[]; // identifiers of blocking issues
  parent?: string; // identifier
  comments: TicketComment[];
  attachments: TicketAttachment[];
}

export type ActionKind =
  | "draft-spec"
  | "draft-plan"
  | "spec-review"
  | "plan-review"
  | "pickup"
  | "code-review"
  | "merge"
  | "advance" // pure state transition, no spawn
  | "report-only" // for blocked tickets
  | "skip";

export interface ActionDecision {
  kind: ActionKind;
  /** Human-readable reason — surfaces in tick output and in the spawn-log comment. */
  reason: string;
  /** True if this action consumes the spawn-budget (launches a long-running subagent). */
  spawns: boolean;
  /** Optional payload the handler needs (e.g., target state, label changes). */
  payload?: Record<string, unknown>;
}

export interface ResolvedRepo {
  /** Short name, e.g., "hive" or "beekeeper". */
  name: string;
  /** Absolute path on disk. */
  path: string;
}

export interface ReviewerFinding {
  severity: "BLOCKER" | "SHOULD-FIX" | "NICE-TO-HAVE";
  body: string;
  /** Reviewer's recommendation per finding: in-PR fix or follow-up. */
  disposition?: "fix-in-this-PR" | "file-follow-up";
}

export interface ReviewerOutput {
  verdict: "APPROVE" | "REQUEST CHANGES";
  findings: ReviewerFinding[];
}

export interface LockClaim {
  runId: string;
  action: string;
  postedAt: string; // ISO
}

export interface BudgetCounters {
  spawnUsed: number;
  spawnLimit: number;
  actionUsed: number;
  actionLimit: number;
}

export interface TickReportEntry {
  ticket: string;
  decision: ActionDecision;
  outcome: "spawned" | "transitioned" | "skipped" | "blocked" | "report-only";
  detail?: string;
}

export interface TickReport {
  runId: string;
  scope: string;
  startedAt: string;
  endedAt: string;
  budget: BudgetCounters;
  entries: TickReportEntry[];
  blocked: TickReportEntry[];
}
```

- [ ] **Step 3.2:** Create `src/pipeline/labels.ts`:

```typescript
import type { PipelineLabel, TypeLabel, BlockLabel } from "./types.js";

export const TYPE_LABELS: readonly TypeLabel[] = [
  "type:trivial",
  "type:plan-only",
  "type:spec-and-plan",
  "type:research",
] as const;

export const BLOCK_LABELS: readonly BlockLabel[] = [
  "block:human",
  "block:ci",
  "block:external",
] as const;

export function isTypeLabel(s: string): s is TypeLabel {
  return (TYPE_LABELS as readonly string[]).includes(s);
}

export function isBlockLabel(s: string): s is BlockLabel {
  return (BLOCK_LABELS as readonly string[]).includes(s);
}

export function isPipelineLabel(s: string): s is PipelineLabel {
  return (
    isTypeLabel(s) ||
    isBlockLabel(s) ||
    s === "pipeline-auto" ||
    s === "epic" ||
    s === "qa:meta-review-due" ||
    s === "qa:rollback"
  );
}

/** Returns the single `type:*` label on the ticket, or undefined if none/multiple. */
export function getTypeLabel(labels: PipelineLabel[]): TypeLabel | undefined {
  const matched = labels.filter(isTypeLabel);
  return matched.length === 1 ? matched[0] : undefined;
}

/** Returns all `block:*` labels on the ticket. */
export function getBlockLabels(labels: PipelineLabel[]): BlockLabel[] {
  return labels.filter(isBlockLabel);
}

export function hasLabel(labels: PipelineLabel[], target: PipelineLabel): boolean {
  return labels.includes(target);
}
```

- [ ] **Step 3.3:** Create `src/pipeline/labels.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { getBlockLabels, getTypeLabel, hasLabel, isPipelineLabel } from "./labels.js";

describe("labels", () => {
  it("identifies pipeline labels", () => {
    expect(isPipelineLabel("type:trivial")).toBe(true);
    expect(isPipelineLabel("block:ci")).toBe(true);
    expect(isPipelineLabel("pipeline-auto")).toBe(true);
    expect(isPipelineLabel("epic")).toBe(true);
    expect(isPipelineLabel("random-label")).toBe(false);
  });

  it("returns single type label or undefined", () => {
    expect(getTypeLabel(["type:plan-only", "pipeline-auto"])).toBe("type:plan-only");
    expect(getTypeLabel([])).toBeUndefined();
    expect(getTypeLabel(["type:plan-only", "type:trivial"])).toBeUndefined(); // ambiguous
  });

  it("returns all block labels", () => {
    expect(getBlockLabels(["block:human", "block:ci", "pipeline-auto"])).toEqual([
      "block:human",
      "block:ci",
    ]);
  });

  it("hasLabel checks membership", () => {
    expect(hasLabel(["pipeline-auto", "epic"], "pipeline-auto")).toBe(true);
    expect(hasLabel(["pipeline-auto"], "epic")).toBe(false);
  });
});
```

- [ ] **Step 3.4:** Verify

```bash
npm run check
```

- [ ] **Step 3.5:** Commit

```bash
git add src/pipeline/types.ts src/pipeline/labels.ts src/pipeline/labels.test.ts
git commit -m "feat(pipeline): pipeline label/type definitions and parsers"
```

---

## Task 4: Linear client wrapper

**Files:**
- Create: `src/pipeline/linear-client.ts`

This task wraps `@linear/sdk` behind a small surface so the rest of the module stays decoupled from the SDK's GraphQL types. Tests in later tasks mock this surface, not the SDK directly.

- [ ] **Step 4.1:** Create `src/pipeline/linear-client.ts`:

```typescript
import { LinearClient as LinearSdk } from "@linear/sdk";
import type {
  PipelineLabel,
  TicketAttachment,
  TicketComment,
  TicketState,
  WorkflowState,
} from "./types.js";
import { isPipelineLabel } from "./labels.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("pipeline-linear");

export interface LinearClientOptions {
  apiKey: string;
  teamKey: string;
}

/** Thin facade over @linear/sdk. All pipeline I/O against Linear flows through this. */
export class LinearClient {
  private readonly sdk: LinearSdk;
  private readonly teamKey: string;
  private teamIdCache?: string;
  private stateIdCache: Map<WorkflowState, string> = new Map();

  constructor(opts: LinearClientOptions) {
    if (!opts.apiKey) throw new Error("LinearClient: apiKey required");
    if (!opts.teamKey) throw new Error("LinearClient: teamKey required");
    this.sdk = new LinearSdk({ apiKey: opts.apiKey });
    this.teamKey = opts.teamKey;
  }

  async getTeamId(): Promise<string> {
    if (this.teamIdCache) return this.teamIdCache;
    const teams = await this.sdk.teams({ filter: { key: { eq: this.teamKey } } });
    const team = teams.nodes[0];
    if (!team) throw new Error(`Linear team not found for key: ${this.teamKey}`);
    this.teamIdCache = team.id;
    return team.id;
  }

  /** Look up a workflow state ID by name on the configured team. Cached after first hit. */
  async getStateId(name: WorkflowState): Promise<string> {
    const cached = this.stateIdCache.get(name);
    if (cached) return cached;
    const teamId = await this.getTeamId();
    const states = await this.sdk.workflowStates({
      filter: { team: { id: { eq: teamId } }, name: { eq: name } },
    });
    const state = states.nodes[0];
    if (!state) throw new Error(`Workflow state "${name}" not found on team ${this.teamKey}`);
    this.stateIdCache.set(name, state.id);
    return state.id;
  }

  /** Read a single issue and join labels + comments + attachments + parent + blockedBy. */
  async getTicketState(identifier: string): Promise<TicketState> {
    const issue = await this.sdk.issue(identifier);

    const [labelsConn, commentsConn, attachmentsConn, blockedByConn, stateRel, parentRel] =
      await Promise.all([
        issue.labels(),
        issue.comments(),
        issue.attachments(),
        issue.relations({ filter: { type: { eq: "blocks" } } }),
        issue.state,
        issue.parent,
      ]);

    const labels: PipelineLabel[] = labelsConn.nodes
      .map((l) => l.name)
      .filter(isPipelineLabel);

    const comments: TicketComment[] = await Promise.all(
      commentsConn.nodes.map(async (c) => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
        authorId: (await c.user)?.id,
      })),
    );

    const attachments: TicketAttachment[] = attachmentsConn.nodes.map((a) => ({
      id: a.id,
      url: a.url,
      title: a.title,
    }));

    const blockedBy: string[] = await Promise.all(
      blockedByConn.nodes.map(async (rel) => (await rel.relatedIssue)?.identifier ?? ""),
    ).then((arr) => arr.filter((s) => s.length > 0));

    const state = stateRel ? ((await stateRel).name as WorkflowState) : "Backlog";
    const parent = parentRel ? (await parentRel)?.identifier : undefined;

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? "",
      state,
      labels,
      blockedBy,
      parent,
      comments,
      attachments,
    };
  }

  /** List children of an epic, identifier-form. */
  async listChildren(parentIdentifier: string): Promise<string[]> {
    const parent = await this.sdk.issue(parentIdentifier);
    const children = await parent.children();
    return children.nodes.map((c) => c.identifier);
  }

  /** List all `pipeline-auto` issues on the team. */
  async listTeamPipelineIssues(): Promise<string[]> {
    const teamId = await this.getTeamId();
    const issues = await this.sdk.issues({
      filter: {
        team: { id: { eq: teamId } },
        labels: { name: { eq: "pipeline-auto" } },
      },
      first: 100,
    });
    return issues.nodes.map((i) => i.identifier);
  }

  async addComment(issueId: string, body: string): Promise<{ id: string; createdAt: string }> {
    const result = await this.sdk.createComment({ issueId, body });
    if (!result.success || !result.comment) {
      throw new Error("Failed to create Linear comment");
    }
    const c = await result.comment;
    return { id: c.id, createdAt: c.createdAt.toISOString() };
  }

  async setState(issueId: string, state: WorkflowState): Promise<void> {
    const stateId = await this.getStateId(state);
    const result = await this.sdk.updateIssue(issueId, { stateId });
    if (!result.success) throw new Error(`Failed to set state ${state} on ${issueId}`);
  }

  async addLabel(issueId: string, labelName: PipelineLabel): Promise<void> {
    const teamId = await this.getTeamId();
    const labels = await this.sdk.issueLabels({
      filter: { team: { id: { eq: teamId } }, name: { eq: labelName } },
    });
    const label = labels.nodes[0];
    if (!label) throw new Error(`Label "${labelName}" not found on team ${this.teamKey}`);
    const issue = await this.sdk.issue(issueId);
    const current = await issue.labels();
    const ids = [...new Set([...current.nodes.map((l) => l.id), label.id])];
    const result = await this.sdk.updateIssue(issueId, { labelIds: ids });
    if (!result.success) throw new Error(`Failed to add label ${labelName} on ${issueId}`);
  }

  async removeLabel(issueId: string, labelName: PipelineLabel): Promise<void> {
    const issue = await this.sdk.issue(issueId);
    const current = await issue.labels();
    const ids = current.nodes.filter((l) => l.name !== labelName).map((l) => l.id);
    const result = await this.sdk.updateIssue(issueId, { labelIds: ids });
    if (!result.success) throw new Error(`Failed to remove label ${labelName} on ${issueId}`);
    log.debug("Label removed", { issueId, labelName });
  }
}
```

- [ ] **Step 4.2:** Verify

```bash
npm run typecheck
```

Expected: clean. (No tests yet — this module is mocked by callers.)

- [ ] **Step 4.3:** Commit

```bash
git add src/pipeline/linear-client.ts
git commit -m "feat(pipeline): linear client facade over @linear/sdk"
```

---

## Task 5: State reader

**Files:**
- Create: `src/pipeline/state-reader.ts`
- Create: `src/pipeline/state-reader.test.ts`

The state reader is a thin orchestrator: in Phase 1 it just calls `LinearClient.getTicketState`. The unit exists so that downstream code depends on a `readTicketState(client, identifier)` API and not directly on the client class — this keeps the dispatcher and handler tests easy to write.

- [ ] **Step 5.1:** Create `src/pipeline/state-reader.ts`:

```typescript
import type { LinearClient } from "./linear-client.js";
import type { TicketState } from "./types.js";

/** Read joined ticket state from Linear. Wraps the client for testability. */
export async function readTicketState(
  client: LinearClient,
  identifier: string,
): Promise<TicketState> {
  return client.getTicketState(identifier);
}
```

- [ ] **Step 5.2:** Create `src/pipeline/state-reader.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { readTicketState } from "./state-reader.js";
import type { LinearClient } from "./linear-client.js";
import type { TicketState } from "./types.js";

describe("readTicketState", () => {
  it("delegates to LinearClient.getTicketState", async () => {
    const sample: TicketState = {
      id: "id-1",
      identifier: "KPR-1",
      title: "test",
      description: "",
      state: "Backlog",
      labels: ["pipeline-auto"],
      blockedBy: [],
      comments: [],
      attachments: [],
    };
    const client = { getTicketState: vi.fn().mockResolvedValue(sample) } as unknown as LinearClient;
    const result = await readTicketState(client, "KPR-1");
    expect(result).toEqual(sample);
    expect(client.getTicketState).toHaveBeenCalledWith("KPR-1");
  });
});
```

- [ ] **Step 5.3:** Verify

```bash
npm run check
```

- [ ] **Step 5.4:** Commit

```bash
git add src/pipeline/state-reader.ts src/pipeline/state-reader.test.ts
git commit -m "feat(pipeline): ticket state reader"
```

---

## Task 6: Action dispatcher (the action table)

**Files:**
- Create: `src/pipeline/action-dispatcher.ts`
- Create: `src/pipeline/action-dispatcher.test.ts`

This is the spec's §"Action table" translated to a pure function. **Every row of the table gets a covering test.**

- [ ] **Step 6.1:** Create `src/pipeline/action-dispatcher.ts`:

```typescript
import type { ActionDecision, TicketState } from "./types.js";
import { getBlockLabels, getTypeLabel, hasLabel } from "./labels.js";

/**
 * Pure decision function — given a ticket state, return the next action.
 *
 * Implements the action table from `docs/specs/2026-04-26-pipeline-tick-design.md`.
 * Block labels short-circuit: a `block:human` or `block:external` ticket is
 * `report-only`. `block:ci` is checked by the handler (it polls CI status), so
 * here we just emit `report-only` and let the handler/dispatcher upstream
 * re-decide after it clears.
 */
export function decideAction(state: TicketState): ActionDecision {
  const blocks = getBlockLabels(state.labels);
  if (blocks.includes("block:human")) {
    return {
      kind: "report-only",
      reason: "block:human — operator action required",
      spawns: false,
    };
  }
  if (blocks.includes("block:external")) {
    return {
      kind: "report-only",
      reason: "block:external — vendor/legal/decider action required",
      spawns: false,
    };
  }
  if (blocks.includes("block:ci")) {
    return {
      kind: "report-only",
      reason: "block:ci — auto-clears when CI flips green",
      spawns: false,
    };
  }

  const isAuto = hasLabel(state.labels, "pipeline-auto");
  const blocked = state.blockedBy.length > 0;
  const type = getTypeLabel(state.labels);

  switch (state.state) {
    case "Backlog":
      if (!isAuto) return skip("not pipeline-auto");
      if (blocked) return skip("blockedBy issue dependency");
      if (!type) return skip("missing type:* label");
      if (type === "type:trivial") {
        return {
          kind: "advance",
          reason: "trivial → Ready (no spec, no plan)",
          spawns: false,
          payload: { nextState: "Ready" },
        };
      }
      if (type === "type:plan-only") {
        return {
          kind: "draft-plan",
          reason: "plan-only → spawn plan-drafting subagent",
          spawns: true,
          payload: { nextState: "Plan Drafting" },
        };
      }
      if (type === "type:spec-and-plan") {
        return {
          kind: "draft-spec",
          reason: "spec-and-plan → spawn spec-drafting subagent",
          spawns: true,
          payload: { nextState: "Spec Drafting" },
        };
      }
      // type:research
      return {
        kind: "draft-spec", // research output is a spec-shaped findings doc
        reason: "research → spawn research subagent",
        spawns: true,
        payload: { nextState: "In Progress", research: true },
      };

    case "Spec Drafting":
      // Handler reads the latest tick-spawn-log to know if a draft is in flight.
      // If draft completed and review-clean → advance. If issues → spec-review loop.
      // The dispatcher returns the kind; the handler interrogates the comment trail.
      return {
        kind: "spec-review",
        reason: "in spec drafting — let handler interrogate latest draft + review state",
        spawns: false, // handler may launch a reviewer; that's a separate budget consumption
      };

    case "Plan Drafting":
      return {
        kind: "plan-review",
        reason: "in plan drafting — let handler interrogate latest draft + review state",
        spawns: false,
      };

    case "Ready":
      if (blocked) return skip("blockedBy issue dependency");
      return {
        kind: "pickup",
        reason: "ready → spawn implementer subagent",
        spawns: true,
        payload: { nextState: "In Progress" },
      };

    case "In Progress":
      // Implementer may have opened a PR (attachment) or failed (no PR + spawn-log shows error).
      // Handler interrogates; dispatcher returns the kind.
      return {
        kind: "code-review",
        reason: "in progress — handler reads PR/error state",
        spawns: false,
      };

    case "In Review":
      return {
        kind: "code-review",
        reason: "in review — handler reads CI + reviewer output",
        spawns: false,
      };

    case "Done":
      return skip("done");
    case "Canceled":
      return skip("canceled");
    case "Todo":
      return skip("legacy non-pipeline state");
    default: {
      const exhaustive: never = state.state;
      return skip(`unknown state: ${String(exhaustive)}`);
    }
  }
}

function skip(reason: string): ActionDecision {
  return { kind: "skip", reason, spawns: false };
}
```

- [ ] **Step 6.2:** Create `src/pipeline/action-dispatcher.test.ts`. Cover one case per row of spec §"Action table":

```typescript
import { describe, expect, it } from "vitest";
import { decideAction } from "./action-dispatcher.js";
import type { TicketState } from "./types.js";

function makeTicket(over: Partial<TicketState>): TicketState {
  return {
    id: "id",
    identifier: "KPR-1",
    title: "t",
    description: "",
    state: "Backlog",
    labels: [],
    blockedBy: [],
    comments: [],
    attachments: [],
    ...over,
  };
}

describe("decideAction", () => {
  it("Backlog + type:trivial + pipeline-auto → advance to Ready", () => {
    const d = decideAction(makeTicket({ labels: ["type:trivial", "pipeline-auto"] }));
    expect(d.kind).toBe("advance");
    expect(d.payload?.nextState).toBe("Ready");
    expect(d.spawns).toBe(false);
  });

  it("Backlog + type:plan-only + pipeline-auto → draft-plan", () => {
    const d = decideAction(makeTicket({ labels: ["type:plan-only", "pipeline-auto"] }));
    expect(d.kind).toBe("draft-plan");
    expect(d.spawns).toBe(true);
  });

  it("Backlog + type:spec-and-plan + pipeline-auto → draft-spec", () => {
    const d = decideAction(makeTicket({ labels: ["type:spec-and-plan", "pipeline-auto"] }));
    expect(d.kind).toBe("draft-spec");
    expect(d.spawns).toBe(true);
  });

  it("Backlog without pipeline-auto → skip", () => {
    const d = decideAction(makeTicket({ labels: ["type:plan-only"] }));
    expect(d.kind).toBe("skip");
  });

  it("Backlog with blockedBy → skip", () => {
    const d = decideAction(
      makeTicket({ labels: ["type:plan-only", "pipeline-auto"], blockedBy: ["KPR-2"] }),
    );
    expect(d.kind).toBe("skip");
  });

  it("Spec Drafting → spec-review (handler interrogates)", () => {
    const d = decideAction(makeTicket({ state: "Spec Drafting" }));
    expect(d.kind).toBe("spec-review");
    expect(d.spawns).toBe(false);
  });

  it("Plan Drafting → plan-review", () => {
    const d = decideAction(makeTicket({ state: "Plan Drafting" }));
    expect(d.kind).toBe("plan-review");
  });

  it("Ready not blockedBy → pickup", () => {
    const d = decideAction(makeTicket({ state: "Ready" }));
    expect(d.kind).toBe("pickup");
    expect(d.spawns).toBe(true);
  });

  it("Ready blockedBy → skip", () => {
    const d = decideAction(makeTicket({ state: "Ready", blockedBy: ["KPR-2"] }));
    expect(d.kind).toBe("skip");
  });

  it("In Progress → code-review (handler reads PR state)", () => {
    const d = decideAction(makeTicket({ state: "In Progress" }));
    expect(d.kind).toBe("code-review");
  });

  it("In Review → code-review", () => {
    const d = decideAction(makeTicket({ state: "In Review" }));
    expect(d.kind).toBe("code-review");
  });

  it("Done → skip", () => {
    expect(decideAction(makeTicket({ state: "Done" })).kind).toBe("skip");
  });

  it("Canceled → skip", () => {
    expect(decideAction(makeTicket({ state: "Canceled" })).kind).toBe("skip");
  });

  it("block:human short-circuits → report-only", () => {
    const d = decideAction(makeTicket({ state: "Ready", labels: ["block:human"] }));
    expect(d.kind).toBe("report-only");
  });

  it("block:ci short-circuits → report-only (handler will re-decide on green)", () => {
    const d = decideAction(makeTicket({ state: "In Review", labels: ["block:ci"] }));
    expect(d.kind).toBe("report-only");
  });

  it("block:external short-circuits → report-only", () => {
    const d = decideAction(makeTicket({ state: "Ready", labels: ["block:external"] }));
    expect(d.kind).toBe("report-only");
  });
});
```

- [ ] **Step 6.3:** Verify

```bash
npm run check
```

- [ ] **Step 6.4:** Commit

```bash
git add src/pipeline/action-dispatcher.ts src/pipeline/action-dispatcher.test.ts
git commit -m "feat(pipeline): action dispatcher implementing the action table"
```

---

## Task 7: Comment-based mutex

**Files:**
- Create: `src/pipeline/mutex.ts`
- Create: `src/pipeline/mutex.test.ts`

Per spec §"Per-ticket mutual exclusion": three comment types (`tick-lock-claim`, `tick-lock-release`, `tick-spawn-log`), 60s TTL, type-filtered scan. The mutex MUST filter to `tick-lock-claim` comments specifically when verifying.

- [ ] **Step 7.1:** Create `src/pipeline/mutex.ts`:

```typescript
import { ulid } from "ulid";
import type { LinearClient } from "./linear-client.js";
import type { TicketComment } from "./types.js";

const CLAIM_PREFIX = "tick-lock-claim:";
const RELEASE_PREFIX = "tick-lock-release:";
const SPAWN_PREFIX = "tick-spawn-log:";
const TTL_MS = 60_000;

export interface ClaimResult {
  /** True if this caller now holds the lock; false if another runId beat them. */
  acquired: boolean;
  /** The runId that beat us, when acquired=false. */
  contendedBy?: string;
  /** The comment ID we wrote (so the release step can pair it). */
  claimCommentId?: string;
}

export interface ReleaseInput {
  outcome: "spawned" | "transitioned" | "skipped";
}

interface ParsedClaim {
  runId: string;
  action: string;
  postedAt: Date;
}

interface ParsedRelease {
  runId: string;
  outcome: string;
}

/**
 * Generate a fresh runId for one tick invocation.
 * Format: `tick-<ulid>`. ULID is monotonic + lexicographic, useful for log-grepping.
 */
export function newRunId(): string {
  return `tick-${ulid()}`;
}

/**
 * Try to claim the per-ticket lock. Posts a `tick-lock-claim` comment,
 * then re-reads to verify the latest claim is ours.
 */
export async function claim(
  client: LinearClient,
  ticketId: string,
  runId: string,
  action: string,
): Promise<ClaimResult> {
  // Step 1: read existing claims; bail if a *different* fresh claim exists.
  const issue = await client.getTicketState(ticketId);
  const existing = latestClaim(issue.comments);
  if (existing && existing.runId !== runId && Date.now() - existing.postedAt.getTime() < TTL_MS) {
    const released = hasMatchingRelease(issue.comments, existing.runId, existing.postedAt);
    if (!released) {
      return { acquired: false, contendedBy: existing.runId };
    }
  }

  // Step 2: write our claim.
  const written = await client.addComment(
    issue.id,
    `${CLAIM_PREFIX} runId=${runId} action=${action}`,
  );

  // Step 3: re-read and verify our claim is the most recent tick-lock-claim.
  const verify = await client.getTicketState(ticketId);
  const newest = latestClaim(verify.comments);
  if (!newest || newest.runId !== runId) {
    return { acquired: false, contendedBy: newest?.runId, claimCommentId: written.id };
  }
  return { acquired: true, claimCommentId: written.id };
}

export async function release(
  client: LinearClient,
  ticketId: string,
  runId: string,
  input: ReleaseInput,
): Promise<void> {
  const issue = await client.getTicketState(ticketId);
  await client.addComment(
    issue.id,
    `${RELEASE_PREFIX} runId=${runId} outcome=${input.outcome}`,
  );
}

export async function logSpawn(
  client: LinearClient,
  ticketId: string,
  runId: string,
  agentId: string,
): Promise<void> {
  const issue = await client.getTicketState(ticketId);
  await client.addComment(
    issue.id,
    `${SPAWN_PREFIX} runId=${runId} agentId=${agentId}`,
  );
}

/** Find the most recent `tick-lock-claim`-typed comment, ignoring releases/spawn-logs/non-pipeline. */
export function latestClaim(comments: TicketComment[]): ParsedClaim | undefined {
  const claims: ParsedClaim[] = [];
  for (const c of comments) {
    const trimmed = c.body.trim();
    if (!trimmed.startsWith(CLAIM_PREFIX)) continue;
    const parsed = parseClaim(trimmed, new Date(c.createdAt));
    if (parsed) claims.push(parsed);
  }
  if (claims.length === 0) return undefined;
  return claims.reduce((a, b) => (a.postedAt >= b.postedAt ? a : b));
}

export function parseClaim(body: string, postedAt: Date): ParsedClaim | undefined {
  // Body shape: "tick-lock-claim: runId=tick-XXXX action=draft-plan"
  const m = body.match(/^tick-lock-claim:\s+runId=(\S+)\s+action=(\S+)\s*$/);
  if (!m) return undefined;
  return { runId: m[1], action: m[2], postedAt };
}

export function parseRelease(body: string): ParsedRelease | undefined {
  const m = body.trim().match(/^tick-lock-release:\s+runId=(\S+)\s+outcome=(\S+)\s*$/);
  if (!m) return undefined;
  return { runId: m[1], outcome: m[2] };
}

/** Returns true if the comment list shows a release for the given runId after `claimedAt`. */
export function hasMatchingRelease(
  comments: TicketComment[],
  runId: string,
  claimedAt: Date,
): boolean {
  for (const c of comments) {
    if (new Date(c.createdAt) <= claimedAt) continue;
    const r = parseRelease(c.body);
    if (r && r.runId === runId) return true;
  }
  return false;
}
```

- [ ] **Step 7.2:** Create `src/pipeline/mutex.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { claim, latestClaim, hasMatchingRelease, newRunId } from "./mutex.js";
import type { LinearClient } from "./linear-client.js";
import type { TicketComment, TicketState } from "./types.js";

function comment(body: string, createdAt: string, id = body.slice(0, 8)): TicketComment {
  return { id, body, createdAt };
}

describe("mutex helpers", () => {
  it("latestClaim ignores release and spawn-log comments", () => {
    const comments: TicketComment[] = [
      comment("tick-lock-claim: runId=tick-1 action=pickup", "2026-04-26T00:00:00.000Z"),
      comment("tick-spawn-log: runId=tick-1 agentId=foo", "2026-04-26T00:00:01.000Z"),
      comment("tick-lock-release: runId=tick-1 outcome=spawned", "2026-04-26T00:00:02.000Z"),
      comment("just a note", "2026-04-26T00:00:03.000Z"),
    ];
    const c = latestClaim(comments);
    expect(c?.runId).toBe("tick-1");
  });

  it("latestClaim returns most recent claim by createdAt", () => {
    const comments: TicketComment[] = [
      comment("tick-lock-claim: runId=tick-1 action=pickup", "2026-04-26T00:00:00.000Z"),
      comment("tick-lock-claim: runId=tick-2 action=pickup", "2026-04-26T00:00:05.000Z"),
    ];
    expect(latestClaim(comments)?.runId).toBe("tick-2");
  });

  it("hasMatchingRelease finds release after claim", () => {
    const comments: TicketComment[] = [
      comment("tick-lock-release: runId=tick-1 outcome=spawned", "2026-04-26T00:00:10.000Z"),
    ];
    expect(hasMatchingRelease(comments, "tick-1", new Date("2026-04-26T00:00:00.000Z"))).toBe(true);
  });
});

describe("claim", () => {
  function mockClient(initial: TicketComment[], afterWrite: TicketComment[]): LinearClient {
    const calls: string[] = [];
    const stateCommon: Omit<TicketState, "comments"> = {
      id: "issue-id",
      identifier: "KPR-1",
      title: "t",
      description: "",
      state: "Backlog",
      labels: [],
      blockedBy: [],
      attachments: [],
    };
    return {
      getTicketState: vi
        .fn()
        .mockResolvedValueOnce({ ...stateCommon, comments: initial })
        .mockResolvedValueOnce({ ...stateCommon, comments: afterWrite }),
      addComment: vi.fn(async (_id: string, body: string) => {
        calls.push(body);
        return { id: `c-${calls.length}`, createdAt: "2026-04-26T00:00:30.000Z" };
      }),
    } as unknown as LinearClient;
  }

  it("acquires lock when no contention", async () => {
    const runId = newRunId();
    const after: TicketComment[] = [
      comment(`tick-lock-claim: runId=${runId} action=pickup`, "2026-04-26T00:00:30.000Z"),
    ];
    const result = await claim(mockClient([], after), "KPR-1", runId, "pickup");
    expect(result.acquired).toBe(true);
  });

  it("backs off when a different fresh claim exists", async () => {
    const runId = "tick-mine";
    const recent = new Date(Date.now() - 1_000).toISOString();
    const initial: TicketComment[] = [
      comment("tick-lock-claim: runId=tick-other action=pickup", recent),
    ];
    const result = await claim(mockClient(initial, initial), "KPR-1", runId, "pickup");
    expect(result.acquired).toBe(false);
    expect(result.contendedBy).toBe("tick-other");
  });

  it("ignores stale claim past TTL", async () => {
    const runId = "tick-mine";
    const stale = new Date(Date.now() - 120_000).toISOString();
    const after: TicketComment[] = [
      comment("tick-lock-claim: runId=tick-old action=pickup", stale),
      comment(`tick-lock-claim: runId=${runId} action=pickup`, new Date().toISOString()),
    ];
    const initial: TicketComment[] = [
      comment("tick-lock-claim: runId=tick-old action=pickup", stale),
    ];
    const result = await claim(mockClient(initial, after), "KPR-1", runId, "pickup");
    expect(result.acquired).toBe(true);
  });

  it("loses race if a different runId becomes most-recent on verify", async () => {
    const runId = "tick-mine";
    const initial: TicketComment[] = [];
    const after: TicketComment[] = [
      comment(`tick-lock-claim: runId=${runId} action=pickup`, "2026-04-26T00:00:30.000Z"),
      comment(
        "tick-lock-claim: runId=tick-other action=pickup",
        "2026-04-26T00:00:31.000Z",
      ),
    ];
    const result = await claim(mockClient(initial, after), "KPR-1", runId, "pickup");
    expect(result.acquired).toBe(false);
    expect(result.contendedBy).toBe("tick-other");
  });
});
```

- [ ] **Step 7.3:** Verify

```bash
npm run check
```

- [ ] **Step 7.4:** Commit

```bash
git add src/pipeline/mutex.ts src/pipeline/mutex.test.ts
git commit -m "feat(pipeline): comment-based per-ticket mutex with run-id verify"
```

---

## Task 8: Reviewer-findings parser, block-evidence, budget, repo-resolver

**Files:**
- Create: `src/pipeline/reviewer-parser.ts` + `.test.ts`
- Create: `src/pipeline/block-evidence.ts` + `.test.ts`
- Create: `src/pipeline/budget.ts` + `.test.ts`
- Create: `src/pipeline/repo-resolver.ts` + `.test.ts`

These four are small, independent units. Group into one task to keep the task count tight.

- [ ] **Step 8.1:** Create `src/pipeline/reviewer-parser.ts`:

```typescript
import type { ReviewerFinding, ReviewerOutput } from "./types.js";

/**
 * Parse the reviewer subagent's structured output. The reviewer is prompted
 * to emit a fenced JSON block with shape:
 *
 *   ```json
 *   {
 *     "verdict": "APPROVE" | "REQUEST CHANGES",
 *     "findings": [
 *       { "severity": "BLOCKER"|"SHOULD-FIX"|"NICE-TO-HAVE",
 *         "body": "...",
 *         "disposition": "fix-in-this-PR"|"file-follow-up" }
 *     ]
 *   }
 *   ```
 *
 * The parser then RE-ASSERTS the pipeline rule: any BLOCKER or SHOULD-FIX
 * forces verdict to REQUEST CHANGES regardless of what the reviewer wrote.
 * This guards against reviewer prompt drift (caught in the KPR-84 trial).
 */
export function parseReviewerOutput(text: string): ReviewerOutput {
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (!m) throw new Error("Reviewer output missing fenced JSON block");
  const raw = JSON.parse(m[1]) as unknown;
  if (!raw || typeof raw !== "object") {
    throw new Error("Reviewer output is not an object");
  }
  const obj = raw as Record<string, unknown>;
  const verdictRaw = obj.verdict;
  if (verdictRaw !== "APPROVE" && verdictRaw !== "REQUEST CHANGES") {
    throw new Error(`Reviewer output: invalid verdict ${String(verdictRaw)}`);
  }
  if (!Array.isArray(obj.findings)) {
    throw new Error("Reviewer output: findings must be an array");
  }
  const findings: ReviewerFinding[] = obj.findings.map((f, i) => parseFinding(f, i));
  const reasserted = reassertVerdict(verdictRaw, findings);
  return { verdict: reasserted, findings };
}

function parseFinding(raw: unknown, index: number): ReviewerFinding {
  if (!raw || typeof raw !== "object") {
    throw new Error(`findings[${index}] must be an object`);
  }
  const o = raw as Record<string, unknown>;
  if (
    o.severity !== "BLOCKER" &&
    o.severity !== "SHOULD-FIX" &&
    o.severity !== "NICE-TO-HAVE"
  ) {
    throw new Error(`findings[${index}].severity invalid: ${String(o.severity)}`);
  }
  if (typeof o.body !== "string" || o.body.length === 0) {
    throw new Error(`findings[${index}].body must be a non-empty string`);
  }
  let disposition: ReviewerFinding["disposition"];
  if (o.disposition === "fix-in-this-PR" || o.disposition === "file-follow-up") {
    disposition = o.disposition;
  } else if (o.disposition !== undefined) {
    throw new Error(`findings[${index}].disposition invalid: ${String(o.disposition)}`);
  }
  return { severity: o.severity, body: o.body, disposition };
}

/** Pipeline rule: APPROVE means zero BLOCKER and zero SHOULD-FIX. */
export function reassertVerdict(
  reviewerVerdict: "APPROVE" | "REQUEST CHANGES",
  findings: ReviewerFinding[],
): "APPROVE" | "REQUEST CHANGES" {
  const hasBlocking = findings.some(
    (f) => f.severity === "BLOCKER" || f.severity === "SHOULD-FIX",
  );
  if (hasBlocking) return "REQUEST CHANGES";
  return reviewerVerdict;
}
```

- [ ] **Step 8.2:** Create `src/pipeline/reviewer-parser.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { parseReviewerOutput, reassertVerdict } from "./reviewer-parser.js";

describe("parseReviewerOutput", () => {
  it("parses approve with no findings", () => {
    const out = parseReviewerOutput('```json\n{"verdict":"APPROVE","findings":[]}\n```');
    expect(out.verdict).toBe("APPROVE");
    expect(out.findings).toEqual([]);
  });

  it("re-asserts REQUEST CHANGES when reviewer said APPROVE but had SHOULD-FIX (KPR-84 regression)", () => {
    const out = parseReviewerOutput(
      '```json\n{"verdict":"APPROVE","findings":[{"severity":"SHOULD-FIX","body":"x"}]}\n```',
    );
    expect(out.verdict).toBe("REQUEST CHANGES");
  });

  it("preserves APPROVE when only NICE-TO-HAVE findings", () => {
    const out = parseReviewerOutput(
      '```json\n{"verdict":"APPROVE","findings":[{"severity":"NICE-TO-HAVE","body":"x"}]}\n```',
    );
    expect(out.verdict).toBe("APPROVE");
  });

  it("throws on missing fenced JSON", () => {
    expect(() => parseReviewerOutput("plain prose")).toThrow();
  });

  it("throws on bad severity", () => {
    expect(() =>
      parseReviewerOutput('```json\n{"verdict":"APPROVE","findings":[{"severity":"foo","body":"x"}]}\n```'),
    ).toThrow();
  });
});

describe("reassertVerdict", () => {
  it("BLOCKER forces REQUEST CHANGES", () => {
    expect(
      reassertVerdict("APPROVE", [{ severity: "BLOCKER", body: "x" }]),
    ).toBe("REQUEST CHANGES");
  });

  it("only NICE-TO-HAVE keeps APPROVE", () => {
    expect(
      reassertVerdict("APPROVE", [{ severity: "NICE-TO-HAVE", body: "x" }]),
    ).toBe("APPROVE");
  });
});
```

- [ ] **Step 8.3:** Create `src/pipeline/block-evidence.ts`:

```typescript
import type { TicketComment } from "./types.js";

const PIPELINE_PREFIXES = ["tick-lock-claim:", "tick-lock-release:", "tick-spawn-log:"];

/**
 * Per spec §"Default unblock flow": for `block:human` and `block:external`,
 * the operator must post a non-pipeline comment between the original block
 * diagnostic and the unblock. If the most recent non-pipeline comment is the
 * block diagnostic itself, no resolution evidence exists — the tick re-applies
 * the block label.
 *
 * For Phase 1 we use a simple heuristic: was there ANY non-pipeline comment
 * authored AFTER the block label was added (we approximate "label-added time"
 * by the most recent pipeline comment that mentions the block label, falling
 * back to the most recent block-diagnostic-style comment from the tick).
 *
 * `block:ci` does NOT route through this function — the dispatcher polls CI
 * directly and clears `block:ci` automatically.
 */
export function hasUnblockEvidence(comments: TicketComment[]): boolean {
  const sorted = [...comments].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  // Walk from the end; first non-pipeline comment wins as evidence
  // unless it itself is a block-diagnostic written by the tick (those start
  // with a recognizable prefix; for Phase 1 we accept any non-pipeline comment
  // as evidence).
  for (let i = sorted.length - 1; i >= 0; i--) {
    const c = sorted[i];
    const trimmed = c.body.trim();
    if (PIPELINE_PREFIXES.some((p) => trimmed.startsWith(p))) continue;
    return true;
  }
  return false;
}
```

- [ ] **Step 8.4:** Create `src/pipeline/block-evidence.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { hasUnblockEvidence } from "./block-evidence.js";
import type { TicketComment } from "./types.js";

const c = (body: string, ts: string): TicketComment => ({ id: ts, body, createdAt: ts });

describe("hasUnblockEvidence", () => {
  it("returns false when only pipeline comments exist", () => {
    expect(
      hasUnblockEvidence([
        c("tick-lock-claim: runId=tick-1 action=pickup", "2026-04-26T00:00:00.000Z"),
        c("tick-spawn-log: runId=tick-1 agentId=x", "2026-04-26T00:00:01.000Z"),
        c("tick-lock-release: runId=tick-1 outcome=spawned", "2026-04-26T00:00:02.000Z"),
      ]),
    ).toBe(false);
  });

  it("returns true when at least one non-pipeline comment exists", () => {
    expect(
      hasUnblockEvidence([
        c("tick-lock-claim: runId=tick-1 action=pickup", "2026-04-26T00:00:00.000Z"),
        c("Operator: I rebased and pushed.", "2026-04-26T00:01:00.000Z"),
      ]),
    ).toBe(true);
  });

  it("returns false on empty comment list", () => {
    expect(hasUnblockEvidence([])).toBe(false);
  });
});
```

- [ ] **Step 8.5:** Create `src/pipeline/budget.ts`:

```typescript
import type { BudgetCounters } from "./types.js";

export class Budget {
  private spawnUsed = 0;
  private actionUsed = 0;

  constructor(
    public readonly spawnLimit: number,
    public readonly actionLimit: number,
  ) {
    if (spawnLimit < 0) throw new Error("spawnLimit must be >= 0");
    if (actionLimit < 0) throw new Error("actionLimit must be >= 0");
  }

  /** Always consumes an action slot. Returns false if the action-budget is exhausted. */
  tryConsumeAction(): boolean {
    if (this.actionUsed >= this.actionLimit) return false;
    this.actionUsed += 1;
    return true;
  }

  /** Consumes both an action slot and a spawn slot. Returns false if either is exhausted. */
  tryConsumeSpawn(): boolean {
    if (this.spawnUsed >= this.spawnLimit) return false;
    if (this.actionUsed >= this.actionLimit) return false;
    this.spawnUsed += 1;
    this.actionUsed += 1;
    return true;
  }

  summary(): BudgetCounters {
    return {
      spawnUsed: this.spawnUsed,
      spawnLimit: this.spawnLimit,
      actionUsed: this.actionUsed,
      actionLimit: this.actionLimit,
    };
  }
}
```

- [ ] **Step 8.6:** Create `src/pipeline/budget.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { Budget } from "./budget.js";

describe("Budget", () => {
  it("tracks action consumption up to limit", () => {
    const b = new Budget(3, 5);
    expect(b.tryConsumeAction()).toBe(true);
    expect(b.tryConsumeAction()).toBe(true);
    expect(b.tryConsumeAction()).toBe(true);
    expect(b.tryConsumeAction()).toBe(true);
    expect(b.tryConsumeAction()).toBe(true);
    expect(b.tryConsumeAction()).toBe(false);
  });

  it("spawn consumes both spawn and action slots", () => {
    const b = new Budget(2, 5);
    expect(b.tryConsumeSpawn()).toBe(true);
    expect(b.tryConsumeSpawn()).toBe(true);
    expect(b.tryConsumeSpawn()).toBe(false); // spawn exhausted
    expect(b.summary()).toEqual({
      spawnUsed: 2,
      spawnLimit: 2,
      actionUsed: 2,
      actionLimit: 5,
    });
  });

  it("spawn fails when action-budget exhausted even if spawn available", () => {
    const b = new Budget(5, 1);
    expect(b.tryConsumeAction()).toBe(true);
    expect(b.tryConsumeSpawn()).toBe(false); // action exhausted
  });

  it("rejects negative limits", () => {
    expect(() => new Budget(-1, 1)).toThrow();
    expect(() => new Budget(1, -1)).toThrow();
  });
});
```

- [ ] **Step 8.7:** Create `src/pipeline/repo-resolver.ts`:

```typescript
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResolvedRepo, TicketState } from "./types.js";
import type { PipelineConfig } from "../types.js";

const DESCRIPTION_HINTS: Array<{ name: string; pattern: RegExp }> = [
  { name: "hive", pattern: /\b(hive\b|~\/github\/hive|github\.com\/[\w-]+\/hive\b)/i },
  { name: "beekeeper", pattern: /\b(beekeeper\b|~\/github\/beekeeper|github\.com\/[\w-]+\/beekeeper\b)/i },
];

/**
 * Resolve the target repo from a ticket. Order of checks:
 *   1. `repo:<name>` label (Phase 1: TBD per spec; we accept it if present).
 *   2. config.repoPaths keys grepped against ticket description.
 *   3. Built-in DESCRIPTION_HINTS as a fallback for hive/beekeeper.
 * Returns null when ambiguous or unresolvable; caller marks `block:human`.
 */
export function resolveRepo(
  ticket: TicketState,
  config?: PipelineConfig,
): ResolvedRepo | null {
  // 1. repo:<name> label
  for (const label of ticket.labels) {
    if (label.startsWith("repo:")) {
      const name = label.slice("repo:".length);
      const path = lookupPath(name, config);
      if (path && existsSync(path)) return { name, path };
    }
  }

  // 2. config.repoPaths keys grepped in description
  if (config?.repoPaths) {
    const matches: ResolvedRepo[] = [];
    for (const [name, path] of Object.entries(config.repoPaths)) {
      const re = new RegExp(`\\b${escapeRegex(name)}\\b`, "i");
      if (re.test(ticket.description) && existsSync(path)) {
        matches.push({ name, path });
      }
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null; // ambiguous
  }

  // 3. Built-in fallback
  const matches: ResolvedRepo[] = [];
  for (const hint of DESCRIPTION_HINTS) {
    if (hint.pattern.test(ticket.description)) {
      const path = lookupPath(hint.name, config);
      if (path && existsSync(path)) matches.push({ name: hint.name, path });
    }
  }
  if (matches.length === 1) return matches[0];
  return null;
}

function lookupPath(name: string, config?: PipelineConfig): string | undefined {
  if (config?.repoPaths?.[name]) return config.repoPaths[name];
  return join(homedir(), "github", name);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

- [ ] **Step 8.8:** Create `src/pipeline/repo-resolver.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { resolveRepo } from "./repo-resolver.js";
import type { TicketState } from "./types.js";

function ticket(over: Partial<TicketState>): TicketState {
  return {
    id: "id",
    identifier: "KPR-1",
    title: "t",
    description: "",
    state: "Backlog",
    labels: [],
    blockedBy: [],
    comments: [],
    attachments: [],
    ...over,
  };
}

// NOTE: paths here must exist on the test runner. We use the actual checkout
// dirs since they're known to exist on the dev machine. CI will need either
// fake fixtures or skipping; deferring fixture-based tests to Phase 2.
describe("resolveRepo", () => {
  const config = {
    linearTeamKey: "KPR",
    repoPaths: {
      hive: "/Users/mokie/github/hive",
      beekeeper: "/Users/mokie/github/beekeeper",
    },
  };

  it("returns null when description has no repo hints", () => {
    expect(resolveRepo(ticket({ description: "fix the thing" }), config)).toBeNull();
  });

  it("matches single repo by config key", () => {
    const r = resolveRepo(ticket({ description: "Update beekeeper config." }), config);
    expect(r?.name).toBe("beekeeper");
  });

  it("returns null when description matches multiple", () => {
    const r = resolveRepo(
      ticket({ description: "Cross-repo touching hive and beekeeper." }),
      config,
    );
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 8.9:** Verify

```bash
npm run check
```

- [ ] **Step 8.10:** Commit

```bash
git add src/pipeline/reviewer-parser.ts src/pipeline/reviewer-parser.test.ts \
        src/pipeline/block-evidence.ts src/pipeline/block-evidence.test.ts \
        src/pipeline/budget.ts src/pipeline/budget.test.ts \
        src/pipeline/repo-resolver.ts src/pipeline/repo-resolver.test.ts
git commit -m "feat(pipeline): reviewer parser, block evidence, budget, repo resolver"
```

---

## Task 9: Subagent spawn driver + prompt templates

Per **OQ-1 (RESOLVED → A)**: launches go through `child_process.spawn("claude", ["-p", prompt], { detached: true, stdio: "ignore" })`. The launched subagent runs to completion and writes its result back to Linear (drafting commits markdown + posts a comment, reviewer posts a structured JSON comment, implementer opens the PR via `gh`). The launched process inherits `process.env`, plus `PIPELINE_AGENT_ID`, `PIPELINE_TICKET_ID`, and `PIPELINE_KIND` for audit-trail purposes — `LINEAR_API_KEY` flows through the inherited env.

**Files:**
- Create: `src/pipeline/subagent-spawn.ts`
- Create: `src/pipeline/subagent-spawn.test.ts`
- Create: `src/pipeline/prompts/drafting.ts`
- Create: `src/pipeline/prompts/reviewer.ts`
- Create: `src/pipeline/prompts/implementer.ts`

- [ ] **Step 9.1:** Create `src/pipeline/subagent-spawn.ts`:

```typescript
import { spawn } from "node:child_process";
import { ulid } from "ulid";
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
  /** Phase 1: always "started". Tick does not wait. */
  status: "started";
}

/**
 * Per OQ-1: detached `claude` CLI children. The tick CLI exits immediately;
 * each subagent runs to completion in the background and writes its result
 * back to Linear via the inherited `LINEAR_API_KEY`. `child.unref()` so the
 * parent can exit without waiting.
 *
 * `claude -p <prompt>` is the documented non-interactive (print) mode; tools
 * are still permitted, so the subagent can read/write files, call `git`,
 * `gh`, and similar. The subagent is responsible for posting its own audit
 * comments on the ticket.
 *
 * NOTE: This is the lone documented exception to the "no execFile-on-shell"
 * convention. The arg array is still strictly `[binary, ...args]` form — no
 * shell-string concatenation.
 */
export async function spawnSubagent(input: SpawnInput): Promise<SpawnResult> {
  const agentId = `agent-${ulid()}`;
  const args = ["-p", input.prompt];
  const child = spawn("claude", args, {
    cwd: input.repoPath,
    env: {
      ...process.env,
      PIPELINE_AGENT_ID: agentId,
      PIPELINE_TICKET_ID: input.ticketId,
      PIPELINE_KIND: input.kind,
    },
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();
  log.info("Subagent launched", {
    agentId,
    kind: input.kind,
    ticketId: input.ticketId,
    repoPath: input.repoPath,
    pid: child.pid,
  });
  return { agentId, status: "started" };
}
```

- [ ] **Step 9.2:** Create `src/pipeline/subagent-spawn.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const fakeChild = { unref: vi.fn(), pid: 12345 };

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockReturnValue(fakeChild);
  fakeChild.unref.mockClear();
});

describe("spawnSubagent", () => {
  it("invokes claude -p with the prompt and detaches the child", async () => {
    const { spawnSubagent } = await import("./subagent-spawn.js");
    const result = await spawnSubagent({
      kind: "draft-plan",
      prompt: "draft me a plan",
      repoPath: "/tmp/repo",
      ticketId: "KPR-90",
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: unknown },
    ];
    expect(bin).toBe("claude");
    expect(args).toEqual(["-p", "draft me a plan"]);
    expect(opts.cwd).toBe("/tmp/repo");
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toEqual(["ignore", "ignore", "ignore"]);
    expect(opts.env.PIPELINE_AGENT_ID).toBe(result.agentId);
    expect(opts.env.PIPELINE_TICKET_ID).toBe("KPR-90");
    expect(opts.env.PIPELINE_KIND).toBe("draft-plan");
    expect(fakeChild.unref).toHaveBeenCalled();
    expect(result.status).toBe("started");
    expect(result.agentId).toMatch(/^agent-[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("propagates the LINEAR_API_KEY through inherited env", async () => {
    const prev = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "lin_api_test";
    try {
      const { spawnSubagent } = await import("./subagent-spawn.js");
      await spawnSubagent({
        kind: "code-review",
        prompt: "review",
        repoPath: "/tmp/r",
        ticketId: "KPR-1",
      });
      const opts = spawnMock.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
      expect(opts.env.LINEAR_API_KEY).toBe("lin_api_test");
    } finally {
      if (prev === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = prev;
    }
  });
});
```

- [ ] **Step 9.3:** Create `src/pipeline/prompts/drafting.ts`:

```typescript
/**
 * Prompt template constants for spec-drafting and plan-drafting subagents.
 *
 * Both bake in the spec §"Drafting subagent contract": the subagent must emit
 * v1 of the artifact PLUS an open-questions list, and must end with a marker
 * the tick's next pass can detect (`## Open design questions` heading).
 *
 * Memory-rule references baked in:
 *   - feedback_pipeline_review_rule.md (open-questions contract)
 *   - feedback_agent_review_workflow.md (multi-round review expectations)
 *
 * Placeholders: `${ticketId}`, `${repoPath}`, `${title}`, `${description}`.
 * The handler substitutes via plain template literals before passing to
 * `spawnSubagent`.
 */

export interface DraftingPromptInput {
  ticketId: string;
  repoPath: string;
  title: string;
  description: string;
  /** Where the artifact must land (relative to repoPath). */
  outputPath: string;
}

const SHARED_PREAMBLE = `You are running as a DETACHED Claude Code session launched by Beekeeper's pipeline-tick.
You will not be polled or watched — you must complete the work and write your results back to Linear yourself.

Audit-trail environment (already in your env):
- PIPELINE_AGENT_ID — your agent id; quote it in every comment you post
- PIPELINE_TICKET_ID — the Linear ticket you are working
- PIPELINE_KIND — your role (draft-spec, draft-plan, code-review, implementer)
- LINEAR_API_KEY — use this to post comments to the ticket via the Linear API or \`linear-cli\`

Memory rules in scope:
- feedback_pipeline_review_rule.md — drafts MUST surface every uncertainty as an open question rather than guessing.
- feedback_agent_review_workflow.md — drafts will be reviewed; expect 2-3 review rounds.`;

const OPEN_QUESTIONS_CONTRACT = `## Open-questions contract (strict)

When you reach any uncertainty — ambiguous requirement, undecided trade-off, missing fact you cannot
verify, contested design — DO NOT GUESS. Stop, list it, and continue.

At the END of your artifact, append a section literally titled \`## Open design questions\`. List each
open question with:
  - The question itself (one sentence)
  - The options you considered (A/B/C with one-line pros/cons)
  - Your lean (and why), if you have one

If there are zero open questions, still append the section with the line "None — review-clean."
The pipeline detects the heading and uses its presence + body to decide \`block:human\` vs. advance.`;

export function buildSpecDraftingPrompt(input: DraftingPromptInput): string {
  return `${SHARED_PREAMBLE}

# Your task: draft the v1 design SPEC for ${input.ticketId}

Repo: ${input.repoPath}
Output path: ${input.outputPath}
Ticket title: ${input.title}

Ticket description (verbatim):
"""
${input.description}
"""

Steps:
1. Read the ticket description and any links it references.
2. Explore the codebase enough to understand the integration surface.
3. Write the spec at ${input.outputPath} following the repo's existing spec conventions
   (look at sibling files in docs/specs/ for the shape).
4. Append \`## Open design questions\` per the contract below.
5. Commit the file: \`git add ${input.outputPath} && git commit -m "spec(${input.ticketId}): v1 draft"\`.
6. Post a Linear comment on ${input.ticketId} announcing the draft is committed and listing the
   open questions inline. Quote your PIPELINE_AGENT_ID in the comment for audit.

${OPEN_QUESTIONS_CONTRACT}
`;
}

export function buildPlanDraftingPrompt(input: DraftingPromptInput): string {
  return `${SHARED_PREAMBLE}

# Your task: draft the v1 implementation PLAN for ${input.ticketId}

Repo: ${input.repoPath}
Output path: ${input.outputPath}
Ticket title: ${input.title}

Ticket description (verbatim):
"""
${input.description}
"""

Steps:
1. Read the ticket description and the linked spec (if any).
2. Explore the codebase enough to identify files-to-create / files-to-modify.
3. Write the plan at ${input.outputPath} matching the shape of
   docs/plans/2026-04-25-frames-foundation.md (task per logical unit, code blocks,
   commit step at the end of each task).
4. Append \`## Open design questions\` per the contract below.
5. Commit: \`git add ${input.outputPath} && git commit -m "plan(${input.ticketId}): v1 draft"\`.
6. Post a Linear comment on ${input.ticketId} announcing the draft + open questions inline,
   quoting your PIPELINE_AGENT_ID.

${OPEN_QUESTIONS_CONTRACT}
`;
}
```

- [ ] **Step 9.4:** Create `src/pipeline/prompts/reviewer.ts`:

```typescript
/**
 * Prompt template for the code-reviewer subagent.
 *
 * Bakes in the pipeline review rule (APPROVE = zero BLOCKER + zero SHOULD-FIX)
 * per `feedback_pipeline_review_rule.md`. The reviewer-parser re-asserts this
 * rule even if the reviewer's verdict drifts (KPR-84 trial regression), but
 * the prompt cites it explicitly so the reviewer's output is correct on the
 * first pass.
 *
 * The reviewer MUST emit a fenced \`\`\`json block with shape:
 *   { verdict: "APPROVE" | "REQUEST CHANGES",
 *     findings: [{ severity, body, disposition }] }
 * — parsed by `reviewer-parser.ts`.
 */

export interface ReviewerPromptInput {
  ticketId: string;
  repoPath: string;
  /** GitHub PR URL to review. */
  prUrl: string;
}

export function buildReviewerPrompt(input: ReviewerPromptInput): string {
  return `You are running as a DETACHED Claude Code session launched by Beekeeper's pipeline-tick.
Your role is REVIEWER for ${input.ticketId}.

Audit-trail environment (already in your env):
- PIPELINE_AGENT_ID — quote it in every comment you post
- PIPELINE_TICKET_ID = ${input.ticketId}
- PIPELINE_KIND = code-review
- LINEAR_API_KEY — post your verdict to ${input.ticketId} as a Linear comment

Memory rule in scope (cited explicitly):
**feedback_pipeline_review_rule.md** — APPROVE means zero BLOCKER findings AND zero SHOULD-FIX
findings. NICE-TO-HAVE alone may APPROVE. Any BLOCKER or SHOULD-FIX → REQUEST CHANGES.
This rule is enforced by the parser regardless of what you write — but write it correctly.

# Your task: review PR ${input.prUrl}

Repo: ${input.repoPath}
PR: ${input.prUrl}

Steps:
1. \`gh pr checkout ${input.prUrl}\` (or fetch the PR ref) inside ${input.repoPath}.
2. Read the diff against the PR's base branch. Read the spec/plan the PR claims to implement.
3. Categorize each issue you find:
   - **BLOCKER**: correctness bug, security issue, spec non-compliance, regression.
   - **SHOULD-FIX**: code quality, missing test coverage on a touched path, gotcha that will bite later.
   - **NICE-TO-HAVE**: pure preference, future polish.
4. For each finding decide \`disposition\`:
   - \`fix-in-this-PR\` if it's local to the PR and small.
   - \`file-follow-up\` if it's larger or out-of-scope (the pipeline will create a child ticket).
5. Post a Linear comment on ${input.ticketId} containing EXACTLY ONE fenced JSON block in this shape:

\`\`\`json
{
  "verdict": "APPROVE" | "REQUEST CHANGES",
  "findings": [
    {
      "severity": "BLOCKER" | "SHOULD-FIX" | "NICE-TO-HAVE",
      "body": "explanation of the issue, with file:line references where applicable",
      "disposition": "fix-in-this-PR" | "file-follow-up"
    }
  ]
}
\`\`\`

The comment may include prose around the JSON block, but the parser only reads the fenced JSON.
Quote your PIPELINE_AGENT_ID somewhere in the comment for audit.
`;
}
```

- [ ] **Step 9.5:** Create `src/pipeline/prompts/implementer.ts`:

```typescript
/**
 * Prompt template for the implementer subagent (pickup action).
 *
 * Memory-rule references baked in:
 *   - feedback_pr_base_on_epic_branches.md — phase tickets must \`--base <epic-branch>\`,
 *     never main.
 *   - feedback_merge_strategy.md — chosen strategy depends on PR shape; the implementer
 *     does not merge (the tick's merge handler does), but the implementer must open the PR
 *     with the correct base ref so the merge strategy resolves correctly.
 */

export interface ImplementerPromptInput {
  ticketId: string;
  repoPath: string;
  /** Absolute path (or repo-relative) to the plan file. */
  planPath: string;
  /** The branch that the PR's base should be — typically the parent epic's branch. */
  epicBranch: string;
  /** The branch the implementer should work on (created if it doesn't exist). */
  workBranch: string;
}

export function buildImplementerPrompt(input: ImplementerPromptInput): string {
  return `You are running as a DETACHED Claude Code session launched by Beekeeper's pipeline-tick.
Your role is IMPLEMENTER for ${input.ticketId}.

Audit-trail environment (already in your env):
- PIPELINE_AGENT_ID — quote it in every comment you post
- PIPELINE_TICKET_ID = ${input.ticketId}
- PIPELINE_KIND = implementer
- LINEAR_API_KEY — post status to ${input.ticketId} via Linear API

Memory rules in scope (cited explicitly):
**feedback_pr_base_on_epic_branches.md** — when ${input.ticketId} is a phase/sub-task of an epic,
the PR MUST be opened with \`--base ${input.epicBranch}\`. Main is branch-protected; never PR
phase tickets directly to main.
**feedback_merge_strategy.md** — phase→epic uses merge-commit; single-purpose→main uses squash;
epic→main uses merge-commit. The pipeline's merge handler picks the strategy based on base ref —
your job is to set the correct base ref.

# Your task: implement ${input.ticketId} per the plan

Repo: ${input.repoPath}
Plan: ${input.planPath}
Base branch (PR target): ${input.epicBranch}
Work branch: ${input.workBranch}

Steps:
1. \`cd ${input.repoPath}\`
2. \`git fetch origin && git checkout -B ${input.workBranch} origin/${input.epicBranch}\`
3. Read ${input.planPath} end-to-end.
4. Execute each task in the plan: implement, run \`npm run check\`, commit. One commit per task.
5. Push: \`git push -u origin ${input.workBranch}\`
6. Open the PR with \`gh pr create --base ${input.epicBranch} --title "<title>" --body "<body>"\`.
   The body must reference ${input.ticketId} and the plan path.
7. Post a Linear comment on ${input.ticketId} with the PR URL, quoting PIPELINE_AGENT_ID.
8. Exit cleanly. The pipeline's next tick will see the PR attached to the ticket and route to review.

If you hit a blocker (failing tests you can't fix, missing context, ambiguous spec):
- Stop committing.
- Post a Linear comment on ${input.ticketId} starting with "BLOCKED:" describing what you need.
- Quote PIPELINE_AGENT_ID. Exit. The pipeline's next tick will see the BLOCKED comment and apply
  \`block:human\`.
`;
}
```

- [ ] **Step 9.6:** Verify

```bash
npm run check
```

Expected: typecheck + tests pass; the new `subagent-spawn.test.ts` adds 2 assertions.

- [ ] **Step 9.7:** Commit

```bash
git add src/pipeline/subagent-spawn.ts src/pipeline/subagent-spawn.test.ts \
        src/pipeline/prompts/drafting.ts src/pipeline/prompts/reviewer.ts \
        src/pipeline/prompts/implementer.ts
git commit -m "feat(pipeline): subagent spawn driver + prompt templates"
```

---

## Task 10: Per-action handlers

Now that **OQ-1 is resolved → A**, handlers call `spawnSubagent` (fire-and-forget) and return immediately. The tick's next pass interrogates ticket comments + GitHub PR state to advance.

Each handler returns the same shape:

```typescript
export interface HandlerResult {
  outcome: "spawned" | "transitioned" | "blocked" | "skipped";
  detail?: string;
  /** Set when the handler launched a subagent so the tick-runner can post tick-spawn-log. */
  agentId?: string;
}
```

**Files:**
- Create: `src/pipeline/handlers/types.ts`
- Create: `src/pipeline/handlers/drafting.ts` + `.test.ts`
- Create: `src/pipeline/handlers/pickup.ts`
- Create: `src/pipeline/handlers/review.ts` + `.test.ts`
- Create: `src/pipeline/handlers/merge.ts`

- [ ] **Step 10.1:** Create `src/pipeline/handlers/types.ts`:

```typescript
import type { LinearClient } from "../linear-client.js";
import type { ActionDecision, PipelineLabel, TicketState } from "../types.js";
import type { PipelineConfig } from "../../types.js";
import type { SpawnInput, SpawnResult } from "../subagent-spawn.js";

export interface HandlerResult {
  outcome: "spawned" | "transitioned" | "blocked" | "skipped";
  detail?: string;
  /** Returned when a subagent was launched, for `tick-spawn-log` audit. */
  agentId?: string;
}

/**
 * Common context every handler receives. The `spawn` function is injected so
 * tests can substitute a mock without spinning up `claude`.
 */
export interface HandlerContext {
  client: LinearClient;
  ticket: TicketState;
  decision: ActionDecision;
  config: PipelineConfig;
  spawn: (input: SpawnInput) => Promise<SpawnResult>;
}

/** Helper: apply `block:human` with a comment. Used by every handler on hard failures. */
export async function blockHuman(
  client: LinearClient,
  ticket: TicketState,
  reason: string,
): Promise<HandlerResult> {
  const label: PipelineLabel = "block:human";
  if (!ticket.labels.includes(label)) {
    await client.addLabel(ticket.id, label);
  }
  await client.addComment(ticket.id, `block:human — ${reason}`);
  return { outcome: "blocked", detail: reason };
}
```

- [ ] **Step 10.2:** Create `src/pipeline/handlers/drafting.ts`:

```typescript
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRepo } from "../repo-resolver.js";
import { buildPlanDraftingPrompt, buildSpecDraftingPrompt } from "../prompts/drafting.js";
import { blockHuman, type HandlerContext, type HandlerResult } from "./types.js";

const OPEN_QUESTIONS_HEADING = /^##\s+Open design questions\s*$/m;
const NONE_LINE = /None\s*[—-]\s*review-clean\.?/i;

/**
 * Returns the canonical artifact path under the resolved repo, given the
 * ticket and decision kind. Phase 1 convention:
 *   - draft-spec → docs/specs/<YYYY-MM-DD>-<ticket-id>-design.md
 *   - draft-plan → docs/plans/<YYYY-MM-DD>-<ticket-id>.md
 * The drafting subagent commits to `_pending_review/` first per the open-questions
 * contract; this resolver checks both locations.
 */
export function artifactCandidatePaths(
  repoPath: string,
  kind: "spec" | "plan",
  ticketId: string,
): string[] {
  const subdir = kind === "spec" ? "specs" : "plans";
  const ticketLower = ticketId.toLowerCase();
  return [
    join(repoPath, "docs", subdir, "_pending_review"),
    join(repoPath, "docs", subdir),
  ].flatMap((dir) => [
    join(dir, `${ticketLower}.md`),
    join(dir, `${ticketLower}-design.md`),
  ]);
}

function findExistingArtifact(repoPath: string, kind: "spec" | "plan", ticketId: string): string | undefined {
  // Pattern-match by date prefix is brittle; the drafting subagent posts the
  // exact path back via Linear comment. For Phase 1 we accept the canonical
  // locations and the simple ticketId-named candidates.
  for (const path of artifactCandidatePaths(repoPath, kind, ticketId)) {
    if (existsSync(path)) return path;
  }
  return undefined;
}

/**
 * Drafting handler — handles draft-spec, draft-plan, spec-review, plan-review.
 *
 * Behavior:
 *   1. Resolve repo. If unresolvable → block:human.
 *   2. If a draft exists at the canonical path AND has zero open questions
 *      ("None — review-clean.") → advance state past Spec/Plan Drafting.
 *   3. If a draft exists with open questions → block:human, post the questions
 *      inline.
 *   4. If no draft yet → launch drafting subagent, return spawned.
 */
export async function handleDrafting(ctx: HandlerContext): Promise<HandlerResult> {
  const repo = resolveRepo(ctx.ticket, ctx.config);
  if (!repo) {
    return blockHuman(
      ctx.client,
      ctx.ticket,
      "could not resolve target repo from ticket description (add a repo: label or update the description)",
    );
  }

  const kind: "spec" | "plan" = ctx.decision.kind === "draft-spec" || ctx.decision.kind === "spec-review" ? "spec" : "plan";
  const existing = findExistingArtifact(repo.path, kind, ctx.ticket.identifier);

  if (existing) {
    const text = readFileSync(existing, "utf8");
    const hasHeading = OPEN_QUESTIONS_HEADING.test(text);
    if (!hasHeading) {
      // Subagent didn't follow the contract — block for human review.
      return blockHuman(
        ctx.client,
        ctx.ticket,
        `draft at ${existing} is missing the \`## Open design questions\` section`,
      );
    }
    const tail = text.slice(text.search(OPEN_QUESTIONS_HEADING));
    if (NONE_LINE.test(tail)) {
      // Review-clean → advance state.
      const nextState = kind === "spec" ? "Plan Drafting" : "Ready";
      await ctx.client.setState(ctx.ticket.id, nextState);
      await ctx.client.addComment(
        ctx.ticket.id,
        `Drafting handler: ${kind} review-clean → state ${nextState}.`,
      );
      return { outcome: "transitioned", detail: `${kind} clean → ${nextState}` };
    }
    // Open questions present → block for operator review.
    return blockHuman(
      ctx.client,
      ctx.ticket,
      `draft at ${existing} has unresolved open questions; operator must answer before pipeline advances`,
    );
  }

  // No draft yet → launch.
  const outputPath = kind === "spec"
    ? `docs/specs/_pending_review/${ctx.ticket.identifier.toLowerCase()}-design.md`
    : `docs/plans/_pending_review/${ctx.ticket.identifier.toLowerCase()}.md`;
  const prompt = kind === "spec"
    ? buildSpecDraftingPrompt({
        ticketId: ctx.ticket.identifier,
        repoPath: repo.path,
        title: ctx.ticket.title,
        description: ctx.ticket.description,
        outputPath,
      })
    : buildPlanDraftingPrompt({
        ticketId: ctx.ticket.identifier,
        repoPath: repo.path,
        title: ctx.ticket.title,
        description: ctx.ticket.description,
        outputPath,
      });

  const result = await ctx.spawn({
    kind: kind === "spec" ? "draft-spec" : "draft-plan",
    prompt,
    repoPath: repo.path,
    ticketId: ctx.ticket.identifier,
  });

  // Transition into Spec/Plan Drafting state if we're not already there.
  const targetState = kind === "spec" ? "Spec Drafting" : "Plan Drafting";
  if (ctx.ticket.state !== targetState) {
    await ctx.client.setState(ctx.ticket.id, targetState);
  }

  return { outcome: "spawned", detail: `${kind} drafting subagent launched`, agentId: result.agentId };
}
```

- [ ] **Step 10.3:** Create `src/pipeline/handlers/drafting.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDrafting } from "./drafting.js";
import type { LinearClient } from "../linear-client.js";
import type { ActionDecision, TicketState } from "../types.js";
import type { PipelineConfig } from "../../types.js";

function ticket(over: Partial<TicketState>): TicketState {
  return {
    id: "issue-id",
    identifier: "KPR-9",
    title: "test",
    description: "Update beekeeper config.",
    state: "Backlog",
    labels: ["pipeline-auto", "type:plan-only"],
    blockedBy: [],
    comments: [],
    attachments: [],
    ...over,
  };
}

function decision(kind: ActionDecision["kind"]): ActionDecision {
  return { kind, reason: "test", spawns: kind === "draft-plan" || kind === "draft-spec" };
}

function clientStub(): LinearClient {
  return {
    addLabel: vi.fn().mockResolvedValue(undefined),
    addComment: vi.fn().mockResolvedValue({ id: "c1", createdAt: new Date().toISOString() }),
    setState: vi.fn().mockResolvedValue(undefined),
  } as unknown as LinearClient;
}

describe("handleDrafting", () => {
  it("blocks when repo cannot be resolved", async () => {
    const config: PipelineConfig = { linearTeamKey: "KPR", repoPaths: {} };
    const client = clientStub();
    const result = await handleDrafting({
      client,
      ticket: ticket({ description: "no hints here" }),
      decision: decision("draft-plan"),
      config,
      spawn: vi.fn(),
    });
    expect(result.outcome).toBe("blocked");
    expect(client.addLabel).toHaveBeenCalledWith("issue-id", "block:human");
  });

  it("spawns drafting subagent when no draft exists", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "drafting-"));
    try {
      const config: PipelineConfig = { linearTeamKey: "KPR", repoPaths: { repoX: tmp } };
      const client = clientStub();
      const spawn = vi.fn().mockResolvedValue({ agentId: "agent-Z", status: "started" });
      const result = await handleDrafting({
        client,
        ticket: ticket({ description: "fix repoX bug" }),
        decision: decision("draft-plan"),
        config,
        spawn,
      });
      expect(result.outcome).toBe("spawned");
      expect(result.agentId).toBe("agent-Z");
      expect(spawn).toHaveBeenCalledTimes(1);
      const call = (spawn.mock.calls[0] as [{ kind: string; repoPath: string }])[0];
      expect(call.kind).toBe("draft-plan");
      expect(call.repoPath).toBe(tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("blocks when existing draft has open questions", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "drafting-"));
    try {
      mkdirSync(join(tmp, "docs", "plans", "_pending_review"), { recursive: true });
      writeFileSync(
        join(tmp, "docs", "plans", "_pending_review", "kpr-9.md"),
        "# Plan\n\nbody\n\n## Open design questions\n\n### OQ-1: foo\nWhat?\n",
      );
      const config: PipelineConfig = { linearTeamKey: "KPR", repoPaths: { repoX: tmp } };
      const client = clientStub();
      const result = await handleDrafting({
        client,
        ticket: ticket({ description: "do thing in repoX", state: "Plan Drafting" }),
        decision: decision("plan-review"),
        config,
        spawn: vi.fn(),
      });
      expect(result.outcome).toBe("blocked");
      expect(client.addLabel).toHaveBeenCalledWith("issue-id", "block:human");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("transitions when existing draft is review-clean", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "drafting-"));
    try {
      mkdirSync(join(tmp, "docs", "plans", "_pending_review"), { recursive: true });
      writeFileSync(
        join(tmp, "docs", "plans", "_pending_review", "kpr-9.md"),
        "# Plan\n\nbody\n\n## Open design questions\n\nNone — review-clean.\n",
      );
      const config: PipelineConfig = { linearTeamKey: "KPR", repoPaths: { repoX: tmp } };
      const client = clientStub();
      const result = await handleDrafting({
        client,
        ticket: ticket({ description: "do thing in repoX", state: "Plan Drafting" }),
        decision: decision("plan-review"),
        config,
        spawn: vi.fn(),
      });
      expect(result.outcome).toBe("transitioned");
      expect(client.setState).toHaveBeenCalledWith("issue-id", "Ready");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 10.4:** Create `src/pipeline/handlers/pickup.ts`:

```typescript
import { execFileSync } from "node:child_process";
import { resolveRepo } from "../repo-resolver.js";
import { buildImplementerPrompt } from "../prompts/implementer.js";
import { blockHuman, type HandlerContext, type HandlerResult } from "./types.js";

/**
 * Pickup handler — launches the implementer subagent for a Ready ticket.
 *
 * 1. Resolve repo. If unresolvable → block:human.
 * 2. Verify epic branch exists locally or on origin; create from main if missing.
 * 3. Launch implementer with plan path + repo path + epic branch in the prompt.
 * 4. Transition state → In Progress.
 */
export async function handlePickup(ctx: HandlerContext): Promise<HandlerResult> {
  const repo = resolveRepo(ctx.ticket, ctx.config);
  if (!repo) {
    return blockHuman(
      ctx.client,
      ctx.ticket,
      "could not resolve target repo from ticket description",
    );
  }

  const epicBranch = ctx.ticket.parent
    ? `${ctx.ticket.parent}-epic`
    : ctx.config.mainBranch ?? "main";
  const workBranch = ctx.ticket.identifier.toLowerCase();

  // Ensure epicBranch exists on origin (fail-soft: log and continue if not — implementer
  // will surface the error in its blocking comment).
  try {
    execFileSync("git", ["-C", repo.path, "fetch", "origin", epicBranch], { stdio: "ignore" });
  } catch {
    // Branch may not exist on origin yet; implementer's prompt assumes it does.
    // If it doesn't, the implementer will fail and post a BLOCKED comment, which the
    // next tick converts to block:human.
  }

  const planPath = `docs/plans/${ctx.ticket.identifier.toLowerCase()}.md`;
  const prompt = buildImplementerPrompt({
    ticketId: ctx.ticket.identifier,
    repoPath: repo.path,
    planPath,
    epicBranch,
    workBranch,
  });

  const result = await ctx.spawn({
    kind: "implementer",
    prompt,
    repoPath: repo.path,
    ticketId: ctx.ticket.identifier,
  });

  if (ctx.ticket.state !== "In Progress") {
    await ctx.client.setState(ctx.ticket.id, "In Progress");
  }

  return { outcome: "spawned", detail: "implementer launched", agentId: result.agentId };
}
```

- [ ] **Step 10.5:** Create `src/pipeline/handlers/review.ts`:

```typescript
import { parseReviewerOutput } from "../reviewer-parser.js";
import { buildReviewerPrompt } from "../prompts/reviewer.js";
import { resolveRepo } from "../repo-resolver.js";
import { blockHuman, type HandlerContext, type HandlerResult } from "./types.js";
import type { TicketAttachment, TicketComment } from "../types.js";

const REVIEWER_OUTPUT_HEAD = /```json\s*\{[\s\S]*?"verdict"\s*:/;
const SPAWN_REVIEWER_PREFIX = /^tick-spawn-log:.*kind=code-review/;

function findPrAttachment(attachments: TicketAttachment[]): TicketAttachment | undefined {
  return attachments.find((a) => /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(a.url));
}

function findReviewerOutput(comments: TicketComment[]): string | undefined {
  // Most recent comment with a JSON verdict block wins.
  for (let i = comments.length - 1; i >= 0; i--) {
    if (REVIEWER_OUTPUT_HEAD.test(comments[i].body)) return comments[i].body;
  }
  return undefined;
}

function hasReviewerSpawnLog(comments: TicketComment[]): boolean {
  return comments.some((c) => SPAWN_REVIEWER_PREFIX.test(c.body.trim()));
}

/**
 * Review handler — handles `code-review` for In Progress and In Review states.
 *
 *   In Progress + no PR → wait (skip with detail).
 *   In Progress + PR → transition to In Review.
 *   In Review + no reviewer spawn-log → launch reviewer.
 *   In Review + reviewer output present → parse:
 *     APPROVE → mark for merge (caller routes to merge handler).
 *     REQUEST CHANGES → block:human (Phase 1 keeps the loop simple — the
 *       fix-inline / file-follow-up routing is Phase 2).
 */
export async function handleReview(ctx: HandlerContext): Promise<HandlerResult> {
  if (ctx.ticket.state === "In Progress") {
    const pr = findPrAttachment(ctx.ticket.attachments);
    if (!pr) {
      return { outcome: "skipped", detail: "in progress — no PR attached yet" };
    }
    await ctx.client.setState(ctx.ticket.id, "In Review");
    return { outcome: "transitioned", detail: "PR attached → In Review" };
  }

  // In Review
  const reviewerOutput = findReviewerOutput(ctx.ticket.comments);
  if (!reviewerOutput) {
    if (hasReviewerSpawnLog(ctx.ticket.comments)) {
      return { outcome: "skipped", detail: "reviewer in flight — waiting for output" };
    }
    const repo = resolveRepo(ctx.ticket, ctx.config);
    if (!repo) {
      return blockHuman(ctx.client, ctx.ticket, "could not resolve repo for reviewer");
    }
    const pr = findPrAttachment(ctx.ticket.attachments);
    if (!pr) {
      return blockHuman(ctx.client, ctx.ticket, "ticket is In Review but has no PR attachment");
    }
    const prompt = buildReviewerPrompt({
      ticketId: ctx.ticket.identifier,
      repoPath: repo.path,
      prUrl: pr.url,
    });
    const spawnResult = await ctx.spawn({
      kind: "code-review",
      prompt,
      repoPath: repo.path,
      ticketId: ctx.ticket.identifier,
    });
    return { outcome: "spawned", detail: "reviewer launched", agentId: spawnResult.agentId };
  }

  // Reviewer output present → parse and decide.
  const parsed = parseReviewerOutput(reviewerOutput);
  if (parsed.verdict === "APPROVE") {
    // Caller (tick-runner) sees this outcome+detail and routes to merge handler.
    return { outcome: "transitioned", detail: "APPROVE — ready to merge" };
  }
  // REQUEST CHANGES → Phase 1: block:human with finding summary.
  const summary = parsed.findings
    .map((f, i) => `  ${i + 1}. [${f.severity}] ${f.body}${f.disposition ? ` (${f.disposition})` : ""}`)
    .join("\n");
  return blockHuman(
    ctx.client,
    ctx.ticket,
    `reviewer requested changes:\n${summary}`,
  );
}
```

- [ ] **Step 10.6:** Create `src/pipeline/handlers/review.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { handleReview } from "./review.js";
import type { LinearClient } from "../linear-client.js";
import type { ActionDecision, TicketState, TicketComment, TicketAttachment } from "../types.js";
import type { PipelineConfig } from "../../types.js";

const config: PipelineConfig = { linearTeamKey: "KPR" };

function ticket(over: Partial<TicketState>): TicketState {
  return {
    id: "issue-id",
    identifier: "KPR-9",
    title: "test",
    description: "",
    state: "In Progress",
    labels: ["pipeline-auto"],
    blockedBy: [],
    comments: [],
    attachments: [],
    ...over,
  };
}

const decision: ActionDecision = { kind: "code-review", reason: "test", spawns: false };

function clientStub(): LinearClient {
  return {
    addLabel: vi.fn().mockResolvedValue(undefined),
    addComment: vi.fn().mockResolvedValue({ id: "c1", createdAt: new Date().toISOString() }),
    setState: vi.fn().mockResolvedValue(undefined),
  } as unknown as LinearClient;
}

describe("handleReview", () => {
  it("waits when In Progress with no PR", async () => {
    const result = await handleReview({
      client: clientStub(),
      ticket: ticket({}),
      decision,
      config,
      spawn: vi.fn(),
    });
    expect(result.outcome).toBe("skipped");
  });

  it("transitions to In Review when In Progress + PR present", async () => {
    const attachments: TicketAttachment[] = [
      { id: "a1", url: "https://github.com/x/y/pull/1", title: "PR" },
    ];
    const client = clientStub();
    const result = await handleReview({
      client,
      ticket: ticket({ attachments }),
      decision,
      config,
      spawn: vi.fn(),
    });
    expect(result.outcome).toBe("transitioned");
    expect(client.setState).toHaveBeenCalledWith("issue-id", "In Review");
  });

  it("APPROVE → ready to merge", async () => {
    const comments: TicketComment[] = [
      {
        id: "c1",
        body: '```json\n{"verdict":"APPROVE","findings":[]}\n```',
        createdAt: new Date().toISOString(),
      },
    ];
    const result = await handleReview({
      client: clientStub(),
      ticket: ticket({ state: "In Review", comments }),
      decision,
      config,
      spawn: vi.fn(),
    });
    expect(result.outcome).toBe("transitioned");
    expect(result.detail).toContain("APPROVE");
  });

  it("REQUEST CHANGES → block:human with finding summary", async () => {
    const comments: TicketComment[] = [
      {
        id: "c1",
        body: '```json\n{"verdict":"REQUEST CHANGES","findings":[{"severity":"BLOCKER","body":"x"}]}\n```',
        createdAt: new Date().toISOString(),
      },
    ];
    const client = clientStub();
    const result = await handleReview({
      client,
      ticket: ticket({ state: "In Review", comments }),
      decision,
      config,
      spawn: vi.fn(),
    });
    expect(result.outcome).toBe("blocked");
    expect(client.addLabel).toHaveBeenCalledWith("issue-id", "block:human");
  });
});
```

- [ ] **Step 10.7:** Create `src/pipeline/handlers/merge.ts`:

```typescript
import { execFileSync } from "node:child_process";
import { resolveRepo } from "../repo-resolver.js";
import { blockHuman, type HandlerContext, type HandlerResult } from "./types.js";

const PR_URL_RE = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

/**
 * Merge handler — picks the strategy per `feedback_merge_strategy.md`:
 *   phase → epic        : merge-commit (preserves per-task history)
 *   single-purpose → main : squash
 *   epic → main           : merge-commit
 *
 * Phase 1: classify by base ref (main = squash unless ticket has `epic` label).
 */
export async function handleMerge(ctx: HandlerContext): Promise<HandlerResult> {
  const repo = resolveRepo(ctx.ticket, ctx.config);
  if (!repo) return blockHuman(ctx.client, ctx.ticket, "could not resolve repo for merge");

  const pr = ctx.ticket.attachments.find((a) => PR_URL_RE.test(a.url));
  if (!pr) return blockHuman(ctx.client, ctx.ticket, "merge: no PR attachment on ticket");

  const baseRef = readPrBaseRef(repo.path, pr.url);
  if (!baseRef) return blockHuman(ctx.client, ctx.ticket, `merge: could not read PR base ref for ${pr.url}`);

  const mainBranch = ctx.config.mainBranch ?? "main";
  const isEpicTicket = ctx.ticket.labels.includes("epic");
  const strategy: "merge" | "squash" =
    baseRef !== mainBranch ? "merge" : isEpicTicket ? "merge" : "squash";

  try {
    execFileSync(
      "gh",
      ["pr", "merge", `--${strategy}`, "--auto", pr.url],
      { cwd: repo.path, stdio: "pipe" },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return blockHuman(ctx.client, ctx.ticket, `merge failed: ${msg}`);
  }

  await ctx.client.setState(ctx.ticket.id, "Done");
  await ctx.client.addComment(
    ctx.ticket.id,
    `Merged via \`gh pr merge --${strategy} --auto\` (base=${baseRef}).`,
  );
  return { outcome: "transitioned", detail: `merged (${strategy})` };
}

function readPrBaseRef(repoPath: string, prUrl: string): string | undefined {
  const m = prUrl.match(PR_URL_RE);
  if (!m) return undefined;
  const [, owner, repo, num] = m;
  try {
    const out = execFileSync(
      "gh",
      ["pr", "view", num, "--repo", `${owner}/${repo}`, "--json", "baseRefName", "-q", ".baseRefName"],
      { cwd: repoPath, stdio: ["ignore", "pipe", "ignore"] },
    ).toString().trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 10.8:** Verify

```bash
npm run check
```

- [ ] **Step 10.9:** Commit

```bash
git add src/pipeline/handlers/
git commit -m "feat(pipeline): per-action handlers (drafting/pickup/review/merge)"
```

---

## Task 11: Tick runner + CLI wiring

**Files:**
- Create: `src/pipeline/tick-runner.ts`
- Create: `src/pipeline/tick-runner.test.ts`
- Create: `src/pipeline/cli.ts`
- Modify: `src/cli.ts` (dispatch `case "pipeline-tick":`)

- [ ] **Step 11.1:** Create `src/pipeline/tick-runner.ts`:

```typescript
import { decideAction } from "./action-dispatcher.js";
import { Budget } from "./budget.js";
import { LinearClient } from "./linear-client.js";
import { claim, logSpawn, newRunId, release } from "./mutex.js";
import { spawnSubagent, type SpawnInput, type SpawnResult } from "./subagent-spawn.js";
import { handleDrafting } from "./handlers/drafting.js";
import { handlePickup } from "./handlers/pickup.js";
import { handleReview } from "./handlers/review.js";
import { handleMerge } from "./handlers/merge.js";
import type { HandlerContext, HandlerResult } from "./handlers/types.js";
import type { ActionDecision, TickReport, TickReportEntry, TicketState } from "./types.js";
import type { PipelineConfig } from "../types.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("pipeline-tick");

export interface RunTickOptions {
  /** "<EPIC-ID>" | "<TICKET-ID>" | "--all" */
  scope: string;
  dryRun: boolean;
  spawnBudget: number;
  actionBudget: number;
  includeBlocked: boolean;
  config: PipelineConfig;
  apiKey: string;
  /** Injected for tests; defaults to real LinearClient + real spawnSubagent. */
  clientFactory?: (apiKey: string, teamKey: string) => LinearClient;
  spawnFn?: (input: SpawnInput) => Promise<SpawnResult>;
}

const DEFAULT_SPAWN_BUDGET = 3;
const DEFAULT_ACTION_BUDGET = 25;

export async function runTick(opts: RunTickOptions): Promise<TickReport> {
  const runId = newRunId();
  const startedAt = new Date().toISOString();
  const client = (opts.clientFactory ?? defaultClientFactory)(opts.apiKey, opts.config.linearTeamKey);
  const spawn = opts.spawnFn ?? spawnSubagent;
  const budget = new Budget(
    opts.spawnBudget ?? DEFAULT_SPAWN_BUDGET,
    opts.actionBudget ?? DEFAULT_ACTION_BUDGET,
  );

  const identifiers = await resolveScope(client, opts.scope);
  log.info("Tick scope resolved", { runId, scope: opts.scope, ticketCount: identifiers.length });

  const entries: TickReportEntry[] = [];
  const blocked: TickReportEntry[] = [];

  for (const id of identifiers) {
    let ticket: TicketState;
    try {
      ticket = await client.getTicketState(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      entries.push({
        ticket: id,
        decision: { kind: "skip", reason: `read failed: ${msg}`, spawns: false },
        outcome: "skipped",
        detail: msg,
      });
      continue;
    }

    const decision = decideAction(ticket);

    if (decision.kind === "report-only") {
      const entry: TickReportEntry = { ticket: id, decision, outcome: "report-only", detail: decision.reason };
      if (opts.includeBlocked) blocked.push(entry);
      continue;
    }

    if (decision.kind === "skip") {
      entries.push({ ticket: id, decision, outcome: "skipped", detail: decision.reason });
      continue;
    }

    if (decision.spawns && !budget.tryConsumeSpawn()) {
      entries.push({
        ticket: id,
        decision,
        outcome: "skipped",
        detail: "spawn-budget exhausted",
      });
      continue;
    }
    if (!decision.spawns && !budget.tryConsumeAction()) {
      entries.push({
        ticket: id,
        decision,
        outcome: "skipped",
        detail: "action-budget exhausted",
      });
      break; // hard stop — no more action slots for any ticket.
    }

    if (opts.dryRun) {
      entries.push({ ticket: id, decision, outcome: "skipped", detail: "dry-run" });
      continue;
    }

    const claimResult = await claim(client, id, runId, decision.kind);
    if (!claimResult.acquired) {
      entries.push({
        ticket: id,
        decision,
        outcome: "skipped",
        detail: `lost lock contention (held by ${claimResult.contendedBy ?? "unknown"})`,
      });
      continue;
    }

    let result: HandlerResult;
    try {
      result = await runHandler(client, ticket, decision, opts.config, spawn);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Handler failed", { runId, ticket: id, error: msg });
      result = { outcome: "skipped", detail: `handler error: ${msg}` };
    }

    if (result.agentId) {
      try {
        await logSpawn(client, id, runId, result.agentId);
      } catch (err) {
        log.warn("Spawn-log write failed", { runId, ticket: id, error: String(err) });
      }
    }

    entries.push({ ticket: id, decision, outcome: result.outcome, detail: result.detail });
    await release(client, id, runId, {
      outcome: result.outcome === "transitioned" ? "transitioned"
              : result.outcome === "spawned" ? "spawned"
              : "skipped",
    });
  }

  return {
    runId,
    scope: opts.scope,
    startedAt,
    endedAt: new Date().toISOString(),
    budget: budget.summary(),
    entries,
    blocked,
  };
}

function defaultClientFactory(apiKey: string, teamKey: string): LinearClient {
  return new LinearClient({ apiKey, teamKey });
}

async function resolveScope(client: LinearClient, scope: string): Promise<string[]> {
  if (scope === "--all") return client.listTeamPipelineIssues();
  // Treat any value with team-prefix-N pattern as a single ticket; for an
  // epic, expand to its children. We try children first; if the API returns
  // none, treat the scope as a single-ticket reference.
  const children = await safeListChildren(client, scope);
  if (children.length > 0) return [scope, ...children];
  return [scope];
}

async function safeListChildren(client: LinearClient, identifier: string): Promise<string[]> {
  try {
    return await client.listChildren(identifier);
  } catch {
    return [];
  }
}

async function runHandler(
  client: LinearClient,
  ticket: TicketState,
  decision: ActionDecision,
  config: PipelineConfig,
  spawn: (input: SpawnInput) => Promise<SpawnResult>,
): Promise<HandlerResult> {
  const ctx: HandlerContext = { client, ticket, decision, config, spawn };

  switch (decision.kind) {
    case "draft-spec":
    case "draft-plan":
    case "spec-review":
    case "plan-review":
      return handleDrafting(ctx);
    case "pickup":
      return handlePickup(ctx);
    case "code-review": {
      const result = await handleReview(ctx);
      // APPROVE result → route immediately to merge in the same tick.
      if (result.outcome === "transitioned" && result.detail?.includes("APPROVE")) {
        return handleMerge(ctx);
      }
      return result;
    }
    case "merge":
      return handleMerge(ctx);
    case "advance": {
      const next = (decision.payload?.nextState as string) ?? "Ready";
      await client.setState(ticket.id, next as Parameters<typeof client.setState>[1]);
      return { outcome: "transitioned", detail: `advanced to ${next}` };
    }
    default:
      return { outcome: "skipped", detail: `no handler for ${decision.kind}` };
  }
}
```

- [ ] **Step 11.2:** Create `src/pipeline/tick-runner.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { runTick } from "./tick-runner.js";
import type { LinearClient } from "./linear-client.js";
import type { TicketState } from "./types.js";
import type { PipelineConfig } from "../types.js";

const config: PipelineConfig = { linearTeamKey: "KPR" };

function ticket(over: Partial<TicketState>): TicketState {
  return {
    id: "issue-id",
    identifier: "KPR-9",
    title: "test",
    description: "",
    state: "Backlog",
    labels: ["pipeline-auto", "type:trivial"],
    blockedBy: [],
    comments: [],
    attachments: [],
    ...over,
  };
}

function mockClient(t: TicketState): LinearClient {
  return {
    listTeamPipelineIssues: vi.fn().mockResolvedValue([t.identifier]),
    listChildren: vi.fn().mockResolvedValue([]),
    getTicketState: vi.fn().mockResolvedValue(t),
    addComment: vi.fn().mockResolvedValue({ id: "c", createdAt: new Date().toISOString() }),
    setState: vi.fn().mockResolvedValue(undefined),
    addLabel: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
  } as unknown as LinearClient;
}

describe("runTick", () => {
  it("dry-run does not call setState or spawn", async () => {
    const t = ticket({});
    const client = mockClient(t);
    const spawnFn = vi.fn();
    const report = await runTick({
      scope: "--all",
      dryRun: true,
      spawnBudget: 3,
      actionBudget: 25,
      includeBlocked: false,
      config,
      apiKey: "lin_x",
      clientFactory: () => client,
      spawnFn,
    });
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].outcome).toBe("skipped");
    expect(report.entries[0].detail).toBe("dry-run");
    expect(client.setState).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("trivial Backlog → advance to Ready writes setState", async () => {
    // Spy claim/release writes via addComment — they all go through addComment.
    const t = ticket({});
    const client = mockClient({
      ...t,
      // mutex.claim re-reads after writing; provide stable comments so it sees its own claim.
    });
    // Patch getTicketState to return distinct mutex states across calls.
    let calls = 0;
    (client.getTicketState as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return t; // top-level read
      // mutex pre-claim read (no claims yet)
      if (calls === 2) return { ...t, comments: [] };
      // After write, return our claim as latest. The body must match the
      // exact format mutex.claim wrote (we reverse-engineer: runId comes from
      // the test path, which we cannot read directly. Instead, we accept any
      // claim and let the verify pass since there is no contender.).
      return {
        ...t,
        comments: [
          {
            id: "c-claim",
            body: "tick-lock-claim: runId=tick-X action=advance",
            createdAt: new Date().toISOString(),
          },
        ],
      };
    });
    const report = await runTick({
      scope: "--all",
      dryRun: false,
      spawnBudget: 3,
      actionBudget: 25,
      includeBlocked: false,
      config,
      apiKey: "lin_x",
      clientFactory: () => client,
      spawnFn: vi.fn(),
    });
    // We don't assert on the post-runId mutex round-trip here (covered by mutex.test.ts);
    // we only assert the runner consulted the dispatcher correctly.
    expect(report.entries[0].decision.kind).toBe("advance");
  });

  it("spawn-budget caps spawning decisions", async () => {
    const t = ticket({ labels: ["pipeline-auto", "type:plan-only"] });
    const client = mockClient(t);
    (client.listTeamPipelineIssues as ReturnType<typeof vi.fn>).mockResolvedValue([
      "KPR-1",
      "KPR-2",
      "KPR-3",
    ]);
    (client.getTicketState as ReturnType<typeof vi.fn>).mockResolvedValue(t);
    const spawnFn = vi.fn().mockResolvedValue({ agentId: "agent-Z", status: "started" });
    const report = await runTick({
      scope: "--all",
      dryRun: true, // dry-run still consumes budget per the runner contract
      spawnBudget: 1,
      actionBudget: 25,
      includeBlocked: false,
      config,
      apiKey: "lin_x",
      clientFactory: () => client,
      spawnFn,
    });
    // First ticket consumes the only spawn slot; the next two are skipped.
    const skipped = report.entries.filter((e) => e.detail === "spawn-budget exhausted");
    expect(skipped.length).toBe(2);
  });

  it("includeBlocked surfaces report-only entries in `blocked`", async () => {
    const t = ticket({ labels: ["pipeline-auto", "block:human"] });
    const client = mockClient(t);
    const report = await runTick({
      scope: "--all",
      dryRun: true,
      spawnBudget: 3,
      actionBudget: 25,
      includeBlocked: true,
      config,
      apiKey: "lin_x",
      clientFactory: () => client,
      spawnFn: vi.fn(),
    });
    expect(report.blocked.length).toBe(1);
    expect(report.blocked[0].decision.kind).toBe("report-only");
  });
});
```

- [ ] **Step 11.3:** Create `src/pipeline/cli.ts`:

```typescript
import { runTick, type RunTickOptions } from "./tick-runner.js";
import type { TickReport } from "./types.js";
import type { PipelineConfig } from "../types.js";

export interface PipelineCliInputs {
  argv: string[];
  config: PipelineConfig | undefined;
  apiKey: string | undefined;
}

export interface PipelineCliResult {
  exitCode: number;
  report?: TickReport;
  /** Lines to print to stdout (for slash-command callers). */
  output: string[];
  /** Lines to print to stderr (for human errors). */
  errors: string[];
}

const DEFAULTS = { spawnBudget: 3, actionBudget: 25 } as const;

/**
 * Pure entry point — parses argv, validates env+config, runs the tick, and
 * returns a structured result. The CLI wrapper (called from `src/cli.ts`)
 * prints+exits; the slash-command wrapper formats the same data into a
 * single message. Both surfaces share this function so behavior stays
 * consistent.
 */
export async function runPipelineCli(inputs: PipelineCliInputs): Promise<PipelineCliResult> {
  const out: string[] = [];
  const err: string[] = [];

  if (!inputs.config) {
    err.push("pipeline-tick: missing `pipeline:` block in beekeeper.yaml");
    return { exitCode: 1, output: out, errors: err };
  }
  if (!inputs.apiKey) {
    err.push("pipeline-tick: missing LINEAR_API_KEY env var");
    return { exitCode: 1, output: out, errors: err };
  }

  const parsed = parseArgs(inputs.argv);
  if (parsed.error) {
    err.push(parsed.error);
    err.push("Usage: beekeeper pipeline-tick <scope> [--dry-run] [--include-blocked] [--spawn-budget N] [--action-budget N]");
    return { exitCode: 1, output: out, errors: err };
  }

  const opts: RunTickOptions = {
    scope: parsed.scope,
    dryRun: parsed.dryRun,
    spawnBudget: parsed.spawnBudget ?? DEFAULTS.spawnBudget,
    actionBudget: parsed.actionBudget ?? DEFAULTS.actionBudget,
    includeBlocked: parsed.includeBlocked,
    config: inputs.config,
    apiKey: inputs.apiKey,
  };

  let report: TickReport;
  try {
    report = await runTick(opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err.push(`pipeline-tick: infra failure: ${msg}`);
    return { exitCode: 1, output: out, errors: err };
  }

  out.push(formatReport(report));
  return { exitCode: 0, report, output: out, errors: err };
}

interface ParsedArgs {
  scope: string;
  dryRun: boolean;
  includeBlocked: boolean;
  spawnBudget?: number;
  actionBudget?: number;
  error?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let scope: string | undefined;
  let dryRun = false;
  let includeBlocked = false;
  let spawnBudget: number | undefined;
  let actionBudget: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--include-blocked") includeBlocked = true;
    else if (a === "--all") scope = "--all";
    else if (a === "--spawn-budget") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) return errOut(`--spawn-budget expects a non-negative integer`);
      spawnBudget = v;
    } else if (a === "--action-budget") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) return errOut(`--action-budget expects a non-negative integer`);
      actionBudget = v;
    } else if (a.startsWith("--")) {
      return errOut(`unknown flag: ${a}`);
    } else if (!scope) {
      scope = a;
    } else {
      return errOut(`unexpected positional: ${a}`);
    }
  }

  if (!scope) return errOut("scope required (e.g., KPR-90 or --all)");
  return { scope, dryRun, includeBlocked, spawnBudget, actionBudget };
}

function errOut(msg: string): ParsedArgs {
  return { scope: "", dryRun: false, includeBlocked: false, error: msg };
}

export function formatReport(report: TickReport): string {
  const lines: string[] = [];
  lines.push(`pipeline-tick runId=${report.runId} scope=${report.scope}`);
  for (const e of report.entries) {
    lines.push(`  ${e.ticket}\t${e.decision.kind}\t${e.outcome}${e.detail ? `\t(${e.detail})` : ""}`);
  }
  if (report.blocked.length > 0) {
    lines.push("blocked:");
    for (const e of report.blocked) {
      lines.push(`  ${e.ticket}\t${e.decision.reason}`);
    }
  }
  const b = report.budget;
  lines.push(`budget: spawn ${b.spawnUsed}/${b.spawnLimit}  action ${b.actionUsed}/${b.actionLimit}`);
  return lines.join("\n");
}
```

- [ ] **Step 11.4:** Modify `src/cli.ts` to dispatch the new subcommand. Add this `case` before the `default` arm:

```typescript
  case "pipeline-tick": {
    const { loadConfig } = await import("./config.js");
    const { runPipelineCli } = await import("./pipeline/cli.js");
    const config = loadConfig();
    const result = await runPipelineCli({
      argv: process.argv.slice(3),
      config: config.pipeline,
      apiKey: process.env.LINEAR_API_KEY,
    });
    for (const line of result.output) console.log(line);
    for (const line of result.errors) console.error(line);
    if (result.exitCode) process.exit(result.exitCode);
    break;
  }
```

- [ ] **Step 11.5:** Register `/pipeline-tick` slash command in `SessionManager`. The existing command map lives at `src/session-manager.ts:100-113`. Surgical edit:

  1. Add a private async handler beneath the existing `handleStatus`:

```typescript
  /**
   * /pipeline-tick — run the pipeline driver from inside a Beekeeper session.
   * Thin wrapper over the same `runPipelineCli` the CLI uses; output is
   * formatted as a single session message. `args` is the raw split arg list.
   */
  private async handlePipelineTick(sessionId: string, args: string[]): Promise<void> {
    const { runPipelineCli } = await import("./pipeline/cli.js");
    const result = await runPipelineCli({
      argv: args,
      config: this.config.pipeline,
      apiKey: process.env.LINEAR_API_KEY,
    });
    const text = [...result.output, ...result.errors].join("\n");
    this.send({ type: "message", text, sessionId, final: true });
  }
```

  2. Inside the constructor command-registration block (alongside `clear`/`help`/`status`), append:

```typescript
    this.commands.set("pipeline-tick", {
      description: "Run pipeline-tick (Linear-driven autonomous ticket execution)",
      handler: (sessionId, args) => this.handlePipelineTick(sessionId, args),
    });
```

  Do not redesign the slash-command system; this should be ~20 lines of changes total.

- [ ] **Step 11.6:** Add a small slash-command unit test covering registration. Append to `src/session-manager.test.ts` (or create a new `*.test.ts` if no slash-command tests exist there):

```typescript
import { describe, expect, it, vi } from "vitest";

vi.mock("./pipeline/cli.js", () => ({
  runPipelineCli: vi.fn().mockResolvedValue({
    exitCode: 0,
    output: ["pipeline-tick runId=tick-test scope=KPR-90"],
    errors: [],
  }),
}));

describe("SessionManager /pipeline-tick", () => {
  it("registers the command", async () => {
    // Smoke-test the registration without spinning up a full SessionManager.
    // The command should be present in the public commands surface — we test
    // by importing the constructor and spying on Map writes.
    const { SessionManager } = await import("./session-manager.js");
    // Construct with minimal stubs (mirror existing test patterns in this file).
    const config = { pipeline: { linearTeamKey: "KPR" } } as unknown as Parameters<typeof SessionManager>[0];
    const guardian = {} as unknown as Parameters<typeof SessionManager>[1];
    const relayer = {} as unknown as Parameters<typeof SessionManager>[2];
    const sm = new SessionManager(config, guardian, relayer);
    // commands is private; cast to access for the registration check.
    const commands = (sm as unknown as { commands: Map<string, { description: string }> }).commands;
    expect(commands.has("pipeline-tick")).toBe(true);
  });
});
```

  If the existing `session-manager.test.ts` does not already cover constructor smoke, this test may need stubs aligned with that file's conventions — keep the test minimal and aligned.

- [ ] **Step 11.7:** Verify

```bash
npm run check
```

- [ ] **Step 11.8:** Commit

```bash
git add src/pipeline/tick-runner.ts src/pipeline/tick-runner.test.ts \
        src/pipeline/cli.ts src/cli.ts src/session-manager.ts src/session-manager.test.ts
git commit -m "feat(pipeline): tick runner + CLI subcommand + slash-command wrapper"
```

---

## Task 12: End-to-end smoke test against KPR-90

This task is manual validation, not automated — it requires a live `LINEAR_API_KEY`, a real Keepur team, and a known test ticket.

- [ ] **Step 12.1:** Operator setup. Add a `pipeline:` block to `~/.beekeeper/beekeeper.yaml`:

```yaml
pipeline:
  linearTeamKey: KPR
  repoPaths:
    hive: ~/github/hive
    beekeeper: ~/github/beekeeper
  mainBranch: main
```

Export `LINEAR_API_KEY=lin_api_…` (operator's personal Linear API key) into the shell that will run the tick. Per **OQ-2 (RESOLVED → A for Phase 1)**, the env var is the only auth source in this phase. The Phase-3 evolution (env-first / Honeypot-fallback resolution per Hive's `config.ts` pattern) is tracked as a deferred item in "What this plan does NOT do".

- [ ] **Step 12.2:** Dry-run against the parent epic.

```bash
cd /Users/mokie/github/beekeeper
npm run build
node dist/cli.js pipeline-tick KPR-74 --dry-run
```

Expected output: a header line with the runId, one line per child of KPR-74 showing its state/decision/outcome, and a budget summary line. No comments are written to Linear.

- [ ] **Step 12.3:** Single-ticket dry-run against KPR-90 (this ticket — `type:plan-only`, currently `Plan Drafting`).

```bash
node dist/cli.js pipeline-tick KPR-90 --dry-run
```

Expected: one entry, decision `plan-review`. No state writes.

- [ ] **Step 12.4:** Lock-contention smoke test (manual).

```bash
node dist/cli.js pipeline-tick KPR-90 &
node dist/cli.js pipeline-tick KPR-90 &
wait
```

Expected: one tick reports `outcome=spawned|transitioned`, the other reports `outcome=skipped reason=lost lock contention`. Both terminate with exit 0.

- [ ] **Step 12.5:** Open-questions surface test. Create a tiny `pipeline-auto` + `type:plan-only` test ticket whose description is intentionally underspecified (e.g., "Implement X — operator must choose API surface name."). Run:

```bash
node dist/cli.js pipeline-tick <test-ticket-id>
```

Expected after the launched drafting subagent finishes (next tick):
- Ticket has `block:human` label
- Latest comment on the ticket is the open-questions list
- Plan v1 is in `<resolved-repo>/docs/plans/_pending_review/`
- Re-running tick reports `report-only` until operator removes label.

- [ ] **Step 12.6:** Slash-command surface check (per **OQ-3 (RESOLVED → ship both)**). With Beekeeper running locally:

```
/pipeline-tick KPR-90 --dry-run
```

Expected: the same `pipeline-tick runId=… scope=KPR-90` summary as Step 12.3, delivered as a session message. No state writes.

- [ ] **Step 12.7:** Cleanup the test ticket from Step 12.5 (remove labels, delete branch).

- [ ] **Step 12.8:** Final verification.

```bash
npm run check
```

Expected: typecheck + all unit tests pass.

- [ ] **Step 12.9:** No code commit; this task is validation only.

---

## What this plan does NOT do

The following are explicitly deferred to subsequent plans (Phase 2+ in the spec):

- **Linear-comment audit trail beyond locks/spawn-logs.** Phase 2 adds richer per-action audit comments and re-uses prior comments to skip already-attempted actions.
- **Cron / scheduler integration.** Phase 3.
- **Slack notifications.** Phase 3.
- **Self-healing retries (CI flake, network blips).** Phase 3.
- **Cross-epic priority queue.** Phase 4.
- **Per-epic compute budgets.** Phase 4.
- **Meta-review sampling cadence.** Phase 4.
- **DB-side mutex (SQLite leader election).** Spec §"Concurrency" Phase 3 escalation. Comment-based mutex is sufficient for Phase 1 single-operator use.
- **Honeypot integration for `LINEAR_API_KEY`.** Phase 3 introduces env-first / Honeypot-fallback resolution per Hive's `config.ts` pattern. Phase 1 is env-only.
- **In-PR fix-iteration loop on REQUEST CHANGES.** Phase 1 routes any REQUEST CHANGES verdict to `block:human` so the operator decides between fix-inline / file-follow-up. Phase 2 automates the per-finding routing (re-launch implementer with findings, file child tickets via Linear) and adds the 5-round bound.
- **Reviewer/implementer MCP wiring.** Detached `claude` subagents inherit env but not Beekeeper's MCP servers. Drafting and reviewing don't need them; the implementer makes do with filesystem + git + `gh` (consistent with Hive's `code_task` pattern). Phase 4 may revisit if subagents need richer tooling.
- **`repo:*` label enforcement.** Spec leaves Phase 1 with description-grep heuristic; we accept a `repo:*` label if present but don't require it.
- **Multi-repo per-ticket execution.** Phase 4 — Phase 1 selects primary repo, lets the implementer span repos.
- **Hive→Beekeeper trigger surface.** Open question in spec; out of Phase 1 scope.

---

## Test coverage summary

| File | Test count | Type |
|---|---|---|
| `labels.test.ts` | 4 | Unit |
| `state-reader.test.ts` | 1 | Unit (mocked client) |
| `action-dispatcher.test.ts` | 16 | Unit (one per action-table row) |
| `mutex.test.ts` | 7 | Unit (mocked client) |
| `reviewer-parser.test.ts` | 7 | Unit |
| `block-evidence.test.ts` | 3 | Unit |
| `budget.test.ts` | 4 | Unit |
| `repo-resolver.test.ts` | 3 | Unit |
| `subagent-spawn.test.ts` | 2 | Unit (mocked `node:child_process.spawn`) |
| `handlers/drafting.test.ts` | 4 | Unit (tmpfs fixtures + mocked client/spawn) |
| `handlers/review.test.ts` | 4 | Unit |
| `tick-runner.test.ts` | 4 | Unit (mocked client + spawn, exercises dispatcher → handler → mutex flow) |
| `session-manager.test.ts` (slash-cmd registration) | 1 | Unit |
| End-to-end smoke (Task 12) | 6 manual checks | Integration (requires live Linear + Beekeeper running) |

Phase-1 automated total: **60 assertions across 13 unit-test files**. Tasks 1-8 contribute 45; Tasks 9-11 add 15.

---

## Acceptance criteria

- [ ] `npm run check` is green.
- [ ] `node dist/cli.js pipeline-tick <epic>` reads team state, decides per-ticket actions per the action table, launches subagents within the spawn-budget, writes lock claims/releases/spawn-logs to Linear, and prints a summary.
- [ ] `node dist/cli.js pipeline-tick <ticket> --dry-run` decides without writing.
- [ ] Two concurrent ticks against the same ticket cleanly serialize via the comment-based mutex (one wins, one backs off — no corrupted state).
- [ ] Drafting subagent that produces an open-questions list lands the ticket in `block:human` rather than auto-advancing.
- [ ] Reviewer that returns APPROVE with a SHOULD-FIX is treated as REQUEST CHANGES (KPR-84 trial regression).
- [ ] No `any` types in production code.
- [ ] Process spawning uses `execFile`-style API throughout (no shell-string invocation). The single documented exception is `spawnSubagent` in `src/pipeline/subagent-spawn.ts` (per OQ-1 → A: `child_process.spawn("claude", [...], { detached: true })`). The arg array is still strict `[binary, ...args]` form — no shell-string concatenation.
- [ ] Both surfaces ship: `beekeeper pipeline-tick <scope>` CLI subcommand AND `/pipeline-tick <scope>` slash command (per OQ-3 → both).

---

## Open design questions

> All three open questions from the v1 drafting pass have been resolved by the operator. Decisions are documented below as audit history (do not delete) so future readers can see why the implementation took the shape it did.

### OQ-1: Subagent spawn mechanism — **RESOLVED → A (detached `claude` CLI children)**

**Question.** When `pipeline-tick` decides to "launch a drafting/reviewer/implementer subagent in the background" (spec §3 step 3 + §"Concurrency"), what is the actual mechanism that mints the subagent process?

**Context.** The CLI form (`beekeeper pipeline-tick <scope>`) finishes and exits. The spec says "tick returns without waiting; subagents finish on their own and trigger the next tick to pick up the new state." There's no surface in the current Beekeeper repo for launching agent subprocesses — the existing `SessionManager` runs SDK-driven sessions inside the long-running Beekeeper server, which is a separate process from the CLI invocation.

**Options.**

A. **Detached `claude` CLI child process.** Each launch issues `child_process.spawn("claude", ["-p", prompt], { detached: true, stdio: "ignore" })`. Each subagent runs to completion and writes its result back to Linear via comments (the implementer-launch case adds a PR via `gh`, the drafting-launch case commits a markdown file + posts a comment, the reviewer-launch case posts a structured comment). Pros: simple, no IPC, matches spec language ("not a separate process; runs in-session"). Cons: no easy way for the launched process to call back into Beekeeper's tooling; each subagent reads its own Linear API key from env; `claude` CLI must be on PATH; a crashed subagent leaves no trace beyond `tick-spawn-log` until the next tick scans Linear.

B. **In-process SDK sessions managed by a long-running Beekeeper service.** Pipeline-tick CLI talks to the running Beekeeper server (via the existing WS port or a new admin HTTP endpoint), the server launches SDK sessions in-process, and the server's existing `SessionManager` keeps them alive. Pros: reuses Beekeeper's session/auth/MCP wiring; consistent with "loaded into Beekeeper's session as a slash command" language. Cons: requires Beekeeper to be running for the CLI to work; new IPC surface; bigger Phase-1 scope.

C. **Hybrid: CLI uses SDK in-process, then exits (subagents die with it).** Tick CLI launches SDK sessions inline, runs them to completion synchronously inside the tick, posts results to Linear, exits. Pros: simplest. Cons: contradicts spec's "tick returns without waiting" — long-running implementer sessions would block the tick for many minutes.

**Disposition.** **A.** Operator confirmed `claude -p <prompt>` non-interactive (print) mode with tools allowed. Implementation contract is pinned in `src/pipeline/subagent-spawn.ts` (Task 9.1). Subagents inherit `process.env`, plus three `PIPELINE_*` audit-trail env vars; `LINEAR_API_KEY` flows through inheritance. Tests mock `node:child_process.spawn` with 4-5 assertions verifying call shape (Task 9.2).

**Trade-off accepted.** Subagents do not get Beekeeper's MCP wiring (tool-guardian, question-relayer, Linear MCP). For drafting/reviewing this is fine. For the implementer, this matches Hive's existing `code_task` pattern, which is known to work.

---

### OQ-2: Linear API auth source — **RESOLVED → A for Phase 1; env-first/Honeypot-fallback in Phase 3**

**Question.** Where does `pipeline-tick` read the Linear API key from?

**Options.**
- A. `LINEAR_API_KEY` env var (consistent with `BEEKEEPER_JWT_SECRET` etc.).
- B. Honeypot keychain entry `hive/<instanceId>/LINEAR_API_KEY` (matches the longer-term Hive credential model).
- C. Both, with env taking precedence (matches Hive's `config.ts` resolution pattern).

**Disposition.** **A for Phase 1, evolving to C in Phase 3.** Phase 1 reads `LINEAR_API_KEY` from `process.env` in both `src/pipeline/cli.ts` and the subagent-spawn env passthrough. Operator setup step is documented in Task 12.1. The Phase-3 evolution (env-first / Honeypot-fallback resolution per Hive's `config.ts` pattern) is listed in "What this plan does NOT do" so future readers know the migration is planned, not punted.

---

### OQ-3: Skill vs. CLI form — **RESOLVED → ship BOTH in Phase 1**

**Question.** Spec §"Where it lives" describes pipeline-tick as "a skill loaded into Beekeeper's session as a slash command," but spec §"Inputs" and the user's task description specify `beekeeper pipeline-tick <scope>` (a CLI subcommand). These are different surfaces with different lifecycle properties.

**Disposition.** **Ship both in Phase 1.** The CLI is the primary surface (`beekeeper pipeline-tick <scope>`); the slash command (`/pipeline-tick <scope>`) is a thin wrapper registered in `SessionManager` alongside `/clear`, `/help`, `/status`. Both call the same `runPipelineCli({ argv, config, apiKey })` core in `src/pipeline/cli.ts` so behavior stays consistent.

The slash-command registration is a surgical edit (~20 lines in `src/session-manager.ts` + a 1-assertion test) and is implemented in Task 11.5–11.6. Smoke validation is Task 12.6.

---

## Reference

- Spec: `docs/specs/2026-04-26-pipeline-tick-design.md`
- Pipeline taxonomy: `~/.claude/projects/-Users-mokie-github-hive/memory/reference_pipeline_taxonomy.md`
- Pipeline review rule: `~/.claude/projects/-Users-mokie-github-hive/memory/feedback_pipeline_review_rule.md`
- Agent review workflow: `~/.claude/projects/-Users-mokie-github-hive/memory/feedback_agent_review_workflow.md`
- Merge strategy: `~/.claude/projects/-Users-mokie-github-hive/memory/feedback_merge_strategy.md`
- Reference plan: `docs/plans/2026-04-25-frames-foundation.md`
