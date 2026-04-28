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
