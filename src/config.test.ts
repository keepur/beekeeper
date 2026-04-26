import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
}));

vi.mock("yaml", () => ({
  parse: vi.fn(),
}));

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig, autoSourceEnv } from "./config.js";
import type { BeekeeperConfig } from "./types.js";

const DEFAULT_ENV_PATH = join(homedir(), ".beekeeper", "env");

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockParseYaml = vi.mocked(parseYaml);

describe("loadConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };
    process.env.BEEKEEPER_JWT_SECRET = "test-jwt-secret";
    process.env.BEEKEEPER_ADMIN_SECRET = "test-admin-secret";
    process.env.BEEKEEPER_CONFIG = "/tmp/beekeeper.yaml";
    process.env.HOME = "/Users/testuser";
    mockReaddirSync.mockReturnValue([] as any);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("loads a valid YAML config and returns correct BeekeeperConfig structure", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({
      port: 4000,
      model: "claude-sonnet-4-5",
      confirm_operations: ["rm -rf", "git push --force"],
    });

    const config = loadConfig();

    expect(config).toMatchObject({
      port: 4000,
      model: "claude-sonnet-4-5",
      confirmOperations: ["rm -rf", "git push --force"],
      jwtSecret: "test-jwt-secret",
      adminSecret: "test-admin-secret",
    });
    expect(config).toHaveProperty("plugins");
  });

  it("throws if config file not found", () => {
    mockExistsSync.mockReturnValue(false);

    expect(() => loadConfig()).toThrow("Beekeeper config not found");
  });

  it("throws if BEEKEEPER_JWT_SECRET env var is missing", () => {
    delete process.env.BEEKEEPER_JWT_SECRET;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({ port: 3099 });

    expect(() => loadConfig()).toThrow("Missing required env var: BEEKEEPER_JWT_SECRET");
  });

  it("throws if BEEKEEPER_ADMIN_SECRET env var is missing", () => {
    delete process.env.BEEKEEPER_ADMIN_SECRET;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({ port: 3099 });

    expect(() => loadConfig()).toThrow("Missing required env var: BEEKEEPER_ADMIN_SECRET");
  });

  it("falls back to default port (8420) when port is missing", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({});

    const config = loadConfig();

    expect(config.port).toBe(8420);
  });

  it("falls back to default capabilitiesHealthIntervalMs (10000) when missing", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({});

    const config = loadConfig();

    expect(config.capabilitiesHealthIntervalMs).toBe(10000);
  });

  it("falls back to default capabilitiesFailureThreshold (2) when missing", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({});

    const config = loadConfig();

    expect(config.capabilitiesFailureThreshold).toBe(2);
  });

  it("parses capabilities_health_interval_ms and capabilities_failure_threshold from YAML", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({
      capabilities_health_interval_ms: 250,
      capabilities_failure_threshold: 5,
    });

    const config = loadConfig();

    expect(config.capabilitiesHealthIntervalMs).toBe(250);
    expect(config.capabilitiesFailureThreshold).toBe(5);
  });

  it("falls back to default model when model is missing", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({});

    const config = loadConfig();

    expect(config.model).toBe("claude-opus-4-6");
  });

  it("falls back to default confirm_operations when field is missing", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({});

    const config = loadConfig();

    expect(config.confirmOperations).toContain("git push --force");
    expect(config.confirmOperations).toContain("rm -rf");
    expect(config.confirmOperations.length).toBeGreaterThan(0);
  });

  it("uses BEEKEEPER_CONFIG env var to locate config file", () => {
    process.env.BEEKEEPER_CONFIG = "/custom/path/beekeeper.yaml";
    mockExistsSync.mockReturnValue(false);

    expect(() => loadConfig()).toThrow("/custom/path/beekeeper.yaml");
  });

  it("falls back to default data dir ~/.beekeeper/data when not configured", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({});
    delete process.env.BEEKEEPER_DATA_DIR;

    const config = loadConfig();

    expect(config.dataDir).toContain(".beekeeper/data");
  });

  it("parses defaultWorkspace and workspaces from YAML", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({
      port: 3099,
      default_workspace: "my-project",
      workspaces: { "my-project": "~/code/my-project" },
    });
    const config = loadConfig();
    expect(config.defaultWorkspace).toBe("my-project");
    expect(config.workspaces).toEqual({ "my-project": "~/code/my-project" });
  });

  const VALID_ORCHESTRATOR = {
    stallThresholds: {
      drafting:    { soft: 300000, hard: 900000 },
      review:      { soft: 300000, hard: 900000 },
      implementer: { soft: 600000, hard: 1800000 },
    },
    pipelineModel: {
      drafting: "claude-opus-4-7",
      review: "claude-opus-4-7",
      implementer: "claude-sonnet-4-6",
    },
    bashAllowlist: ["^gh ", "^git "],
    jobTtlMs: 86400000,
  };

  it("parses pipeline.orchestrator into typed OrchestratorConfig", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({
      pipeline: {
        linearTeamKey: "KPR",
        orchestrator: VALID_ORCHESTRATOR,
      },
    });
    const config = loadConfig();
    expect(config.pipeline?.orchestrator).toBeDefined();
    expect(config.pipeline?.orchestrator?.stallThresholds.drafting.hard).toBe(900000);
    expect(config.pipeline?.orchestrator?.bashAllowlist).toEqual(["^gh ", "^git "]);
    expect(config.pipeline?.orchestrator?.jobTtlMs).toBe(86400000);
  });

  it("defaults jobTtlMs to 24h when omitted", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({
      pipeline: {
        linearTeamKey: "KPR",
        orchestrator: { ...VALID_ORCHESTRATOR, jobTtlMs: undefined },
      },
    });
    const config = loadConfig();
    expect(config.pipeline?.orchestrator?.jobTtlMs).toBe(86400000);
  });

  it("rejects orchestrator with soft >= hard", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({
      pipeline: {
        linearTeamKey: "KPR",
        orchestrator: {
          ...VALID_ORCHESTRATOR,
          stallThresholds: {
            ...VALID_ORCHESTRATOR.stallThresholds,
            drafting: { soft: 1000, hard: 500 },
          },
        },
      },
    });
    expect(() => loadConfig()).toThrow(/soft must be < hard/);
  });

  it("rejects orchestrator with empty bashAllowlist", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({
      pipeline: {
        linearTeamKey: "KPR",
        orchestrator: { ...VALID_ORCHESTRATOR, bashAllowlist: [] },
      },
    });
    expect(() => loadConfig()).toThrow(/bashAllowlist must be a non-empty array/);
  });

  it("rejects orchestrator missing pipelineModel.implementer", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({
      pipeline: {
        linearTeamKey: "KPR",
        orchestrator: {
          ...VALID_ORCHESTRATOR,
          pipelineModel: { drafting: "x", review: "x" },
        },
      },
    });
    expect(() => loadConfig()).toThrow(/pipelineModel\.implementer/);
  });

  it("returns pipeline.orchestrator=undefined when block omitted", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({ pipeline: { linearTeamKey: "KPR" } });
    const config = loadConfig();
    expect(config.pipeline?.orchestrator).toBeUndefined();
  });
});

