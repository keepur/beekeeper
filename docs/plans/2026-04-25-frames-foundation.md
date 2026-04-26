# Frames — Foundation + `--adopt` Implementation Plan

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan. Each task is self-contained; commit after each.

**Goal:** Ship `beekeeper frame list/audit/apply --adopt` against a target Hive instance. No asset writes — this plan establishes the architecture (manifest schema, instance resolver, MongoDB access, anchor resolver, applied_frames store) and delivers the safe operations only. Destructive `apply` (asset writes), `remove`, drift dialog, and hand-authored `hive-baseline` ship in subsequent plans.

**Architecture:** A new `src/frames/` module houses manifest loading, instance resolution, anchor resolution, MongoDB access to Hive instance databases (`hive_<id>`), and an `applied_frames` collection store. The CLI grows a `frame` subcommand that dispatches to handlers under `src/frames/commands/`. All MongoDB access goes through one connection helper; instance config is added to `BeekeeperConfig`.

**Tech Stack:** TypeScript (NodeNext, strict), Vitest, MongoDB 7.x driver (matching Hive's version), `yaml` package (already a dependency), Node 22+. No new lint/format steps. ESM `.js` import extensions throughout.

**Spec reference:** `/tmp/2026-04-25-frames-design.md` (review-clean, 4 review rounds).

---

## File Structure

### Files to create

| File | Responsibility |
|---|---|
| `src/frames/types.ts` | TypeScript types for manifest, applied_frames record, asset descriptors |
| `src/frames/manifest-loader.ts` | Parse + validate `frame.yaml` into typed `FrameManifest` |
| `src/frames/anchor-resolver.ts` | Find HTML anchor IDs (`<a id="...">`) in markdown text |
| `src/frames/instance-resolver.ts` | Resolve instance ID → mongo URI + service path |
| `src/frames/mongo-client.ts` | Connection helper to a Hive instance's MongoDB |
| `src/frames/applied-frames-store.ts` | CRUD over `applied_frames` collection |
| `src/frames/errors.ts` | Named error classes (`MissingAnchorError`, `DependencyError`, `PartialApplyError`, etc.) |
| `src/frames/cli.ts` | `frame` subcommand router (dispatches to commands/) |
| `src/frames/commands/list.ts` | `beekeeper frame list <instance>` |
| `src/frames/commands/audit.ts` | `beekeeper frame audit <instance>` (read-only diff) |
| `src/frames/commands/apply.ts` | `beekeeper frame apply <frame> <instance>` — `--adopt` only in this plan |
| `src/frames/manifest-loader.test.ts` | Manifest validation cases |
| `src/frames/anchor-resolver.test.ts` | Anchor extraction cases |
| `src/frames/applied-frames-store.test.ts` | Store CRUD against test database |
| `src/frames/commands/apply.test.ts` | Adopt path E2E |

### Files to modify

| File | Reason |
|---|---|
| `src/types.ts` | Add `instances?: Record<string, InstanceConfig>` to `BeekeeperConfig` |
| `src/config.ts` | Load `instances:` block from `beekeeper.yaml` |
| `src/cli.ts` | Add `case "frame":` dispatching to `frames/cli.ts` |
| `package.json` | Add `mongodb: ^7.1.0` dependency |
| `beekeeper.yaml.example` | Add `instances:` example block |

---

## Task 1: Add mongodb dependency and InstanceConfig

**Files:**
- Modify: `package.json`
- Modify: `src/types.ts`

- [ ] **Step 1.1:** Add the `mongodb` dependency at the version Hive uses.

```bash
cd /Users/mokie/github/beekeeper
npm install mongodb@^7.1.0
```

Verify the lockfile is updated and there are no peer-dep warnings.

- [ ] **Step 1.2:** Add `InstanceConfig` and extend `BeekeeperConfig` in `src/types.ts`. Append to the bottom of the file:

```typescript
export interface InstanceConfig {
  /** Path to the deployed instance (e.g., ~/services/hive/dodi). */
  servicePath: string;
  /** MongoDB connection URI. Defaults to mongodb://localhost:27017. */
  mongoUri?: string;
  /** MongoDB database name. Defaults to `hive_<instanceId>`. */
  dbName?: string;
}
```

Then extend `BeekeeperConfig` (do not remove existing fields):

```typescript
export interface BeekeeperConfig {
  port: number;
  model: string;
  confirmOperations: string[];
  jwtSecret: string;
  adminSecret: string;
  dataDir: string;
  defaultWorkspace?: string;
  workspaces?: Record<string, string>;
  plugins?: string[];
  capabilitiesHealthIntervalMs: number;
  capabilitiesFailureThreshold: number;
  /** Map of instanceId → instance config. Used by the `frame` subcommand. */
  instances?: Record<string, InstanceConfig>;
}
```

- [ ] **Step 1.3:** Verify

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 1.4:** Commit

```bash
git add package.json package-lock.json src/types.ts
git commit -m "feat(frames): add mongodb dep and InstanceConfig type"
```

---

## Task 2: Load `instances:` from beekeeper.yaml

**Files:**
- Modify: `src/config.ts`
- Modify: `beekeeper.yaml.example`

- [ ] **Step 2.1:** In `src/config.ts`, locate the function that returns `BeekeeperConfig` (it's the main `loadConfig` export). Inside that function, after the YAML is parsed into a local variable (let's call it `yaml`), read the `instances` block and pass it through. Do not invent values; if absent, leave the field undefined.

Add to the returned config object:

```typescript
instances: parseInstances(yaml?.instances),
```

Add this helper above `loadConfig` in the same file:

First, ensure `InstanceConfig` is imported at the top of `src/config.ts`:

```typescript
import type { BeekeeperConfig, InstanceConfig } from "./types.js";
```

(If `BeekeeperConfig` is already imported, just add `InstanceConfig` to the same statement.)

Then add the helper:

```typescript
function parseInstances(raw: unknown): Record<string, InstanceConfig> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, InstanceConfig> = {};
  for (const [id, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== "object") {
      throw new Error(`beekeeper.yaml: instances.${id} must be an object`);
    }
    const v = val as Record<string, unknown>;
    if (typeof v.servicePath !== "string" || v.servicePath.length === 0) {
      throw new Error(`beekeeper.yaml: instances.${id}.servicePath is required`);
    }
    out[id] = {
      servicePath: v.servicePath,
      mongoUri: typeof v.mongoUri === "string" ? v.mongoUri : undefined,
      dbName: typeof v.dbName === "string" ? v.dbName : undefined,
    };
  }
  return out;
}
```

- [ ] **Step 2.2:** Append to `beekeeper.yaml.example`:

```yaml

# Hive instances managed by this Beekeeper. Used by `beekeeper frame ...`.
# instanceId is the key; servicePath is the deployed instance directory.
# mongoUri defaults to mongodb://localhost:27017; dbName defaults to hive_<instanceId>.
instances:
  dodi:
    servicePath: /Users/youruser/services/hive/dodi
  keepur:
    servicePath: /Users/youruser/services/hive/keepur
```

- [ ] **Step 2.3:** Verify

```bash
npm run typecheck
npm run test
```

Expected: typecheck clean; existing tests pass (no regressions).

- [ ] **Step 2.4:** Commit

```bash
git add src/config.ts beekeeper.yaml.example
git commit -m "feat(frames): load instances from beekeeper.yaml"
```

---

## Task 3: Frame manifest types and loader

**Files:**
- Create: `src/frames/types.ts`
- Create: `src/frames/manifest-loader.ts`
- Create: `src/frames/manifest-loader.test.ts`

- [ ] **Step 3.1:** Create `src/frames/types.ts`:

```typescript
/**
 * Frame manifest — the parsed, validated form of a frame.yaml.
 * Mirrors the schema in /tmp/2026-04-25-frames-design.md "Manifest schema".
 */
export interface FrameManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  targets?: { hiveVersion?: string };
  requires?: string[];
  conflicts?: string[];

  constitution?: ConstitutionAsset[];
  skills?: SkillAsset[];
  coreservers?: CoreServerAsset[];
  schedule?: ScheduleAsset[];
  memorySeeds?: MemorySeedAsset[];
  prompts?: PromptAsset[];
  hooks?: { preApply?: string; postApply?: string };

  /** Absolute path to the frame's root directory on disk. Populated by the loader. */
  rootPath: string;
}

export type ConstitutionInsertMode =
  | "after-anchor"
  | "before-anchor"
  | "append-to-anchor"
  | "replace-anchor";

export interface ConstitutionAsset {
  anchor: string;
  title?: string;
  insert: ConstitutionInsertMode;
  /** When mode is *-anchor (other than replace), the target anchor whose neighborhood we modify. */
  targetAnchor?: string;
  /** Path to the markdown fragment, relative to the frame's rootPath. */
  file: string;
}

export interface SkillAsset {
  /** Path to the skill bundle directory, relative to the frame's rootPath. */
  bundle: string;
}

export interface CoreServerAsset {
  /** MCP server names to add. */
  add: string[];
  /** Agent IDs or `["*"]` for all agents. */
  agents: string[];
}

export type SchedulePattern = "stagger" | "shared";

export interface ScheduleAsset {
  task: string;
  agents: string[];
  /** Either an explicit cron string or a named pattern with parameters. */
  cron?: string;
  pattern?: SchedulePattern;
  /** Required for stagger pattern. Free-text window descriptor (e.g., "fri 14:00-17:00 PT"). */
  window?: string;
  /** Required for stagger pattern. Slot duration descriptor (e.g., "15m"). */
  interval?: string;
}

export interface MemorySeedAsset {
  agent: string;
  tier: "hot" | "warm" | "cold";
  /** Path relative to the frame's rootPath. */
  file: string;
  dedupeBy?: "content-hash";
}

export interface PromptAsset {
  anchor: string;
  agents: string[];
  /** Path relative to the frame's rootPath. */
  file: string;
}

/** Record stored in the `applied_frames` collection (per Hive instance). */
export interface AppliedFrameRecord {
  _id: string;
  version: string;
  appliedAt: Date;
  appliedBy: string;
  /** Snapshot of the manifest at apply time. */
  manifest: FrameManifest;
  resources: AppliedResources;
  driftAccepted?: DriftDecision[];
}

export interface AppliedResources {
  constitution?: {
    anchors: string[];
    snapshotBefore: string;
    insertedText: Record<string, string>;
  };
  skills?: Array<{ bundle: string; sha256: string }>;
  coreservers?: Record<string, string[]>;
  schedule?: Record<string, Array<{ task: string; cron: string }>>;
  memorySeeds?: Array<{ id: string; contentHash: string }>;
  prompts?: Record<
    string,
    { anchors: string[]; snapshotBefore: string; insertedText: Record<string, string> }
  >;
}

export interface DriftDecision {
  resource: string;
  decision: "keep-local" | "take-frame" | "merged" | "deferred";
  decidedAt: Date;
  decidedBy: string;
  reason?: string;
}
```

- [ ] **Step 3.2:** Create `src/frames/manifest-loader.ts`:

```typescript
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  FrameManifest,
  ConstitutionAsset,
  ConstitutionInsertMode,
  SkillAsset,
  CoreServerAsset,
  ScheduleAsset,
  SchedulePattern,
  MemorySeedAsset,
  PromptAsset,
} from "./types.js";

/**
 * Load and validate frame.yaml at the given frame root directory.
 * Throws on schema errors with the offending field path included.
 */
export function loadManifest(frameDir: string): FrameManifest {
  const absDir = isAbsolute(frameDir) ? frameDir : resolve(frameDir);
  if (!existsSync(absDir) || !statSync(absDir).isDirectory()) {
    throw new Error(`Frame directory not found: ${absDir}`);
  }
  const manifestPath = join(absDir, "frame.yaml");
  if (!existsSync(manifestPath)) {
    throw new Error(`Frame manifest not found: ${manifestPath}`);
  }
  const text = readFileSync(manifestPath, "utf-8");
  const raw = parseYaml(text) as unknown;
  if (!raw || typeof raw !== "object") {
    throw new Error(`Frame manifest is not an object: ${manifestPath}`);
  }
  const obj = raw as Record<string, unknown>;

  const name = requireString(obj.name, "name");
  const version = requireString(obj.version, "version");

  const manifest: FrameManifest = {
    name,
    version,
    description: optionalString(obj.description, "description"),
    author: optionalString(obj.author, "author"),
    license: optionalString(obj.license, "license"),
    targets: parseTargets(obj.targets),
    requires: parseStringArray(obj.requires, "requires"),
    conflicts: parseStringArray(obj.conflicts, "conflicts"),
    constitution: parseConstitution(obj.constitution),
    skills: parseSkills(obj.skills),
    coreservers: parseCoreServers(obj.coreservers),
    schedule: parseSchedule(obj.schedule),
    memorySeeds: parseMemorySeeds(obj["memory-seeds"] ?? obj.memorySeeds),
    prompts: parsePrompts(obj.prompts),
    hooks: parseHooks(obj.hooks),
    rootPath: absDir,
  };

  validateAssetFiles(manifest);

  return manifest;
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`frame.yaml: ${field} is required and must be a non-empty string`);
  }
  return v;
}

function optionalString(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw new Error(`frame.yaml: ${field} must be a string`);
  }
  return v;
}

function parseStringArray(v: unknown, field: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error(`frame.yaml: ${field} must be an array`);
  return v.map((item, i) => {
    if (typeof item !== "string") {
      throw new Error(`frame.yaml: ${field}[${i}] must be a string`);
    }
    return item;
  });
}

function parseTargets(v: unknown): FrameManifest["targets"] {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  return {
    hiveVersion: optionalString(o["hive-version"] ?? o.hiveVersion, "targets.hive-version"),
  };
}

function parseHooks(v: unknown): FrameManifest["hooks"] {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  return {
    preApply: optionalString(o["pre-apply"] ?? o.preApply, "hooks.pre-apply"),
    postApply: optionalString(o["post-apply"] ?? o.postApply, "hooks.post-apply"),
  };
}

const VALID_INSERT_MODES: readonly ConstitutionInsertMode[] = [
  "after-anchor",
  "before-anchor",
  "append-to-anchor",
  "replace-anchor",
];

function parseConstitution(v: unknown): ConstitutionAsset[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error("frame.yaml: constitution must be an array");
  return v.map((entry, i) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`frame.yaml: constitution[${i}] must be an object`);
    }
    const o = entry as Record<string, unknown>;
    const anchor = requireString(o.anchor, `constitution[${i}].anchor`);
    const insertRaw = requireString(o.insert, `constitution[${i}].insert`);
    // Insert can be `replace-anchor` or `<mode> "<targetAnchor>"`.
    const { mode, targetAnchor } = parseInsertSpec(insertRaw, `constitution[${i}].insert`);
    return {
      anchor,
      title: optionalString(o.title, `constitution[${i}].title`),
      insert: mode,
      targetAnchor,
      file: requireString(o.file, `constitution[${i}].file`),
    };
  });
}

/**
 * Parse an insert specifier like:
 *   "after-anchor \"memory\""         -> mode=after-anchor, targetAnchor=memory
 *   "before-anchor \"capabilities\""  -> mode=before-anchor, targetAnchor=capabilities
 *   "replace-anchor"                  -> mode=replace-anchor, targetAnchor=undefined
 *
 * Anchors must be quoted. Whitespace flexible.
 */
function parseInsertSpec(
  raw: string,
  field: string,
): { mode: ConstitutionInsertMode; targetAnchor?: string } {
  const trimmed = raw.trim();
  if (trimmed === "replace-anchor") return { mode: "replace-anchor" };
  const match = trimmed.match(/^(after-anchor|before-anchor|append-to-anchor)\s+"([^"]+)"$/);
  if (!match) {
    throw new Error(
      `${field}: must be 'replace-anchor' or '<mode> "<targetAnchor>"' (modes: ${VALID_INSERT_MODES.join(", ")}). Got: ${raw}`,
    );
  }
  return { mode: match[1] as ConstitutionInsertMode, targetAnchor: match[2] };
}

function parseSkills(v: unknown): SkillAsset[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error("frame.yaml: skills must be an array");
  return v.map((entry, i) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`frame.yaml: skills[${i}] must be an object`);
    }
    const o = entry as Record<string, unknown>;
    return { bundle: requireString(o.bundle, `skills[${i}].bundle`) };
  });
}

function parseCoreServers(v: unknown): CoreServerAsset[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error("frame.yaml: coreservers must be an array");
  return v.map((entry, i) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`frame.yaml: coreservers[${i}] must be an object`);
    }
    const o = entry as Record<string, unknown>;
    return {
      add: parseStringArray(o.add, `coreservers[${i}].add`) ?? [],
      agents: parseStringArray(o.agents, `coreservers[${i}].agents`) ?? [],
    };
  });
}

const VALID_SCHEDULE_PATTERNS: readonly SchedulePattern[] = ["stagger", "shared"];

function parseSchedule(v: unknown): ScheduleAsset[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error("frame.yaml: schedule must be an array");
  return v.map((entry, i) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`frame.yaml: schedule[${i}] must be an object`);
    }
    const o = entry as Record<string, unknown>;
    const task = requireString(o.task, `schedule[${i}].task`);
    const agents = parseStringArray(o.agents, `schedule[${i}].agents`) ?? [];
    const cron = optionalString(o.cron, `schedule[${i}].cron`);
    const patternRaw = optionalString(o.pattern, `schedule[${i}].pattern`);
    let pattern: SchedulePattern | undefined;
    if (patternRaw !== undefined) {
      if (!(VALID_SCHEDULE_PATTERNS as readonly string[]).includes(patternRaw)) {
        throw new Error(
          `frame.yaml: schedule[${i}].pattern must be one of ${VALID_SCHEDULE_PATTERNS.join(", ")}; got ${patternRaw}`,
        );
      }
      pattern = patternRaw as SchedulePattern;
    }
    if (!cron && !pattern) {
      throw new Error(
        `frame.yaml: schedule[${i}] must specify either 'cron' or 'pattern' (with required parameters)`,
      );
    }
    return {
      task,
      agents,
      cron,
      pattern,
      window: optionalString(o.window, `schedule[${i}].window`),
      interval: optionalString(o.interval, `schedule[${i}].interval`),
    };
  });
}

function parseMemorySeeds(v: unknown): MemorySeedAsset[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error("frame.yaml: memory-seeds must be an array");
  return v.map((entry, i) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`frame.yaml: memory-seeds[${i}] must be an object`);
    }
    const o = entry as Record<string, unknown>;
    const tier = requireString(o.tier, `memory-seeds[${i}].tier`);
    if (tier !== "hot" && tier !== "warm" && tier !== "cold") {
      throw new Error(`memory-seeds[${i}].tier must be hot|warm|cold; got ${tier}`);
    }
    const dedupeRaw = optionalString(o["dedupe-by"] ?? o.dedupeBy, `memory-seeds[${i}].dedupe-by`);
    if (dedupeRaw !== undefined && dedupeRaw !== "content-hash") {
      throw new Error(`memory-seeds[${i}].dedupe-by must be 'content-hash'; got ${dedupeRaw}`);
    }
    return {
      agent: requireString(o.agent, `memory-seeds[${i}].agent`),
      tier,
      file: requireString(o.file, `memory-seeds[${i}].file`),
      dedupeBy: dedupeRaw as "content-hash" | undefined,
    };
  });
}

function parsePrompts(v: unknown): PromptAsset[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new Error("frame.yaml: prompts must be an array");
  return v.map((entry, i) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`frame.yaml: prompts[${i}] must be an object`);
    }
    const o = entry as Record<string, unknown>;
    return {
      anchor: requireString(o.anchor, `prompts[${i}].anchor`),
      agents: parseStringArray(o.agents, `prompts[${i}].agents`) ?? [],
      file: requireString(o.file, `prompts[${i}].file`),
    };
  });
}

function validateAssetFiles(m: FrameManifest): void {
  const checks: Array<[string, string]> = [];
  for (const a of m.constitution ?? []) checks.push([`constitution:${a.anchor}`, a.file]);
  for (const a of m.memorySeeds ?? []) checks.push([`memory-seeds:${a.agent}`, a.file]);
  for (const a of m.prompts ?? []) checks.push([`prompts:${a.anchor}`, a.file]);
  for (const [label, file] of checks) {
    const full = join(m.rootPath, file);
    if (!existsSync(full)) {
      throw new Error(`Frame asset file missing: ${label} -> ${file} (resolved: ${full})`);
    }
  }
  for (const a of m.skills ?? []) {
    const full = join(m.rootPath, a.bundle);
    if (!existsSync(full) || !statSync(full).isDirectory()) {
      throw new Error(`Frame skill bundle missing: ${a.bundle} (resolved: ${full})`);
    }
  }
}
```

- [ ] **Step 3.3:** Create `src/frames/manifest-loader.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { loadManifest } from "./manifest-loader.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "frame-test-"));
  const writeFile = (rel: string, content: string) => {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  return { dir, writeFile };
}

describe("loadManifest", () => {
  let dir: string;
  let writeFile: (rel: string, content: string) => void;

  beforeEach(() => {
    const s = setup();
    dir = s.dir;
    writeFile = s.writeFile;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses a minimal manifest", () => {
    writeFile("frame.yaml", `name: test\nversion: 0.1.0\n`);
    const m = loadManifest(dir);
    expect(m.name).toBe("test");
    expect(m.version).toBe("0.1.0");
    expect(m.constitution).toBeUndefined();
  });

  it("throws when name missing", () => {
    writeFile("frame.yaml", `version: 0.1.0\n`);
    expect(() => loadManifest(dir)).toThrow(/name is required/);
  });

  it("parses constitution insert specs", () => {
    writeFile(
      "frame.yaml",
      `name: t\nversion: 0.1.0\nconstitution:\n  - anchor: capabilities\n    insert: after-anchor "memory"\n    file: c.md\n  - anchor: memory\n    insert: replace-anchor\n    file: m.md\n`,
    );
    writeFile("c.md", "x");
    writeFile("m.md", "y");
    const m = loadManifest(dir);
    expect(m.constitution).toHaveLength(2);
    expect(m.constitution![0].insert).toBe("after-anchor");
    expect(m.constitution![0].targetAnchor).toBe("memory");
    expect(m.constitution![1].insert).toBe("replace-anchor");
    expect(m.constitution![1].targetAnchor).toBeUndefined();
  });

  it("rejects malformed insert spec", () => {
    writeFile(
      "frame.yaml",
      `name: t\nversion: 0.1.0\nconstitution:\n  - anchor: x\n    insert: nonsense\n    file: c.md\n`,
    );
    writeFile("c.md", "x");
    expect(() => loadManifest(dir)).toThrow(/insert: must be/);
  });

  it("requires schedule entry to have cron or pattern", () => {
    writeFile(
      "frame.yaml",
      `name: t\nversion: 0.1.0\nschedule:\n  - task: x\n    agents: ["*"]\n`,
    );
    expect(() => loadManifest(dir)).toThrow(/cron.*pattern/);
  });

  it("validates asset file existence", () => {
    writeFile(
      "frame.yaml",
      `name: t\nversion: 0.1.0\nconstitution:\n  - anchor: x\n    insert: replace-anchor\n    file: missing.md\n`,
    );
    expect(() => loadManifest(dir)).toThrow(/asset file missing/);
  });
});
```

- [ ] **Step 3.4:** Verify

```bash
npm run typecheck
npx vitest run src/frames/manifest-loader.test.ts
```

Expected: typecheck clean. All 6 manifest tests pass.

- [ ] **Step 3.5:** Commit

```bash
git add src/frames/types.ts src/frames/manifest-loader.ts src/frames/manifest-loader.test.ts
git commit -m "feat(frames): manifest types and yaml loader"
```

---

## Task 4: Anchor resolver

**Files:**
- Create: `src/frames/anchor-resolver.ts`
- Create: `src/frames/anchor-resolver.test.ts`

- [ ] **Step 4.1:** Create `src/frames/anchor-resolver.ts`:

```typescript
/**
 * Locate HTML anchor IDs in markdown text.
 * Used to resolve frame anchor references against constitution/systemPrompt content.
 */

export interface AnchorLocation {
  anchor: string;
  /** Character offset into the source text where `<a id="...">` starts. */
  start: number;
  /** Character offset where the anchor tag ends. */
  end: number;
}

/**
 * Match `<a id="anchor-name"></a>` with optional whitespace and self-close variants.
 * Captures the anchor id.
 */
const ANCHOR_RE = /<a\s+id\s*=\s*"([^"]+)"\s*(?:\/?>\s*<\/a>|\/>|>)/g;

export function findAnchors(markdown: string): AnchorLocation[] {
  const results: AnchorLocation[] = [];
  ANCHOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANCHOR_RE.exec(markdown)) !== null) {
    results.push({ anchor: m[1], start: m.index, end: m.index + m[0].length });
  }
  return results;
}

export function findAnchor(markdown: string, anchor: string): AnchorLocation | undefined {
  return findAnchors(markdown).find((a) => a.anchor === anchor);
}

/**
 * Return the set of anchors present in the document.
 * If the same anchor appears more than once, throws — anchors must be unique.
 */
export function collectAnchorSet(markdown: string): Set<string> {
  const all = findAnchors(markdown);
  const seen = new Set<string>();
  for (const a of all) {
    if (seen.has(a.anchor)) {
      throw new Error(`Duplicate anchor in document: "${a.anchor}"`);
    }
    seen.add(a.anchor);
  }
  return seen;
}

/**
 * Verify that every anchor in `required` is present in the document.
 * Returns the list of missing anchors (empty if all present).
 */
export function checkAnchorsPresent(markdown: string, required: string[]): string[] {
  const present = collectAnchorSet(markdown);
  return required.filter((a) => !present.has(a));
}
```

- [ ] **Step 4.2:** Create `src/frames/anchor-resolver.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { findAnchor, findAnchors, collectAnchorSet, checkAnchorsPresent } from "./anchor-resolver.js";

describe("anchor-resolver", () => {
  it("finds a single anchor with explicit close", () => {
    const md = `# Title\n\n<a id="memory"></a>\n### 7.3 Memory\nbody\n`;
    const a = findAnchor(md, "memory");
    expect(a).toBeDefined();
    expect(a!.anchor).toBe("memory");
  });

  it("finds a self-closed anchor", () => {
    const md = `<a id="capabilities"/>\n### 7.4 Capabilities\n`;
    expect(findAnchor(md, "capabilities")).toBeDefined();
  });

  it("returns undefined for missing anchor", () => {
    expect(findAnchor("no anchors here", "missing")).toBeUndefined();
  });

  it("collects all anchors", () => {
    const md = `<a id="a"></a>\n<a id="b"></a>\n<a id="c"/>`;
    const set = collectAnchorSet(md);
    expect(set.size).toBe(3);
    expect(set.has("a")).toBe(true);
  });

  it("throws on duplicate anchors", () => {
    const md = `<a id="x"></a>\n<a id="x"></a>`;
    expect(() => collectAnchorSet(md)).toThrow(/Duplicate anchor/);
  });

  it("checkAnchorsPresent reports missing", () => {
    const md = `<a id="memory"></a>`;
    expect(checkAnchorsPresent(md, ["memory", "capabilities"])).toEqual(["capabilities"]);
    expect(checkAnchorsPresent(md, ["memory"])).toEqual([]);
  });

  it("findAnchors returns sequential locations", () => {
    const md = `<a id="a"></a>middle<a id="b"></a>`;
    const list = findAnchors(md);
    expect(list).toHaveLength(2);
    expect(list[0].start).toBeLessThan(list[1].start);
  });
});
```

- [ ] **Step 4.3:** Verify

```bash
npx vitest run src/frames/anchor-resolver.test.ts
```

Expected: all 7 tests pass.

- [ ] **Step 4.4:** Commit

```bash
git add src/frames/anchor-resolver.ts src/frames/anchor-resolver.test.ts
git commit -m "feat(frames): markdown anchor resolver"
```

---

## Task 5: Errors, instance resolver, mongo client

**Files:**
- Create: `src/frames/errors.ts`
- Create: `src/frames/instance-resolver.ts`
- Create: `src/frames/mongo-client.ts`

- [ ] **Step 5.1:** Create `src/frames/errors.ts`:

```typescript
export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

