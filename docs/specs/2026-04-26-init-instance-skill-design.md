# Beekeeper Skill: `init-instance` — Design Spec

**Date:** 2026-04-26
**Author:** May (CEO) + Mokie (Opus)
**Linear:** KPR-71
**Triggered by:** The 2026-04-25 keepur tuning audit (`docs/specs/2026-04-25-keepur-instance-tuning-analysis.md` in the hive repo) showed that fresh instances ship with a generic constitution, a generic Chief-of-Staff prompt, and no operator context — the CoS is *the* agent driving onboarding, but she bootstraps with no idea who the operator is, what the team looks like, or which agents to spin up. The original Linear ticket framed the fix as "harden the CoS-driven onboarding flow." That misses the load-bearing problem: a generic LLM cannot author a high-quality Section 2 and provision sensible initial agents on her first turn. KPR-71 reframes `hive init` as a **Beekeeper conversation** that authors operator-specific config *before* CoS comes online. CoS gets her first conversation already pre-tuned. KPR-72 (`tune-instance`) is the remedial sibling that fixes drift on running instances; this spec is the **preventive** half.

## Reframe context

The current Linear KPR-71 description (as of 2026-04-26) frames the work as "harden the existing CoS-driven bootstrap → onboarding flow." The reframe (operator decision, 2026-04-26, captured in `~/.claude/projects/-Users-mokie-github-hive/memory/project_kpr71_reframe.md`) settles a different framing:

- **Beekeeper owns `hive init`.** Entry point is conversational — operator says "init dodi" or similar in a Beekeeper session, Beekeeper loads the `init-instance` skill and runs the playbook.
- Beekeeper interviews the operator, then authors:
  - Section 2 of the constitution (operator-specific: team structure, comms norms, approval delegation, working environment).
  - Initial CoS profile (soul + systemPrompt + memory seed + coreServers — universal-9 + role-specific layer).
- **CoS comes online pre-tuned.** Already has operator context in memory. Already knows the team. Already shaped to the actual operation.
- **CoS owns ongoing team management** post-init (per constitution §1.6 — Section 2 ongoing edits, onboarding new team members). KPR-71 is *initial* Section 2 + *initial* CoS only. Not ongoing.

The Linear ticket description should be updated as part of the spec PR (same redirect-note pattern used for KPR-72 and KPR-79). This spec is authoritative.

### Where the original ticket goals land in the reframe

| Original goal | Where it lands in the reframe |
|---|---|
| Clean constitution at bootstrap | Beekeeper renders Section 1 from current template, version-stamps, authors Section 2 from interview |
| CoS Section 2 by reference, not copy | Mostly moot for INITIAL Section 2 (Beekeeper does it). Applies to ongoing CoS edits — uses same discipline |
| CoS provisions agents with role/tool consistency | Beekeeper enforces at initial provisioning; CoS uses same frame-defined registry post-init |
| New agent prompts inherit from constitution | Beekeeper enforces 5-line template at initial provisioning; CoS enforces same template ongoing |
| Template-drift detection | Beekeeper stamps template version into rendered constitution at init; tune-instance (KPR-72) detects drift against frame |

## Problem

A fresh Hive instance, today, looks like:

1. `bootstrap.sh` provisions OS-level deps (Mongo, Ollama, Qdrant, Node 24), creates `~/services/hive/<instance>/`, drops in a generic `constitution.md` rendered from `constitution-bootstrap.md.tpl`, and seeds a generic CoS agent definition.
2. The operator joins the CoS in Slack. CoS introduces herself. CoS asks who the operator is, what the company does, what the team looks like.
3. CoS — as a generic LLM with no operator context — is supposed to elicit Section 2 content, draft it, propose initial agents, and write the agent definitions. She does this on her first conversation, in cloud, with no priors.

This last step is where things break. CoS produces a generic Section 2 ("the team is collaborative, decisions are by consensus..."). She proposes generic agents ("you might want a sales rep, a project manager..."). She gets the role→tool mapping wrong because there's no canonical mapping she can read from. The operator has to course-correct repeatedly, and the artifacts that come out of that conversation are uneven — some good, some still generic. By the time CoS's onboarding is "done," the instance has already accumulated drift.

Constitution **§1.16** forbids agents from modifying their own prompts/soul/config; only the platform admin can. Constitution **§1.6** limits CoS to authoring Section 2. **DOD-212** says bulk admin operations on `agent_definitions` are high-blast-radius and need a human in the loop. Beekeeper is the platform admin (local CLI + agentic skills, direct Mongo access, human in the loop on every invocation). Beekeeper is the natural owner of *initial* Section 2 + *initial* agent provisioning, the same way she's the natural owner of `tune-instance` (KPR-72).

## Goals

