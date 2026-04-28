---
name: init-instance
description: Initialize a fresh Hive instance via Beekeeper conversation. Interviews the operator, authors constitution Section 2, applies the hive-baseline frame, and seeds an operator-specific Chief-of-Staff agent. Hands off to CoS with operator context in memory.
agents: [beekeeper]
---

# Init Instance

You are about to initialize a fresh Hive instance. Your job is to interview the operator, author the operator-specific constitution Section 2, apply the `hive-baseline` frame for the platform-shared Section 1 and structural defaults, seed a single Chief-of-Staff agent shaped to the operator's voice and team, and hand off to CoS via a memory-seeded welcome record. You are operating from outside the hive — agents do not self-modify (constitution §1.16). Mutations go through `admin_*` MCP tools and the `frame apply` write primitives from KPR-85.

## Operating principles

- **Interview-first; never seed without operator input.** The whole point of this skill is that operator context is the load-bearing input. Do not auto-fill team structure, comms norms, or CoS shaping from defaults beyond what the frame supplies.
- **Phases 1–3 mutate nothing.** No Mongo writes, no filesystem writes (other than transient in-memory transcript state) until Phase 4. Operator approval gates every durable write.
- **Initial-agent scope = JUST CoS.** Other agents are described by the operator during the interview but provisioned post-init by CoS using the frame's role→tool registry. This skill bootstraps the agent who provisions the org chart; it does not provision the org chart.
- **Refuse re-init by default; partial-state resume on demand.** Use `detectInstanceState()` (see spec §"detectInstanceState() — shared primitive"); branch on `fresh` / `partial` / `completed`. Refuse `completed` unless explicitly overridden with `force re-init <instance-id>`.

## Inputs

The skill takes one input from the operator's invocation:

- `<instance-id>` — string matching a configured Hive instance (the one `bootstrap.sh` just provisioned, or one the operator names freshly). Resolves to:
  - `~/services/hive/<instance-id>/` for skills, frames, and operator-level config
  - `mongodb://localhost/hive_<instance-id>` for the instance database

If no instance is given, the skill asks the operator. If `bootstrap.sh` ran moments before and only one fresh instance exists, the skill defaults silently to that one and confirms.

## runId allocation

At Phase 1 entry the skill allocates a fresh ULID (`<runId>`) that flows through the rest of the run:

- Phase 1: tags the in-memory interview transcript.
- Phase 4: every Mongo write tags `updatedBy: "beekeeper-init-instance:<runId>"`; the seeded CoS memory record carries `seedRunId: <runId>` for traceability.
- Phase 5: the handoff memory record references `<runId>` so future Beekeeper or CoS introspection can trace back to "this is what was seeded at init."

## Phase 0 — Pre-flight + state detection

Before Phase 1 starts, detect the instance's current init state via the shared `detectInstanceState()` primitive (canonical implementation: `src/init/detect-instance-state.ts`). Both Phase 0 and Phase 4-resume invoke the same CLI subcommand so they cannot disagree about what "initialized" means.

### Invocation

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

Decision rule:

- All four detail booleans `true` → `completed`.
- All four `false` → `fresh`.
- Any other combination → `partial`.

Branch on the returned `state` field. If the operator chose a non-default CoS slug in a prior run (e.g., `mokie`), pass `--cos-agent-id <slug>` so detection picks up the right record.

### Branches

- **`fresh`** → proceed to Phase 1 normally.
- **`partial`** → surface the detected partial state to the operator: which artifacts are present (Section 2 written? frame manifest? CoS in `agent_definitions`? handoff memory record?), which are missing, and the last `appliedAt` if known. Ask: "this instance was partially initialized at `<lastInitAppliedAt>`. Resume from where init left off, or redo from scratch?"
  - **Resume** → re-run Phase 1 only for the pieces that aren't durable yet (e.g., if Section 2 was written but CoS wasn't seeded, re-ask the CoS-shaping questions). Conversation context isn't replayable across sessions; only artifacts are durable, so the operator may re-answer some questions.
  - **Redo from scratch** → remove existing partial artifacts (with operator confirmation per artifact, since this is destructive) and proceed to Phase 1 fresh.
- **`completed`** → refuse with: "instance `<id>` is already initialized (Section 2 written, frame applied, CoS seeded, last init at `<appliedAt>`). To update Section 2, hire new agents, or fix drift, use the `tune-instance` skill (KPR-72) or a future `cos:hire-agent` skill. To re-init from scratch anyway, confirm explicitly with `force re-init <instance-id>`."
  - On explicit `force re-init <instance-id>` confirmation, behave as if state were `partial` with `redo from scratch` selected (per-artifact confirmation, finding-by-finding).

### Phase 0.5 — Dependency pre-flight

Before the interview, verify OS-level deps are reachable so a Mongo connection failure mid-Phase-4 doesn't waste an interview's worth of operator time:

- **Mongo**: `mongosh --eval "db.runCommand({ping:1})"` returns `{ok: 1}` against `mongodb://localhost`.
- **Qdrant** (if the frame's coreServers depend on `structured-memory`): `curl -s http://localhost:6333/healthz` returns 200.
- **Ollama** (if the frame's coreServers depend on local embeddings): `curl -s http://localhost:11434/api/tags` returns 200.

If any dep is down, fail fast: "Operator, before we start the interview: `<dep>` isn't reachable. Check that `bootstrap.sh` ran fully, then re-invoke." Do NOT enter Phase 1.

### Note on the canonical implementation

The TypeScript module at `src/init/detect-instance-state.ts` is the single source of truth for what "initialized" means. The CLI subcommand wraps it; Phase 4-resume detection invokes the same CLI. If you find yourself wanting to write parallel mongosh checks, stop — extend the primitive instead and update both call sites at once.

## Phase 1 — Discover (operator interview)

[FILLED IN BY TASK 6]

## Phase 2 — Propose (drafts to operator)

[FILLED IN BY TASK 7]

## Phase 3 — Operator review

[FILLED IN BY TASK 8]

## Phase 4 — Apply

[FILLED IN BY TASK 9]

## Phase 5 — Handoff to CoS

[FILLED IN BY TASK 10]

## Idempotency

[FILLED IN BY TASK 11]

## Failure recovery

[FILLED IN BY TASK 12]
