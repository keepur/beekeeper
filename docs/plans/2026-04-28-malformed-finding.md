# KPR-107 — drift-detector: emit `*-malformed` finding instead of swallowing

## Symptom

`src/frames/drift-detector.ts:53-57` (constitution) and `~198-201` (prompts) catches throws from `collectAnchorSet` and silently produces an empty `Set`. Any duplicate-anchor situation in the constitution / prompts then reports as N spurious `constitution-anchor-missing` / `prompt-anchor-missing` findings, hiding the real cause. KPR-106 removed the primary cause but the catch-swallow remains a footgun.

## Fix shape (from ticket)

1. **Inline documentation** at both catch blocks — explain the fail-safe intent, reference KPR-106 + KPR-107.
2. **Promote to a named finding** — emit a distinct `constitution-malformed` / `prompt-malformed` finding with the original error message.
3. **Blocking behavior** — malformed findings are blocking by default (audit exits non-zero, apply refuses to write); operator may opt out with `--force-malformed`.

The existing `constitution-anchor-missing` / `prompt-anchor-missing` findings remain unchanged — they continue to surface for genuine missing-anchor situations.

## Implementation

### Task 1 — Add new `DriftKind` variants

**File**: `src/frames/types.ts`

Extend the `DriftKind` union with two new variants:
- `"constitution-malformed"`
- `"prompt-malformed"`

No other type changes required; both new findings use the existing `DriftFinding` shape.

### Task 2 — `drift-detector.ts` — emit malformed findings

**File**: `src/frames/drift-detector.ts`

In `checkConstitution` (lines 53-57), replace:

```ts
let present: Set<string>;
try {
  present = collectAnchorSet(content);
} catch {
  present = new Set();
}
```

with:

```ts
// KPR-107: surface malformed-document errors as a distinct finding rather
// than swallowing into an empty set. Pre-KPR-106 (PR #38), the only known
// cause of this throw was the in-fragment anchor-tag bug; we keep the
// fail-safe but make it actionable so operators see the real cause instead
// of N spurious anchor-missing findings.
let present: Set<string>;
try {
  present = collectAnchorSet(content);
} catch (e) {
  findings.push({
    frame: record._id,
    kind: "constitution-malformed",
    resource: resourceKey("constitution", "shared/constitution.md"),
    detail: `frame "${record._id}" cannot audit constitution: ${(e as Error).message}`,
    informational: false,
  });
  return;
}
```

Note the `return` — once the document is malformed, all per-anchor checks against it would be misleading. We emit the malformed finding and stop checking this record's constitution anchors.

In `checkPrompts` (lines 197-202), apply the parallel transformation:

```ts
let present: Set<string>;
try {
  present = collectAnchorSet(currentPrompt);
} catch (e) {
  findings.push({
    frame: record._id,
    kind: "prompt-malformed",
    resource: resourceKey("prompts", agentId, "systemPrompt"),
    detail: `frame "${record._id}" cannot audit prompts on agent "${agentId}": ${(e as Error).message}`,
    informational: false,
  });
  continue; // skip per-anchor checks for this agent only
}
```

The `continue` (vs. `return` for constitution) is intentional — malformed prompt for one agent should not block prompt checks for other agents in the same record.

### Task 3 — `apply.ts` — block on malformed unless `--force-malformed`

**File**: `src/frames/commands/apply.ts`

Add `forceMalformed` to `ApplyOptions`. Add a pre-flight `detectMalformedTargets` helper that scans the frame's target documents (constitution + per-agent systemPrompts the frame touches) using `collectAnchorSet` and returns a list of malformed findings. This runs BEFORE `verifyAnchors` so it catches first-time apply too.

In both `executeFullApply` and `runAdopt`, before the existing flow:

```ts
if (!opts.forceMalformed) {
  const blocked = await detectMalformedTargets(db, manifest, resolver);
  if (blocked.length > 0) {
    console.error(`Frame "${name}" v${ver}: refusing to apply — N malformed target document(s):`);
    for (const m of blocked) console.error(`  ${m.kind}: ${m.detail}`);
    console.error(`Pass --force-malformed to apply anyway.`);
    return 1;
  }
}
```

**Side effect on `verifyAnchors`**: it currently calls `collectAnchorSet`, which throws on duplicates. With the pre-flight gate doing the malformed check, `verifyAnchors` only needs to check anchor *presence* — duplicates don't invalidate that. Switch its two `collectAnchorSet` calls to `new Set(findAnchors(text).map(a => a.anchor))` (permissive, no throw). This way `--force-malformed` actually lets the apply proceed past the presence check into the writer (where ambiguity about which anchor to write to is the operator's problem).

