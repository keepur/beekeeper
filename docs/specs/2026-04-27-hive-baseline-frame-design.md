# Frame: `hive-baseline` — Design Spec

**Date:** 2026-04-27
**Author:** May (CEO) + Mokie (Opus)
**Linear:** KPR-86 (Frames Phase 3)
**Epic:** KPR-83 (Frames)
**Depends on:** KPR-84 (Phase 1 — foundation + `--adopt`) merged; KPR-85 (Phase 2 — asset writes + remove + drift dialog) merged.
**Triggered by:** Phases 1 and 2 shipped a complete frames runtime against an empty registry. KPR-86 hand-authors the first real frame so the runtime is exercised end-to-end against a real instance, and so the downstream consumers (KPR-71 `init-instance`, KPR-72 `tune-instance`) have a concrete frame to apply / be aware of. Source artifacts are the dodi 2026-04-25 tuning session: constitution v4 fragments, the `memory-hygiene-review` skill, and the staggered Friday-afternoon crons in `agent_definitions`.

## Problem

The frames runtime has no real frame. A runtime without a frame on it is unproven against the patterns it was built for — anchor resolution, drift detection, the per-asset apply/remove ordering, the staggered-cron slot algorithm, the `--adopt` short-circuit. The KPR-83 spec named `hive-baseline` as the proving frame; this spec is its design.

`hive-baseline` is also load-bearing for KPR-71 and KPR-72:

- **KPR-71 `init-instance`** applies `hive-baseline` as the structural backbone of every fresh instance — Section 1 of the constitution comes from the frame, the universal-9 baseline is wired in, the memory-hygiene cadence is seeded. Without a real frame, KPR-71 has nothing to apply.
- **KPR-72 `tune-instance`** runs `frame audit` as its first step. It expects a real frame to be present (or zero frames; either is fine — but the "frame is present and audit reports clean" path needs a real frame to validate against).

Beyond proving the runtime and unblocking siblings, `hive-baseline` codifies the operational defaults May actually wants in every Hive she runs (and every Hive a customer runs). It is the smallest worth-running set: memory-tier discipline, capability discipline, the 5 universal-9 coreServers that aren't engine-auto-injected, and the weekly self-audit cadence that keeps the first two from rotting.

## Goals

1. **Author the four assets** named in the Linear ticket scope: 2 constitution clauses (anchors `memory` and `capabilities`), 1 skill bundle (`memory-hygiene-review`), 1 coreServers add (5 servers, all agents), 1 schedule entry (weekly staggered `memory-hygiene-review`).
2. **Source content from dodi.** Constitution clauses extract from dodi's constitution v4 (the artifact of the 2026-04-25 tuning session); skill bundle extracts from dodi's installed `memory-hygiene-review`; schedule pattern extracts from dodi's existing `agent_definitions.scheduledTasks`. Each extraction includes a **scrub-pass** to remove dodi-specific references (people names, business specifics, "DodiHome", "May", etc.) so the codified content is generic and inheritable by any Hive instance.
3. **Apply cleanly to two real instances.** dodi via `--adopt` (the anchored content is already present — the frame is derived from dodi); keepur via full `apply` (anchors and content introduced fresh).
4. **Validate as operator-driven prep-work.** Walk the apply / drift dialog / remove paths interactively against dodi and keepur. Capture findings as confidence — not as automated regression tests. The runtime already has its own automated test suite (KPR-85 shipped 195 tests); this is integration prep, not a duplicate test layer.
5. **Frame lives at `~/.beekeeper/frames/hive-baseline/`** for local development. Registry distribution (`frames.keepur.io`) ships in Phase 4+.

## Non-goals

