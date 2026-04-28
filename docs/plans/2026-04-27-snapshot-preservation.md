# KPR-105 — Preserve `snapshotBefore` (and unchanged resources) Across Drift-Resolved Applies

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan. Each task is self-contained; commit after each.

**Goal:** Fix two related engine bugs in `src/frames/commands/apply.ts` so that a drift-resolved `frame apply` (e.g. operator chooses `take-frame`) does not corrupt the `applied_frames` record's rollback fidelity:

1. **Primary bug (per KPR-105 ticket).** `snapshotBefore` for `constitution` and `prompts.<agent>` is re-captured on every apply, including drift-resolved applies, overwriting the original pre-first-apply baseline. `frame remove` then restores to the post-drift state, not the true pre-frame state.
2. **Adjacent bug (uncovered while reading the source).** During a drift-resolved apply, the staged record at line 383 is built from `resources: AppliedResources = {}` populated only by what step 6 actually wrote. Resources NOT in `forceWriteResources` (i.e., resources with no actionable drift this round) are silently DROPPED from the persisted record. Subsequent audits stop checking them; `frame remove` no longer cleans them up. This is a strict-superset issue of the snapshot bug — fixing snapshot alone leaves the record incomplete.

After this lands, drift-resolved applies preserve the original `snapshotBefore` AND the full set of resources from the previous record; they update only the snapshot fields and `insertedText` for resources that were re-written this round.

**Prerequisites:** KPR-83-frames epic branch with KPR-99 / KPR-100 / KPR-98 already merged.

**PR base:** `KPR-83-frames` epic branch. Do **not** target main directly.

**Architecture:** Single-file source change in `src/frames/commands/apply.ts` (asset-write step 6 and `buildAdoptRecord`). One new test file `src/frames/commands/apply-snapshot-preservation.test.ts` covering the five drift cycles required by the ticket plus the resource-preservation case. No public API or schema changes — `AppliedFrameRecord` shape unchanged.

**Tech Stack:** TypeScript (strict, NodeNext), Vitest, Mongo (via in-memory fakes for unit tests; live `MongoClient` for e2e if `MONGODB_TEST_URI` is set).

