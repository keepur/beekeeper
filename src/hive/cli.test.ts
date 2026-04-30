import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import type { HiveInstance } from "./discover.js";
import { renderInstancesTable } from "./cli.js";

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function logged(): string {
  return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

function errored(): string {
  return errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

describe("renderInstancesTable", () => {
  it("formats version, running, port columns with sensible placeholders", () => {
    const instances: HiveInstance[] = [
      { id: "dodi", path: "/x/dodi", version: "0.3.0", running: true, port: 3200 },
      { id: "halfdone", path: "/x/halfdone", version: null, running: false, port: null },
      { id: "unknown-uid", path: "/x/u", version: "0.3.2", running: null, port: null },
    ];

    const out = renderInstancesTable(instances);

    expect(out).toContain("dodi");
    expect(out).toContain("0.3.0");
    expect(out).toContain("3200");
    // Placeholders for missing data don't crash + don't leak `null` text.
    expect(out).toContain("incomplete");
    expect(out).toContain("—");
    expect(out).toContain("?");
    expect(out).not.toContain("null");
  });
});

describe("runHiveCli", () => {
  it("prints usage and exits 1 when no subcommand is given", async () => {
    const { runHiveCli } = await import("./cli.js");
    const code = await runHiveCli([]);
    expect(code).toBe(1);
    expect(errored()).toMatch(/Usage:/);
    expect(errored()).toMatch(/hive setup/);
    expect(errored()).toMatch(/hive list/);
  });

  it("`hive list` with no instances prints the empty-state hint", async () => {
    const { runHiveCli } = await import("./cli.js");
    const code = await runHiveCli(["list"], { discover: () => [] });
    expect(code).toBe(0);
    expect(logged()).toMatch(/no hive instances installed/);
  });

  it("`hive list --json` dumps raw JSON, not the table", async () => {
    const { runHiveCli } = await import("./cli.js");
    await runHiveCli(["list", "--json"], {
      discover: () => [{ id: "dodi", path: "/x/dodi", version: "0.3.0", running: true, port: 3200 }],
    });
    const out = logged();
    expect(out).toContain("\"id\": \"dodi\"");
    expect(out).toContain("\"version\": \"0.3.0\"");
    expect(out).not.toContain("INSTANCE  VERSION");
  });

  it("`hive list` (table mode) prints column headers + a row per instance", async () => {
    const { runHiveCli } = await import("./cli.js");
    await runHiveCli(["list"], {
      discover: () => [
        { id: "dodi", path: "/x/dodi", version: "0.3.0", running: true, port: 3200 },
        { id: "keepur", path: "/x/keepur", version: "0.3.2", running: false, port: null },
      ],
    });
    const out = logged();
    expect(out).toContain("INSTANCE");
    expect(out).toContain("dodi");
    expect(out).toContain("keepur");
  });

  it("`hive setup` calls into setup() and returns 0 on the happy path", async () => {
    // Mirror the cli.ts wiring path — we want to know the CLI layer
    // doesn't drop errors or mis-propagate exit codes.
    const cacheRoot = mkdtempSync(join(tmpdir(), "bk-cli-setup-"));
    const launchClaude = vi.fn();
    const lifecycleEnv = {
      fetchPackument: async () => ({
        version: "1.0.0",
        tarballUrl: "https://example.test/x.tgz",
        integrity: "sha512-stub",
      }),
      downloadFile: async () => {},
      verifyIntegrity: async () => {},
      extractTarball: (_t: string, destDir: string) => {
        mkdirSync(join(destDir, "package"), { recursive: true });
        writeFileSync(join(destDir, "package", "CLAUDE.md"), "");
      },
      launchClaude,
      listInstances: () => [],
      cacheRoot,
    };

    const { runHiveCli } = await import("./cli.js");
    const code = await runHiveCli(["setup"], { lifecycleEnv });

    expect(code).toBe(0);
    expect(launchClaude).toHaveBeenCalledTimes(1);
  });

  it("`hive setup` short-circuits when an existing instance is detected (no Claude launch)", async () => {
    const launchClaude = vi.fn();
    const lifecycleEnv = {
      fetchPackument: async () => {
        throw new Error("should not fetch when short-circuiting");
      },
      downloadFile: async () => {},
      verifyIntegrity: async () => {},
      extractTarball: () => {},
      launchClaude,
      listInstances: () => [{ id: "dodi", path: "/x", version: "0.3.0", running: true, port: 3200 }],
      cacheRoot: "/tmp/never-touched",
    };

    const { runHiveCli } = await import("./cli.js");
    const code = await runHiveCli(["setup"], { lifecycleEnv });

    expect(code).toBe(0);
    expect(launchClaude).not.toHaveBeenCalled();
    expect(logged()).toContain("Found existing instance: dodi");
  });
});
