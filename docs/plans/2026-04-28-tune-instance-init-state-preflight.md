# tune-instance Phase 1 Step 0 — pre-flight init-state check

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan. Each task is self-contained; commit after.

**Goal:** Wire the `tune-instance` skill (KPR-72, PR #23) to call `beekeeper init-state <instance-id> --json` (KPR-71, PR #41) as **Step 0** of Phase 1, parse the result, and route based on `state`:

- `state: "fresh"` → recommend the operator run `hive init` first; exit Phase 1 with no findings produced.
- `state: "partial"` → audit proceeds, but the Phase 2 report carries a leading note that the instance is partially initialized AND a P-prefixed finding suggesting completion of init.
- `state: "completed"` → audit proceeds normally (current behavior, no extra finding).

This closes the integration gap left by KPR-71: the spec described `detectInstanceState()` as "shared with KPR-72 tune-instance," but PR #41 only wired `init-instance`. Without this preflight, running `tune-instance` on a fresh / partial instance produces noisy findings (e.g. "Section 2 missing" when the right action is `hive init`, not tune).

**Architecture:** `tune-instance` is an agentic skill — the playbook IS the implementation. The Beekeeper agent reads `skills/tune-instance/SKILL.md` and executes the steps via Bash + existing MCP tools. New preflight = new SKILL.md section + Phase 2 note path + new finding shape. **No TypeScript, no MCP changes**, no new dependencies. Mirrors the pattern KPR-102 used to add Steps 11/12.

**Sibling skill we copy from:** `skills/init-instance/SKILL.md` Phase 0 already invokes `beekeeper init-state <id> --json` and parses the same JSON shape. Step 0 reuses the same invocation pattern verbatim so Phase 0 and Step 0 cannot disagree about what "initialized" means.

**Spec reference:** `docs/specs/2026-04-26-init-instance-skill-design.md` ("Coordination with sibling tickets") + `docs/specs/2026-04-26-tune-instance-skill-design.md` (the tune-instance design itself).

**Tech stack:** Markdown only. `npm run check` runs typecheck + lint + tests; no behavior change is expected, but the gate must stay clean.

---

## File Structure

### Files to modify

| File | Reason |
|---|---|
| `skills/tune-instance/SKILL.md` | Add **Step 0 — Pre-flight state check** at the top of Phase 1 (before "1. Constitution drift"). Add a "leading note" clause to Phase 2 for the `partial` branch and the new P-prefixed finding shape. |

### Files NOT touched

- `skills/init-instance/SKILL.md` — already correct; Step 0 just mirrors its Phase 0 invocation pattern.
- `skills/tune-instance/README.md` — operator-facing, but Step 0 is a transparent pre-flight; no change to invocation, prefix list, or cherry-pick syntax. (The new partial-init finding uses the existing `P` prefix so the prefix list stays accurate.)
- `src/init/cli.ts` and `src/init/detect-instance-state.ts` — KPR-71 already shipped these; consumed as-is via `--json`.
- No new tests — markdown skill change.

---

## CLI invocation contract (from KPR-71)

`beekeeper init-state <instance-id> --json` (per `src/init/cli.ts`) prints to stdout:

```json
{
  "state": "fresh" | "partial" | "completed",
  "detail": {
    "section2Written": boolean,
    "frameApplied": boolean,
    "cosSeeded": boolean,
    "handoffMemoryWritten": boolean,
    "lastInitRunId": string | null,
    "lastInitAppliedAt": string | null
  }
}
```

Decision rule (already implemented in `detect-instance-state.ts`):
- All four detail booleans `true` → `completed`.
- All four `false` → `fresh`.
- Any other combination → `partial`.

Step 0 only branches on the top-level `state`. The `detail` fields are surfaced verbatim into the Phase 2 leading note for the `partial` branch (operator readability), but Step 0 itself does not re-derive state from them.

---

## Task 1: Add "Step 0 — Pre-flight state check" to SKILL.md Phase 1

**Files:** `skills/tune-instance/SKILL.md`

- [ ] **Step 1.1:** Locate the `## Phase 1 — Audit (read-only)` section (currently at line 40). The current first audit step is `### 1. Constitution drift` at line 44. Insert a new section **between** the Phase 1 intro paragraph (line 42–43) and `### 1. Constitution drift`. The exact markdown to insert is shown below in a 4-backtick fence so the inner triple-backtick fences render correctly — when implementing, drop the outer 4-backtick wrapper and write only the inner content into SKILL.md:

````markdown
### 0. Pre-flight state check

Before running any audit step, verify the target instance has actually been through `init-instance` (KPR-71). Running tune on a fresh or partially-initialized instance produces noisy findings (e.g. "Section 2 missing" — but the right remediation is `hive init`, not a tune fix). Step 0 short-circuits the obvious cases and annotates the report when init isn't fully done.

#### Invocation

Run `beekeeper init-state <instance-id> --json` via Bash. The command prints a JSON object to stdout shaped:

```
{
  "state": "fresh" | "partial" | "completed",
  "detail": {
    "section2Written": boolean,
    "frameApplied": boolean,
    "cosSeeded": boolean,
    "handoffMemoryWritten": boolean,
    "lastInitRunId": string | null,
    "lastInitAppliedAt": string | null
  }
}
```

This is the same primitive `init-instance` Phase 0 uses (canonical implementation: `src/init/detect-instance-state.ts`); both skills route through the same CLI so they cannot disagree about what "initialized" means.

If the operator referred to a non-default CoS slug (e.g., `mokie`) in their invocation context, pass `--cos-agent-id <slug>` so detection picks up the right CoS record. Otherwise the default (`chief-of-staff`) is used.

#### Branches

- **`fresh`** → tune-instance is the wrong tool. Emit to the operator:

  ```
  Instance <instance-id> has not been initialized — `init-state` returned `fresh`
  (no Section 2, no frame, no CoS, no handoff memory).

  Run `hive init <instance-id>` (or invoke the `init-instance` skill) first.
  Re-invoke tune-instance once init completes.
  ```

  **Exit Phase 1.** No findings produced, no report drafted, no Phase 2/3/4 run. Return control to the operator.

- **`partial`** → audit proceeds (Steps 1–12 run normally), but:
  - The Phase 2 report opens with a **leading note** stating that the instance is partially initialized, listing which `detail` booleans are `false`, and citing `lastInitAppliedAt` if present.
  - A new finding is appended under prefix `P` (per-agent prompts category — closest fit, since CoS prompt-shape is the dominant init artifact missing) with a recommendation to complete `init-instance` before applying tune fixes. The finding's proposed action is **manual** (operator runs `init-instance` resume, not a Phase 3 write); the finding is informational, not auto-applyable.

- **`completed`** → audit proceeds normally. No extra finding, no leading note. This is the existing behavior for instances that have been through init.

#### Frame-awareness

The state primitive already accounts for `applied_frames`; Step 0 doesn't add frame-aware logic of its own. If the instance is frame-naive (no `applied_frames` collection), `frameApplied` reads `false` and the state likely lands `partial` or `fresh` depending on the other booleans — that's correct: a frame-naive instance is genuinely not init-completed under the KPR-86 model.

#### Why P prefix and not a new letter

The partial-init finding is structurally a **per-agent prompt completeness** issue — the CoS agent isn't fully shaped, the operator-authored Section 2 is missing, the universal-9 baseline isn't asserted via the frame. Reusing `P` keeps the prefix list stable (no README/spec churn for one informational finding) and the operator can still cherry-pick around it (`skip P0` or whatever the report numbers it). If a future audit run finds enough init-related drift to justify a dedicated prefix (e.g., `I` for init), that's a follow-up; not this ticket.
````

**Note on fence nesting:** the section being inserted contains nested code fences (the JSON-shape block and the operator-message block). When you paste into SKILL.md, leave those triple-backtick fences as triple-backticks — markdown renders nested fences correctly when the outer block is also closed by triple-backticks. Prettier may complain about the indentation under the bullet points; if so, adopt the same indentation pattern Step 11's registry table uses (no extra leading spaces beyond the bullet's own indent).