**Spec reference:** Linear ticket [KPR-105](https://linear.app/keepur/issue/KPR-105/).

---

## Resource-by-resource snapshot semantics audit

| Resource | Has `snapshotBefore`? | Has full restorable state? | Bug present? | Fix |
|---|---|---|---|---|
| `constitution` | Yes (full document text) | Yes (`removeConstitutionAnchor` writes snapshot back) | **YES** — fresh capture clobbers original | Initialize from `existing.resources.constitution?.snapshotBefore` if present; else capture fresh. |
| `prompts.<agent>` | Yes (full systemPrompt text per agent) | Yes (`removePromptClause` reads snapshot to compute restore) | **YES** — same pattern, per-agent | Same fix, per-agent: initialize from `existing.resources.prompts?.[agentId]?.snapshotBefore` if present; else capture fresh on first-anchor-write. |
| `skills` | No (records `bundle, sha256, replacedClaimFrom`) | No (uses `cpSync` / `rmSync` of dir; no prior-version restore) | No (snapshot-wise) | None for snapshot. **Resource-preservation fix below applies.** |
| `memorySeeds` | No (records `id, contentHash, tier, agent`) | No (delete by `_id` on remove; no prior content restore) | No | None. **Resource-preservation fix below applies.** |
| `coreservers` | No (records added server names per agent) | Partial — removal pulls only the recorded list; "before" is implicit (whatever wasn't pulled) | No (snapshot-wise) | None. **Resource-preservation fix below applies.** |
| `schedule` | No (records task/cron/pattern per agent) | Partial — removal `$pull`s by task name | No (snapshot-wise) | None. **Resource-preservation fix below applies.** |

**Conclusion:** Only `constitution` and `prompts` need the snapshot-preservation fix per the ticket. The other four resource types do not have a `snapshotBefore` field, so there is no field for the bug to live in. They DO suffer from the adjacent resource-drop bug below, which is a separate concern.

---

## Adjacent bug — staged record drops untouched resources on drift-resolved apply

**Repro shape:** apply a frame with skills + coreservers + constitution → drift the constitution only → drift-resolved apply with `take-frame` on constitution. After step 6, `writtenSkills`/`writtenCoreservers` are empty (skills/coreservers were not in `forceWriteResources`), so `resources.skills` and `resources.coreservers` are `undefined` in the staged record. `store.upsert(stagedRecord)` replaces the existing record wholesale (`replaceOne` semantics — see `applied-frames-store.ts:21`). Result: persisted record has only `resources.constitution`. Next audit cannot check skills/coreservers (no record). `frame remove` cleans up only constitution; skills bundle stays on disk, coreservers stay attached to agents.

**Why this fix belongs in this PR:** The ticket asks us to ensure a drift-resolved apply preserves the original baseline for `frame remove`. Preserving `snapshotBefore` while letting the rest of the record evaporate would still leave `frame remove` unable to clean up the bulk of the frame's footprint. The two fixes share the same root cause shape (drift-resolved apply not carrying forward state from `existing`) and the same fix shape (initialize-from-existing if present).

**Test of record completeness on cycle:** Apply with all 6 asset types → drift on constitution only → drift-resolved apply on constitution → assert `applied_frames.resources` still has `skills`, `memorySeeds`, `coreservers`, `schedule`, `prompts` carried over from `existing`. Then `frame remove` → assert all 6 resource types reverted (this is the existing smoke-e2e shape; we extend it with the drift-cycle in between).

---

## File Structure

### Files to create

| File | Responsibility |
|---|---|
| `src/frames/commands/apply-snapshot-preservation.test.ts` | Five drift-cycle cases from KPR-105 + the adjacent resource-preservation case. Mongo-gated via `MONGODB_TEST_URI` like `smoke-e2e.test.ts`. |

### Files to modify

| File | Reason |
|---|---|
| `src/frames/commands/apply.ts` | Step 6 (constitution + prompts): initialize `snapshotBefore` from `existing` when running drift-resolved apply. Post-step-6 staged record build: merge `existing.resources` into `resources` for resource types not re-written this round. `buildAdoptRecord`: preserve existing snapshot if a record already exists at adopt time. |

### Files NOT touched

- `src/frames/commands/remove.ts` — consumer side correctly reads `record.resources.*.snapshotBefore`. Bug is in producer.
- `src/frames/asset-writer.ts` — writer return values are correct; bug is in how the caller handles them.
- `src/frames/types.ts` — schema unchanged.
- `src/frames/drift-detector.ts` — already reads from `record.resources`; once we stop dropping resources, drift detection covers the full record again. No change needed.

---

## Implementation

### Task 1 — Constitution snapshot preservation (with in-flight rollback split)

**File:** `src/frames/commands/apply.ts`

**Locate:** the `constitutionSnapshotBefore` initialization at line 182, the per-anchor capture at line 334, and the two `reverseBestEffort` call sites at lines 348-355 and 367-374 that pass `constitutionSnapshotBefore`.

**Subtle issue uncovered during review:** the variable `constitutionSnapshotBefore` is used for **two distinct purposes**:

1. **In-flight rollback target** (used by `reverseBestEffort` if step 6 throws midway). The semantically correct value here is "what the constitution looked like immediately before THIS apply began writing" — i.e., for a drift-resolved apply, the post-drift state. If we naively make `constitutionSnapshotBefore` the original-pre-first-apply baseline, an in-flight rollback would clobber the operator's drift state with the original baseline — a regression.
2. **Persisted record snapshot** (written into `applied_frames.resources.constitution.snapshotBefore` and used by `frame remove` later). The semantically correct value here is "the document state before the very first apply" — preserved across drift-resolved applies, per KPR-105.

These two semantics diverge for drift-resolved applies. The fix must split them into two local variables.

**Change shape:**

1. After `existing` is set at line 122 but before step 6, compute the carry-over snapshot:

   ```typescript
   // KPR-105: preserve original snapshotBefore (the persisted, "before-first-
   // apply" baseline) across drift-resolved applies. The in-flight rollback
   // target — what reverseBestEffort writes if step 6 throws — remains the
   // pre-this-round state captured by the writer; those two semantics diverge
   // for drift-resolved applies and need separate variables.
   const persistedConstitutionSnapshot =
     existing?.resources.constitution?.snapshotBefore;
   ```

2. Rename the existing `constitutionSnapshotBefore` variable's role to "in-flight rollback target." It stays `let constitutionSnapshotBefore: string | undefined;` and continues to be set on the first writer call this round (line 334 logic unchanged). It is passed to `reverseBestEffort` unchanged. The two `reverseBestEffort` call sites at lines 348-355 and 367-374 keep their current behavior.

3. At line 339-345 where `resources.constitution` is built for the staged record, use the persisted snapshot:

   ```typescript
   if (constitutionAnchorsWritten.length > 0) {
     resources.constitution = {
       anchors: constitutionAnchorsWritten,
       snapshotBefore: persistedConstitutionSnapshot ?? constitutionSnapshotBefore ?? "",
       insertedText: constitutionInsertedText,
     };
   }
   ```

   First-time apply: `existing` is null, so `persistedConstitutionSnapshot` is undefined, falls through to `constitutionSnapshotBefore` (writer-captured), preserving current behavior. Drift-resolved apply: `persistedConstitutionSnapshot` carries the original baseline, used here.

**Verify after edit:** `npm run typecheck` clean. Run existing `smoke-e2e.test.ts` to confirm first-time apply path is unchanged.

**Commit:** `fix(frames): KPR-105 — preserve constitution snapshotBefore across drift-resolved applies`

### Task 2 — Prompt snapshot preservation (per-agent, with in-flight rollback split)

**File:** `src/frames/commands/apply.ts`

**Locate:** the prompt loop at line 277, specifically the per-agent block around line 297-302, AND the two `reverseBestEffort` call sites that pass `writtenPrompts` (lines 348-355 and 367-374), AND the `reverseBestEffort` function body at lines 438-462 that reads `block.snapshotBefore`.

**Same split-purpose subtlety as Task 1.** `writtenPrompts[agentId].snapshotBefore` is currently consumed by both:

1. **In-flight rollback** (`reverseBestEffort` → `removePromptClause(..., block.snapshotBefore, current)`). Wants pre-this-round state.
2. **Persisted record snapshot** (`stagedRecord.resources.prompts[agentId].snapshotBefore`). Wants pre-first-apply baseline.

Splitting them keeps `writtenPrompts` as the in-flight rollback bookkeeping (unchanged shape — preserves the existing `reverseBestEffort` contract), and applies the original-baseline override only when building the persisted `resources.prompts`.

**Change shape:**

1. Leave the per-agent block (lines 297-307) **unchanged**. `writtenPrompts[agentId].snapshotBefore` continues to be the writer's just-captured pre-this-round state — what `reverseBestEffort` needs.

2. Replace the `if (Object.keys(writtenPrompts).length > 0) resources.prompts = writtenPrompts;` line (309) with logic that, for drift-resolved applies, swaps in the original snapshot from `existing` for the persisted record:

   ```typescript
   // KPR-105: writtenPrompts[*].snapshotBefore is the in-flight rollback
   // target (used by reverseBestEffort). The persisted record needs the
   // pre-first-apply baseline, which is preserved from the existing record
   // when this is a drift-resolved apply.
   if (Object.keys(writtenPrompts).length > 0) {
     const persistedPrompts: Record<
       string,
       { anchors: string[]; snapshotBefore: string; insertedText: Record<string, string> }
     > = {};
     for (const [agentId, block] of Object.entries(writtenPrompts)) {
       const existingSnap = existing?.resources.prompts?.[agentId]?.snapshotBefore;
       persistedPrompts[agentId] = {
         anchors: block.anchors,
         snapshotBefore: existingSnap ?? block.snapshotBefore,
         insertedText: block.insertedText,
       };
     }
     resources.prompts = persistedPrompts;
   }
   ```

   First-time apply: `existing` is null → uses writer-captured snapshot. Drift-resolved apply: uses original baseline.

**Note:** `insertedText[anchor]` is updated to the freshly-written text when the anchor is re-written — that's intentional, because the inserted text reflects what's currently in the document. Only `snapshotBefore` is the immutable "first-write baseline."

**Verify after edit:** `npm run typecheck` clean. Run existing `apply.test.ts` and `smoke-e2e.test.ts` to confirm first-time apply path is unchanged.

**Commit:** `fix(frames): KPR-105 — preserve prompt snapshotBefore per-agent across drift-resolved applies`

### Task 3 — Carry forward untouched resources into staged record

**File:** `src/frames/commands/apply.ts`

**Locate:** the staged record build at lines 383-391:

```typescript
const stagedRecord: AppliedFrameRecord = {
  _id: manifest.name,
  version: manifest.version,
  appliedAt: new Date(),
  appliedBy: buildActor(),
  manifest,
  resources,
  driftAccepted: [...existingDecisions, ...newDecisions],
};
```

**Change shape:**

Before the staged record build, merge `existing.resources` into `resources` for keys not populated this round. This logic only applies when `existing` is non-null (drift-resolved apply path); first-time apply path leaves `existing` null and the merge is a no-op.

```typescript
// KPR-105: drift-resolved applies only re-write resources flagged in
// forceWriteResources. Resources untouched this round must carry forward
// from the existing record so the persisted record stays a complete
// description of what the frame contributed. Without this, audit + remove
// stop seeing resource types that didn't drift this round.
if (existing) {
  if (!resources.skills && existing.resources.skills) {
    resources.skills = existing.resources.skills;
  }
  if (!resources.memorySeeds && existing.resources.memorySeeds) {
    resources.memorySeeds = existing.resources.memorySeeds;
  }
  if (!resources.coreservers && existing.resources.coreservers) {
    resources.coreservers = existing.resources.coreservers;
  }
  if (!resources.schedule && existing.resources.schedule) {
    resources.schedule = existing.resources.schedule;
  }
  if (!resources.prompts && existing.resources.prompts) {
    resources.prompts = existing.resources.prompts;
  }
  if (!resources.constitution && existing.resources.constitution) {
    resources.constitution = existing.resources.constitution;
  }
}
```

**Per-resource subtlety — partial overlap within a resource type.** If a frame has multiple constitution anchors and only one drifted + was take-frame'd, the `resources.constitution.anchors` rebuilt this round contains only the re-written anchor. We need to union with existing anchors and merge `insertedText`. Same pattern for `prompts.<agent>` and `coreservers`/`schedule` per-agent.

**Decision on partial-overlap handling:** rather than open-code a deep merge, gate the carry-forward at the top-level resource-type key only. The reasoning:

- For `constitution`: if any anchor was re-written, `resources.constitution` is set this round. The top-level fallback above wouldn't fire. We need a deeper merge of anchor lists + `insertedText`.
- For `prompts`: same — if any agent had any prompt re-written, the top-level `resources.prompts` is set. We need a deeper merge of per-agent records.
- For `coreservers`: if any (agent, server) was re-written, `resources.coreservers` is set. We need to union per-agent server lists with `existing.resources.coreservers`.
- For `schedule`: similar — per-agent schedule entry array union.
- For `skills` and `memorySeeds`: these are arrays at the top level. If any element was re-written, the top-level array is set fresh, missing peers. We need to union by element identity (skill bundle name, seed id).

So the merge logic must go one level deeper. The implementation:

```typescript
if (existing) {
  // skills: union by bundle name (last-write-wins per bundle)
  if (existing.resources.skills) {
    const writtenBundles = new Set((resources.skills ?? []).map((s) => s.bundle));
    const carryover = existing.resources.skills.filter((s) => !writtenBundles.has(s.bundle));
    resources.skills = [...(resources.skills ?? []), ...carryover];
    if (resources.skills.length === 0) delete resources.skills;
  }

  // memorySeeds: union by (agent, contentHash)
  if (existing.resources.memorySeeds) {
    const writtenIds = new Set(
      (resources.memorySeeds ?? []).map((s) => `${s.agent}:${s.contentHash}`),
    );
    const carryover = existing.resources.memorySeeds.filter(
      (s) => !writtenIds.has(`${s.agent}:${s.contentHash}`),
    );
    resources.memorySeeds = [...(resources.memorySeeds ?? []), ...carryover];
    if (resources.memorySeeds.length === 0) delete resources.memorySeeds;
  }

  // coreservers: per-agent server list union
  if (existing.resources.coreservers) {
    const merged: Record<string, string[]> = { ...resources.coreservers };
    for (const [agentId, servers] of Object.entries(existing.resources.coreservers)) {
      const cur = merged[agentId] ?? [];
      const curSet = new Set(cur);
      const carryover = servers.filter((s) => !curSet.has(s));
      if (cur.length + carryover.length > 0) {
        merged[agentId] = [...cur, ...carryover];
      }
    }
    if (Object.keys(merged).length > 0) resources.coreservers = merged;
  }

  // schedule: per-agent entry list union by task name
  if (existing.resources.schedule) {
    const merged: Record<string, AppliedScheduleRecord[]> = { ...resources.schedule };
    for (const [agentId, entries] of Object.entries(existing.resources.schedule)) {
      const cur = merged[agentId] ?? [];
      const curTasks = new Set(cur.map((e) => e.task));
      const carryover = entries.filter((e) => !curTasks.has(e.task));
      if (cur.length + carryover.length > 0) {
        merged[agentId] = [...cur, ...carryover];
      }
    }
    if (Object.keys(merged).length > 0) resources.schedule = merged;
  }

  // prompts: per-agent { anchors, snapshotBefore, insertedText } union
  if (existing.resources.prompts) {
    const merged: Record<string, { anchors: string[]; snapshotBefore: string; insertedText: Record<string, string> }> = {
      ...resources.prompts,
    };
    for (const [agentId, block] of Object.entries(existing.resources.prompts)) {
      const cur = merged[agentId];
      if (!cur) {
        merged[agentId] = block;
        continue;
      }
      // Re-write happened for this agent; union anchors + insertedText. snapshotBefore
      // already preserved (Task 2). Keep cur.snapshotBefore (carries the original).
      const curAnchorSet = new Set(cur.anchors);
      const carryAnchors = block.anchors.filter((a) => !curAnchorSet.has(a));
      cur.anchors = [...cur.anchors, ...carryAnchors];
      for (const [a, txt] of Object.entries(block.insertedText)) {
        if (!(a in cur.insertedText)) cur.insertedText[a] = txt;
      }
    }
    if (Object.keys(merged).length > 0) resources.prompts = merged;
  }

  // constitution: anchors + insertedText union; snapshotBefore already preserved (Task 1).
  if (existing.resources.constitution) {
    const cur = resources.constitution;
    if (!cur) {
      resources.constitution = existing.resources.constitution;
    } else {
      const curAnchorSet = new Set(cur.anchors);
      const carryAnchors = existing.resources.constitution.anchors.filter(
        (a) => !curAnchorSet.has(a),
      );
      cur.anchors = [...cur.anchors, ...carryAnchors];
      for (const [a, txt] of Object.entries(existing.resources.constitution.insertedText)) {
        if (!(a in cur.insertedText)) cur.insertedText[a] = txt;
      }
      // cur.snapshotBefore was already initialized to existing's (Task 1).
    }
  }
}
```

**Why "carry over current-record-not-this-round" rather than "carry over all of existing":** the resources just written this round are the freshly-resolved truth (after take-frame / merged), so they win for the keys they touch. Untouched keys come from `existing`.

**Verify after edit:** `npm run typecheck` clean.

**Commit:** `fix(frames): KPR-105 — carry forward untouched resources into drift-resolved apply record`

### Task 4 — `buildAdoptRecord` re-adopt path

**File:** `src/frames/commands/apply.ts`

**Locate:** `runAdopt` at line 86 and `buildAdoptRecord` at line 655.

**Audit:** `runAdopt` already short-circuits with "already adopted on … . No change." when `existing && existing.version === manifest.version` (line 93-98). So same-version re-adopt is a no-op — no record write, no snapshot recapture. **No bug on the same-version re-adopt path.**

**However:** if a different-version manifest is adopted on top of an existing record (e.g. operator runs `--adopt` against a newer frame version on an instance that previously adopted an older version), the existing short-circuit doesn't fire — `buildAdoptRecord` runs fresh and `store.upsert` overwrites the record. The new record's snapshots will reflect the current document state, which is post-prior-frame-content (because the prior version was applied/adopted and operator may have written assets).

**Decision:** the cleanest path is to also have `buildAdoptRecord` (or, preferably, `runAdopt`) preserve `existing.resources.*.snapshotBefore` when an `existing` record is present. Implementation: in `runAdopt`, after `buildAdoptRecord` returns, if `existing` is non-null, splice the original snapshots back in:

```typescript
async function runAdopt(...): Promise<number> {
  const store = new AppliedFramesStore(db);
  const existing = await store.get(manifest.name);
  if (existing && existing.version === manifest.version) {
    console.log(`Frame "${manifest.name}" v${manifest.version} already adopted on "${instance.id}". No change.`);
    return 0;
  }
  await verifyAnchors(db, manifest, (sel) => resolveAgents(db, sel));
  const record = await buildAdoptRecord(db, manifest);

  // KPR-105: if a prior record exists (different version), preserve original
  // snapshots. The new record may have a wider/narrower anchor set, but the
  // pre-frame baseline that frame remove uses must be the very first one.
  if (existing) {
    if (record.resources.constitution && existing.resources.constitution) {
      record.resources.constitution.snapshotBefore =
        existing.resources.constitution.snapshotBefore;
    }
    if (record.resources.prompts && existing.resources.prompts) {
      for (const [agentId, block] of Object.entries(record.resources.prompts)) {
        const prev = existing.resources.prompts[agentId];
        if (prev) {
          block.snapshotBefore = prev.snapshotBefore;
        }
      }
    }
  }

  await store.upsert(record);
  ...
}
```

This intentionally does NOT carry forward unmentioned resource types in the adopt path — adopt is a fresh authoritative declaration of what the frame manages, the manifest is the ground truth. Resources only present in the previous record but not this manifest version should not be carried (the new manifest doesn't claim them).

**Verify after edit:** `npm run typecheck` clean.

**Commit:** `fix(frames): KPR-105 — preserve original snapshots on cross-version --adopt`

### Task 5 — Tests

**File:** `src/frames/commands/apply-snapshot-preservation.test.ts` (new)

**Pattern:** mongo-gated like `smoke-e2e.test.ts` — use `MONGODB_TEST_URI` env var, skip when absent. Real `MongoClient`, real `db`. Each test seeds a clean state in `beforeEach`.

**Test cases (the five from the ticket plus three more):**

1. **Apply → drift → take-frame → remove → constitution restored to pre-first-apply.**
   - Seed constitution with `<a id="cap"></a>\nORIGINAL\n<a id="end"></a>\nend` (record `ORIGINAL_DOC`).
   - Apply frame with `replace-anchor` on `cap`, fragment `FRAME-CONTENT`.
   - Inject drift: direct mongo write prepending `LOCALLY-EDITED ` to the cap heading.
   - Drift-resolved apply with `yes: true` (auto-picks take-frame).
   - Assert `applied_frames.resources.constitution.snapshotBefore === ORIGINAL_DOC` (NOT the drifted state).
   - `removeFrameWithDb`.
   - Assert `memory.findOne({path:"shared/constitution.md"}).content === ORIGINAL_DOC`.

2. **Apply → drift → take-frame → drift again → take-frame again → remove → still restores to pre-first-apply.**
   - Same seed and apply as (1).
   - Inject drift A, drift-resolved apply A.
   - Inject drift B (different content), drift-resolved apply B.
   - `frame remove`.
   - Assert constitution === `ORIGINAL_DOC`. Verifies snapshot survives N cycles.

3. **Apply → drift → keep-local → remove → restores to pre-first-apply.**
   - Same seed and apply as (1).
   - Inject drift.
   - Pre-seed `applied_frames.driftAccepted` with a `keep-local` decision for the constitution resource (matching the schema in `types.ts`). On the next apply, `applyDriftDecisions` filters out the already-decided finding, so audit reports "no actionable drift" and apply short-circuits at line 131-135 (no step 6 execution at all).
   - Re-run `executeFullApply`. Assert exit 0 and the persisted `applied_frames.resources.constitution.snapshotBefore` is unchanged from after step (1).
   - `frame remove`. Constitution becomes `ORIGINAL_DOC` (frame's snapshotBefore was never touched). Note: the operator's local edit is wiped — that's the documented contract of keep-local + remove (the snapshot wins on remove). The test verifies the snapshot was preserved, not that local edits are kept.

4. **Apply → drift → merged-write → remove → restores to pre-first-apply.**
   - `merged` decision is processed in step 6 like `take-frame` (both are in `forceWriteResources`). Set up a merged decision via the dialog or by direct construction (the dialog returns `mergedText` which apply.ts substitutes for the file content).
   - Test approach: skip the dialog entirely by calling `executeFullApply` after pre-seeding an `applied_frames` record + injecting drift, then injecting a synthetic `dialogResultsByResource` entry. Easier: just exercise the same code path with `take-frame`-equivalent merged content, since the snapshot-preservation logic doesn't branch on merged-vs-take-frame.
   - Assert `snapshotBefore === ORIGINAL_DOC` after the drift-resolved apply.
   - `frame remove` → constitution === `ORIGINAL_DOC`.

5. **Apply → drift on prompts → take-frame → remove → restores to pre-first-apply.**
   - Seed agent_definitions with `rae` having `<a id="role-spec"></a>\nORIGINAL ROLE`.
   - Apply frame with prompt clause for `rae` at `role-spec`.
   - Inject drift on `rae`'s systemPrompt around `role-spec`.
   - Drift-resolved apply.
   - Assert `applied_frames.resources.prompts.rae.snapshotBefore === ORIGINAL ROLE` (not the drifted prompt).
   - `frame remove` → `rae.systemPrompt === ORIGINAL ROLE`.

6. **(Adjacent bug coverage)** Apply with all 6 asset types → drift on constitution only → drift-resolved apply on constitution → assert `applied_frames.resources` still has `skills`, `memorySeeds`, `coreservers`, `schedule`, `prompts` carried over from `existing`. Then `frame remove` → assert all 6 resource types reverted (skill bundle gone, seed gone, coreservers pulled, schedule pulled, prompt clause removed, constitution restored).

7. **(First-time apply unchanged)** Apply with no existing record → assert all 6 resource types recorded → `snapshotBefore` for constitution and prompts captured fresh from current state. This pins backwards-compat and protects against the carry-forward logic accidentally polluting the first-time path.

8. **(Cross-version --adopt)** Pre-seed an `applied_frames` record at v1.0.0 with a custom `snapshotBefore`. Run adopt with v1.1.0 manifest (different version). Assert new record persists with the v1.0.0 snapshotBefore preserved (not re-captured from current document state).

**Verify after add:** `MONGODB_TEST_URI=mongodb://localhost:27017 npm run test -- src/frames/commands/apply-snapshot-preservation.test.ts` all pass; `npm run typecheck` clean.

**Commit:** `test(frames): KPR-105 — cover snapshotBefore preservation across drift-resolved applies`

---

## Verification

After all four commits land in the worktree:

1. `npm run check` (typecheck + lint + format + full test suite) passes.
2. Read-only sanity-check the live dodi `applied_frames` record before and after the fix is implemented (no migration — read only):
   ```
   mongosh --quiet --eval 'use("hive_dodi"); const r = db.applied_frames.findOne({_id:"hive-baseline"}); print("constitution.snapshotBefore length:", r.resources.constitution?.snapshotBefore?.length);'
   ```
   The fix does not migrate this record; if dodi later runs a drift-resolved apply post-fix, the carry-forward logic uses the current (already-stale) `snapshotBefore` value as the carry. That's correct forward-only behavior.
3. The smoke-e2e test (`smoke-e2e.test.ts`) continues to pass — protects the first-time apply + remove path.

---

## Migration / Live-instance impact

- **dodi**: existing `applied_frames.hive-baseline` record's `snapshotBefore` was captured under old engine semantics. The fix is forward-only — it ensures FUTURE drift-resolved applies don't make things worse. The current record's snapshot is whatever it was at the moment of the prior adopt; the fix doesn't reconstruct true pre-frame state.
- **keepur**: record was cleared during KPR-86 walkthrough cleanup. Future `frame apply` will produce a record under the new (correct) semantics from the start — no migration concern.
- **Operator-visible behavior change**: a drift-resolved apply now produces a persisted record where `snapshotBefore` may be older than `appliedAt` (because it carries over). This is intentional — the `appliedAt` field is "when this version of the record was last touched"; `snapshotBefore` is "the document state before the very first apply." They were conflated under the buggy behavior; they're now distinct and correctly so.

PR body must clearly call out this migration note.

---

## Out of Scope

- Migrating existing `applied_frames` records on dodi or other already-applied instances. Forward-only fix.
- Schema change to `AppliedFrameRecord` (e.g. adding a `firstAppliedAt` field). Not needed — `appliedAt` continues to mean "last touched" and `snapshotBefore` continues to mean "pre-first-apply baseline" once the bug is fixed.
- Changing drift-dialog UX. The dialog's contract is unchanged.
- Changing `removeFrameWithDb` (consumer side). It already correctly reads `record.resources.*.snapshotBefore`.
- Coreservers/schedule "true rollback" snapshot capture. They don't have `snapshotBefore` semantics today; adding them would be a wider design change tracked separately if/when needed.

## Risks

- **Carry-forward edge cases.** If a drift-resolved apply removes an anchor from the manifest (rare — would require a manifest edit between applies), the carry-forward logic would re-introduce the dropped anchor's record into `resources.constitution.anchors`. Mitigation: tests pin same-manifest cycles. Cross-version applies on different manifest are out of scope (a manifest edit is a different ticket — would need a "stale anchor cleanup" pass).
- **`replaceOne` race with hot-reload.** `applied-frames-store.upsert` is a wholesale `replaceOne`. The new merge logic runs in JS before the upsert, so the persisted document is the merged truth. No race introduced.
- **Test fragility around dialog auto-pick.** The drift dialog with `yes: true` auto-picks `take-frame` for `constitution-text-changed` and `prompt-text-changed` findings — that's the path tests 1, 2, 4, 5, 6 rely on. If the dialog's auto-pick policy changes, those tests need to inject the decision directly. Mitigation: tests assert the resolved decision was what we expected (via `applied_frames.driftAccepted`).
