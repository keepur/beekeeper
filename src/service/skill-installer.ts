import { existsSync, lstatSync, readlinkSync, symlinkSync, unlinkSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "../logging/logger.js";

const log = createLogger("skill-installer");

const SKILL_NAME = "tune-instance";

/**
 * Bundled skills shipped by this Beekeeper install. Each name corresponds to
 * a directory under `<repo>/skills/<name>/SKILL.md`. The postinstall step
 * symlinks every entry into `~/.claude/skills/<name>/`.
 *
 * Add new bundled skills here when authoring them under `skills/<name>/`.
 */
export const BUNDLED_SKILLS = ["tune-instance", "init-instance"] as const;
export type BundledSkillName = (typeof BUNDLED_SKILLS)[number];

/**
 * Resolve the absolute path to the bundled skill directory inside this
 * beekeeper install. At runtime `import.meta.dirname` is `<repo>/dist/service`,
 * so `../../skills/<name>` walks back to `<repo>/skills/<name>`. The same
 * arithmetic resolveRepoRoot() uses in generate-plist.ts.
 */
function resolveBundledSkillPath(name: string): string {
  return resolve(import.meta.dirname, "..", "..", "skills", name);
}

/**
 * Resolve where the symlink lives in the user's Claude Code skills directory.
 * Beekeeper's existing skill auto-discovery (config.ts:84-97 discoverUserSkills)
 * walks ~/.claude/skills/ for any directory or symlink with a SKILL.md inside.
 */
function resolveLinkPath(name: string, baseDir?: string): string {
  return join(baseDir ?? homedir(), ".claude", "skills", name);
}

/**
 * Create a symlink at ~/.claude/skills/<name> pointing at the bundled
 * skills/<name> in this beekeeper install. Idempotent:
 *
 *   - If link already exists and points at the right target → no-op.
 *   - If link points at a different beekeeper install → replace.
 *   - If link is broken (target missing) → replace.
 *   - If a real directory exists at the link path → log warning, do NOT clobber.
 *
 * Returns a result object describing what happened, for the caller to print.
 */
/**
 * @param baseDir - Optional override for the install root. Defaults to homedir().
 *                  For testing only; production callers omit it.
 */
export function installSkillSymlink(
  skillName: string = SKILL_NAME,
  baseDir?: string,
): {
  status: "created" | "already-current" | "replaced" | "blocked-real-dir";
  linkPath: string;
  targetPath: string;
  detail?: string;
} {
  const targetPath = resolveBundledSkillPath(skillName);
  const linkPath = resolveLinkPath(skillName, baseDir);

  // Ensure parent directory exists. Derive parent from linkPath itself so we
  // honor baseDir during tests — mkdirSync(join(homedir(), ...)) would create
  // a side-effect directory in the real user's home, breaking test isolation.
  mkdirSync(dirname(linkPath), { recursive: true });

  // Sanity: the target must actually exist before we link to it.
  if (!existsSync(targetPath) || !existsSync(join(targetPath, "SKILL.md"))) {
    throw new Error(`Bundled skill missing or has no SKILL.md: ${targetPath}`);
  }

  // Inspect what's currently at linkPath.
  let currentKind: "missing" | "symlink" | "real-dir" | "broken-symlink" = "missing";
  let currentTarget: string | undefined;
  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      currentTarget = readlinkSync(linkPath);
      currentKind = existsSync(linkPath) ? "symlink" : "broken-symlink";
    } else if (stat.isDirectory()) {
      currentKind = "real-dir";
    }
  } catch {
    // ENOENT — falls through as "missing"
  }

  if (currentKind === "real-dir") {
    log.warn("Skill already installed as a real directory; not overwriting", { linkPath });
    return {
      status: "blocked-real-dir",
      linkPath,
      targetPath,
      detail: "Operator-forked or pre-existing install. rm the directory and re-run install to replace.",
    };
  }

  if (currentKind === "symlink" && currentTarget === targetPath) {
    return { status: "already-current", linkPath, targetPath };
  }

  // symlink (different target) | broken-symlink | missing → (re)create
  if (currentKind === "symlink" || currentKind === "broken-symlink") {
    unlinkSync(linkPath);
  }
  symlinkSync(targetPath, linkPath);

  return {
    status: currentKind === "missing" ? "created" : "replaced",
    linkPath,
    targetPath,
  };
}

/**
 * Remove the symlink at ~/.claude/skills/<name> if (and only if) it is a
 * symlink. A real directory at that path is NOT removed — operator owns it.
 *
 * Per spec §"Skill identity": uninstall is operator-driven; postinstall does
 * not garbage-collect on its own. This function is exposed for symmetry with
 * generate-plist.uninstall() but only fires when the operator explicitly
 * runs `beekeeper uninstall`.
 */
/**
 * @param baseDir - Optional override for the install root. Defaults to homedir().
 *                  For testing only; production callers omit it.
 */
export function removeSkillSymlink(
  skillName: string = SKILL_NAME,
  baseDir?: string,
): {
  status: "removed" | "not-present" | "skipped-real-dir";
  linkPath: string;
} {
  const linkPath = resolveLinkPath(skillName, baseDir);
  let kind: "missing" | "symlink" | "real-dir" = "missing";
  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) kind = "symlink";
    else if (stat.isDirectory()) kind = "real-dir";
  } catch {
    // ENOENT
  }

  if (kind === "missing") return { status: "not-present", linkPath };
  if (kind === "real-dir") {
    log.info("Not removing real-directory skill install", { linkPath });
    return { status: "skipped-real-dir", linkPath };
  }
  unlinkSync(linkPath);
  return { status: "removed", linkPath };
}

export interface SkillInstallReport {
  skill: BundledSkillName;
  result: ReturnType<typeof installSkillSymlink>;
}

export interface SkillRemoveReport {
  skill: BundledSkillName;
  result: ReturnType<typeof removeSkillSymlink>;
}

/**
 * Install symlinks for every bundled skill. Best-effort iteration: a missing
 * bundled skill (e.g., a packaging issue that drops one directory) does NOT
 * prevent the others from being installed. Each skill's individual result is
 * captured in the returned array; callers (e.g. `beekeeper install`) iterate
 * to print per-skill status.
 */
export function installAllSkillSymlinks(baseDir?: string): SkillInstallReport[] {
  const reports: SkillInstallReport[] = [];
  for (const skill of BUNDLED_SKILLS) {
    try {
      reports.push({ skill, result: installSkillSymlink(skill, baseDir) });
    } catch (err) {
      log.warn("Skill install failed", {
        skill,
        error: err instanceof Error ? err.message : String(err),
      });
      reports.push({
        skill,
        result: {
          status: "blocked-real-dir",
          linkPath: "",
          targetPath: "",
          detail: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
  return reports;
}

/**
 * Remove symlinks for every bundled skill. Same best-effort posture as
 * `installAllSkillSymlinks`; a real directory at any link path is preserved
 * (operator-fork protection). `not-present` is silent.
 */
export function removeAllSkillSymlinks(baseDir?: string): SkillRemoveReport[] {
  return BUNDLED_SKILLS.map((skill) => ({
    skill,
    result: removeSkillSymlink(skill, baseDir),
  }));
}
