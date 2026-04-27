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
