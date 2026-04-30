import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, unlinkSync, existsSync, chmodSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../logging/logger.js";
import { installAllSkillSymlinks, removeAllSkillSymlinks } from "./skill-installer.js";

const log = createLogger("beekeeper-service");

// Reverse-DNS label for the LaunchAgent. The real domain is keepur.io, so
// the reverse is io.keepur.beekeeperd — NOT com.keepur.beekeeperd (we do not
// own keepur.com). The trailing "d" mirrors the daemon binary name and
// distinguishes the daemon from the operator CLI (`beekeeper`).
const LABEL = "io.keepur.beekeeperd";

// Pre-1.2 installs used `io.keepur.beekeeper` (without the trailing "d").
// install/uninstall both clean up that legacy label so an upgrader doesn't
// end up with two LaunchAgents fighting for :8420.
const LEGACY_LABEL = "io.keepur.beekeeper";

/**
 * Resolve where the built index.js lives for this install.
 * In a normal `npm run build` checkout, dist/service/generate-plist.js is two
 * levels deep from dist/index.js.
 */
function resolveIndexPath(): string {
  return resolve(import.meta.dirname, "../index.js");
}

/**
 * Resolve the repo/source root that contains the `dist/` directory. At
 * runtime `import.meta.dirname` is `<repo>/dist/service`, so `..` is
 * `<repo>/dist` and `../..` is the repo root. This is where the wrapper
 * script gets written in wrapper mode.
 */
function resolveRepoRoot(): string {
  return resolve(import.meta.dirname, "../..");
}

/**
 * Path to the bundled `beekeeper.yaml.example`. It ships at the package root
 * (declared in `package.json#files`) for both source checkouts and npm
 * installs. May not exist in unusual packaging — callers must check.
 */
function resolveExampleConfigPath(): string {
  return join(resolveRepoRoot(), "beekeeper.yaml.example");
}

/**
 * Seed `<configDir>/beekeeper.yaml` if it doesn't already exist. Re-running
 * `beekeeper install` on a configured machine never overwrites the user's
 * config — that's the same idempotence the rest of install relies on.
 *
 * Source preference: copy the bundled example so the seed includes the same
 * commented documentation users would see in the README. If the example is
 * missing (custom packaging, manual edit), write a minimal two-line config
 * so the LaunchAgent can still boot — server-side defaults fill the rest.
 */
export function seedConfigIfMissing(configDir: string): {
  path: string;
  created: boolean;
  source: "example" | "minimal" | null;
} {
  const target = join(configDir, "beekeeper.yaml");
  if (existsSync(target)) return { path: target, created: false, source: null };

  mkdirSync(configDir, { recursive: true });

  const example = resolveExampleConfigPath();
  if (existsSync(example)) {
    copyFileSync(example, target);
    return { path: target, created: true, source: "example" };
  }

  writeFileSync(target, "port: 8420\nmodel: claude-opus-4-6\n");
  return { path: target, created: true, source: "minimal" };
}

/**
 * POSIX shell-quote: wrap in single quotes and escape any embedded single
 * quotes via the `'\''` dance. Safe for any byte sequence except NUL.
 * Used to embed runtime paths into the generated wrapper script so a
 * workDir containing `"`, `$`, or a backtick can't corrupt it.
 */
function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Escape a string for safe inclusion inside an XML text node or attribute.
 * The plist format is XML; paths containing `&`, `<`, or `>` would
 * otherwise produce an invalid document.
 */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Write a wrapper shell script that sources `envFile` and execs node on the
 * built index.js. Returns the absolute path to the wrapper. Idempotent —
 * overwrites on each install so a rebuild can't leave a stale wrapper
 * pointing at an old path.
 *
 * Wrapper lives under `<workDir>/bin/start.sh` (the user's beekeeper config
 * directory, e.g. `~/.beekeeper/bin/start.sh`). Earlier versions wrote it
 * inside the package directory at `<repoRoot>/bin/start.sh`, which broke
 * for `npm i -g` users — the package directory is root-owned after a sudo
 * install and `beekeeper install` runs as the user. The config dir is
 * always user-owned, so writing there works for both source and npm
 * installs.
 */
