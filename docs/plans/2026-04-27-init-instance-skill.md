# Init-Instance Skill Implementation Plan

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan. Each task is self-contained; commit after each.
>
> **STATUS — gated on KPR-83 Phase 2 (`frame apply` write primitives) AND Phase 3 (`hive-baseline` frame content).** Spec and plan can land now; implementation must wait until both ship so the frame primitives + universal Section 1 / role→tool registry / universal-9 baseline / 5-line prompt template that Phase 4 calls into are real and importable. KPR-85 (Phase 2) shipped to the epic branch; KPR-86 (Phase 3 / `hive-baseline` content) is in spec+plan flight as of 2026-04-26. Confirm both are "Done" in Linear (or merged into epic and ready for cutover) before opening a worktree against this plan.

**Goal:** Ship a Beekeeper-owned agentic skill `init-instance` that initializes a fresh Hive instance via a 5-phase Beekeeper conversation (discover → propose → operator-review → apply → handoff). The skill interviews the operator, authors constitution Section 2 from interview output, applies the `hive-baseline` frame for Section 1 + universal-9 + role→tool registry + 5-line prompt template, seeds a single operator-tuned Chief-of-Staff agent, and hands off to CoS via a memory-seeded welcome record so CoS's first conversation already carries operator context.

**Architecture:** A new `skills/init-instance/` directory under the Beekeeper repo holds the skill (`SKILL.md` playbook + operator-facing `README.md`). Skill auto-discovery is unchanged: the existing postinstall step (shipped by KPR-72 Task 8) symlinks `skills/<name>/` → `~/.claude/skills/<name>/` for every bundled skill, so adding `init-instance` to the bundled set is the only wiring change. **No new MCP servers** — the skill consumes `admin_save_constitution`, `admin_save_agent`, `admin_save_memory`, the KPR-85 `frame apply` write primitives, and direct mongosh access the Beekeeper agent already has. A new shared TypeScript primitive `detectInstanceState()` lives at a single import path consumed by both Phase 0 (idempotency) and Phase 4 (mid-run resume detection) so the two cannot disagree about what "initialized" means.

**Tech Stack:** Markdown for the skill body. TypeScript (NodeNext, strict) + Vitest for `detectInstanceState()` + the (likely already-shipped) installer wiring. ESM `.js` import extensions throughout. No `any` in production code.

**Spec reference:** `docs/specs/2026-04-26-init-instance-skill-design.md` (review-clean, Linear KPR-71).

**Sibling skill plan (style + installer reference):** `docs/plans/2026-04-26-tune-instance-skill.md` (KPR-72) — same author, same skill shape, same installer surface. This plan mirrors its task structure.

---

## File Structure

### Files to create

| File | Responsibility |
|---|---|
| `skills/init-instance/SKILL.md` | The playbook the Beekeeper agent loads when the skill is invoked. Frontmatter (`name`, `description`, `agents: [beekeeper]`) + Phase 0 pre-flight + Phase 1 interview script + Phase 2 propose + Phase 3 operator review + Phase 4 apply + Phase 5 handoff + idempotency + failure-recovery contracts. Targets ~350–450 lines (interview script + phase prose are the bulk). |
| `skills/init-instance/README.md` | Operator-facing how-to: when to run, what each phase does, what to expect from the interview, what gets written, troubleshooting. ~80–100 LOC. |
| `src/lib/instance-state.ts` | The shared `detectInstanceState()` primitive (see spec §"detectInstanceState() — shared primitive"). Returns `InstanceState` type. Read-only — no writes. |
| `src/lib/instance-state.test.ts` | Vitest coverage: fresh / partial / completed detection across the four detail booleans + `lastInitRunId` / `lastInitAppliedAt` best-effort introspection. |

### Files to modify

| File | Reason |
|---|---|
| `package.json` | Confirm `"skills/"` is in the `files` array (already added by KPR-72 Task 2). If absent, add it. New skill auto-ships once the directory exists. |
| `src/service/skill-installer.ts` | If KPR-72's installer hard-codes `SKILL_NAME = "tune-instance"`, refactor to iterate over a list `["tune-instance", "init-instance"]` (or to discover bundled skills dynamically). If it already iterates, this file is unchanged. |
| `src/service/skill-installer.test.ts` | Mirror the installer change with test coverage for the second skill being symlinked alongside the first. Skip if installer already iterates. |

### Files NOT touched

- No `src/agents/`, no MCP server source — the skill consumes existing `admin_*` MCP surfaces + `frame apply` primitives only.
- No `src/index.ts` — the skill is a plugin auto-discovered at config-load time; no wiring change.
- No `bootstrap.sh` modification in this plan — per spec §"Distribution" line 403, the `bootstrap.sh` change (drop generic constitution rendering + generic CoS seed; print "open Beekeeper and run init-instance" instead) is plan-stage scope BUT lives in the hive engine repo, not in beekeeper. A redirect-note PR to hive will be filed alongside this plan's PR; this plan covers the beekeeper-side work only.

---

## Task 1: Skill directory + frontmatter scaffold

**Files:**
- Create: `skills/init-instance/SKILL.md` (frontmatter + heading skeleton only — phase content lands in Tasks 3–9)

- [ ] **Step 1.1:** Create the skill directory and write the frontmatter + scaffold to `skills/init-instance/SKILL.md`. Frontmatter MUST match the spec §"Skill identity, distribution, and load path" (`name`, `description`, `agents: [beekeeper]`, NO `schedule:` — this is one-shot per instance, not recurring).

```markdown
---
name: init-instance
description: Initialize a fresh Hive instance via Beekeeper conversation. Interviews the operator, authors constitution Section 2, applies the hive-baseline frame, and seeds an operator-specific Chief-of-Staff agent. Hands off to CoS with operator context in memory.
agents: [beekeeper]
---

# Init Instance

You are about to initialize a fresh Hive instance. Your job is to interview the operator, author the operator-specific constitution Section 2, apply the `hive-baseline` frame for the platform-shared Section 1 and structural defaults, seed a single Chief-of-Staff agent shaped to the operator's voice and team, and hand off to CoS via a memory-seeded welcome record. You are operating from outside the hive — agents do not self-modify (constitution §1.16). Mutations go through `admin_*` MCP tools and the `frame apply` write primitives from KPR-85.

## Operating principles

[FILLED IN BY TASK 3]

## Inputs

[FILLED IN BY TASK 3]

## runId allocation

[FILLED IN BY TASK 3]

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
```

This scaffold lets later tasks fill in sections without merge-conflicting if work is parallelized. `[FILLED IN BY TASK N]` markers must NOT remain in the final file — Task 14 verifies they're all gone.

- [ ] **Step 1.2:** Verify

```bash
test -f skills/init-instance/SKILL.md && head -5 skills/init-instance/SKILL.md
```

Expected: file exists; first 5 lines show the frontmatter open + `name: init-instance`.

- [ ] **Step 1.3:** Commit

```bash
git add skills/init-instance/SKILL.md
git commit -m "feat(skill): scaffold init-instance SKILL.md with frontmatter"
```

---

## Task 2: Confirm `skills/` ships in npm tarball

**Files:**
- Possibly modify: `package.json`

**Note:** KPR-72 Task 2 added `"skills/"` to the `package.json#files` array. If that landed, this task is a no-op verification. If it did not (e.g., KPR-72 plan was reordered), add it.

- [ ] **Step 2.1:** Inspect `package.json` for `"skills/"` in the `files` array.

```bash
grep -A 6 '"files":' package.json
```

  - **If `"skills/"` already present:** skip to Step 2.3 (no-op verification).
  - **If `"skills/"` absent:** add it between `"dist/"` and the next entry per the KPR-72 plan's diff (Task 2 of `2026-04-26-tune-instance-skill.md`).

- [ ] **Step 2.2:** (Only if Step 2.1 added the entry) Verify the new skill ships in the tarball.

```bash
npm pack --dry-run 2>&1 | grep "skills/init-instance/SKILL.md"
```

Expected: line printed showing `skills/init-instance/SKILL.md` is included.

- [ ] **Step 2.3:** Verify the existing skill (if KPR-72 already shipped) still ships and the new one rides along.

```bash
npm pack --dry-run 2>&1 | grep "skills/.*/SKILL.md"
```

