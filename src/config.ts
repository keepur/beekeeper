import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { BeekeeperConfig, PipelineConfig } from "./types.js";
import { createLogger } from "./logging/logger.js";

const log = createLogger("beekeeper-config");

/**
 * Merge KEY=VALUE lines from an env file into `process.env`, but only for
 * keys that are not already set. Returns the path sourced, or null if none.
 *
 * Lookup order:
 *   1. $BEEKEEPER_ENV_FILE (explicit override)
 *   2. $HOME/.beekeeper/env (default install location)
 *
 * This lets the CLI and the server work without requiring the caller to
 * manually `source` the env file first. Under launchd, the wrapper script
 * already exported the vars so this is a no-op.
 */
export function autoSourceEnv(): string | null {
  const candidates = [
    process.env.BEEKEEPER_ENV_FILE,
    join(homedir(), ".beekeeper", "env"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf-8");
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue; // existing env wins
      // Strip a single pair of surrounding quotes if present.
      let value = rawValue;
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
    return path;
  }
  return null;
}

/**
 * Discover all installed Claude Code plugins from ~/.claude/plugins/installed_plugins.json.
 */
function discoverInstalledPlugins(): string[] {
  const home = process.env.HOME ?? "";
  const installedPath = join(home, ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(installedPath)) return [];

  try {
    const data = JSON.parse(readFileSync(installedPath, "utf-8")) as {
      plugins: Record<string, Array<{ installPath: string }>>;
    };
    const paths: string[] = [];
    for (const versions of Object.values(data.plugins)) {
      for (const entry of versions) {
        if (entry.installPath && existsSync(entry.installPath)) {
          paths.push(entry.installPath);
        }
      }
    }
    return paths;
  } catch {
    log.warn("Failed to read installed plugins");
    return [];
  }
}

/**
 * Discover user-level skills from ~/.claude/skills/.
 * Each subdirectory with a SKILL.md is loaded as a local plugin.
 */
function discoverUserSkills(): string[] {
  const home = process.env.HOME ?? "";
  const skillsDir = join(home, ".claude", "skills");
  if (!existsSync(skillsDir)) return [];

  const paths: string[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    const fullPath = join(skillsDir, entry.name);
    if ((entry.isDirectory() || entry.isSymbolicLink()) && existsSync(join(fullPath, "SKILL.md"))) {
      paths.push(fullPath);
    }
  }
  return paths;
}

function parsePipeline(raw: unknown): PipelineConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v.linearTeamKey !== "string" || v.linearTeamKey.length === 0) {
    throw new Error("beekeeper.yaml: pipeline.linearTeamKey is required");
  }
  let repoPaths: Record<string, string> | undefined;
  if (v.repoPaths && typeof v.repoPaths === "object") {
    repoPaths = {};
    for (const [name, p] of Object.entries(v.repoPaths as Record<string, unknown>)) {
      if (typeof p !== "string" || p.length === 0) {
        throw new Error(`beekeeper.yaml: pipeline.repoPaths.${name} must be a non-empty string`);
      }
      repoPaths[name] = p.replace(/^~/, process.env.HOME ?? "");
    }
  }
  return {
    linearTeamKey: v.linearTeamKey,
    repoPaths,
    mainBranch: typeof v.mainBranch === "string" ? v.mainBranch : undefined,
  };
}

export function loadConfig(): BeekeeperConfig {
  const sourced = autoSourceEnv();
  if (sourced) {
    log.info("Sourced env file", { path: sourced });
  }

  const configPath = resolve(process.env.BEEKEEPER_CONFIG ?? "./beekeeper.yaml");
  if (!existsSync(configPath)) {
    // The npm-install path doesn't include an obvious "create this file"
    // step, so tell the user exactly how to seed one. `beekeeper install`
    // copies the example into ~/.beekeeper/beekeeper.yaml automatically.
    const example = resolve(import.meta.dirname, "..", "beekeeper.yaml.example");
    const hint = existsSync(example)
      ? `Run \`beekeeper install\` to seed one, or copy the example: cp ${example} ${configPath}`
      : `Run \`beekeeper install\` to seed one.`;
    throw new Error(`Beekeeper config not found: ${configPath}\n${hint}`);
  }

  const raw = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown>;

  const jwtSecret = process.env.BEEKEEPER_JWT_SECRET;
  if (!jwtSecret) {
    throw new Error("Missing required env var: BEEKEEPER_JWT_SECRET");
  }

  const adminSecret = process.env.BEEKEEPER_ADMIN_SECRET;
  if (!adminSecret) {
    throw new Error("Missing required env var: BEEKEEPER_ADMIN_SECRET");
  }

  const dataDir =
    process.env.BEEKEEPER_DATA_DIR ??
    (raw.data_dir as string) ??
    join(homedir(), ".beekeeper", "data");

  // Auto-discover: installed plugins + user skills + explicit extras
  const installedPlugins = discoverInstalledPlugins();
  const userSkills = discoverUserSkills();
  const extraPlugins = (raw.plugins as string[])?.map((p) => p.replace(/^~/, process.env.HOME ?? "")) ?? [];
  const allPlugins = [...new Set([...installedPlugins, ...userSkills, ...extraPlugins])];

  log.info("Plugin discovery complete", {
    installed: installedPlugins.length,
    userSkills: userSkills.length,
    extra: extraPlugins.length,
    total: allPlugins.length,
  });

  return {
    port: (raw.port as number) ?? 8420,
    model: (raw.model as string) ?? "claude-opus-4-6",
    confirmOperations: (raw.confirm_operations as string[]) ?? [
      "git push --force",
      "git branch -D",
      "rm -rf",
      "rm -r",
      "git reset --hard",
      "git checkout -- .",
      "git clean -f",
    ],
    jwtSecret,
    adminSecret,
    dataDir,
    defaultWorkspace: raw.default_workspace as string | undefined,
    workspaces: raw.workspaces as Record<string, string> | undefined,
    plugins: allPlugins,
    capabilitiesHealthIntervalMs: (raw.capabilities_health_interval_ms as number) ?? 10000,
    capabilitiesFailureThreshold: (raw.capabilities_failure_threshold as number) ?? 2,
    pipeline: parsePipeline(raw.pipeline),
  };
}