export class MissingAnchorError extends FrameError {
  constructor(
    public readonly frame: string,
    public readonly asset: string,
    public readonly anchor: string,
    public readonly target: string,
  ) {
    super(
      `Frame "${frame}" references anchor "${anchor}" in ${asset}, but it was not found in ${target}.`,
    );
    this.name = "MissingAnchorError";
  }
}

export class DependencyError extends FrameError {
  constructor(
    public readonly target: string,
    public readonly dependents: string[],
  ) {
    super(
      `Cannot remove frame "${target}" because the following applied frame(s) depend on it: ${dependents.join(", ")}. Remove them first or pass --force.`,
    );
    this.name = "DependencyError";
  }
}

export class PartialApplyError extends FrameError {
  constructor(
    public readonly written: string[],
    public readonly unreversed: string[],
  ) {
    super(
      `Apply failed mid-stream. Reverse-best-effort completed for: [${written.join(", ")}]. Could not reverse: [${unreversed.join(", ")}]. Manual cleanup may be required.`,
    );
    this.name = "PartialApplyError";
  }
}

export class InstanceNotFoundError extends FrameError {
  constructor(public readonly instanceId: string) {
    super(
      `Instance "${instanceId}" not found in beekeeper.yaml. Add it under the 'instances:' section.`,
    );
    this.name = "InstanceNotFoundError";
  }
}
```

- [ ] **Step 5.2:** Create `src/frames/instance-resolver.ts`:

```typescript
import { existsSync, statSync } from "node:fs";
import type { BeekeeperConfig, InstanceConfig } from "../types.js";
import { InstanceNotFoundError } from "./errors.js";

