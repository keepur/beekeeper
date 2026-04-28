# Beekeeper Skill: `tune-instance` — Design Spec

**Date:** 2026-04-26
**Author:** May (CEO) + Mokie (Opus)
**Linear:** KPR-72
**Triggered by:** The 2026-04-25 keepur tuning audit (`docs/specs/2026-04-25-keepur-instance-tuning-analysis.md` in hive repo) revealed four classes of drift on running instances — constitution rot, per-agent prompt boilerplate, tool/claim mismatches, role/tool gaps. KPR-71 fixes the bootstrap path (preventive) so fresh instances ship clean; this spec is the **remedial** companion that audits + repairs already-deployed instances on demand. Existing playbook draft at `/tmp/tune-instance-skill.md` (210 lines, dated 2026-04-25) is the basis — this spec promotes it to canonical and adds the contract layer (cherry-pick apply, frame-awareness, traceability, idempotency, distribution).

## Problem

Running instances accumulate drift over weeks of normal operation:

1. **Constitution rot.** Internal redundancy (multiple sections restating the Risk Levels table), duplication with `business-context.md` (Tools & Systems, Communication Preferences in both), template drift (the engine's `constitution-bootstrap.md.tpl` adds a "Message Delivery" section that never gets backfilled to existing instances).
2. **Per-agent prompt boilerplate.** Three or more agents repeating the same "be agentic / use semantic search / back with data / work closely with May" lines in their `systemPrompt` — content that belongs in the constitution once, not boilerplated per agent.
3. **Tool/claim mismatches.** An agent's `systemPrompt` claims a domain ("lives in GitHub and Linear") but `coreServers`/`delegateServers` don't include the corresponding MCPs. Or the inverse — tools granted that nothing in the prompt exercises.
4. **Tool matrix gaps.** An agent's role implies a tool the agent doesn't have — Alexandria as "Head of Product *and engineering*" with `archetype: software-engineer` but no `github`/`code-task`/`linear` MCPs. She literally can't ship code.

Constitution **§1.16** forbids agents from modifying their own prompts/soul/config; only the platform admin (Beekeeper) can. **DOD-212** says bulk rewrites of `agent_definitions` are high-blast-radius and need a human in the loop. CoS owns onboarding (KPR-71); Beekeeper owns ongoing instance admin. `tune-instance` is the Beekeeper skill that closes the remedial loop.

## Goals

1. **Beekeeper-the-agent invokes `tune-instance` as a skill** within a normal Beekeeper conversation, scoped to one Hive instance per invocation. Frontmatter declares `agents: [beekeeper]`.
2. **Phase model: audit (read-only) → operator review → apply with consent → save findings.** Phase 1 mutates nothing. Phase 3 only writes after explicit operator approval.
3. **Cherry-pick apply.** The operator approves a subset of the proposed findings; un-approved items roll forward to the next run as "deferred." Not all-or-nothing.
4. **Frame-aware** (post-KPR-83). When KPR-83 ships, `tune-instance` honors frame-managed config — anchored constitution sections, schedule/skill/seed records with `replacedClaimFrom`, frame-installed bundles — and never proposes to remove or alter what a frame layered. For a frame-naive instance the awareness is a no-op.
5. **Traceability.** Every Mongo write that has a structured version-history mechanism uses it (`agent_definition_versions` for `agent_definitions`, `memory_versions` for memory documents) tagged with `updatedBy: "beekeeper-tune-instance:<runId>"`. Writes that lack such a mechanism — known gap: memory-tier-only mutations on `db.agent_memory` — are logged out-of-band with the run-id (Linear comment + Phase 4 findings doc entry) so the audit trail still survives, just not in a versioned-document form. The audit-trail goal is delivered; the mechanism varies by collection.
6. **Idempotent.** Re-running `tune-instance` immediately after `--apply` returns clean (zero new findings beyond what the operator deferred). Caveat below.

## Non-goals

- **Auto-tuning without human review.** Phase 2 review is mandatory even on the recurring schedule. The skill never writes without explicit operator confirmation.
- **CLI command.** Beekeeper is a Claude Agent SDK consumer, not a command-line tool. `tune-instance` is an agentic skill loaded into a Beekeeper session, not `beekeeper tune-instance ...` as a subcommand. The ticket's CLI-flavored wording is a misnomer.
- **Cross-instance moves or seed regeneration.** Out of scope. Each instance is audited independently.
- **Replacing Beekeeper's existing audit/admin tools.** `tune-instance` reuses the existing `admin_*` MCP surface (admin_save_constitution, admin_save_agent), mongosh access, and skill/file tooling. No new MCP servers are introduced; this work is wiring + playbook codification.
- **Implementing this work before KPR-83 (Frames) lands.** Spec + plan land now; implementation gates on KPR-83 so frame-awareness can be built in from the start rather than retrofitted.

## Design

### Skill identity, distribution, and load path

The skill ships as a directory `tune-instance/` under the canonical Beekeeper skills location:

```
~/github/beekeeper/skills/tune-instance/
  SKILL.md             # the playbook (frontmatter + 9-step audit + phases)
  README.md            # operator-facing how-to
```

The Beekeeper installer (postinstall step or `beekeeper install` command) creates a **symlink** from `~/.claude/skills/tune-instance/` → `<beekeeper-install-dir>/skills/tune-instance/`. Beekeeper's existing skill auto-discovery (`src/config.ts:84` — `discoverUserSkills`) picks it up as a local plugin.

**Update semantics** (symlink chosen for this reason): when beekeeper version-bumps and ships a newer `tune-instance/`, the symlink target's content updates automatically — next Beekeeper session sees the new skill, no re-install step required. The trade-off is: operator-local edits to the installed copy aren't preserved (because the install location IS the repo location). For operators who want to fork the skill, they remove the symlink and substitute their own directory under `~/.claude/skills/tune-instance/`.

**Install collision.** If `~/.claude/skills/tune-instance/` already exists and is NOT a symlink to the current beekeeper install dir (operator forked previously, prior incompatible install, etc.), postinstall logs a warning (`tune-instance already installed at <path> as a real directory; not overwriting`) and does NOT clobber. Operator can `rm ~/.claude/skills/tune-instance/` and re-run install to take the canonical version, or keep their fork.

**Uninstall** is operator-driven: `rm ~/.claude/skills/tune-instance/` (the symlink only). The beekeeper postinstall does not garbage-collect on its own — uninstalling beekeeper does not remove the symlink, but the symlink dangles harmlessly. `discoverUserSkills` (config.ts:84-97) gates inclusion on `existsSync(join(fullPath, "SKILL.md"))`, which follows symlinks; a broken symlink fails the existsSync check and is silently skipped — confirmed by reading the function.

Frontmatter (matches the existing draft):

```yaml
---
name: tune-instance
description: Periodic audit-and-tune pass on a Hive instance. Surfaces drift in constitution, business-context, per-agent prompts, coreServer baseline, memory tiers, cron→skill wiring, and frame-managed overrides; proposes remediations; applies on operator approval.
agents: [beekeeper]
schedule: every 2 weeks
---
```

The `schedule: every 2 weeks` line is informational documentation of the recommended cadence. Actual recurrence is operator-driven (the operator triggers the skill in conversation when ready). Optional follow-up ticket can wire the cron via Beekeeper's scheduled-task infrastructure if/when warranted.

### Inputs

The skill takes one input from the operator's invocation:

- `<instance-id>` — string matching a configured Hive instance (`dodi`, `keepur`, etc.). Resolves to:
  - `~/services/hive/<instance-id>/` for skills and operator-level config
  - `mongodb://localhost/hive_<instance-id>` for the instance database
  - `~/services/hive/<instance-id>/tune-runs/` for findings persistence (Phase 4 below)

If no instance is given, the skill asks the operator which one. If only one instance is configured, it defaults silently.

### `runId` allocation

At Phase 1 entry the skill allocates a fresh ULID (`<runId>`) that flows through the rest of the run:

- Phase 1: tags the in-memory findings buffer.
- Phase 3: every Mongo write tags `updatedBy: "beekeeper-tune-instance:<runId>"`; mongosh writes that lack structured `updatedBy` post a Linear comment carrying `<runId>`.
- Phase 4: the findings doc is named `<runId>.md`; `_index.md` reverse-chrono row carries `<runId>`.

The same `<runId>` is the durable handle across phases, audit logs, and operator-facing prose ("the run from earlier today, runId 01HW…").

### Phase 1 — Audit (read-only)

The skill walks the 9-step checklist defined in the playbook draft (`/tmp/tune-instance-skill.md`, sections 1–9). Promoted verbatim with the additions below; key steps recapped:

1. **Constitution drift** — bloat (>200 lines), excess negation count, sections that restate the Risk Levels table, sections that duplicate `business-context.md`, missing template-drift sections.
2. **Business-context separation** — must contain product/team/market info, must NOT contain authority/escalation/risk-level content (those belong in constitution).
3. **Per-agent prompt audit** — length (>80 lines flag), DRY violations across agents (boilerplate that belongs in constitution once), voice (own name on outbound), approval-delegation language, cron-pointer-to-skill consistency, model-ceiling sanity.
4. **Universal-9 coreServers baseline** — every agent must have `[memory, structured-memory, keychain, contacts, event-bus, conversation-search, callback, schedule, slack]`. Engine auto-injects 5; the explicit gap is usually `keychain + contacts + event-bus + conversation-search + callback`.
5. **Memory hygiene tier audit** — hot tier ≤ ~12 entries, no point-in-time snapshots / conversational meta / stale role-facts / duplicates; warm for queryable history; cold for archived.
6. **Cron → skill wiring** — every `scheduledTasks` entry resolves to a real skill; un-resolved tasks improvise output every fire (inconsistent + wasteful).
7. **Skill availability across instances** — customer-space skills override seeds + plugins; check the per-instance `skills/` directory matches expectation.
8. **Vestigial cron cleanup** — crons whose skill no longer exists AND whose work has been centralized elsewhere (e.g., aggregated into Mokie's morning-briefing) should be removed.
9. **Naming/identity audit** — agent directories use one convention (role-id OR agent-name, not mixed); Slack channels follow `#agent-<name>`; email addresses follow `<firstname>@<domain>` for human-fronted agents; agents without their own mailbox don't have email-send tooling.
10. **Frame integrity** (added with KPR-83) — flag inconsistencies between what `~/services/hive/<instance-id>/frames/applied.json` says is applied and what's actually present in the instance. Resolution path is to re-apply or remove the frame, not hand-edit. Frame-naive instances skip this step entirely.
11. **Engine-superseded prompt instructions** (added KPR-102) — per-agent prompt instructions that the engine already handles automatically. Detection scans `agent_definitions.systemPrompt` against an in-skill registry of engine-handled behaviors (initial seed: 5 entries covering Slack prefix auto-prepending, markdown→mrkdwn auto-conversion, oversized-message auto-split, auto-threading, error-message auto-wrapping). Findings surface under prefix `E`. Frame-aware (records with `replacedClaimFrom` skipped). Distinct from Step 3 DRY pass: this step finds phrases that contradict engine reality regardless of how many agents have them; a single-agent stale instruction still files a finding.
12. **Seed-tool-claim vs. constitution-rule mismatch** (added KPR-102) — when the constitution carries `"never use X"` or `"only use X for Y"` rules, scan agent prompts AND seed YAMLs for tool advertisements that name X without the scoping caveat. Findings surface under prefix `R`. Frame-aware. Distinct from Step 3 tool/claim audit: that step checks prompt vs. coreServers; this one checks prompt vs. constitution. KPR-97 root cause: Wyatt's seed advertised `Slack MCP — send messages` while the constitution says `"Never use Slack MCP tools to reply to the message you're currently handling"`.

The full step-by-step prose, the example queries, the per-step expected outputs, and the engine-handled-behaviors registry (for Step 11) live in `SKILL.md`.

### Frame-awareness (KPR-83 dependency)

When KPR-83 ships, frames apply config overlays via:
- **Anchored sections** in `shared/constitution.md` (e.g., `<!-- frame:cabinet-shop:start -->...<!-- frame:cabinet-shop:end -->`).
- **Stored records** in `agent_definitions`, schedule entries, and seed bundles carrying a `replacedClaimFrom: "<frame-id>"` field marking what a frame layered.
- **Per-instance frame manifest** at `~/services/hive/<instance-id>/frames/applied.json` (or wherever KPR-83 settles) listing currently-applied frames.

`tune-instance` integrates as follows:

- **Phase 1 audit**: when scanning constitution for drift, sections enclosed by frame anchors are tagged "frame-managed" and excluded from "remove redundant" findings. The audit may still flag a frame-managed section as informationally interesting ("this section was added by frame X; verify it still matches your needs"), but never as "drift to remove."
- **Phase 1 audit**: when scanning agent definitions for tool/claim mismatches, records with `replacedClaimFrom` set are skipped — the frame is the authoritative claim, not the agent's own prompt drift.
- **Phase 1 audit**: a new top-level finding category, **"frame integrity,"** flags inconsistencies between what `applied.json` says is applied and what's actually present (e.g., frame X claims to provide `daily-purchasing-scan` cron but the cron is missing). Resolution path is to re-apply or remove the frame, not to hand-edit.
- **Phase 3 apply**: refuses to write any change that would alter frame-managed config without first asking the operator to confirm the frame-bypass. The operator can override with explicit consent ("yes, override frame X's section"), but the default is to defer the change as "blocked-by-frame."

For a frame-naive instance (no `applied.json`, no anchored sections, no `replacedClaimFrom` fields), the frame-awareness logic is a no-op — skill behaves exactly like the playbook describes.

### Phase 2 — Operator review (cherry-pick gate)

After the audit, the skill emits a single consolidated report to the operator (no drip — full picture in one message). Format follows the playbook draft's structured-text shape, with each finding numbered for cherry-pick reference:

```
TUNE-INSTANCE REPORT: <instance-id>  |  <run-id>  |  <date>

CONSTITUTION DRIFT (5 findings)
  C1. §1.7–1.10 restate Risk Levels table — propose: drop sections
  C2. §2.4 duplicates business-context "Tools & Systems" — propose: drop §2.4
  C3. Missing "Message Delivery" template section — propose: backfill
  ...

PER-AGENT PROMPTS (4 findings)
  P1. Hermi: generic prompt, no Keepur context — propose: rewrite role per template
  P2. Alexandria: prompt claims GitHub/Linear, lacks both MCPs — propose: ADD tools OR TRIM role (operator decides which)
  ...

MEMORY HYGIENE (12 findings)
  M1. Wyatt hot tier: 0 records — propose: pre-seed durable knowledge
  M2. Sam hot tier: 8 stale standup snapshots — propose: demote to cold
  ...

[plus business-context (B), coreServers baseline (T), cron→skill (K), skill availability (S), naming/identity (N)]

FRAME INTEGRITY (0 findings)  [or N if frames applied]

DEFERRED FROM PREVIOUS RUN (3 findings)
  C2 (deferred 2026-04-12 — operator declined; recheck if still applicable)
  ...
```

The operator responds conversationally: `"apply C1, C3, P2-trim-role, M1-M3; defer P1; skip C2"` (or similar). The skill parses the response, confirms the parsed selection (`"applying 6 findings: C1, C3, P2 (trim role), M1, M2, M3. Deferring P1. Skipping C2. Confirm?"`), then proceeds to Phase 3 on confirm.

**Parsing-failure contract.** If the skill cannot confidently parse a response (e.g., `"apply all the constitution ones"` is ambiguous when frame-managed C-findings are present, or `"C1 through C3"` could be a closed or open interval depending on operator intent), it asks **one targeted clarifying question** rather than guessing or applying a partial selection. Two consecutive ambiguous responses in the same review → the skill abandons Phase 3, writes a `"no apply, parsing failed"` findings doc (Phase 4 still runs), and exits. Operator can re-invoke with a fresh response.

If the operator wants to apply *all* findings, they say so (`"apply all"`) and the skill skips per-finding parsing. **Apply-all scope:** `"apply all"` covers all *proposed* findings as listed in the report (already filtered to exclude frame-managed config). Frame-bypass findings (which require explicit override per **Frame-awareness**) and Section 1 invariant findings that are NOT template-drift backfills (which require explicit override per **Phase 3**) are NOT covered by `"apply all"` and still require the per-finding override prompt — even if the operator said "apply all," those findings get a follow-up "you're about to override <invariant>; confirm?" gate. Section 1 template-drift backfills ARE covered by apply-all (the Phase 3 invariant guard auto-allows backfills, no override prompt needed).

**Deferred findings persist** in the run's findings doc with reason ("operator deferred"). The next `tune-instance` run reads the prior run's findings (Phase 4 below) and re-surfaces deferred items in the new report's "DEFERRED FROM PREVIOUS RUN" section. Skipped findings do NOT roll forward (operator chose to dismiss; if drift recurs, it'll be detected fresh).

### Phase 3 — Apply with consent

For each operator-approved finding, the skill executes the appropriate write through the existing tooling:

| Finding type | Mechanism |
|---|---|
| Constitution edit | `admin_save_constitution` MCP tool (already exists; routes through `memory_versions`) |
| Business-context edit | Direct file edit in `<instance>/skills/business-context/` (or via `admin_save_memory` if applicable) |
| Agent prompt edit | `admin_save_agent` MCP tool (already exists; routes through `agent_definition_versions`) |
| `coreServers` change | `admin_save_agent` (same) |
| Memory tier mutation | `mongosh db.agent_memory.updateMany(...)` — no MCP tool exists for tier moves at agent-external scope |
| Skill creation/recovery | Write to `<instance>/skills/<bundle>/<skill>/SKILL.md` |
| `scheduledTasks` removal | `admin_save_agent` with updated `scheduledTasks` array |

Every write tags `updatedBy: "beekeeper-tune-instance:<runId>"` (where `<runId>` is the ULID of this audit run). For mongosh writes that don't have a structured `updatedBy` field, the skill posts a Linear comment referencing the run-id + summary so traceability survives.

After all approved mutations:
- **SIGUSR1 the running hive**: `kill -USR1 $(pgrep -f "hive-agent <instance-id>")` — agent definitions reload without a full restart.
- **Verify**: re-query the affected fields to confirm the writes landed.

**Section 1 platform-only invariant.** The skill REFUSES to apply any constitution edit that touches Section 1 (Authority, Hard Limits, etc.) UNLESS the edit is a template-drift backfill (a section present in the current `constitution-bootstrap.md.tpl` but missing from the rendered constitution). All other Section 1 edits require explicit operator override which the skill flags as a high-risk approval. The override phrase is parsed conversationally — variants like `"yes, override Section 1 invariant"`, `"override §1 for C5"`, `"yes, even Section 1"` all work; what matters is unambiguous operator intent. The parsing-failure rule applies but with **finding-scoped abandonment**, NOT phase-scoped: ambiguous → one targeted clarifying question; two consecutive ambiguous responses on the same Section 1 override prompt → mark THAT finding alone as "deferred — Section 1 override unclear" and continue with the remaining approved findings in Phase 3. The abandonment is recorded in the findings doc. (This differs from Phase 2's parsing-failure rule, which abandons all of Phase 3 because Phase 2's ambiguity is about which findings to apply at all.)

### Phase 4 — Save findings

Write a session summary to `~/services/hive/<instance-id>/tune-runs/<runId>.md`:

- `<runId>` is the same ULID allocated at Phase 1 entry (see "runId allocation" above); the file path is the durable handle.
- Contents:
  - **Top half — markdown**: the Phase 1 report verbatim, the operator's selections (applied / deferred / skipped per finding), the Phase 3 results (writes that succeeded vs. failed vs. blocked-by-frame), and any operator notes the skill captured during the conversation. This is operator-readable.
  - **Bottom half — JSON block** (fenced ```json): a machine-parseable selections record with each finding's stable signature (hash of `{step, target, proposed-action}`), category prefix (C/B/P/T/M/K/S/N/F/E/R), disposition (`applied` / `deferred` / `skipped` / `blocked-by-frame` / `failed`), and (for deferred items) the reason. The next run reads this block to know which prior findings to re-surface.

A separate aggregated file `~/services/hive/<instance-id>/tune-runs/_index.md` lists all runs in reverse-chronological order with one-line summaries (date, runId, applied-count / deferred-count). Updated atomically per run (read-modify-write within a single Phase 4 step).

**Deferred-finding identity across runs.** Each finding carries a stable signature in the JSON block — `sha256({step, target, proposed-action})` truncated to 12 hex chars. The signature inputs are **normalized** to survive legitimate operator activity that renames or relocates targets between runs:

- **`step`** — the audit-step identifier (e.g., `"step-3a-prompt-dry"`, `"step-5-memory-hot-tier"`). Stable across runs by construction.
- **`target`** — a normalized identity, NOT a human-display string:
  - For agents: `agentId` (the slug, not the display name) — survives `name` renames.
  - For constitution sections: a content-derived anchor id (e.g., `sha256(section-heading-text)[:8]`), NOT the section number — survives reordering when other sections are inserted/removed.
  - For memory records: the Mongo `_id` — survives prose changes to the record.
  - For schedules / crons: the `taskId` field (or task name if the schema lacks a stable id).
  - For skills/seeds: the skill name (filesystem identifier), not the description.
- **`proposed-action`** — a normalized action verb + minimal payload, NOT the full prose. E.g., `{verb: "demote", recordIds: [...], toTier: "cold"}` not `"demote 3 stale standup snapshots from hot to cold tier"`. Verb stays canonical (`demote`); tier-specific detail is payload, keeping the verb space small. Verb vocabulary is small and fixed; playbook prose can evolve without breaking signatures. The full list, organized by audit step:
  - Steps 1, 2 (constitution / business-context): `drop`, `backfill`, `rewrite`, `reword`, `dedupe`
  - Step 3 (per-agent prompts): `rewrite`, `reword`, `add-tool`, `remove-tool`
  - Step 4 (universal-9 coreServers): `add-tool`, `remove-tool`
  - Step 5 (memory hygiene): `demote`, `promote`, `archive`, `dedupe`, `drop`
  - Step 6, 8 (cron wiring / vestigial cron): `fix-cron`, `remove-cron`
  - Step 7 (skill availability): `install-skill`, `remove-skill`
  - Step 9 (naming/identity): `rename` (with payload `{kind: "agent-dir" | "slack-channel" | "email-address", from, to}`)
  - Step 10 (frame integrity, post-KPR-83): `reapply-frame`, `remove-frame`
  - Step 11 (engine-superseded, post-KPR-102): `remove-instruction`, `rewrite`
  - Step 12 (rule-mismatch, post-KPR-102): `rewrite`, `remove-tool`, `add-caveat`

  If a finding cannot be expressed with the listed verbs, the skill flags it as `verb: "manual"` and writes the prose-only proposal — these don't get stable signatures and can't carry forward as deferred (operator must re-evaluate next run). Plan-stage decides whether to add new verbs or accept manual-only handling.

The next `tune-instance` run, after running its own Phase 1 audit, looks up the prior run's deferred signatures: any signature still detectable in the new audit re-surfaces in the new report's "DEFERRED FROM PREVIOUS RUN" section (under its **new** finding-ID — old IDs aren't preserved, but the prior-run prose is quoted so the operator can see continuity); signatures NOT re-detected are considered resolved (drift went away on its own, or the operator fixed it manually) and dropped from the deferred carry-forward.

If a target's normalized identity legitimately changes (e.g., agentId rotation as part of an agent re-creation), the prior signature won't re-match — that's correct behavior: the prior decision was about the prior agent and may not apply to the new one.

**Phase 4 write-failure recovery.** If the findings doc write or `_index.md` update fails (disk full, permission error, atomic-write rename collision), the skill emits the full findings doc content (markdown + JSON block) into the operator's chat session with an explicit `"Phase 4 write failed — please save this output manually to <path>"` instruction, AND posts a Linear comment on a tracking issue (configurable; defaults to a per-instance "tune-instance log" issue if one exists, or to the Phase 3 changes' affected tickets) with the runId + summary. External traceability survives even when filesystem persistence didn't.

**Filesystem vs Mongo for findings persistence:** v1 chose filesystem (`~/services/hive/<instance-id>/tune-runs/`) because (a) operator-readable as plain markdown without DB tooling, (b) survives instance DB resets without data migration, (c) co-located with other per-instance operator artifacts. A `tune_runs` Mongo collection would make cross-run signature lookups trivial but adds a schema and a versioning question. Revisit if operators ask for "show me all deferred findings across the last 6 runs" queries — filesystem grep is fine for v1.

### Idempotency

"Re-running `tune-instance` immediately after Phase 3 apply returns clean" means: a fresh audit run posted right after a previous run's apply step **produces no new structural findings beyond what the operator deferred or skipped in the previous run**.

Each audit step is classified as **structural** (drift that's deterministic given the current DB state — fixing it makes the next audit not re-find it) or **content** (per-record judgment that can shift between audits as live activity continues, e.g., new conversations land new hot-tier entries):

| Audit step | Classification |
|---|---|
| 1. Constitution drift (redundancy, template drift, sections that restate Risk Levels) | **Structural** |
| 2. Business-context separation (org chart, escalation paths in wrong place) | **Structural** |
| 3a. Per-agent prompt — length / DRY violations / voice / approval-language / cron-pointers / model ceiling | **Structural** |
| 3b. Per-agent prompt — vestigial content judged by current-truth (e.g., "X is VP Engineering" after rescoping) | **Content** (depends on agent reality at moment of audit) |
| 4. Universal-9 coreServers baseline | **Structural** |
| 5. Memory hygiene tier audit (hot/warm/cold counts, snapshots, meta-text, duplicates) | **Content** (memory turns over with conversation activity) |
| 6. Cron → skill wiring | **Structural** |
| 7. Skill availability across instances | **Structural** |
| 8. Vestigial cron cleanup (skill missing AND work centralized elsewhere) | **Structural** (the "centralized elsewhere" half is operator judgment, but stable across short windows) |
| 9. Naming/identity audit | **Structural** |
| 10. Frame integrity (added with KPR-83) | **Structural** |

The idempotency AC tests against the **structural** subset only. Content findings (step 5 and a slice of 3) may legitimately re-appear on the next run because live activity continues between audits — that's not a violation.

Other caveats:
- **Frame integrity** can shift independently of `tune-instance` (a frame is added/removed between audits); idempotency holds at the moment of audit, not against future operator action.
- **Cron→skill wiring** changes if the operator manually adds a skill or cron between audits; this is not a violation.

### Cross-instance considerations

The skill operates on one instance per invocation. Findings on `dodi` may not apply to `keepur` (different team, different configuration). The skill does NOT generalize a finding from one instance to another. If an operator notices a systemic pattern across instances, they file a ticket — `tune-instance` does not auto-propagate fixes.

The constitution may be shared across instances (if it lives in the engine repo) or per-instance (if customer-space overrides exist). The skill confirms scope before editing constitution content — if the constitution lives in the engine repo and the operator approves an edit, the skill flags that the change affects all instances.

## Acceptance criteria

- [ ] Skill exists at `~/github/beekeeper/skills/tune-instance/SKILL.md` with frontmatter `name`, `description`, `agents: [beekeeper]`, `schedule: every 2 weeks`
- [ ] Beekeeper installer (or postinstall) ensures the skill is reachable at `~/.claude/skills/tune-instance/` so existing skill auto-discovery picks it up
- [ ] Phase 1 audit covers all 12 audit steps (Steps 1–9 baseline from the playbook draft, Step 10 "frame integrity" added with KPR-83, Steps 11–12 "engine-superseded" + "rule-mismatch" added with KPR-102)
- [ ] Phase 2 emits a single consolidated report with numbered findings (per-category prefix: `C/B/P/T/M/K/S/N/F/E/R` for constitution / business-context / per-agent-prompt / tool-matrix (coreServers baseline) / memory / cron→skill / skill-availability / naming-identity / frame-integrity / engine-superseded / rule-mismatch)
- [ ] Phase 2 supports cherry-pick selection (operator response parsed conversationally; "apply all" / "apply X1, X3" / "defer Y2" / "skip Z4" all work); confirmation prompt before Phase 3 begins
- [ ] Phase 2 parsing-failure contract: ambiguous operator response triggers exactly one targeted clarifying question; two consecutive ambiguous responses cause the skill to abandon Phase 3, write a "no apply, parsing failed" findings doc, and exit
- [ ] Phase 3 applies only operator-approved findings; un-approved findings persist as "deferred" or "skipped" in the run's findings doc
- [ ] Every Phase 3 write tags `updatedBy: "beekeeper-tune-instance:<runId>"`; mongosh writes that lack structured `updatedBy` post a Linear comment referencing the run-id AND record each write under a "mongosh writes" subsection of the Phase 4 findings doc (so both audit channels carry the runId)
- [ ] Section 1 constitution edits are refused unless they are template-drift backfills OR the operator explicitly overrides; Section 1 override is finding-scoped (two consecutive ambiguous responses defer that single finding and continue with the rest of Phase 3)
- [ ] Frame-awareness: when frame primitives are present (anchors, `replacedClaimFrom` fields, `applied.json`), the skill does not propose changes to frame-managed config without flagging them as frame-bypass requiring explicit operator override; "frame integrity" findings flag genuine inconsistencies
- [ ] Frame-naive instances behave identically to the pre-KPR-83 baseline (no-op frame-awareness)
- [ ] Phase 4 writes a per-run findings doc at `~/services/hive/<instance-id>/tune-runs/<runId>.md` (markdown body + JSON block carrying signatures/dispositions for next-run programmatic re-surfacing) and updates `_index.md`
- [ ] Phase 4 write-failure recovery: on filesystem write failure, the skill emits the full findings doc content (markdown + JSON) into the operator's chat with a manual-save instruction AND posts a Linear comment with the runId + summary on the configured tracking issue
- [ ] Deferred-finding signatures use normalized inputs (agentId, content-anchor for sections, Mongo `_id` for memory records, taskId for crons, fixed action-verb vocabulary) so legitimate target evolution doesn't silently break deferral continuity
- [ ] Next-run idempotency: a re-run immediately after Phase 3 apply produces no new structural findings (content findings excepted)
- [ ] Anti-patterns enforced: no blanket constitution rewrites without specific drift, no bulk memory deletion without sample, no public scope corrections, no "rebuild the agent" from scratch
- [ ] Phase 1 Step 11 (engine-superseded, KPR-102) ships with at least 3 registry entries seeded; registry is operator-extensible (markdown table format)
- [ ] Phase 1 Step 12 (rule-mismatch, KPR-102) detects constitution `"never use X"` / `"only use X for Y"` patterns and cross-references against agent prompts AND seed YAMLs; records with `replacedClaimFrom` are frame-aware skipped
- [ ] Both new categories surface findings via the existing cherry-pick gate (prefix `E`/`R`); both feed the existing Phase 4 signature contract via the verb-vocabulary additions
- [ ] Re-running the audit against pre-2026-04-27 dodi state would catch KPR-97 (regression: the `slack-prefix-double` registry entry matches all five affected agents; the rule-mismatch detector matches Wyatt's pre-fix seed)

## Coordination with sibling tickets

- **KPR-71** (preventive — bootstrap + CoS onboarding) — companion. KPR-71 prevents drift at instance creation; KPR-72 catches what slipped through. Findings from `tune-instance` runs become input to KPR-71 improvements ("audit keeps finding X — fix in bootstrap").
- **KPR-78** (CoS environment audit) — sibling. KPR-78 asks the meta question "what does CoS need to be effective"; KPR-72 is one of the answers (the remedial half).
- **KPR-79** (engine team-API) — already Ready. The team summary auto-injection from KPR-79 is one of the things KPR-72 audits ("does business-context still have the team table? — drop it; the team API serves it").
- **KPR-83** (Frames) — **dependency**. Implementation of KPR-72 waits until KPR-83 lands; spec + plan can land now with frame-awareness baked in.
- **KPR-96** (pipeline-tick Phase 2) — already Ready. No direct dependency; both are Beekeeper concerns.
- **KPR-97** (Slack-MCP self-echo bug — root cause analysis) — motivating bug for KPR-102's audit additions. KPR-102 codifies the two new audit categories (engine-superseded, rule-mismatch) that would have caught the bug statically.
- **KPR-102** (tune-instance audit additions) — extends Phase 1 with Steps 11 (engine-superseded) and 12 (rule-mismatch); extends Phase 2 prefix table with `E` and `R`; extends Phase 4 verb vocabulary.

## Open design questions

1. ~~Distribution mechanism for the skill~~ — **resolved (Round 2):** symlink from `<beekeeper-install-dir>/skills/tune-instance/` to `~/.claude/skills/tune-instance/`. Promote to a `@keepur/beekeeper-skills` plugin if/when Beekeeper accumulates 3+ skills.

2. ~~Findings doc format — markdown vs JSON~~ — **resolved (Round 1 → 2):** markdown body for operator readability + JSON block at the bottom carrying signatures, dispositions, and reasons for next-run programmatic re-surfacing.

3. **Schedule wiring**. The frontmatter declares `schedule: every 2 weeks` informationally; do we wire actual cron via Beekeeper's scheduled-task infrastructure, or rely on operator memory? Lean: **operator memory for v1** (operator runs the skill manually when ready); add cron in a follow-up ticket if drift detection becomes time-sensitive.

## Path to implementation

Once spec is review-clean → KPR-72 advances to Plan Drafting. Plan covers:

1. Skill directory + frontmatter + 9-step playbook (~250 LOC of markdown ported from `/tmp/tune-instance-skill.md`)
2. Frame-awareness extensions in the playbook (anchor-detection guidance, `replacedClaimFrom` honoring, frame-integrity finding category)
3. Phase 2 cherry-pick conversational parsing — example operator-response patterns + skill-prompt instructions for confirmation
4. Phase 3 write-path coordination — `updatedBy` tagging, Section 1 invariant guard, Linear comment for mongosh writes
5. Phase 4 findings doc + `_index.md` format spec + write semantics
6. Beekeeper installer / postinstall step that ensures the skill is at `~/.claude/skills/tune-instance/` (~40 LOC + tests)
7. README at `skills/tune-instance/README.md` for operator-facing how-to (~80 LOC)
8. End-to-end test scenario: dry-run `tune-instance` against the dodi instance; capture the Phase 2 report; verify cherry-pick parsing + Phase 4 findings persistence

**Implementation gating note:** plan execution waits until KPR-83 (Frames) lands. Spec and plan can be drafted, reviewed, and committed now; the implementer subagent shouldn't pick up the plan until KPR-83 is shipped (so frame primitives — anchors, `replacedClaimFrom`, `applied.json` schema — are real and importable). Linear state for KPR-72 stays at "Ready" with a coordination note pinned to KPR-83 in the dependency field.

Estimated 2 days of focused work after KPR-83 lands and plan-clean.
