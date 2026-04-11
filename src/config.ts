import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { RelayConfig } from "./types.js";
import { createLogger } from "./logging/logger.js";

const log = createLogger("relay-config");

function envWithFallback(newName: string, oldName: string): string | undefined {
  const value = process.env[newName] ?? process.env[oldName];
  if (!process.env[newName] && process.env[oldName]) {
    log.warn(`Deprecated env var ${oldName} — use ${newName} instead`);
  }
  return value;
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

export function loadConfig(): RelayConfig {
  const configPath = resolve(envWithFallback("RELAY_CONFIG", "BEEKEEPER_CONFIG") ?? "./relay.yaml");
  if (!existsSync(configPath)) {
    throw new Error(`Relay config not found: ${configPath}`);
  }

  const raw = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown>;

  const jwtSecret = envWithFallback("RELAY_JWT_SECRET", "BEEKEEPER_JWT_SECRET");
  if (!jwtSecret) {
    throw new Error("Missing required env var: RELAY_JWT_SECRET");
  }

  const adminSecret = envWithFallback("RELAY_ADMIN_SECRET", "BEEKEEPER_ADMIN_SECRET");
  if (!adminSecret) {
    throw new Error("Missing required env var: RELAY_ADMIN_SECRET");
  }

  const dataDir =
    envWithFallback("RELAY_DATA_DIR", "BEEKEEPER_DATA_DIR") ??
    (raw.data_dir as string) ??
    join(homedir(), ".relay", "data");

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
    port: (raw.port as number) ?? 3099,
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
  };
}
