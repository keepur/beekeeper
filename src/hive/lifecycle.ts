/**
 * `beekeeper hive setup` — the guided installer.
 *
 * Resolves the latest hive version from npm, downloads + extracts the
 * tarball into a beekeeper-owned cache directory, writes the install-bee
 * overlay CLAUDE.md, evicts stale cached versions, and spawns Claude Code
 * rooted at the cache so the operator gets a guided install session.
 *
 * Side effects (the runner contract abstracts them so tests can drive
 * the flow without hitting the network or the filesystem in earnest):
 *   - HTTPS GET to the npm registry for `@keepur/hive` metadata.
 *   - HTTPS GET for the tarball URL (follows redirects via the runner).
 *   - tar -xzf into the cache directory.
 *   - spawn `claude` with cwd at the cache root.
 *
 * Fail-loud: if any step short-circuits, throw with an actionable message.
 * `setup` is called from a CLI surface that surfaces thrown errors as
 * exit-1 + the error message to stderr (see src/cli.ts pattern).
 */

import { spawn, spawnSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createLogger } from "../logging/logger.js";
import { discoverHiveInstances, type HiveInstance } from "./discover.js";
import { renderInstallBeeClaudeMd } from "./install-bee-claude-md.js";

const log = createLogger("beekeeper-hive-lifecycle");

/**
 * Subset of the npm registry packument we actually care about for setup.
 * `npm view @keepur/hive --json` returns much more — we ignore the rest.
 */
export interface HivePackumentSlice {
  version: string;
  tarballUrl: string;
}

/** Fetcher contract — tests inject mocks. */
export interface LifecycleEnv {
  /** Resolve the latest hive version + tarball URL. */
  fetchPackument: () => Promise<HivePackumentSlice>;
  /** Stream a remote URL into a local file. */
  downloadFile: (url: string, destPath: string) => Promise<void>;
  /** Extract a tarball into a target directory; throws on non-zero exit. */
  extractTarball: (tarballPath: string, destDir: string) => void;
  /** Spawn Claude Code rooted at cwd. Returns immediately (detached-ish). */
  launchClaude: (cwd: string) => void;
  /** Discovery helper — defaults wrap discover.ts but tests can stub. */
  listInstances: () => HiveInstance[];
  /** Default: `~/.beekeeper/hive-cache`. Tests pass a tmp dir. */
  cacheRoot: string;
}

export const defaultLifecycleEnv: LifecycleEnv = {
  fetchPackument: defaultFetchPackument,
  downloadFile: defaultDownloadFile,
  extractTarball: defaultExtractTarball,
  launchClaude: defaultLaunchClaude,
  listInstances: () => discoverHiveInstances(),
  cacheRoot: join(homedir(), ".beekeeper", "hive-cache"),
};

export interface SetupOptions {
  /** Bypass the existing-install short-circuit. */
  force?: boolean;
}

export interface SetupResult {
  version: string;
  cacheDir: string;
  /** True if we re-used an already-extracted cache for this version. */
  reusedCache: boolean;
  /** Existing instance that triggered the short-circuit (when not forced). */
  shortCircuited?: HiveInstance;
}

/**
 * Run the guided installer. Returns when Claude Code has been launched (the
 * spawn is detached / inheriting stdio so the parent process exits and the
 * operator's terminal is taken over by Claude Code). On short-circuit
 * (existing install, no --force), returns without launching Claude.
 */
