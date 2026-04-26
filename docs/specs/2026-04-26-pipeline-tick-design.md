# `/pipeline-tick` — Autonomous Ticket Execution Driver

**Status:** draft  •  **Date:** 2026-04-26  •  **Author:** Mokie (with May)

## Motivation

The pipeline we've been running manually — read ticket state from Linear, decide next action, spawn subagents, run review loops, file follow-ups, merge — works mechanically. The trial run on KPR-84 (Frames Phase 1) and KPR-89 (audit-exit-code follow-up) validated the pattern in one session. But:

- It's multi-day async by nature (real PRs span days, not minutes)
- Operator (May) has to type "kick off X" each time something is ready
- Session compaction loses the in-flight state between calls
- The same friction points (commit-the-plan, provision-the-epic-branch) come up every cycle

**`/pipeline-tick`** is the operator-callable (and eventually cron-callable) orchestrator that takes one bounded step through the pipeline whenever invoked. Each tick is short, idempotent, Linear-state-driven. State lives in Linear (workflow + labels + comments) so it survives session boundaries, compactions, and days-long PR review windows.

## Vocabulary

- **Pipeline state machine** — the workflow states and labels established in `reference_pipeline_taxonomy.md`. Source of truth for "what should happen next on this ticket."
- **Tick** — one invocation of `/pipeline-tick`. Short, bounded, idempotent.
- **Action** — a discrete operation the tick performs on a ticket: draft spec, draft plan, pickup, review, merge, file follow-up.
- **Block** — when the tick can't progress a ticket on its own (operator decision needed, CI red, conflict, etc.). Marked via `block:*` labels; operator unblocks.

## What `/pipeline-tick` is

A skill loaded into Beekeeper. Operator (or cron) invokes it. It:

1. Reads ticket state from Linear (workflow status, labels, blockedBy, parent, comments)
2. For each ticket in scope, decides the next action based on state
3. Executes the action — spawning subagents in background where the action is long-running (drafting, implementing, reviewing)
4. Writes back to Linear (workflow status, labels, comments) so the state survives the tick
5. Returns a summary of what happened and what's pending

A single tick may launch multiple background subagents (implementers, reviewers) and then return without waiting. The next tick picks up where this one left off.

## What `/pipeline-tick` is NOT

- Not a long-running daemon. Each tick is a discrete invocation.
- Not a synchronous "run the whole pipeline" call. End-to-end shipping spans many ticks.
- Not a replacement for operator judgment. Decision points (spec sign-off, plan sign-off, scope changes, restricted topics) still surface to the operator.
- Not a CI replacement. CI runs on PR; the tick reads CI status, doesn't run the checks itself.

## Inputs

```
beekeeper pipeline-tick <scope> [flags]
```

**`<scope>`** — one of:
- `<EPIC-ID>` — tick all children of the epic (e.g., `KPR-83`)
- `<TICKET-ID>` — tick a single ticket
- `<TEAM>` — tick all `pipeline-auto` tickets on a team (`Keepur`)
- `--all` — workspace-wide (default if scope omitted)

**Flags:**
- `--dry-run` — print what would happen, don't execute
- `--budget <N>` — cap actions per tick (default: 10 actions)
- `--include-blocked` — also report blocked tickets even though tick can't progress them

## Action table — state × type → action

The decision matrix the tick walks per ticket:

| Workflow state | Type label | Other conditions | Action |
|---|---|---|---|
| Backlog | `type:trivial` | `pipeline-auto` + not blockedBy | → Ready (no spec, no plan). **`type:trivial` is operator-classified — the tick does not auto-classify into trivial.** Operator applies the label during ticket triage. Trivial is reserved for typos, one-line fixes, obvious config — anything where reading the ticket description is sufficient context for the implementer. |
| Backlog | `type:plan-only` | `pipeline-auto` + not blockedBy | spawn plan-drafting subagent → Plan Drafting |
| Backlog | `type:spec-and-plan` | `pipeline-auto` + not blockedBy | spawn spec-drafting subagent → Spec Drafting |
| Backlog | `type:research` | `pipeline-auto` | spawn research subagent → In Progress (output is findings) |
| Spec Drafting | any | spec exists + review-clean | → Plan Drafting (or → Done if `type:research`) |
| Spec Drafting | any | spec exists + review found issues | run review loop subagent (max 3 rounds) |
| Plan Drafting | any | plan exists + review-clean | → Ready |
| Plan Drafting | any | plan exists + review found issues | run review loop subagent |
| Ready | any | not blockedBy + not block:* | spawn implementer subagent → In Progress |
| In Progress | any | implementer succeeded → PR open | → In Review |
| In Progress | any | implementer failed | mark `block:human`, comment diagnostic |
| In Review | any | reviewer not yet run | spawn code-review subagent |
| In Review | any | reviewer APPROVE + CI green | merge per merge-strategy rule, → Done |
| In Review | any | reviewer REQUEST CHANGES | per finding: fix-inline OR file-follow-up; re-run review |
| In Review | any | CI red | mark `block:human`, comment diagnostic |
| In Review | any | merge conflict | mark `block:human`, comment diagnostic |
| Done | any | — | no action |
| Canceled | any | — | no action |
| any | — | `block:human` | report only; no progression |
| any | — | `block:ci` | poll CI; if green or red, transition |
| any | — | `block:external` | report only |

