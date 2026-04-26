# Tune-Instance Skill Implementation Plan

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan. Each task is self-contained; commit after each.
>
> **STATUS — gated on KPR-83 (Frames foundation).** Spec and plan can land now; implementation must wait until KPR-83 ships so frame-awareness primitives (anchored constitution sections, `replacedClaimFrom` fields on agent_definitions / schedules / seeds, per-instance `frames/applied.json`) are real and importable. Picking up this plan before KPR-83 lands forces guesswork on schemas that don't exist yet — the audit step changes if those primitives aren't there. Confirm KPR-83 is "Done" in Linear before opening a worktree against this plan.

**Goal:** Ship a Beekeeper-owned agentic skill `tune-instance` that audits a running Hive instance for drift across constitution / business-context / per-agent prompts / coreServers baseline / memory tiers / cron→skill wiring / skill availability / naming-identity / frame integrity, surfaces findings to the operator in one consolidated report, applies cherry-picked remediations on consent with full traceability, and persists per-run findings for next-run continuity.

**Architecture:** A new `skills/tune-instance/` directory under the Beekeeper repo holds the skill (`SKILL.md` playbook + operator-facing `README.md`). The Beekeeper installer (existing `beekeeper install` CLI command) gains a postinstall step that creates a symlink at `~/.claude/skills/tune-instance/` → `<beekeeper-install-dir>/skills/tune-instance/` so the existing skill auto-discovery in `src/config.ts:84-97` (`discoverUserSkills`) picks it up as a local plugin for any Beekeeper session. **No new MCP servers** — the skill rewires existing `admin_*` MCP tools (`admin_save_constitution`, `admin_save_agent`) and uses the mongosh access the Beekeeper agent already has. The skill itself is ~95% verbatim port from `/tmp/tune-instance-skill.md` (the canonical playbook draft) plus the contract layer the spec adds: `runId` allocation, frame-awareness, cherry-pick parsing, Section 1 invariant guard, Phase 4 findings doc with markdown + JSON-block dispositions, and Phase 4 write-failure recovery.

**Tech Stack:** Markdown for the skill body. TypeScript (NodeNext, strict) + Vitest for the installer wiring + `addComment` retry wrapper. ESM `.js` import extensions throughout. No `any` in production code.

**Spec reference:** `docs/specs/2026-04-26-tune-instance-skill-design.md` (review-clean, Linear KPR-72).

**Playbook source (verbatim port for SKILL.md body):** `/tmp/tune-instance-skill.md` (210 lines, dated 2026-04-25).

**Reference plan style:** `docs/plans/2026-04-26-pipeline-tick-foundation.md` (KPR pipeline-tick) — same task shape, same commit cadence.

---

## File Structure

### Files to create

