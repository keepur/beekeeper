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

[FILLED IN BY TASK 6]

## Phase 4 — Save findings

[FILLED IN BY TASK 7]

## Anti-patterns to refuse

- **Blanket constitution rewrites** without identifying specific drift
- **Bulk memory deletion** without sampling content first
- **Public scope corrections** (Slack channel announcements about agent rescoping) — always private DM
- **"Just rebuild the agent"** — preserve version history; iterate on the existing definition
- **Auto-applying without operator review** — even on a 2-week schedule, Phase 2 review is mandatory

## Cross-instance considerations

If the operator has multiple instances (dodi, keepur, personal), each runs independently. A finding on dodi may not apply to keepur. Check before generalizing.

The constitution is shared across instances if it lives in the repo, but per-instance if customer-space overrides exist. Confirm scope before editing.