## Per-action contracts

### Drafting actions (spec, plan)

Each drafting action:
1. **Resolves the target repo** from the ticket. The tick reads the ticket description for hints (e.g., "in the Beekeeper repo", "in `~/github/hive`"), or checks a `repo:*` label if present (`repo:hive`, `repo:beekeeper`, etc. — labels TBD; for Phase 1 the description-grep heuristic is sufficient). If neither yields a clear answer, the tick marks `block:human` with a comment asking the operator to specify. **No drafting subagent spawns until the repo is resolved** — otherwise the artifact lands in the wrong tree and is annoying to migrate.
2. Spawns a drafting subagent with the ticket description + relevant context + resolved repo path
3. Drafting subagent writes the artifact to a known location (`docs/specs/YYYY-MM-DD-<topic>.md` or `docs/plans/YYYY-MM-DD-<feature>.md`) inside the resolved repo
4. Tick spawns a review subagent immediately after; up to 5 review rounds (same cap as code review per `feedback_agent_review_workflow.md`)
5. After review-clean, tick commits the artifact to the appropriate epic branch in the resolved repo and pushes
6. Comments on the Linear ticket with the artifact path + repo + review-round count
7. Transitions ticket state forward

**Multi-repo per-ticket** is uncommon but possible (e.g., KPR-88 touches both Hive and Beekeeper). For tickets that legitimately span repos, the tick selects the *primary* repo via the resolution heuristic and lets the implementation step span repos via the implementer subagent's plan execution. This is acceptable for Phase 1; Phase 4 may revisit if multi-repo tickets become common.

### Drafting subagent contract: surface open questions, don't decide them

The drafting subagent (spec or plan) must produce **two outputs in its first pass**:

1. A v1 of the artifact (spec or plan), making the design decisions that ARE clear from the ticket description and surrounding context.
2. A structured list of **open design questions** — anything that requires operator judgment to resolve.

The contract is: **delegate mechanics, surface judgment**. A subagent that guesses on a design question without the operator is wrong; one that produces "here's v1 + the 3 things I can't decide on my own" is right.

If the open-questions list is empty, the tick proceeds normally: spawn reviewer, run review loop, commit, advance state.

If the open-questions list is non-empty, the tick **does not advance state**. Instead:

1. Tick adds `block:human` to the ticket
2. Tick posts a Linear comment with the open-questions list, formatted as numbered items the operator can answer in-line. The v1 draft is committed to a side branch (or to a `_pending_review` directory in the worktree) so the operator can read it alongside.
3. The next `/pipeline-tick` invocation reports `block:human` tickets prominently at the top of its output, with the question count: e.g., `[block:human] KPR-71 (3 questions), KPR-79 (1 question), KPR-82 (1 question)`.
4. Operator answers in Linear comments using a recognizable prefix (`answer:` per question), then removes the `block:human` label.
5. Next tick re-spawns the drafting subagent with the answers as additional context. Subagent produces v2 incorporating the answers. If v2 has no new open questions, advance; if it does, repeat.

This is the discrimination between **Path A (no operator input needed)** and **Path B (operator is the design partner)**. Both paths use the same pipeline mechanics; only the question-list content differs.

**What counts as an open question:**