export interface ResolvedInstance {
  id: string;
  servicePath: string;
  mongoUri: string;
  dbName: string;
}

/**
 * Resolve an instance id to its full config. Applies defaults where needed.
 * Throws InstanceNotFoundError if the id is not in the config.
 */
export function resolveInstance(config: BeekeeperConfig, instanceId: string): ResolvedInstance {
  const instances = config.instances ?? {};
  const entry: InstanceConfig | undefined = instances[instanceId];
  if (!entry) throw new InstanceNotFoundError(instanceId);

  if (!existsSync(entry.servicePath) || !statSync(entry.servicePath).isDirectory()) {
    throw new Error(
      `Instance "${instanceId}" servicePath does not exist or is not a directory: ${entry.servicePath}`,
    );
  }

  return {
    id: instanceId,
    servicePath: entry.servicePath,
    mongoUri: entry.mongoUri ?? "mongodb://localhost:27017",
    dbName: entry.dbName ?? `hive_${instanceId}`,
  };
}
```

- [ ] **Step 5.3:** Create `src/frames/mongo-client.ts`:

```typescript
import { MongoClient, type Db } from "mongodb";
import type { ResolvedInstance } from "./instance-resolver.js";

/**
 * Connect to a Hive instance's MongoDB database.
 * Caller is responsible for closing the returned client.
 */