Expected: both `skills/tune-instance/SKILL.md` AND `skills/init-instance/SKILL.md` listed (or just the latter if KPR-72 hasn't merged yet).

- [ ] **Step 2.4:** Commit (skip if Step 2.1 was a no-op)

```bash
git add package.json
git commit -m "feat(skill): include skills/ directory in npm tarball"
```

---

## Task 3: Operating principles + Inputs + runId allocation sections

**Files:**
- Modify: `skills/init-instance/SKILL.md`

This task fills the three opening sections that establish the skill's posture and configuration. Verbatim ports + light paraphrase from spec.

- [ ] **Step 3.1:** Replace the `## Operating principles` section with the following (synthesizes spec §"Reframe context", §"Goals", §"Non-goals" into a four-bullet posture statement):

```markdown
## Operating principles

- **Interview-first; never seed without operator input.** The whole point of this skill is that operator context is the load-bearing input. Do not auto-fill team structure, comms norms, or CoS shaping from defaults beyond what the frame supplies.
- **Phases 1–3 mutate nothing.** No Mongo writes, no filesystem writes (other than transient in-memory transcript state) until Phase 4. Operator approval gates every durable write.
- **Initial-agent scope = JUST CoS.** Other agents are described by the operator during the interview but provisioned post-init by CoS using the frame's role→tool registry. This skill bootstraps the agent who provisions the org chart; it does not provision the org chart.
- **Refuse re-init by default; partial-state resume on demand.** Use `detectInstanceState()` (see spec §"detectInstanceState() — shared primitive"); branch on `fresh` / `partial` / `completed`. Refuse `completed` unless explicitly overridden with `force re-init <instance-id>`.
```

- [ ] **Step 3.2:** Replace the `## Inputs` section with the spec's "Inputs" content (spec §"Inputs", lines 91–98). Verbatim port:

```markdown
## Inputs

The skill takes one input from the operator's invocation:

- `<instance-id>` — string matching a configured Hive instance (the one `bootstrap.sh` just provisioned, or one the operator names freshly). Resolves to:
  - `~/services/hive/<instance-id>/` for skills, frames, and operator-level config
  - `mongodb://localhost/hive_<instance-id>` for the instance database

If no instance is given, the skill asks the operator. If `bootstrap.sh` ran moments before and only one fresh instance exists, the skill defaults silently to that one and confirms.
```

- [ ] **Step 3.3:** Replace the `## runId allocation` section with the spec's "runId allocation" content (spec §"runId allocation", lines 100–106). Verbatim port:

```markdown
## runId allocation

At Phase 1 entry the skill allocates a fresh ULID (`<runId>`) that flows through the rest of the run:

- Phase 1: tags the in-memory interview transcript.
- Phase 4: every Mongo write tags `updatedBy: "beekeeper-init-instance:<runId>"`; the seeded CoS memory record carries `seedRunId: <runId>` for traceability.
- Phase 5: the handoff memory record references `<runId>` so future Beekeeper or CoS introspection can trace back to "this is what was seeded at init."
```

- [ ] **Step 3.4:** Verify

```bash
grep -c "FILLED IN BY TASK" skills/init-instance/SKILL.md
grep -c "Operating principles\|## Inputs\|## runId allocation" skills/init-instance/SKILL.md
```

Expected: FILLED-IN markers count drops from 9 to 7; the three new section headers present.

- [ ] **Step 3.5:** Commit

```bash
git add skills/init-instance/SKILL.md
git commit -m "feat(skill): init-instance operating principles, inputs, runId allocation"
```

---

## Task 4: `detectInstanceState()` shared primitive + CLI wrapper

**Files:**
- Create: `src/lib/instance-state.ts`
- Create: `src/lib/instance-state.test.ts`
- Modify: `src/cli.ts` — add `init-state` subcommand routing

**Why a TypeScript primitive, not skill-inline mongosh queries:** spec §"detectInstanceState() — shared primitive" explicitly mandates a single import path so Phase 0 (idempotency) and Phase 4 (mid-run resume detection) cannot disagree about what "initialized" means.

**How the SKILL.md playbook invokes it:** the Beekeeper agent runs `beekeeper init-state <instance-id> --json` via Bash. The CLI subcommand wraps `detectInstanceState()` and prints a JSON object to stdout (`{"state":"fresh|partial|completed","detail":{...},"lastInitRunId":"...","lastInitAppliedAt":"..."}`) plus exits 0 on success. The skill parses the JSON to determine the branch. This matches the established beekeeper CLI pattern (`frame audit/apply/remove`, `pipeline tick`) — no new MCP servers, no cross-repo coordination, no `code` runner assumptions. Tested in isolation via the Vitest module tests; integration-tested via Task 15's e2e dry-run which spawns `beekeeper init-state` against fresh / partial / completed fixtures.

- [ ] **Step 4.1:** Create `src/lib/instance-state.ts`:

```typescript
import { MongoClient } from "mongodb";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logging/logger.js";

const log = createLogger("instance-state");

export type InstanceState = {
  state: "fresh" | "partial" | "completed";
  detail: {
    section2Written: boolean;
    frameApplied: boolean;
    cosSeeded: boolean;
    handoffMemoryWritten: boolean;
    lastInitRunId: string | null;
    lastInitAppliedAt: Date | null;
  };
};

export type DetectInstanceStateInput = {
  instanceId: string;
  servicePath: string;       // ~/services/hive/<instanceId>/
  mongoUri: string;          // mongodb://localhost/hive_<instanceId>
  /** Default CoS slug; per spec §"Open design questions" item 3, default is `chief-of-staff` but operator may rename during interview. Detection accepts either the default OR a list of known overrides if Phase 0 is invoked after Phase 1. v1 only checks the default. */
  cosAgentId?: string;       // default: "chief-of-staff"
};

const SECTION_2_ANCHOR_PATH = "shared/business-context.md";
const APPLIED_FRAMES_COLLECTION = "applied_frames";
const HIVE_BASELINE_FRAME_ID = "hive-baseline";
const AGENT_DEFINITIONS_COLLECTION = "agent_definitions";
const AGENT_MEMORY_COLLECTION = "agent_memory";

/**
 * Detect whether an instance is fresh (no init artifacts), partial (some
 * but not all init artifacts present), or completed (all four init
 * artifacts present).
 *
 * Per spec §"detectInstanceState() — shared primitive":
 *   - All four detail booleans `true`  → "completed"
 *   - All four `false`                  → "fresh"
 *   - Any other combination             → "partial"
 *
 * Best-effort `lastInitRunId` / `lastInitAppliedAt`: read from the most
 * recent `applied_frames` record's `appliedBy` (parsing the embedded ULID)
 * OR from the `seedRunId` field on the handoff memory record. Null if not
 * resolvable; Phase 0 prose to operator just omits the timestamp.
 */
export async function detectInstanceState(
  input: DetectInstanceStateInput,
): Promise<InstanceState> {
  const { instanceId, servicePath, mongoUri, cosAgentId = "chief-of-staff" } = input;
  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const db = client.db();

    // 1. Section 2 written? Look for the constitution doc with operator-authored Section 2 prose
    //    at the anchor introduced by the frame. Prefer a Mongo-backed check via the agent_memory
    //    document for shared/constitution.md (if the engine stores constitution there) OR fall back
    //    to a filesystem check on shared/business-context.md.
    const section2Written = await checkSection2Written(db, servicePath);

    // 2. Frame applied? applied_frames has a hive-baseline record.
    const frameRecord = await db
      .collection(APPLIED_FRAMES_COLLECTION)
      .findOne({ frameId: HIVE_BASELINE_FRAME_ID });
    const frameApplied = frameRecord !== null;

    // 3. CoS seeded? agent_definitions has cosAgentId with a non-default systemPrompt.
    //    "Non-default" = not equal to the bare frame template. Heuristic: presence of an
    //    operator-context section in the prompt OR length > frame-template-length-threshold.
    const cosSeeded = await checkCosSeeded(db, cosAgentId);

    // 4. Handoff memory written? agent_memory has a record on cosAgentId with metadata.seededBy.
    const handoffRecord = await db
      .collection(AGENT_MEMORY_COLLECTION)
      .findOne({
        agentId: cosAgentId,
        "metadata.seededBy": "beekeeper-init-instance",
      });
    const handoffMemoryWritten = handoffRecord !== null;

    // Best-effort lastInitRunId / lastInitAppliedAt
    const { lastInitRunId, lastInitAppliedAt } = extractLastInitMetadata(
      frameRecord,
      handoffRecord,
    );

    const detail = {
      section2Written,
      frameApplied,
      cosSeeded,
      handoffMemoryWritten,
      lastInitRunId,
      lastInitAppliedAt,
    };

    const allTrue =
      section2Written && frameApplied && cosSeeded && handoffMemoryWritten;
    const allFalse =
      !section2Written && !frameApplied && !cosSeeded && !handoffMemoryWritten;

    const state: InstanceState["state"] = allTrue
      ? "completed"
      : allFalse
        ? "fresh"
        : "partial";

    log.info("detectInstanceState", { instanceId, state, detail });
    return { state, detail };
  } finally {
    await client.close();
  }
}

async function checkSection2Written(db: ReturnType<MongoClient["db"]>, servicePath: string): Promise<boolean> {
  // Primary: Mongo-backed agent_memory doc for shared/constitution.md with operator Section 2 anchor.
  // Fallback: filesystem check on <servicePath>/shared/business-context.md.
  const constitutionDoc = await db
    .collection(AGENT_MEMORY_COLLECTION)
    .findOne({ key: SECTION_2_ANCHOR_PATH });
  if (constitutionDoc !== null) {
    // Heuristic: presence of a Section 2 anchor with non-empty operator-authored content.
    const content = (constitutionDoc as { content?: string }).content ?? "";
    return /<!--\s*section-2:start\s*-->[\s\S]+<!--\s*section-2:end\s*-->/.test(content)
      && content.match(/<!--\s*section-2:start\s*-->([\s\S]+?)<!--\s*section-2:end\s*-->/)?.[1]?.trim() !== "";
  }
  return existsSync(join(servicePath, "shared", "business-context.md"));
}

async function checkCosSeeded(db: ReturnType<MongoClient["db"]>, cosAgentId: string): Promise<boolean> {
  const cosDoc = await db
    .collection(AGENT_DEFINITIONS_COLLECTION)
    .findOne({ agentId: cosAgentId });
  if (cosDoc === null) return false;
  // Non-default heuristic: systemPrompt length > 200 chars (frame template alone is ~120) AND
  // includes at least one operator-context marker (operator name, team list, etc.).
  // TODO(post-KPR-86): replace the magic 200 with a frame-manifest constant
  // (e.g., `FRAME_TEMPLATE_BASELINE_LENGTH` exported from the hive-baseline manifest)
  // so this check tracks frame-template growth automatically.
  const systemPrompt = (cosDoc as { systemPrompt?: string }).systemPrompt ?? "";
  return systemPrompt.length > 200;
}

function extractLastInitMetadata(
  frameRecord: { appliedBy?: string; appliedAt?: Date } | null,
  handoffRecord: { metadata?: { seedRunId?: string; seededAt?: Date } } | null,
): { lastInitRunId: string | null; lastInitAppliedAt: Date | null } {
  // Prefer handoff record (carries seedRunId verbatim); fall back to frame record's appliedBy.
  const seedRunId = handoffRecord?.metadata?.seedRunId ?? null;
  const seededAt = handoffRecord?.metadata?.seededAt ?? null;
  if (seedRunId !== null) {
    return { lastInitRunId: seedRunId, lastInitAppliedAt: seededAt };
  }
  // Frame record's appliedBy is shaped like "beekeeper-init-instance:<runId>" — parse the ULID.
  const appliedBy = frameRecord?.appliedBy ?? "";
  const m = appliedBy.match(/^beekeeper-init-instance:([0-9A-HJKMNP-TV-Z]{26})$/);
  return {
    lastInitRunId: m?.[1] ?? null,
    lastInitAppliedAt: frameRecord?.appliedAt ?? null,
  };
}
```

- [ ] **Step 4.2:** Wire the CLI subcommand. Open `src/cli.ts` and add a route for `init-state` mirroring the existing `pipeline-tick` subcommand handler. The handler derives `servicePath` and `mongoUri` inline from `instanceId` using the documented convention (`~/services/hive/<id>/` + `mongodb://localhost/hive_<id>`) — these are NOT yet on the `BeekeeperConfig` type, and `resolveInstance()` is a KPR-85 deliverable that hasn't merged to main yet, so we derive directly:

```typescript
// In src/cli.ts argv-router (mirror the existing pipeline-tick case):
case "init-state": {
  const instanceId = argv[1];
  const json = argv.includes("--json");
  if (!instanceId) {
    console.error("usage: beekeeper init-state <instance-id> [--json]");
    process.exit(2);
  }
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const { detectInstanceState } = await import("./lib/instance-state.js");
  const result = await detectInstanceState({
    instanceId,
    servicePath: join(homedir(), "services", "hive", instanceId),  // ~/services/hive/<id>/
    mongoUri: `mongodb://localhost/hive_${instanceId}`,             // hive_<id> per spec
    // cosAgentId omitted — defaults to "chief-of-staff"; Phase 0 can override
  });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`state: ${result.state}`);
    for (const [k, v] of Object.entries(result.detail)) console.log(`  ${k}: ${v}`);
    if (result.lastInitRunId) console.log(`lastInitRunId: ${result.lastInitRunId}`);
    if (result.lastInitAppliedAt) console.log(`lastInitAppliedAt: ${result.lastInitAppliedAt.toISOString()}`);
  }
  process.exit(0);
}
```

(The exact router shape depends on the current `src/cli.ts` argv-parsing convention — read the existing `pipeline-tick` case before writing this; if it switches on `argv[0]`, mirror that shape exactly. The contract is: `beekeeper init-state <id> --json` emits the JSON shape returned by `detectInstanceState()` to stdout, exits 0; without `--json` emits human-readable lines. **Forward-compat note:** once KPR-83 epic merges to main and `resolveInstance()` becomes available, the inline derivation can be replaced with a call to it for consistency with `frames/cli.ts` — but the inline path stays correct regardless, since it implements the same convention.)

- [ ] **Step 4.3:** Create `src/lib/instance-state.test.ts` with Vitest coverage. Use an in-memory or local-fixture Mongo (e.g., `mongodb-memory-server` if already a dev dep, otherwise spin a real `mongodb://localhost` test database `hive_init_state_test_<random>` and clean up after each test).

  Test cases (one `it()` each):
  - **fresh**: empty Mongo, no filesystem `shared/business-context.md` → returns `state: "fresh"`, all four detail booleans `false`.
  - **completed**: all four artifacts present (constitution doc with Section 2 anchor, applied_frames record for hive-baseline, agent_definitions for chief-of-staff with prompt > 200 chars, agent_memory record with `metadata.seededBy: "beekeeper-init-instance"`) → returns `state: "completed"`, all four `true`.
  - **partial — Section 2 only**: constitution Section 2 written, others absent → returns `partial`, only `section2Written: true`.
  - **partial — Phase 4 mid-run failure**: 4a, 4b, 4c done (Section 2 written + frame applied) but 4d–4f missing → returns `partial`, two booleans true.
  - **lastInitRunId from handoff record**: handoff memory record present with `metadata.seedRunId: "01HW..."` → returned verbatim.
  - **lastInitRunId from frame fallback**: handoff missing, frame record present with `appliedBy: "beekeeper-init-instance:01HW..."` → ULID parsed.
  - **lastInitRunId both absent**: returns `null`.
  - **CoS prompt below threshold**: agent_definitions has chief-of-staff but with frame-default prompt < 200 chars → `cosSeeded: false` (catches the "frame applied but operator interview not yet baked in" intermediate state).

