# Frames Phase 2 — Asset Writes, Remove, Drift Dialog Implementation Plan

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan. Each task is self-contained; commit after each.

**Goal:** Ship the destructive operations that complete the `beekeeper frame` command surface — full `frame apply` with all six asset writes (skills, memory seeds, coreServers, schedule, prompts, constitution), `frame remove` with safe reverse-best-effort rollback, full text-diff drift detection (replacing Phase 1's anchor-presence stub), the conversational drift dialog with durable `driftAccepted` decisions, `requires`/`conflicts` enforcement, pre/post-apply hooks, and SIGUSR1 reload. After this plan merges, frames are end-to-end usable (subject to Phase 3 providing `hive-baseline` content).

**Prerequisites:** Phase 1 (KPR-84) must be present on the base branch. This plan extends `src/frames/` as established there: `types.ts`, `manifest-loader.ts`, `anchor-resolver.ts`, `instance-resolver.ts`, `mongo-client.ts`, `applied-frames-store.ts`, `errors.ts`, `cli.ts`, and `commands/{apply,audit,list}.ts` are assumed present. KPR-89 (audit exit-code fix) is also assumed in.

**PR base:** `KPR-83-frames` epic branch (per `feedback_pr_base_on_epic_branches.md`). Do **not** target main directly.

**Architecture:** Phase 2 adds two command files (`commands/remove.ts`, `commands/drift-dialog.ts`), a shared `asset-writer.ts` consumed by `apply.ts` and `remove.ts`, a `drift-detector.ts` that upgrades the Phase 1 audit logic, and a small `text-utils.ts` shared module to break the latent circular import between `apply.ts` and the new drift-detector. Existing `apply.ts` gains the full write path; `audit.ts` switches over to `drift-detector`. No new external dependencies beyond what Phase 1 already pulled in (`mongodb`, `yaml`).

**Tech Stack:** TypeScript (strict, NodeNext), Vitest, MongoDB driver, `node:crypto` (sha256), `node:child_process` `execFileSync` for hooks (binary + arg array form only — see hive `CLAUDE.md` security rule against the shell-string variant), `node:readline/promises` for dialog. ESM `.js` import extensions throughout.

**Spec reference:** `docs/specs/2026-04-25-frames-design.md` (review-clean).

---

## File Structure

### Files to create

| File | Responsibility |
|---|---|
| `src/frames/text-utils.ts` | Shared helpers: `extractAnchorNeighborhood`, `escapeRe`, `sha256Text`, `sha256File`, `computeBundleHash`. Refactor target for the existing helper inside Phase 1 `apply.ts`. |
| `src/frames/asset-writer.ts` | Per-asset write + reverse functions: skills, memory seeds, coreServers, schedule, prompts, constitution. Also owns the stagger-slot resolver. |
| `src/frames/drift-detector.ts` | `detectDrift(db, record, servicePath): DriftFinding[]`. Compares each `applied_frames.resources.*` block against current instance state. |
| `src/frames/drift-dialog.ts` | `runDriftDialog(...)`. Interactive per-finding resolution, writes `driftAccepted` mid-session. `--yes` non-interactive mode auto-picks `take-frame`. |
| `src/frames/commands/remove.ts` | `removeFrame(name, instance, opts)` — dependents check, reverse all assets, delete record, SIGUSR1. |
| `src/frames/asset-writer.test.ts` | Unit tests: stagger-slot math, `replacedClaimFrom` detection, content-hash dedup. |
| `src/frames/drift-detector.test.ts` | Unit tests per drift kind against fixed snapshots (mocked Db). |
| `src/frames/commands/remove.test.ts` | Unit tests for dependents check + rollback path (mocked Db). |

### Files to modify

| File | Reason |
|---|---|
| `src/frames/types.ts` | Add `replacedClaimFrom: string \| null` to skill/schedule/seed records; expand `schedule` record with `pattern` + `windowSlot`; expand `memorySeeds` record with `tier` + `agent`; add `DriftFinding` + `DriftKind`. |
| `src/frames/commands/apply.ts` | Replace Phase 1 adopt-only guard with full write path: `requires`/`conflicts` checks, hooks via the binary+args form of `execFileSync`, asset writes in fixed order, same-version re-apply with drift dialog, SIGUSR1. Extract `extractAnchorNeighborhood` into `text-utils.ts` and re-import. |
| `src/frames/commands/audit.ts` | Delegate to `drift-detector.detectDrift`; filter findings by `driftAccepted`; print actionable vs informational separately; preserve KPR-89 exit-code-on-drift behaviour. |
| `src/frames/cli.ts` | Add `case "remove":` route; extend `apply` to parse `--force-override`, `--allow-seed-override`, `--yes`; update help text. |

---

## Task 1 — Extend types

**Files:** Modify `src/frames/types.ts`

Phase 1's `AppliedResources` has bare `skills: Array<{ bundle, sha256 }>`, bare `schedule: Array<{ task, cron }>`, and bare `memorySeeds: Array<{ id, contentHash }>`. Phase 2 needs `replacedClaimFrom`, schedule pattern metadata, and per-seed agent + tier. Add a discriminated `DriftFinding` for the detector and dialog.

- [ ] **Step 1.1** Add three sub-record interfaces and a `DriftFinding` type. Replace the `AppliedResources` interface with the expanded form:

```typescript
export interface AppliedSkillRecord {
  bundle: string;
  sha256: string;
  replacedClaimFrom: string | null;
}
export interface AppliedScheduleRecord {
  task: string;
  cron: string;
  pattern: "explicit" | "shared" | "stagger";
  windowSlot: number | null;
  replacedClaimFrom: string | null;
}
export interface AppliedSeedRecord {
  id: string;
  contentHash: string;
  tier: "hot" | "warm" | "cold";
  agent: string;
  replacedClaimFrom: string | null;
}

export interface AppliedResources {
  constitution?: { anchors: string[]; snapshotBefore: string; insertedText: Record<string, string> };
  skills?: AppliedSkillRecord[];
  coreservers?: Record<string, string[]>;
  schedule?: Record<string, AppliedScheduleRecord[]>;
  memorySeeds?: AppliedSeedRecord[];
  prompts?: Record<string, { anchors: string[]; snapshotBefore: string; insertedText: Record<string, string> }>;
}

export type DriftKind =
  | "constitution-text-changed"
  | "constitution-anchor-missing"
  | "skill-modified-locally"
  | "skill-missing"
  | "coreserver-missing"
  | "schedule-missing"
  | "prompt-text-changed"
  | "prompt-anchor-missing"
  | "seed-missing"
  | "overridden-claim";

export interface DriftFinding {
  frame: string;
  kind: DriftKind;
  resource: string;
  detail: string;
  /** Informational findings (overridden-claim) are surfaced but don't fail audit. */
  informational: boolean;
}
```

- [ ] **Step 1.2** Verify: `npm run typecheck`. Expect existing tests to break (the Phase 1 store + apply + audit reference the old shapes); that's fine — they get updated in subsequent tasks. If typecheck reports errors only in `applied-frames-store.ts`, `commands/apply.ts`, `commands/audit.ts`, that's expected. Do **not** patch those here; the next tasks own those files.

- [ ] **Step 1.3** Commit: `feat(frames/p2): extend types — replacedClaimFrom, schedule/seed records, DriftFinding`.

---

## Task 2 — Extract shared text-utils

**Files:** Create `src/frames/text-utils.ts`. Modify `src/frames/commands/apply.ts`.

Phase 1 `apply.ts` defines `extractAnchorNeighborhood` and a local `escapeRe` helper. Phase 2 needs both in `asset-writer.ts` and `drift-detector.ts`. Importing from `commands/apply.ts` would create a layering inversion (commands depending on commands). Extract to a sibling utils module.

- [ ] **Step 2.1** Create `src/frames/text-utils.ts` with five exports. Behaviour must match the existing inline implementations in Phase 1 `apply.ts` exactly:
  - `escapeRe(s: string): string`
  - `extractAnchorNeighborhood(markdown: string, anchor: string): string` — finds the `<a id="anchor">` opener (with or without closing tag) and returns the substring from that opener to the next anchor opener or EOF.
  - `sha256Text(text: string): string`
  - `sha256File(path: string): string`
  - `computeBundleHash(dir: string): string` — sha256 of `SKILL.md` if present, else sha256 of the alphabetically first file. Empty dir → sha256 of empty string.

- [ ] **Step 2.2** In `commands/apply.ts`, remove the local `extractAnchorNeighborhood` and `escapeRe` definitions; replace internal call sites with imports from `../text-utils.js`. Also remove the existing public re-export of `extractAnchorNeighborhood` from `apply.ts` (it was a Phase 1 implementation detail; Phase 2 callers go through `text-utils.ts`).

- [ ] **Step 2.3** Verify: `npm run typecheck` and `npx vitest run src/frames/`. Phase 1 anchor + adopt tests must still pass; the only regression should be the type errors from Task 1, which the later tasks resolve.

- [ ] **Step 2.4** Commit: `refactor(frames/p2): extract text-utils for shared anchor + hash helpers`.

---

## Task 3 — Asset writer

**Files:** Create `src/frames/asset-writer.ts`, `src/frames/asset-writer.test.ts`.

The asset writer is the workhorse module. It exports a `write*` and a `remove*` function per asset type, plus a pure `resolveScheduleSlots` helper. `apply.ts` and `remove.ts` are thin wrappers over it.

- [ ] **Step 3.1** Create `asset-writer.ts` with these exports. Each function takes `Db` plus the relevant asset/record fields and returns the record to persist (write side) or void (remove side).

  | Export | Behaviour |
  |---|---|
  | `writeSkillBundle(db, manifest, bundle, servicePath, { forceOverride })` | `cp -r` the frame's `<bundle>` into `<servicePath>/skills/<basename(bundle)>/`. Hash via `computeBundleHash`. Detect peer claims in `applied_frames.resources.skills`; if a peer has a different sha256, throw `ConflictError` unless `forceOverride` (then set `replacedClaimFrom` to the peer's frame id). Same hash → shared claim, `replacedClaimFrom: null`. Returns `AppliedSkillRecord`. |
  | `removeSkillBundle(db, record, frameName, servicePath)` | Skip removal if any other applied frame still claims the same `bundle` path. Otherwise `rm -rf` the bundle. Soft-warn if the current bundle hash diverges from `record.sha256` (locally modified) but proceed. |
  | `writeMemorySeed(db, manifest, seed, { allowSeedOverride })` | Read seed file, compute content hash. If `agent_memory` already has an entry for `agentId+contentHash`, return its id (shared claim). If a peer frame claims the same agent with a different content hash, throw unless `allowSeedOverride`. Otherwise insert a new `agent_memory` doc with `_id: ulid()`, `agentId`, `content`, `tier`, `contentHash`. Returns `AppliedSeedRecord`. |
  | `removeMemorySeed(db, seedRec, frameName)` | Skip if any other applied frame claims the same `contentHash`. Otherwise `agent_memory.deleteOne({_id})`. |
  | `writeCoreServers(db, asset, resolvedAgents)` | For each agent, set-union add. Use `$addToSet: { coreServers: { $each: toAdd } }`. Returns `Record<agentId, string[]>` of *only the servers actually added* (for clean reverse). |
  | `removeCoreServers(db, coreserversResource)` | For each agentId, `$pullAll: { coreServers: servers }`. Only the entries this frame added. |
  | `resolveScheduleSlots(asset, resolvedAgents)` | Pure function. Returns `Array<{ agentId, cron, pattern, windowSlot }>`. Three patterns: explicit cron (all agents same), `pattern: shared` (require `cron`), `pattern: stagger` (require `window` + `interval`). Stagger algorithm: parse `<day> HH:MM-HH:MM [tz]` window and `NNm` interval → `slotCount = floor(duration/interval)`. Sort agents by id; assign slot[i] = window_start + i*interval. Throw if `agents.length > slotCount`. Cron emitted as `<m> <h> * * <dayNum>`. Timezone defaults to instance timezone (read from `<servicePath>/hive.yaml`); IANA zone in window suffix overrides. |
  | `writeScheduleEntry(db, agentId, task, cron, pattern, windowSlot, frameName, { forceOverride })` | Conflict key is `(agentId, task)`. Check peer claims in `applied_frames.resources.schedule[agentId][]`. Conflict → throw unless `forceOverride` (set `replacedClaimFrom`). Upsert via `$pull` task then `$push` new entry to `agent_definitions.<agent>.schedule`. Returns `AppliedScheduleRecord`. |
  | `removeScheduleEntry(db, agentId, entry)` | `$pull: { schedule: { task: entry.task } }`. |
  | `writePromptClause(db, agentId, anchor, clauseText)` | Find the `<a id="anchor">` opener in `agent_definitions.<agent>.systemPrompt` (use `text-utils.escapeRe`). Insert `\n${clauseText}` immediately after the anchor opener. Capture `snapshotBefore` (the full pre-write systemPrompt). Returns `{ snapshotBefore, insertedAt: number }`. |
  | `removePromptClause(db, agentId, anchor, insertedText, snapshotBefore, currentPrompt)` | If `currentPrompt.includes(insertedText)` and no further drift, restore to `snapshotBefore`. Otherwise drop only the literal `insertedText` substring and stderr-warn that surrounding context shifted. |
  | `writeConstitutionAnchor(db, anchor, insertMode, targetAnchor, fragmentText)` | Read `db.memory.findOne({path: "shared/constitution.md"})`. Apply one of four modes: `replace-anchor` (replace block from anchor opener to next anchor or EOF), `after-anchor` / `before-anchor` (insert `\n\n${text}\n` adjacent to `targetAnchor`), `append-to-anchor` (insert at end of `targetAnchor`'s block). Upsert back. Returns `{ snapshotBefore, insertedText }` where `insertedText = extractAnchorNeighborhood(updated, anchor)`. |
  | `removeConstitutionAnchor(db, snapshotBefore)` | Full revert to `snapshotBefore`. |

  Implementation notes:
  - Constitution is a **single document** per instance — `apply` captures `snapshotBefore` once at the start of the constitution write loop, not per-asset, so a multi-anchor frame still has one snapshot to revert to. Persist the single snapshot at the resource level (`resources.constitution.snapshotBefore`), not per asset.
  - `ulid` is already a transitive dep via `mongodb`. If not, `npm install ulid`.
  - The shared-claim check for skills queries `{ "resources.skills.bundle": <bundle> }`. Watch out: Phase 1 `applied-frames-store.ts` may need a passthrough method if direct collection access from the writer feels wrong. Per the Phase 1 module shape (store wraps the collection), prefer adding a `findClaimsForSkill(bundle)` / `findClaimsForSchedule(agentId, task)` / `findClaimsForSeedAgent(agentId)` to the store and have the writer use those.

- [ ] **Step 3.2** Create `asset-writer.test.ts`. Cover the pure logic (no DB calls): `resolveScheduleSlots` for explicit / shared / stagger; deterministic agent ordering; throws when `agents > slotCount`; sha256 helpers determinism. Five tests minimum. DB-touching write paths get exercised via the smoke test in Task 9, not unit-mocked here.

- [ ] **Step 3.3** Verify: `npm run typecheck && npx vitest run src/frames/asset-writer.test.ts`. Five tests pass.

- [ ] **Step 3.4** Commit: `feat(frames/p2): asset-writer — write + reverse for all six asset types`.

---

## Task 4 — Drift detector

**Files:** Create `src/frames/drift-detector.ts`, `src/frames/drift-detector.test.ts`.

Phase 1 audit only checks anchor presence. Phase 2 upgrades to full text-diff per asset type, returning typed `DriftFinding[]`.

- [ ] **Step 4.1** Create `drift-detector.ts` with one export:

  ```typescript
  export async function detectDrift(
    db: Db,
    record: AppliedFrameRecord,
    servicePath: string,
  ): Promise<DriftFinding[]>
  ```

  Implementation walks each populated `record.resources.*` block and emits findings:

  | Block | Checks |
  |---|---|
  | `constitution` | For each anchor: anchor still present? text neighborhood matches `insertedText[anchor]`? Emit `constitution-anchor-missing` or `constitution-text-changed`. |
  | `skills` | For each `AppliedSkillRecord`: bundle dir exists at `<servicePath>/skills/<basename(bundle)>`? `computeBundleHash` matches `record.sha256`? Emit `skill-missing` / `skill-modified-locally`. If `replacedClaimFrom` is non-null, emit `overridden-claim` (informational). |
  | `coreservers` | For each agent's added servers: agent's current `coreServers` still contains them? Emit `coreserver-missing` per missing server. |
  | `schedule` | For each agent's task entries: agent's `schedule` still contains the task? Emit `schedule-missing`. `replacedClaimFrom` → `overridden-claim` informational. |
  | `prompts` | For each agent's anchors: anchor still in current systemPrompt? `currentPrompt.includes(insertedText[anchor])`? Emit `prompt-anchor-missing` / `prompt-text-changed`. |
  | `memorySeeds` | For each seed: `agent_memory.findOne({_id: seed.id})` exists? Emit `seed-missing`. `replacedClaimFrom` → `overridden-claim` informational. |

  All detail strings must include the frame id, resource type, and what specifically diverged — operator should be able to act on the finding without re-querying state.

- [ ] **Step 4.2** Create `drift-detector.test.ts`. Three tests minimum, mocking Db: clean-state (no findings), constitution-text-changed flagged, constitution-anchor-missing flagged. Use a thin `mockDb` factory that returns `{ findOne, find: () => ({ toArray }) }` shape with hand-keyed responses.

- [ ] **Step 4.3** Verify: `npm run typecheck && npx vitest run src/frames/drift-detector.test.ts`. Three tests pass.

- [ ] **Step 4.4** Commit: `feat(frames/p2): drift detector — full text-diff across six asset types`.

---

## Task 5 — Upgrade `frame audit` to full drift detector

**Files:** Modify `src/frames/commands/audit.ts`.

Phase 1's audit checks anchor presence only. Replace with `detectDrift` + `driftAccepted` filtering. Preserve KPR-89's behaviour (exit code 1 when actionable findings remain after filtering).

- [ ] **Step 5.1** Replace the per-frame inner check with a `detectDrift` call. Filter findings by `record.driftAccepted` — drop any finding whose `resource` matches an entry whose `decision` is `"keep-local"` or `"deferred"` (decided items remain skipped until the frame version changes; spec § Drift acceptance is durable). Re-surface findings if `record.version !== record.driftAccepted[i].againstVersion` — this means add an `againstVersion` field to `DriftDecision` in `types.ts` (write `manifest.version` at decision time so version bumps re-ask the operator). If that field doesn't exist on older records, treat as "ask again" (re-surface).

- [ ] **Step 5.2** Print actionable findings before informational. Format: one line per finding with severity prefix (`drift:` for actionable, `info:` for informational).

- [ ] **Step 5.3** Exit code: 1 if any actionable finding remains after `driftAccepted` filtering; 0 if clean or only informational.

- [ ] **Step 5.4** Update `audit.test.ts` to match the new output shape. The Phase 1 test asserted on the anchor-presence message text — it needs to assert on the new `drift:` / `info:` lines.

- [ ] **Step 5.5** Verify: `npm run check`. Audit tests pass; KPR-89 exit-code behaviour preserved.

- [ ] **Step 5.6** Commit: `feat(frames/p2): audit upgrades to full drift-detector with driftAccepted filtering`.

---

## Task 6 — Drift dialog

**Files:** Create `src/frames/drift-dialog.ts`.

Conversational per-finding resolution. Beekeeper-conversational UX is documented in the spec; in the CLI process this is a `readline/promises` loop. Decisions written to `driftAccepted` immediately for resumability — see spec § "Decisions persist mid-session".

- [ ] **Step 6.1** Create `drift-dialog.ts` with one export:

  ```typescript
  export interface DialogResult {
    decision: DriftDecision["decision"];
    finding: DriftFinding;
    mergedText?: string;
  }
  export async function runDriftDialog(
    db: Db,
    record: AppliedFrameRecord,
    findings: DriftFinding[],
    opts: { yes: boolean; actor: string },
  ): Promise<DialogResult[]>
  ```

  Behaviour:
  - Filter to actionable (`!informational`) findings up front.
  - **Resumability:** if `record.driftAccepted` already has a decision for a finding's resource at the current frame version, skip and reuse that decision (so re-running the dialog after a partial session continues where it left off).
  - For each remaining finding, prompt with options (a) keep-local, (b) take-frame, (c) merged, (d) deferred.
  - On `(c) merged`: prompt operator to paste merged text, terminated by a line of `---`. Confirm. On confirmation, treat as `take-frame` semantically (apply the merged text) but record decision as `merged` with the merged text in `reason`.
  - Write each decision to `driftAccepted` immediately via `applied-frames-store.appendDriftDecision(frameName, decision)` — add this method to the Phase 1 store: `{ $push: { driftAccepted: decision } }` with `$setOnInsert: { driftAccepted: [] }` upsert behaviour.
  - `--yes` mode: skip prompts; default decision is `take-frame` for every actionable finding.

- [ ] **Step 6.2** No unit test — interactive stdin is exercised via the smoke test in Task 9.

- [ ] **Step 6.3** Verify: `npm run typecheck`. Clean.

- [ ] **Step 6.4** Commit: `feat(frames/p2): drift dialog — interactive resolution with durable per-decision writes`.

---

## Task 7 — Full `frame apply` write path

**Files:** Modify `src/frames/commands/apply.ts`. Modify `src/frames/cli.ts`.

Replace Phase 1's `--adopt`-only path with the full apply sequence per spec § Apply semantics. `--adopt` remains as a branch (still no writes); the default is now full apply.

- [ ] **Step 7.1** New `applyFrame` signature:

  ```typescript
  export async function applyFrame(
    framePath: string,
    instanceId: string,
    opts: { adopt?: boolean; forceOverride?: boolean; allowSeedOverride?: boolean; yes?: boolean },
  ): Promise<number>
  ```

- [ ] **Step 7.2** Implement the full sequence (extracted into `executeFullApply`):

  1. **Resolve frame** — `loadManifest(framePath)`.
  2. **Validate** — `verifyAnchors` (already in Phase 1) plus new `requires`/`conflicts` enforcement: for each `manifest.requires`, the named frame must be in `applied_frames`; for each `manifest.conflicts`, the named frame must NOT be in `applied_frames`. Throw `DependencyError` (already exists) on either failure with the offending frame ids in the message.
  3. **Same-version short-circuit** — if `applied_frames.<name>` exists at the same version: run `detectDrift`. No actionable drift → log no-op + return 0. Actionable drift → run `runDriftDialog`. Translate dialog results to a `Set<resource>` of "force-write" entries; subsequent writes gate on this set (write only resources whose drift the operator chose `take-frame` or `merged`). If all decisions are keep-local or deferred → no writes → return 0.
  4. **Pre-apply hook** — if `manifest.hooks?.preApply` and not `--adopt`: print the hook command, prompt unless `--yes`, then run via `execFileSync` from `node:child_process` with the binary-and-args form: first arg `"/bin/sh"`, second arg `[join(rootPath, hookPath)]`, options `{ stdio: "inherit" }`. **Never the shell-string overload** — security rule from `CLAUDE.md`.
  5. **Resolve agent selectors** — add helper `resolveAgents(db, selector: string[]): string[]`. `["*"]` → all `agent_definitions._id` sorted; explicit list → validate each exists, throw on missing.
  6. **Apply assets in fixed order** (skills → memory seeds → coreservers → schedule → prompts → constitution). Capture single `constitution.snapshotBefore` before the constitution loop. For each asset, call the matching `asset-writer.write*` and accumulate the resource records into a staged `AppliedResources`.
  7. **Stage record in memory** — do NOT write yet. Build `{ _id: name, version, appliedAt, appliedBy, manifest, resources, driftAccepted: [] }`.
  8. **Post-apply hook** — same binary-and-args invocation pattern. On non-zero exit: run reverse-best-effort over what was just written (call each `asset-writer.remove*` for the staged resources), collect errors. Throw `PartialApplyError` if reversal itself fails, with a list of what was written and what couldn't be reversed.
  9. **Commit record** — `applied-frames-store.upsert(record)` (Phase 1 method).
  10. **SIGUSR1** — read `<servicePath>/hive.pid` if present; `process.kill(pid, "SIGUSR1")`. Skip silently if no pid file. Skip entirely if no asset writes occurred (same-version no-op or dialog-result-empty path).

- [ ] **Step 7.3** Build the `appliedBy` actor string: `${process.env.USER ?? process.env.LOGNAME ?? "unknown"}@${hostname()}+beekeeper-${packageVersion}`. `packageVersion` from `package.json` import-attribute or a small `readFileSync` of the package's own json — match whatever Phase 1 already does for version reporting.

- [ ] **Step 7.4** Update `cli.ts`:
  - `apply`: parse `--force-override`, `--allow-seed-override`, `--yes`; pass through.
  - Add `case "remove":` (Task 8 fills the import).
  - Update `printUsage()` text.

- [ ] **Step 7.5** Verify: `npm run check`. Phase 1 tests adjusted by Tasks 1+2 must still pass.

- [ ] **Step 7.6** Commit: `feat(frames/p2): full apply write path — hooks, asset writes, same-version drift, SIGUSR1`.

---

## Task 8 — `frame remove`

**Files:** Create `src/frames/commands/remove.ts`, `src/frames/commands/remove.test.ts`. Modify `src/frames/cli.ts`.

- [ ] **Step 8.1** Create `commands/remove.ts`:

  ```typescript
  export async function removeFrame(
    frameName: string,
    instanceId: string,
    opts: { force?: boolean },
  ): Promise<number>
  ```

  Sequence per spec § Remove semantics:
  1. **Dependents check** — call `applied-frames-store.findDependents(frameName)`. If non-empty and not `--force`, throw `DependencyError` listing the blockers.
  2. Read `record = store.get(frameName)`. If absent, log "not applied" and return 0.
  3. Reverse asset blocks in **reverse apply order** (constitution → prompts → schedule → coreservers → seeds → skills). Each `remove*` call collects errors into a list; do **not** abort the reversal mid-flight on a single failure — try them all so the operator sees the full picture.
  4. After reversal: if the error list is empty, `store.remove(frameName)` and `signalHive(servicePath)`. If non-empty, throw `PartialApplyError` with the per-asset error breakdown — record stays in `applied_frames` so the operator can retry remove after fixing.
  5. Force is recorded only in stderr log, not in the (now-deleted) record.

- [ ] **Step 8.2** Create `remove.test.ts`. Two tests with mocked store:
  - Refuses with `DependencyError` when `findDependents` returns a non-empty list and force is false.
  - Proceeds past the dependents check when `force: true` (the rest of the path may fail on missing mock data; assert only that the thrown error is not `DependencyError`).

- [ ] **Step 8.3** Wire `cli.ts` `case "remove":` to call `removeFrame(frameName, instanceId, { force: flags.has("--force") })`.

- [ ] **Step 8.4** Verify: `npm run check`. Two new tests pass.

- [ ] **Step 8.5** Commit: `feat(frames/p2): frame remove with dependents check + reverse-best-effort rollback`.

---

## Task 9 — End-to-end smoke test against dodi

Manual validation, no commit. Mirrors Phase 1's smoke-test pattern (Phase 1 task 10).

- [ ] **Step 9.1** Confirm dodi has `instances.dodi.servicePath` set in `~/.beekeeper/beekeeper.yaml`. Confirm anchors `memory` and `capabilities` exist in dodi's constitution (`mongosh hive_dodi --eval 'db.memory.findOne({path:"shared/constitution.md"}).content' | grep '<a id'`).

- [ ] **Step 9.2** Author a smoke-test frame at `~/.beekeeper/frames/test-full/`. Minimal `frame.yaml` exercising all six asset types — one constitution `replace-anchor` on `capabilities`, one skill bundle (any throwaway), one coreServer add (`keychain` to `["rae"]`), one explicit-cron schedule on rae, one memory seed for rae (hot tier), one prompt anchor on rae (ensure rae has a `<a id="role-spec">` marker — add it manually if missing).

- [ ] **Step 9.3** Run the apply / audit / remove cycle:

```bash
cd ~/github/beekeeper-KPR-85-plan
npm run build
node dist/cli.js frame apply ~/.beekeeper/frames/test-full dodi   # full apply, not --adopt
node dist/cli.js frame list dodi                                  # shows test-full
node dist/cli.js frame audit dodi                                 # exit 0, clean (or only `info:` lines)
node dist/cli.js frame remove test-full dodi                      # reverses everything
node dist/cli.js frame list dodi                                  # test-full gone
```

- [ ] **Step 9.4** Drift dialog smoke test: re-apply, then via `mongosh` append a literal `<!-- local edit -->` to the constitution, then re-apply same-version. Dialog should surface `constitution-text-changed`. Pick `(a) keep-local`. `audit` afterwards should show no actionable drift.

- [ ] **Step 9.5** Verify hive logs show SIGUSR1-triggered agent reload after both apply and remove.

- [ ] **Step 9.6** Cleanup: `rm -rf ~/.beekeeper/frames/test-full`.

---

## Out of scope (deferred)

- Registry distribution (`frame install/list/search` against `frames.keepur.io`) — spec § Registry distribution, ships in a later phase.
- Manifest signing — same.
- `tune-instance` calling `frame audit` first — KPR-72 spec already handles the integration; tune-instance landing is gated on this Phase 2 plan, not the other way around.
- Hand-authored `hive-baseline` content — Phase 3 (KPR-86). Task 9's smoke-test frame is a synthetic exerciser, not the real baseline.
- Upgrade-version dialog (newer manifest vs. local-changed asset) — same drift-dialog code path as same-version drift, but with the diff against the new manifest's asset rather than the snapshot. Mechanically straightforward; defer until same-version path is proven by Task 9.

## Acceptance criteria

- [ ] `npm run check` is green on the PR branch.
- [ ] `frame apply <path> <instance>` (no `--adopt`) writes all six asset types in fixed order, commits the record, and sends SIGUSR1.
- [ ] Pre-apply hook failure aborts apply before any asset writes. Post-apply hook failure triggers reverse-best-effort and surfaces `PartialApplyError` if reversal is incomplete.
- [ ] `frame remove <name> <instance>` reverses all six asset types, deletes the record, and sends SIGUSR1.
- [ ] `--force` on remove bypasses the dependents check.
- [ ] `frame audit <instance>` reports findings of all ten `DriftKind` variants when present; exit code 1 on actionable drift, 0 on clean-or-informational.
- [ ] Same-version re-apply with drift triggers the interactive dialog; decisions are written to `driftAccepted` per-decision (not at session end).
- [ ] Hooks are invoked via the binary-and-args form of `execFileSync`, never the shell-string overload.
- [ ] No `any` in production code.
- [ ] Smoke test (Task 9) against dodi passes.
- [ ] PR base is `KPR-83-frames`, not `main`.

## Test coverage summary

| File | Tests | Type |
|---|---|---|
| `asset-writer.test.ts` | 5 | Unit |
| `drift-detector.test.ts` | 3 | Unit |
| `commands/remove.test.ts` | 2 | Unit |
| `commands/audit.test.ts` (updated) | existing + drift-finding shape | Unit |
| Task 9 smoke test | 6 manual checks | Integration (live dodi) |

Total: 10 new automated tests + 1 modified existing test + 6 manual smoke checks. Combined with Phase 1's 21 automated tests, the post-Phase-2 module total is 31 automated tests covering loader → resolver → store → audit → apply → remove.
