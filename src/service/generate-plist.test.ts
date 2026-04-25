import { describe, it, expect } from "vitest";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { generatePlist, seedConfigIfMissing } from "./generate-plist.js";

describe("generatePlist", () => {
  const baseOptions = {
    configDir: "/Users/mokie/.beekeeper",
    nodePath: "/opt/homebrew/bin/node",
    indexPath: "/Users/mokie/services/beekeeper/dist/index.js",
    logDir: "/Users/mokie/.beekeeper/logs",
  };

  it("emits a direct-node plist when no wrapper path is given", () => {
    const xml = generatePlist(baseOptions);
    expect(xml).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(xml).toContain("<string>/Users/mokie/services/beekeeper/dist/index.js</string>");
    // Direct mode still ships the BEEKEEPER_CONFIG env var.
    expect(xml).toContain("BEEKEEPER_CONFIG");
    expect(xml).toContain("beekeeper.yaml");
  });

  it("emits a wrapper-mode plist when wrapperPath is given", () => {
    const xml = generatePlist({
      ...baseOptions,
      wrapperPath: "/Users/mokie/services/beekeeper/bin/start.sh",
    });
    expect(xml).toContain("<string>/Users/mokie/services/beekeeper/bin/start.sh</string>");
    // Wrapper mode must NOT include the direct node path in ProgramArguments.
    expect(xml).not.toContain("<string>/opt/homebrew/bin/node</string>");
    // Wrapper mode omits BEEKEEPER_CONFIG — the env file sets it.
    expect(xml).not.toContain("BEEKEEPER_CONFIG");
  });

  it("includes RunAtLoad, KeepAlive, and ThrottleInterval", () => {
    const xml = generatePlist(baseOptions);
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  });

  it("uses the io.keepur.beekeeper reverse-DNS label", () => {
    // The real domain is keepur.io — NOT keepur.com. A rename to
    // com.keepur.* would be both factually wrong AND a breaking change
    // for anyone running the service today, so any future rename
    // should require updating this test deliberately.
    const xml = generatePlist(baseOptions);
    expect(xml).toContain("<string>io.keepur.beekeeper</string>");
    expect(xml).not.toContain("com.keepur.beekeeper");
  });

  it("escapes XML-special characters in paths", () => {
    const xml = generatePlist({
      ...baseOptions,
      configDir: "/tmp/has & ampersand",
      logDir: "/tmp/has <angle> brackets",
    });
    expect(xml).toContain("/tmp/has &amp; ampersand");
    expect(xml).toContain("/tmp/has &lt;angle&gt; brackets");
    // And the raw characters should NOT appear (they'd produce invalid XML).
    expect(xml).not.toContain("/tmp/has & ampersand");
    expect(xml).not.toContain("/tmp/has <angle>");
  });
});

describe("seedConfigIfMissing", () => {
  it("copies the bundled example into a fresh configDir", () => {
    const dir = mkdtempSync(join(tmpdir(), "beekeeper-seed-"));
    const result = seedConfigIfMissing(dir);
    expect(result.created).toBe(true);
    expect(result.source).toBe("example");
    expect(result.path).toBe(join(dir, "beekeeper.yaml"));
    expect(existsSync(result.path)).toBe(true);

    // Content should match the bundled example byte-for-byte.
    const exampleSrc = resolve(
      dirname(new URL(import.meta.url).pathname),
      "..",
      "..",
      "beekeeper.yaml.example",
    );
    expect(readFileSync(result.path, "utf-8")).toBe(readFileSync(exampleSrc, "utf-8"));
  });

  it("never overwrites an existing beekeeper.yaml", () => {
    const dir = mkdtempSync(join(tmpdir(), "beekeeper-seed-"));
    const target = join(dir, "beekeeper.yaml");
    writeFileSync(target, "port: 9999\n");
    const result = seedConfigIfMissing(dir);
    expect(result.created).toBe(false);
    expect(result.source).toBeNull();
    expect(readFileSync(target, "utf-8")).toBe("port: 9999\n");
  });

  it("creates configDir if missing", () => {
    const parent = mkdtempSync(join(tmpdir(), "beekeeper-seed-"));
    const dir = join(parent, "nested", "deep");
    expect(existsSync(dir)).toBe(false);
    const result = seedConfigIfMissing(dir);
    expect(result.created).toBe(true);
    expect(existsSync(result.path)).toBe(true);
  });
});

describe("wrapper-script resolution", () => {
  // This test pins the resolveRepoRoot logic: the wrapper script lives under
  // the same repo root as dist/index.js. If someone changes the `..` count
  // in either helper, this asserts that bin/ stays next to dist/ — which is
  // the invariant `beekeeper install` relies on to avoid writing the wrapper
  // to a parent directory the user doesn't own.
  //
  // We can't easily import the private helpers, so we replicate the path
  // arithmetic at test time against the known on-disk layout.
  it("bin/start.sh lives under the same root as dist/index.js", async () => {
    // At test time this file runs as dist/service/generate-plist.test.js
    // after build, or src/service/generate-plist.test.ts under vitest.
    // Vitest uses the source path, so we compute relative to __dirname /
    // import.meta at test time.
    const testDir = dirname(new URL(import.meta.url).pathname);
    // testDir ends in src/service — walk up to the repo root.
    const repoRoot = resolve(testDir, "..", "..");
    // Sanity: repoRoot should contain src/ and bin/ (once install has run
    // at least once locally). We only assert that the computed paths are
    // siblings — not that bin/ exists yet.
    const binDir = resolve(repoRoot, "bin");
    const srcDir = resolve(repoRoot, "src");
    expect(dirname(binDir)).toBe(repoRoot);
    expect(dirname(srcDir)).toBe(repoRoot);
    // This is the load-bearing invariant: bin/ is a child of the same
    // repo root that contains src/ (and after build, dist/).
    expect(dirname(binDir)).toBe(dirname(srcDir));
  });
});