- **Role→tool registry.** Per-archetype tool maps (engineering → github + code-task + linear; sales → quo + resend; etc.) are NOT in `hive-baseline`. Those belong in archetype-specific frames (`role-engineering`, `role-sales`, etc.) authored in Phase 4+. `hive-baseline` is universal — every agent regardless of role gets exactly the same overlay.
- **Full Section 1 backbone.** The Linear ticket scope is two anchors (`memory` and `capabilities`), not the whole of Section 1 (Authority, Hard Limits, Approval Delegation, Risk Levels, Message Delivery, etc.). Section 1 backbone in full is a future archetype frame (or a follow-up to `hive-baseline` once the apply/audit/remove loop has been exercised on a small surface).
- **Per-agent prompt template.** The 5-line role-spec template (identity / scope / boundary / tools / guardrail) named in the frames-design spec under "Concrete first frames → dodi-ops" is NOT in `hive-baseline`. It belongs in `dodi-ops` or a future role-spec frame.
- **Operator-specific Section 2 anchors.** Section 2 (operator team, comms norms, approval delegation, working environment) is authored at runtime by KPR-71 `init-instance`, not codified in a frame.
- **Memory seeds.** `hive-baseline` ships zero memory seeds. Durable knowledge (product formulas, team rosters, etc.) is operator-specific and goes in operator-specific frames or is seeded by KPR-71.
- **Hooks.** `hive-baseline` ships zero `pre-apply` / `post-apply` hooks. The four asset types are declarative; nothing needs to run on the operator's machine.
- **Implementing the frame's content authoring before the spec lands.** Spec + plan are this PR; the actual `manifest.yaml` + `assets/*` files are written by the plan's tasks against the same `KPR-83-frames` epic branch.

## Design

### Frame layout on disk

```
~/.beekeeper/frames/hive-baseline/
├── frame.yaml                               # manifest
├── README.md                                # operator-facing one-pager
├── constitution/
│   ├── memory.md                            # the "Manage your memory lifecycle" clause
│   └── capabilities.md                      # the "Your Capabilities" clause
└── skills/
    └── memory-hygiene/
        └── skills/
            └── memory-hygiene-review/
                └── SKILL.md                 # the per-agent weekly self-audit playbook
```

The layout follows the convention from `~/github/beekeeper/docs/specs/2026-04-25-frames-design.md` § "On-disk layout": `constitution/` holds markdown fragments named to mirror anchor IDs; `skills/<bundle>/` mirrors `<instance>/skills/<bundle>/` so the runtime's skill-asset writer can `cp -R` without rewriting paths.

No `prompts/`, `memory-seeds/`, or `hooks/` directories — those asset types are out of scope for this frame.

### Manifest YAML — full example

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

**Schema notes (per `src/frames/types.ts` on `KPR-83-frames`):**

- `version: 1.0.0` — initial release. See § "Versioning" below for bump policy.
- `targets.hive-version: ">=0.2.0"` — the universal-9 baseline + auto-injection logic landed in 0.2.x; pre-0.2.0 instances don't have the engine-side auto-injection so the frame's claim that "5 servers complete the universal-9" wouldn't hold.
- `requires: []`, `conflicts: []` — `hive-baseline` is the foundation; nothing depends on it (yet) and nothing conflicts with it.
- Two `replace-anchor` constitution entries — both anchors carry full clauses authored by this frame. Anchor IDs are `memory` and `capabilities` (stable contracts; section numbers can renumber freely without breaking the manifest).
- `skills: [{ bundle: skills/memory-hygiene }]` — single skill bundle; the runtime copies the bundle directory into `<instance>/skills/memory-hygiene/`.
- `coreservers.add: [keychain, contacts, event-bus, conversation-search, callback]` — the 5 of universal-9 that the engine does NOT auto-inject. The other 4 (`memory`, `structured-memory`, `slack`, `schedule`) come from the engine's `INFRASTRUCTURE_SERVERS` set (per `~/.claude/projects/-Users-mokie-github-hive/memory/feedback_universal_default_tools.md`). `agents: ["*"]` is evaluated as a snapshot at apply time per § "Wildcard agent selectors" in the frames-design spec.
- `schedule[0].pattern: stagger` with `window: "fri 14:00-17:00 America/Los_Angeles"` and `interval: 15m` — the runtime's stagger algorithm assigns `slot[i] = window_start + i * interval` to agents sorted by `agent_id`. With a 3-hour window and 15-minute slots, 12 slots are available — enough for ~10 agents per instance with headroom. If an instance has more than 12 agents in scope, apply fails with the explicit "widen the window or reduce agent scope" error from the frames-design spec.