- [ ] **Step 4.4:** Verify

```bash
npm run typecheck
npx vitest run src/lib/instance-state.test.ts
# CLI smoke (will fail without a Mongo instance — that's fine, smoke is the help/usage path):
node dist/cli.js init-state || echo "expected usage exit"
```

Expected: typecheck clean; all instance-state tests green; CLI prints usage when no instance-id is provided.

- [ ] **Step 4.5:** Commit

```bash
git add src/lib/instance-state.ts src/lib/instance-state.test.ts src/cli.ts
git commit -m "feat(init): detectInstanceState() shared primitive + CLI wrapper + tests"
```

---

## Task 5: Phase 0 — Pre-flight + state detection

**Files:**
- Modify: `skills/init-instance/SKILL.md`

- [ ] **Step 5.1:** Replace the `## Phase 0 — Pre-flight + state detection` section with the spec's content from spec §"Phase 0 — Pre-flight (instance-state detection)", lines 108–151. Port verbatim, structured as:

  1. **Intro paragraph** explaining that Phase 0 calls `detectInstanceState()` (cross-link to `src/lib/instance-state.ts`) before Phase 1 starts, and branches on `fresh` / `partial` / `completed`.
  2. **Three branch paragraphs**:
     - `fresh` → proceed to Phase 1 normally.
     - `partial` → surface detected partial state to operator (which artifacts are present, which are missing, last `appliedAt` if known); ask "Resume from where init left off, or redo from scratch?". Resume → re-run Phase 1 only for not-yet-written pieces. Redo → remove existing partial artifacts (with operator confirmation per artifact, since destructive) and proceed to Phase 1 fresh.
     - `completed` → refuse with: `"instance <id> is already initialized (Section 2 written, frame applied, CoS seeded, last init at <appliedAt>). To update Section 2, hire new agents, or fix drift, use the tune-instance skill (KPR-72) or a future cos:hire-agent skill. To re-init from scratch anyway, confirm explicitly with 'force re-init <instance-id>'."` On explicit `force re-init` confirmation, behave as if state were `partial` with `redo from scratch` selected.
  3. **`detectInstanceState()` contract subsection** — short prose pointing the agent at the CLI invocation: "Run `beekeeper init-state <instance-id> --json` via Bash; the command prints a JSON object `{state, detail, lastInitRunId, lastInitAppliedAt}` to stdout. Branch on the returned `state` field." Then list the four detail booleans + the decision rule (all-true → completed; all-false → fresh; mixed → partial). DO NOT inline the TypeScript signature here; the SKILL.md is operator-prose, not code-spec. Just say: "see `src/lib/instance-state.ts` for the canonical implementation. Both Phase 0 and Phase 4 invoke the same CLI subcommand so they cannot disagree about what 'initialized' means."
  4. **Optional Phase 0.5 dep check** (per spec §"Open design questions" item 1, lean: yes) — Mongo running, Qdrant up, Ollama present. Fail-fast with a clearer error than a Mongo connection failure mid-Phase-4. If any dep is down: "Operator, before we start the interview: <dep> isn't reachable. Check `bootstrap.sh` ran fully, then re-invoke."

