import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, lstatSync, existsSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  installSkillSymlink,
  removeSkillSymlink,
  installAllSkillSymlinks,
  removeAllSkillSymlinks,
  BUNDLED_SKILLS,
} from "./skill-installer.js";

const REAL_SKILL = "tune-instance";
const REAL_TARGET = resolve(import.meta.dirname, "..", "..", "skills", REAL_SKILL);
const SKILLS_ROOT = resolve(import.meta.dirname, "..", "..", "skills");

describe("installSkillSymlink", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "beekeeper-skill-test-"));
  });

  it("creates the symlink on a fresh install", () => {
    const result = installSkillSymlink(REAL_SKILL, baseDir);
    expect(result.status).toBe("created");
    expect(result.linkPath).toBe(join(baseDir, ".claude", "skills", REAL_SKILL));
    expect(result.targetPath).toBe(REAL_TARGET);
    expect(lstatSync(result.linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(result.linkPath)).toBe(REAL_TARGET);
  });

  it("is a no-op when the symlink already points at the right target", () => {
    installSkillSymlink(REAL_SKILL, baseDir);
    const result = installSkillSymlink(REAL_SKILL, baseDir);
    expect(result.status).toBe("already-current");
  });

  it("replaces a stale symlink that points at a different target", () => {
    const linkPath = join(baseDir, ".claude", "skills", REAL_SKILL);
    mkdirSync(join(baseDir, ".claude", "skills"), { recursive: true });
    const stalePath = join(baseDir, "stale-target");
    mkdirSync(stalePath, { recursive: true });
    writeFileSync(join(stalePath, "SKILL.md"), "stale");
    symlinkSync(stalePath, linkPath);

    const result = installSkillSymlink(REAL_SKILL, baseDir);
    expect(result.status).toBe("replaced");
    expect(readlinkSync(linkPath)).toBe(REAL_TARGET);
  });

  it("replaces a broken symlink whose target no longer exists", () => {
    const linkPath = join(baseDir, ".claude", "skills", REAL_SKILL);
    mkdirSync(join(baseDir, ".claude", "skills"), { recursive: true });
    symlinkSync(join(baseDir, "does-not-exist"), linkPath);

    const result = installSkillSymlink(REAL_SKILL, baseDir);
    expect(result.status).toBe("replaced");
    expect(readlinkSync(linkPath)).toBe(REAL_TARGET);
  });

  it("refuses to clobber a real directory at the link path", () => {
    const linkPath = join(baseDir, ".claude", "skills", REAL_SKILL);
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, "SKILL.md"), "operator-fork");

    const result = installSkillSymlink(REAL_SKILL, baseDir);
    expect(result.status).toBe("blocked-real-dir");
    expect(result.detail).toBeDefined();
    // Confirm the operator's directory is untouched.
    expect(lstatSync(linkPath).isDirectory()).toBe(true);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(false);
  });

  it("throws when the bundled skill is missing", () => {
    expect(() => installSkillSymlink("does-not-exist-skill", baseDir)).toThrow(
      /Bundled skill missing/,
    );
  });
});

describe("removeSkillSymlink", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "beekeeper-skill-test-"));
  });

  it("removes an existing symlink", () => {
    installSkillSymlink(REAL_SKILL, baseDir);
    const result = removeSkillSymlink(REAL_SKILL, baseDir);
    expect(result.status).toBe("removed");
    expect(existsSync(result.linkPath)).toBe(false);
  });

  it("does not remove a real directory at the link path", () => {
    const linkPath = join(baseDir, ".claude", "skills", REAL_SKILL);
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, "SKILL.md"), "operator-fork");

    const result = removeSkillSymlink(REAL_SKILL, baseDir);
    expect(result.status).toBe("skipped-real-dir");
    expect(lstatSync(linkPath).isDirectory()).toBe(true);
  });

  it("returns not-present when nothing is at the link path", () => {
    const result = removeSkillSymlink(REAL_SKILL, baseDir);
    expect(result.status).toBe("not-present");
  });
});

describe("installAllSkillSymlinks", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "beekeeper-skill-bulk-test-"));
  });

  it("creates symlinks for every bundled skill on a fresh install", () => {
    const reports = installAllSkillSymlinks(baseDir);
    expect(reports.length).toBe(BUNDLED_SKILLS.length);
    for (const skill of BUNDLED_SKILLS) {
      const report = reports.find((r) => r.skill === skill);
      expect(report).toBeDefined();
      expect(report?.result.status).toBe("created");
      const linkPath = join(baseDir, ".claude", "skills", skill);
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(linkPath)).toBe(join(SKILLS_ROOT, skill));
    }
  });

  it("is idempotent — re-running reports already-current for both skills", () => {
    installAllSkillSymlinks(baseDir);
    const reports = installAllSkillSymlinks(baseDir);
    for (const r of reports) {
      expect(r.result.status).toBe("already-current");
    }
  });

  it("preserves operator-forked skill directories on bulk install", () => {
    // Pre-create a real directory at the second skill's link path.
    const forked = BUNDLED_SKILLS[1];
    const linkPath = join(baseDir, ".claude", "skills", forked);
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, "SKILL.md"), "operator-fork");

    const reports = installAllSkillSymlinks(baseDir);
    const forkedReport = reports.find((r) => r.skill === forked);
    expect(forkedReport?.result.status).toBe("blocked-real-dir");
    // The other skill still installed cleanly.
    const other = BUNDLED_SKILLS.find((s) => s !== forked);
    if (other) {
      const otherReport = reports.find((r) => r.skill === other);
      expect(otherReport?.result.status).toBe("created");
    }
  });
});

describe("removeAllSkillSymlinks", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "beekeeper-skill-bulk-rm-test-"));
  });

  it("removes every symlink that was previously installed", () => {
    installAllSkillSymlinks(baseDir);
    const reports = removeAllSkillSymlinks(baseDir);
    for (const r of reports) {
      expect(r.result.status).toBe("removed");
      expect(existsSync(r.result.linkPath)).toBe(false);
    }
  });

  it("returns not-present for symlinks that were never installed", () => {
    const reports = removeAllSkillSymlinks(baseDir);
    for (const r of reports) {
      expect(r.result.status).toBe("not-present");
    }
  });

  it("preserves operator-forked real directories on bulk uninstall", () => {
    const forked = BUNDLED_SKILLS[0];
    const linkPath = join(baseDir, ".claude", "skills", forked);
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, "SKILL.md"), "operator-fork");

    const reports = removeAllSkillSymlinks(baseDir);
    const forkedReport = reports.find((r) => r.skill === forked);
    expect(forkedReport?.result.status).toBe("skipped-real-dir");
    expect(lstatSync(linkPath).isDirectory()).toBe(true);
  });
});