- Naming choices the ticket leaves underspecified
- Tradeoffs between two approaches with different operator priorities
- Scope decisions (does this ticket include X, or is X a separate concern?)
- Anything that depends on operator-only knowledge (business priorities, customer commitments, restricted topics)
- Anything where the subagent finds itself reasoning "I'll guess and let the reviewer catch it" — that's the signal to surface, not guess

**What does NOT count as an open question** (subagent should decide on its own):

- Mechanical implementation details well-covered by codebase conventions
- Choices between equivalent forms (formatting, file location within an established pattern)
- Test coverage decisions when the testing pattern is established

The subagent's prompt should make this discrimination explicit, with examples drawn from prior trial runs.

### Pickup action

1. Tick verifies the plan is committed to a repo branch (refuses to pick up if plan only exists in operator's workspace untracked)
2. Tick verifies the epic branch exists; if missing, creates and pushes it
3. Spawns implementer subagent with plan path + repo path + epic branch name
4. Implementer creates worktree, executes plan tasks in order, opens PR, returns PR URL
5. Tick comments PR URL on Linear ticket and transitions to In Review

### Review action

1. Tick spawns code-reviewer subagent with PR URL + plan reference + pipeline review rule (passed explicitly in the prompt so the reviewer's behavior is anchored, not inferred).
2. Reviewer returns structured output with two parts: per-finding severity list AND a top-level verdict.
3. **Tick parses findings, not just the verdict.** The pipeline rule (`feedback_pipeline_review_rule.md`) says APPROVE means zero BLOCKER and zero SHOULD-FIX. The tick re-asserts this: if the reviewer returned APPROVE but the findings list contains any BLOCKER or SHOULD-FIX, the tick treats it as REQUEST CHANGES. Reviewer's verdict alone is not load-bearing — the rule is. This guards against reviewer prompt drift and was the load-bearing failure mode caught in the KPR-84 trial.
4. If parsed-as-APPROVE (zero BLOCKER, zero SHOULD-FIX): tick checks CI status; if green, merge per merge-strategy rule; if red, mark `block:ci`. NICE-TO-HAVE findings are dropped silently or filed as low-priority follow-ups if they cluster (same-area improvements).
5. If parsed-as-REQUEST-CHANGES: per BLOCKER and SHOULD-FIX finding, decide fix-inline (default for `type:trivial` and for findings the reviewer marks as "fix-in-this-PR") vs file-follow-up (for findings the reviewer marks as "file-follow-up" or that are explicitly Phase N+1 polish). Operator can override the default.
6. After fixes/follow-ups land, re-run review (max 5 rounds — feedback memory budget). If 5 rounds don't converge, mark `block:human` with the residual findings.

### Merge action

Per `feedback_merge_strategy.md`:
- Phase merging into epic branch → merge-commit (preserves phase history)
- Single-purpose PR to main → squash
- Epic branch to main → merge-commit (preserves phase history of the epic)

After merge:
- Mark ticket Done
- Auto-cleanup worktree + feature branch
- Comment merge SHA on Linear ticket

## State persistence

**Linear is the state machine.** No external state file. The tick reads:

- `state` (workflow status)
- `labels` (`type:*`, `block:*`, `qa:*`, `pipeline-auto`, `epic`)
- `blockedBy` (issue dependencies)
- `parent` (epic membership)
- `attachments` (PRs auto-attached by GitHub integration)
- `comments` (the audit trail — pipeline writes its own comments here)

Each pipeline action writes a Linear comment with: action taken, who/what executed it, timestamp, outcome, link to artifact (commit SHA, PR, file path). Operator can audit by scrolling the ticket.

## Failure modes

The tick is conservative. It blocks rather than guesses when something is wrong:

| Failure | Action |
|---|---|
| Subagent returns error | `block:human`, comment with subagent's last message |
| CI red after merge attempt | `block:ci`, comment with check status |
| Merge conflict | `block:human`, comment "rebase needed" |
| Plan-review didn't converge in 5 rounds | `block:human`, comment with last round's findings |
| Implementer ran out of budget | `block:human`, comment with progress so far |
| Linear API error | retry once, then bail tick with diagnostic |
| Unknown ticket state | report only; don't progress |

**Default unblock flow** (applies to `block:human` and `block:external`):

1. Operator addresses the underlying issue (rebasing a conflict, fixing a CI failure, providing a missing decision)
2. Operator posts a comment on the ticket explaining what was done — this is the resolution evidence and survives the unblock
3. Operator removes the `block:*` label

The tick on the next run reads the most recent comment on the ticket. If the last comment is the original block diagnostic (no resolution evidence between block and unblock), the tick re-applies the block label with a "no resolution evidence found" comment, refusing to retry blindly. Operator must add at least a one-line resolution note before the unblock holds. This guards against the failure mode where removing a label respawns the implementer into the same broken conditions.

**Exception — `block:ci` auto-clears.** Unlike the other blocks, `block:ci` does **not** require operator action or evidence. The tick re-checks CI status on every pass; if CI is green when read, the block clears automatically. If CI is red, the block stays. The operator's role for `block:ci` is to push a fix to the branch (which triggers a new CI run); no Linear interaction needed. This is structurally different from `block:human`/`block:external` because the resolution signal (CI status) is observable by the tick directly.

| Block label | Auto-clears? | Operator action to unblock |
|---|---|---|
| `block:human` | No | Resolve issue + post evidence comment + remove label |
| `block:external` | No | Same as above |
| `block:ci` | Yes | Push fix to branch; tick clears block on next pass when CI flips green |

## Notifications

**Phase 1 (MVP):** all output goes to the tick's own stdout. Operator-driven invocation, operator reads the result.

**Phase 2:** Linear comments only. Operator gets Linear's native notifications.

**Phase 3:** Optional Slack post per ticket transition (configurable via `notify:slack` label or per-team setting). Most useful for: PR-opened, review-clean, merged, blocked.

## Concurrency

A single tick may spawn multiple background subagents (e.g., one implementer per Ready ticket, one reviewer per In Review PR). The tick returns without waiting; subagents finish on their own and trigger the next tick to pick up the new state.

**Cap per tick — split into two budgets:**
- `--spawn-budget <N>` (default: 3) — caps actions that spawn long-running background subagents (implementer pickup, drafting, reviewing). The expensive kind; saturates compute if uncapped.
- `--action-budget <N>` (default: 25) — caps total actions including cheap bookkeeping (state transitions, label updates, comment writes).

The `--spawn-budget` is the practical limit; the `--action-budget` is a safety rail against runaway label-rewriting loops.

### Per-ticket mutual exclusion

The tick uses a **comment-based run-id mechanism** for race-detectable serialization. A label-only approach doesn't work: Linear's add-label is idempotent, so two ticks racing both see no label, both call `save_issue`, both get success, neither can detect they raced.

**Mechanism:**

The tick writes structured comments with a recognizable prefix and a comment-type tag:

- `tick-lock-claim: runId=<ulid> action=<name>` — issued before action
- `tick-lock-release: runId=<ulid> outcome=<spawned|transitioned|skipped>` — issued after action
- `tick-spawn-log: runId=<ulid> agentId=<id>` — issued when a background subagent is spawned

These three are pipeline-tick metadata and are scanned/filtered as a class.

Each tick generates a unique `runId` at the start (e.g., `tick-<ulid>`). At the start of each per-ticket decision:

1. **Read** the ticket's comments and find the most recent **`tick-lock-claim`-type** comment specifically (filtering out `tick-lock-release`, `tick-spawn-log`, and any non-pipeline comments). If that claim has a *different* runId and was posted within the last 60s (TTL), this ticket is in flight elsewhere — skip. If the most recent `tick-lock-claim` already shows a matching `tick-lock-release` afterward, the prior tick released; safe to proceed.
2. **Claim:** post `tick-lock-claim: runId=<this-ulid> action=<name>`.
3. **Verify:** re-read the ticket's comments and again find the most recent **`tick-lock-claim`-type** comment specifically. If it is your own runId, you hold the lock. If it is a *different* runId posted between your step-1 read and your step-2 write, you lost the race; back off. (Filtering to `tick-lock-claim` is essential — interleaved `tick-lock-release` or `tick-spawn-log` comments from other pipeline activity on the same ticket would otherwise produce a false negative.)
4. **Act:** perform the action. For background subagents, post a `tick-spawn-log` comment with the agentId.
5. **Release:** post `tick-lock-release: runId=<this-ulid> outcome=<spawned|transitioned|skipped>`. The lock is held only for the duration of the spawn or state-write — not for the duration of the spawned subagent's work.

This gives true race detection: comment ordering is server-assigned and globally consistent, and the type-filter ensures the verify step reads the lock contest specifically rather than the most recent comment of any kind.

**Phase 1 limitation acknowledged:** the read-then-write claim sequence still has a small window where two ticks both pass step 1 and write claims at nearly the same time. Step 3's verify catches this — the loser's claim is not the most recent `tick-lock-claim` when re-read. The TTL bounds how long a stale claim persists (60s) so a tick that crashed mid-action doesn't permanently lock a ticket.

**Phase 3 (cron-driven) escalation:** if multiple cron'd ticks fire concurrently, this comment-based scheme still works — the global comment ordering is the authoritative record. If race volume becomes high enough that the verify step fails frequently, escalate to a DB-side mutex (Beekeeper's local SQLite) or leader election. Flag in open questions.

## Implementation phases

### Phase 1 (MVP) — manual invocation, Linear state, single-team

- Operator-callable: `beekeeper pipeline-tick <scope>`
- Reads Linear state, executes action table, writes back
- Spawns subagents in background; doesn't wait
- Returns a summary of actions taken
- No Slack, no cron

Concretely: this is what we've been doing manually in this conversation. Phase 1 codifies it.

### Phase 2 — Linear-comment audit trail + better diagnostics

- Each action writes a structured Linear comment
- Failed actions include the subagent's last error message in the comment
- Tick output can read prior comments to skip already-attempted actions

### Phase 3 — Cron-driven autonomous mode

- Tick can be invoked by cron (or by Beekeeper's own scheduler)
- Per-team cadence configuration
- Optional Slack notifications for human-relevant events
- Self-healing: retry transient failures (CI flake, network blips) once before blocking

### Phase 4 — Beyond MVP

- Cross-epic priority queue (when many epics' children are Ready, which to pick up first?)
- Budget per epic (cost cap on subagent compute)
- Meta-review cadence (the sampling-review pattern from the original PR-review discussion)

## Where it lives

`@keepur/beekeeper` repo, under `src/skills/pipeline-tick/` or similar. Loaded into Beekeeper's session as a slash command. Not a separate process; runs in-session when invoked.

Owned by Beekeeper because:
- Spawns subagents — needs the agent-spawning APIs
- Mutates Linear at the API level
- Drives merges via `gh` CLI
- Must run with operator-tier authority (can write to repos, can merge PRs)

This is the same authority profile as `tune-instance` (KPR-72) and `frame` (KPR-83). All three are Beekeeper skills.

## Open questions

1. **Cron-callable mode (Phase 3)** — does cron invoke `beekeeper pipeline-tick` directly, or does it go through some Hive-side scheduler that knows about Beekeeper? If the latter, we need a Hive→Beekeeper trigger surface.
2. **Multi-instance scope.** Today Beekeeper manages 2+ instances (dodi, keepur). Pipeline-tick is per-team in Linear (Keepur), but the actions might touch hive engine repo + per-instance state. Is the ticket scope-by-Linear-team, or scope-by-instance, or both?
3. **Implementer subagent type.** We've been using `general-purpose`. Should we ship a dedicated `pipeline-implementer` subagent type with a specific prompt template baked in?
4. **Reviewer subagent calibration.** The pipeline-review-rule (APPROVE = zero SHOULD-FIX) was just adopted. The reviewer prompts in this codebase don't yet enforce it consistently — they sometimes return APPROVE with SHOULD-FIX (we caught one in the KPR-84 trial). Pipeline-tick should explicitly remind the reviewer of the rule, or we should bake it into the reviewer's system prompt.
5. **What happens when a sibling phase (e.g., KPR-85 Frames Phase 2) becomes unblocked while a tick is running?** Pickup is bounded per tick; the next tick gets it. Acceptable, but should we surface "now-unblocked" tickets in tick output even though we won't act on them?
6. **Operator override.** What's the explicit way for an operator to say "skip this ticket, I'll handle it manually"? Probably: remove `pipeline-auto` label.

## Path to implementation

- **Phase 0 (this spec)** — design + name + agreed action table.
- **Phase 1** — implement the Phase-1 MVP, including subagent prompt templates as constants.
- **Phase 2** — Linear comment audit trail.
- **Phase 3** — cron + Slack.
- **Phase 4+** — optimization based on observed friction.

Phase 1 is the unblocker. Once it ships, the operator's role compresses from "type 'kick off X' for each ticket" to "type '/pipeline-tick KPR-83' once and read the summary."
