# Hive-Baseline Frame Implementation Plan

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan. Each task is self-contained; commit after each.
>
> **STATUS — gated on KPR-83 frames runtime (KPR-84 + KPR-85) shipped to the `KPR-83-frames` epic branch.** Both phases shipped 2026-04-26/27 per `~/.claude/projects/-Users-mokie-github-hive/memory/project_frames.md`. KPR-86 picks up against the epic branch (PR base: `KPR-83-frames`, NOT main, per `~/.claude/projects/-Users-mokie-github-hive/memory/feedback_pr_base_on_epic_branches.md`).

**Goal:** Hand-author the `hive-baseline` frame from the dodi 2026-04-25 tuning session artifacts, place it at `~/.beekeeper/frames/hive-baseline/`, and validate end-to-end against dodi (`--adopt`) and keepur (full `apply`) including the drift dialog and the remove path. Capture refinement findings.

**Architecture:** A new directory `~/.beekeeper/frames/hive-baseline/` holds the frame: a `frame.yaml` manifest, two constitution markdown fragments (`memory.md`, `capabilities.md`), and a skill bundle (`memory-hygiene/skills/memory-hygiene-review/SKILL.md`). The frame's content is **scrubbed-from-dodi**: dodi's constitution v4 + dodi's installed `memory-hygiene-review` skill are the source of truth, with operator-specific references stripped before codification (per `~/.claude/projects/-Users-mokie-github-hive/memory/project_kpr86_brainstorm.md` answer 2). **No new TypeScript code** — the runtime shipped in KPR-84 + KPR-85; this plan is content authoring + integration validation.

**Tech Stack:** Markdown for constitution fragments + skill body. YAML for the manifest. No tests — the runtime's automated coverage is in KPR-85; this phase's validation is operator-driven prep-work per spec § "Validation as prep-work."

**Spec reference:** `docs/specs/2026-04-27-hive-baseline-frame-design.md` (this PR), Linear KPR-86.

**Reference plan style:** `docs/plans/2026-04-26-tune-instance-skill.md` (KPR-72 plan) — same task shape, same commit cadence.

---

## File Structure

### Files to create

| File | Responsibility |
|---|---|
| `~/.beekeeper/frames/hive-baseline/frame.yaml` | Frame manifest. Wires the four asset types (constitution × 2, skill bundle, coreservers add, schedule). |
| `~/.beekeeper/frames/hive-baseline/README.md` | Operator-facing one-pager — what the frame is, why apply it, how to remove. |
| `~/.beekeeper/frames/hive-baseline/constitution/memory.md` | "Manage your memory lifecycle" clause — three-tier model + autoDream awareness + hygiene cadence. Scrubbed from dodi v4. |
| `~/.beekeeper/frames/hive-baseline/constitution/capabilities.md` | "Your Capabilities" clause — check-before-declining tool/access discipline. Scrubbed from dodi v4. |
| `~/.beekeeper/frames/hive-baseline/skills/memory-hygiene/skills/memory-hygiene-review/SKILL.md` | Per-agent weekly memory self-audit playbook. Scrubbed from dodi state. |

### Files NOT created or modified

- No `~/.beekeeper/frames/hive-baseline/prompts/` — the frame ships zero prompt clauses (per spec § "Non-goals").
- No `~/.beekeeper/frames/hive-baseline/memory-seeds/` — the frame ships zero memory seeds.
- No `~/.beekeeper/frames/hive-baseline/hooks/` — the frame ships zero hooks.
- No source code in `~/github/beekeeper/src/` — runtime is already shipped (KPR-84 + KPR-85 on the epic branch).
- No new tests — automated coverage is in KPR-85; this phase is operator-driven validation.

### Data dependency note

The actual prose for `constitution/memory.md`, `constitution/capabilities.md`, and `skills/memory-hygiene/skills/memory-hygiene-review/SKILL.md` is extracted from dodi's running state at plan execution time. Specifically:

- **dodi constitution v4** lives in MongoDB at `db.memory["shared/constitution.md"]` on the dodi instance (`mongodb://localhost/hive_dodi`). Read-only access via `mongosh` is sufficient.
- **dodi `memory-hygiene-review` skill** lives at `~/services/hive/dodi/skills/memory-hygiene/skills/memory-hygiene-review/SKILL.md` (per the dodi 2026-04-25 tuning session install).

If the dodi prose is not accessible from the worktree at plan execution time, the implementer falls back to reconstructing from the design intent in the spec (§ "Asset specifications" topic-scope bullets). The spec captures intent; dodi captures wording. Either source can produce a valid frame.

