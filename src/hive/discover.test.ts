import { describe, it, expect, vi } from "vitest";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
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

import { discoverHiveInstances } from "./discover.js";

function makeServicesRoot(): string {
  return mkdtempSync(join(tmpdir(), "bk-services-"));
}

function seedInstance(
  servicesRoot: string,
  id: string,
  opts: { engineVersion?: string | null; hiveYaml?: string; envFile?: string } = {},
): string {
  const dir = join(servicesRoot, id);
  mkdirSync(dir, { recursive: true });
  if (opts.engineVersion !== null && opts.engineVersion !== undefined) {
    const engineDir = join(dir, ".hive");
    mkdirSync(engineDir, { recursive: true });
    writeFileSync(
      join(engineDir, "package.json"),
      JSON.stringify({ name: "@keepur/hive", version: opts.engineVersion }),
    );
  }
  if (opts.hiveYaml !== undefined) {
    writeFileSync(join(dir, "hive.yaml"), opts.hiveYaml);
  }
  if (opts.envFile !== undefined) {
    writeFileSync(join(dir, ".env"), opts.envFile);
  }
  return dir;
}

describe("discoverHiveInstances", () => {
  it("returns empty array when servicesRoot does not exist", () => {
    expect(discoverHiveInstances({ servicesRoot: "/no/such/path" })).toEqual([]);
  });

  it("ignores hidden files, .bak / .pre-* dirs, and non-directories", () => {
    // The .pre-* skip is load-bearing on @mokie's machine — `dodi.pre-0.2-bak`
    // sits next to `dodi`. Without the filter, list would double-count.
    const root = makeServicesRoot();
    seedInstance(root, "dodi", { engineVersion: "0.3.0" });
    seedInstance(root, "dodi.pre-0.2-bak", { engineVersion: "0.1.5" });
    seedInstance(root, "keepur.bak", { engineVersion: "0.2.0" });
    mkdirSync(join(root, ".hidden"));
    writeFileSync(join(root, "stray-file.txt"), "");

    const result = discoverHiveInstances({
      servicesRoot: root,
      uid: 501,
      launchctl: () => ({ status: 1 }),
    });

    expect(result.map((i) => i.id)).toEqual(["dodi"]);
  });

  it("reads engine version from <instance>/.hive/package.json", () => {
    const root = makeServicesRoot();
    seedInstance(root, "dodi", { engineVersion: "0.3.0" });
    seedInstance(root, "keepur", { engineVersion: "0.3.2" });

    const result = discoverHiveInstances({
      servicesRoot: root,
      uid: 501,
      launchctl: () => ({ status: 1 }),
    });

    expect(result.map((i) => `${i.id}@${i.version}`)).toEqual(["dodi@0.3.0", "keepur@0.3.2"]);
  });

  it("reports version null when .hive/package.json is missing", () => {
    // An instance directory that ran init partway and bailed will have
    // hive.yaml but no .hive/. Operator should see "incomplete" not a
    // crash.
    const root = makeServicesRoot();
    seedInstance(root, "halfdone", { engineVersion: null, hiveYaml: "instance:\n  id: halfdone\n" });

    const result = discoverHiveInstances({
      servicesRoot: root,
      uid: 501,
      launchctl: () => ({ status: 1 }),
    });

    expect(result).toHaveLength(1);
    expect(result[0].version).toBeNull();
  });

  it("calls launchctl print gui/<uid>/com.hive.<id>.agent for run state", () => {
    const root = makeServicesRoot();
    seedInstance(root, "dodi", { engineVersion: "0.3.0" });
    seedInstance(root, "keepur", { engineVersion: "0.3.0" });
    const calls: string[][] = [];
    const launchctl = (args: string[]) => {
      calls.push(args);
      return { status: args[1].endsWith("com.hive.dodi.agent") ? 0 : 1 };
    };

    const result = discoverHiveInstances({ servicesRoot: root, uid: 501, launchctl });

    expect(calls).toEqual([
      ["print", "gui/501/com.hive.dodi.agent"],
      ["print", "gui/501/com.hive.keepur.agent"],
    ]);
    expect(result.find((i) => i.id === "dodi")?.running).toBe(true);
    expect(result.find((i) => i.id === "keepur")?.running).toBe(false);
  });

  it("reports running=null when uid is undefined", () => {
    const root = makeServicesRoot();
    seedInstance(root, "dodi", { engineVersion: "0.3.0" });

    const result = discoverHiveInstances({ servicesRoot: root, uid: undefined, launchctl: () => ({ status: 0 }) });

    expect(result[0].running).toBeNull();
  });

  it("reads ws port from .env (preferred) — dodi pattern", () => {
    // dodi sets WS_PORT in .env, not in hive.yaml. The discover module
    // must look there, otherwise list says PORT=— for an instance that
    // is plainly listening on 3200.
    const root = makeServicesRoot();
    seedInstance(root, "dodi", {
      engineVersion: "0.3.0",
      envFile: "WS_ENABLED=true\nWS_PORT=3200\n",
    });

    const [instance] = discoverHiveInstances({
      servicesRoot: root,
      uid: 501,
      launchctl: () => ({ status: 0 }),
    });

    expect(instance.port).toBe(3200);
  });

  it("falls back to ws.port in hive.yaml when .env doesn't carry it", () => {
    const root = makeServicesRoot();
    seedInstance(root, "yamlonly", {
      engineVersion: "0.3.0",
      hiveYaml: "instance:\n  id: yamlonly\nws:\n  enabled: true\n  port: 3303\n",
    });

    const [instance] = discoverHiveInstances({
      servicesRoot: root,
      uid: 501,
      launchctl: () => ({ status: 0 }),
    });

    expect(instance.port).toBe(3303);
  });

  it("returns port=null when neither .env nor hive.yaml carries a ws port", () => {
    const root = makeServicesRoot();
    seedInstance(root, "noport", {
      engineVersion: "0.3.0",
      hiveYaml: "instance:\n  id: noport\n",
    });

    const [instance] = discoverHiveInstances({
      servicesRoot: root,
      uid: 501,
      launchctl: () => ({ status: 0 }),
    });

    expect(instance.port).toBeNull();
  });

  it("sorts results by id", () => {
    const root = makeServicesRoot();
    seedInstance(root, "zebra", { engineVersion: "0.3.0" });
    seedInstance(root, "apple", { engineVersion: "0.3.0" });
    seedInstance(root, "mango", { engineVersion: "0.3.0" });

    const result = discoverHiveInstances({
      servicesRoot: root,
      uid: 501,
      launchctl: () => ({ status: 1 }),
    });

    expect(result.map((i) => i.id)).toEqual(["apple", "mango", "zebra"]);
  });
});