- [ ] **Step 1.2:** Verify

```bash
grep -c "### 0. Pre-flight state check" skills/tune-instance/SKILL.md
grep -c "beekeeper init-state" skills/tune-instance/SKILL.md
grep -cE 'state.*"fresh".*"partial".*"completed"' skills/tune-instance/SKILL.md
```

Expected: heading count = 1; `init-state` invocation count >= 1; state-shape line count >= 1.

- [ ] **Step 1.3:** Commit

```bash
git add skills/tune-instance/SKILL.md
git commit -m "feat(skill): KPR-108 — tune-instance Phase 1 Step 0 pre-flight init-state check"
```

---

## Task 2: Add Phase 2 leading-note clause for the `partial` branch

**Files:** `skills/tune-instance/SKILL.md`

- [ ] **Step 2.1:** Locate the `## Phase 2 — Operator review` section (currently around line 228). The first paragraph reads:

> After the audit, the skill emits a single consolidated report to the operator (no drip — full picture in one message). Format follows the playbook draft's structured-text shape, with each finding numbered for cherry-pick reference. Per-category prefixes:

Insert a new short subsection **before** the "Per-category prefixes" bullet list, titled `### Leading note (when Step 0 returned partial)`. Same nested-fence convention as Task 1 — drop the outer 4-backtick wrapper when writing into SKILL.md:

````markdown
### Leading note (when Step 0 returned partial)

If Step 0's `init-state` returned `partial`, the consolidated report opens with a leading note **before** the per-category findings, formatted:

```
NOTE: instance <instance-id> is partially initialized.
  section2Written:        <true | false>
  frameApplied:           <true | false>
  cosSeeded:              <true | false>
  handoffMemoryWritten:   <true | false>
  lastInitAppliedAt:      <ISO timestamp or "unknown">

Some findings below may be artifacts of incomplete init rather than drift.
Recommend completing `init-instance` (resume from where it left off — the
skill detects `partial` and offers a resume dialog) before applying tune
fixes. The audit report is still useful as a checkpoint, but read it through
the lens that init wasn't done yet.
```

If Step 0's `init-state` returned `completed`, this leading note is omitted (the existing report opens with the per-category findings as before).
````

- [ ] **Step 2.2:** Update the example report shape (the fenced text block under `Example report shape:`) to show the leading note in context. Locate the existing example block opening:

```
TUNE-INSTANCE REPORT: <instance-id>  |  <run-id>  |  <date>

CONSTITUTION DRIFT (5 findings)
```

Insert a one-line "leading note appears here when Step 0 returned partial" comment so the operator can see where it slots in:

```
TUNE-INSTANCE REPORT: <instance-id>  |  <run-id>  |  <date>

[OPTIONAL: leading note from Step 0 partial branch — see "Leading note" subsection above]

CONSTITUTION DRIFT (5 findings)
```

- [ ] **Step 2.3:** Verify

```bash
grep -c "### Leading note (when Step 0 returned partial)" skills/tune-instance/SKILL.md
grep -c "OPTIONAL: leading note from Step 0" skills/tune-instance/SKILL.md
```

Expected: heading count = 1; example-block annotation count = 1.

- [ ] **Step 2.4:** Commit

```bash
git add skills/tune-instance/SKILL.md
git commit -m "feat(skill): KPR-108 — Phase 2 leading note for partial-init state"
```

---

## Task 3: Quality gate

- [ ] **Step 3.1:** Run `npm run check`. Expected: clean (typecheck + lint + Prettier + Vitest all pass; no behavior change in TypeScript surface).

- [ ] **Step 3.2:** Eye-grep for accidental TODO/FIXME markers in the modified file:

```bash
grep -nE 'TODO|FIXME|FILLED IN' skills/tune-instance/SKILL.md
```

Expected: no new matches beyond what's there pre-change.

- [ ] **Step 3.3:** Read-back sanity: open `skills/tune-instance/SKILL.md` and confirm Phase 1 reads top-down as **Step 0 → Step 1 → ... → Step 12**, with no orphan headings or duplicated section numbers.

---

## Acceptance criteria mapping

| Ticket AC (KPR-108) | Task |
|---|---|
| Step 0 invokes `beekeeper init-state <instance-id> --json` and parses the result | Task 1 |
| `state: "fresh"` → recommend `hive init`, exit Phase 1, no findings | Task 1 |
| `state: "partial"` → audit proceeds + leading note + P-prefixed finding | Task 1 + Task 2 |
| `state: "completed"` → audit proceeds normally (current behavior) | Task 1 (no-change branch) |
| Skill style matches existing SKILL.md (markdown-as-instructions, follows Steps 1–12 pattern) | Task 1 (mirrored from `init-instance` Phase 0 + KPR-102 Steps 11/12) |
| Single source of truth for instance state (Step 0 calls the same CLI as `init-instance` Phase 0) | Task 1 (re-uses `beekeeper init-state` per spec coordination note) |

---

## Plan-stage notes

**Why no code changes:** the CLI primitive shipped in KPR-71. tune-instance is markdown; Beekeeper executes Bash + parses JSON natively as part of skill execution. Adding a Step 0 = adding a SKILL.md section. No TypeScript surface.

**Why P prefix instead of a new prefix letter:** the partial-init finding is structurally a "CoS prompt + Section 2 + frame" completeness issue. `P` (per-agent prompts) is the dominant fit and avoids README/spec churn. If future audit runs uncover enough init-related drift to justify a dedicated `I` prefix, file a follow-up ticket; do not preempt that decision here.

**Why leading note vs. inline finding-only:** a single P-prefixed finding can get lost in a 30-finding report. The leading note makes the partial-init context unmissable on first read. The finding still exists for cherry-pick semantics (operator can `skip` it if they're auditing intentionally-partial state, e.g. mid-resume).

**Frame-naive instances:** state primitive accounts for `applied_frames` directly; no special-casing in Step 0. A frame-naive instance reads `frameApplied: false` → likely `fresh` or `partial` depending on the other booleans. That's correct under the KPR-86 model.

**Idempotency:** Step 0 is purely structural — running it twice on the same instance returns the same state. The leading note re-appears on every audit run while the instance stays partial; once init completes, the note disappears and the audit returns to the existing baseline.

**Out-of-scope:** refactoring `detectInstanceState` itself, adding new state branches beyond fresh/partial/completed, designing a dedicated init-completion finding category. All ticket-explicit out-of-scope items.