export async function connectInstance(
  instance: ResolvedInstance,
): Promise<{ client: MongoClient; db: Db }> {
  const client = new MongoClient(instance.mongoUri, {
    serverSelectionTimeoutMS: 5000,
  });
  await client.connect();
  const db = client.db(instance.dbName);
  return { client, db };
}

/**
 * Run an operation with a connected database, ensuring the client is always closed.
 */
export async function withInstanceDb<T>(
  instance: ResolvedInstance,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const { client, db } = await connectInstance(instance);
  try {
    return await fn(db);
  } finally {
    await client.close();
  }
}
```

- [ ] **Step 5.4:** Verify

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 5.5:** Commit

```bash
git add src/frames/errors.ts src/frames/instance-resolver.ts src/frames/mongo-client.ts
git commit -m "feat(frames): errors, instance resolver, mongo client"
```

---

## Task 6: applied_frames store

**Files:**
- Create: `src/frames/applied-frames-store.ts`
- Create: `src/frames/applied-frames-store.test.ts`

- [ ] **Step 6.1:** Create `src/frames/applied-frames-store.ts`:

```typescript
import type { Db, Collection } from "mongodb";
import type { AppliedFrameRecord } from "./types.js";

const COLLECTION = "applied_frames";

export class AppliedFramesStore {
  private readonly coll: Collection<AppliedFrameRecord>;

