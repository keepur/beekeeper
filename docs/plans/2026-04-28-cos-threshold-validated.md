# KPR-109: pin cosSeeded threshold to engine-shipped default CoS template

## Context

KPR-71 (PR #41) shipped `detectInstanceState()` with a `checkCosSeeded` helper
that flags a CoS agent's `systemPrompt` as operator-tuned when its length
exceeds `COS_PROMPT_NONDEFAULT_THRESHOLD = 200` chars. The 200 was a guess
with a `// TODO(post-KPR-86)` calling for replacement once hive-baseline
content was finalized.

KPR-86 (closed 2026-04-28) is now finalized. Two options were proposed in
KPR-109: wire the threshold from a frame manifest constant (Option A) or
pin the threshold to the actual default content + epsilon plus a
content-based test fixture (Option B). May's intake direction selects
Option B as faster and verifiable.

## Where the canonical default actually ships

The hive-baseline frame at `~/.beekeeper/frames/hive-baseline/` does NOT ship
a per-agent default `systemPrompt`. The frame's scope is constitution
anchors, skills, coreservers, and schedule cadence. Per-agent default
prompts are not part of the frame contract.

The canonical default CoS `systemPrompt` is shipped by the **engine repo**
(`hive`) at `~/github/hive/seeds/chief-of-staff/agent.yaml`. The
`hive` setup wizard reads this seed and inserts it verbatim into
`agent_definitions` (only `name` and `channels` are customized at install
time). So this is the literal content that lives in MongoDB on a freshly
seeded but un-tuned instance — exactly the state `cosSeeded` should detect
as "frame-template baseline only."

This divergence from the original KPR-109 framing (which assumed the frame
ships the template) does not change the fix shape — Option B's recipe
("measure actual default + epsilon, lock with a content fixture") still
applies; we just measure against the engine seed instead of a frame
artifact. The path comment in source will reflect the engine repo location.

## Measurement

Source: `~/github/hive/seeds/chief-of-staff/agent.yaml`, `systemPrompt`
field (YAML block scalar, lines 29-36).

```
You are the Chief of Staff agent. Your role:
- Coordinate across agents when needed
- Handle administrative tasks
- Advise the owner on agent team management
- Troubleshoot agent issues

Always be direct, concise, and actionable.

```

Length: **230 characters** (rendered scalar, including the trailing newline
that YAML's `|` block scalar keeps).

The current 200-char threshold is a **false positive** against this
content: a freshly-seeded CoS with the engine's default prompt produces
`cosSeeded === true` (230 > 200) and `detectInstanceState` would
incorrectly report such an instance as `completed` (assuming the other
three booleans were also true). KPR-109's symptom prediction was
correct.

## Threshold choice

Set `COS_PROMPT_NONDEFAULT_THRESHOLD = 280`.

- 230 (engine default) + 50 epsilon = 280.
- 50 epsilon is enough headroom to absorb minor template polish (a couple
  added bullet points, a sentence-level expansion) without forcing a
  threshold bump.
- 280 is comfortably below typical operator-tuned CoS prompts. Reference
  point: this repo's own `agents-personal/chief-of-staff/system-prompt.md`
  is 8,813 chars; the dodi plugin's tuned seeds run 1,000-3,000 chars.
  Even a "lightly tuned" operator prompt (a few short paragraphs of
  voice, role, guardrails) clears 280 trivially.

## Test fixture approach

Add a verbatim copy of the engine seed's default `systemPrompt` to the
test as `ENGINE_DEFAULT_COS_PROMPT`. Add a new test case that exercises
the threshold's realistic boundary:

- "returns cosSeeded=false when CoS prompt is the engine-shipped default
  verbatim" — feed the 230-char default into the mock, expect
  `cosSeeded === false` (the boundary case the current heuristic gets
  wrong).

Rename the existing `SHORT_PROMPT` ("frame template baseline only" — 30
chars) usage in the matching test from "frame-template baseline length"
to "well below frame-template baseline length" so the two cases are
distinct.

Keep `LONG_PROMPT = "a".repeat(250)` — wait, 250 < 280 now; need to bump
this to clear the new threshold. Update to `"a".repeat(400)` so the
"completed" test continues to exercise an operator-tuned-length prompt.

## Source changes

`src/init/detect-instance-state.ts`:

1. Bump `COS_PROMPT_NONDEFAULT_THRESHOLD` from 200 to 280.
2. Replace the existing TODO comment + the inline note "(frame template
   baseline is ~120)" with a derivation comment:

   ```
   /**
    * Minimum systemPrompt length to consider CoS "operator-tuned" rather
    * than engine-default seed.
    *
    * Pinned to the engine-shipped default CoS systemPrompt length (230
    * chars) plus a 50-char epsilon for minor template polish.
    *
    * Source of truth: hive repo `seeds/chief-of-staff/agent.yaml`
    * `systemPrompt` field. The setup wizard inserts that seed verbatim
    * into `agent_definitions` on a fresh install, so a freshly-seeded
    * instance produces a 230-char prompt and we want to detect that as
    * NOT operator-tuned.
    *
    * If the engine default grows past 230 chars (template polish, new
    * bullet, expanded role description), update the constant here AND
    * the matching test fixture (ENGINE_DEFAULT_COS_PROMPT in the test).
    */
   ```

3. Update the `cosSeeded` field jsdoc on `InstanceStateDetail` to drop
   the "(frame template baseline is ~120)" parenthetical and the
   "magic number" caveat — the value is now derivation-anchored, not
   guessed.

`src/init/detect-instance-state.test.ts`:

1. Add `ENGINE_DEFAULT_COS_PROMPT` constant — verbatim copy of the seed
   `systemPrompt` value, including the trailing newline.
2. Bump `LONG_PROMPT` from `"a".repeat(250)` to `"a".repeat(400)` so it
   clears the new 280 threshold.
3. Add a new test case after the existing "returns cosSeeded=false when
   CoS prompt is at frame-template baseline length" test:

   ```
   it("returns cosSeeded=false when CoS prompt is the engine-shipped default verbatim", ...)
   ```

   This is the realistic boundary case — fixture is the literal default,
   asserts `cosSeeded === false`.

No other test changes — the existing tests using `LONG_PROMPT` continue
to assert `cosSeeded === true` and the new 400 length still clears 280.

## Out of scope

- Wiring a frame-manifest constant at runtime (Option A in the ticket).
- Fetching the engine default at runtime by walking the engine repo or
  npm tarball — adds I/O and a runtime dependency on engine repo layout
  for what is fundamentally a static heuristic.
- Reworking `detectInstanceState`'s state decision rules.

## Verification

`npm run check` clean (typecheck + lint + format + test).

The new "engine-shipped default verbatim" test will fail against the
current 200 threshold (230 > 200 → `cosSeeded === true` → `state === "fresh"`
expectation fails) and pass against the new 280 threshold. That is the
explicit demonstration that the fix is content-anchored.

## Risk

Low. Local constant change, two test fixture additions, no runtime API
or schema change. False-negative risk (operator-tuned prompt < 280
chars) is minimal — a serious tune adds either a soul block, a role
description, or guardrails, all of which push past 280 trivially.

## Followups (not in this PR)

- If KPR-86's hive-baseline frame ever ships agent prompt content (it
  currently does not — frame scope is constitution + skills +
  coreservers + schedule), revisit Option A: wire threshold from a
  frame manifest constant. Filing as a stub note in the source comment
  ("If hive-baseline ever takes ownership of the CoS default prompt,
  read the threshold from there instead.") would be premature — we'd
  do that ticket if and when the architectural shift happens.