- [ ] **Step 5.2:** Verify

```bash
grep -c "fresh\|partial\|completed\|force re-init\|detectInstanceState" skills/init-instance/SKILL.md
grep -c "FILLED IN BY TASK" skills/init-instance/SKILL.md
```

Expected: state-machine references >= 8; FILLED-IN markers drop from 7 to 6.

- [ ] **Step 5.3:** Commit

```bash
git add skills/init-instance/SKILL.md
git commit -m "feat(skill): Phase 0 pre-flight + detectInstanceState branching"
```

---

## Task 6: Phase 1 — Discover (operator interview)

**Files:**
- Modify: `skills/init-instance/SKILL.md`

This is the largest content task — the interview script is the bulk of the SKILL.md. Verbatim port from spec §"Phase 1 — Discover (operator interview)", lines 153–223.

- [ ] **Step 6.1:** Replace the `## Phase 1 — Discover (operator interview)` section with the spec's content. Structure:

  1. **Intro paragraph** — Beekeeper opens a structured conversation with the operator. The interview produces three outputs, written in memory only at this phase:
     - Section 2 raw notes (operator's answers, ready to be drafted into prose at Phase 2)
     - CoS shaping notes (voice/tone, working hours, escalation tolerance, proactive vs reactive, topic routing)
     - Initial agents the operator describes (names + role sketches, NOT provisioned in Phase 4 — written to handoff memory record so CoS knows what to spin up next)

  2. **Interview script** — port spec lines 161–206 verbatim, all 8 sections:
     - **§1. Operator identity and authority** (operator-specific; no frame default)
     - **§2. Company / operation context** (operator-specific)
     - **§3. Team structure** (operator-specific)
     - **§4. Communication norms** (operator-specific; some frame defaults to confirm)
     - **§5. Approval delegation** (operator-specific values; frame-supplied shape)
     - **§6. Working environment** (operator-specific)
     - **§7. Chief-of-Staff shaping** (CoS-specific; frame supplies role/tool defaults, operator fills voice/scope)
     - **§8. Initial agents the operator wants spun up next** (NOT provisioned; written to CoS handoff memory)

  Each section: header with the question category + bullet list of questions verbatim from spec.

  3. **"Script is a guide, not a strict order" paragraph** — port verbatim from spec line 206: Beekeeper-the-agent reads the situation conversationally; if the operator volunteers Section 4 content while answering Section 2, Beekeeper rolls with it and circles back to anything missing at the end.

  4. **What Beekeeper reads from the frame vs asks the operator** table — port verbatim from spec lines 210–223. This is critical for plan-stage wiring; the table makes the frame-vs-interview boundary explicit.

- [ ] **Step 6.2:** Verify

```bash
grep -c "Operator identity\|Company / operation\|Team structure\|Communication norms\|Approval delegation\|Working environment\|Chief-of-Staff shaping\|Initial agents" skills/init-instance/SKILL.md
grep -c "frame default\|operator-specific" skills/init-instance/SKILL.md
grep -c "FILLED IN BY TASK" skills/init-instance/SKILL.md
wc -l skills/init-instance/SKILL.md
```

Expected: all 8 interview-section headers present; >= 6 `frame default`/`operator-specific` callouts (the explicit boundary cues); FILLED-IN markers drop to 5; total file length grows ~80–120 lines.

- [ ] **Step 6.3:** Commit

```bash
git add skills/init-instance/SKILL.md
git commit -m "feat(skill): Phase 1 operator interview script (8 sections + frame/operator boundary table)"
```

---

## Task 7: Phase 2 — Propose (Section 2 + frame + CoS profile drafts)

**Files:**
- Modify: `skills/init-instance/SKILL.md`

- [ ] **Step 7.1:** Replace the `## Phase 2 — Propose (drafts to operator)` section with the spec's content from spec §"Phase 2 — Propose (drafts to operator)", lines 225–237. Verbatim port covering:

  1. **Intro** — Beekeeper produces three drafts and shows them to the operator in one consolidated proposal (mirroring `tune-instance` Phase 2 numbered findings, but smaller — 3 macro-items here instead of dozens).

  2. **Three drafts** (header per draft + content description):
     - **Draft 1 — Constitution Section 2 draft.** Markdown. Written in the structure the frame anchors expect (team, comms, approval delegation, working environment). Operator-readable. Beekeeper drafts in operator's voice based on Phase 1 notes, signs the draft as "from Beekeeper, awaiting your approval."
     - **Draft 2 — Frame application plan.** Which frame (`hive-baseline` for v1, possibly `dodi-ops` or other operator-named frames if KPR-86 has shipped them and the operator opts in), with what selectors. For v1 this is just `hive-baseline` with `agents: ["*"]` (which at init time matches CoS only, since CoS is the only agent — frame coverage extends naturally as CoS adds agents post-init via re-apply, per the frames spec § Wildcard agent selectors).
     - **Draft 3 — CoS profile draft.** Soul + systemPrompt + coreServers + initial memory seed:
       - **Soul** — drafted from Phase 1 §7 voice/tone notes.
       - **systemPrompt** — 5-line role-spec template from the frame, filled with operator's CoS-shaping notes (identity, scope, boundary, tools, guardrail).
       - **coreServers** — universal-9 baseline from the frame, no role-specific extras (CoS's role-specific extras come from the frame's CoS-specific clauses if `hive-baseline` ships them, or are left to CoS to request post-init).
       - **Initial memory seed** — structured hot-tier records carrying operator identity, team roster, comms norms, approval delegation values; the structured form of Phase 1 interview output. This is what makes CoS "pre-tuned" on her first conversation.

  3. **Single consolidated proposal note** — port spec line 236: drafts emitted as one consolidated proposal; format mirrors `tune-instance` Phase 2 numbered findings but smaller (3 macro-items: Section 2, frame application, CoS profile). Each draft shown in full; operator can request edits.

- [ ] **Step 7.2:** Verify

```bash
grep -c "Section 2 draft\|Frame application plan\|CoS profile draft" skills/init-instance/SKILL.md
grep -c "soul\|systemPrompt\|coreServers\|memory seed\|universal-9" skills/init-instance/SKILL.md
grep -c "FILLED IN BY TASK" skills/init-instance/SKILL.md
```

Expected: three draft headers present; >= 5 CoS-profile-component references; FILLED-IN markers drop to 4.

- [ ] **Step 7.3:** Commit

```bash
git add skills/init-instance/SKILL.md
git commit -m "feat(skill): Phase 2 propose — Section 2 + frame + CoS profile drafts"
```

---

## Task 8: Phase 3 — Operator review with parsing-failure contract

**Files:**
- Modify: `skills/init-instance/SKILL.md`

- [ ] **Step 8.1:** Replace the `## Phase 3 — Operator review` section with the spec's content from spec §"Phase 3 — Operator review", lines 239–247. Verbatim port covering:

  1. **Three response shapes**:
     - **Approve all** — `"looks good"`, `"apply"`, `"ship it"`.
     - **Edit and re-show** — `"change Section 2 paragraph 3 to say X"`, `"the CoS systemPrompt should be more concise"`. Beekeeper revises and re-emits affected draft(s); operator re-reviews.
     - **Defer one piece** — `"hold off on the CoS profile, I want to think about her voice more — apply Section 2 and the frame for now"`. Beekeeper applies the approved subset and writes a partial state record (so Phase 0's `detectInstanceState()` returns `partial` on next invocation).

  2. **Parsing-failure contract** — port spec line 245 verbatim:
     - If skill cannot confidently parse a response, asks ONE targeted clarifying question rather than guessing.
     - TWO consecutive ambiguous responses in the same review → skill exits Phase 3 without applying anything (no partial state written) and reports: `"review response unclear; re-invoke init-instance when ready."`
     - Differs from `tune-instance` Phase 2: init's review is smaller (3 items, not dozens), so abandoning is cheaper than partial-application; init defaults conservative.

  3. **Post-approval transition** — port spec line 247: after explicit approval, Beekeeper proceeds to Phase 4.

- [ ] **Step 8.2:** Verify

```bash
grep -c "Approve all\|Edit and re-show\|Defer one piece\|Parsing-failure" skills/init-instance/SKILL.md
grep -c "FILLED IN BY TASK" skills/init-instance/SKILL.md
```

Expected: all four contract headers present; FILLED-IN markers drop to 3.

- [ ] **Step 8.3:** Commit

```bash
git add skills/init-instance/SKILL.md
git commit -m "feat(skill): Phase 3 operator review + parsing-failure contract"
```

---

## Task 9: Phase 4 — Apply (six durable steps + KPR-85 integration)

**Files:**
- Modify: `skills/init-instance/SKILL.md`

This is the second-largest content task — the apply step ordering + frame primitive integration is the heart of the skill's contract with KPR-85 and KPR-86.

- [ ] **Step 9.1:** Replace the `## Phase 4 — Apply` section with the spec's content from spec §"Phase 4 — Apply", lines 249–270. Verbatim port covering:

  1. **Intro paragraph** — Beekeeper executes approved drafts as a sequence of writes, using KPR-83 Phase 2 (KPR-85) `frame apply` primitives where applicable. Each step writes durably before the next begins, so partial-state recovery has structured intermediate states.

  2. **Step ordering table** — port the 6-row table from spec lines 256–263 verbatim:

```markdown
| Step | Mechanism | Durable artifact |
|---|---|---|
| 4a. Render Section 1 from frame | Frame primitive (KPR-85) emits Section 1 + structural anchors into `db.memory[shared/constitution.md]` | `agent_memory` record for `shared/constitution.md` |
| 4b. Insert Section 2 prose | Direct `admin_save_constitution` (Phase 1 frame primitives are read-only; Section 2 is operator-authored, not frame-managed) at the Section 2 anchor introduced by the frame in 4a. The anchor's stable name (e.g. `section-2`) is defined in the `hive-baseline` frame manifest (KPR-86 deliverable); plan-stage picks it up from there. | Same `agent_memory` doc, updated |
| 4c. Apply `hive-baseline` frame | `frame apply hive-baseline <instance-id>` — the rest of the frame's assets (skills, schedules, prompt anchors, memory seeds, coreservers) | `applied_frames.hive-baseline` record |
| 4d. Render initial CoS agent definition | `admin_save_agent` with the Phase 2 draft (soul + systemPrompt + universal-9 coreServers + role-specific extras from the frame's prompt clauses) | `agent_definitions.<cos-id>` record + `agent_definition_versions` row |
| 4e. Seed CoS memory | `admin_save_memory` (or direct insert into `agent_memory` collection) with structured records from Phase 1 interview output — operator identity, team roster, comms norms, approval delegation values | `agent_memory` records tagged with `seedRunId: <runId>` |
| 4f. Stamp template version | Write `constitution-template-version: <semver>` field into the constitution doc's metadata so KPR-72 can detect template drift later | Same `agent_memory` doc, metadata |
```

  3. **`updatedBy` tagging rule** — port spec line 264: every Mongo write tags `updatedBy: "beekeeper-init-instance:<runId>"` (or, for `applied_frames`, the frame primitive's `appliedBy` carries an equivalent ULID per frames spec § Apply semantics).

  4. **Post-write SIGUSR1 + verify** — port spec lines 266–268:
     - SIGUSR1 the running hive: `kill -USR1 $(pgrep -f "hive-agent <instance-id>")` — agent definitions reload without a full restart. (For a truly fresh instance, the hive process may not be running yet; in that case Phase 4 ends and Phase 5 reminds the operator to start the hive service.)
     - Verify: re-query each affected doc to confirm the writes landed; report any failures to the operator.

  5. **Failure mid-Phase-4** — port spec line 270 verbatim: each step durably committed before the next runs. If 4d fails (e.g., admin tool errors), operator told which steps succeeded (4a, 4b, 4c) and which failed (4d) and what's still missing (4e, 4f). On re-invocation, `beekeeper init-state <id> --json` returns `partial` with detail showing 4a-4c done, 4d-4f missing, and Phase 0 routes to resume.

- [ ] **Step 9.2:** Verify

```bash
grep -c "4a\|4b\|4c\|4d\|4e\|4f" skills/init-instance/SKILL.md
grep -c "admin_save_constitution\|admin_save_agent\|admin_save_memory\|frame apply" skills/init-instance/SKILL.md
grep -c "updatedBy\|SIGUSR1\|partial" skills/init-instance/SKILL.md
grep -c "FILLED IN BY TASK" skills/init-instance/SKILL.md
```

Expected: all 6 step labels present; >= 4 admin/frame primitive references; >= 3 traceability/restart references; FILLED-IN markers drop to 2.

- [ ] **Step 9.3:** Commit

```bash
git add skills/init-instance/SKILL.md
git commit -m "feat(skill): Phase 4 apply — six durable steps with KPR-85 frame primitives"
```

---

## Task 10: Phase 5 — Handoff to CoS

**Files:**
- Modify: `skills/init-instance/SKILL.md`

- [ ] **Step 10.1:** Replace the `## Phase 5 — Handoff to CoS` section with the spec's content from spec §"Phase 5 — Handoff to CoS", lines 272–315. Verbatim port covering:

  1. **Intro** — Beekeeper writes a final hot-tier memory record on the CoS agent describing what just happened.

  2. **Handoff record schema** — port the YAML-ish block from spec lines 277–297 verbatim:

```yaml
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

  3. **Hot-tier surface note** — port spec line 299: hot tier reads records directly (no embeddings dependency), so this record surfaces in CoS's prompt context on her first turn. CoS's first conversation reads this naturally — no special "first conversation" code path; first-time vs nth-time is just memory contents.

  4. **Operator next-steps message** — port the message block from spec lines 304–313 verbatim:

```markdown
Init complete for <instance-id>.
Constitution Section 1 + Section 2 written.
Frame `hive-baseline` applied.
CoS agent `<cos-id>` seeded with <N> hot-tier memory records.

Next steps:
  - Start the hive service if it isn't running: `launchctl kickstart -k gui/$(id -u)/com.hive.<instance-id>.agent`
  - Send a message to <cos-id> in Slack — she's pre-tuned with your operator context and ready to pick up the team-building you described.
  - When ready to spin up the agents you mentioned (X, Y, Z), ask <cos-id> in Slack — she'll use the frame's role→tool registry to provision them.
```

  5. **No run-artifact file in v1** — port spec line 315 verbatim: unlike KPR-72's `tune-runs/<runId>.md`, init does not write a per-run findings doc. Audit trail is the `updatedBy: "beekeeper-init-instance:<runId>"` tags across affected Mongo docs plus the Phase 5 handoff memory record (which carries `seedRunId` + synthesized operator context). Conversation context is not durable — only artifacts are. Deliberate scope choice: init has three macro writes (constitution, frame apply, CoS) versus tune-instance's dozens of remediations, and the tagged Mongo docs are sufficient to reconstruct what was seeded. If a future need arises (e.g. multi-operator review of historical inits), an `init-runs/<runId>.md` artifact can be added without breaking compatibility.

- [ ] **Step 10.2:** Verify

```bash
grep -c "seedRunId\|seededBy\|seededAt\|hot-tier" skills/init-instance/SKILL.md
grep -c "Init complete\|launchctl kickstart\|Next steps" skills/init-instance/SKILL.md
grep -c "FILLED IN BY TASK" skills/init-instance/SKILL.md
```

Expected: traceability metadata references >= 4; operator-message references present; FILLED-IN markers drop to 1.

- [ ] **Step 10.3:** Commit

```bash
git add skills/init-instance/SKILL.md
git commit -m "feat(skill): Phase 5 handoff — hot-tier memory record + operator next-steps"
```

---

## Task 11: Idempotency on re-init

**Files:**
- Modify: `skills/init-instance/SKILL.md`

- [ ] **Step 11.1:** Replace the `## Idempotency` section with the spec's content from spec §"Idempotency", lines 384–391. Verbatim port:

```markdown
## Idempotency

Init is fundamentally a one-shot per instance. The idempotency story:

- **`fresh` → run produces `completed`** (or `partial` on failure). Re-running on `completed` refuses by default; operator must explicitly `force re-init` to repeat.
- **`partial` → resume produces `completed`** without re-doing the durable work. The operator may re-answer interview questions for not-yet-written pieces (conversation context isn't replayable).
- **`force re-init` on `completed`** is treated as `partial` with `redo from scratch` — destructive, requires per-artifact operator confirmation (per spec §"Open design questions" item 2: per-artifact, finding-by-finding confirmation, NOT category-grouped).

This is *not* the same idempotency contract as `tune-instance` (which expects clean re-runs to produce zero structural findings). Init is not designed for clean re-runs because the operator interview is a one-shot creative input. Re-running init on the same instance is a recovery mechanism, not a first-class expected operation.
```

  Note: the spec line about `force re-init` granularity (spec §"Open design questions" item 2) settles on per-artifact finding-by-finding confirmation — bake that into the prose explicitly.

- [ ] **Step 11.2:** Verify

```bash
grep -c "force re-init\|fresh.*completed\|partial.*completed\|per-artifact" skills/init-instance/SKILL.md
grep -c "FILLED IN BY TASK" skills/init-instance/SKILL.md
```

Expected: idempotency state-machine references >= 4; FILLED-IN markers drop to 1 (Failure recovery, filled in by Task 12).

- [ ] **Step 11.3:** Commit

```bash
git add skills/init-instance/SKILL.md
git commit -m "feat(skill): idempotency contract on re-init"
```

---

## Task 12: Failure recovery — partial-state resume

**Files:**
- Modify: `skills/init-instance/SKILL.md`

- [ ] **Step 12.1:** Replace the `## Failure recovery` section with the spec's content from spec §"Failure modes", lines 374–381. Port the seven failure modes verbatim, structured as a numbered list:

  1. **Operator abandons Phase 1 mid-interview.** No artifacts written; state stays `fresh`. Re-invocation starts from scratch.
  2. **Phase 3 review unparseable (2 consecutive ambiguous responses).** No artifacts written; state stays `fresh`. Re-invocation starts from scratch.
  3. **Phase 4 step fails before completion.** Steps that completed are durable; remaining are not. State becomes `partial`. Re-invocation routes to Phase 0's `partial` branch and offers resume vs redo.
  4. **`bootstrap.sh` did not run.** OS-level deps missing. Phase 4 step 4a or 4c fails on Mongo writes or frame apply; error message points operator at `bootstrap.sh` re-run. (Phase 0.5 dep check from Task 5 catches this earlier.)
  5. **Frame `hive-baseline` not present** (KPR-86 not yet shipped, or operator on an older Beekeeper). Phase 2 cannot draft a frame application plan. Skill refuses with: `"init-instance requires KPR-86 (hive-baseline frame). Either install Beekeeper >=<version-with-baseline> or contact Keepur for a registry-distributed frame."` This is the gate — implementation pickup waits for KPR-86 to land.
  6. **Concurrent invocation on the same instance.** Two Beekeeper sessions running `init-instance` against the same `<instance-id>` simultaneously. Phase 4 writes through `admin_save_*` MCP tools and `frame apply` primitives, which serialize at the Mongo layer; the second session's `detectInstanceState()` will see the first's writes and route to `partial`. Spec accepts this as benign — operator just gets confused and can re-invoke.
  7. **Operator runs `tune-instance` on a partially initialized instance.** `tune-instance`'s frame audit will surface the partial frame application as drift; per `tune-instance` spec, this is reported as informational. Operator should finish `init-instance` first; spec does not block `tune-instance` from running on partial state but the output will be noisy.

- [ ] **Step 12.2:** Append a **resume / redo dialog** sub-section describing the operator-facing prompt the skill emits when `detectInstanceState()` returns `partial`. Cross-link to Phase 0 (don't duplicate).

- [ ] **Step 12.3:** Verify

```bash
grep -c "fresh\|partial" skills/init-instance/SKILL.md
grep -c "FILLED IN BY TASK" skills/init-instance/SKILL.md
wc -l skills/init-instance/SKILL.md
```

Expected: state-machine references >= 12 across the file; FILLED-IN markers count = 0; total file length ≈ 350–450 lines.

- [ ] **Step 12.4:** Commit

```bash
git add skills/init-instance/SKILL.md
git commit -m "feat(skill): failure-recovery section — seven failure modes + resume/redo"
```

---

## Task 13: Skill installer postinstall — register `init-instance` alongside `tune-instance`

**Files:**
- Possibly modify: `src/service/skill-installer.ts`
- Possibly modify: `src/service/skill-installer.test.ts`

**Why "possibly":** KPR-72 Task 8 already shipped a postinstall step that symlinks `~/.claude/skills/tune-instance/` → bundled `skills/tune-instance/`. The installer either (a) already iterates over all bundled skill directories OR (b) hard-codes `SKILL_NAME = "tune-instance"`. Inspect first; only modify if (b).

- [ ] **Step 13.1:** Inspect the existing installer.

```bash
cat src/service/skill-installer.ts | head -60
grep -n "SKILL_NAME\|tune-instance\|readdirSync\|skills/" src/service/skill-installer.ts
```

  - **If installer already iterates bundled skills (e.g., `readdirSync("skills/")` and links each):** skip to Step 13.4 (no-op — adding the directory in Tasks 1+3–12 is sufficient).
  - **If installer hard-codes `tune-instance`:** continue to Step 13.2.

- [ ] **Step 13.2:** Refactor `src/service/skill-installer.ts` to iterate over all bundled skills. Replace the `SKILL_NAME` constant + single-skill logic with:

```typescript
const BUNDLED_SKILLS = ["tune-instance", "init-instance"] as const;

export function installAllSkillSymlinks(baseDir?: string): Array<ReturnType<typeof installSkillSymlink>> {
  return BUNDLED_SKILLS.map((name) => installSkillSymlink(name, baseDir));
}

export function removeAllSkillSymlinks(baseDir?: string): Array<ReturnType<typeof removeSkillSymlink>> {
  return BUNDLED_SKILLS.map((name) => removeSkillSymlink(name, baseDir));
}
```

  Update `src/service/generate-plist.ts` callers (`install()` and `uninstall()`) to call `installAllSkillSymlinks` / `removeAllSkillSymlinks` and iterate the result array for console output.

- [ ] **Step 13.3:** Add Vitest cases to `src/service/skill-installer.test.ts`:
  - `installAllSkillSymlinks` creates symlinks for both bundled skills.
  - `installAllSkillSymlinks` is idempotent across both.
  - `removeAllSkillSymlinks` removes both.
  - Bundled-skill-missing throws for the missing one but doesn't prevent the present one from being symlinked. (If atomicity is preferred — i.e., either both link or neither — note that as a follow-up; v1 best-effort iterate is acceptable per the existing single-skill installer's posture.)

- [ ] **Step 13.4:** Verify

```bash
npm run check
```

Expected: typecheck + all tests pass; new init-instance is installed alongside tune-instance.

- [ ] **Step 13.5:** Manual verification on the test machine (DO NOT run on production install):

```bash
npm run build
node dist/cli.js install /tmp/beekeeper-init-test-config
ls -la ~/.claude/skills/init-instance ~/.claude/skills/tune-instance
readlink ~/.claude/skills/init-instance
node dist/cli.js uninstall
ls -la ~/.claude/skills/init-instance 2>&1 | head -1
```

Expected:
- After `install`: both symlinks exist, `readlink` shows the absolute path to `<worktree>/skills/init-instance`.
- After `uninstall`: both symlinks gone.

- [ ] **Step 13.6:** Commit (skip if Step 13.1 was a no-op)

```bash
git add src/service/skill-installer.ts src/service/skill-installer.test.ts src/service/generate-plist.ts
git commit -m "feat(skill): installer registers init-instance alongside tune-instance"
```

---

## Task 14: README — operator-facing how-to

**Files:**
- Create: `skills/init-instance/README.md`

**Audience:** the human operator running Beekeeper, NOT the skill itself. Targets ~80–100 LOC. Mirror the structure of `skills/tune-instance/README.md` (KPR-72 Task 10).

- [ ] **Step 14.1:** Write `skills/init-instance/README.md` covering:

  1. **One-paragraph intro** — what the skill does (initializes a fresh Hive instance via Beekeeper conversation), who it's for (the operator on day zero of a new Hive), when to run it (immediately after `bootstrap.sh` completes, before the first Slack conversation with CoS).

  2. **Prerequisites** — operator's machine needs:
     - Beekeeper installed.
     - Skill installed at `~/.claude/skills/init-instance/` (the postinstall step from Task 13 handles this).
     - mongosh access to `mongodb://localhost/hive_<instance-id>`.
     - Beekeeper agent has `admin_*` MCP tools available + KPR-85 `frame apply` primitives.
     - `hive-baseline` frame (from KPR-86) is on the machine.
     - `bootstrap.sh` has run successfully (Mongo + Qdrant + Ollama up, instance directory at `~/services/hive/<instance-id>/`).

  3. **How to invoke** — in a Beekeeper conversation: `"Init dodi"`, `"Initialize the keepur instance"`, or `"Run init-instance on <id>"`. The skill auto-resolves the instance from natural-language phrasing; if multiple fresh instances exist, the skill asks which one.

  4. **What each phase does** — one paragraph per phase (0 pre-flight + state detection, 1 discover/interview, 2 propose 3 drafts, 3 operator review, 4 apply 6 durable steps, 5 handoff to CoS). Not a re-port of SKILL.md detail; just enough for the operator to know what to expect at each prompt.

  5. **What you'll be asked during the interview** — the 8 interview sections in plain prose:
     - Who you are and what authority you hold.
     - What this Hive supports (company / operation context).
     - Who's on the human team.
     - Communication norms (Slack channels, email, response cadence).
     - Approval delegation (who approves what).
     - Working environment (timezone, working hours, holidays).
     - Chief-of-Staff shaping (her voice, scope, proactivity).
     - Initial agents you want spun up next (descriptive only — not provisioned at init).

  6. **Frame defaults vs operator-specific values** — short table or prose explaining which interview answers can fall back to the frame's defaults (comms norms, approval delegation shape, CoS role/tools) vs which must come from the operator (team, identity, voice, environment).

  7. **What gets written at Phase 4** — the 6 durable artifacts listed plainly:
     - Section 1 of constitution (from frame).
     - Section 2 of constitution (from your interview answers).
     - `hive-baseline` frame application record.
     - CoS agent definition (soul + systemPrompt + universal-9 coreServers).
     - CoS hot-tier memory seed (operator context, team roster, comms norms, approval delegation).
     - Constitution template version stamp.

  8. **Idempotency — re-running init** — short prose:
     - First run on a fresh instance: produces a complete init.
     - Re-run on a partial instance (Phase 4 mid-failure): offers resume vs redo.
     - Re-run on a completed instance: refused unless you say `force re-init <instance-id>` explicitly.
     - Day-2 changes (adding agents, editing Section 2): use `tune-instance` (KPR-72) or ask CoS in Slack — NOT `init-instance`.

  9. **Troubleshooting** — common issues:
     - "skill not loading" → check `~/.claude/skills/init-instance/` exists as a symlink; re-run `beekeeper install`.
     - "frame hive-baseline not found" → install or update Beekeeper to the version that ships KPR-86 content.
     - "instance auto-resolution failing" → operator passes `<instance-id>` explicitly in the invocation.
     - "Phase 4 step failed" → re-invoke; Phase 0 will detect partial state and offer resume.
     - "CoS doesn't seem to know about my team after init" → check `agent_memory` records for the seedRunId from the run; if missing, Phase 4 step 4e didn't complete.

  10. **What to do after init completes** — a short list:
     - Start the hive service.
     - Send a "hello" message to the seeded CoS in Slack — she's pre-tuned and ready.
     - Ask CoS to spin up the agents you mentioned in interview §8 — she has the frame's role→tool registry and your context in memory.

- [ ] **Step 14.2:** Verify

```bash
test -f skills/init-instance/README.md
wc -l skills/init-instance/README.md
```

Expected: file exists; ~80–110 LOC.

- [ ] **Step 14.3:** Commit

```bash
git add skills/init-instance/README.md
git commit -m "docs(skill): operator-facing README for init-instance"
```

---

## Task 15: End-to-end dry-run scenario across fresh + partial + completed states

**Files:** none — this task is **manual verification on a test machine**, not source-code change. Output is a checklist confirmation, optionally a short note appended to a follow-up tracking artifact.

**Per spec §"Path to implementation" item 9.**

**Pre-conditions:** Beekeeper running with Tasks 1–14 landed. KPR-85 (`frame apply` writes) AND KPR-86 (`hive-baseline` frame content) both landed and importable. A fresh test instance directory exists (e.g., `~/services/hive/init-test-<n>/` from a `bootstrap.sh` dry run, or scaffolded manually). The dodi instance is running normally on the test machine for the partial/completed sub-tests (or use a separate "completed" test instance).

- [ ] **Step 15.1:** **Fresh-state E2E.** Open a Beekeeper conversation and invoke: `"Run init-instance on init-test-<n>"`. Walk through the full 5-phase flow:
  - Phase 0 detects `fresh`, proceeds.
  - Phase 1 interview: answer all 8 sections with realistic test values (operator: yourself; team: 2–3 fake names; CoS shaping: warm + proactive).
  - Phase 2 emits 3 drafts in one consolidated proposal.
  - Phase 3 approve all (`"looks good, apply"`).
  - Phase 4 executes 4a → 4f durably; SIGUSR1 the test instance's hive process if running.
  - Phase 5 emits handoff message to operator + writes hot-tier memory record.

- [ ] **Step 15.2:** Verify Phase 4 durable artifacts:

```bash
mongosh mongodb://localhost/hive_init-test-<n> --eval 'db.applied_frames.find({frameId:"hive-baseline"}).toArray()'
mongosh mongodb://localhost/hive_init-test-<n> --eval 'db.agent_definitions.find({agentId:"chief-of-staff"}).toArray()'
mongosh mongodb://localhost/hive_init-test-<n> --eval 'db.agent_memory.find({"metadata.seededBy":"beekeeper-init-instance"}).toArray()'
```

Expected:
- `applied_frames.hive-baseline` record present with `appliedBy: "beekeeper-init-instance:<runId>"`.
- `agent_definitions.chief-of-staff` record present with non-default systemPrompt.
- `agent_memory` records with `metadata.seededBy: "beekeeper-init-instance"` and matching `seedRunId`.

- [ ] **Step 15.3:** Verify CoS pre-tuned context. Send a message to the seeded CoS in Slack: `"who are you and who am I?"`. Expected: she identifies herself as the seeded CoS, names the operator (you), references the team members from Phase 1.

- [ ] **Step 15.4:** **Completed-state refuse.** Re-invoke `"Run init-instance on init-test-<n>"` (the same instance, now completed). Verify:
  - Phase 0 detects `completed`.
  - Skill refuses with the spec's prose: `"instance init-test-<n> is already initialized... To re-init from scratch anyway, confirm explicitly with 'force re-init init-test-<n>'."`

- [ ] **Step 15.5:** **Partial-state resume.** Manually corrupt one of the four detail booleans to force `partial` (e.g., `db.agent_memory.deleteMany({"metadata.seededBy":"beekeeper-init-instance"})` to drop the handoff record). Re-invoke. Verify:
  - Phase 0 detects `partial`, lists which artifacts are present and which missing.
  - Operator chooses `resume` → skill re-runs only the missing pieces (4e/4f if those are what's missing); does NOT re-run the interview unless the missing piece needs it.
  - Final state: `completed`.

- [ ] **Step 15.6:** **Force re-init path.** Invoke `force re-init init-test-<n>`. Verify:
  - Skill prompts per-artifact destruction confirmation (per spec §"Open design questions" item 2).
  - On confirmation, removes artifacts and proceeds as `fresh`.

- [ ] **Step 15.7:** **Parsing-failure contract.** Re-invoke on a fresh instance. At Phase 3, respond ambiguously: `"some of these look fine"`. Verify skill asks one targeted clarifying question. Respond again ambiguously: `"yeah, you know"`. Verify skill exits Phase 3 without writing, reports `"review response unclear; re-invoke init-instance when ready."`, state remains `fresh`.

- [ ] **Step 15.8:** **`tune-instance` cross-check.** Once Step 15.1 completes and produces a `completed` state, run `"Run tune-instance on init-test-<n>"`. Verify the audit returns ZERO structural findings (per spec §"Goals" item 3 and §"Coordination with sibling tickets" — the preventive contract). Any structural findings indicate that init's output drifted from frame expectations — file a follow-up ticket and add a one-line note to that run's tune-instance findings doc.

- [ ] **Step 15.9:** Document any drift between the spec and reality. If `detectInstanceState()` returned errors (e.g., schema mismatch in `applied_frames` or `agent_memory`), file a follow-up ticket with concrete reproduction steps.

- [ ] **Step 15.10:** No commit — manual verification task. Mark this task complete in the implementation tracker once Steps 15.1–15.9 are all green.

---

## Acceptance criteria mapping (spec → tasks)

For self-review and reviewer cross-check. Each acceptance criterion in spec §"Acceptance criteria" lines 416–432 maps to one or more tasks:

| Spec AC | Task(s) |
|---|---|
| Skill exists at `~/github/beekeeper/skills/init-instance/SKILL.md` with required frontmatter | Task 1 |
| Beekeeper installer ensures the skill is reachable at `~/.claude/skills/init-instance/` | Task 13 |
| `detectInstanceState()` lives at a single import path; both Phase 0 and Phase 4-resume use the same import | Task 4 |
| Phase 0 returns `fresh` / `partial` / `completed` per documented decision rule; refuses `completed` re-init unless `force re-init` | Task 4 + Task 5 |
| Phase 1 conducts operator interview covering 8 sections; calls out frame defaults vs operator-specific values explicitly | Task 6 |
| Phase 2 emits three drafts in one consolidated proposal | Task 7 |
| Phase 3 supports approve-all / edit-and-re-show / defer-one-piece; parsing-failure: one clarifier then exit (no partial-state write on parse fail) | Task 8 |
| Phase 4 uses KPR-83 Phase 2 (KPR-85) `frame apply` primitives for frame-managed writes; Section 2 via `admin_save_constitution` | Task 9 |
| Every Phase 4 Mongo write tags `updatedBy: "beekeeper-init-instance:<runId>"` | Task 9 |
| Phase 4 step ordering durable per-step: 4a → 4b → 4c → 4d → 4e → 4f | Task 9 |
| Phase 4 SIGUSR1s the hive after writes if running; otherwise prints "start the hive" instruction | Task 9 + Task 10 |
| Phase 5 writes hot-tier memory record on seeded CoS describing operator context, team, comms, approval delegation, initial-agent wishes | Task 10 |
| Phase 5 record tagged with `seedRunId` and `seededBy: beekeeper-init-instance` | Task 10 |
| Output of `init-instance` passes `tune-instance` audit on first run with zero structural findings | Task 15 (E2E verification) |
| On any Phase 4 step failure, durable artifacts up to that point persist; `detectInstanceState()` returns `partial` next invocation | Task 4 + Task 9 + Task 12 |
| Re-invocation on `partial` offers resume vs redo; resume re-runs only not-yet-written pieces; redo confirms per-artifact destruction | Task 5 + Task 11 + Task 12 |
| Implementation pickup gated on KPR-83 Phase 2 + Phase 3 landing | Front-matter status note + Task 9 explicit gate |

---

## Open design questions

All major open questions are settled (see spec §"Open design questions" + the 11 settled answers in `~/.claude/projects/-Users-mokie-github-hive/memory/project_kpr71_reframe.md`):

1. **Phase 0.5 dep check** — settled (lean: yes). Implemented in Task 5 §"Optional Phase 0.5 dep check".

2. **`force re-init` granularity** — settled (lean: per-artifact, finding-by-finding). Baked into Task 11 prose.

3. **CoS agent ID convention** — settled (default `chief-of-staff`, operator override during Phase 1 §7). Baked into Task 6 (interview §7) and Task 4 (`detectInstanceState()` accepts `cosAgentId` override).

No new open questions surfaced during plan drafting.

---

## Self-review pass (2026-04-27)

Reviewed against spec §"Acceptance criteria" lines 416–432. All 16 ACs map to at least one task (see mapping table above). Findings:

- **Plan covers all 9 numbered items** in spec §"Path to implementation" lines 446–456:
  - Item 1 (skill directory + frontmatter + phased playbook) → Tasks 1, 3, 5–12.
  - Item 2 (`detectInstanceState()` primitive) → Task 4.
  - Item 3 (Phase 4 wiring — KPR-85 frame primitives + admin MCP + structured memory) → Task 9.
  - Item 4 (Phase 1 interview script — concrete prompts, branching guidance, frame-vs-operator cues) → Task 6.
  - Item 5 (Phase 5 handoff record template — concrete schema with metadata) → Task 10.
  - Item 6 (`bootstrap.sh` modification) → out of scope for this plan; redirect-note PR to hive engine repo to be filed alongside this plan's PR. Documented in `### Files NOT touched`.
  - Item 7 (Beekeeper installer postinstall) → Task 13. Likely no-op if KPR-72 installer already iterates bundled skills.
  - Item 8 (operator-facing README) → Task 14.
  - Item 9 (E2E test scenario) → Task 15.

- **Implementation gating** — front-matter at the top of this plan + Task 4 + Task 9 + Task 14 (README prerequisite list) all reflect spec §"Path to implementation" line 458: implementation waits until KPR-83 Phase 2 (KPR-85) AND Phase 3 (KPR-86) land. Plan can be drafted, reviewed, committed now.

- **No new MCP servers** confirmed across all tasks. Skill consumes existing `admin_save_constitution`, `admin_save_agent`, `admin_save_memory`, `frame apply` write primitives (KPR-85), and direct mongosh access. Spec §"Non-goals" + §"Coordination with sibling tickets" satisfied.

- **Spec-vs-reality gaps** — none surfaced in this plan-stage review. The spec is internally consistent; the 11 settled answers from `project_kpr71_reframe.md` are all represented in the spec; the three open design questions in spec §"Open design questions" are baked into the relevant tasks. Sibling plan (`2026-04-26-tune-instance-skill.md`) provides the installer surface this plan reuses.

- **Architectural surprises** — none. The skill is conservative: reuses existing admin MCP, reuses KPR-85 frame primitives (the dependency surface), reuses KPR-72 installer (with a small refactor to iterate over bundled skills if needed), reuses skill auto-discovery. The one new TypeScript module (`detectInstanceState()`) is small (~80 LOC + tests) and has a single, well-specified contract.

- **Cross-cutting traceability** — every Phase 4 Mongo write tags `updatedBy: "beekeeper-init-instance:<runId>"`; the handoff memory record carries `seedRunId` + `seededBy`. The audit trail is the tagged Mongo docs themselves (no per-run findings file in v1, per spec §"No run-artifact file in v1"). This plan upholds that contract across Tasks 9 + 10.

- **Sibling-skill consistency** — `init-instance` and `tune-instance` share the installer surface, the agent identity (`agents: [beekeeper]`), the conversational shape, and the universal-9 baseline reference. Output of `init-instance` is contractually expected to pass `tune-instance` audit on first run (Task 15 Step 15.8 verifies this). The two skills are designed as a preventive/remedial pair.
