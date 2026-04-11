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
import type { RelayConfig } from "./types.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockParseYaml = vi.mocked(parseYaml);

describe("loadConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };
    process.env.RELAY_JWT_SECRET = "test-jwt-secret";
    process.env.RELAY_ADMIN_SECRET = "test-admin-secret";
    process.env.RELAY_CONFIG = "/tmp/relay.yaml";
    process.env.HOME = "/Users/testuser";
    mockReaddirSync.mockReturnValue([] as any);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("loads a valid YAML config and returns correct RelayConfig structure", () => {
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

    expect(() => loadConfig()).toThrow("Relay config not found");
  });

  it("throws if RELAY_JWT_SECRET env var is missing", () => {
    delete process.env.RELAY_JWT_SECRET;
    delete process.env.BEEKEEPER_JWT_SECRET;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({ port: 3099 });

    expect(() => loadConfig()).toThrow("Missing required env var: RELAY_JWT_SECRET");
  });

  it("throws if RELAY_ADMIN_SECRET env var is missing", () => {
    delete process.env.RELAY_ADMIN_SECRET;
    delete process.env.BEEKEEPER_ADMIN_SECRET;
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({ port: 3099 });

    expect(() => loadConfig()).toThrow("Missing required env var: RELAY_ADMIN_SECRET");
  });

  it("falls back to default port (3099) when port is missing", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({});

    const config = loadConfig();

    expect(config.port).toBe(3099);
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

  it("uses RELAY_CONFIG env var to locate config file", () => {
    process.env.RELAY_CONFIG = "/custom/path/relay.yaml";
    mockExistsSync.mockReturnValue(false);

    expect(() => loadConfig()).toThrow("/custom/path/relay.yaml");
  });

  it("falls back to default data dir ~/.relay/data when not configured", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({});
    delete process.env.RELAY_DATA_DIR;
    delete process.env.BEEKEEPER_DATA_DIR;

    const config = loadConfig();

    expect(config.dataDir).toContain(".relay/data");
  });

  it("parses defaultWorkspace and workspaces from YAML", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("yaml content");
    mockParseYaml.mockReturnValue({
      port: 3099,
      default_workspace: "my-project",
      workspaces: { "my-project": "~/code/my-project" },
    });
    process.env.RELAY_JWT_SECRET = "jwt-secret";
    process.env.RELAY_ADMIN_SECRET = "admin-secret";
    const config = loadConfig();
    expect(config.defaultWorkspace).toBe("my-project");
    expect(config.workspaces).toEqual({ "my-project": "~/code/my-project" });
  });

  describe("env var backward compatibility", () => {
    it("accepts old BEEKEEPER_JWT_SECRET env var", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("port: 3099");
      mockParseYaml.mockReturnValue({ port: 3099 });
      delete process.env.RELAY_JWT_SECRET;
      process.env.BEEKEEPER_JWT_SECRET = "old-secret";
      process.env.RELAY_ADMIN_SECRET = "admin-secret";
      const config = loadConfig();
      expect(config.jwtSecret).toBe("old-secret");
    });

    it("prefers new RELAY_* vars when both old and new are set", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("port: 3099");
      mockParseYaml.mockReturnValue({ port: 3099 });
      process.env.RELAY_JWT_SECRET = "new-secret";
      process.env.BEEKEEPER_JWT_SECRET = "old-secret";
      process.env.RELAY_ADMIN_SECRET = "admin-secret";
      const config = loadConfig();
      expect(config.jwtSecret).toBe("new-secret");
    });

    it("accepts old BEEKEEPER_ADMIN_SECRET env var", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("port: 3099");
      mockParseYaml.mockReturnValue({ port: 3099 });
      process.env.RELAY_JWT_SECRET = "jwt-secret";
      delete process.env.RELAY_ADMIN_SECRET;
      process.env.BEEKEEPER_ADMIN_SECRET = "old-admin";
      const config = loadConfig();
      expect(config.adminSecret).toBe("old-admin");
    });

    it("accepts old BEEKEEPER_CONFIG env var for config path", () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue("port: 3099");
      mockParseYaml.mockReturnValue({ port: 3099 });
      process.env.RELAY_JWT_SECRET = "jwt-secret";
      process.env.RELAY_ADMIN_SECRET = "admin-secret";
      delete process.env.RELAY_CONFIG;
      process.env.BEEKEEPER_CONFIG = "./beekeeper.yaml";
      expect(() => loadConfig()).not.toThrow();
    });
  });
});