1. **Beekeeper-the-agent invokes `init-instance` as a skill** within a normal Beekeeper conversation, scoped to one new (or partial) Hive instance per invocation. Frontmatter declares `agents: [beekeeper]`.
2. **Phase model: discover (operator interview) → propose (Section 2 + frame + CoS profile drafts) → operator-review → apply → handoff.** Phases 1–3 mutate nothing. Phase 4 only writes after explicit operator approval.
3. **Constitution at runtime.** Section 1 + structural conventions come from the frame (`hive-baseline` from KPR-86). Section 2 comes from the operator interview. The constitution is built at runtime during init, not shipped as a static file.
4. **Initial-agent scope = JUST CoS.** Other agents are created post-init by CoS using the same frame's role→tool registry. KPR-71 does not provision an org chart's worth of agents; it bootstraps the agent who provisions the org chart.
5. **`bootstrap.sh` becomes a thin wrapper.** Handles OS-level deps deterministically, then hands off to Beekeeper for the conversational instance config. No inline generic constitution rendering. No inline generic CoS seed.
6. **Memory-seeded handoff to CoS.** Beekeeper writes a hot-tier memory record describing what was just seeded + operator context. CoS's first conversation surfaces the record naturally — no new "first conversation" code path; first-time vs nth-time is just memory contents.
7. **Idempotent on re-init — refuse-by-default with explicit override.** Detect existing instance state. If already initialized, refuse with "already initialized; use `tune-instance` to update or override with explicit confirm."
8. **Failure-recovery via durable artifacts.** Each apply step writes its artifact durably (Section 2 → Mongo, frame → manifest, agent-definition → DB). On re-invoke after a partial run, Beekeeper detects partial state and asks operator: keep partial / redo from scratch.
9. **Frame-aware from the start.** Init applies the `hive-baseline` frame via Phase 2 `frame apply` primitives. The skill does not reimplement asset writes; it composes Phase 2 primitives.

## Non-goals

- **Auto-init without operator interview.** The whole point is that the operator's context is the load-bearing input. The skill never seeds without an interview.
- **Provisioning a full team of agents at init.** Just CoS. The operator can describe a team during the interview — that information becomes memory-seeded context for CoS, not agent definitions.
- **Replacing or competing with `tune-instance` (KPR-72).** They are sibling skills. `init-instance` is preventive (clean fresh instances); `tune-instance` is remedial (fix drift on running instances). Output of `init-instance` should pass `tune-instance` audit on the first run with zero structural findings.
- **Implementing this work before KPR-83 (Frames) Phase 2 + Phase 3 land.** Spec + plan land now; implementation gates on Phase 2 (`frame apply` write primitives) AND Phase 3 (`hive-baseline` frame content).
- **CLI command.** Beekeeper is a Claude Agent SDK consumer, not a command-line tool. `init-instance` is an agentic skill loaded into a Beekeeper session, not `beekeeper init <id>` as a subcommand. The original ticket's CLI-flavored language is a misnomer (same correction made for KPR-72).
- **Ongoing onboarding.** Adding new team members, authoring new Section 2 content for an evolving operation, hiring new agents — those belong to CoS post-init (per constitution §1.6) or to a future `cos:hire-agent` skill. KPR-71 is *initial* only.

## Design

### Skill identity, distribution, and load path

The skill ships as a directory `init-instance/` under the canonical Beekeeper skills location:

```
~/github/beekeeper/skills/init-instance/
  SKILL.md             # the playbook (frontmatter + phases + interview script)
  README.md            # operator-facing how-to
```

The Beekeeper installer (postinstall step or `beekeeper install` command) creates a **symlink** from `~/.claude/skills/init-instance/` → `<beekeeper-install-dir>/skills/init-instance/`. Beekeeper's existing skill auto-discovery (`src/config.ts:84` — `discoverUserSkills`) picks it up as a local plugin. Same pattern as `tune-instance` (see `~/github/beekeeper/docs/specs/2026-04-26-tune-instance-skill-design.md` § "Skill identity, distribution, and load path"); refer there for the install-collision, symlink-update, and uninstall semantics — they apply unchanged.

Frontmatter:

```yaml
---
name: init-instance
description: Initialize a fresh Hive instance via Beekeeper conversation. Interviews the operator, authors constitution Section 2, applies the hive-baseline frame, and seeds an operator-specific Chief-of-Staff agent. Hands off to CoS with operator context in memory.
agents: [beekeeper]
---
```

No `schedule:` — this is a one-shot per instance, not a recurring skill.

### Inputs

The skill takes one input from the operator's invocation:

- `<instance-id>` — string matching a configured Hive instance (the one `bootstrap.sh` just provisioned, or one the operator names freshly). Resolves to:
  - `~/services/hive/<instance-id>/` for skills, frames, and operator-level config
  - `mongodb://localhost/hive_<instance-id>` for the instance database

If no instance is given, the skill asks the operator. If `bootstrap.sh` ran moments before and only one fresh instance exists, the skill defaults silently to that one and confirms.

### `runId` allocation

At Phase 1 entry the skill allocates a fresh ULID (`<runId>`) that flows through the rest of the run:

- Phase 1: tags the in-memory interview transcript.
- Phase 4: every Mongo write tags `updatedBy: "beekeeper-init-instance:<runId>"`; the seeded CoS memory record carries `seedRunId: <runId>` for traceability.
- Phase 5: the handoff memory record references `<runId>` so future Beekeeper or CoS introspection can trace back to "this is what was seeded at init."

