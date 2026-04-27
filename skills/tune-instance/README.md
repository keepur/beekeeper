# tune-instance — Operator Guide

Periodic audit-and-tune pass on a Hive instance, surfaced through Beekeeper. The skill walks 9 audit categories (constitution, business-context, per-agent prompts, coreServer baseline, memory tiers, cron→skill wiring, schedules, naming/dignity, frame integrity) on a target hive, bundles drift into a single numbered report, and applies operator-approved findings. It's for the human running Beekeeper — usually the instance owner — and is meant to run roughly every 2 weeks (per the `schedule` frontmatter, which is informational for v1).

## Prerequisites

- Beekeeper installed on the operator machine (`beekeeper install` has run).
- The skill installed at `~/.claude/skills/tune-instance/`. The Beekeeper postinstall step symlinks `<install>/skills/tune-instance/` to that path automatically; verify with `readlink ~/.claude/skills/tune-instance`.
- `mongosh` available on `$PATH` and the instance DB reachable at `mongodb://localhost/hive_<instance-id>`.
- The Beekeeper agent has `admin_save_constitution`, `admin_save_agent`, and `admin_save_memory` MCP tools available (default for the beekeeper agent).

## How to invoke

In any Beekeeper conversation:

- `Run tune-instance on dodi`
- `Tune the keepur instance`
- `Audit dodi (read-only)` — Phase 1 only

The skill resolves the instance from natural-language phrasing. If multiple instances are configured and the message is ambiguous, the skill asks which one. If only one instance is configured, it defaults silently.

## What each phase does

- **Phase 1 — Read-only audit.** Walks the 9 audit steps, collects raw findings, no writes. The operator sees nothing yet.
- **Phase 2 — Operator review.** Bundles findings into one report, numbered with category prefixes (`C/B/P/T/M/K/S/N/F`). The operator responds with a cherry-pick selection. The skill confirms the parsed plan before doing anything; an ambiguous response gets one targeted clarifying question, and a second ambiguous response abandons Phase 3 (Phase 4 still runs).
- **Phase 3 — Apply with consent.** Executes only the findings the operator approved. Each write tags `updatedBy`. Section 1 (Authority, Hard Limits) edits require explicit override unless the change is plain template-drift backfill; ambiguity on a Section 1 finding scopes-out that single finding only, the rest of Phase 3 continues.
- **Phase 4 — Save findings.** Writes a `<runId>.md` doc to `~/services/hive/<instance-id>/tune-runs/` with the report at the top and a JSON block at the bottom mapping each finding's signature to its disposition (applied / deferred / skipped). Updates `_index.md`. The next run reads this to surface deferred findings under "DEFERRED FROM PREVIOUS RUN".

## Cherry-pick syntax

By example. The skill parses these conversationally:

- `apply all` — apply every proposed finding (apply-all-scope caveats from Phase 2 still apply).
- `apply C1, C3, P2; defer M1; skip B2` — explicit per-finding selection.
- `apply C1-C3 and all the M findings; skip the rest` — range + category + skip-rest.
- `apply P2 with trim-role; defer P1` — sub-action selection where a finding offers two paths.

Verbs:
- `apply` — execute the proposed change in Phase 3.
- `defer` — don't apply now, but carry forward into next run's "DEFERRED FROM PREVIOUS RUN" section.
- `skip` — drop entirely; not surfaced again unless the underlying drift recurs.

## Section 1 invariants

Section 1 of the constitution covers Authority and Hard Limits. The skill refuses to edit these silently — the only auto-apply allowed is template-drift backfill (a missing field that the template now requires). Any other Section 1 edit triggers an explicit override prompt: the operator must say something like `override: yes, apply C1 anyway`. Anything ambiguous abandons that single finding (not all of Phase 3) and marks it deferred.

## Frame-managed config

Frames (KPR-83) are operator-authored config bundles applied on top of the instance — for example, a "remote-team" frame that pins certain coreServers and memory hot-tier entries. The skill detects frame-anchored content and refuses to modify it without an explicit bypass like `bypass-frame: yes`. Frame-naive instances (no frames applied) behave identically to the pre-KPR-83 baseline. Frame-integrity findings (category `F`) flag inconsistencies between what a frame declared and what's currently in the instance — these are surfaced in Phase 2 like any other finding.

## Reading the findings doc

```
~/services/hive/<instance-id>/tune-runs/
├── _index.md           # one row per run with date, runId, applied/deferred counts
└── <runId>.md          # full report at top, JSON block at bottom
```

The JSON block at the bottom of `<runId>.md` is the load-bearing artifact for next-run continuity:

```json
{
  "C1": { "signature": "...", "disposition": "applied" },
  "P2": { "signature": "...", "disposition": "deferred" },
  ...
}
```

Signatures are normalized inputs + a fixed verb vocabulary so a re-detection of the same drift collides with the prior signature and surfaces under "DEFERRED FROM PREVIOUS RUN".

## Manual save fallback

If Phase 4's filesystem write fails (disk full, permissions, missing tune-runs dir), the skill emits the full markdown body + JSON block into chat AND posts a Linear comment with the runId. The operator can copy-paste the doc into the right path manually — audit trail survives via two channels.

## Troubleshooting

- **"Skill not loading"** — check `~/.claude/skills/tune-instance/` exists. If it's missing or not a symlink, re-run `beekeeper install`. The postinstall step is idempotent.
- **"Real directory collision warning"** — operator forked the skill previously into `~/.claude/skills/tune-instance/` as a real directory. The installer refuses to clobber operator-owned content. Resolve with `rm -rf ~/.claude/skills/tune-instance` and re-run `beekeeper install` to take the canonical version, OR keep the fork (the warning is informational).
- **"Instance auto-resolution failing"** — pass `<instance-id>` explicitly in the invocation, e.g. `Run tune-instance on dodi`.
- **"SIGUSR1 didn't pick up an agent change"** — verify the running PID with `pgrep -fa "hive-agent <instance-id>"`, then `kill -USR1 <pid>` manually. The skill's apply step emits the exact command to run.

## Cadence

Operator-driven for v1 — the `schedule: every 2 weeks` frontmatter is informational. Run when drift suspicion is high (after a constitution edit, after onboarding a new agent, after a frame change). A follow-up ticket can wire actual cron via Beekeeper's scheduled-task infrastructure if drift detection becomes time-sensitive.

