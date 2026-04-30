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
    }),
    downloadFile: async (_url, dest) => {
      writeFileSync(dest, "stub-tarball");
    },
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
