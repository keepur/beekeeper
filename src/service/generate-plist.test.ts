import { describe, it, expect } from "vitest";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { generatePlist, removeLegacyPlist, seedConfigIfMissing, writeWrapperScript } from "./generate-plist.js";

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

  it("uses the io.keepur.beekeeperd reverse-DNS label", () => {
    // The real domain is keepur.io — NOT keepur.com. The trailing "d" on
    // the label mirrors the daemon binary name (`beekeeperd`) and
    // distinguishes it from the operator CLI (`beekeeper`). A rename to
    // com.keepur.* would be both factually wrong AND a breaking change
    // for anyone running the service today, so any future rename
    // should require updating this test deliberately.
    const xml = generatePlist(baseOptions);
    expect(xml).toContain("<string>io.keepur.beekeeperd</string>");
    expect(xml).not.toContain("com.keepur.beekeeperd");
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


describe("writeWrapperScript", () => {
  it("writes the wrapper under workDir/bin/start.sh, not the package dir", () => {
    // Regression test for a bug shipped in 1.2.0: writeWrapperScript wrote
    // the wrapper to <repoRoot>/bin/start.sh, which is /opt/homebrew/lib/
    // node_modules/@keepur/beekeeper/bin for `npm i -g` users — root-owned
    // and unwritable when `beekeeper install` runs as the user. The fix
    // routes the wrapper into the user's config dir, which is always
    // user-owned regardless of how the package was installed.
    const workDir = mkdtempSync(join(tmpdir(), "bk-wrap-"));
    const envFile = join(workDir, "env");
    writeFileSync(envFile, "BEEKEEPER_JWT_SECRET=stub\n");

    const wrapperPath = writeWrapperScript(
      envFile,
      "/opt/homebrew/bin/node",
      "/some/dist/index.js",
      workDir,
    );

    expect(wrapperPath).toBe(join(workDir, "bin", "start.sh"));
    expect(existsSync(wrapperPath)).toBe(true);
    const content = readFileSync(wrapperPath, "utf8");
    // Wrapper sources the env file by absolute path…
    expect(content).toContain(envFile);
    // …and execs node + indexPath.
    expect(content).toContain("/opt/homebrew/bin/node");
    expect(content).toContain("/some/dist/index.js");
    // The PATH default that protects against launchd's minimal gui/ PATH
    // must come BEFORE the env-file source so a user-supplied PATH can win.
    const pathIdx = content.indexOf("export PATH=");
    const sourceIdx = content.indexOf(". \"${ENV_FILE}\"");
    expect(pathIdx).toBeGreaterThan(0);
    expect(sourceIdx).toBeGreaterThan(pathIdx);
  });

  it("creates the bin/ directory if it doesn't exist", () => {
    const workDir = mkdtempSync(join(tmpdir(), "bk-wrap-"));
    const envFile = join(workDir, "env");
    writeFileSync(envFile, "stub\n");

    expect(existsSync(join(workDir, "bin"))).toBe(false);
    writeWrapperScript(envFile, "/x/node", "/x/index.js", workDir);
    expect(existsSync(join(workDir, "bin"))).toBe(true);
  });
});

describe("removeLegacyPlist", () => {
  it("returns removed=false silently when the legacy plist does not exist", () => {
    // Using a fresh tmp dir guarantees no plist is present. Production
    // callers will hit this path on every install after the first one.
    const dir = mkdtempSync(join(tmpdir(), "bk-plist-"));
    const result = removeLegacyPlist(dir);
    expect(result.removed).toBe(false);
    expect(result.path).toBe(join(dir, "io.keepur.beekeeper.plist"));
  });

  it("unlinks the legacy plist and returns removed=true when it exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "bk-plist-"));
    mkdirSync(dir, { recursive: true });
    const legacyPath = join(dir, "io.keepur.beekeeper.plist");
    writeFileSync(legacyPath, "<!-- pre-1.2 plist -->");
    expect(existsSync(legacyPath)).toBe(true);

    const result = removeLegacyPlist(dir);
    expect(result.removed).toBe(true);
    expect(result.path).toBe(legacyPath);
    // File must actually be gone — otherwise the new plist would race
    // with the old one for :8420 on the next launchctl load.
    expect(existsSync(legacyPath)).toBe(false);
  });

  it("only touches the legacy label, not the new beekeeperd plist", () => {
    // Critical safety: removing the legacy must NOT remove
    // io.keepur.beekeeperd.plist sitting in the same directory.
    const dir = mkdtempSync(join(tmpdir(), "bk-plist-"));
    const legacyPath = join(dir, "io.keepur.beekeeper.plist");
    const newPath = join(dir, "io.keepur.beekeeperd.plist");
    writeFileSync(legacyPath, "legacy");
    writeFileSync(newPath, "new");

    removeLegacyPlist(dir);
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(newPath)).toBe(true);
  });
});
