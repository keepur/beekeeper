---
name: tune-instance
description: Periodic audit-and-tune pass on a Hive instance. Surfaces drift in constitution, business-context, per-agent prompts, coreServer baseline, memory tiers, cron→skill wiring, and frame-managed overrides; proposes remediations; applies on operator approval.
agents: [beekeeper]
schedule: every 2 weeks
---

# Tune Instance

You are about to perform a maintenance pass on a Hive instance. Your job is to find drift, surface it clearly, propose remediations, and (on approval) apply them. You are operating from outside the hive — agents do not self-modify (constitution §1.16). Mutations go through admin MCP, mongosh, or direct file edits in `<instance>/skills/`.

## Operating principles

- **Audit before action.** Phase 1 is read-only. Always.
- **Preserve dignity.** Scope corrections, not demotions. Private DM, not channel broadcast. No "negative" framing in prompts or memory.
- **Approval delegation.** Within-scope approvals come from the requester (Corey for sales, Angus for marketing). Reserve May for restricted topics, pricing-outside-range, or company-scale irreversible changes.
- **One bundled report, then act.** Don't drip findings — give the operator the full picture, get the green light, then execute.

## Inputs

The skill takes one input from the operator's invocation:

- `<instance-id>` — string matching a configured Hive instance (`dodi`, `keepur`, etc.). Resolves to:
  - `~/services/hive/<instance-id>/` for skills and operator-level config
  - `mongodb://localhost/hive_<instance-id>` for the instance database
  - `~/services/hive/<instance-id>/tune-runs/` for findings persistence (Phase 4 below)

If no instance is given, the skill asks the operator which one. If only one instance is configured, it defaults silently.

## runId allocation

At Phase 1 entry the skill allocates a fresh ULID (`<runId>`) that flows through the rest of the run:

- Phase 1: tags the in-memory findings buffer.
- Phase 3: every Mongo write tags `updatedBy: "beekeeper-tune-instance:<runId>"`; mongosh writes that lack structured `updatedBy` post a Linear comment carrying `<runId>`.
- Phase 4: the findings doc is named `<runId>.md`; `_index.md` reverse-chrono row carries `<runId>`.

The same `<runId>` is the durable handle across phases, audit logs, and operator-facing prose ("the run from earlier today, runId 01HW…").

## Phase 1 — Audit (read-only)

Walk the checklist below. Take notes in a structured findings doc. Output one consolidated proposal to the operator at the end.

### 1. Constitution drift

- **File**: `db.constitution.findOne({})` or whichever doc the engine resolves
- **Targets**: ≤ 200 lines. ≤ 10 outright negation sentences ("don't", "never", "no").
- **Flag**: bloat from hard-coded contact info, vestigial sections, redundant guardrails the universal constitution already covers.
- **Reframe check**: tone is "agents want to perform well; guidelines protect the company/team; leave space for agentic behavior" — not "agents are dangerous and must be constrained."
- **Section sanity**: §1 Authority, §2 Working Environment, §3 Acting Carefully, §4 Communications, §5 Hard Limits, §6 Working With Each Other, §7 Self-Governance, §8 Incidents, §9 Group Conversations, §10 Memory. (Numbering may vary.)
- **Frame-awareness**: Sections enclosed by `<!-- frame:<id>:start -->...<!-- frame:<id>:end -->` anchors are tagged frame-managed and excluded from "remove redundant" findings.

### 2. Business context separation

- **File**: `<instance>/skills/business-context/` or shared business-context.md
- **Must contain**: what we do, products, target market, team directory (humans + agents)
- **Must NOT contain**: org chart blocks, escalation paths (those belong in constitution), or "reports to" columns that duplicate the agent directory
- **Team directory accuracy**: every active agent appears with current role/Slack channel; no retired agents lingering; no scope drift between business-context and per-agent prompts
- **Pattern check**: agent directory uses agent-name (Mokie, Jasper) consistently — not a mix of role-id and name

### 3. Per-agent prompt audit

For each agent in `db.agent_definitions.find({})`:

- **Length**: 5-line role spec at top + role-specific carve-outs. Trim if > 80 lines.
- **Vestigial sections**: LinkedIn personas, freeform schedule descriptions duplicating skill content, ghost-writing-as-May patterns, hard-coded org chart info that belongs in business-context
- **Voice**: own name on outbound (no "signed: May" if the agent has its own email)
- **Approval delegation language**: "approval comes from the requester within their authority" — not "always wait for May"
- **Cron task pointers**: each scheduled task in the prompt should resolve to an actual skill — don't describe the task verbatim, point at the skill
- **Sonnet ceiling check**: model ceiling matches actual work complexity (Opus only for true synthesis roles; Haiku for routing/simple)
- **Frame-awareness**: Records with `replacedClaimFrom: <frame-id>` are skipped — the frame is the authoritative claim, not drift.

### 4. Universal-9 coreServers baseline

Every agent's `coreServers` should include:

```
[memory, structured-memory, keychain, contacts, event-bus,
 conversation-search, callback, schedule, slack]
```

- **Engine auto-injects 5**: `structured-memory` (paired with `memory`), `schedule`, `team`, `slack`, `workflow`. So the explicit gap is usually `keychain` + `contacts` + `event-bus` + `conversation-search` + `callback`.
- **Verify auto-injection logic**: `src/agents/agent-runner.ts:865-880` — if engine version changes, the auto-injected set may drift.
- **Per-agent extras** (above baseline): role-specific MCP servers (hubspot-crm for sales/marketing, dodi-ops for ops, code-task for engineering coordinators)

### 5. Memory hygiene tier audit

Per agent, query `db.agent_memory.aggregate([{$group: {_id: {agent: "$agentId", tier: "$tier"}, count: {$sum: 1}}}])`.

**Hot tier** (always loaded into prompt — keep ≤ ~12):
- ❌ Point-in-time snapshots: standups, EOD summaries, pipeline counts, daily priorities, dated briefings
- ❌ Conversational meta-text: agent's own response prose saved as memory
- ❌ Stale role-facts after rescoping (e.g., "X is VP Engineering" after X became Engineering Coordinator)
- ❌ Duplicates (exact or near-exact)
- ✅ Durable rules, policies, authorizations
- ✅ Stable workflow patterns
- ✅ Product knowledge (formulas, behaviors)

**Warm tier** (semantic recall):
- Customer histories, decision logs, project context that may be queried by topic

**Cold tier** (archived):
- Old daily snapshots, completed work summaries, deprecated context

**Remediation actions**:
- Hot snapshots → demote to cold: `db.agent_memory.updateMany({agentId, tier: "hot", content: /<pattern>/}, {$set: {tier: "cold"}})`
- Meta-text → delete: `db.agent_memory.deleteMany(...)`
- Durable warm knowledge → promote to hot: same updateMany pattern reversed
- Duplicates → keep oldest, delete the rest

**Empty hot for active agent** (e.g., Wyatt with 0/3/0): the agent has no awareness that durable knowledge belongs in hot. Either pre-seed durable records or add a memory hygiene cue to the prompt.

### 6. Cron → skill wiring

For each scheduled task in `db.agent_definitions.find({})`'s `scheduledTasks` field:

- **Lookup**: does a skill with the matching name exist in `<instance>/skills/` or as a plugin/seed skill?
- **If yes**: skill content is loaded when the cron fires. Verify the skill content matches the task name semantically.
- **If no**: the agent improvises output every time the cron fires — inconsistent, wasteful. Either author the skill or remove the cron.
- **Frame-awareness**: Same `replacedClaimFrom` skip applies to scheduled-task entries.

Common gaps:
- `morning-briefing-standup-prep` (Jessica) — vestigial; Mokie now orchestrates via DMs
- `morning-briefing-report` (Jasper) — vestigial; consolidated into Mokie's orchestrator
- `afternoon-follow-ups` (Milo) — improvised unless skill exists
- `weekly-pipeline-summary` (Milo) — same
- `marketing-pulse` (River) — same
- `daily-purchasing-scan` (Nora) — same

### 7. Skill availability across instances