---

## Task 1: Scrub-pass on dodi constitution v4 → `constitution/memory.md` and `constitution/capabilities.md`

**Files:**
- Create: `~/.beekeeper/frames/hive-baseline/constitution/memory.md`
- Create: `~/.beekeeper/frames/hive-baseline/constitution/capabilities.md`

**Source:** dodi's `db.memory["shared/constitution.md"]` document. Read via `mongosh "mongodb://localhost/hive_dodi" --eval 'db.memory.findOne({_id: "shared/constitution.md"}).content' | less`.

- [ ] **Step 1.1:** Read the dodi constitution and locate the two anchored sections. The anchor markers are `<a id="memory"></a>` and `<a id="capabilities"></a>` per the frames-design spec § "Stable anchor IDs." Each anchor precedes a section heading; the section body extends to the next anchor or the next top-level section break.

```bash
mkdir -p ~/.beekeeper/frames/hive-baseline/constitution
mongosh "mongodb://localhost/hive_dodi" --quiet \
  --eval 'print(db.memory.findOne({_id: "shared/constitution.md"}).content)' \
  > /tmp/dodi-constitution-v4.md
grep -n '<a id=' /tmp/dodi-constitution-v4.md
```

Expected: at least two grep hits — one for `id="memory"`, one for `id="capabilities"`. Note the line numbers; the section bodies extend from each anchor to the next anchor (or section heading at the same level).

- [ ] **Step 1.2:** Extract the `memory` clause body. Copy the prose between `<a id="memory"></a>` and the next anchor / equivalent boundary into a working buffer. Do NOT include the anchor tag itself in the file — the anchor lives on the instance's constitution, not on the frame's fragment (the runtime stitches the anchor and the fragment together at apply time).

- [ ] **Step 1.3:** **Scrub-pass on the `memory` clause.** Apply each rule from spec § "Asset specifications → memory → Scrub-pass items":
  - Replace `DodiHome`, `dodi`, business-name references → "the operator's business" or remove if the sentence still reads naturally.
  - Replace operator names (`May`, `Corey`, `Mike`, `Angus`, `Aaron`, `Angela`, `Lauren`, `Zhitong`, `Mokie`) → role descriptors (e.g., "the CEO," "the operator") or remove.
  - Replace product-specific examples (cabinet ops, designs, jobs, permits) → neutral examples or remove the example entirely.
  - Strip references to dodi-specific MCP servers (`hubspot-crm`, `dodi-ops`, `permits`, `clickup`, `quo`, `resend`) when discussing capabilities; reference only universal-9 servers (`memory`, `structured-memory`, `keychain`, `contacts`, `event-bus`, `conversation-search`, `callback`, `schedule`, `slack`).
  - Preserve the three-tier memory model (hot ≤ ~12, warm queryable, cold archived).
  - Preserve autoDream awareness language.
  - Preserve hygiene cadence reference (weekly self-audit via `memory-hygiene-review`).
  - Preserve the hygiene rules from `~/.claude/projects/-Users-mokie-github-hive/memory/feedback_memory_tier_hygiene.md`: no point-in-time snapshots, no conversational meta-text, no stale role-facts, no duplicates.

  Write the scrubbed prose to `~/.beekeeper/frames/hive-baseline/constitution/memory.md`.

- [ ] **Step 1.4:** Extract + scrub the `capabilities` clause body using the same rules. Topic scope per spec:
  - Check-before-declining tool/access discipline ("I don't have access to X" anti-pattern).
  - Universal-9 expectation: every agent has these tools, the prompt should reflect that, the agent should use them.

  Write to `~/.beekeeper/frames/hive-baseline/constitution/capabilities.md`.

- [ ] **Step 1.5:** Read both files end-to-end and verify NO residual dodi-specific references remain. Use:

```bash
grep -iE 'dodihome|dodi |\bmay\b|corey|angus|aaron|angela|lauren|zhitong|mokie|hubspot|clickup|cabinet|permit|quo|resend' \
  ~/.beekeeper/frames/hive-baseline/constitution/memory.md \
  ~/.beekeeper/frames/hive-baseline/constitution/capabilities.md
```

Expected: zero matches. Any match → re-scrub the offending line.

- [ ] **Step 1.6:** Commit

