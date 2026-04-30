import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { evictStaleCache, setup, type LifecycleEnv } from "./lifecycle.js";
import type { HiveInstance } from "./discover.js";

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeEnv(overrides: Partial<LifecycleEnv>): LifecycleEnv {
  const cacheRoot = mkdtempSync(join(tmpdir(), "bk-cache-"));
  return {
    fetchPackument: async () => ({
      version: "1.0.0",
      tarballUrl: "https://example.test/keepur-hive-1.0.0.tgz",
      // Stub integrity — verifyIntegrity in the test env is a no-op, so
      // the value isn't validated, but it must be present so setup()
      // doesn't reject the packument.
      integrity: "sha512-stub",
    }),
    downloadFile: async (_url, dest) => {
      writeFileSync(dest, "stub-tarball");
    },
    verifyIntegrity: vi.fn(async () => {}),
    extractTarball: (_tarballPath, destDir) => {
      // Mimic npm tar layout — extraction creates ./package/ inside destDir.
      const pkg = join(destDir, "package");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "CLAUDE.md"), "# hive engine docs");
    },
    launchClaude: vi.fn(),
    listInstances: () => [],
    cacheRoot,
    ...overrides,
  };
}

function logged(): string {
  return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

describe("setup — fresh install path", () => {
  it("downloads, extracts, writes overlay CLAUDE.md, and launches Claude Code", async () => {
    const launchClaude = vi.fn();
    const env = makeEnv({ launchClaude });

    const result = await setup({}, env);

    expect(result.version).toBe("1.0.0");
    expect(result.cacheDir).toBe(join(env.cacheRoot, "1.0.0"));
    expect(result.reusedCache).toBe(false);

    // Cache layout matches the spec: <version>/CLAUDE.md (overlay) +
    // <version>/package/ (extracted tarball contents).
    const overlay = join(env.cacheRoot, "1.0.0", "CLAUDE.md");
    expect(existsSync(overlay)).toBe(true);
    const overlayContent = readFileSync(overlay, "utf8");
    expect(overlayContent).toContain("@keepur/hive@1.0.0");
    expect(existsSync(join(env.cacheRoot, "1.0.0", "package", "CLAUDE.md"))).toBe(true);

    // Claude Code is launched rooted at the cache dir.
    expect(launchClaude).toHaveBeenCalledTimes(1);
    expect(launchClaude).toHaveBeenCalledWith(join(env.cacheRoot, "1.0.0"));
  });

  it("verifies tarball integrity AFTER download and BEFORE extract", async () => {
    // Order is load-bearing: extract before verify would let a tampered
    // tarball execute its contents (or at least drop them on disk) before
    // we'd notice. The order assertion catches a refactor that flips them.
    const order: string[] = [];
    const env = makeEnv({
      downloadFile: async (_url, dest) => {
        order.push("download");
        writeFileSync(dest, "stub-tarball");
      },
      verifyIntegrity: vi.fn(async () => {
        order.push("verify");
      }),
      extractTarball: (_tarballPath, destDir) => {
        order.push("extract");
        const pkg = join(destDir, "package");
        mkdirSync(pkg, { recursive: true });
      },
    });

    await setup({}, env);

    expect(order).toEqual(["download", "verify", "extract"]);
  });

  it("propagates integrity-check failure as a thrown error (no extract, no Claude launch)", async () => {
    const launchClaude = vi.fn();
    const extractTarball = vi.fn();
    const env = makeEnv({
      launchClaude,
      extractTarball,
      verifyIntegrity: vi.fn(async () => {
        throw new Error("integrity mismatch");
      }),
    });

    await expect(setup({}, env)).rejects.toThrow(/integrity mismatch/);
    expect(extractTarball).not.toHaveBeenCalled();
    expect(launchClaude).not.toHaveBeenCalled();
  });

  it("rejects packuments missing dist.integrity rather than silently extracting", async () => {
    // The npm registry has emitted dist.integrity for years. A response
    // missing it is suspicious — abort with an actionable message rather
    // than skip verification.
    const env = makeEnv({
      fetchPackument: async () => ({
        version: "1.0.0",
        tarballUrl: "https://example.test/x.tgz",
        // integrity intentionally omitted
      }),
    });

    await expect(setup({}, env)).rejects.toThrow(/missing dist\.integrity/);
  });

  it("re-uses an already-extracted cache for the same version (no double download)", async () => {
    const downloadFile = vi.fn(async (_url: string, dest: string) => {
      writeFileSync(dest, "stub-tarball");
    });
    const extractTarball = vi.fn();
    const env = makeEnv({ downloadFile, extractTarball });
    // Pre-seed the cache so setup short-circuits the download/extract.
    const versionDir = join(env.cacheRoot, "1.0.0");
    mkdirSync(join(versionDir, "package"), { recursive: true });

    const result = await setup({}, env);

    expect(result.reusedCache).toBe(true);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(extractTarball).not.toHaveBeenCalled();
    // Overlay is still rewritten so a beekeeper upgrade can refresh it.
    expect(existsSync(join(versionDir, "CLAUDE.md"))).toBe(true);
  });
});

describe("setup — existing-install short-circuit", () => {
  function existingInstance(version: string | null = "0.3.0"): HiveInstance {
    return {
      id: "dodi",
      path: "/Users/mokie/services/hive/dodi",
      version,
      running: true,
      port: 3200,
    };
  }

  it("short-circuits when an existing instance is found and --force is not passed", async () => {
    const launchClaude = vi.fn();
    const downloadFile = vi.fn();
    const env = makeEnv({
      launchClaude,
      downloadFile,
      listInstances: () => [existingInstance()],
    });

    const result = await setup({}, env);

    expect(result.shortCircuited?.id).toBe("dodi");
    expect(launchClaude).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
    expect(logged()).toContain("Found existing instance: dodi");
  });

  it("--force bypasses the short-circuit and proceeds with install", async () => {
    const launchClaude = vi.fn();
    const env = makeEnv({
      launchClaude,
      listInstances: () => [existingInstance()],
    });

    const result = await setup({ force: true }, env);

    expect(result.shortCircuited).toBeUndefined();
    expect(launchClaude).toHaveBeenCalledTimes(1);
  });

  it("ignores instances without an engine version (incomplete inits)", async () => {
    // A directory at ~/services/hive/halfdone with no .hive/ shouldn't
    // count as "already installed" — those are mid-init failures, not
    // working instances.
    const launchClaude = vi.fn();
    const env = makeEnv({
      launchClaude,
      listInstances: () => [existingInstance(null)],
    });

    await setup({}, env);

    expect(launchClaude).toHaveBeenCalledTimes(1);
  });
});

describe("defaultVerifyIntegrity (real implementation)", () => {
  // Imports the real default rather than a stub so we exercise the
  // crypto + stream pipeline. Without this, the production verifier
  // could regress silently (every other lifecycle test injects a no-op).
  it("accepts a tarball whose sha512 matches the integrity string", async () => {
    const { defaultLifecycleEnv } = await import("./lifecycle.js");
    const tmp = mkdtempSync(join(tmpdir(), "bk-int-"));
    const tarball = join(tmp, "x.tgz");
    writeFileSync(tarball, "the-real-bytes");
    // Compute the expected sha512 ourselves so the test is self-contained.
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha512").update("the-real-bytes").digest("base64");

    await expect(
      defaultLifecycleEnv.verifyIntegrity(tarball, `sha512-${expected}`),
    ).resolves.toBeUndefined();
  });

  it("rejects a tarball whose hash doesn't match", async () => {
    const { defaultLifecycleEnv } = await import("./lifecycle.js");
    const tmp = mkdtempSync(join(tmpdir(), "bk-int-"));
    const tarball = join(tmp, "x.tgz");
    writeFileSync(tarball, "tampered-bytes");

    await expect(
      defaultLifecycleEnv.verifyIntegrity(tarball, "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    ).rejects.toThrow(/integrity check/);
  });

  it("rejects an unsupported algorithm rather than skipping verification", async () => {
    const { defaultLifecycleEnv } = await import("./lifecycle.js");
    const tmp = mkdtempSync(join(tmpdir(), "bk-int-"));
    const tarball = join(tmp, "x.tgz");
    writeFileSync(tarball, "x");

    await expect(
      defaultLifecycleEnv.verifyIntegrity(tarball, "md5-asdf"),
    ).rejects.toThrow(/Unsupported integrity algorithm/);
  });

  it("rejects a malformed integrity string with no algorithm separator", async () => {
    const { defaultLifecycleEnv } = await import("./lifecycle.js");
    const tmp = mkdtempSync(join(tmpdir(), "bk-int-"));
    const tarball = join(tmp, "x.tgz");
    writeFileSync(tarball, "x");

    // No dash at all → idx === -1 → malformed (vs. "md5-asdf" which would
    // parse as algo="md5", hash="asdf" and hit the unsupported-algo path).
    await expect(
      defaultLifecycleEnv.verifyIntegrity(tarball, "abcdef"),
    ).rejects.toThrow(/Malformed integrity/);
  });
});

describe("evictStaleCache", () => {
  it("removes versions that aren't kept and aren't currently installed", () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), "bk-evict-"));
    for (const v of ["0.2.0", "0.3.0", "0.3.2", "1.0.0"]) {
      mkdirSync(join(cacheRoot, v));
    }

    evictStaleCache(cacheRoot, "1.0.0", ["0.3.0"]);

    expect(existsSync(join(cacheRoot, "1.0.0"))).toBe(true);
    expect(existsSync(join(cacheRoot, "0.3.0"))).toBe(true); // installed → kept
    expect(existsSync(join(cacheRoot, "0.3.2"))).toBe(false);
    expect(existsSync(join(cacheRoot, "0.2.0"))).toBe(false);
  });

  it("is silent and idempotent on a missing cache root", () => {
    expect(() => evictStaleCache("/no/such/path", "1.0.0", [])).not.toThrow();
  });

  it("does not remove dot-files in the cache root", () => {
    // Future-proofing — if we ever add a `.cache-meta` or similar, the
    // eviction shouldn't clobber it.
    const cacheRoot = mkdtempSync(join(tmpdir(), "bk-evict-"));
    writeFileSync(join(cacheRoot, ".cache-meta"), "");
    mkdirSync(join(cacheRoot, "0.3.0"));

    evictStaleCache(cacheRoot, "1.0.0", []);

    expect(existsSync(join(cacheRoot, ".cache-meta"))).toBe(true);
    expect(existsSync(join(cacheRoot, "0.3.0"))).toBe(false);
  });
});