### Phase 0 — Pre-flight (instance-state detection)

Before Phase 1 starts, the skill calls a shared primitive `detectInstanceState()` (defined below) and branches:

- **`fresh`** → proceed to Phase 1 normally.
- **`partial`** → surface the detected partial state to the operator: which artifacts are present (Section 2 written? frame manifest? CoS in `agent_definitions`?), which are missing. Ask: "this instance was partially initialized at <appliedAt of last write>. Keep partial state and resume from where init left off, or redo from scratch?"
  - **Resume** → skill re-runs Phase 1 interview only for the pieces that aren't durable yet (e.g., if Section 2 was written but CoS wasn't seeded, re-ask the CoS-shaping questions). Conversation context isn't replayable across sessions; only artifacts are durable, so the operator may re-answer some questions.
  - **Redo from scratch** → skill removes existing partial artifacts (with operator confirmation per artifact, since this is destructive) and proceeds to Phase 1 fresh.
- **`completed`** → refuse with: "instance `<id>` is already initialized (Section 2 written, frame applied, CoS seeded, last init at <appliedAt>). To update Section 2, hire new agents, or fix drift, use the `tune-instance` skill (KPR-72) or a future `cos:hire-agent` skill. To re-init from scratch anyway, confirm explicitly with `force re-init <instance-id>`."
  - On explicit `force re-init` confirmation, the skill behaves as if the state were `partial` with `redo from scratch` selected.

#### `detectInstanceState()` — shared primitive

Used by both Phase 0 idempotency (above) and Phase 4 mid-run resume detection (below). Single implementation, used twice, so the two code paths cannot disagree about what "initialized" means.

**Inputs:**
- `instanceId: string` — the instance slug.
- `servicePath: string` — resolved to `~/services/hive/<instanceId>/`.
- `mongoUri: string` — resolved to `mongodb://localhost/hive_<instanceId>`.

**Returns:** `"fresh" | "partial" | "completed"` plus a structured `detail` object listing which artifacts are present and which are missing.

```typescript
type InstanceState = {
  state: "fresh" | "partial" | "completed";
  detail: {
    section2Written: boolean;        // shared/business-context.md OR equivalent Mongo doc has operator-authored Section 2
    frameApplied: boolean;           // applied_frames collection has hive-baseline record
    cosSeeded: boolean;              // agent_definitions has chief-of-staff (or operator-renamed equivalent) with non-default systemPrompt
    handoffMemoryWritten: boolean;   // agent_memory has the Phase 5 handoff record for the CoS agent
    lastInitRunId: string | null;    // ULID from prior init run if any artifact carries one
    lastInitAppliedAt: Date | null;
  };
};
```

**Decision rule:**
- All four detail booleans `true` → `completed`.
- All four `false` → `fresh`.
- Any other combination → `partial`.