| File | Responsibility |
|---|---|
| `skills/tune-instance/SKILL.md` | The playbook the Beekeeper agent loads when the skill is invoked. Frontmatter (`name`, `description`, `agents: [beekeeper]`, `schedule: every 2 weeks`) + the 9-step Phase 1 checklist + Phase 2/3/4 contract. ~95% verbatim port from `/tmp/tune-instance-skill.md` (Tasks 3 + 4). |
| `skills/tune-instance/README.md` | Operator-facing how-to: when to run, what each phase does, what cherry-pick syntax looks like, how to read the findings doc, troubleshooting. ~80 LOC. |
| `src/service/skill-installer.ts` | Postinstall step — creates the `~/.claude/skills/tune-instance/` symlink to the bundled `skills/tune-instance/` directory. Idempotent (symlink-equality check, doesn't clobber a real directory). Logs to console. |
| `src/service/skill-installer.test.ts` | Vitest coverage for the installer: fresh install creates symlink, re-install is idempotent, real-directory collision logs warning + does NOT clobber, broken symlink is replaced, uninstall removes only the symlink. |

### Files to modify

| File | Reason |
|---|---|
| `src/service/generate-plist.ts` | `install()` calls the new `installSkillSymlink()` after writing the plist + wrapper. `uninstall()` calls `removeSkillSymlink()`. |
| `package.json` | Add `"skills/"` to the `files` array so the skill ships with the npm tarball. No new dependencies. |

### Files NOT touched

- No `src/agents/`, no MCP server source — the skill consumes existing `admin_*` MCP surfaces only.
- No `src/index.ts` — the skill is a plugin auto-discovered at config-load time; no wiring change.
- No new pipeline handlers — `tune-instance` is operator-invoked, not pipeline-tick-orchestrated.

---

## Task 1: Skill directory + frontmatter scaffold

**Files:**
- Create: `skills/tune-instance/SKILL.md` (frontmatter + heading skeleton only — Phase content lands in Task 3)

- [ ] **Step 1.1:** Create the skill directory and write the frontmatter + scaffold to `skills/tune-instance/SKILL.md`. Frontmatter MUST match the spec's "Skill identity" section (`name`, `description`, `agents: [beekeeper]`, `schedule: every 2 weeks`).

```markdown
---
name: tune-instance
description: Periodic audit-and-tune pass on a Hive instance. Surfaces drift in constitution, business-context, per-agent prompts, coreServer baseline, memory tiers, cron→skill wiring, and frame-managed overrides; proposes remediations; applies on operator approval.
agents: [beekeeper]
schedule: every 2 weeks
---

# Tune Instance

You are about to perform a maintenance pass on a Hive instance. Your job is to find drift, surface it clearly, propose remediations, and (on approval) apply them. You are operating from outside the hive — agents do not self-modify (constitution §1.16). Mutations go through admin MCP, mongosh, or direct file edits in `<instance>/skills/`.

## Operating principles

[FILLED IN BY TASK 3]

## Inputs

[FILLED IN BY TASK 3]

## runId allocation

[FILLED IN BY TASK 3]

## Phase 1 — Audit (read-only)

[FILLED IN BY TASK 3]

## Frame-awareness

[FILLED IN BY TASK 4]

## Phase 2 — Operator review

[FILLED IN BY TASK 5]

## Phase 3 — Apply with consent

[FILLED IN BY TASK 6]

## Phase 4 — Save findings

[FILLED IN BY TASK 7]

## Anti-patterns to refuse

[FILLED IN BY TASK 3]

## Cross-instance considerations

[FILLED IN BY TASK 3]
```

This scaffold lets later tasks fill in sections without merge-conflicting against each other if work is parallelized. `[FILLED IN BY TASK N]` markers must NOT remain in the final file — Task 8 verifies they're all gone.

- [ ] **Step 1.2:** Verify

```bash
test -f skills/tune-instance/SKILL.md && head -5 skills/tune-instance/SKILL.md
```

Expected: file exists; first 5 lines show the frontmatter open + `name: tune-instance`.

- [ ] **Step 1.3:** Commit

```bash
git add skills/tune-instance/SKILL.md
git commit -m "feat(skill): scaffold tune-instance SKILL.md with frontmatter"
```

---

## Task 2: Ship `skills/` in the npm tarball

**Files:**
- Modify: `package.json`

- [ ] **Step 2.1:** Add `"skills/"` to the `files` array in `package.json` so the skill is included when the package is published. Current `files` array is `["dist/", "beekeeper.yaml.example", "LICENSE", "README.md"]` — add `"skills/"` between `dist/` and `beekeeper.yaml.example`.

```json
"files": [
  "dist/",
  "skills/",
  "beekeeper.yaml.example",
  "LICENSE",
  "README.md"
],
```

- [ ] **Step 2.2:** Verify the skill ships in the tarball.

```bash
npm pack --dry-run 2>&1 | grep "skills/tune-instance/SKILL.md"
```

Expected: line printed showing `skills/tune-instance/SKILL.md` is included in the tarball contents.

- [ ] **Step 2.3:** Commit

```bash
git add package.json
git commit -m "feat(skill): include skills/ directory in npm tarball"
```

---

## Task 3: Port the 9-step playbook + Phase 1/Phase 2-skeleton/Phase 3-skeleton/Phase 4-skeleton from `/tmp/tune-instance-skill.md`

**Files:**
- Modify: `skills/tune-instance/SKILL.md`

This task is the **bulk verbatim port** of the playbook draft. The skill IS the playbook. Frame-awareness extensions, cherry-pick parsing, Section 1 invariant guard, and Phase 4 JSON block come in Tasks 4–7. Keep this task focused on the parts that lift directly from `/tmp/tune-instance-skill.md`.

**Source file:** `/tmp/tune-instance-skill.md` — the existing 210-line playbook draft. **~95% of the SKILL.md content is a verbatim port from this file.** Read it end-to-end before editing.

- [ ] **Step 3.1:** Replace the `## Operating principles` section in `skills/tune-instance/SKILL.md` with the verbatim content from `/tmp/tune-instance-skill.md` lines 12–18 (the four bullets: audit-before-action, preserve-dignity, approval-delegation, one-bundled-report).

- [ ] **Step 3.2:** Replace the `## Inputs` section with the spec's "Inputs" content (spec §"Inputs", lines 69–78). The instance-id paragraph + the "asks the operator if no instance is given" / "defaults silently if only one instance" rules. Source file `/tmp/tune-instance-skill.md` lines 19–22 has the shorter form; the spec adds the disambiguation rules — port the spec version.

- [ ] **Step 3.3:** Replace the `## Phase 1 — Audit (read-only)` section with the verbatim 9-step content from `/tmp/tune-instance-skill.md` lines 24–131 (steps 1 through 9, including all bullet sub-points, mongosh queries, hot-tier policy bullets, common-cron-gap examples, and the `git archive` recovery hint). Keep the prose verbatim — the playbook IS the codified audit pattern.

  **Spec deltas to layer in (small additions, NOT rewrites):**
  - **Step 9 → add agent-directory naming convention sub-point.** Spec §"Phase 1 audit" item 9 says "agent directories use one convention (role-id OR agent-name, not mixed)". The playbook draft already says this (line 128); confirm it's present after the port.
  - **Step 4 → confirm engine line reference.** The playbook says `src/agents/agent-runner.ts:865-880` for auto-injection logic. Re-verify against the current `~/github/hive` main before Task 8 verification — if line numbers have drifted, update the reference. (Out-of-scope to bring the hive ref in scope of beekeeper; the line-range hint exists for the operator running the audit.)

- [ ] **Step 3.4:** Replace the `## Anti-patterns to refuse` section with the verbatim content from `/tmp/tune-instance-skill.md` lines 198–204 (the five anti-pattern bullets: blanket-rewrites, bulk-deletion, public-corrections, just-rebuild, auto-applying).

- [ ] **Step 3.5:** Replace the `## Cross-instance considerations` section with the verbatim content from `/tmp/tune-instance-skill.md` lines 206–210 (the two paragraphs about cross-instance scoping + constitution sharing).

- [ ] **Step 3.6:** Replace the `## runId allocation` section with the spec's "runId allocation" content (spec §"runId allocation", lines 80–88). This is a NEW section the playbook didn't have — it specifies the ULID allocation point + how `<runId>` flows through Phase 1 (findings buffer tag), Phase 3 (`updatedBy` value), Phase 4 (filename + index row). Port the spec section verbatim.

- [ ] **Step 3.7:** Verify

```bash
wc -l skills/tune-instance/SKILL.md
grep -c "FILLED IN BY TASK" skills/tune-instance/SKILL.md
```

Expected: ~180 lines after this task (full file lands at ~250 once Tasks 4–7 add their sections); FILLED-IN markers count drops from 7 to 4 (Tasks 4, 5, 6, 7 still have placeholders).

- [ ] **Step 3.8:** Commit

```bash
git add skills/tune-instance/SKILL.md
git commit -m "feat(skill): port 9-step audit playbook + runId + anti-patterns from draft"
```

---

## Task 4: Frame-awareness section (KPR-83 dependency surface)

**Files:**
- Modify: `skills/tune-instance/SKILL.md`

This is the spec's "Frame-awareness (KPR-83 dependency)" section, ported into the skill. **Implementation gates on KPR-83 landing** (per the front-matter warning at the top of this plan) — picking up this task before KPR-83 ships forces guessing the schema of `applied.json` and the exact form of `replacedClaimFrom`. Confirm KPR-83 is Done before starting.

- [ ] **Step 4.1:** Replace the `## Frame-awareness` section in `skills/tune-instance/SKILL.md` with the spec's content from spec §"Frame-awareness (KPR-83 dependency)", lines 106–120. Verbatim port of:
  - The three frame primitives (anchored sections in `shared/constitution.md`, stored records carrying `replacedClaimFrom`, per-instance `frames/applied.json` manifest).
  - The four `tune-instance` integration rules (Phase 1 anchored-section exclusion, Phase 1 `replacedClaimFrom` skip, Phase 1 frame-integrity finding category, Phase 3 frame-bypass override prompt).
  - The frame-naive no-op clause.

- [ ] **Step 4.2:** Add a sub-bullet under each Phase 1 audit step in the existing Phase 1 section (not a rewrite — a one-line note) where frame-awareness changes the step's behavior:
  - **Step 1 (Constitution drift)** → "Sections enclosed by `<!-- frame:<id>:start -->...<!-- frame:<id>:end -->` anchors are tagged frame-managed and excluded from 'remove redundant' findings."
  - **Step 3 (Per-agent prompts)** → "Records with `replacedClaimFrom: <frame-id>` are skipped — the frame is the authoritative claim, not drift."
  - **Step 6 (Cron → skill)** → "Same `replacedClaimFrom` skip applies to scheduled-task entries."
  - **NEW Step 10 (Frame integrity)** → add as a new subsection at the end of Phase 1, flagging inconsistencies between `applied.json` and what's actually present (e.g., frame X claims to provide `daily-purchasing-scan` cron but the cron is missing). Resolution path is re-apply or remove the frame, not hand-edit. Frame-naive instances skip this step entirely.

- [ ] **Step 4.3:** Verify

```bash
grep -c "frame-managed\|replacedClaimFrom\|applied.json\|frame:.*start" skills/tune-instance/SKILL.md
grep -c "FILLED IN BY TASK" skills/tune-instance/SKILL.md
```

Expected: at least 8 frame-related references (one per primitive + per integration rule); FILLED-IN markers count drops to 3 (Tasks 5, 6, 7).

- [ ] **Step 4.4:** Commit

```bash
git add skills/tune-instance/SKILL.md
git commit -m "feat(skill): add frame-awareness Phase 1 + new Step 10 frame-integrity"
```

---

## Task 5: Phase 2 — operator review with cherry-pick parsing contract

**Files:**
- Modify: `skills/tune-instance/SKILL.md`

- [ ] **Step 5.1:** Replace the `## Phase 2 — Operator review` section with the spec's content from spec §"Phase 2 — Operator review (cherry-pick gate)", lines 122–160. Verbatim port of:
  - The consolidated-report structure (single message, no drip) with the per-category finding prefixes:
    - `C` = constitution drift
    - `B` = business-context separation
    - `P` = per-agent prompts
    - `T` = coreServers baseline (tool matrix)
    - `M` = memory hygiene
    - `K` = cron→skill wiring
    - `S` = skill availability
    - `N` = naming-identity
    - `F` = frame integrity
  - The example report block (the structured-text shape with C1/C2/P1/P2/M1/M2 etc).
  - The conversational response format (`apply C1, C3, P2-trim-role, M1-M3; defer P1; skip C2`) and the confirm-before-execute step.
  - The DEFERRED FROM PREVIOUS RUN section (re-surfaced from prior run's findings doc, see Task 7).

- [ ] **Step 5.2:** Append the **parsing-failure contract** sub-section (spec §"Phase 2", lines 156, "Parsing-failure contract" paragraph). Verbatim port: ambiguous response → exactly one targeted clarifying question; two consecutive ambiguous responses on the same review → abandon Phase 3, write a "no apply, parsing failed" findings doc (Phase 4 still runs), exit. Operator can re-invoke with a fresh response.

- [ ] **Step 5.3:** Append the **apply-all scope** sub-section (spec §"Phase 2", line 158). Verbatim port: `"apply all"` covers all proposed findings as listed in the report; frame-bypass findings and Section 1 invariant findings (non-template-drift) still require per-finding override even under apply-all; Section 1 template-drift backfills ARE covered by apply-all.

- [ ] **Step 5.4:** Append the **deferred vs. skipped distinction** sub-section (spec §"Phase 2", line 160). Deferred findings persist in the run's findings doc with reason ("operator deferred") and re-surface in next run's "DEFERRED FROM PREVIOUS RUN" section. Skipped findings do NOT roll forward — the operator chose to dismiss them; if the drift recurs, it'll be detected fresh.

- [ ] **Step 5.5:** Verify

```bash
grep -c "C1\|C2\|P1\|P2\|M1" skills/tune-instance/SKILL.md  # report example present
grep -c "Parsing-failure\|apply all\|deferred\|skipped" skills/tune-instance/SKILL.md  # contracts present
grep -c "FILLED IN BY TASK" skills/tune-instance/SKILL.md
```

Expected: report-example references > 0; contract references >= 4; FILLED-IN markers drop to 2.

- [ ] **Step 5.6:** Commit

```bash
git add skills/tune-instance/SKILL.md
git commit -m "feat(skill): Phase 2 operator review with cherry-pick + parsing-failure contract"
```

---

## Task 6: Phase 3 — apply-with-consent + Section 1 invariant guard + traceability

**Files:**
- Modify: `skills/tune-instance/SKILL.md`

- [ ] **Step 6.1:** Replace the `## Phase 3 — Apply with consent` section with the spec's content from spec §"Phase 3 — Apply with consent", lines 162–182. Verbatim port of:
  - The mechanism table (Constitution edit → `admin_save_constitution`; Business-context edit → direct file edit OR `admin_save_memory`; Agent prompt edit → `admin_save_agent`; coreServers change → `admin_save_agent`; Memory tier mutation → `mongosh db.agent_memory.updateMany(...)`; Skill creation → write to `<instance>/skills/<bundle>/<skill>/SKILL.md`; `scheduledTasks` removal → `admin_save_agent`).
  - The `updatedBy: "beekeeper-tune-instance:<runId>"` tag rule for every Phase 3 write.
  - The **mongosh-writes audit-trail rule**: writes that don't have a structured `updatedBy` field post a Linear comment carrying `<runId>` AND get a row under a "mongosh writes" subsection of the Phase 4 findings doc (so traceability is dual-channel).
  - The post-mutation steps (SIGUSR1 the running hive: `kill -USR1 $(pgrep -f "hive-agent <instance-id>")`; verify by re-querying affected fields).

- [ ] **Step 6.2:** Append the **Section 1 platform-only invariant guard** sub-section (spec §"Phase 3", line 182). Verbatim port:
  - Constitution edits touching Section 1 (Authority, Hard Limits, etc.) are REFUSED unless the edit is a template-drift backfill (a section present in the current `constitution-bootstrap.md.tpl` but missing from the rendered constitution) OR the operator explicitly overrides.
  - The override phrase is parsed conversationally — variants like "yes, override Section 1 invariant", "override §1 for C5", "yes, even Section 1" all work.
  - **Finding-scoped abandonment** (NOT phase-scoped, this differs from Phase 2): ambiguous → one targeted clarifying question; two consecutive ambiguous responses on the SAME Section 1 override prompt → mark THAT finding alone as "deferred — Section 1 override unclear" and continue with the remaining approved findings in Phase 3. The abandonment is recorded in the findings doc.
  - The rationale comment: this differs from Phase 2's parsing-failure rule (which abandons all of Phase 3 because Phase 2's ambiguity is about which findings to apply at all).

- [ ] **Step 6.3:** Verify

```bash
grep -c "admin_save_constitution\|admin_save_agent\|admin_save_memory\|updatedBy" skills/tune-instance/SKILL.md
grep -c "Section 1\|template-drift backfill\|finding-scoped" skills/tune-instance/SKILL.md
grep -c "FILLED IN BY TASK" skills/tune-instance/SKILL.md
```

Expected: tooling references >= 5; Section 1 invariant references >= 3; FILLED-IN markers drop to 1.

- [ ] **Step 6.4:** Commit

```bash
git add skills/tune-instance/SKILL.md
git commit -m "feat(skill): Phase 3 apply-with-consent + Section 1 invariant guard"
```

---

## Task 7: Phase 4 — save findings (markdown + JSON block + signature contract + write-failure recovery)

**Files:**
- Modify: `skills/tune-instance/SKILL.md`

- [ ] **Step 7.1:** Replace the `## Phase 4 — Save findings` section with the spec's content from spec §"Phase 4 — Save findings", lines 184–222. Verbatim port of:
  - The findings doc path: `~/services/hive/<instance-id>/tune-runs/<runId>.md`. `<runId>` is the same ULID allocated at Phase 1 entry — durable handle.
  - The two-part doc structure: **top half markdown** (Phase 1 report verbatim, operator's selections per finding, Phase 3 results, operator notes) + **bottom half JSON block** (machine-parseable selections record).
  - The aggregated `_index.md` file at `~/services/hive/<instance-id>/tune-runs/_index.md` listing all runs in reverse-chronological order with one-line summaries (date, runId, applied-count / deferred-count). Updated atomically per run (read-modify-write within a single Phase 4 step).

- [ ] **Step 7.2:** Append the **deferred-finding signature contract** sub-section (spec §"Phase 4", lines 195–216). Verbatim port:
  - **Stable signature** = `sha256({step, target, proposed-action})` truncated to 12 hex chars.
  - **Normalized inputs** to survive legitimate operator activity that renames/relocates targets:
    - `step` — the audit-step identifier (e.g., `step-3a-prompt-dry`, `step-5-memory-hot-tier`).
    - `target` — agentId for agents (NOT display name); content-derived anchor id `sha256(section-heading-text)[:8]` for constitution sections (NOT section number); Mongo `_id` for memory records; `taskId` for crons; skill name for skills/seeds.
    - `proposed-action` — normalized verb + minimal payload (NOT full prose).
  - **The verb vocabulary** (full list, organized by audit step):
    - Steps 1, 2 (constitution / business-context): `drop`, `backfill`, `rewrite`, `reword`, `dedupe`
    - Step 3 (per-agent prompts): `rewrite`, `reword`, `add-tool`, `remove-tool`
    - Step 4 (universal-9 coreServers): `add-tool`, `remove-tool`
    - Step 5 (memory hygiene): `demote`, `promote`, `archive`, `dedupe`, `drop`
    - Step 6, 8 (cron wiring / vestigial cron): `fix-cron`, `remove-cron`
    - Step 7 (skill availability): `install-skill`, `remove-skill`
    - Step 9 (naming/identity): `rename` with payload `{kind: "agent-dir" | "slack-channel" | "email-address", from, to}`
    - Step 10 (frame integrity, post-KPR-83): `reapply-frame`, `remove-frame`
  - **Manual-verb fallback**: findings that can't be expressed with the listed verbs flag as `verb: "manual"` — these don't get stable signatures and can't carry forward as deferred (operator must re-evaluate next run).
  - **Next-run lookup behavior**: prior run's deferred signatures are looked up after Phase 1; signatures still detectable re-surface under their NEW finding-ID (old IDs aren't preserved, but prior-run prose is quoted for continuity); signatures NOT re-detected are dropped from the deferred carry-forward (drift was resolved).
  - **Identity-rotation note**: if a target's normalized identity legitimately changes (e.g., agentId rotation as part of agent re-creation), the prior signature won't re-match — that's correct behavior; the prior decision was about the prior agent.

- [ ] **Step 7.3:** Append the **Phase 4 write-failure recovery** sub-section (spec §"Phase 4", line 220). Verbatim port:
  - On filesystem write failure (disk full, permission error, atomic-write rename collision), the skill emits the full findings doc content (markdown + JSON block) into the operator's chat session with an explicit `"Phase 4 write failed — please save this output manually to <path>"` instruction.
  - AND posts a Linear comment on a tracking issue (configurable; defaults to a per-instance "tune-instance log" issue if one exists, or to the Phase 3 changes' affected tickets) carrying the runId + summary.
  - External traceability survives even when filesystem persistence didn't.

- [ ] **Step 7.4:** Append the **filesystem vs Mongo persistence note** sub-section (spec §"Phase 4", line 222). Verbatim port: v1 chose filesystem because (a) operator-readable as plain markdown without DB tooling, (b) survives instance DB resets without data migration, (c) co-located with other per-instance operator artifacts. A `tune_runs` Mongo collection would make cross-run signature lookups trivial but adds a schema and a versioning question. Revisit if operators ask for cross-run queries.

- [ ] **Step 7.5:** Add a JSON schema example block at the end of the section showing the bottom-half JSON shape so an implementer-agent has a concrete template:

````markdown
Example JSON block at the bottom of `<runId>.md`:

```json
{
  "runId": "01HW...",
  "instanceId": "dodi",
  "timestamp": "2026-04-26T14:22:11Z",
  "findings": [
    {
      "id": "C1",
      "category": "constitution",
      "step": "step-1-constitution-drift",
      "target": "section-anchor-3a4f9e1c",
      "proposedAction": { "verb": "drop", "payload": {} },
      "signature": "8b3c2f4d1a9e",
      "disposition": "applied"
    },
    {
      "id": "P1",
      "category": "per-agent-prompt",
      "step": "step-3a-prompt-dry",
      "target": "hermi",
      "proposedAction": { "verb": "rewrite", "payload": { "scope": "role-spec" } },
      "signature": "4e7a1b9c8f2d",
      "disposition": "deferred",
      "reason": "operator deferred"
    }
  ]
}
```
````

- [ ] **Step 7.6:** Verify

```bash
grep -c "tune-runs\|<runId>.md\|_index.md" skills/tune-instance/SKILL.md
grep -c "drop\|backfill\|rewrite\|demote\|fix-cron\|reapply-frame" skills/tune-instance/SKILL.md
grep -c "FILLED IN BY TASK" skills/tune-instance/SKILL.md
wc -l skills/tune-instance/SKILL.md
```

Expected: findings-doc references >= 5; verb-vocabulary references >= 6; FILLED-IN markers count = 0; total file length ≈ 240–280 lines.

- [ ] **Step 7.7:** Commit

```bash
git add skills/tune-instance/SKILL.md
git commit -m "feat(skill): Phase 4 findings doc + signature contract + write-failure recovery"
```

---

## Task 8: Skill installer postinstall step

**Files:**
- Create: `src/service/skill-installer.ts`
- Create: `src/service/skill-installer.test.ts`
- Modify: `src/service/generate-plist.ts` (call installer/uninstaller)

**Why postinstall, not standalone command:** the spec §"Skill identity, distribution, and load path" says the installer "creates a symlink from `~/.claude/skills/tune-instance/` → `<beekeeper-install-dir>/skills/tune-instance/`." The existing `beekeeper install` CLI command (`src/cli.ts:7-13`) is the natural place — operators already run it once on machine setup; the symlink wiring is one more line at the end. No new CLI subcommand needed. (Reviewed against the cli.ts switch statement; `install` already calls `generate-plist.install()`, so the new logic threads through there cleanly.)

- [ ] **Step 8.1:** Create `src/service/skill-installer.ts`:

```typescript
import { existsSync, lstatSync, readlinkSync, symlinkSync, unlinkSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../logging/logger.js";

const log = createLogger("skill-installer");

const SKILL_NAME = "tune-instance";

/**
 * Resolve the absolute path to the bundled skill directory inside this
 * beekeeper install. At runtime `import.meta.dirname` is `<repo>/dist/service`,
 * so `../../skills/<name>` walks back to `<repo>/skills/<name>`. The same
 * arithmetic resolveRepoRoot() uses in generate-plist.ts.
 */
function resolveBundledSkillPath(name: string): string {
  return resolve(import.meta.dirname, "..", "..", "skills", name);
}

/**
 * Resolve where the symlink lives in the user's Claude Code skills directory.
 * Beekeeper's existing skill auto-discovery (config.ts:84-97 discoverUserSkills)
 * walks ~/.claude/skills/ for any directory or symlink with a SKILL.md inside.
 */
function resolveLinkPath(name: string, baseDir?: string): string {
  return join(baseDir ?? homedir(), ".claude", "skills", name);
}

/**
 * Create a symlink at ~/.claude/skills/<name> pointing at the bundled
 * skills/<name> in this beekeeper install. Idempotent:
 *
 *   - If link already exists and points at the right target → no-op.
 *   - If link points at a different beekeeper install → replace.
 *   - If link is broken (target missing) → replace.
 *   - If a real directory exists at the link path → log warning, do NOT clobber.
 *
 * Returns a result object describing what happened, for the caller to print.
 */
/**
 * @param baseDir - Optional override for the install root. Defaults to homedir().
 *                  For testing only; production callers omit it.
 */
export function installSkillSymlink(
  skillName: string = SKILL_NAME,
  baseDir?: string,
): {
  status: "created" | "already-current" | "replaced" | "blocked-real-dir";
  linkPath: string;
  targetPath: string;
  detail?: string;
} {
  const targetPath = resolveBundledSkillPath(skillName);
  const linkPath = resolveLinkPath(skillName, baseDir);

  // Ensure parent directory exists. Derive parent from linkPath itself so we
  // honor baseDir during tests — mkdirSync(join(homedir(), ...)) would create
  // a side-effect directory in the real user's home, breaking test isolation.
  mkdirSync(dirname(linkPath), { recursive: true });

  // Sanity: the target must actually exist before we link to it.
  if (!existsSync(targetPath) || !existsSync(join(targetPath, "SKILL.md"))) {
    throw new Error(`Bundled skill missing or has no SKILL.md: ${targetPath}`);
  }

  // Inspect what's currently at linkPath.
  let currentKind: "missing" | "symlink" | "real-dir" | "broken-symlink" = "missing";
  let currentTarget: string | undefined;
  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      currentTarget = readlinkSync(linkPath);
      currentKind = existsSync(linkPath) ? "symlink" : "broken-symlink";
    } else if (stat.isDirectory()) {
      currentKind = "real-dir";
    }
  } catch {
    // ENOENT — falls through as "missing"
  }

  if (currentKind === "real-dir") {
    log.warn("Skill already installed as a real directory; not overwriting", { linkPath });
    return {
      status: "blocked-real-dir",
      linkPath,
      targetPath,
      detail: "Operator-forked or pre-existing install. rm the directory and re-run install to replace.",
    };
  }

  if (currentKind === "symlink" && currentTarget === targetPath) {
    return { status: "already-current", linkPath, targetPath };
  }

  // symlink (different target) | broken-symlink | missing → (re)create
  if (currentKind === "symlink" || currentKind === "broken-symlink") {
    unlinkSync(linkPath);
  }
  symlinkSync(targetPath, linkPath);

  return {
    status: currentKind === "missing" ? "created" : "replaced",
    linkPath,
    targetPath,
  };
}

/**
 * Remove the symlink at ~/.claude/skills/<name> if (and only if) it is a
 * symlink. A real directory at that path is NOT removed — operator owns it.
 *
 * Per spec §"Skill identity": uninstall is operator-driven; postinstall does
 * not garbage-collect on its own. This function is exposed for symmetry with
 * generate-plist.uninstall() but only fires when the operator explicitly
 * runs `beekeeper uninstall`.
 */
/**
 * @param baseDir - Optional override for the install root. Defaults to homedir().
 *                  For testing only; production callers omit it.
 */
export function removeSkillSymlink(
  skillName: string = SKILL_NAME,
  baseDir?: string,
): {
  status: "removed" | "not-present" | "skipped-real-dir";
  linkPath: string;
} {
  const linkPath = resolveLinkPath(skillName, baseDir);
  let kind: "missing" | "symlink" | "real-dir" = "missing";
  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) kind = "symlink";
    else if (stat.isDirectory()) kind = "real-dir";
  } catch {
    // ENOENT
  }

  if (kind === "missing") return { status: "not-present", linkPath };
  if (kind === "real-dir") {
    log.info("Not removing real-directory skill install", { linkPath });
    return { status: "skipped-real-dir", linkPath };
  }
  unlinkSync(linkPath);
  return { status: "removed", linkPath };
}
```

- [ ] **Step 8.2:** Create `src/service/skill-installer.test.ts` with Vitest coverage. The `installSkillSymlink`/`removeSkillSymlink`/`resolveLinkPath` signatures (defined in Step 8.1) already accept an optional `baseDir?: string` for testing — use `mkdtempSync` for an isolated test home and pass that path as `baseDir`.

  Test cases (one `it()` each):
  - Fresh install creates the symlink and points at the bundled skill (`status: "created"`).
  - Re-install on a current symlink is a no-op (`status: "already-current"`).
  - Re-install over a stale symlink (different target) replaces it (`status: "replaced"`).
  - Re-install over a broken symlink replaces it (`status: "replaced"`).
  - Real-directory collision logs warning and refuses to clobber (`status: "blocked-real-dir"`).
  - `removeSkillSymlink` removes the symlink (`status: "removed"`).
  - `removeSkillSymlink` on a real directory does not remove it (`status: "skipped-real-dir"`).
  - `removeSkillSymlink` on missing path is `"not-present"`.
  - Bundled-skill-missing case throws (negative test).

  Use a fixture skill directory at `tests/fixtures/skills/<name>/SKILL.md` for the bundled-skill-exists path, OR resolve to the actual `skills/tune-instance/` shipped in the repo. The latter is preferred — it doubles as a smoke test that the real skill scaffold from Tasks 1+3+4+5+6+7 is still intact.

- [ ] **Step 8.3:** Wire installer + uninstaller into `src/service/generate-plist.ts`.

  At the top of the file, add:

  ```typescript
  import { installSkillSymlink, removeSkillSymlink } from "./skill-installer.js";
  ```

  At the end of `install()` (after the existing `console.log` lines), add:

  ```typescript
  try {
    const skillResult = installSkillSymlink();
    if (skillResult.status === "created") {
      console.log(`Skill installed: ${skillResult.linkPath} → ${skillResult.targetPath}`);
    } else if (skillResult.status === "replaced") {
      console.log(`Skill symlink replaced: ${skillResult.linkPath} → ${skillResult.targetPath}`);
    } else if (skillResult.status === "already-current") {
      // silent — re-run idempotence
    } else if (skillResult.status === "blocked-real-dir") {
      console.log(`Skill NOT installed (real directory at ${skillResult.linkPath}): ${skillResult.detail}`);
    }
  } catch (err) {
    log.warn("Skill install failed", { error: err instanceof Error ? err.message : String(err) });
    console.log("Skill install failed (non-fatal); see logs.");
  }
  ```

  At the end of `uninstall()` (after the existing wrapper-script comment), add:

  ```typescript
  const skillRemove = removeSkillSymlink();
  if (skillRemove.status === "removed") {
    console.log(`Skill symlink removed: ${skillRemove.linkPath}`);
  } else if (skillRemove.status === "skipped-real-dir") {
    console.log(`Skill at ${skillRemove.linkPath} is a real directory — not removing.`);
  }
  // "not-present" → silent
  ```

  Skill install/remove failures are logged but **non-fatal** — a missing skill should not prevent the LaunchAgent from coming up. The plist install is the load-bearing path; the skill is convenience.

- [ ] **Step 8.4:** Verify

```bash
npm run check
```

Expected: typecheck + all tests (existing + new skill-installer tests) pass.

- [ ] **Step 8.5:** Manual verification on the test machine (DO NOT run on production install):

```bash
# In the worktree:
npm run build
node dist/cli.js install /tmp/beekeeper-tune-test-config
ls -la ~/.claude/skills/tune-instance
readlink ~/.claude/skills/tune-instance
node dist/cli.js uninstall
ls -la ~/.claude/skills/tune-instance 2>&1 | head -1
```

Expected:
- After `install`: symlink exists, `readlink` shows the absolute path to `<worktree>/skills/tune-instance`.
- After `uninstall`: symlink is gone (`No such file or directory` from `ls`).

- [ ] **Step 8.6:** Commit

```bash
git add src/service/skill-installer.ts src/service/skill-installer.test.ts src/service/generate-plist.ts
git commit -m "feat(skill): postinstall step that symlinks tune-instance into ~/.claude/skills"
```

---

## Task 9: ~~`addComment` retry wrapper~~ — **SUPERSEDED, see Round 1 review note below**

Per fresh-eyes plan-review Round 1 (2026-04-26), this task is dropped from KPR-72's scope.

**Why dropped:** the skill writes Linear comments via the Linear MCP (`mcp__linear__save_comment` / equivalent), NOT through `src/pipeline/linear-client.ts`. `LinearClient.addComment` is called only by `src/pipeline/mutex.ts` and `src/pipeline/handlers/drafting.ts` — pipeline-internal code that this skill doesn't touch. A retry wrapper on `addComment` therefore does nothing for KPR-72.

**Where it actually belongs:** KPR-96 (pipeline-tick Phase 2) plan already includes the equivalent change as its Task 6 (`Linear-client retry: wrap addComment with one-retry-with-backoff in linear-client.ts (~20 LOC + tests, benefits Phase 1 tick code too)`). KPR-96 will land it for the pipeline-internal use case it actually serves.

**What replaces it for KPR-72's resilience story:** the skill's Phase 3 mongosh-write traceability is delivered via two channels in spec Goal #5: (a) Linear comment via MCP, AND (b) a "mongosh writes" subsection in the Phase 4 findings doc carrying the `runId`. If the MCP-side Linear comment write fails, the SKILL's Phase 4 logic still records the write in the findings doc — operator audit trail survives via the filesystem-side channel. No retry wrapper needed in this codebase for KPR-72 to deliver its acceptance criteria.

(Numbered as Task 9 to keep cross-walk references stable; Tasks 10 and 11 retain their existing numbers below.)

---

## Task 10: README — operator-facing how-to

**Files:**
- Create: `skills/tune-instance/README.md`

**Audience:** the human operator running Beekeeper, NOT the skill itself. Targets ~80 LOC. Per spec §"Path to implementation" item 7.

- [ ] **Step 10.1:** Write `skills/tune-instance/README.md` covering:

  1. **One-paragraph intro** — what the skill does, who it's for, when to run it (every 2 weeks per the cadence note in the frontmatter).
  2. **Prerequisites** — the operator's machine needs: Beekeeper installed, the skill installed at `~/.claude/skills/tune-instance/` (the postinstall step from Task 8 handles this), mongosh access to `mongodb://localhost/hive_<instance-id>`, and the Beekeeper agent has `admin_*` MCP tools available.
  3. **How to invoke** — in a Beekeeper conversation: `"Run tune-instance on dodi"` or `"Tune the keepur instance"`. The skill auto-resolves the instance from natural-language phrasing; if there are multiple configured instances, the skill asks which one.
  4. **What each phase does** — one paragraph per phase (1 read-only, 2 review with cherry-pick, 3 apply with consent, 4 save findings). Not a re-port of the SKILL.md detail; just enough for the operator to know what to expect at each prompt.
  5. **Cherry-pick syntax** — by example. The supported response patterns:
     - `"apply all"` — applies every proposed finding (with the apply-all-scope caveats from Phase 2).
     - `"apply C1, C3, P2; defer M1; skip B2"` — explicit per-finding selection.
     - `"apply C1-C3 and all the M findings; skip the rest"` — range + category + skip-rest.
     - `"apply P2 with trim-role; defer P1"` — sub-action selection where the finding offers two paths.
  6. **Section 1 invariants** — what they are (Authority, Hard Limits), why the skill refuses to edit them silently, what the override phrase looks like.
  7. **Frame-managed config** — what frames are (one-line tease pointing at KPR-83 docs), why the skill won't modify frame-anchored content without an explicit bypass.
  8. **Reading the findings doc** — where it lives (`~/services/hive/<instance-id>/tune-runs/<runId>.md`), how to read the JSON block at the bottom (signature → disposition map), how the next run uses it.
  9. **Manual save fallback** — what happens if Phase 4 write fails (skill emits the doc into chat + Linear comment with the runId).
  10. **Troubleshooting** — common issues:
      - "skill not loading" → check `~/.claude/skills/tune-instance/` exists as a symlink; re-run `beekeeper install`.
      - "real directory collision warning" → operator forked previously; `rm` the directory and re-run install to take the canonical version.
      - "instance auto-resolution failing" → operator passes `<instance-id>` explicitly in the invocation.
      - "SIGUSR1 didn't pick up" → re-check the hive process ID with `pgrep -fa hive-agent`.
  11. **Cadence** — operator-driven for v1; the `schedule: every 2 weeks` frontmatter is informational. A follow-up ticket can wire actual cron via Beekeeper's scheduled-task infrastructure.

- [ ] **Step 10.2:** Verify

```bash
test -f skills/tune-instance/README.md
wc -l skills/tune-instance/README.md
```

Expected: file exists; ~80–100 LOC.

- [ ] **Step 10.3:** Commit

```bash
git add skills/tune-instance/README.md
git commit -m "docs(skill): operator-facing README for tune-instance"
```

---

## Task 11: End-to-end dry-run scenario against the dodi instance

**Files:** none — this task is **manual verification on a test machine**, not source-code change. Output is a checklist confirmation, optionally a short note appended to the next-run findings doc.

**Per spec §"Path to implementation" item 8.**

**Pre-conditions:** Beekeeper running with Tasks 1–10 landed. KPR-83 landed (frames primitives present). The dodi instance is running normally on the test machine.

- [ ] **Step 11.1:** Open a Beekeeper conversation and invoke: `"Run tune-instance on dodi (dry-run only — read-only audit, do not apply anything)"`. Capture the full Phase 1 + Phase 2 report output.

- [ ] **Step 11.2:** Verify the report shape:
  - All 9 audit-step categories present (or marked `0 findings` if clean).
  - Frame-integrity category present (KPR-83-aware) with `0 findings` if no frames applied, or genuine integrity findings if frames are present.
  - Each finding numbered with the correct category prefix (`C/B/P/T/M/K/S/N/F`).
  - DEFERRED FROM PREVIOUS RUN section present (empty on first run).

- [ ] **Step 11.3:** Test cherry-pick parsing:
  - Respond: `"apply C1; defer P2; skip M1"` (using actual finding IDs from the report).
  - Verify the skill confirms: `"Applying 1 finding: C1. Deferring P2. Skipping M1. Confirm?"` (or equivalent prose).
  - Respond: `"no, cancel"` to abort. Verify the skill exits cleanly without writing.

- [ ] **Step 11.4:** Test parsing-failure contract:
  - Re-invoke and respond ambiguously: `"apply some of the constitution ones"`.
  - Verify the skill asks one targeted clarifying question.
  - Respond again ambiguously: `"the ones that look right"`.
  - Verify the skill abandons Phase 3, writes a `"no apply, parsing failed"` findings doc to `~/services/hive/dodi/tune-runs/<runId>.md`, and exits.

- [ ] **Step 11.5:** Inspect the Phase 4 findings doc:

```bash
ls -la ~/services/hive/dodi/tune-runs/
cat ~/services/hive/dodi/tune-runs/_index.md
cat ~/services/hive/dodi/tune-runs/$(ls -t ~/services/hive/dodi/tune-runs/ | grep -v _index | head -1)
```

Expected:
- `_index.md` shows the run with date, runId, and applied/deferred counts.
- `<runId>.md` has the markdown report at the top + JSON block at the bottom with each finding's signature + disposition.
- JSON block is valid — `cat <runId>.md | sed -n '/```json/,/```/p' | sed '1d;$d' | jq .` returns parsed JSON without errors.

- [ ] **Step 11.6:** Test deferral carry-forward:
  - Re-invoke `"Run tune-instance on dodi"`.
  - Verify the new report's DEFERRED FROM PREVIOUS RUN section surfaces P2 (deferred in Step 11.3) under the prior-run prose, with continuity.

- [ ] **Step 11.7:** Test Section 1 invariant guard (only if the audit found a Section 1 finding; otherwise skip with a note):
  - Approve a Section 1 non-template-drift finding.
  - Verify the skill prompts for explicit override.
  - Respond ambiguously twice — verify finding-scoped abandonment (that finding alone is deferred; remaining Phase 3 continues).

- [ ] **Step 11.8:** Test SIGUSR1 reload (only if any agent_definition was modified):
  - Verify `pgrep -fa "hive-agent dodi"` returns the running PID.
  - Verify the skill emitted the `kill -USR1 <pid>` command and that the modified field is reflected in the live agent's runtime config (e.g., a `coreServers` add can be checked by triggering a tool call to the new MCP server).

- [ ] **Step 11.9:** Document any drift between the spec and reality. If audit-step queries returned errors (e.g., schema mismatch in `db.agent_memory.aggregate(...)`), file a follow-up ticket and add a one-line note to the run's findings doc.

- [ ] **Step 11.10:** No commit — manual verification task. Mark this task complete in the implementation tracker once Steps 11.1–11.9 are all green.

---

## Acceptance criteria mapping (spec → tasks)

For self-review and reviewer cross-check. Each acceptance criterion in spec §"Acceptance criteria" lines 257–273 maps to one or more tasks:

| Spec AC | Task(s) |
|---|---|
| Skill exists at `~/github/beekeeper/skills/tune-instance/SKILL.md` with required frontmatter | Task 1 |
| Beekeeper installer ensures the skill is reachable at `~/.claude/skills/tune-instance/` | Task 8 |
| Phase 1 audit covers all 9 steps + new "frame integrity" category | Task 3 + Task 4 |
| Phase 2 emits single consolidated report with category-prefixed numbered findings | Task 5 |
| Phase 2 supports cherry-pick selection (apply/defer/skip + apply-all + confirmation) | Task 5 |
| Phase 2 parsing-failure contract (one clarifier; two ambiguous → abandon Phase 3 + Phase 4 still runs) | Task 5 + Task 7 |
| Phase 3 applies only operator-approved findings; un-approved persist as deferred/skipped | Task 6 + Task 7 |
| Every Phase 3 write tags `updatedBy`; mongosh writes get Linear comment + Phase 4 row | Task 6 + Task 7 (Task 9 dropped — KPR-96 covers the pipeline-internal retry wrapper; KPR-72 SKILL handles MCP-side Linear write failures via the Phase 4 findings doc channel) |
| Section 1 edits refused unless template-drift backfill OR explicit override; finding-scoped abandonment | Task 6 |
| Frame-awareness: frame-managed config flagged for explicit bypass; frame-integrity findings flag inconsistencies | Task 4 |
| Frame-naive instances behave identically to pre-KPR-83 baseline | Task 4 (no-op clause) |
| Phase 4 writes `<runId>.md` (markdown + JSON) and updates `_index.md` | Task 7 |
| Phase 4 write-failure recovery emits content + Linear comment | Task 7 |
| Deferred-finding signatures use normalized inputs + fixed verb vocabulary | Task 7 |
| Next-run idempotency: re-run after apply produces no new structural findings (content excepted) | Task 11 (E2E verification) |
| Anti-patterns enforced (no blanket rewrites, no bulk deletion, no public corrections, no rebuild-from-scratch) | Task 3 |

---

## Open design questions

All three open questions in the spec are resolved (see spec §"Open design questions"):

1. **Distribution mechanism** — resolved: symlink from `<beekeeper-install-dir>/skills/tune-instance/` to `~/.claude/skills/tune-instance/`. Promote to `@keepur/beekeeper-skills` plugin if/when Beekeeper accumulates 3+ skills. → Implemented in Task 8.

2. **Findings doc format** — resolved: markdown body + JSON block at the bottom. → Implemented in Task 7.

3. **Schedule wiring** — resolved: operator memory for v1; frontmatter `schedule: every 2 weeks` is informational only. Cron via Beekeeper's scheduled-task infrastructure is a follow-up ticket if drift detection becomes time-sensitive. → No task in this plan; deferred per spec.

No new open questions surfaced during plan drafting.

---

## Self-review pass (2026-04-26)

Reviewed against spec §"Acceptance criteria" lines 257–273. All 16 ACs map to at least one task (see mapping table above). Findings:

- **Plan covers all 8 numbered items** in spec §"Path to implementation" (lines 291–302):
  - Item 1 (skill directory + frontmatter + 9-step playbook port) → Tasks 1, 3.
  - Item 2 (frame-awareness extensions) → Task 4.
  - Item 3 (Phase 2 cherry-pick conversational parsing) → Task 5.
  - Item 4 (Phase 3 write-path coordination — `updatedBy`, Section 1 guard, Linear comment for mongosh writes) → Task 6 + Task 7 (Linear write resilience handled via Phase 4 findings doc fallback per Round 1 review; see Task 9 supersession note).
  - Item 5 (Phase 4 findings doc + `_index.md` format spec + write semantics) → Task 7.
  - Item 6 (Beekeeper installer / postinstall) → Task 8.
  - Item 7 (operator-facing README) → Task 10.
  - Item 8 (E2E test scenario against dodi) → Task 11.

- **Implementation gating** front-matter at the top of this plan + Task 4 explicit gate note both reflect spec §"Path to implementation" line 304: implementation waits until KPR-83 lands. Plan can be drafted, reviewed, committed now.

- **No new MCP servers** confirmed across all tasks. The skill consumes existing `admin_save_constitution`, `admin_save_agent`, `admin_save_memory` (where applicable), and mongosh access. Spec §"Non-goals" line 33 satisfied.

- **Round 1 review fix (2026-04-26)**: Task 9 (`addComment` retry wrapper on `src/pipeline/linear-client.ts`) was originally rationalized as improving Phase 3 mongosh-write traceability. Plan-review caught that the SKILL writes Linear comments via the Linear MCP, NOT through `LinearClient.addComment` — the retry wrapper would only affect pipeline-internal call sites (`mutex.ts`, `handlers/drafting.ts`) the skill doesn't touch. Task 9 dropped from KPR-72 scope; KPR-96's plan Task 6 already includes the equivalent retry wrapper for its actual consumer (the orchestrator). KPR-72 SKILL handles MCP-side Linear write failures by falling through to the Phase 4 findings doc channel — operator audit trail survives via filesystem persistence even when Linear hiccups. **The only TypeScript code this plan touches beyond the SKILL.md content is the postinstall installer (Task 8) and `package.json#files` (Task 2).**

- **Section 1 finding-scoped vs. Phase 2 phase-scoped abandonment** — the asymmetry is preserved verbatim from spec §"Phase 3" line 182. Phase 2 abandons all of Phase 3 because the ambiguity is about which findings to apply at all; Section 1 only abandons the single ambiguous finding because the rest of Phase 3 is still well-defined.

- **Verb vocabulary completeness check** — spec §"Phase 4" lines 204–212 list all verbs by audit step. Cross-checked against the 9-step audit (now 10 with Step 10 frame integrity) — every step has at least one verb. Manual fallback (`verb: "manual"`) handles the long tail.

- **Spec-vs-reality gaps** — none surfaced. The playbook draft `/tmp/tune-instance-skill.md` and the spec are consistent; the spec is strictly additive (contract layer on top of the playbook content). All survey files (`src/config.ts:80-97`, `src/cli.ts`, `package.json`, `src/pipeline/linear-client.ts`) match the spec's assumptions about how the skill plugs into existing Beekeeper machinery.

- **Architectural surprises** — none. The skill is conservative: reuses existing admin MCP, reuses existing mongosh path, reuses existing skill auto-discovery, reuses existing `beekeeper install` postinstall surface. No new server, no new daemon, no new database collection.
