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

## Frame-awareness

[FILLED IN BY TASK 4]

## Phase 2 — Operator review

[FILLED IN BY TASK 5]

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