export async function setup(
  opts: SetupOptions = {},
  env: LifecycleEnv = defaultLifecycleEnv,
): Promise<SetupResult> {
  // Short-circuit on existing install unless forced. The operator can still
  // get an ops session via `beekeeper hive claude <id>` (Phase B).
  if (!opts.force) {
    const existing = env.listInstances().find((i) => i.version !== null);
    if (existing) {
      console.log(`Found existing instance: ${existing.id} (engine ${existing.version}).`);
      console.log(`Use 'beekeeper hive list' to see all instances.`);
      console.log(`Pass --force to set up a fresh install alongside it.`);
      return {
        version: existing.version ?? "unknown",
        cacheDir: "",
        reusedCache: false,
        shortCircuited: existing,
      };
    }
  }

  console.log("Resolving latest hive version from npm…");
  const pkt = await env.fetchPackument();
  console.log(`Latest: @keepur/hive@${pkt.version}`);

  const versionDir = join(env.cacheRoot, pkt.version);
  const packageDir = join(versionDir, "package");
  const tarballPath = join(versionDir, ".tarball.tgz");
  const overlayPath = join(versionDir, "CLAUDE.md");

  let reusedCache = false;
  if (existsSync(packageDir)) {
    console.log(`Cache hit: ${packageDir}`);
    reusedCache = true;
  } else {
    mkdirSync(versionDir, { recursive: true });
    console.log(`Downloading tarball → ${tarballPath}`);
    await env.downloadFile(pkt.tarballUrl, tarballPath);
    console.log(`Extracting → ${packageDir}`);
    env.extractTarball(tarballPath, versionDir);
  }

  // Always rewrite the overlay so a beekeeper upgrade picks up changes
  // even when the underlying cache is reused.
  writeFileSync(overlayPath, renderInstallBeeClaudeMd({ hiveVersion: pkt.version }));
  log.info("Install-bee overlay written", { path: overlayPath, version: pkt.version });

  evictStaleCache(env.cacheRoot, pkt.version, env.listInstances().map((i) => i.version).filter(Boolean) as string[]);

  console.log("");
  console.log(`Launching Claude Code in ${versionDir}`);
  console.log(`The session will guide you through installing hive ${pkt.version}.`);
  console.log("");
  env.launchClaude(versionDir);

  return { version: pkt.version, cacheDir: versionDir, reusedCache };
}

/**
 * Remove cached version directories that aren't the new one and aren't the
 * version of any currently-installed instance. Idempotent and silent on
 * missing cache root.
 */
export function evictStaleCache(cacheRoot: string, keepVersion: string, alsoKeep: string[]): void {
  if (!existsSync(cacheRoot)) return;
  const keep = new Set([keepVersion, ...alsoKeep]);
  let entries: string[];
  try {
    entries = readdirSync(cacheRoot);
  } catch {
    return;
  }
  for (const name of entries) {
    if (keep.has(name)) continue;
    if (name.startsWith(".")) continue;
    const target = join(cacheRoot, name);
    try {
      rmSync(target, { recursive: true, force: true });
      log.info("Evicted stale hive cache", { path: target });
    } catch (err) {
      log.warn("Failed to evict cache dir", { path: target, error: String(err) });
    }
  }
}

// ----- Default env implementations -----

async function defaultFetchPackument(): Promise<HivePackumentSlice> {
  const url = "https://registry.npmjs.org/@keepur/hive/latest";
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(
      `Failed to reach npm registry at ${url}: ${err instanceof Error ? err.message : String(err)}. Check your connection.`,
    );
  }
  if (!res.ok) {
    throw new Error(`npm registry returned ${res.status} ${res.statusText} for ${url}`);
  }
  const body = (await res.json()) as { version?: unknown; dist?: { tarball?: unknown } };
  if (typeof body.version !== "string" || typeof body.dist?.tarball !== "string") {
    throw new Error(`Unexpected npm registry response shape from ${url}`);
  }
  return { version: body.version, tarballUrl: body.dist.tarball };
}

async function defaultDownloadFile(url: string, destPath: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(
      `Failed to download tarball from ${url}: ${err instanceof Error ? err.message : String(err)}.`,
    );
  }
  if (!res.ok || !res.body) {
    throw new Error(`Tarball download returned ${res.status} ${res.statusText} for ${url}`);
  }
  // Stream into a file rather than buffering the whole tarball in memory —
  // hive's tarball is ~8MB today but will grow.
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(destPath));
}

function defaultExtractTarball(tarballPath: string, destDir: string): void {
  // /usr/bin/tar is on every macOS install — beekeeper is macOS-only.
  // npm tarballs always contain a top-level `package/` directory; running
  // tar from `destDir` lands the contents at `destDir/package/`.
  const result = spawnSync("/usr/bin/tar", ["-xzf", tarballPath, "-C", destDir], { stdio: "ignore" });
  if (result.status !== 0) {
    throw new Error(
      `tar -xzf ${tarballPath} -C ${destDir} exited ${result.status}. Tarball may be corrupt; delete ${tarballPath} and retry.`,
    );
  }
}

function defaultLaunchClaude(cwd: string): void {
  // Spawn detached + stdio:inherit so Claude Code takes over the operator's
  // terminal and survives our process exit. We don't await; we don't unref
  // either, because the parent is exiting right after — we want the child
  // attached to the TTY for the operator's session.
  const child = spawn("claude", [], { cwd, stdio: "inherit" });
  child.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(
        "claude (Claude Code CLI) was not found on PATH. Install it from https://docs.claude.com/en/docs/agents-and-tools/claude-code/quickstart and re-run.",
      );
    } else {
      console.error(`Failed to launch Claude Code: ${err.message}`);
    }
    process.exit(1);
  });
}
