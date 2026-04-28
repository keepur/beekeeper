# init-instance — Operator Guide

`init-instance` initializes a fresh Hive instance through a Beekeeper conversation. The skill interviews you (the operator), drafts the operator-specific constitution Section 2 + an initial Chief-of-Staff agent profile, applies the platform-shared `hive-baseline` frame, and seeds CoS with a hot-tier memory record so her first conversation already carries your operator context. It runs once per instance, immediately after `bootstrap.sh` provisions the OS-level deps; day-2 changes go through `tune-instance` (KPR-72) or CoS in Slack, NOT this skill.

## Prerequisites

- Beekeeper installed on the operator machine (`beekeeper install` has run).
- Skill reachable at `~/.claude/skills/init-instance/` (the postinstall step symlinks the bundled copy automatically — verify with `readlink ~/.claude/skills/init-instance`).
- `mongosh` available on `$PATH` and the instance DB reachable at `mongodb://localhost/hive_<instance-id>`.
- The Beekeeper agent has `admin_save_constitution`, `admin_save_agent`, `admin_save_memory` MCP tools available, plus the KPR-85 `frame apply` write primitives.
- The `hive-baseline` frame (from KPR-86) is on the machine — without it the skill refuses, since there's nothing to apply.
- `bootstrap.sh` has run successfully: Mongo / Qdrant / Ollama up, instance directory at `~/services/hive/<instance-id>/`.

## How to invoke

In any Beekeeper conversation:

- `Init dodi`
- `Initialize the keepur instance`
- `Run init-instance on <instance-id>`

The skill auto-resolves the instance from natural-language phrasing. If multiple fresh instances exist and the message is ambiguous, it asks which one. If `bootstrap.sh` ran moments before and only one fresh instance is configured, it defaults silently to that one and confirms.

## What each phase does

- **Phase 0 — Pre-flight + state detection.** Calls `beekeeper init-state <id> --json` and branches: `fresh` proceeds; `partial` offers resume vs redo; `completed` refuses unless you say `force re-init <id>`. Phase 0.5 then verifies Mongo / Qdrant / Ollama before the interview so a missing dep fails fast, not mid-Phase-4.
- **Phase 1 — Discover (operator interview).** Eight conversational sections covering you, your operation, your team, comms norms, approval delegation, working environment, CoS shaping, and any agents you want spun up next. The script is a guide, not a checklist — Beekeeper rolls with whatever order you volunteer information in.
- **Phase 2 — Propose.** Three drafts in one consolidated proposal: Section 2 prose (D1), the frame application plan (D2), and the CoS profile draft including soul + systemPrompt + universal-9 coreServers + hot-tier memory seeds (D3). Nothing is written yet.
- **Phase 3 — Operator review.** You respond conversationally — `apply`, `change D1 paragraph 3 to say X`, `defer D3 for now`. Two consecutive ambiguous responses abandon the run without writing anything (state stays `fresh`); init defaults conservative.
- **Phase 4 — Apply.** Six durable steps: 4a render Section 1 from frame, 4b insert Section 2 prose, 4c apply remaining `hive-baseline` assets, 4d render initial CoS agent definition, 4e seed CoS memory records, 4f stamp template version. Each step is committed before the next runs, so a partial failure leaves a coherent intermediate state Phase 0 can resume.
- **Phase 5 — Handoff to CoS.** Writes a hot-tier memory record describing operator context + team roster + comms norms + approval delegation values + the agents you wanted next, then prints a short "next steps" message with the launchctl command and a pointer to send CoS her first Slack message.

## What you'll be asked during the interview

1. Who you are and what authority you hold (sole operator, distributed authority, who else can approve what).
2. What this Hive supports — your operation, industry, scale, customer model.
3. Who's on the human team (names, roles, pronouns, email pattern, reporting structure).
4. Communication norms — Slack channels, email conventions (frame default is "agents send from their own addresses"), response cadence.
5. Approval delegation — who can approve customer-facing comms, what's reserved for you, what's delegable.
6. Working environment — timezone(s), working hours, holidays.
7. Chief-of-Staff shaping — her name (default `chief-of-staff`), voice, proactivity, escalation tolerance, memory tone.
8. Initial agents you want spun up next — names + role sketches (descriptive only; CoS provisions them post-init).

## Frame defaults vs operator-specific values

Beekeeper reads platform-shared content from the `hive-baseline` frame; you fill in only the operator-specific values. The split:

| Topic | Source |
|---|---|
| Constitution Section 1 (Authority, Hard Limits, Risk Levels) | Frame |
| Universal-9 coreServers baseline | Frame |
| 5-line per-agent prompt template | Frame |
| Role→tool registry (which MCPs each archetype gets) | Frame |
| Memory tier discipline (hot ≤ ~12, no point-in-time, no meta) | Frame |
| Approval delegation **structure** (who-approves-what shape) | Frame |
| Approval delegation **values** (which roles map to which scopes for THIS operation) | Operator |
| Constitution Section 2 (team, comms, approval values, environment) | Operator |
| CoS voice / scope / proactivity / memory tone | Operator |

If a question mentions a frame default ("agents send from their own addresses unless you have a specific reason to override"), you can accept the default with a one-word `yes` — Beekeeper will note the choice and move on.

## What gets written at Phase 4

Six durable artifacts, in order:

1. Section 1 of the constitution, rendered from the `hive-baseline` frame into `memory[shared/constitution.md]`.
2. Section 2 prose (your operator-specific content) inserted at the frame's `<!-- section-2:start -->...<!-- section-2:end -->` anchor.
3. The rest of the `hive-baseline` frame's assets — skills, schedules, prompt anchors, memory seeds, coreservers — recorded in `applied_frames.hive-baseline`.
4. The initial CoS agent definition in `agent_definitions.<cos-id>`, with a version row in `agent_definition_versions`.
5. The CoS hot-tier memory seeds in `agent_memory` (operator identity, team roster, comms norms, approval delegation values, the operator-described agent wishlist), all tagged with `seedRunId: <runId>` for traceability.
6. The constitution template version stamp in the constitution doc's metadata, so `tune-instance` (KPR-72) can detect template drift later.

Every Mongo write tags `updatedBy: "beekeeper-init-instance:<runId>"` (or `appliedBy:` for the `applied_frames` record). The audit trail is the tagged docs themselves; init does not write a per-run findings doc (unlike `tune-instance`).

## Idempotency — re-running init

- **First run on a fresh instance** → produces a complete init.
- **Re-run on a partial instance** (Phase 4 mid-failure or a Phase 3 deferred draft) → Phase 0 detects `partial` and offers resume vs redo. Resume re-runs only the missing pieces (you may need to re-answer interview questions for unwritten pieces, since conversation context isn't replayable across sessions). Redo confirms per-artifact destruction (one `y/n` per artifact) before proceeding fresh.
- **Re-run on a completed instance** → refused unless you confirm explicitly with `force re-init <instance-id>`. On confirmation, treated like `partial` with redo selected: per-artifact destruction confirmation, then fresh run.
- **Day-2 changes** (adding agents, editing Section 2, fixing drift) → use `tune-instance` (KPR-72) or ask CoS in Slack. NOT `init-instance`.

## Troubleshooting

- **"Skill not loading"** → check `~/.claude/skills/init-instance/` exists. If it's missing or not a symlink, re-run `beekeeper install`. The postinstall step is idempotent.
- **"Real directory collision warning"** → an operator-forked directory already exists at the link path. Resolve with `rm -rf ~/.claude/skills/init-instance` and re-run `beekeeper install` to take the canonical version, OR keep the fork (the warning is informational).
- **"Frame `hive-baseline` not found"** → install or update Beekeeper to a version that ships KPR-86's frame content, OR fetch the frame from the Keepur registry and re-invoke.
- **"Instance auto-resolution failing"** → pass `<instance-id>` explicitly: `Run init-instance on dodi`.
- **"Phase 4 step failed"** → re-invoke the skill; Phase 0 will detect partial state and offer resume. The error message tells you exactly which step (4a–4f) failed.
- **"CoS doesn't seem to know about my team after init"** → check `agent_memory` records on the CoS agent for the `seedRunId` from your run; if missing, Phase 4 step 4e didn't complete. Re-invoke and resume to fill it in.
- **"Mongo / Qdrant / Ollama not reachable"** → Phase 0.5 catches this before the interview starts. Re-run `bootstrap.sh` and confirm the deps are up before re-invoking.

## What to do after init completes

1. Start the hive service if it isn't already running:

   ```
   launchctl kickstart -k gui/$(id -u)/com.hive.<instance-id>.agent
   ```

2. Send a "hello" message to the seeded CoS in Slack — she's pre-tuned with your operator context and ready to introduce herself, name your team back, and pick up the agent provisioning you described.

3. When you're ready to spin up the agents you mentioned in interview §8, ask CoS in Slack. She has the frame's role→tool registry and your context in memory; she'll provision each agent with the right archetype's coreServers and a 5-line role-spec prompt without needing to re-interview you.