describe("autoSourceEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };
    process.env.HOME = "/Users/testuser";
    delete process.env.BEEKEEPER_ENV_FILE;
    delete process.env.BEEKEEPER_JWT_SECRET;
    delete process.env.BEEKEEPER_ADMIN_SECRET;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns null when no env file exists", () => {
    mockExistsSync.mockReturnValue(false);
    expect(autoSourceEnv()).toBeNull();
    expect(process.env.BEEKEEPER_JWT_SECRET).toBeUndefined();
  });

  it("sources $HOME/.beekeeper/env when present", () => {
    mockExistsSync.mockImplementation((p) => String(p) === DEFAULT_ENV_PATH);
    mockReadFileSync.mockReturnValue(
      "BEEKEEPER_JWT_SECRET=from-file-jwt\nBEEKEEPER_ADMIN_SECRET=from-file-admin\n",
    );
    const sourced = autoSourceEnv();
    expect(sourced).toBe(DEFAULT_ENV_PATH);
    expect(process.env.BEEKEEPER_JWT_SECRET).toBe("from-file-jwt");
    expect(process.env.BEEKEEPER_ADMIN_SECRET).toBe("from-file-admin");
  });

  it("existing env vars win over the env file", () => {
    process.env.BEEKEEPER_JWT_SECRET = "from-shell";
    mockExistsSync.mockImplementation((p) => String(p) === DEFAULT_ENV_PATH);
    mockReadFileSync.mockReturnValue("BEEKEEPER_JWT_SECRET=from-file\n");
    autoSourceEnv();
    expect(process.env.BEEKEEPER_JWT_SECRET).toBe("from-shell");
  });

  it("honors BEEKEEPER_ENV_FILE override before the default location", () => {
    process.env.BEEKEEPER_ENV_FILE = "/custom/env";
    mockExistsSync.mockImplementation((p) => String(p) === "/custom/env");
    mockReadFileSync.mockReturnValue("BEEKEEPER_JWT_SECRET=custom\n");
    expect(autoSourceEnv()).toBe("/custom/env");
    expect(process.env.BEEKEEPER_JWT_SECRET).toBe("custom");
  });

  it("skips blank lines, comments, and malformed lines", () => {
    mockExistsSync.mockImplementation((p) => String(p) === DEFAULT_ENV_PATH);
    mockReadFileSync.mockReturnValue(
      [
        "",
        "# this is a comment",
        "   # indented comment",
        "no_equals_sign",
        "BEEKEEPER_JWT_SECRET=ok",
        "",
      ].join("\n"),
    );
    autoSourceEnv();
    expect(process.env.BEEKEEPER_JWT_SECRET).toBe("ok");
  });

  it("strips a single pair of surrounding quotes from values", () => {
    mockExistsSync.mockImplementation((p) => String(p) === DEFAULT_ENV_PATH);
    mockReadFileSync.mockReturnValue(
      [
        'BEEKEEPER_JWT_SECRET="quoted-value"',
        "BEEKEEPER_ADMIN_SECRET='single-quoted'",
      ].join("\n"),
    );
    autoSourceEnv();
    expect(process.env.BEEKEEPER_JWT_SECRET).toBe("quoted-value");
    expect(process.env.BEEKEEPER_ADMIN_SECRET).toBe("single-quoted");
  });

  it("passes values with unbalanced quotes through literally", () => {
    // Matches neither startsWith && endsWith check, so the value should be
    // preserved as-is rather than having a stray leading quote stripped.
    // This is the defensible behavior for a malformed env file — we don't
    // want to silently "fix" it and hand the downstream consumer a value
    // that's subtly different from what's on disk.
    mockExistsSync.mockImplementation((p) => String(p) === DEFAULT_ENV_PATH);
    mockReadFileSync.mockReturnValue('BEEKEEPER_JWT_SECRET="unclosed\n');
    autoSourceEnv();
    expect(process.env.BEEKEEPER_JWT_SECRET).toBe('"unclosed');
  });
});