**Why the IANA zone (`America/Los_Angeles`) and not `PT`.** The frames-design spec explicitly notes "the 'PT' shorthand is informal; canonical form uses IANA zones." `hive-baseline` uses canonical form. Customer hives in other zones can fork the frame and rewrite the window, or Phase 4+ can add a `local-business-hours` semantic so the frame is timezone-portable.

### Asset specifications

#### Constitution clauses — `memory` and `capabilities`

**Anchor IDs.** Both are stable IDs already documented in the frames-design spec § "Stable anchor IDs" example. The actual prose comes from dodi's constitution v4 (the source-of-truth per the 2026-04-27 brainstorm). The plan's Task 1 extracts the prose, scrubs dodi-specific references, and writes the generalized text to `constitution/memory.md` and `constitution/capabilities.md`.

**Topic scope** (what the prose covers — actual prose is plan-stage extraction):

- **`memory`** — the three-tier memory model (hot ≤ ~12 records, warm queryable, cold archived); awareness of autoDream consolidation; cadence for self-audit (weekly via `memory-hygiene-review`); the "no point-in-time snapshots, no conversational meta-text, no stale role-facts" hygiene rules from `~/.claude/projects/-Users-mokie-github-hive/memory/feedback_memory_tier_hygiene.md`.
- **`capabilities`** — check-before-declining tool/access discipline; the "I don't have access to X" anti-pattern (the agent should check coreServers before declining); the universal-9 expectation (every agent has these tools, the prompt should reflect that, the agent should use them).

**Insert mode.** Both `replace-anchor`. The frame is the authoritative source; it owns the content fully. On `--adopt` the runtime stages the *current* (already-present) text as the inserted text — see § "Apply-vs-adopt strategy" below.

**Scrub-pass items** (plan Task 1 enumerates):
- Replace `DodiHome` / `dodi` business-name references with neutral phrasing (e.g., "the operator's business").
- Replace operator/team names (`May`, `Corey`, `Mike`, etc.) with role descriptors or remove.
- Replace product-specific examples (cabinet ops, designs, jobs) with neutral examples or remove.
- Strip references to dodi-specific MCP servers (`hubspot-crm`, `dodi-ops`) when discussing capabilities; reference the universal-9 baseline only.

The scrub-pass is iterative: read the dodi prose, identify operator-coupled content, generalize, re-read, ship. Plan stage reviews the scrubbed prose for residual specifics before commit.

#### Skill bundle — `memory-hygiene-review`

**Source.** dodi's installed `<instance>/skills/memory-hygiene/skills/memory-hygiene-review/SKILL.md` (the artifact of the 2026-04-25 tuning session). If the dodi copy isn't accessible from the worktree, plan Task 2 reconstructs the skill from scratch using the per-agent self-audit pattern described in `feedback_memory_tier_hygiene.md` and the cron pointer in dodi's agent definitions.

**Skill purpose.** A weekly agent-side self-audit. Each agent reads its own memory tiers, applies the hygiene checklist (hot ≤ ~12 records, no point-in-time snapshots, no conversational meta, no stale role-facts, no duplicates), and proposes demotions / archivals / drops. Per-agent (the agent runs the skill on itself), not platform-level (Beekeeper does NOT run this skill).

**Frontmatter.**

```yaml
---
name: memory-hygiene-review
description: Weekly self-audit of your own memory tiers. Read your hot tier, apply hygiene rules, propose demotions or drops to keep the tier clean.
agents: ["*"]
---
```