In `executeFullApply`'s drift-resolved-apply branch, also filter `constitution-malformed` / `prompt-malformed` out of the dialog set (operator already opted in via `--force-malformed`; we don't ask them again per-finding).

### Task 4 — `cli.ts` — wire `--force-malformed`

**File**: `src/frames/cli.ts`

In the `apply` case:

```ts
const forceMalformed = flags.includes("--force-malformed");
// ...
return await applyFrame(framePath, instanceId, {
  adopt,
  forceOverride,
  allowSeedOverride,
  forceMalformed,
  yes,
});
```

Update usage line and help text to mention `--force-malformed`.

### Task 5 — Tests

Add to `src/frames/drift-detector.test.ts`:

1. **Duplicate constitution anchor → emits `constitution-malformed`, not N × `constitution-anchor-missing`.**
   - Setup: record with 2 frame anchors; live constitution content has duplicate `<a id="capabilities">`.
   - Assert: exactly one finding with `kind === "constitution-malformed"`, error message includes "Duplicate anchor", `informational === false`. No `constitution-anchor-missing` findings.

2. **Duplicate prompt anchor on one agent → emits one `prompt-malformed` for that agent only; other agents still checked.**
   - Setup: prompts block for two agents; agent A's systemPrompt has duplicate anchor, agent B's is well-formed but missing the required anchor.
   - Assert: one `prompt-malformed` for agent A, one `prompt-anchor-missing` for agent B.

Add to `src/frames/commands/apply.test.ts` (or new test file if cleaner):

3. **Malformed finding blocks apply by default.**
   - Setup: existing applied record at same version; live constitution has duplicate anchor.
   - Call `executeFullApply` without `forceMalformed`. Assert exit code 1, error message mentions `constitution-malformed`, no asset writes occurred.

4. **`--force-malformed` opt-out allows apply to proceed past malformed finding.**
   - Same setup as (3), but with `forceMalformed: true`. The malformed finding is treated as part of the drift dialog flow (since informational is false, it'll be presented to the user; in `--yes` mode, take-frame will be the default, attempting to re-write).
   - Realistic assertion: with `forceMalformed: true` + `--yes`, the apply does NOT short-circuit on malformed; it enters the normal drift-dialog flow.

Tests 3 and 4 may be challenging given the complexity of `executeFullApply`'s mocking surface — keep the assertions minimal (exit-code + error-message checks; don't exhaustively validate the asset-writer mocks). If full integration is too heavy, split into:
   - Pure unit test on a hypothetical extracted `checkMalformedBlock(findings, opts) -> { block: boolean, message: string }` helper.
   - But preferred: keep the gate inline in `executeFullApply` and exercise it via the existing `apply.test.ts` mock harness.

Add to `src/frames/commands/audit.test.ts`:

5. **Audit summary: malformed finding renders as actionable drift line, exits 1.**
   - Findings array with one `constitution-malformed`. Assert `summary.exitCode === 1` and message contains the malformed kind.

## Out of scope

- Migrating CI/scripts that may grep for `constitution-anchor-missing` — the legacy finding kind remains for genuine missing-anchor cases. New `*-malformed` is additive.
- Detecting other classes of "malformed document" beyond duplicate anchors — `collectAnchorSet` is the canonical throw site; if its contract grows, the catch already captures whatever it throws.
- Drift-dialog UI changes for malformed findings — they flow through the existing pipeline as actionable findings; operator can keep-local / take-frame / merged the same as any other finding (under `--force-malformed`).

## Verification

1. `npm run check` clean.
2. New tests pass:
   - `npx vitest run drift-detector` — covers tasks (1) + (2).
   - `npx vitest run apply.test` — covers tasks (3) + (4).
   - `npx vitest run audit.test` — covers task (5).
3. `--force-malformed` appears in `beekeeper frame apply --help` output (usage line + flags block).

## Commits

Single-purpose commit recommended:

1. `KPR-107: emit constitution-malformed / prompt-malformed finding instead of swallowing` — types + detector + apply gate + CLI flag + tests.

If the commit gets too large, split:
1. `KPR-107: types — add constitution-malformed / prompt-malformed DriftKind`
2. `KPR-107: detector — emit malformed findings instead of swallowing throws`
3. `KPR-107: apply — block malformed by default, --force-malformed opt-out`
