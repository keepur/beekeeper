import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computeBundleHash, sha256File, sha256Text } from "./text-utils.js";

const EMPTY_HASH = sha256Text("");

let bundleA: string;
let bundleB: string;

const writeFile = (root: string, rel: string, content: string): void => {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
};

beforeEach(() => {
  bundleA = mkdtempSync(join(tmpdir(), "khash-a-"));
  bundleB = mkdtempSync(join(tmpdir(), "khash-b-"));
});

afterEach(() => {
  rmSync(bundleA, { recursive: true, force: true });
  rmSync(bundleB, { recursive: true, force: true });
});

describe("computeBundleHash", () => {
  it("flat bundle with SKILL.md at root: matches legacy sha256File(SKILL.md) for backwards-compat", () => {
    writeFile(bundleA, "SKILL.md", "# legacy skill\n\nContent.\n");
    const expected = sha256File(join(bundleA, "SKILL.md"));
    expect(computeBundleHash(bundleA)).toBe(expected);
  });

  it("nested-only bundle (memory-hygiene shape): produces a non-empty stable hash", () => {
    writeFile(bundleA, "skills/memory-hygiene-review/SKILL.md", "# memory hygiene review\n");
    const hash = computeBundleHash(bundleA);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(EMPTY_HASH);
    // stability across calls
    expect(computeBundleHash(bundleA)).toBe(hash);
  });

  it("nested-only bundle: same content, different write order produces the same hash", () => {
    // bundleA: write a.md first, then b.md
    writeFile(bundleA, "skills/sub/a.md", "alpha\n");
    writeFile(bundleA, "skills/sub/b.md", "bravo\n");

    // bundleB: write b.md first, then a.md
    writeFile(bundleB, "skills/sub/b.md", "bravo\n");
    writeFile(bundleB, "skills/sub/a.md", "alpha\n");

    expect(computeBundleHash(bundleA)).toBe(computeBundleHash(bundleB));
  });

  it("nested bundle: renaming a file changes the hash even when bytes are identical", () => {
    writeFile(bundleA, "skills/sub/SKILL.md", "X");
    writeFile(bundleB, "skills/sub/RENAMED.md", "X");
    expect(computeBundleHash(bundleA)).not.toBe(computeBundleHash(bundleB));
  });

  it("nested bundle: modifying file content changes the hash", () => {
    writeFile(bundleA, "skills/sub/SKILL.md", "original");
    writeFile(bundleB, "skills/sub/SKILL.md", "modified");
    expect(computeBundleHash(bundleA)).not.toBe(computeBundleHash(bundleB));
  });

  it("empty directory: returns sha256Text('') per legacy contract", () => {
    expect(computeBundleHash(bundleA)).toBe(EMPTY_HASH);
  });

  it("missing directory: returns sha256Text('') per legacy contract", () => {
    const missing = join(tmpdir(), "khash-does-not-exist-" + Date.now());
    expect(computeBundleHash(missing)).toBe(EMPTY_HASH);
  });

  it("bundle with non-SKILL.md root file plus nested content: falls through to recursive walk", () => {
    // No SKILL.md at root → fast path skipped → recursive walk includes both files.
    writeFile(bundleA, "notes.md", "root notes\n");
    writeFile(bundleA, "skills/sub/SKILL.md", "nested skill\n");
    const hash = computeBundleHash(bundleA);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(EMPTY_HASH);
    // Crucially, this is NOT the legacy "first file alphabetically" hash
    // (which would have been sha256File(notes.md)). Documents the quiet upgrade.
    expect(hash).not.toBe(sha256File(join(bundleA, "notes.md")));
  });

  it("bundle with only directories at root (no files): produces non-empty hash via recursion", () => {
    // This is the exact bug from the ticket — root has only subdirs, legacy returned empty.
    writeFile(bundleA, "skills/a/SKILL.md", "a\n");
    writeFile(bundleA, "skills/b/SKILL.md", "b\n");
    const hash = computeBundleHash(bundleA);
    expect(hash).not.toBe(EMPTY_HASH);
  });
});