export function writeWrapperScript(
  envFile: string,
  nodePath: string,
  indexPath: string,
  workDir: string,
): string {
  const wrapperDir = join(workDir, "bin");
  const wrapperPath = join(wrapperDir, "start.sh");
  mkdirSync(wrapperDir, { recursive: true });

  // When launchd starts a gui/ LaunchAgent, the child process inherits a
  // minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) — no /opt/homebrew/bin, no
  // /usr/local/bin. That breaks any `spawn("node", ...)` or `spawn("git", ...)`
  // call from beekeeper or from tools Claude Code runs (bash, git, npm, etc.),
  // because the binaries aren't in that default PATH. We export a reasonable
  // PATH in the wrapper BEFORE sourcing the env file, so a user-provided
  // PATH= line in ~/.beekeeper/env still wins (it'll overwrite this default).
  const defaultPath = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

  const content = `#!/usr/bin/env bash
# Auto-generated by 'beekeeper install'. Regenerated on each install.
# Sources the env file (secrets + paths) and execs the built server.
set -euo pipefail

# Ensure a sane PATH for subprocess spawns (node, git, bash tools). launchd's
# default PATH omits /opt/homebrew/bin which breaks Claude Code's own tool
# use. Set BEFORE sourcing the env file so a user-provided PATH line in that
# file can still override this default.
export PATH=${shQuote(defaultPath)}

ENV_FILE=${shQuote(envFile)}
if [[ ! -f "\${ENV_FILE}" ]]; then
  echo "missing env file: \${ENV_FILE}" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "\${ENV_FILE}"
set +a

exec ${shQuote(nodePath)} ${shQuote(indexPath)}
`;

  writeFileSync(wrapperPath, content);
  chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

/**
 * Generate the plist XML. When `wrapperPath` is provided, the plist runs the
 * wrapper script instead of node directly (so secrets can be sourced from an
 * env file without being embedded in the plist).
 */
export function generatePlist(options: {
  configDir: string;
  wrapperPath?: string;
  nodePath: string;
  indexPath: string;
  logDir: string;
}): string {
  const { configDir, wrapperPath, nodePath, indexPath, logDir } = options;

  const programArgs = wrapperPath ? [wrapperPath] : [nodePath, indexPath];
  const programArgsXml = programArgs
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join("\n");

  // When a wrapper sources its own env file, the plist doesn't need to embed
  // BEEKEEPER_CONFIG. Direct-node mode still sets it for back-compat.
  const envVarsXml = wrapperPath
    ? ""
    : `  <key>EnvironmentVariables</key>
  <dict>
    <key>BEEKEEPER_CONFIG</key>
    <string>beekeeper.yaml</string>
  </dict>
`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(configDir)}</string>
${envVarsXml}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logDir)}/beekeeper.log</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logDir)}/beekeeper.err</string>
</dict>
</plist>`;
}

/**
 * Install the LaunchAgent plist. If `${configDir}/env` exists, install
 * generates a wrapper script at `${configDir}/bin/start.sh` that sources the
 * env file, and points the plist at that wrapper. Otherwise, the plist runs
 * node directly (legacy mode — requires secrets to be in launchd's env).
 */
/**
 * Unload + delete the legacy `io.keepur.beekeeper.plist` if present. Pre-1.2
 * installs used that label; from 1.2 onward we use `io.keepur.beekeeperd`.
 * Run this BEFORE writing the new plist so we never leave two LaunchAgents
 * fighting for :8420. Idempotent and silent when the legacy plist doesn't
 * exist.
 *
 * Exported and parameterized for tests — production callers can pass nothing
 * and get the real `~/Library/LaunchAgents` path.
 */
export function removeLegacyPlist(
  plistDir: string = join(homedir(), "Library", "LaunchAgents"),
): { removed: boolean; path: string } {
  const legacyPath = join(plistDir, `${LEGACY_LABEL}.plist`);
  if (!existsSync(legacyPath)) return { removed: false, path: legacyPath };
  // Capture launchctl's status: if the legacy daemon is currently loaded and
  // unload fails, we still unlink the plist below — but the daemon stays
  // running and would race :8420 with the new one. Surface that so an
  // operator can `launchctl bootout` it manually before kickstarting the
  // new label. We don't throw because the more common case is "plist exists
  // but isn't loaded," where launchctl exits non-zero harmlessly.
  const unload = spawnSync("launchctl", ["unload", legacyPath], { stdio: "ignore" });
  if (unload.status !== 0) {
    log.warn("launchctl unload of legacy plist returned non-zero", {
      path: legacyPath,
      status: unload.status,
    });
    console.log(
      `Note: launchctl unload ${legacyPath} returned ${unload.status} — if the legacy daemon is still running, stop it manually before kickstarting io.keepur.beekeeperd.`,
    );
  }
  try {
    unlinkSync(legacyPath);
    log.info("Legacy plist removed", { path: legacyPath, legacyLabel: LEGACY_LABEL });
    console.log(`Removed legacy LaunchAgent: ${legacyPath}`);
    return { removed: true, path: legacyPath };
  } catch (err) {
    log.warn("Failed to remove legacy plist", { error: err instanceof Error ? err.message : String(err) });
    return { removed: false, path: legacyPath };
  }
}

/**
 * The runner contract that `loadLaunchAgent` calls into. Real callers pass
 * `defaultRunner` (which delegates to `child_process.spawnSync`); tests pass
 * a mock that records the args and returns a controlled status.
 */
export type LaunchctlRunner = (args: string[]) => { status: number | null };

/** Synchronous sleep — injectable so tests don't pay the wall clock. */
export type Sleeper = (ms: number) => void;

const defaultRunner: LaunchctlRunner = (args) => {
  const r = spawnSync("launchctl", args, { stdio: "ignore" });
  return { status: r.status };
};

const defaultSleeper: Sleeper = (ms) => {
  // Atomics.wait blocks the current thread without busy-waiting and without
  // reaching for child_process. The buffer is private to this call so no
  // cross-thread coordination concerns apply.
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
};

const BOOTSTRAP_MAX_ATTEMPTS = 3;
const BOOTSTRAP_RETRY_MS = 250;

/**
 * Bootout-then-bootstrap a LaunchAgent so `beekeeper install` is genuinely
 * one-shot — no manual `launchctl load` follow-up. The bootout is silent
 * (it returns non-zero when the service isn't loaded, which is fine), so
 * this works for both first install and upgrade-in-place. Bootstrap is the
 * modern launchctl primitive that replaced `launchctl load`.
 *
 * Bootstrap is retried up to 3 attempts with a 250ms gap between. Real
 * machines occasionally see bootstrap exit 5 ("input/output error") right
 * after a bootout — the unload is async, and bootstrap can race with the
 * teardown even when the service is fully gone by the next try. Retrying
 * smooths over the transient without papering over a real failure: three
 * consecutive 5s is an actual problem.
 *
 * Returns a structured outcome (including attempt count) so install() can
 * print the right line and tests can assert retry behavior. If bootstrap
 * still fails after retries, we don't throw — install prints a manual
 * fallback so the operator can finish the load themselves.
 */
export function loadLaunchAgent(
  uid: number,
  label: string,
  plistPath: string,
  runner: LaunchctlRunner = defaultRunner,
  sleeper: Sleeper = defaultSleeper,
): { loaded: boolean; bootstrapStatus: number | null; attempts: number } {
  // bootout first — silent if not loaded. Lets us re-run install() to
  // pick up plist edits without needing the operator to know whether
  // they're upgrading or installing fresh.
  runner(["bootout", `gui/${uid}/${label}`]);

  let lastStatus: number | null = null;
  for (let attempt = 1; attempt <= BOOTSTRAP_MAX_ATTEMPTS; attempt++) {
    const r = runner(["bootstrap", `gui/${uid}`, plistPath]);
    lastStatus = r.status;
    if (r.status === 0) {
      return { loaded: true, bootstrapStatus: 0, attempts: attempt };
    }
    if (attempt < BOOTSTRAP_MAX_ATTEMPTS) sleeper(BOOTSTRAP_RETRY_MS);
  }
  return { loaded: false, bootstrapStatus: lastStatus, attempts: BOOTSTRAP_MAX_ATTEMPTS };
}

export function install(configDir?: string): void {
  const nodePath = process.execPath;
  const indexPath = resolveIndexPath();
  const workDir = configDir ?? join(homedir(), ".beekeeper");
  const logDir = join(workDir, "logs");
  mkdirSync(logDir, { recursive: true });

  // Migrate away from the pre-1.2 `io.keepur.beekeeper` label before writing
  // the new plist — running both at once would EADDRINUSE on :8420.
  removeLegacyPlist();

  const seed = seedConfigIfMissing(workDir);
  if (seed.created) {
    log.info("Seeded beekeeper.yaml", { path: seed.path, source: seed.source });
  }

  const envFile = join(workDir, "env");
  const useWrapper = existsSync(envFile);
  let wrapperPath: string | undefined;
  if (useWrapper) {
    wrapperPath = writeWrapperScript(envFile, nodePath, indexPath, workDir);
    log.info("Wrapper script written", { path: wrapperPath, envFile });
  }

  const plistContent = generatePlist({
    configDir: workDir,
    wrapperPath,
    nodePath,
    indexPath,
    logDir,
  });
  const plistDir = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(plistDir, `${LABEL}.plist`);

  mkdirSync(plistDir, { recursive: true });
  writeFileSync(plistPath, plistContent);
  log.info("Plist installed", { path: plistPath, wrapper: useWrapper });

  if (seed.created) {
    const origin = seed.source === "example" ? "beekeeper.yaml.example" : "minimal defaults";
    console.log(`Wrote ${seed.path} (from ${origin}). Edit it before first launch to set workspaces and other settings.`);
  } else {
    console.log(`Existing config: ${seed.path}`);
  }
  console.log(`LaunchAgent installed: ${plistPath}`);
  if (useWrapper) {
    console.log(`Wrapper script: ${wrapperPath}`);
    console.log(`Sources env from: ${envFile}`);
  } else {
    console.log(`No ${envFile} found — plist runs node directly.`);
    console.log(`If you need secrets, either:`);
    console.log(`  - create ${envFile} with BEEKEEPER_JWT_SECRET / BEEKEEPER_ADMIN_SECRET and re-run install`);
    console.log(`  - or manually edit the plist's EnvironmentVariables`);
  }
  // Auto-load (or reload) the LaunchAgent so install is one-shot. The
  // user's UID is what gui/<uid>/<label> resolves against; we read it
  // from process.getuid() rather than $UID so the behavior matches whoever
  // ran the command, not whatever shell var happens to be exported.
  const uid = process.getuid?.() ?? -1;
  if (uid >= 0) {
    const result = loadLaunchAgent(uid, LABEL, plistPath);
    if (result.loaded) {
      const note = result.attempts > 1 ? ` (after ${result.attempts} bootstrap attempts)` : "";
      console.log(`LaunchAgent loaded — daemon running on the configured port${note}.`);
      console.log(`Restart with: launchctl kickstart -k gui/${uid}/${LABEL}`);
      console.log(`Stop with:    launchctl bootout gui/${uid}/${LABEL}`);
    } else {
      log.warn("launchctl bootstrap exhausted retries", {
        status: result.bootstrapStatus,
        attempts: result.attempts,
      });
      console.log(
        `Note: launchctl bootstrap returned ${result.bootstrapStatus} after ${result.attempts} attempts. Load it manually with: launchctl bootstrap gui/${uid} ${plistPath}`,
      );
      console.log(`Stop with: launchctl bootout gui/${uid}/${LABEL}`);
    }
  } else {
    console.log(`Could not resolve uid; load manually with: launchctl bootstrap gui/$UID ${plistPath}`);
  }

  try {
    const reports = installAllSkillSymlinks();
    for (const { skill, result } of reports) {
      if (result.status === "created") {
        console.log(`Skill installed (${skill}): ${result.linkPath} → ${result.targetPath}`);
      } else if (result.status === "replaced") {
        console.log(`Skill symlink replaced (${skill}): ${result.linkPath} → ${result.targetPath}`);
      } else if (result.status === "already-current") {
        // silent — re-run idempotence
      } else if (result.status === "blocked-real-dir") {
        console.log(
          `Skill NOT installed (${skill}; real directory at ${result.linkPath}): ${result.detail ?? ""}`,
        );
      } else if (result.status === "failed") {
        console.log(
          `Skill install FAILED (${skill}): ${result.detail ?? "unknown error"} (target ${result.targetPath})`,
        );
      }
    }
  } catch (err) {
    log.warn("Skill install failed", { error: err instanceof Error ? err.message : String(err) });
    console.log("Skill install failed (non-fatal); see logs.");
  }
}

export function uninstall(): void {
  const plistDir = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(plistDir, `${LABEL}.plist`);
  const legacyPath = join(plistDir, `${LEGACY_LABEL}.plist`);

  let removedAny = false;
  for (const path of [plistPath, legacyPath]) {
    // spawnSync with an array avoids shell interpretation entirely.
    spawnSync("launchctl", ["unload", path], { stdio: "ignore" });
    if (existsSync(path)) {
      unlinkSync(path);
      log.info("Plist removed", { path });
      console.log(`LaunchAgent removed: ${path}`);
      removedAny = true;
    }
  }
  if (!removedAny) {
    console.log("No LaunchAgent found to remove.");
  }

  // Note: we intentionally do NOT delete the wrapper script under bin/start.sh.
  // It's harmless without the plist and users may still invoke it manually
  // from the shell.

  const skillRemoveReports = removeAllSkillSymlinks();
  for (const { skill, result } of skillRemoveReports) {
    if (result.status === "removed") {
      console.log(`Skill symlink removed (${skill}): ${result.linkPath}`);
    } else if (result.status === "skipped-real-dir") {
      console.log(`Skill at ${result.linkPath} is a real directory — not removing (${skill}).`);
    }
    // "not-present" → silent
  }
}