```bash
cd ~/github/beekeeper  # NOT the frame dir — commits go in the beekeeper repo
# (The frame files live outside the repo at ~/.beekeeper/frames/. Commit the
#  PLAN's progress markers in the beekeeper repo, not the frame files themselves.
#  Frame files are operator-local artifacts. The PR delivers the spec + plan;
#  the frame content is committed to operator local state.)
```

**Note:** The frame files at `~/.beekeeper/frames/hive-baseline/` are operator-local — they are NOT committed to the beekeeper git repo. Each operator has their own `~/.beekeeper/frames/`. The PR for KPR-86 delivers the **spec** and **plan** documents; the frame content is the artifact of executing the plan on an operator's machine. Phase 4+ ships these contents to the registry (`frames.keepur.io`); until then, frame content is reproducible from the spec + plan, not from the repo.

For audit-trail purposes, the implementer keeps a copy of the frame contents in `/tmp/hive-baseline-frame-snapshot-<timestamp>/` and attaches a tarball to the Linear ticket as evidence the artifacts were produced. No git commit for the frame files themselves.

---

## Task 2: Extract `memory-hygiene-review` skill bundle

**Files:**
- Create: `~/.beekeeper/frames/hive-baseline/skills/memory-hygiene/skills/memory-hygiene-review/SKILL.md`

**Source:** `~/services/hive/dodi/skills/memory-hygiene/skills/memory-hygiene-review/SKILL.md` (the dodi-installed skill). If absent, reconstruct from the design intent in spec § "Skill bundle — `memory-hygiene-review`."

- [ ] **Step 2.1:** Locate the dodi-installed skill:

```bash
ls -la ~/services/hive/dodi/skills/memory-hygiene/skills/memory-hygiene-review/SKILL.md
cat ~/services/hive/dodi/skills/memory-hygiene/skills/memory-hygiene-review/SKILL.md > /tmp/dodi-memory-hygiene-review-SKILL.md
```

If the file doesn't exist, fall back to plan Step 2.2 (reconstruct). If it exists, proceed to Step 2.3.

- [ ] **Step 2.2:** **Reconstruct path (only if dodi copy missing).** Author from scratch using the per-agent self-audit pattern. The skill body should:
  - Read the agent's own memory tiers (hot / warm / cold) via `memory_list` and `memory_history` tools.
  - Apply the hygiene checklist (hot ≤ ~12 records, no point-in-time snapshots, no conversational meta-text, no stale role-facts, no duplicates).
  - Propose demotions (hot → warm), archivals (warm → cold), or drops, one at a time.
  - Confirm with the operator before applying any mutation.
  - Output a one-line summary of changes when done.

  Frontmatter must match spec § "Skill bundle — `memory-hygiene-review`":

  ```yaml
  ---
  name: memory-hygiene-review
  description: Weekly self-audit of your own memory tiers. Read your hot tier, apply hygiene rules, propose demotions or drops to keep the tier clean.
  agents: ["*"]
  ---
  ```

- [ ] **Step 2.3:** **Scrub-pass.** Apply the same rules from Task 1.3 — strip dodi-specific examples, operator names, business specifics. The audit checklist itself is universal; only example payloads need scrubbing.

```bash
mkdir -p ~/.beekeeper/frames/hive-baseline/skills/memory-hygiene/skills/memory-hygiene-review
# Edit /tmp/dodi-memory-hygiene-review-SKILL.md (or your reconstructed draft),
# apply scrub rules, then write to the frame path:
cp /tmp/dodi-memory-hygiene-review-SKILL.md \
  ~/.beekeeper/frames/hive-baseline/skills/memory-hygiene/skills/memory-hygiene-review/SKILL.md
```

- [ ] **Step 2.4:** Verify scrub-pass cleanliness:

```bash
grep -iE 'dodihome|dodi |\bmay\b|corey|angus|aaron|angela|lauren|zhitong|mokie|hubspot|clickup|cabinet|permit|quo|resend' \
  ~/.beekeeper/frames/hive-baseline/skills/memory-hygiene/skills/memory-hygiene-review/SKILL.md
```

Expected: zero matches.

- [ ] **Step 2.5:** Verify frontmatter parses (YAML must be well-formed):

```bash
head -10 ~/.beekeeper/frames/hive-baseline/skills/memory-hygiene/skills/memory-hygiene-review/SKILL.md
```

Expected: opens with `---`, has `name`, `description`, `agents`, closes with `---`.

- [ ] **Step 2.6:** No git commit (per Task 1.6 note — frame content is operator-local).

---

## Task 3: Author `frame.yaml` manifest

