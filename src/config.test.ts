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
import { parse as parseYaml } from "yaml";
import { loadConfig } from "./config.js";
import type { BeekeeperConfig } from "./types.js";

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
});