  constructor(db: Db) {
    this.coll = db.collection<AppliedFrameRecord>(COLLECTION);
  }

  async list(): Promise<AppliedFrameRecord[]> {
    return await this.coll.find({}).sort({ _id: 1 }).toArray();
  }

  async get(name: string): Promise<AppliedFrameRecord | null> {
    return await this.coll.findOne({ _id: name });
  }

  async upsert(record: AppliedFrameRecord): Promise<void> {
    await this.coll.replaceOne({ _id: record._id }, record, { upsert: true });
  }

  async remove(name: string): Promise<boolean> {
    const r = await this.coll.deleteOne({ _id: name });
    return r.deletedCount === 1;
  }

  /** Frames that declare a `requires` including the named frame. */
  async findDependents(name: string): Promise<string[]> {
    const docs = await this.coll
      .find({ "manifest.requires": name }, { projection: { _id: 1 } })
      .toArray();
    return docs.map((d) => d._id);
  }
}
```

- [ ] **Step 6.2:** Create `src/frames/applied-frames-store.test.ts`. This is an **integration test** — it talks to a real local MongoDB. Skip if `MONGODB_TEST_URI` is unset; the CI runner already has MongoDB available.

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { AppliedFramesStore } from "./applied-frames-store.js";
import type { AppliedFrameRecord } from "./types.js";

// Guard skips the suite cleanly when the env var is unset (no live MongoDB).
// Inside the suite we still need a real URI; default to localhost when present.
const HAS_TEST_URI = !!process.env.MONGODB_TEST_URI;
const TEST_URI = process.env.MONGODB_TEST_URI ?? "mongodb://localhost:27017";
const TEST_DB = "frames_test";

let client: MongoClient;
let db: Db;

const sample = (id: string, requires: string[] = []): AppliedFrameRecord => ({
  _id: id,
  version: "0.1.0",
  appliedAt: new Date(),
  appliedBy: "test",
  manifest: {
    name: id,
    version: "0.1.0",
    rootPath: "/tmp/x",
    requires,
  },
  resources: {},
});

describe.runIf(HAS_TEST_URI)("AppliedFramesStore", () => {
  beforeAll(async () => {
    client = new MongoClient(TEST_URI, { serverSelectionTimeoutMS: 3000 });
    await client.connect();
    db = client.db(TEST_DB);
  });

  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  beforeEach(async () => {
    await db.collection("applied_frames").deleteMany({});
  });

  it("upsert then get", async () => {
    const store = new AppliedFramesStore(db);
    await store.upsert(sample("hive-baseline"));
    const got = await store.get("hive-baseline");
    expect(got?._id).toBe("hive-baseline");
  });

  it("list returns empty when nothing applied", async () => {
    const store = new AppliedFramesStore(db);
    expect(await store.list()).toEqual([]);
  });

  it("upsert is idempotent (replace not duplicate)", async () => {
    const store = new AppliedFramesStore(db);
    await store.upsert(sample("x"));
    await store.upsert(sample("x"));
    expect((await store.list()).length).toBe(1);
  });

  it("remove deletes record", async () => {
    const store = new AppliedFramesStore(db);
    await store.upsert(sample("x"));
    expect(await store.remove("x")).toBe(true);
    expect(await store.get("x")).toBeNull();
  });

  it("findDependents returns frames that require the target", async () => {
    const store = new AppliedFramesStore(db);
    await store.upsert(sample("a"));
    await store.upsert(sample("b", ["a"]));
    await store.upsert(sample("c", ["a", "b"]));
    expect((await store.findDependents("a")).sort()).toEqual(["b", "c"]);
    expect(await store.findDependents("c")).toEqual([]);
  });
});
```

- [ ] **Step 6.3:** Verify

```bash
brew services list | grep mongodb
MONGODB_TEST_URI=mongodb://localhost:27017 npx vitest run src/frames/applied-frames-store.test.ts
```

Expected: 5 tests pass. If MongoDB is not running, set `MONGODB_TEST_URI=` (empty) or simply omit the env var to skip the suite cleanly via `describe.runIf`.

To verify the skip path works:

```bash
unset MONGODB_TEST_URI
npx vitest run src/frames/applied-frames-store.test.ts
```

Expected: vitest reports the describe block as skipped (no connection attempts, no failures).

- [ ] **Step 6.4:** Commit

```bash
git add src/frames/applied-frames-store.ts src/frames/applied-frames-store.test.ts
git commit -m "feat(frames): applied_frames store with dependents lookup"
```

---

## Task 7: `frame list` command + CLI router

**Files:**
- Create: `src/frames/cli.ts`
- Create: `src/frames/commands/list.ts`
- Modify: `src/cli.ts`

- [ ] **Step 7.1:** Create `src/frames/commands/list.ts`:

```typescript
import { loadConfig } from "../../config.js";
import { resolveInstance } from "../instance-resolver.js";
import { withInstanceDb } from "../mongo-client.js";
import { AppliedFramesStore } from "../applied-frames-store.js";

export async function listFrames(instanceId: string): Promise<void> {
  const config = loadConfig();
  const instance = resolveInstance(config, instanceId);

  await withInstanceDb(instance, async (db) => {
    const store = new AppliedFramesStore(db);
    const records = await store.list();
    if (records.length === 0) {
      console.log(`No frames applied to "${instanceId}".`);
      return;
    }
    console.log(`Applied frames on "${instanceId}":`);
    for (const r of records) {
      const drift = (r.driftAccepted?.length ?? 0) > 0 ? ` (${r.driftAccepted!.length} drift accepted)` : "";
      console.log(`  ${r._id}  ${r.version}  applied=${r.appliedAt.toISOString()}  by=${r.appliedBy}${drift}`);
    }
  });
}
```

- [ ] **Step 7.2:** Create `src/frames/cli.ts`:

```typescript
import { listFrames } from "./commands/list.js";

export async function runFrameCli(args: string[]): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case "list": {
      const instanceId = args[1];
      if (!instanceId) {
        console.error("Usage: beekeeper frame list <instance>");
        return 1;
      }
      await listFrames(instanceId);
      return 0;
    }
    case undefined:
    case "--help":
    case "-h":
    case "help": {
      printUsage();
      return 0;
    }
    default: {
      console.error(`Unknown frame subcommand: ${sub}`);
      printUsage();
      return 1;
    }
  }
}

function printUsage(): void {
  console.log(`Usage: beekeeper frame <subcommand>

Subcommands:
  list   <instance>                  List frames applied to an instance
  audit  <instance>                  Audit instance for drift (read-only)
  apply  <frame> <instance> [flags]  Apply a frame; --adopt for record-only

Examples:
  beekeeper frame list dodi
  beekeeper frame audit dodi
  beekeeper frame apply ~/.beekeeper/frames/hive-baseline dodi --adopt
`);
}
```

- [ ] **Step 7.3:** Modify `src/cli.ts`. Add a new `case "frame":` block right after `case "user":` ends (before the `default:` case). Pattern matches the existing `pair` case style: dynamic import, own try/catch, own exit.

```typescript
  case "frame": {
    let frameExit = 0;
    try {
      const { runFrameCli } = await import("./frames/cli.js");
      frameExit = await runFrameCli(process.argv.slice(3));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`beekeeper frame failed: ${msg}`);
      frameExit = 1;
    }
    if (frameExit) process.exit(frameExit);
    break;
  }
```

- [ ] **Step 7.4:** Verify

```bash
npm run typecheck
npm run build
node dist/cli.js frame
```

Expected output of `node dist/cli.js frame`:

```
Usage: beekeeper frame <subcommand>

Subcommands:
  list   <instance>                  List frames applied to an instance
  ...
```

- [ ] **Step 7.5:** Commit

```bash
git add src/frames/cli.ts src/frames/commands/list.ts src/cli.ts
git commit -m "feat(frames): cli router with frame list command"
```

---

## Task 8: `frame audit` command (read-only)

**Files:**
- Create: `src/frames/commands/audit.ts`
- Modify: `src/frames/cli.ts`

This task ships a minimal audit: list applied frames and verify each frame's referenced anchors still resolve. Full drift detection (text-diff against snapshots, missing seeds, etc.) lands in a later plan; what we need now is the bones.

- [ ] **Step 8.1:** Create `src/frames/commands/audit.ts`:

```typescript
import type { Db } from "mongodb";
import { loadConfig } from "../../config.js";
import { resolveInstance } from "../instance-resolver.js";
import { withInstanceDb } from "../mongo-client.js";
import { AppliedFramesStore } from "../applied-frames-store.js";
import { collectAnchorSet } from "../anchor-resolver.js";
import type { AppliedFrameRecord } from "../types.js";

interface AuditFinding {
  frame: string;
  resource: string;
  kind: "missing-anchor" | "missing-seed";
  detail: string;
}

export async function auditInstance(instanceId: string): Promise<number> {
  const config = loadConfig();
  const instance = resolveInstance(config, instanceId);

  return await withInstanceDb(instance, async (db) => {
    const store = new AppliedFramesStore(db);
    const records = await store.list();
    if (records.length === 0) {
      console.log(`No frames applied to "${instanceId}". Nothing to audit.`);
      return 0;
    }

    const findings: AuditFinding[] = [];
    for (const rec of records) {
      findings.push(...(await auditFrame(db, rec)));
    }

    if (findings.length === 0) {
      console.log(`Audit clean: ${records.length} frame(s) applied, no drift detected.`);
      return 0;
    }

    console.log(`Audit found ${findings.length} drift item(s):\n`);
    for (const f of findings) {
      console.log(`  [${f.kind}] ${f.frame} -> ${f.resource}: ${f.detail}`);
    }
    return 0;
  });
}

async function auditFrame(
  db: Db,
  record: AppliedFrameRecord,
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];

  // Constitution anchor presence check.
  // Mirror verifyAnchors() in apply.ts: include both c.anchor (the frame's own
  // declared anchor) and c.targetAnchor (the structural anchor a replace/after/before
  // insert depends on). Both must remain present for the frame's insertion to be
  // reverse-able and audit-meaningful.
  const constitutionAnchors = new Set<string>();
  for (const c of record.manifest.constitution ?? []) {
    constitutionAnchors.add(c.anchor);
    if (c.targetAnchor) constitutionAnchors.add(c.targetAnchor);
  }
  if (constitutionAnchors.size > 0) {
    const doc = await db.collection<{ path: string; content: string }>("memory").findOne({
      path: "shared/constitution.md",
    });
    if (!doc) {
      findings.push({
        frame: record._id,
        resource: "constitution",
        kind: "missing-anchor",
        detail: "shared/constitution.md not found in db.memory",
      });
    } else {
      let present: Set<string>;
      try {
        present = collectAnchorSet(doc.content);
      } catch (err) {
        findings.push({
          frame: record._id,
          resource: "constitution",
          kind: "missing-anchor",
          detail: `anchor scan failed: ${(err as Error).message}`,
        });
        present = new Set();
      }
      for (const a of constitutionAnchors) {
        if (!present.has(a)) {
          findings.push({
            frame: record._id,
            resource: `constitution:${a}`,
            kind: "missing-anchor",
            detail: `anchor "${a}" not present in shared/constitution.md`,
          });
        }
      }
    }
  }

  // Memory-seed presence check.
  for (const seed of record.resources.memorySeeds ?? []) {
    const exists = await db.collection("agent_memory").findOne(
      { _id: seed.id },
      { projection: { _id: 1 } },
    );
    if (!exists) {
      findings.push({
        frame: record._id,
        resource: `memory-seed:${seed.id}`,
        kind: "missing-seed",
        detail: `agent_memory record ${seed.id} no longer present`,
      });
    }
  }

  return findings;
}
```

- [ ] **Step 8.2:** Wire `audit` into `src/frames/cli.ts`. In the `switch (sub)`, add a case before `case "list":`:

```typescript
    case "audit": {
      const instanceId = args[1];
      if (!instanceId) {
        console.error("Usage: beekeeper frame audit <instance>");
        return 1;
      }
      const { auditInstance } = await import("./commands/audit.js");
      return await auditInstance(instanceId);
    }
```

- [ ] **Step 8.3:** Verify

```bash
npm run typecheck
npm run build
node dist/cli.js frame audit dodi
```

Expected: `No frames applied to "dodi". Nothing to audit.` (or similar if frames are applied — empty findings = clean audit).