`agents: ["*"]` — every agent that has the skill installed runs it on itself. The frame's `coreservers` add makes sure every agent has the tools to read its memory; the frame's `schedule` cron triggers the skill weekly.

**Scrub-pass items** (plan Task 2 enumerates): same rules as constitution — strip dodi-specific examples, operator names, business specifics. The audit checklist itself is universal; only example payloads need scrubbing.

#### CoreServers — completes universal-9

The 5 servers added by this frame (`keychain`, `contacts`, `event-bus`, `conversation-search`, `callback`) plus the 4 the engine auto-injects (`memory`, `structured-memory`, `slack`, `schedule`) equal the universal-9 baseline named in `feedback_universal_default_tools.md`.

`agents: ["*"]` — set-union per agent at apply time. The runtime captures the set of matched agent IDs in `applied_frames.resources.coreservers` (per `src/frames/types.ts`), so a `frame remove hive-baseline` only strips servers from the agents the frame actually claimed (not ones added later by the operator or by another frame).

**Why these 5 specifically.** Per `~/.claude/projects/-Users-mokie-github-hive/memory/feedback_universal_default_tools.md`, the engine's `INFRASTRUCTURE_SERVERS` set in `src/tools/instance-capabilities.ts` already auto-injects 4 of the 9. The remaining 5 require explicit listing in `coreServers` per agent — that listing is what `hive-baseline` provides.

#### Schedule — weekly staggered `memory-hygiene-review`

`pattern: stagger` with a 3-hour window (Friday 14:00–17:00 PT) and 15-minute interval gives 12 slots. The runtime's stagger algorithm sorts agents by `agent_id` and assigns slot `i` to agent `i`, deterministic across re-applies.

**Why staggered, not shared.** A shared cron would fire every agent at the same minute, hammering the database and the `memory-hygiene-review` skill's downstream Mongo queries. Staggered slots keep the load smooth across the window.

**Why Friday afternoon PT.** Operator-comfort window: ahead of the weekend, after the bulk of the work-week's memory churn has landed. Customer hives in other zones override per § "IANA zone" note above.

**Interaction with the universal-9 `schedule` server.** The `schedule` server is engine-auto-injected (one of the 4 the frame doesn't add); it's the per-agent self-service scheduler ("put it on my calendar," "ping me back in N minutes"). The frame's `schedule` asset is platform-managed (Beekeeper-issued, frame-claimed). The two coexist — the frame's cron lands in `agent_definitions.<agent>.scheduledTasks` (frame-managed); the agent's own self-service entries go to the same array but without `replacedClaimFrom`. KPR-72 audit knows the difference via `replacedClaimFrom`.

### Apply-vs-adopt strategy

**dodi → `frame apply --adopt hive-baseline dodi`.**

dodi's constitution v4 already contains the `memory` and `capabilities` anchored content (it's the source the frame is derived from). dodi's `agent_definitions` already have the 5 added coreServers (the 2026-04-25 tuning session ensured this). dodi's agents already have the staggered Friday cron. dodi already has the `memory-hygiene-review` skill installed.

`--adopt` is the intended path: per the frames-design spec § "Bootstrapping and migration," adopt does resolvability checks only (anchors exist, hive-version matches), skips anchor-conflict checks (the whole premise is the content is already present), and records the *current* state as the `applied_frames` snapshot. dodi is now "claimed by" the frame without any asset writes.

After adopt, `frame audit dodi` reports clean (no drift, since the snapshot equals the current state).

**keepur → `frame apply hive-baseline keepur`.**

keepur, by contrast, was set up before `hive-baseline` existed and has never received the universal-9 backfill (per the 2026-04-25 keepur tuning audit findings — agents are missing `conversation-search`, `callback`, `schedule`, etc.). Full apply introduces:

- Constitution: `memory` and `capabilities` anchors + their prose, written via `replace-anchor`. If keepur's constitution doesn't already have anchor markers (`<a id="memory"></a>` and `<a id="capabilities"></a>`), the apply fails with `MissingAnchorError` per the frames-design spec § "Bootstrap requirement — anchors must pre-exist." Resolution: keepur's constitution gets a one-time anchor-tagging pass (manual operator step or a small Beekeeper sub-skill — out of scope for this frame, but plan Task 8 verifies the precondition is met before apply).
- Skill bundle: `memory-hygiene` copied to `~/services/hive/keepur/skills/memory-hygiene/`.
- CoreServers: 5 servers added per agent (set-union; idempotent if any were already present).
- Schedule: 1 staggered cron per agent, slots assigned by `agent_id`-sorted order.

Apply triggers SIGUSR1; keepur reloads agent definitions; the new cron is live.

After full apply, `frame audit keepur` reports clean.

**Future customer hives.** Same path as keepur (full apply), assuming the customer's constitution has the required anchors. Phase 4+ can ship a "constitution-bootstrap-with-anchors" template so fresh installs come anchor-ready.

### Validation as prep-work

The Linear ticket calls for "cross-instance validation" against dodi and keepur. Per the 2026-04-27 brainstorm, this is **operator-driven prep-work**, not an automated regression suite. The runtime's automated coverage is in KPR-85 (195 tests + 6 Mongo-gated smokes). KPR-86 validation walks the operator-facing UX once, end-to-end, on real instances, to build confidence before customer hives are exposed.

The plan codifies the validation as a checklist (Tasks 5–10):

- `frame audit hive-baseline dodi` (pre-adopt) — confirms the engine sees the frame.
- `frame apply --adopt hive-baseline dodi` — confirms `--adopt` succeeds; `applied_frames` record is created on dodi.
- `frame audit dodi` (post-adopt) — confirms snapshot matches current state, no drift.
- `frame apply hive-baseline keepur` — confirms full apply writes all 4 asset types correctly; SIGUSR1 picks up changes.
- `frame audit keepur` (post-apply) — confirms snapshot matches.
- **Drift scenario** — manually edit one anchor on dodi → `audit` reports drift → `apply` triggers drift dialog → walk the (a) keep-local, (b) take-frame, (c) merge paths interactively to confirm UX.
- `frame remove hive-baseline keepur` — confirms constitution restores, agents lose the staggered cron, skill bundle removed, `applied_frames` record gone.

Each step is a single command + an expected outcome (prose, not assertions). Operator notes deviations as findings; non-trivial findings get follow-up tickets (per `feedback_pipeline_review_rule.md`).

