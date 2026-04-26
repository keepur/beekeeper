# Frames — Design Spec

**Status:** review-clean  •  **Date:** 2026-04-25  •  **Author:** Mokie (with May)  •  **Review:** prior 4 rounds (R1: 7, R2: 6, R3: 3, R4: 1) plus independent 4-round re-review (R1': 7 SHOULD-FIX, R2': 4, R3': 3, R4': 1, R5': APPROVE)

## Motivation

Across multiple Hive instances (dodi, keepur, personal, future customers), the same operational patterns recur: universal-9 coreServers, memory hygiene cadence, capability discipline, approval delegation, role-spec prompt template. Today these are re-tuned per-instance from scratch — wasteful, drift-prone, and offers no path to share best practices with other Hive operators.

Frames package these patterns into an applyable, removable, auditable unit. They sit between plugins (full code packages with MCP servers and agent seeds) and skills (single procedural units).

## Vocabulary fit

In beekeeping, frames are removable structural units that hold comb. Beekeepers move them between hives to propagate genetics, transfer brood, share resources. The metaphor is exact: modular, swappable, "I want this in every hive I manage."

## What a frame is

A frame is a **configuration overlay** — declarative, non-code. It can contain:

| Asset type | What it modifies |
|---|---|
| Constitution fragments | `db.memory[shared/constitution.md]` (insertion or replacement at section anchors) |
| Skill bundles | `<instance>/skills/<bundle>/` |
| CoreServer additions | `agent_definitions.<agent>.coreServers` (set-union, idempotent) |
| Schedule entries | `agent_definitions.<agent>.schedule` (cron + task) |
| Memory seeds | `agent_memory` (initial durable records, hot tier by default) |
| Prompt clauses | `agent_definitions.<agent>.systemPrompt` (insert at named anchor) |

What a frame is **not**:
- Not a plugin: no MCP server, no runtime code execution by agents, no credential access at the runtime layer. **But not zero-trust** — memory seeds and constitution fragments land directly in agent prompt context, which means a malicious frame is a prompt-injection vector even without code. Treat unverified frames as medium trust. Signing (Phase 2) is the actual control, not the absence of code.
- Not just a skill bundle: skills are one of several asset types; a frame may have zero skills.
- Not branding/theming: operational discipline, packaged.

**Hooks are the exception to "no code execution."** Optional `pre-apply` / `post-apply` hooks (see manifest below) are shell scripts that run on the operator's machine with operator privileges during `frame apply`. They exist for prereq checks and post-apply verification, not runtime agent execution. Trust rules:
- Hooks count as code for signing purposes — Phase 2 signing covers `hooks/` alongside the manifest.
- In Phase 1 (local-only frames), hooks run only from frames sourced from a local directory the operator authored or pulled deliberately. Registry frames don't exist yet.
- In Phase 2+, raw-URL frames (the `--allow-raw` dev escape hatch) cannot run hooks unless the operator passes `--allow-hooks` per-invocation. Registry frames run hooks only if the manifest signature verifies.
- `apply` prints the hook command and prompts before each hook execution unless `--yes` is passed.

## On-disk layout

```
my-frame/
├── frame.yaml                          # manifest
├── README.md                           # human docs
├── constitution/                       # markdown fragments (filenames mirror anchor IDs)
│   ├── memory-tiers.md
│   └── capabilities.md
├── skills/                             # skill bundles, mirrors <instance>/skills/
│   └── memory-hygiene/
│       └── skills/memory-hygiene-review/SKILL.md
├── prompts/                            # named prompt clauses
│   └── role-spec-template.md
├── memory-seeds/                       # durable records by agent
│   └── product-specialist/
│       └── blind-corner-formula.md
└── hooks/                              # optional pre/post-apply scripts
    └── verify.sh
```

## Manifest schema (`frame.yaml`)

```yaml
name: hive-baseline
version: 0.1.0
description: Universal Hive operational baseline
author: keepur
license: MIT

# Compatibility
targets:
  hive-version: ">=0.2.0"

# Composition with other frames
requires: []           # frames that must be applied first
conflicts: []          # frames that cannot coexist

# --- Assets ---

constitution:
  - anchor: capabilities                    # stable ID; the contract
    title: "Your Capabilities"              # display only; informational
    insert: after-anchor "memory"           # or: before-anchor, append-to-anchor, replace-anchor
    file: constitution/capabilities.md
  - anchor: memory
    title: "Manage your memory lifecycle"
    insert: replace-anchor
    file: constitution/memory-tiers.md

skills:
  - bundle: skills/memory-hygiene     # copied to <instance>/skills/memory-hygiene/

coreservers:
  - add: [keychain, contacts, event-bus, conversation-search, callback]
    agents: ["*"]                    # wildcard, list, or selector

schedule:
  # Three forms supported, pick one per entry:
  #
  # (1) Explicit cron — same time for all agents in scope
  - task: morning-briefing
    agents: ["chief-of-staff"]
    cron: "0 8 * * 1-5"
  #
  # (2) Named pattern: shared — all agents fire at the same cron
  - task: end-of-day-summary
    agents: ["*"]
    pattern: shared
    cron: "0 17 * * 1-5"
  #
  # (3) Named pattern: stagger — agents fire at staggered slots within a window
  - task: memory-hygiene-review
    agents: ["*"]
    pattern: stagger
    window: "fri 14:00-17:00 PT"     # required for stagger
    interval: 15m                    # required for stagger; defines slot size
    # Stagger algorithm:
    #   slot_count = floor(window_duration / interval)
    #   agents in scope are sorted by agent_id (deterministic across re-applies)
    #   slot[i] = window_start + i * interval, assigned to agents[i]
    #   if len(agents) > slot_count → apply fails with explicit error;
    #     resolution is to widen the window or reduce agent scope
    #   two frames requesting overlapping windows on the same task → schedule conflict
    #     (existing conflict rule applies)
    #
    #   The derived per-agent (cron, windowSlot) pairs are persisted to
    #   applied_frames.resources.schedule so remove drops exactly the entries this frame
    #   produced. windowSlot is the integer slot index (0..slot_count-1) for stagger,
    #   null for explicit/shared.
    #
    #   Window timezone defaults to the instance timezone from hive.yaml. Override
    #   per-entry by suffixing an IANA zone (e.g., "fri 14:00-17:00 America/Los_Angeles").
    #   The "PT" shorthand above is informal; canonical form uses IANA zones.

memory-seeds:
  - agent: product-specialist
    tier: hot
    file: memory-seeds/product-specialist/blind-corner-formula.md
    dedupe-by: content-hash          # prevents reapply duplicates

prompts:
  - anchor: "role-spec"              # named insertion point in agent's systemPrompt
    agents: ["*"]
    file: prompts/role-spec-template.md

# --- Hooks (optional) ---

hooks:
  pre-apply: hooks/check-prereqs.sh   # exit non-zero to abort
  post-apply: hooks/verify.sh
```

## Apply semantics

`beekeeper frame apply <frame> <instance>` does the steps below.

**`--adopt` short-circuit.** Under `--adopt`, steps 3, 4, 6, and 8 are skipped entirely (no hooks, no asset writes, no reverse-best-effort, no SIGUSR1 — nothing in `agent_definitions` changes so there's nothing to reload). Steps 1, 2 (with anchor-conflict checks relaxed per § Bootstrapping), 5, and 7 still run. The application record captures the *current* state as the baseline. See § Bootstrapping and migration for the full rationale.

`beekeeper frame apply <frame> <instance>` does:

1. **Resolve frame** — local path, registry name, or git URL (registry is the paved path)
2. **Validate** — hive version match; no conflicts with already-applied frames; required frames present; **all referenced anchors and prompt-anchors across every asset type resolve in their target documents** (constitution sections, every in-scope agent's systemPrompt for prompt clauses). Validation is exhaustive across all assets in step 4 — step 4 must not fail on a missing anchor because step 2 caught them all. Missing anchor → abort apply before writing any state, surface as `MissingAnchorError` listing which frame/asset/anchor/agent failed and where it was looked up. Missing anchors are also a first-class drift type in `audit` (treated as "frame state diverged from instance state").
3. **Pre-apply hook** — abort on non-zero
4. **Apply assets** in fixed order:
   - Skills (file copies — purest operation)
   - Memory seeds (dedupe by content hash, then insert)
   - CoreServers (set-union per agent)
   - Schedule (add if not present)
   - Prompts (insert at anchor)
   - Constitution (insert/replace at section anchor) — done last because it's the most visible
5. **Stage application record** in memory (not yet written to `db.applied_frames`):
   ```
   { _id: "hive-baseline",
     version: "0.1.0",
     appliedAt: <date>,
     appliedBy: "<actor-string>",
     manifest: <snapshot>,
     resources: { ...what was actually changed, by agent... } }
   ```
   `appliedBy` format: `"<login>@<host>+beekeeper-<version>"` for human-driven invocations (e.g., `mokie@kraken.local+beekeeper-0.3.0`). Service-driven invocations use `"service:<service-id>+beekeeper-<version>"`. The string is informational for audit, not parsed by code.
6. **Post-apply hook** — abort with cleanup-best-effort on non-zero. If the hook fails, the record is **not written** and reverse-best-effort runs over the partially-applied assets (skills uncopied, seeds removed, coreservers/schedule entries pulled, prompt clauses removed, constitution restored from staged snapshot). If reverse-best-effort itself fails, surface a `PartialApplyError` listing exactly what was written and what could not be reversed — operator can then resolve manually.
7. **Commit application record** to `db.applied_frames` only after hook success and reverse-best-effort is not needed.
8. **SIGUSR1** the hive — agent definitions reload. Skipped for same-version no-drift no-op re-applies (nothing changed in `agent_definitions`, no reload needed). Issued whenever any asset write actually occurred.

All operations are idempotent **for successfully completed applies**: re-applying the same frame at the same version is a no-op when no drift exists, and triggers the drift dialog when drift exists (see "Same-version re-apply" below). A failed apply leaves no `applied_frames` record, so retrying starts fresh.

### Same-version re-apply

`apply` of an already-applied frame at the same version:

- **No drift detected** → silent no-op. The hive is already conformant.
- **Drift detected** → drift dialog runs with the operator. This is the convergence path: an operator who runs `apply` a second time wants to reconverge (e.g., after recovering from a manual edit or a missing anchor). Same-version drift dialog is the same flow as the upgrade-version drift dialog; the only difference is the diff is local-vs-applied-snapshot rather than local-vs-new-manifest.

## Remove semantics

`beekeeper frame remove <frame> <instance>`:

1. **Dependents check** — scan `applied_frames` for any frame whose `requires` includes the target. If any dependent is still applied, fail with `DependencyError: frame <X> depends on <target>; remove <X> first` unless `--force` is passed. Force is recorded in audit log. This check is the *only* guarantee that anchor-dependent constitution clauses don't end up orphaned: if frame B's clause was inserted `after-anchor "capabilities"` (an anchor introduced by frame A), removing A while B is still present would leave B's clause anchored to nothing. The dependents check refuses that operation.
2. Read `applied_frames[<name>].resources` for what was changed
3. Reverse each operation:
   - Skill bundles: delete unless modified locally (sha256 check)
   - Memory seeds: for each seed in this frame's `resources.memorySeeds`, check if any other applied frame's `resources.memorySeeds` lists the same `contentHash`. If yes, leave the seed in place (peer claim still valid) and only drop this frame's claim entry. If no other claim, delete the seed by id.
   - CoreServers: remove only entries this frame added (don't strip ones from other frames or ones added before any frame was applied)
   - Schedule: remove only this frame's task entries
   - Prompts: revert each agent's systemPrompt to the per-agent `snapshotBefore` if no further edits since apply; otherwise drop only the inserted clause text and report a soft-warning if surrounding context shifted
   - Constitution: revert to pre-apply state (we keep a full-text snapshot)
4. Delete `applied_frames` record
5. SIGUSR1

## Drift detection

`beekeeper frame audit <instance>`:

For each applied frame, compare current state to applied snapshot. Report:

- **Constitution anchor modified locally** — text diff against `snapshotBefore` extended to current section text
- **Constitution anchor missing** — anchor was present at apply, gone now (orphaned-anchor drift)
- **Agent A is missing coreServer B that frame added**
- **Agent A's cron Y was removed**
- **Agent A's systemPrompt anchor missing or text drifted at clause insertion**
- **Skill Z modified locally** — sha256 mismatch
- **Memory seed missing** — was inserted at apply, deleted from `agent_memory` since
- **Overridden claim** (informational, not actionable drift) — this frame's claim on a schedule entry, skill bundle, or memory seed was force-displaced by a later frame's apply. `replacedClaimFrom` on the *other* frame's record points back to this one. Surfaced so the operator sees the stomp; not flagged red.

Operator chooses per finding: **re-apply** (overwrite local change), **accept drift** (mark intentional in `applied_frames.driftAccepted`), or **unapply frame** (full reverse).

This is the bridge to `tune-instance`: tune-instance runs `frame audit` first, then walks unframed drift (the audit checklist for things not yet codified into a frame).

## Composition

- Multiple frames stack. Apply order matters for constitution replacements (later wins).
- `requires` enforces dependency order. `conflicts` prevents incompatible combinations.
- CoreServer additions union across frames (no conflict).
- Schedule conflicts → conflict key is `(agent_id, task_name)`, not just `task_name`. Two frames defining `morning-briefing` for different agents is fine and unioned. Two frames defining `morning-briefing` for the same agent with different cron strings → second apply fails unless `--force-override`. Force records both entries' provenance for audit clarity.
- Constitution anchor conflicts (same anchor) → second apply fails unless explicit `replace-anchor` directive.
- Memory seed conflicts (same agent, same content-hash from different frames) → second apply skipped as duplicate, recorded as "shared seed" in both `applied_frames` records so neither remove orphans the other's claim. Different content for same logical seed slot is a frame-author conflict — flag at apply, require `--allow-seed-override`.
- **Skill bundle shared claims** — two frames shipping the same skill bundle with matching sha256 union via the same shared-claim rule as seeds: both record the skill in `resources.skills`, remove of one frame leaves the bundle in place if any other frame still claims it, and only deletes when the last claimant is removed. Mismatched sha256 for the same bundle path is a frame-author conflict requiring `--force-override` (same audit trail rule).
- **Override flags and audit semantics** — `--force-override` (schedule, skills) and `--allow-seed-override` (seeds) record the *replaced* claim's frame id in the new claim's `replacedClaimFrom` field. `audit` reports overridden claims as informational. On remove of the *overriding* frame, the displaced claim is **not** auto-restored — the operator must re-apply the displaced frame to reconverge. Force is a stomp, not a stack; the audit trail makes the stomp visible.

### Wildcard agent selectors

`agents: ["*"]` and any list/selector are evaluated as a **snapshot at apply time**. The set of agent ids matched is recorded in the `applied_frames` resources block, and frame coverage does not auto-extend to agents added later. This keeps apply deterministic and reversible — a remove only touches the agents the frame actually claimed. To extend a frame's coverage to newly added agents, the operator re-runs `apply` (which is idempotent for unchanged agents and adds the new ones, recorded as a same-version drift-free re-apply). `audit` reports "agents not covered by frame" as informational, not as drift, so the operator can decide whether to re-apply.

## Registry distribution

Per the curated-distribution principle:

- **Default registry**: `frames.keepur.io` (Keepur-curated)
- **Custom registries**: configurable in `beekeeper.yaml`
- **Local development**: `~/.beekeeper/frames/<name>/`
- **Raw git URL** (the `--allow-raw` dev-mode escape hatch): off by default; when enabled, prints warning, refuses to run hooks unless `--allow-hooks` is also passed

Frame manifests are signed (post-MVP). Frames have no code execution and no MCP-layer credential access, but their assets land directly in agent prompt context — meaning unsigned third-party frames are a prompt-injection vector. Curation matters as much as for plugins, just on a different attack surface; signing is a real control, not a nicety.

## Storage

New MongoDB collection: `applied_frames` (per instance database).

Schema:
```
{
  _id: <frame-name>,
  version: <semver>,
  appliedAt: <date>,
  appliedBy: <actor>,
  manifest: <full manifest snapshot at apply time>,
  resources: {
    constitution: {
      anchors: ["memory","capabilities"],
      snapshotBefore: "<full-prior-text>",       // entire constitution before apply
      insertedText: { "capabilities": "<...>" }  // per-anchor inserted text, for clause-level remove
    },
    skills: [{ bundle: "<path>", sha256: "<hash-at-apply>", replacedClaimFrom: "<frame-id|null>" }],
    coreservers: { "<agent-id>": [<servers added>] },
    schedule:    { "<agent-id>": [{task, cron, pattern: "explicit|shared|stagger", windowSlot: <int|null>, replacedClaimFrom: "<frame-id|null>"}] },
    memorySeeds: [{ id: "<seed-id>", contentHash: "<hash>", tier: "hot|warm|cold", agent: "<agent-id>", replacedClaimFrom: "<frame-id|null>" }],
    prompts: {
      "<agent-id>": {
        anchors: ["role-spec"],
        snapshotBefore: "<full prior systemPrompt>",  // per-agent snapshot for clean remove
        insertedText: { "role-spec": "<...>" }
      }
    }
  },
  driftAccepted: [
    { resource: "constitution:capabilities",
      decision: "keep-local",
      decidedAt: <date>,
      decidedBy: <actor>,
      reason: "<text>" }
  ]
}
```

Snapshot cost: a full constitution (~12KB) plus per-agent systemPrompt (~5KB × 11 agents ≈ 55KB) gives ~70KB per applied frame. With ~10 frames per instance that's ~700KB — trivial. The cost buys clean reversibility without relying on text-structural assumptions during remove.

## Concrete first frames (extracted from this session's tuning work)

1. **`hive-baseline`** — universal across all Hive instances
   - Constitution: anchors `memory` (with autoDream awareness), `capabilities`
   - Skill: `memory-hygiene-review`
   - CoreServers: completes the universal-9 baseline by adding `keychain`, `contacts`, `event-bus`, `conversation-search`, `callback` to all agents. The other four (`memory`, `structured-memory`, `schedule`, `slack`) are auto-injected by the engine and don't need to be in the frame.
   - Schedule: weekly `memory-hygiene-review` on Friday afternoons, `pattern: stagger`, window `fri 14:00-17:00 PT`, interval `15m`

2. **`dodi-ops`** — DodiHome operational defaults
   - Business-context fragment (team directory, products, what-we-do)
   - Constitution: approval-delegation (§4.1), agents-use-own-name (§4.1)
   - Memory seeds: durable product knowledge (formulas, behaviors)
   - Per-agent prompt clauses (5-line role spec template)

3. **`morning-briefing`** — Mokie's orchestrator pattern
   - Skill bundle: morning-briefing + 5 standup-prep skills
   - Schedule: 7am per-agent prep, 8am orchestrator
   - Prompt clauses for the 5 reporting agents

## Decisions (2026-04-25)

### Stable anchor IDs, not section numbers

Frame manifests reference constitution sections by anchor ID, not section number:

```yaml
constitution:
  - anchor: capabilities          # stable; survives renumbering
    insert: after-anchor "memory"
    file: constitution/capabilities.md
```

Constitution markdown carries explicit anchors:

```markdown
<a id="memory"></a>
### 7.3 Manage your memory lifecycle
...

<a id="capabilities"></a>
### 7.4 Your Capabilities
...
```

`apply` resolves anchor → current section number at apply time. Section numbers can be renumbered freely; anchors are the contract.

**Bootstrap requirement — anchors must pre-exist in the constitution.** Phase 1 ships an anchor-tagging pass over `shared/constitution.md` (and the bootstrap template) that adds `<a id="...">` tags to every section a first-party frame (`hive-baseline`, `dodi-ops`) references. The anchor set is part of the constitution-template contract going forward — adding a new section means adding an anchor at the same time. `apply` does **not** auto-insert anchors; if a referenced anchor is missing, validation aborts with `MissingAnchorError` and the operator must either tag the section manually or back out the frame. Per-agent prompt anchors follow the same rule: agent definitions ship with named insertion-point markers (e.g., `{{role-spec}}`) for any anchors first-party frames target, added in the same Phase 1 pass.

**Two paths converge on the same end state:**
- **Fresh instances** bootstrapped from the post-Phase-1 constitution template already have all first-party anchors and can run `frame apply hive-baseline` directly without `--adopt`.
- **Pre-existing instances** (dodi, keepur as of 2026-04-25) pre-date the anchored template. They get a one-time anchor-tagging migration as part of Phase 1 rollout (a small Beekeeper sub-skill or manual operator step), then run `frame apply hive-baseline --adopt` to claim the already-conformant content. After this, both paths look identical to subsequent `apply`/`audit`.

### `apply` handles upgrades

No separate `upgrade` command. `beekeeper frame apply hive-baseline` against an already-applied instance:

- **Same version** → idempotent no-op
- **Newer version** → diff old manifest vs new manifest → apply only the delta. Removed assets are removed; changed assets go through the drift dialog (below); new assets are added.

This keeps the operator's mental model to one verb.

### Interactive drift dialog (Beekeeper-conversational)

`apply` is interactive when drift is detected. Beekeeper is a Claude Code session, so the UX is conversational — not a shell prompt loop. For each drifted resource:

```
Beekeeper: §7.4 (Your Capabilities) has been edited locally since hive-baseline 0.1.0
           was applied. The new version (0.2.0) ships an updated text.

           Local change: added a paragraph about checking #agent-* channels first.
           Frame change: rewrote the four-step protocol with clearer language.

           Options:
             (a) keep your local edits, skip the frame's update for this section
             (b) take the frame's new version, discard local edits
             (c) merge — let me draft a merged version for you to review
             (d) defer — leave both, audit will continue to flag

May: c

Beekeeper: <produces merged draft, asks for confirmation>
```

This is hard to do well in pure shell. Putting frames behind Beekeeper (Claude Code session, not a thin CLI) is what makes per-resource judgment-with-context tractable.

**A note on merged drafts.** When the operator picks `(c) merge`, Beekeeper produces a draft using the same model that runs the rest of the session — non-deterministic by nature. The merged draft is a starting point, not an authoritative resolution. The operator should review it against both the local change and the frame's intent before confirming, the same way they'd review any agent-generated text destined for the constitution or a systemPrompt.

### Drift acceptance is durable

Choices recorded in `applied_frames[<name>].driftAccepted`:

```
driftAccepted: [
  { resource: "constitution:capabilities",
    decision: "keep-local",
    decidedAt: <date>,
    decidedBy: <actor>,
    reason: "added agent-channel guidance specific to dodi" }
]
```

Subsequent `apply` and `audit` honor these decisions silently — until the frame version changes, at which point the operator is re-asked (the upstream content moved, the prior decision may no longer apply).

**Decisions persist mid-session.** Each per-resource decision is written to `driftAccepted` immediately when made, not at end-of-session. If the operator answers three of five drift items and then closes the terminal, the next `apply` or `audit` resumes from item four — already-decided items are skipped. This makes long drift dialogs interruptible without losing progress.

### Phase 1 scope: local-only

No registry, no signing, no upgrade-from-network in Phase 1. Hand-authored frames in a local directory, applied against local instances. Validate apply/remove/audit loop end-to-end with `hive-baseline` before designing distribution.

### Bootstrapping and migration

`db.applied_frames` is created lazily on first apply — no schema migration is run on existing instances. Hive instances that pre-date frames continue to work unchanged; the collection simply doesn't exist until a frame is applied.

**Existing instances that already conform.** Instances like dodi today already have constitution sections, universal-9 coreServers, hygiene crons, etc. that match what `hive-baseline` would install. Running `frame apply hive-baseline` against such an instance would either (a) detect anchor conflicts and fail, or (b) silently overwrite text that's already identical — neither outcome is what the operator wants.

For this case, `apply` accepts an `--adopt` flag:

- `beekeeper frame apply hive-baseline dodi --adopt`
- Performs **resolvability** checks only: every anchor referenced by the frame must exist in the instance's constitution and agent systemPrompts; the frame's hive-version target must be satisfied. **Adopt skips anchor-conflict checks** (e.g., `replace-anchor` ownership) — the whole premise is that the anchored content is already present. Adopt does not verify that local content matches the frame's content; that comparison happens on the next normal `apply` (newer version) or `audit`, where any divergence becomes drift the operator can resolve through the dialog.
- **Per-agent anchor resolution under selectors.** When a frame's prompt asset uses `agents: ["*"]` (or any list/selector), adopt's resolvability rule is: every agent that matches the selector AND is in scope must already have the named anchor in its systemPrompt. If any matching agent is missing the anchor, adopt fails with `MissingAnchorError` listing the agent ids and the missing anchor — operator either tags the missing agent prompts or narrows the frame's selector before retrying. The same rule applies to non-`--adopt` `apply`.
- **No asset writes.** Records the current state as the `applied_frames` snapshot — the instance is now "claimed by" the frame. Under `--adopt`, `resources.insertedText` is populated with the *current* (already-present) content at each anchor or per-agent prompt clause; that text becomes the baseline against which future `audit` and `apply` diffs run. `resources.constitution.snapshotBefore` and per-agent prompt `snapshotBefore` capture the same state — the pre-write and post-write text are identical at adopt time.
- Subsequent `audit` runs compare against the adoption-time snapshot; subsequent `apply` (newer version) does normal upgrade.

Adopt is the migration path for instances that pre-date frames. It's also useful when an operator manually configured an instance to match a frame's intent and wants to formalize the relationship without a no-op write cycle.

## Path to implementation

Phase 0 (this spec) — agree on shape, naming, MVP scope. ✓ 2026-04-25
Phase 1 — `beekeeper frame init/apply/remove/audit` against local frame directories. No registry. Hand-author `hive-baseline` from this session's artifacts.
Phase 2 — `frames.keepur.io` registry, `beekeeper frame install/list/search`. Sign manifests.
Phase 3 — `tune-instance` calls `frame audit` as its first step.
Phase 4 — public registry, third-party frames, signing-required-by-default.
