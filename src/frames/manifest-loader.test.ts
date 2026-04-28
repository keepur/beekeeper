import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { loadManifest } from "./manifest-loader.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "frame-test-"));
  const writeFile = (rel: string, content: string) => {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  return { dir, writeFile };
}

describe("loadManifest", () => {
  let dir: string;
  let writeFile: (rel: string, content: string) => void;

  beforeEach(() => {
    const s = setup();
    dir = s.dir;
    writeFile = s.writeFile;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses a minimal manifest", () => {
    writeFile("frame.yaml", `name: test\nversion: 0.1.0\n`);
    const m = loadManifest(dir);
    expect(m.name).toBe("test");
    expect(m.version).toBe("0.1.0");
    expect(m.constitution).toBeUndefined();
  });

  it("throws when name missing", () => {
    writeFile("frame.yaml", `version: 0.1.0\n`);
    expect(() => loadManifest(dir)).toThrow(/name is required/);
  });

  it("parses constitution insert specs", () => {
    writeFile(
      "frame.yaml",
      `name: t\nversion: 0.1.0\nconstitution:\n  - anchor: capabilities\n    insert: after-anchor "memory"\n    file: c.md\n  - anchor: memory\n    insert: replace-anchor\n    file: m.md\n`,
    );
    writeFile("c.md", "x");
    writeFile("m.md", "y");
    const m = loadManifest(dir);
    expect(m.constitution).toHaveLength(2);
    expect(m.constitution![0].insert).toBe("after-anchor");
    expect(m.constitution![0].targetAnchor).toBe("memory");
    expect(m.constitution![1].insert).toBe("replace-anchor");
    expect(m.constitution![1].targetAnchor).toBeUndefined();
  });

  it("rejects malformed insert spec", () => {
    writeFile(
      "frame.yaml",
      `name: t\nversion: 0.1.0\nconstitution:\n  - anchor: x\n    insert: nonsense\n    file: c.md\n`,
    );
    writeFile("c.md", "x");
    expect(() => loadManifest(dir)).toThrow(/insert: must be/);
  });

  it("requires schedule entry to have cron or pattern", () => {
    writeFile(
      "frame.yaml",
      `name: t\nversion: 0.1.0\nschedule:\n  - task: x\n    agents: ["*"]\n`,
    );
    expect(() => loadManifest(dir)).toThrow(/cron.*pattern/);
  });

  it("validates asset file existence", () => {
    writeFile(
      "frame.yaml",
      `name: t\nversion: 0.1.0\nconstitution:\n  - anchor: x\n    insert: replace-anchor\n    file: missing.md\n`,
    );
    expect(() => loadManifest(dir)).toThrow(/asset file missing/);
  });
});