**Files:**
- Create: `~/.beekeeper/frames/hive-baseline/frame.yaml`
- Create: `~/.beekeeper/frames/hive-baseline/README.md`

- [ ] **Step 3.1:** Write `~/.beekeeper/frames/hive-baseline/frame.yaml` exactly as in spec § "Manifest YAML — full example":

```yaml
name: hive-baseline
version: 1.0.0
description: Universal Hive operational baseline. Memory-tier discipline, capability discipline, the 5 universal-9 coreServers that aren't engine-auto-injected, and the weekly self-audit cadence that keeps the first two from rotting.
author: keepur
license: MIT

targets:
  hive-version: ">=0.2.0"

requires: []
conflicts: []

constitution:
  - anchor: memory
    title: "Manage your memory lifecycle"
    insert: replace-anchor
    file: constitution/memory.md
  - anchor: capabilities
    title: "Your Capabilities"
    insert: replace-anchor
    file: constitution/capabilities.md

skills:
  - bundle: skills/memory-hygiene

coreservers:
  - add: [keychain, contacts, event-bus, conversation-search, callback]
    agents: ["*"]

schedule:
  - task: memory-hygiene-review
    agents: ["*"]
    pattern: stagger
    window: "fri 14:00-17:00 America/Los_Angeles"
    interval: 15m
```

- [ ] **Step 3.2:** Write `~/.beekeeper/frames/hive-baseline/README.md` (~30 lines):
  - One-paragraph intro: what `hive-baseline` is and why apply it.
  - Bullet list of the four asset types and their effect.
  - One paragraph on the staggered-cron pattern and timezone caveat.
  - Apply / audit / remove command examples.
  - Link to the design spec.