The validation is "prep-work" not "regression test" because:
- It's run once per real frame authoring session, not on every PR.
- It exercises operator-facing UX (the drift dialog is conversational; not all of it is testable in code).
- Findings flow back into the spec / runtime as refinements (per Linear ticket's "Integration findings" section).

### Frame versioning

`hive-baseline` ships at **`1.0.0`** as the initial public version. Bump policy thereafter follows semver:

- **Patch** (`1.0.x`): typo fixes, prose clarifications, README updates. No behavioral change.
- **Minor** (`1.x.0`): adding a new asset (e.g., another constitution clause), expanding the coreServers list, widening the cron window. Backward-compatible — existing applied instances upgrade cleanly via the runtime's same-version-vs-newer-version diff in `frame apply`.
- **Major** (`x.0.0`): structural manifest change (e.g., a new asset type that didn't exist before), removal of an asset (anchor, skill, server) currently in scope, change of an anchor ID. Operators are prompted via the drift dialog on upgrade; force-overrides may be required.

The first non-trivial bump is likely `1.1.0` when `dodi-ops` (Phase 4+) lands and exposes patterns that prove `hive-baseline` was missing something universal.

### Frame location

For local development: `~/.beekeeper/frames/hive-baseline/`. The runtime's `instance-resolver.ts` (per the epic branch) resolves frame paths from this directory by default; explicit paths also supported for testing.

Registry distribution (`frames.keepur.io`, signed manifests, `frame install hive-baseline`) ships in Phase 4+ per the frames-design spec § "Path to implementation." `hive-baseline` is the first content destined for the registry but does not ship there in this PR.

## Acceptance criteria

- [ ] Frame directory exists at `~/.beekeeper/frames/hive-baseline/` with the layout described in § "Frame layout on disk."
- [ ] `frame.yaml` matches the manifest in § "Manifest YAML — full example."
- [ ] `constitution/memory.md` and `constitution/capabilities.md` are scrubbed of dodi-specific references (operator-spotted in plan-stage review).
- [ ] `skills/memory-hygiene/skills/memory-hygiene-review/SKILL.md` is scrubbed of dodi-specific references.
- [ ] `frame apply --adopt hive-baseline dodi` succeeds; `applied_frames` record exists on dodi; `frame audit dodi` reports clean.
- [ ] `frame apply hive-baseline keepur` succeeds; all 4 asset types write correctly; SIGUSR1 reload picks up changes; `frame audit keepur` reports clean.
- [ ] Drift dialog walked end-to-end against an injected drift case on dodi: (a) keep-local, (b) take-frame, (c) merge paths all confirmed working.
- [ ] `frame remove hive-baseline keepur` restores constitution, removes the cron, removes the skill bundle, deletes the `applied_frames` record.
- [ ] Any spec / runtime refinements surfaced during Tasks 5–10 are filed as follow-up tickets (per `feedback_pipeline_review_rule.md`); small doc fixes can roll into this PR.

## Coordination with sibling tickets

- **KPR-71 `init-instance`** — depends on `hive-baseline` content. The init-instance plan picks up after KPR-86 ships. Init applies the frame as Phase 4 of its workflow.
- **KPR-72 `tune-instance`** — depends on `hive-baseline` content (and on the frame primitives generally). Tune-instance runs `frame audit` as its first step; if `hive-baseline` is the only frame applied, audit returns frame-related findings only when there's actual drift against the frame's content.
- **KPR-83 epic** — KPR-86 closes the epic. After this phase merges to the epic branch, the epic is the candidate for merging to main per `~/.claude/projects/-Users-mokie-github-hive/memory/feedback_merge_strategy.md` (merge commit for the epic preserves phase history; squash for individual phases).
- **KPR-84 / KPR-85** — already merged. KPR-86 consumes the runtime they shipped.

## Open design questions

None. Spec scope is fully captured by the Linear ticket body + the 2026-04-27 brainstorm + the frames-design spec. If real-world authoring (plan execution) surfaces gaps, they get filed as follow-ups per the Linear ticket's "Integration findings" section, not held against this spec.

## Path to implementation

Spec review-clean → KPR-86 advances to plan execution. Plan covers:

1. Scrub-pass on dodi constitution v4 → `constitution/memory.md` + `constitution/capabilities.md`.
2. Extract `memory-hygiene-review` skill bundle from dodi state → `skills/memory-hygiene/skills/memory-hygiene-review/SKILL.md`.
3. Author `frame.yaml` per § "Manifest YAML — full example."
4. Place the frame at `~/.beekeeper/frames/hive-baseline/` and verify directory layout matches what the engine expects.
5. `frame audit hive-baseline dodi` (pre-adopt sanity check).
6. `frame apply --adopt hive-baseline dodi` (claim dodi).
7. `frame audit hive-baseline dodi` (post-adopt clean).
8. `frame apply hive-baseline keepur` (full apply against fresh ground).
9. Drift scenario walkthrough (manual edit → audit → apply → dialog).
10. `frame remove hive-baseline keepur` (full reverse).
11. Refinement findings — file follow-up tickets for non-trivial findings; small fixes roll into this phase's PR.

Estimated 1 day of focused work — content authoring (~2 hours), validation walkthrough (~3 hours), refinement loop (~3 hours).