- [ ] **Step 8.4:** Commit

```bash
git add src/frames/commands/audit.ts src/frames/cli.ts
git commit -m "feat(frames): frame audit command with anchor + seed checks"
```

---

## Task 9: `frame apply --adopt`

**Files:**
- Create: `src/frames/commands/apply.ts`
- Create: `src/frames/commands/apply.test.ts`
- Modify: `src/frames/cli.ts`

- [ ] **Step 9.1:** Create `src/frames/commands/apply.ts`. This task implements **only the `--adopt` path**. Non-adopt apply (asset writes) is intentionally deferred to the next plan and surfaces as a clear error here.

```typescript
import { loadConfig } from "../../config.js";
import { resolveInstance } from "../instance-resolver.js";
import { withInstanceDb } from "../mongo-client.js";
import { AppliedFramesStore } from "../applied-frames-store.js";
import { loadManifest } from "../manifest-loader.js";
import { collectAnchorSet } from "../anchor-resolver.js";
import { MissingAnchorError } from "../errors.js";
import type { AppliedFrameRecord, AppliedResources, FrameManifest } from "../types.js";
import type { Db } from "mongodb";

export interface ApplyOptions {
  adopt: boolean;
}

export async function applyFrame(
  framePath: string,
  instanceId: string,
  opts: ApplyOptions,
): Promise<number> {
  if (!opts.adopt) {
    console.error(
      "Asset-write apply is not implemented in this plan. Pass --adopt to record the current instance state as conformant to this frame.",
    );
    return 2;
  }

  const config = loadConfig();
  const instance = resolveInstance(config, instanceId);
  const manifest = loadManifest(framePath);

  return await withInstanceDb(instance, async (db) => {
    const store = new AppliedFramesStore(db);

    // Conflict check: same name not already applied at a different version.
    const existing = await store.get(manifest.name);
    if (existing && existing.version === manifest.version) {
      console.log(
        `Frame "${manifest.name}" v${manifest.version} already adopted on "${instanceId}". No change.`,
      );
      return 0;
    }

    // Resolvability checks (adopt: anchors must exist, but do not check ownership).
    await verifyAnchors(db, manifest);

    // Build the record from current state.
    const record = await buildAdoptRecord(db, manifest);
    await store.upsert(record);

    console.log(`Adopted frame "${manifest.name}" v${manifest.version} on "${instanceId}".`);
    console.log(
      `Snapshot recorded; future audit/apply will compare against this baseline. No assets were written.`,
    );
    return 0;
  });
}

async function verifyAnchors(db: Db, manifest: FrameManifest): Promise<void> {
  // Collect both the frame's own anchors and any targetAnchor used in insert specs.
  // For replace-anchor the target equals the frame's anchor; for after/before/append-to
  // the target is a different anchor that must already exist in the doc.
  const constitutionRequired = new Set<string>();
  for (const c of manifest.constitution ?? []) {
    constitutionRequired.add(c.anchor);
    if (c.targetAnchor) constitutionRequired.add(c.targetAnchor);
  }
  if (constitutionRequired.size > 0) {
    const doc = await db.collection<{ path: string; content: string }>("memory").findOne({
      path: "shared/constitution.md",
    });
    if (!doc) {
      throw new MissingAnchorError(
        manifest.name,
        "constitution",
        [...constitutionRequired][0],
        "shared/constitution.md (not found)",
      );
    }
    const present = collectAnchorSet(doc.content);
    for (const a of constitutionRequired) {
      if (!present.has(a)) {
        throw new MissingAnchorError(manifest.name, "constitution", a, "shared/constitution.md");
      }
    }
  }

  // Per-agent prompt anchors.
  const promptAnchorsByAgent = new Map<string, string[]>();
  for (const p of manifest.prompts ?? []) {
    for (const agent of p.agents) {
      // Wildcards skipped in Phase-1 adopt; manifest authors must list explicit ids.
      if (agent === "*") continue;
      const list = promptAnchorsByAgent.get(agent) ?? [];
      list.push(p.anchor);
      promptAnchorsByAgent.set(agent, list);
    }
  }
  if (promptAnchorsByAgent.size > 0) {
    const agents = await db
      .collection<{ _id: string; systemPrompt?: string }>("agent_definitions")
      .find({ _id: { $in: [...promptAnchorsByAgent.keys()] } })
      .toArray();
    const byId = new Map(agents.map((a) => [a._id, a.systemPrompt ?? ""]));
    for (const [agentId, anchors] of promptAnchorsByAgent) {
      const text = byId.get(agentId) ?? "";
      const present = collectAnchorSet(text);
      for (const a of anchors) {
        if (!present.has(a)) {
          throw new MissingAnchorError(manifest.name, `prompts:${agentId}`, a, `agent_definitions[${agentId}].systemPrompt`);
        }
      }
    }
  }
}

async function buildAdoptRecord(db: Db, manifest: FrameManifest): Promise<AppliedFrameRecord> {
  const resources: AppliedResources = {};

  const constitutionAnchors = (manifest.constitution ?? []).map((c) => c.anchor);
  if (constitutionAnchors.length > 0) {
    const doc = await db
      .collection<{ path: string; content: string }>("memory")
      .findOne({ path: "shared/constitution.md" });
    const fullText = doc?.content ?? "";
    const insertedText: Record<string, string> = {};
    for (const a of constitutionAnchors) {
      insertedText[a] = extractAnchorNeighborhood(fullText, a);
    }
    resources.constitution = {
      anchors: constitutionAnchors,
      snapshotBefore: fullText,
      insertedText,
    };
  }

  // Other asset types under adopt: not populated in this plan. Subsequent plans
  // extend the adopt path to snapshot coreservers/schedule/prompts/seeds/skills.

  return {
    _id: manifest.name,
    version: manifest.version,
    appliedAt: new Date(),
    appliedBy: `beekeeper@${process.env.USER ?? "unknown"}`,
    manifest,
    resources,
  };
}

/**
 * Extract the text from `<a id="anchor">` to the next anchor (or end-of-document).
 * Returns empty string if anchor is not found.
 */
export function extractAnchorNeighborhood(markdown: string, anchor: string): string {
  const startRe = new RegExp(`<a\\s+id\\s*=\\s*"${escapeRe(anchor)}"\\s*(?:/?>\\s*</a>|/>|>)`);
  const startMatch = startRe.exec(markdown);
  if (!startMatch) return "";
  const startIdx = startMatch.index;
  const afterStart = startIdx + startMatch[0].length;
  const nextAnchorRe = /<a\s+id\s*=\s*"[^"]+"\s*(?:\/?>\s*<\/a>|\/>|>)/g;
  nextAnchorRe.lastIndex = afterStart;
  const next = nextAnchorRe.exec(markdown);
  const endIdx = next?.index ?? markdown.length;
  return markdown.slice(startIdx, endIdx);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

- [ ] **Step 9.2:** Create `src/frames/commands/apply.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { extractAnchorNeighborhood } from "./apply.js";

