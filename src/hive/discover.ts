/**
 * Enumerate hive instances installed on the local machine.
 *
 * The convention is `~/services/hive/<instance-id>/` with the engine
 * extracted to `<instance-id>/.hive/` (post-0.2.0 layout). Beekeeper has
 * zero awareness of installed hives today; `beekeeper hive list` is the
 * first command that needs that picture.
 *
 * Read-only — never mutates anything under `~/services/hive/`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { createLogger } from "../logging/logger.js";

const log = createLogger("beekeeper-hive-discover");

export interface HiveInstance {
  /** Instance id from the directory name (e.g. "dodi", "keepur"). */
  id: string;
  /** Absolute path to the instance directory. */
  path: string;
  /**
   * Engine version from `<instance>/.hive/package.json`. `null` when the
   * `.hive/` engine directory is missing or unreadable — typical for an
   * instance dir that started but never completed `hive init`.
   */
  version: string | null;
  /**
   * Whether the per-instance launchd agent (`com.hive.<id>.agent`) is
   * loaded and has a non-zero PID. `null` when uid resolution fails (we
   * can't query gui/<uid>/...).
   */
  running: boolean | null;
  /**
   * Discovered ws port from `<instance>/hive.yaml`. `null` when the file
   * is missing, malformed, or doesn't set a ws port (ws disabled). We
   * deliberately don't try to compute defaults from portBase here — the
   * operator's mental model is "what's actually configured," not "what
   * would I get if I started it now."
   */
  port: number | null;
}

/**
 * Same runner contract used by generate-plist.loadLaunchAgent — keep it
 * local here too so tests can drive launchctl without spawning a real
 * subprocess. Returns the spawnSync `status` only because that's all the
 * caller needs.
 */
export type LaunchctlRunner = (args: string[]) => { status: number | null };

const defaultRunner: LaunchctlRunner = (args) => {
  const r = spawnSync("launchctl", args, { stdio: "ignore" });
  return { status: r.status };
};

export interface DiscoverOptions {
  /** Defaults to `~/services/hive`. Tests pass a tmp dir. */
  servicesRoot?: string;
  /** Defaults to `process.getuid()`. Tests pass a fixed value. */
  uid?: number;
  /** Tests inject a fake. */
  launchctl?: LaunchctlRunner;
}

/**
 * List all hive instances under `servicesRoot`, sorted by id. Skips:
 *
 * - Hidden dot-directories (`.DS_Store`, etc.).
 * - Directories whose name ends in `.bak` / `.pre-*` (operator backup
 *   pattern observed on @mokie's machine — `dodi.pre-0.2-bak`).
 * - Non-directories (stray files).
 *
 * For each surviving entry, attempt to read engine version and running
 * state. Failures degrade to `null` rather than throwing — `list` is a
 * status command, it should always finish.
 */
export function discoverHiveInstances(opts: DiscoverOptions = {}): HiveInstance[] {
  const servicesRoot = opts.servicesRoot ?? join(homedir(), "services", "hive");
  // Preserve explicit `uid: undefined` (tests use it to simulate Windows /
  // process.getuid-missing envs); only fall through to process.getuid()
  // when the key wasn't supplied at all.
  const uid = "uid" in opts ? opts.uid : process.getuid?.();
  const launchctl = opts.launchctl ?? defaultRunner;

  if (!existsSync(servicesRoot)) return [];

  let entries: string[];
  try {
    entries = readdirSync(servicesRoot);
  } catch (err) {
    log.warn("Failed to read services root", { servicesRoot, error: String(err) });
    return [];
  }

  const instances: HiveInstance[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (name.endsWith(".bak") || name.includes(".pre-")) continue;
    const path = join(servicesRoot, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    instances.push({
      id: name,
      path,
      version: readEngineVersion(path),
      running: uid === undefined ? null : isAgentRunning(uid, name, launchctl),
      // Prefer .env (where dodi sets WS_PORT) over hive.yaml — operators
      // often override the yaml with env, and the env value is the one
      // the running daemon actually binds to.
      port: readEnvWsPort(path) ?? readWsPort(path),
    });
  }

  instances.sort((a, b) => a.id.localeCompare(b.id));
  return instances;
}

function readEngineVersion(instancePath: string): string | null {
  const pkgPath = join(instancePath, ".hive", "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const raw = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch (err) {
    log.warn("Failed to read engine package.json", { path: pkgPath, error: String(err) });
    return null;
  }
}

/**
 * Read the ws port from `<instance>/hive.yaml`. Intentionally string-greppy
 * rather than pulling in a yaml parser — the file is operator-edited and
 * we only want one fact out of it. Returns `null` if the file is missing,
 * unreadable, or doesn't carry a `port:` line under `ws:`.
 *
 * Acceptable patterns (top-level `ws:` block):
 *
 *   ws:
 *     port: 3200
 *
 * Returns null for `ws.enabled: false` / no `ws:` block / port missing.
 */
function readWsPort(instancePath: string): number | null {
  const yamlPath = join(instancePath, "hive.yaml");
  if (!existsSync(yamlPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(yamlPath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  let inWsBlock = false;
  for (const line of lines) {
    if (/^ws:\s*$/.test(line)) {
      inWsBlock = true;
      continue;
    }
    if (inWsBlock) {
      // First non-indented line ends the block.
      if (line.length > 0 && !/^\s/.test(line)) break;
      const m = line.match(/^\s+port:\s*(\d+)/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return null;
}

/**
 * Read `WS_PORT=<n>` from `<instance>/.env`. Returns null if .env doesn't
 * exist, isn't readable, or doesn't carry the line. Comments and blank
 * lines are tolerated.
 */
function readEnvWsPort(instancePath: string): number | null {
  const envPath = join(instancePath, ".env");
  if (!existsSync(envPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*WS_PORT\s*=\s*"?(\d+)"?\s*$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function isAgentRunning(uid: number, instanceId: string, runner: LaunchctlRunner): boolean {
  // `launchctl print gui/<uid>/<label>` exits 0 when the service is loaded
  // (regardless of whether it's running this instant — KeepAlive means a
  // crashed daemon is still "loaded" from launchd's perspective and will
  // be relaunched). For the operator's "is it running" question this is
  // close enough: a loaded service either is running or will be within
  // ThrottleInterval, and an unloaded one definitively isn't.
  const label = `com.hive.${instanceId}.agent`;
  const r = runner(["print", `gui/${uid}/${label}`]);
  return r.status === 0;
}