The `lastInitRunId` and `lastInitAppliedAt` fields are best-effort introspection (read from the most recent `applied_frames` record's `appliedBy` ULID parsing, or from the `seedRunId` field on the handoff memory record). If they can't be resolved, `null` — Phase 0's prose to the operator just omits the timestamp.

Implementation lives in `src/init/detect-instance-state.ts` (or wherever the plan stage settles); spec mandates that both Phase 0 and Phase 4 use it via the same import, not parallel ad-hoc checks.

### Phase 1 — Discover (operator interview)

Beekeeper opens a structured conversation with the operator. The interview produces three outputs, written in memory only at this phase:

1. **Section 2 raw notes** — operator's answers to the interview questions, ready to be drafted into constitution Section 2 prose in Phase 2.
2. **CoS shaping notes** — operator's preferences about how the CoS should behave: voice/tone, working hours, escalation tolerance, how proactive vs reactive she should be, what topics route to operator vs handle autonomously.
3. **Initial agents the operator describes** — names + role sketches. NOT provisioned in Phase 4 (per non-goals); written to the handoff memory record so CoS knows what the operator wants to spin up next.

#### Interview script

Beekeeper asks the questions below. Where the frame supplies a default (and the operator can accept "use the frame default"), Beekeeper says so explicitly so the operator knows what they're agreeing to.

**1. Operator identity and authority** *(operator-specific; no frame default)*
- Who are you? (name, role, pronouns)
- Are you the sole authority for this instance, or is authority distributed?
- If distributed: who else has approval authority and over what scope?

**2. Company / operation context** *(operator-specific)*
- What does this instance support? (the company, the team, the operation it runs)
- One-paragraph "what we do" — Beekeeper drafts a candidate, operator edits.
- Industry, scale, customer model (B2B / B2C / internal / mixed).

**3. Team structure** *(operator-specific)*
- Who's on the human team? (names, roles, pronouns, email address pattern)
- Reporting structure — flat, hierarchical, hybrid?
- Any human team members the agents should know to escalate to or coordinate with?

**4. Communication norms** *(operator-specific)*
- Slack channel conventions (e.g., `#agent-<name>`, `#team`, `#announcements`).
- Email norms — agents send from their own addresses (frame default per `hive-baseline` §agents-use-own-name) or ghost-write as the operator? Confirm frame default unless operator has a specific reason to override.
- Response cadence expectation — agents respond immediately, batched, business hours only?

**5. Approval delegation** *(operator-specific; frame supplies the *shape*, operator fills the values)*
- Who can approve customer-facing comms? (frame default: requester within their authority; operator confirms or restricts).
- What's reserved for the operator (you) vs delegable to a manager (Corey-equivalent, or N/A for this operation)?
- Pricing-outside-range, irreversible company-scale decisions — frame default reserves these to operator; confirm.

**6. Working environment** *(operator-specific)*
- Timezone(s) — primary operator timezone, team timezones if relevant.
- Working hours — when should agents default to "ask before doing"?
- Holidays / blackout windows — anything baseline?

**7. Chief-of-Staff shaping** *(CoS-specific; frame supplies role/tool defaults, operator fills voice/scope)*
- Name for the CoS (default: `chief-of-staff` agent ID; display name operator's choice).
- Voice/tone — formal, casual, dry, warm?
- How proactive — wait for operator to ask, or surface signals unprompted?
- What topics route to operator immediately vs handle autonomously? (frame supplies a default split — high-stakes / pricing / customer-facing-irreversible to operator; low-stakes ops / routing / scheduling autonomous.)
- Memory tone — should CoS write memory in operator's voice, in CoS's voice, or neutral third-person?

**8. Initial agents the operator wants spun up next** *(NOT provisioned; written to CoS handoff memory)*
- Open-ended: "if you could spin up a few agents to handle specific roles, what would they be?"
- Beekeeper captures names + role sketches but does NOT validate role→tool mappings here. CoS does that work post-init using the frame's role→tool registry.

The script is a guide, not a strict order. Beekeeper-the-agent reads the situation conversationally — if the operator volunteers Section 4 content while answering Section 2, Beekeeper rolls with it and circles back to anything missing at the end.

#### What Beekeeper reads from the frame vs asks the operator

For clarity (and so plan-stage can wire this without ambiguity):

| Topic | Source |
|---|---|
| Constitution Section 1 (Authority, Hard Limits, Risk Levels, etc.) | Frame (`hive-baseline`) — verbatim |
| Universal-9 coreServers baseline | Frame |
| 5-line per-agent prompt template | Frame |
| Role→tool registry (which MCPs each archetype gets) | Frame |
| Memory tier discipline (hot ≤ ~12, no point-in-time, no meta) | Frame |
| Approval delegation **structure** (who-approves-what shape) | Frame |
| Approval delegation **values** (which roles map to which scopes for THIS operator) | Operator interview |
| Constitution Section 2 (team, comms, environment, ops norms) | Operator interview |
| CoS voice/scope/proactivity | Operator interview |

### Phase 2 — Propose (drafts to operator)

Beekeeper produces three drafts and shows them to the operator in one message:

1. **Constitution Section 2 draft** — markdown, written in the structure the frame anchors expect (team, comms, approval delegation, working environment). Operator-readable. Beekeeper drafts in operator's voice based on Phase 1 notes, but signs the draft as "from Beekeeper, awaiting your approval."
2. **Frame application plan** — which frame (`hive-baseline` for v1, possibly `dodi-ops` or other operator-named frames if KPR-86 has shipped them and the operator opts in), with what selectors. For v1 this is just `hive-baseline` with `agents: ["*"]` (which at init time matches CoS only, since CoS is the only agent — the frame coverage extends naturally as CoS adds agents post-init via re-apply, per the frames spec § Wildcard agent selectors).
3. **CoS profile draft** — soul + systemPrompt + coreServers + initial memory seed.
   - **Soul**: drafted from operator's voice/tone notes (Phase 1 §7).
   - **systemPrompt**: 5-line role-spec template from the frame, filled with operator's CoS-shaping notes (Phase 1 §7) — identity, scope, boundary, tools, guardrail.
   - **coreServers**: universal-9 baseline from the frame, no role-specific extras (CoS's role-specific extras are added by the frame's CoS-specific clauses if `hive-baseline` ships them, or left to CoS to request post-init).
   - **Initial memory seed**: structured hot-tier records carrying operator identity, team roster, comms norms, approval delegation values — i.e., the structured form of the Phase 1 interview output. This is what makes CoS "pre-tuned" on her first conversation.

The drafts are emitted as a single consolidated proposal. Operator format mirrors `tune-instance` Phase 2 (numbered findings) — but smaller, since init has only three macro-items (Section 2, frame application, CoS profile). Each draft is shown in full; operator can request edits.

### Phase 3 — Operator review

Operator responds conversationally:
- **Approve all** → `"looks good"`, `"apply"`, `"ship it"`.
- **Edit and re-show** → `"change Section 2 paragraph 3 to say X"`, `"the CoS systemPrompt should be more concise"`. Beekeeper revises and re-emits the affected draft(s); operator re-reviews.
- **Defer one piece** → `"hold off on the CoS profile, I want to think about her voice more — apply Section 2 and the frame for now"`. Beekeeper applies the approved subset and writes a partial state record (so Phase 0's `detectInstanceState()` returns `partial` on next invocation). Plan-stage decides whether deferred-piece resume needs anything beyond the standard partial-state flow.

**Parsing-failure contract.** If the skill cannot confidently parse a response, it asks **one targeted clarifying question** rather than guessing. Two consecutive ambiguous responses in the same review → the skill exits Phase 3 without applying anything (no partial state written) and reports: "review response unclear; re-invoke `init-instance` when ready." This differs from `tune-instance` Phase 2 in that init's review is smaller (3 items, not dozens), so abandoning is cheaper than partial-application; init defaults conservative.

After explicit approval, Beekeeper proceeds to Phase 4.

### Phase 4 — Apply

Beekeeper executes the approved drafts as a sequence of writes, using KPR-83 Phase 2 `frame apply` primitives where applicable. Each step writes durably before the next begins, so partial-state recovery (Phase 0's `partial` branch) has structured intermediate states.

Step order and primitives:

| Step | Mechanism | Durable artifact |
|---|---|---|
| 4a. Render Section 1 from frame | Frame primitive (Phase 2 of KPR-83) emits Section 1 + structural anchors into `db.memory[shared/constitution.md]` | `agent_memory` record for `shared/constitution.md` |
| 4b. Insert Section 2 prose | Direct `admin_save_constitution` (Phase 1 frame primitives are read-only; Section 2 is operator-authored, not frame-managed) at the Section 2 anchor introduced by the frame in 4a. The anchor's stable name (e.g. `section-2`) is defined in the `hive-baseline` frame manifest (KPR-86 deliverable); plan-stage picks it up from there. | Same `agent_memory` doc, updated |
| 4c. Apply `hive-baseline` frame | `frame apply hive-baseline <instance-id>` — the rest of the frame's assets (skills, schedules, prompt anchors, memory seeds, coreservers) | `applied_frames.hive-baseline` record |
| 4d. Render initial CoS agent definition | `admin_save_agent` with the Phase 2 draft (soul + systemPrompt + universal-9 coreServers + role-specific extras from the frame's prompt clauses) | `agent_definitions.<cos-id>` record + `agent_definition_versions` row |
| 4e. Seed CoS memory | `admin_save_memory` (or direct insert into `agent_memory` collection) with structured records from Phase 1 interview output — operator identity, team roster, comms norms, approval delegation values | `agent_memory` records tagged with `seedRunId: <runId>` |
| 4f. Stamp template version | Write `constitution-template-version: <semver>` field into the constitution doc's metadata so KPR-72 can detect template drift later | Same `agent_memory` doc, metadata |

Every Mongo write tags `updatedBy: "beekeeper-init-instance:<runId>"` (or, for `applied_frames`, the frame primitive's `appliedBy` carries an equivalent ULID per frames spec § Apply semantics).

After all writes:
- **SIGUSR1 the running hive**: `kill -USR1 $(pgrep -f "hive-agent <instance-id>")` — agent definitions reload without a full restart. (For a truly fresh instance, the hive process may not be running yet; in that case Phase 4 ends and Phase 5 reminds the operator to start the hive service.)
- **Verify**: re-query each affected doc to confirm the writes landed; report any failures to the operator.

**Failure mid-Phase-4.** Each step is durably committed before the next runs. If 4d fails (e.g., admin tool errors), the operator is told which steps succeeded (4a, 4b, 4c) and which failed (4d) and what's still missing (4e, 4f). On re-invocation, `detectInstanceState()` returns `partial` with detail showing 4a-4c done, 4d-4f missing, and Phase 0 routes to resume.

### Phase 5 — Handoff to CoS

Beekeeper writes a final hot-tier memory record on the CoS agent describing what just happened:

```
title: "init-instance handoff from Beekeeper"
tier: hot
content:
  You were just seeded by Beekeeper at <timestamp> via the init-instance skill.
  Your operator is <operator name and role>.
  This Hive supports <one-paragraph operation description>.
  The team includes <list of team members from interview>.
  Your initial scope is <CoS-shaping notes synthesized into role description>.
  Approval delegation: <synthesized rules>.
  The operator mentioned wanting to spin up these agents next:
    - <name>: <role sketch>
    - <name>: <role sketch>
  Use the frame's role→tool registry (see your `frame_lookup` capability or
  ask Beekeeper) when provisioning new agents. Constitution §1.16 forbids
  you from modifying your own prompt; coordinate with Beekeeper for prompt
  changes, with the operator for Section 2 changes.
metadata:
  seedRunId: <runId>
  seededBy: beekeeper-init-instance
  seededAt: <timestamp>
```

The hot tier reads records directly (no embeddings dependency) per the structured-memory model, so this record surfaces in CoS's prompt context on her first turn. CoS's first conversation reads this naturally — no special "first conversation" code path. First-time vs nth-time is just memory contents.

The skill ends with a message to the operator:

```
Init complete for <instance-id>.
Constitution Section 1 + Section 2 written.
Frame `hive-baseline` applied.
CoS agent `<cos-id>` seeded with <N> hot-tier memory records.

Next steps:
  - Start the hive service if it isn't running: `launchctl kickstart -k gui/$(id -u)/com.hive.<instance-id>.agent`
  - Send a message to <cos-id> in Slack — she's pre-tuned with your operator context and ready to pick up the team-building you described.
  - When ready to spin up the agents you mentioned (X, Y, Z), ask <cos-id> in Slack — she'll use the frame's role→tool registry to provision them.
```

**No run-artifact file in v1.** Unlike KPR-72's `tune-runs/<runId>.md`, init does not write a per-run findings doc. The audit trail is the `updatedBy: "beekeeper-init-instance:<runId>"` tags across the affected Mongo docs plus the Phase 5 handoff memory record (which carries `seedRunId` and the synthesized operator context). Conversation context is not durable — only the artifacts are. This is a deliberate scope choice: init has three macro writes (constitution, frame apply, CoS) versus tune-instance's dozens of remediations, and the tagged Mongo docs are sufficient to reconstruct what was seeded. If a future need arises (e.g. multi-operator review of historical inits), a `init-runs/<runId>.md` artifact can be added without breaking compatibility.

## Architecture diagram

Phase flow:

```
                                 detectInstanceState()
                                          │
        ┌─────────────────────────────────┼─────────────────────────────────┐
        ▼                                 ▼                                 ▼
      fresh                            partial                          completed
        │                                 │                                 │
        ▼                                 ▼                                 ▼
   Phase 1 — Discover            (resume / redo dialog)            (refuse w/ override
   (operator interview)                    │                          → tune-instance)
        │                                  │
        ▼                                  ▼
   Phase 2 — Propose             (resume from partial)
   (Section 2 + frame plan +              │
    CoS profile drafts)                   │
        │                                 │
        ▼                                 │
   Phase 3 — Operator review              │
   (cherry-pick allowed; deferred         │
    pieces → partial state)               │
        │                                 │
        └──────────────┬──────────────────┘
                       ▼
              Phase 4 — Apply
              (durable per-step writes;
               uses KPR-83 Phase 2 frame primitives)
                       │
                       ▼
              Phase 5 — Handoff
              (hot-tier memory record on CoS;
               operator gets next-steps message)
```

State machine (simplified):

```
   ┌───────┐                                    ┌────────────┐
   │ fresh │──Phase 1-5 success───────────────▶│ completed  │
   └───────┘                                    └────────────┘
       │                                              ▲
       │                                              │
       │ Phase 4 partial failure                      │ resume of partial run
       ▼                                              │
   ┌─────────┐                                        │
   │ partial │────────────────────────────────────────┘
   └─────────┘
       │ ▲
       │ │ resume / redo cycle (operator chooses each invocation)
       │ │
       └─┘
```

## Failure modes

1. **Operator abandons Phase 1 mid-interview.** No artifacts written; state stays `fresh`. Re-invocation starts from scratch.
2. **Phase 3 review unparseable (2 consecutive ambiguous responses).** No artifacts written; state stays `fresh`. Re-invocation starts from scratch.
3. **Phase 4 step fails before completion.** Steps that completed are durable; remaining are not. State becomes `partial`. Re-invocation routes to Phase 0's `partial` branch and offers resume vs redo.
4. **`bootstrap.sh` did not run.** OS-level deps missing (Mongo not running, Qdrant down, Ollama missing). Phase 4 step 4a or 4c fails on Mongo writes or frame apply; error message points operator at `bootstrap.sh` re-run. (Plan-stage may add a Phase 0.5 explicit dep check before interview to fail-fast on missing infra; not required by spec.)
5. **Frame `hive-baseline` not present** (KPR-86 not yet shipped, or operator on an older Beekeeper). Phase 2 cannot draft a frame application plan. The skill refuses with: "init-instance requires KPR-86 (`hive-baseline` frame). Either install Beekeeper >=<version-with-baseline> or contact Keepur for a registry-distributed frame." This is the gate — implementation pickup waits for KPR-86 to land.
6. **Concurrent invocation on the same instance.** Two Beekeeper sessions running `init-instance` against the same `<instance-id>` simultaneously. Phase 4 writes through `admin_save_*` MCP tools and `frame apply` primitives, which serialize at the Mongo layer; the second session's `detectInstanceState()` will see the first's writes and route to `partial`. Spec accepts this as benign — operator just gets confused and can re-invoke.
7. **Operator runs `tune-instance` on a partially initialized instance.** `tune-instance`'s frame audit will surface the partial frame application as drift; per `tune-instance` spec, this is reported as informational. Operator should finish `init-instance` first; spec does not block `tune-instance` from running on partial state but the output will be noisy.

## Idempotency

Init is fundamentally a one-shot per instance. The idempotency story is:

- **`fresh` → run produces `completed`** (or `partial` on failure). Re-running on `completed` refuses by default; operator must explicitly `force re-init` to repeat.
- **`partial` → resume produces `completed`** without re-doing the durable work. The operator may re-answer interview questions for not-yet-written pieces (conversation context isn't replayable).
- **`force re-init` on `completed`** is treated as `partial` with `redo from scratch` — destructive, requires per-artifact operator confirmation.

This is *not* the same idempotency contract as `tune-instance` (which expects clean re-runs to produce zero structural findings). Init is not designed for clean re-runs because the operator interview is a one-shot creative input. Re-running init on the same instance is a recovery mechanism, not a first-class expected operation.

## Distribution

Same pattern as `tune-instance`:

- Skill ships at `~/github/beekeeper/skills/init-instance/SKILL.md`.
- Postinstall (or `beekeeper install`) symlinks `~/.claude/skills/init-instance/` → install-dir copy.
- Beekeeper's existing `discoverUserSkills` (config.ts:84) auto-discovers it.
- Update semantics, install-collision behavior, uninstall behavior — all identical to `tune-instance`. See that spec for prose; do not duplicate.
- Promote to a `@keepur/beekeeper-skills` plugin if/when Beekeeper accumulates 3+ such skills (`init-instance`, `tune-instance`, future `cos:hire-agent` would be the third — at which point promote).

`bootstrap.sh` change is in scope for the implementation plan but not for this spec: `bootstrap.sh` ends by printing "instance provisioned at `<path>`. Open Beekeeper and run `init-instance <instance-id>` to configure." instead of dropping in a generic constitution + generic CoS seed. The exact prose and any cross-repo coordination (hive-docs / hive engine repo) are plan-stage concerns.

## Coordination with sibling tickets

- **KPR-72** (`tune-instance` — remedial drift remediation) — sibling. Same skill pattern, same distribution mechanism, same Beekeeper-conversational shape. Output of `init-instance` should pass `tune-instance` audit on the first run with zero structural findings (this is the preventive contract).
- **KPR-78** (CoS environment audit) — adjacent. KPR-78 asks the meta question "what does CoS need to be effective"; KPR-71 is the day-zero answer (give her operator context in memory before she comes online).
- **KPR-79** (engine team-API) — already Ready. KPR-71 doesn't directly consume the team API — Beekeeper writes Section 2 + memory seeds, not the team-API records. But KPR-71's Section 2 should align with whatever shape KPR-79's team data takes, so the two don't drift apart in voice or content.
- **KPR-83** (Frames) Phase 2 — **dependency**. KPR-71 implementation gates on Phase 2 (`frame apply` write primitives) shipping in Beekeeper. Spec + plan can land now.
- **KPR-83** (Frames) Phase 3 — **dependency**. KPR-71 implementation gates on Phase 3 (`hive-baseline` frame content) shipping. Spec + plan can land now.
- **KPR-86** (`hive-baseline` frame content) — **dependency**. Same as KPR-83 Phase 3; called out separately because the *content* of `hive-baseline` (the universal Section 1, the role→tool registry, the universal-9 baseline, the 5-line prompt template) is what `init-instance` actually applies. Without `hive-baseline` content, init has nothing to apply.

## Acceptance criteria

- [ ] Skill exists at `~/github/beekeeper/skills/init-instance/SKILL.md` with frontmatter `name`, `description`, `agents: [beekeeper]`
- [ ] Beekeeper installer (or postinstall) ensures the skill is reachable at `~/.claude/skills/init-instance/` so existing skill auto-discovery picks it up
- [ ] `detectInstanceState()` primitive lives at a single import path; both Phase 0 and Phase 4-resume code paths consume it via the same import
- [ ] Phase 0 returns `fresh` / `partial` / `completed` per the documented decision rule; refuses `completed` re-init unless explicit `force re-init` confirmation is given
- [ ] Phase 1 conducts an operator interview covering: operator identity, company context, team structure, comms norms, approval delegation, working environment, CoS shaping, initial-agent wishes; calls out frame defaults vs operator-specific values explicitly
- [ ] Phase 2 emits three drafts (Section 2, frame application plan, CoS profile) in one consolidated proposal
- [ ] Phase 3 supports approve-all / edit-and-re-show / defer-one-piece; parsing-failure contract: one clarifying question, then exit on second ambiguity (no partial-state write on parse failure)
- [ ] Phase 4 uses KPR-83 Phase 2 `frame apply` primitives for the frame-managed writes (does NOT reimplement asset writes); writes Section 2 directly via `admin_save_constitution` after the frame establishes Section 1 + anchors
- [ ] Every Phase 4 Mongo write tags `updatedBy: "beekeeper-init-instance:<runId>"` (or equivalent for frame primitives)
- [ ] Phase 4 step ordering is durable per-step: 4a → 4b → 4c → 4d → 4e → 4f, each artifact landed before the next begins
- [ ] Phase 4 SIGUSR1s the hive after writes if the hive process is running; otherwise prints a "start the hive" instruction to the operator
- [ ] Phase 5 writes a hot-tier memory record on the seeded CoS agent describing operator context, team roster, comms norms, approval delegation values, and the operator's initial-agent wishes
- [ ] Phase 5 record is tagged with `seedRunId` and `seededBy: beekeeper-init-instance` for traceability
- [ ] Output of `init-instance` passes `tune-instance` audit on the first run with zero structural findings (the preventive contract)
- [ ] On any Phase 4 step failure, durable artifacts up to that point persist and `detectInstanceState()` returns `partial` on next invocation
- [ ] Re-invocation on `partial` offers resume vs redo dialog; resume re-runs only not-yet-written pieces; redo confirms per-artifact destruction before proceeding
- [ ] Implementation pickup gated on KPR-83 Phase 2 (`frame apply` writes) AND Phase 3 (`hive-baseline` content) landing — spec/plan land in parallel, implementer waits

## Open design questions

(All major open questions from the brainstorm are settled — see Reframe context, the 11 settled answers in `~/.claude/projects/-Users-mokie-github-hive/memory/project_kpr71_reframe.md`. The items below are smaller plan-stage clarifications that don't block the spec.)

1. **Should Phase 0 include an explicit pre-flight dep check** (Mongo running, Qdrant up, Ollama present) before Phase 1, to fail-fast on missing infra rather than at Phase 4 step 4a? Lean: **yes, plan-stage adds a Phase 0.5** — gives the operator a clearer error than a Mongo connection failure mid-Phase-4. Not blocking spec acceptance.

2. **`force re-init` granularity.** Should `force re-init` blow away ALL artifacts (Section 2, frame application, CoS, memory seeds) or offer per-artifact selection? Spec says per-artifact confirmation, but plan-stage decides whether the dialog is finding-by-finding (more clicks, safer) or category-grouped (faster, less surgical). Lean: **per-artifact confirmation, finding-by-finding** for symmetry with destructive operations elsewhere in Beekeeper.

3. **CoS agent ID convention.** Default `chief-of-staff` slug, or operator-chosen during interview? Frame supplies role definitions by archetype, not by slug, so the slug can be operator-chosen. Lean: **default to `chief-of-staff`, allow operator override during Phase 1 §7 if they want a custom name (e.g., `mokie`, `hermi`)**. Beekeeper just writes the operator's choice into the agent definition.

## Path to implementation

Once spec is review-clean → KPR-71 advances to Plan Drafting. Plan covers:

1. Skill directory + frontmatter + phased playbook (~300–400 LOC of markdown — interview script is the bulk).
2. `detectInstanceState()` primitive — TypeScript implementation, returns `InstanceState` type, tested against fixture instances in fresh/partial/completed states (~80 LOC + tests).
3. Phase 4 wiring — calls into KPR-83 Phase 2 `frame apply`, calls `admin_save_constitution` and `admin_save_agent` MCP tools, writes structured memory records.
4. Phase 1 interview script — concrete question prompts, branching guidance for "operator volunteers content out of order," frame-default-vs-operator-input cues.
5. Phase 5 handoff record template — concrete schema for the hot-tier seed record, including all metadata fields.
6. `bootstrap.sh` modification — drop generic constitution and generic CoS seed; print "open Beekeeper and run init-instance" instead. Plan stage decides whether this lives in Beekeeper repo (with cross-repo coordination to hive engine) or just gets a redirect-note PR to hive.
7. Beekeeper installer / postinstall step that ensures the skill is at `~/.claude/skills/init-instance/` (~40 LOC + tests). Reuse the same installer code path as `tune-instance`.
8. README at `skills/init-instance/README.md` for operator-facing how-to (~80 LOC).
9. End-to-end test scenario: bootstrap a fresh test instance, run `init-instance` against it, verify Section 2 + frame + CoS + handoff memory all land; run `tune-instance` against the result and confirm zero structural findings.

**Implementation gating note:** plan execution waits until KPR-83 Phase 2 AND Phase 3 (KPR-86 `hive-baseline`) land. Spec and plan can be drafted, reviewed, and committed now; the implementer subagent shouldn't pick up the plan until both are shipped (so frame primitives and `hive-baseline` content are real and importable). Linear state for KPR-71 stays at "Ready" with a coordination note pinned to KPR-83 / KPR-86 in the dependency field.

Estimated 2–3 days of focused work after dependencies land and plan-clean.

## Appendix — relationship to constitution sections

For the implementer's reference, here's how `init-instance` interacts with the constitution sections it authors:

| Constitution section | Source | Authored by |
|---|---|---|
| §1 (Authority, Hard Limits, Risk Levels, Memory Lifecycle, Capabilities, etc.) | Frame `hive-baseline` | Beekeeper, via `frame apply` |
| §1.6 (CoS scope — Section 2 ongoing edits) | Frame | Beekeeper |
| §1.16 (no self-modification) | Frame | Beekeeper |
| §2 (operator-specific: team, comms, approval delegation, working environment) | Operator interview | Beekeeper, via direct `admin_save_constitution` after frame establishes anchors |
| Constitution template version stamp (metadata) | Frame manifest version | Beekeeper, written at Phase 4 step 4f |

Section 1 is platform-only per `feedback_admin_skill_ownership.md`. KPR-71 is the *only* skill that ever writes Section 1 directly — and it does so by applying the frame, not by hand-editing. CoS post-init has no path to Section 1 (constitution §1.16); `tune-instance` (KPR-72) refuses Section 1 edits unless they're template-drift backfills.

Section 2 is operator-specific. KPR-71 authors initial Section 2 from operator interview. CoS post-init owns ongoing Section 2 edits per constitution §1.6. `tune-instance` may propose Section 2 edits but applies them only with operator approval per `tune-instance` Phase 2 cherry-pick gate.