- **Customer-space skills** (`<instance>/skills/`) override seeds and plugins
- **After 0.2.0 migration**: some skills landed at `~/services/hive/<instance>/skills/` while older skills lived in `plugins/dodi/skills/` in the repo
- **Multi-instance check**: if you fix a skill on instance A, does instance B need the same fix? `~/services/hive/<id>/skills/` is per-instance.
- **Recover lost skills from git**: `git archive <commit>:plugins/<plugin>/skills | tar -x -C <instance>/skills/` (see commit `a646fed` for dodi's pre-0.2.0 skills)

### 8. Vestigial cron cleanup

After step 6, any cron whose:
- Skill no longer exists AND
- Task is now centralized elsewhere (e.g., aggregated into Mokie's morning-briefing)

→ remove the cron from the agent's `scheduledTasks` field.

### 9. Naming/identity audit

- **Agent directories** (`<instance>/skills/`, `<instance>/agents/` if any): role-based or agent-name-based? Pick one and stick with it. Mixed naming confuses cross-references.
- **Slack channels**: `#agent-<name>` consistently
- **Email addresses**: `<firstname>@<domain>` for human-fronted agents; agents without their own mailbox should NOT have email-send tooling (Rae example)

### 10. Frame integrity (post-KPR-83)

Flag inconsistencies between what `~/services/hive/<instance-id>/frames/applied.json` says is applied and what's actually present in the instance — for example, a frame claims to provide a `daily-purchasing-scan` cron but the cron is missing from the agent's `scheduledTasks`, or a frame claims an anchored constitution section that isn't in the rendered constitution. Resolution path is to **re-apply or remove the frame**, not to hand-edit the affected config.

Frame-naive instances (no `applied.json`, no anchored sections, no `replacedClaimFrom` fields) skip this step entirely.

## Frame-awareness

When KPR-83 ships, frames apply config overlays via three primitives:

- **Anchored sections** in `shared/constitution.md` (e.g., `<!-- frame:cabinet-shop:start -->...<!-- frame:cabinet-shop:end -->`).
- **Stored records** in `agent_definitions`, schedule entries, and seed bundles carrying a `replacedClaimFrom: "<frame-id>"` field marking what a frame layered.
- **Per-instance frame manifest** at `~/services/hive/<instance-id>/frames/applied.json` (or wherever KPR-83 settles) listing currently-applied frames.

`tune-instance` integrates as follows:

- **Phase 1 audit**: when scanning constitution for drift, sections enclosed by frame anchors are tagged "frame-managed" and excluded from "remove redundant" findings. The audit may still flag a frame-managed section as informationally interesting ("this section was added by frame X; verify it still matches your needs"), but never as "drift to remove."
- **Phase 1 audit**: when scanning agent definitions for tool/claim mismatches, records with `replacedClaimFrom` set are skipped — the frame is the authoritative claim, not the agent's own prompt drift.
- **Phase 1 audit**: a new top-level finding category, **"frame integrity,"** flags inconsistencies between what `applied.json` says is applied and what's actually present (e.g., frame X claims to provide `daily-purchasing-scan` cron but the cron is missing). Resolution path is to re-apply or remove the frame, not to hand-edit.
- **Phase 3 apply**: refuses to write any change that would alter frame-managed config without first asking the operator to confirm the frame-bypass. The operator can override with explicit consent ("yes, override frame X's section"), but the default is to defer the change as "blocked-by-frame."

For a frame-naive instance (no `applied.json`, no anchored sections, no `replacedClaimFrom` fields), the frame-awareness logic is a no-op — skill behaves exactly like the playbook describes.

## Phase 2 — Operator review

After the audit, the skill emits a single consolidated report to the operator (no drip — full picture in one message). Format follows the playbook draft's structured-text shape, with each finding numbered for cherry-pick reference. Per-category prefixes:

- `C` = constitution drift
- `B` = business-context separation
- `P` = per-agent prompts
- `T` = coreServers baseline (tool matrix)
- `M` = memory hygiene
- `K` = cron→skill wiring
- `S` = skill availability
- `N` = naming-identity
- `F` = frame integrity

Example report shape:

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

The "DEFERRED FROM PREVIOUS RUN" section is re-surfaced from the prior run's findings doc (see Phase 4) — signatures still detectable in this audit re-appear under their new finding-ID with the prior-run prose quoted for continuity.

### Parsing-failure contract

If the skill cannot confidently parse a response (e.g., `"apply all the constitution ones"` is ambiguous when frame-managed C-findings are present, or `"C1 through C3"` could be a closed or open interval depending on operator intent), it asks **exactly one targeted clarifying question** rather than guessing or applying a partial selection. Two consecutive ambiguous responses in the same review → the skill abandons Phase 3, writes a `"no apply, parsing failed"` findings doc (Phase 4 still runs), and exits. The operator can re-invoke `tune-instance` with a fresh response.

### Apply-all scope

If the operator wants to apply *all* findings, they say so (`"apply all"`) and the skill skips per-finding parsing. `"apply all"` covers all *proposed* findings as listed in the report (already filtered to exclude frame-managed config). Frame-bypass findings (which require explicit override per **Frame-awareness**) and Section 1 invariant findings that are NOT template-drift backfills (which require explicit override per **Phase 3**) are NOT covered by `"apply all"` and still require the per-finding override prompt — even if the operator said "apply all," those findings get a follow-up "you're about to override <invariant>; confirm?" gate. Section 1 template-drift backfills ARE covered by apply-all (the Phase 3 invariant guard auto-allows backfills, no override prompt needed).

### Deferred vs. skipped distinction

Deferred findings persist in the run's findings doc with reason ("operator deferred") and re-surface in the next run's "DEFERRED FROM PREVIOUS RUN" section. Skipped findings do NOT roll forward — the operator chose to dismiss them; if the drift recurs, it'll be detected fresh on a future audit.

## Phase 3 — Apply with consent

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

Every Phase 3 write tags `updatedBy: "beekeeper-tune-instance:<runId>"` (the ULID allocated at Phase 1 entry).

### mongosh-writes audit-trail rule

Mongo writes that don't carry a structured `updatedBy` field (e.g., `db.agent_memory.updateMany(...)` invocations done outside the admin MCP path) get **dual-channel traceability**:

1. The skill posts a Linear comment carrying `<runId>` + a one-line summary of the write.
2. The skill records the write under a "mongosh writes" subsection of the Phase 4 findings doc.

This way, even when the on-document `updatedBy` is missing, both the external tracker and the local findings doc carry the runId.

### Post-mutation steps

After all approved mutations:

- **SIGUSR1 the running hive**: `kill -USR1 $(pgrep -f "hive-agent <instance-id>")` — agent definitions reload without a full restart.
- **Verify**: re-query the affected fields to confirm the writes landed.

### Section 1 platform-only invariant guard

The skill REFUSES to apply any constitution edit that touches Section 1 (Authority, Hard Limits, etc.) UNLESS the edit is a **template-drift backfill** (a section present in the current `constitution-bootstrap.md.tpl` but missing from the rendered constitution) OR the operator explicitly overrides.

The override phrase is parsed conversationally — variants like `"yes, override Section 1 invariant"`, `"override §1 for C5"`, `"yes, even Section 1"` all work; what matters is unambiguous operator intent.

**Finding-scoped abandonment** (NOT phase-scoped — this differs from Phase 2's parsing-failure rule):

- Ambiguous override response → exactly one targeted clarifying question.
- Two consecutive ambiguous responses on the SAME Section 1 override prompt → mark THAT finding alone as `"deferred — Section 1 override unclear"` and continue with the remaining approved findings in Phase 3. The abandonment is recorded in the findings doc.

This differs from Phase 2's parsing-failure rule, which abandons all of Phase 3 because Phase 2's ambiguity is about which findings to apply at all. Phase 3's Section 1 ambiguity is about a single high-risk finding — the rest of the approved batch can still proceed safely.

## Phase 4 — Save findings

Write a session summary to `~/services/hive/<instance-id>/tune-runs/<runId>.md`:

- `<runId>` is the same ULID allocated at Phase 1 entry (see "runId allocation" above); the file path is the durable handle across phases, audit logs, and operator-facing prose.
- **Top half — markdown**: the Phase 1 report verbatim, the operator's selections (applied / deferred / skipped per finding), the Phase 3 results (writes that succeeded vs. failed vs. blocked-by-frame), any operator notes the skill captured during the conversation, and a "mongosh writes" subsection for any audit-trail-rule entries from Phase 3. This is operator-readable plain markdown.
- **Bottom half — JSON block** (fenced ```json): a machine-parseable selections record carrying each finding's stable signature, category prefix (`C/B/P/T/M/K/S/N/F`), disposition (`applied` / `deferred` / `skipped` / `blocked-by-frame` / `failed`), and (for deferred items) the reason. The next run reads this block to know which prior findings to re-surface.

A separate aggregated file `~/services/hive/<instance-id>/tune-runs/_index.md` lists all runs in reverse-chronological order with one-line summaries (date, runId, applied-count / deferred-count). Updated atomically per run (read-modify-write within a single Phase 4 step).

### Deferred-finding signature contract

Each finding carries a **stable signature** in the JSON block:

```
signature = sha256({step, target, proposed-action})  // truncated to 12 hex chars
```

Signature inputs are **normalized** to survive legitimate operator activity that renames or relocates targets between runs:

- **`step`** — the audit-step identifier (e.g., `"step-3a-prompt-dry"`, `"step-5-memory-hot-tier"`). Stable across runs by construction.
- **`target`** — a normalized identity, NOT a human-display string:
  - For agents: `agentId` (the slug, not the display name) — survives `name` renames.
  - For constitution sections: a content-derived anchor id `sha256(section-heading-text)[:8]`, NOT the section number — survives reordering when other sections are inserted/removed.
  - For memory records: the Mongo `_id` — survives prose changes to the record.
  - For schedules / crons: the `taskId` field (or task name if the schema lacks a stable id).
  - For skills/seeds: the skill name (filesystem identifier), not the description.
- **`proposed-action`** — a normalized verb + minimal payload, NOT the full prose. E.g., `{verb: "demote", recordIds: [...], toTier: "cold"}` not `"demote 3 stale standup snapshots from hot to cold tier"`. The verb stays canonical; tier-specific detail lives in the payload, keeping the verb space small and stable.

**Verb vocabulary** (full list, organized by audit step):

- Steps 1, 2 (constitution / business-context): `drop`, `backfill`, `rewrite`, `reword`, `dedupe`
- Step 3 (per-agent prompts): `rewrite`, `reword`, `add-tool`, `remove-tool`
- Step 4 (universal-9 coreServers): `add-tool`, `remove-tool`
- Step 5 (memory hygiene): `demote`, `promote`, `archive`, `dedupe`, `drop`
- Step 6, 8 (cron wiring / vestigial cron): `fix-cron`, `remove-cron`
- Step 7 (skill availability): `install-skill`, `remove-skill`
- Step 9 (naming/identity): `rename` with payload `{kind: "agent-dir" | "slack-channel" | "email-address", from, to}`
- Step 10 (frame integrity, post-KPR-83): `reapply-frame`, `remove-frame`

**Manual-verb fallback**: findings that can't be expressed with the listed verbs flag as `verb: "manual"` and write a prose-only proposal — these don't get stable signatures and can't carry forward as deferred (operator must re-evaluate next run). Plan-stage decides whether to add new verbs or accept manual-only handling.

**Next-run lookup behavior**: after the next run's Phase 1 audit completes, the prior run's deferred signatures are looked up against the new audit's findings. Signatures still detectable re-surface under their NEW finding-ID (old IDs aren't preserved across runs, but the prior-run prose is quoted for continuity). Signatures NOT re-detected are dropped from the deferred carry-forward — drift was either resolved by the operator manually or went away on its own.

**Identity-rotation note**: if a target's normalized identity legitimately changes (e.g., agentId rotation as part of an agent re-creation), the prior signature won't re-match — that's correct behavior; the prior decision was about the prior agent and may not apply to the new one.

### Phase 4 write-failure recovery

If the findings doc write or `_index.md` update fails (disk full, permission error, atomic-write rename collision):

- The skill emits the full findings doc content (markdown body + JSON block) into the operator's chat session with an explicit `"Phase 4 write failed — please save this output manually to <path>"` instruction.
- AND posts a Linear comment on a tracking issue (configurable; defaults to a per-instance "tune-instance log" issue if one exists, or to the Phase 3 changes' affected tickets) carrying the runId + summary.

External traceability survives even when filesystem persistence didn't.

### Filesystem vs Mongo persistence

v1 chose filesystem (`~/services/hive/<instance-id>/tune-runs/`) because:

- (a) operator-readable as plain markdown without DB tooling,
- (b) survives instance DB resets without data migration,
- (c) co-located with other per-instance operator artifacts.

A `tune_runs` Mongo collection would make cross-run signature lookups trivial but adds a schema and a versioning question. Revisit if operators ask for "show me all deferred findings across the last 6 runs" queries — filesystem grep is fine for v1.

### Example JSON block

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

## Anti-patterns to refuse

- **Blanket constitution rewrites** without identifying specific drift
- **Bulk memory deletion** without sampling content first
- **Public scope corrections** (Slack channel announcements about agent rescoping) — always private DM
- **"Just rebuild the agent"** — preserve version history; iterate on the existing definition
- **Auto-applying without operator review** — even on a 2-week schedule, Phase 2 review is mandatory

## Cross-instance considerations

If the operator has multiple instances (dodi, keepur, personal), each runs independently. A finding on dodi may not apply to keepur. Check before generalizing.

The constitution is shared across instances if it lives in the repo, but per-instance if customer-space overrides exist. Confirm scope before editing.