- [ ] **Step 3.3:** Verify the manifest parses (the runtime's `manifest-loader.ts` will validate it; this is a pre-flight smoke):

```bash
node -e "console.log(require('yaml').parse(require('fs').readFileSync('$HOME/.beekeeper/frames/hive-baseline/frame.yaml','utf8')))" 2>&1 | head -30
```

Expected: parsed object with `name: 'hive-baseline'`, `constitution: [...]`, `skills: [...]`, `coreservers: [...]`, `schedule: [...]`.

- [ ] **Step 3.4:** No git commit (per Task 1.6 note).

---

## Task 4: Place + verify frame layout

**Files:** none — this is a verification task.

- [ ] **Step 4.1:** Confirm the on-disk layout matches the spec:

```bash
find ~/.beekeeper/frames/hive-baseline -type f | sort
```

Expected output (5 files):

```
~/.beekeeper/frames/hive-baseline/README.md
~/.beekeeper/frames/hive-baseline/constitution/capabilities.md
~/.beekeeper/frames/hive-baseline/constitution/memory.md
~/.beekeeper/frames/hive-baseline/frame.yaml
~/.beekeeper/frames/hive-baseline/skills/memory-hygiene/skills/memory-hygiene-review/SKILL.md
```

- [ ] **Step 4.2:** Confirm the runtime sees the frame:

```bash
cd ~/github/beekeeper
git checkout KPR-83-frames
npm run build
node dist/frames/cli.js list  # or `beekeeper frame list` if installed
```

Expected: `hive-baseline 1.0.0` appears in the listed frames.

- [ ] **Step 4.3:** No git commit.

---

## Task 5: `frame audit` against dodi (pre-adopt sanity check)

**Files:** none — operator-driven verification.

**Pre-conditions:** Tasks 1–4 complete. dodi instance running normally.

- [ ] **Step 5.1:** Run audit pre-adopt:

```bash
cd ~/github/beekeeper && node dist/frames/cli.js audit hive-baseline dodi
```

Expected: audit completes without engine error. Since `hive-baseline` is not yet applied to dodi, audit reports "frame not applied to instance" (or equivalent message per the runtime's CLI shape) — this confirms the runtime sees the frame and the dodi instance, and there's no `applied_frames` record yet.

- [ ] **Step 5.2:** If audit produces an unexpected error (parse failure, anchor-resolution error, missing-instance error), STOP and triage. The frame's manifest should be clean from Task 3; an unexpected error here is either a frame-content bug (re-do the offending task) or a runtime bug (file follow-up ticket per Task 11, do not block the rest of the plan unless it blocks adopt).

- [ ] **Step 5.3:** No git commit.

---

## Task 6: `frame apply --adopt hive-baseline dodi`

**Files:** none — operator-driven verification.

- [ ] **Step 6.1:** Run adopt:

```bash
cd ~/github/beekeeper && node dist/frames/cli.js apply --adopt hive-baseline dodi
```

Expected:
- Resolvability checks pass (anchors `memory` and `capabilities` exist in dodi's constitution; hive-version target satisfied).
- No asset writes (per spec § "Apply-vs-adopt strategy → dodi" and frames-design spec § "Bootstrapping and migration").
- `applied_frames` record created in `mongodb://localhost/hive_dodi` with `_id: "hive-baseline"`, `version: "1.0.0"`, `appliedAt: <now>`, `appliedBy: <operator-string>`.
- No SIGUSR1 (adopt skips reload per frames-design spec § "Apply semantics → `--adopt` short-circuit").

- [ ] **Step 6.2:** Verify the `applied_frames` record:

```bash
mongosh "mongodb://localhost/hive_dodi" --quiet \
  --eval 'printjson(db.applied_frames.findOne({_id: "hive-baseline"}))'
```

Expected: full record with `manifest` snapshot, `resources.constitution.snapshotBefore` populated (current dodi constitution text), `resources.constitution.insertedText.memory` and `.capabilities` populated with the *current* (already-present) text, `resources.coreservers` listing per-agent IDs, `resources.schedule` listing per-agent slot assignments.

- [ ] **Step 6.3:** Confirm dodi continues running normally (sanity):

```bash
ps aux | grep "hive-agent dodi" | grep -v grep
```

Expected: dodi process is up and unchanged (adopt did not SIGUSR1).

- [ ] **Step 6.4:** No git commit.

---

## Task 7: `frame audit hive-baseline dodi` (post-adopt clean)

**Files:** none.

- [ ] **Step 7.1:** Run audit post-adopt:

```bash
cd ~/github/beekeeper && node dist/frames/cli.js audit hive-baseline dodi
```

Expected: zero drift. Snapshot equals current state because adopt staged the current state as the baseline.

- [ ] **Step 7.2:** If audit returns non-zero drift findings, STOP and triage. Possible causes:
  - Adopt didn't capture the exact current text (off-by-one in anchor extraction → file follow-up ticket).
  - Live activity between adopt and audit modified an anchor (re-run audit; if reproducible without intervening activity, follow-up ticket).
  - Schedule slot assignment is non-deterministic between adopt and audit (off-by-one in agent-id sort → follow-up ticket against the runtime).

  Each of these is a runtime refinement candidate per Task 11.

- [ ] **Step 7.3:** No git commit.

---

## Task 8: `frame apply hive-baseline keepur` (full apply)

**Files:** none — operator-driven verification.

**Pre-conditions:** keepur instance running normally. keepur's constitution has `<a id="memory"></a>` and `<a id="capabilities"></a>` anchor markers (operator-managed precondition; if missing, run a one-time anchor-tagging pass before this task — see frames-design spec § "Bootstrapping and migration").

- [ ] **Step 8.1:** Pre-flight check that the anchors exist on keepur:

```bash
mongosh "mongodb://localhost/hive_keepur" --quiet \
  --eval 'print(db.memory.findOne({_id: "shared/constitution.md"}).content)' \
  | grep -E '<a id="(memory|capabilities)">'
```

Expected: at least two matches. If zero, STOP — operator must tag the anchors first (manual edit, or a Beekeeper sub-skill if one exists). Do NOT run the apply against an instance that lacks the anchors; the runtime fails with `MissingAnchorError` and that's working-as-intended.

- [ ] **Step 8.2:** Run full apply:

```bash
cd ~/github/beekeeper && node dist/frames/cli.js apply hive-baseline keepur
```

Expected:
- Resolvability checks pass.
- Pre-apply hook: skipped (frame ships none).
- Asset writes in fixed order (per frames-design spec § "Apply semantics → step 4"):
  1. Skills — `~/services/hive/keepur/skills/memory-hygiene/` populated.
  2. Memory seeds — none in this frame; skipped.
  3. CoreServers — 5 servers added per agent in `db.agent_definitions` on keepur.
  4. Schedule — staggered crons added per agent.
  5. Prompts — none in this frame; skipped.
  6. Constitution — `memory` and `capabilities` clauses written to `db.memory["shared/constitution.md"]` on keepur.
- Application record committed.
- Post-apply hook: skipped (frame ships none).
- SIGUSR1 to keepur (asset writes occurred).

- [ ] **Step 8.3:** Verify all 4 asset types landed correctly:

```bash
# Skill bundle
ls -la ~/services/hive/keepur/skills/memory-hygiene/skills/memory-hygiene-review/SKILL.md

# CoreServers
mongosh "mongodb://localhost/hive_keepur" --quiet \
  --eval 'db.agent_definitions.find({}, {name:1, coreServers:1}).forEach(a => print(a.name, JSON.stringify(a.coreServers)))'

# Schedule
mongosh "mongodb://localhost/hive_keepur" --quiet \
  --eval 'db.agent_definitions.find({"scheduledTasks.task": "memory-hygiene-review"}, {name:1, scheduledTasks:1}).forEach(a => print(a.name, JSON.stringify(a.scheduledTasks.filter(t => t.task === "memory-hygiene-review"))))'

# Constitution
mongosh "mongodb://localhost/hive_keepur" --quiet \
  --eval 'print(db.memory.findOne({_id: "shared/constitution.md"}).content)' \
  | grep -A3 '<a id="memory">'
```

Expected:
- Skill file present.
- Every agent's `coreServers` includes all 5 added servers.
- Every agent has a `memory-hygiene-review` cron with a unique `windowSlot` integer (0..N-1).
- Constitution shows the new `memory` clause prose under the anchor.

- [ ] **Step 8.4:** Verify SIGUSR1 picked up changes:

```bash
# Tail the keepur log briefly; SIGUSR1 should have logged a definition reload.
tail -50 ~/services/hive/keepur/logs/hive.log | grep -iE 'reload|sigusr1|definition'
```

Expected: a reload-related log line within the last few seconds.

- [ ] **Step 8.5:** Run audit post-apply:

```bash
cd ~/github/beekeeper && node dist/frames/cli.js audit hive-baseline keepur
```

Expected: zero drift.

- [ ] **Step 8.6:** No git commit.

---

## Task 9: Drift scenario walkthrough

**Files:** none — operator-driven walkthrough.

**Goal:** exercise the drift dialog UX end-to-end. Inject a known drift, confirm audit detects it, run apply, walk the (a) keep-local, (b) take-frame, (c) merge paths.

- [ ] **Step 9.1:** Inject drift on dodi (NOT keepur — dodi is `--adopt`, keepur is fresh; injecting on dodi exercises the same-version drift dialog described in frames-design spec § "Same-version re-apply"):

```bash
mongosh "mongodb://localhost/hive_dodi" --quiet --eval '
  const doc = db.memory.findOne({_id: "shared/constitution.md"});
  const modified = doc.content.replace(
    /(<a id="capabilities"><\/a>[\s\S]{0,200})/,
    "$1\n\n<!-- KPR-86 drift injection — manual edit -->\n"
  );
  db.memory.updateOne({_id: "shared/constitution.md"}, {$set: {content: modified}});
  print("drift injected");
'
```

(The exact regex depends on dodi's actual constitution content; adjust to insert a small marker line in the `capabilities` anchored section.)

- [ ] **Step 9.2:** Run audit; confirm drift is detected:

```bash
cd ~/github/beekeeper && node dist/frames/cli.js audit hive-baseline dodi
```

Expected: audit reports drift on `constitution:capabilities`. Note the exact finding text for Task 9.6.

- [ ] **Step 9.3:** Run `frame apply hive-baseline dodi` (NOT `--adopt` — this triggers the same-version drift dialog per frames-design spec § "Same-version re-apply"):

```bash
node dist/frames/cli.js apply hive-baseline dodi
```

Expected: drift dialog opens for the `capabilities` resource. The dialog presents (a) keep-local, (b) take-frame, (c) merge, (d) defer options.

- [ ] **Step 9.4:** Walk the **(a) keep-local** path: respond `keep-local` (or `a`). Verify:
  - The injected drift remains in the constitution.
  - `applied_frames.driftAccepted` gains a record with `decision: "keep-local"`.
  - SIGUSR1 fires (or doesn't — confirm against frames-design spec § step 8 behavior; same-version re-apply with a keep-local decision and no other writes should be silent).

- [ ] **Step 9.5:** Re-inject drift (Step 9.1 again, with a different marker so the previous keep-local decision doesn't auto-honor). Run apply again; this time walk the **(b) take-frame** path: respond `take-frame` (or `b`). Verify:
  - The injected drift is removed; the frame's `capabilities` text is restored.
  - `applied_frames.resources.constitution.snapshotBefore` updated.
  - SIGUSR1 fires.

- [ ] **Step 9.6:** Re-inject drift a third time. Run apply; walk the **(c) merge** path: respond `merge` (or `c`). Verify:
  - The runtime (Beekeeper agent session) drafts a merged version, presents it, and asks for confirmation.
  - On confirm, the merged text replaces both the local drift and the frame's text.
  - On reject, the merge is abandoned and the dialog re-prompts with the original options.

- [ ] **Step 9.7:** Walk the **(d) defer** path. Re-inject drift a fourth time. Run apply; respond `defer` (or `d`). Verify:
  - The injected drift remains in the constitution (no write).
  - `applied_frames.driftAccepted` is **NOT** mutated (defer is the null-action path; no decision is recorded so the next audit/apply re-prompts).
  - Re-run audit: the drift finding is still surfaced.

- [ ] **Step 9.8:** Run audit one more time:

```bash
node dist/frames/cli.js audit hive-baseline dodi
```

Expected: zero drift after the merge accepted (or appropriate state for whichever path was last walked).

- [ ] **Step 9.8:** Capture any UX observations (slow drift dialog rendering, ambiguous prompts, missing options, confusing diff display) for Task 11.

- [ ] **Step 9.9:** No git commit.

---

## Task 10: `frame remove hive-baseline keepur`

**Files:** none — operator-driven verification.

- [ ] **Step 10.1:** Run remove:

```bash
cd ~/github/beekeeper && node dist/frames/cli.js remove hive-baseline keepur
```

Expected (per frames-design spec § "Remove semantics"):
- Dependents check passes (no other frames `require: hive-baseline`).
- Skill bundle deleted from `~/services/hive/keepur/skills/memory-hygiene/` (unless modified locally — sha256 check).
- CoreServers stripped per agent — only the 5 servers this frame added are removed; previously-existing entries (and entries added by other applied frames) preserved.
- Schedule entries removed per agent.
- Constitution reverted to pre-apply state (from `resources.constitution.snapshotBefore`).
- `applied_frames` record deleted.
- SIGUSR1 to keepur.

- [ ] **Step 10.2:** Verify each removal:

```bash
# Skill bundle gone
ls ~/services/hive/keepur/skills/memory-hygiene/ 2>&1 | head -3

# CoreServers no longer have the 5 added servers
mongosh "mongodb://localhost/hive_keepur" --quiet \
  --eval 'db.agent_definitions.find({coreServers: {$in: ["keychain","contacts","event-bus","conversation-search","callback"]}}, {name:1, coreServers:1}).forEach(a => print(a.name, JSON.stringify(a.coreServers)))'

# Schedule entries gone
mongosh "mongodb://localhost/hive_keepur" --quiet \
  --eval 'db.agent_definitions.find({"scheduledTasks.task": "memory-hygiene-review"}, {name:1, scheduledTasks:1}).forEach(a => print(a.name))'

# applied_frames record gone
mongosh "mongodb://localhost/hive_keepur" --quiet \
  --eval 'printjson(db.applied_frames.findOne({_id: "hive-baseline"}))'

# Constitution restored
mongosh "mongodb://localhost/hive_keepur" --quiet \
  --eval 'print(db.memory.findOne({_id: "shared/constitution.md"}).content)' \
  | grep -A3 '<a id="memory">'
```

Expected:
- Skill directory absent (or `No such file or directory`).
- Zero agents with the removed coreServers (assuming no other source added them; if some agents legitimately have them from another frame or operator addition, they should remain).
- Zero agents with the `memory-hygiene-review` cron.
- `applied_frames.findOne` returns `null`.
- Constitution shows pre-apply text (or empty section under the anchor if pre-apply state was empty).

- [ ] **Step 10.3:** No git commit.

---

## Task 11: Capture refinement findings

**Files:** none — outputs are Linear follow-up tickets and (optionally) small doc fixes in this PR.

**Goal:** convert the observations from Tasks 5–10 into actionable follow-ups.

- [ ] **Step 11.1:** Compile a list of observations from Tasks 5, 7, 8, 9, 10. Categorize each as:
  - **BLOCKER** — apply / remove / audit failed in a way that breaks the frame's usability. Fix in this PR.
  - **SHOULD-FIX** — runtime behavior is correct but UX / error messages / log output are confusing. Fix in this PR if ≲50 LOC and no design decisions; otherwise file follow-up ticket per `~/.claude/projects/-Users-mokie-github-hive/memory/feedback_pipeline_review_rule.md`.
  - **NICE-TO-HAVE** — minor polish (typo in prose, off-by-one in slot count display, etc.). Fix inline if trivial; skip otherwise.

- [ ] **Step 11.2:** For each follow-up ticket, file via Linear with `pipeline-auto` label and parent-link to KPR-83 (the epic). Spec § "Path to implementation" item 11 covers this.

- [ ] **Step 11.3:** Routing rule for fixes — **spec/plan doc updates roll into THIS PR** (the `KPR-86-hive-baseline-spec-plan` branch); **runtime code changes go to a separate follow-up PR on `KPR-83-frames`**. The implementer running this plan files the runtime followups; the implementer of the next phase picks them up. Doc-only inline fixes (small doc / comment / error-message text in the spec or plan) apply in this worktree and ship as part of Step 11.5's commit.

- [ ] **Step 11.4:** Append a "Refinement findings" section to the spec at `docs/specs/2026-04-27-hive-baseline-frame-design.md` summarizing what was found and where it landed (ticket links, inline-fix commits). Keep it tight (~10–20 lines).

- [ ] **Step 11.5:** Commit the spec update.

```bash
cd ~/github/beekeeper-KPR-86-spec-plan
git add docs/specs/2026-04-27-hive-baseline-frame-design.md
git commit -m "docs(beekeeper): KPR-86 — capture refinement findings from validation"
```

---

## Acceptance criteria mapping (spec → tasks)

For self-review and reviewer cross-check. Each AC in spec § "Acceptance criteria" maps to one or more tasks:

| Spec AC | Task(s) |
|---|---|
| Frame directory exists at `~/.beekeeper/frames/hive-baseline/` with the layout described | Tasks 1, 2, 3, 4 |
| `frame.yaml` matches the manifest in § "Manifest YAML — full example" | Task 3 |
| `constitution/memory.md` and `constitution/capabilities.md` are scrubbed of dodi-specific references | Task 1 |
| `skills/memory-hygiene/skills/memory-hygiene-review/SKILL.md` is scrubbed | Task 2 |
| `frame apply --adopt hive-baseline dodi` succeeds; `applied_frames` record exists; audit clean | Tasks 6, 7 |
| `frame apply hive-baseline keepur` succeeds; all 4 asset types write; SIGUSR1 picks up; audit clean | Task 8 |
| Drift dialog walked end-to-end on injected drift case (a/b/c paths) | Task 9 |
| `frame remove hive-baseline keepur` restores constitution, removes cron, removes skill, deletes record | Task 10 |
| Spec / runtime refinements filed as follow-ups; small fixes inline | Task 11 |

---

## Open design questions

None. Spec is review-clean per § "Open design questions"; plan is purely execution.

---

## Self-review pass (2026-04-27)

Reviewed against spec § "Acceptance criteria." All ACs map to tasks. Findings:

- **No new TypeScript code** confirmed across all tasks. Runtime is shipped (KPR-84 + KPR-85 on `KPR-83-frames` epic branch); plan executes content authoring + validation only.
- **Frame content is operator-local** per Task 1.6 note. The PR delivers spec + plan; frame artifacts at `~/.beekeeper/frames/hive-baseline/` are reproducible from the spec on any operator's machine. Phase 4+ ships them to the registry.
- **Scrub-pass cleanliness** is verified by grep against a fixed wordlist (Task 1.5 + Task 2.4). The wordlist is spec § "Asset specifications → Scrub-pass items" derived; if the implementer spots additional dodi-specific terms during prose review, they extend the list and re-grep.
- **Apply order on keepur** matches frames-design spec § "Apply semantics → step 4" — skills, memory-seeds (skipped), coreservers, schedule, prompts (skipped), constitution. The asset-writer in `src/frames/asset-writer.ts` (epic branch) enforces this order; plan does not need to enumerate it but Step 8.2 sanity-checks the outcome.
- **Drift dialog walkthrough** (Task 9) covers the three operator-decision paths: keep-local, take-frame, merge. The fourth path (defer) is implicitly covered when the dialog re-prompts on the next audit/apply per frames-design spec § "Drift detection."
- **Remove path** (Task 10) verifies all six asset removals plus the `applied_frames` record delete, plus SIGUSR1.
- **Refinement findings task** (Task 11) is the structured way to convert real-world walkthrough observations into follow-up work, per spec § "Coordination with sibling tickets" and Linear ticket § "Integration findings."
- **PR base note** at the top of this plan reflects `feedback_pr_base_on_epic_branches.md` — KPR-86 PR bases on `KPR-83-frames`, not main.