describe("extractAnchorNeighborhood", () => {
  it("extracts text from anchor to next anchor", () => {
    const md = `<a id="a"></a>\nA-body\n<a id="b"></a>\nB-body`;
    const r = extractAnchorNeighborhood(md, "a");
    expect(r).toContain("A-body");
    expect(r).not.toContain("B-body");
  });

  it("extracts to end of document if no next anchor", () => {
    const md = `pre\n<a id="last"></a>\nfinal-body`;
    expect(extractAnchorNeighborhood(md, "last")).toContain("final-body");
  });

  it("returns empty when anchor missing", () => {
    expect(extractAnchorNeighborhood(`no anchors`, "x")).toBe("");
  });
});
```

- [ ] **Step 9.3:** Wire `apply` into `src/frames/cli.ts`. Add a case before `case "audit":`:

```typescript
    case "apply": {
      const framePath = args[1];
      const instanceId = args[2];
      if (!framePath || !instanceId) {
        console.error("Usage: beekeeper frame apply <framePath> <instance> [--adopt]");
        return 1;
      }
      const flags = args.slice(3);
      const adopt = flags.includes("--adopt");
      const { applyFrame } = await import("./commands/apply.js");
      return await applyFrame(framePath, instanceId, { adopt });
    }
```

- [ ] **Step 9.4:** Verify

```bash
npm run typecheck
npx vitest run src/frames/commands/apply.test.ts
npm run build
```

Expected: typecheck clean, 3 tests pass, build clean.

- [ ] **Step 9.5:** Commit

```bash
git add src/frames/commands/apply.ts src/frames/commands/apply.test.ts src/frames/cli.ts
git commit -m "feat(frames): frame apply --adopt"
```

---

## Task 10: End-to-end smoke test against dodi

This task is a manual validation, not automated — it requires a live MongoDB and a real Hive instance. Skip the commit if any step fails; debug and re-run.

- [ ] **Step 10.1:** Add `dodi` to `~/.beekeeper/beekeeper.yaml` (or wherever `BEEKEEPER_CONFIG` points). Append:

```yaml
instances:
  dodi:
    servicePath: /Users/mokie/services/hive/dodi
```

- [ ] **Step 10.2a:** Preflight — confirm the anchors the smoke-test frame will reference actually exist in dodi's live constitution. Required because adopt fails fast on a missing anchor and you need to distinguish "implementation bug" from "stale precondition."

```bash
mongosh hive_dodi --quiet --eval 'const c = db.memory.findOne({path:"shared/constitution.md"}); print((c?.content || "").match(/<a\s+id\s*=\s*"[^"]+"/g)?.join("\n") || "(no anchors)");'
```

Expected output includes (at minimum):

```
<a id="memory"
<a id="capabilities"
```

If those two anchors are missing, do not proceed — the smoke test will fail for the wrong reason. Either pick different anchors that do exist, or update the constitution to add anchors first.

- [ ] **Step 10.2b:** Author a tiny test frame that adopts cleanly against dodi's current state.

```bash
mkdir -p ~/.beekeeper/frames/test-baseline/constitution
cat > ~/.beekeeper/frames/test-baseline/frame.yaml <<'YAML'
name: test-baseline
version: 0.0.1
description: Smoke-test frame for adopt against dodi
constitution:
  - anchor: capabilities
    insert: replace-anchor
    file: constitution/capabilities.md
  - anchor: memory
    insert: replace-anchor
    file: constitution/memory.md
YAML
echo "stub" > ~/.beekeeper/frames/test-baseline/constitution/capabilities.md
echo "stub" > ~/.beekeeper/frames/test-baseline/constitution/memory.md
```

- [ ] **Step 10.3:** Run the smoke-test sequence:

```bash
cd /Users/mokie/github/beekeeper
npm run build

node dist/cli.js frame list dodi
# Expected: No frames applied to "dodi".

node dist/cli.js frame apply ~/.beekeeper/frames/test-baseline dodi --adopt
# Expected: Adopted frame "test-baseline" v0.0.1 on "dodi".

node dist/cli.js frame list dodi
# Expected: one line listing test-baseline.

node dist/cli.js frame audit dodi
# Expected: Audit clean: 1 frame(s) applied, no drift detected.
```

- [ ] **Step 10.4:** Cleanup the test frame from dodi:

```bash
mongosh hive_dodi --quiet --eval 'db.applied_frames.deleteOne({_id: "test-baseline"})'
node dist/cli.js frame list dodi
# Expected: No frames applied to "dodi".
rm -rf ~/.beekeeper/frames/test-baseline
```

- [ ] **Step 10.5:** Negative test: verify missing-anchor abort.

```bash
mkdir -p ~/.beekeeper/frames/bad-frame/constitution
cat > ~/.beekeeper/frames/bad-frame/frame.yaml <<'YAML'
name: bad-frame
version: 0.0.1
constitution:
  - anchor: this-anchor-does-not-exist
    insert: replace-anchor
    file: constitution/x.md
YAML
echo "stub" > ~/.beekeeper/frames/bad-frame/constitution/x.md

node dist/cli.js frame apply ~/.beekeeper/frames/bad-frame dodi --adopt
# Expected: exit code 1, error mentioning MissingAnchorError and "this-anchor-does-not-exist".

mongosh hive_dodi --quiet --eval 'db.applied_frames.findOne({_id: "bad-frame"})'
# Expected: null. (No record was written for the failed apply.)

rm -rf ~/.beekeeper/frames/bad-frame
```

- [ ] **Step 10.6:** Final verification — full check.

```bash
npm run check
```

Expected: typecheck + all tests pass.

- [ ] **Step 10.7:** No code commit; this task is validation only. The `beekeeper.yaml.example` change from Task 2 is already committed.

---

## What this plan does NOT do

The following are explicitly deferred to subsequent plans (B, C, D in the implementation phasing):

- **Asset-write apply** — copying skill bundles, mutating coreServers/schedule/prompts/memory-seeds, mutating the constitution. Only `--adopt` is supported here.
- **`frame remove`** — needs the asset-write reversal infrastructure to be meaningful.
- **Drift dialog** — the conversational per-resource resolution flow. Audit currently reports findings but does not interactively resolve them.
- **Same-version re-apply with drift** — depends on the drift dialog being implemented.
- **`requires` and `conflicts` enforcement on apply** — the plan implements the schema and the `findDependents` query, but does not yet enforce dependency order at apply time (no asset writes happen in `--adopt` mode, so order doesn't matter).
- **Pre-/post-apply hook execution** — schema is parsed but hooks are not run.
- **SIGUSR1 trigger** — no agent definitions are mutated in this plan, so reload is unnecessary.
- **Wildcard agent expansion in prompts/coreservers/memory-seeds/schedule** — adopt currently skips wildcards in anchor-validation. Subsequent plans implement live expansion against `agent_definitions`.
- **Hand-authored `hive-baseline`** — the test frame in Task 10 is a smoke-test stub. The real `hive-baseline` (with all of dodi's constitution clauses, universal-9 coreServers, hygiene cron) lands in Plan D.

---

## Test coverage summary

| File | Test count | Type |
|---|---|---|
| `manifest-loader.test.ts` | 6 | Unit |
| `anchor-resolver.test.ts` | 7 | Unit |
| `applied-frames-store.test.ts` | 5 | Integration (requires local MongoDB) |
| `commands/apply.test.ts` | 3 | Unit |
| End-to-end smoke (Task 10) | 5 manual checks | Integration (requires running Hive instance) |

Total: 21 automated assertions, 5 manual smoke-test checks.

---

## Acceptance criteria

- [ ] `npm run check` is green.
- [ ] `node dist/cli.js frame list <instance>` returns the applied frames or empty message.
- [ ] `node dist/cli.js frame apply <path> <instance> --adopt` records a snapshot when anchors resolve, and refuses with a clear error when they don't.
- [ ] `node dist/cli.js frame audit <instance>` reports no findings on a freshly adopted frame.
- [ ] No `any` types added in production code.
- [ ] Process spawning, where introduced, uses the safe `execFile`-style API (none required for this plan, but constraint applies to subsequent plans).
- [ ] Commit count: ~9 (one per task).
