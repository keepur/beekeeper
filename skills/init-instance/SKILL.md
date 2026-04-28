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

[FILLED IN BY TASK 5]

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
