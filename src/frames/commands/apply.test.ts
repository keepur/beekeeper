import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "mongodb";
import { extractAnchorNeighborhood, sha256Text } from "../text-utils.js";
import { verifyAnchors, buildAdoptRecord } from "./apply.js";
import { MissingAnchorError } from "../errors.js";
import type { FrameManifest } from "../types.js";

describe("extractAnchorNeighborhood", () => {
  it("extracts text from anchor to next anchor", () => {
    const md = `<a id="a"></a>\nA-body\n<a id="b"></a>\nB-body`;
    const r = extractAnchorNeighborhood(md, "a");
    expect(r).toContain("A-body");
    expect(r).not.toContain("B-body");
  });

  it("extracts to end of document if no next anchor", () => {
    const md = `pre\n<a id="last"></a>\nfinal-body`;
    expect(extractAnchorNeighborhood(md, "last")).toContain("final-body");
  });

  it("returns empty when anchor missing", () => {
    expect(extractAnchorNeighborhood(`no anchors`, "x")).toBe("");
  });
});

interface MockAgent {
  _id: string;
  systemPrompt?: string;
}

function makeAgentDefDb(agents: MockAgent[]): Db {
  const memoryColl = {
    findOne: async () => null,
  };
  const agentDefsColl = {
    find: (q: Record<string, unknown>) => {
      const idClause = (q?._id as { $in?: string[] } | undefined)?.$in;
      const out = idClause ? agents.filter((a) => idClause.includes(a._id)) : agents;
      return {
        toArray: async () => out,
        sort: () => ({
          toArray: async () => [...out].sort((a, b) => a._id.localeCompare(b._id)),
        }),
      };
    },
  };
  const collection = (name: string): unknown => {
    if (name === "memory") return memoryColl;
    if (name === "agent_definitions") return agentDefsColl;
    return { findOne: async () => null, find: () => ({ toArray: async () => [] }) };
  };
  return { collection } as unknown as Db;
}

describe("verifyAnchors with wildcard agent resolver", () => {
  it("resolves wildcards and throws MissingAnchorError when one resolved agent lacks the anchor", async () => {
    const agentWith = {
      _id: "alice",
      systemPrompt: `<a id="role-spec"></a>\nrole content`,
    };
    const agentWithout = {
      _id: "bob",
      systemPrompt: `no anchor here`,
    };
    const db = makeAgentDefDb([agentWith, agentWithout]);

    const manifest: FrameManifest = {
      name: "test-frame",
      version: "1.0.0",
      rootPath: "/tmp/frame",
      prompts: [{ anchor: "role-spec", agents: ["*"], file: "frag.md" }],
    };

    const resolver = async (sel: string[]): Promise<string[]> => {
      if (sel.length === 1 && sel[0] === "*") return ["alice", "bob"];
      return sel;
    };

    await expect(verifyAnchors(db, manifest, resolver)).rejects.toThrow(MissingAnchorError);
    await expect(verifyAnchors(db, manifest, resolver)).rejects.toThrow(/bob/);
  });

  it("passes when all wildcard-resolved agents have the anchor", async () => {
    const agents: MockAgent[] = [
      { _id: "alice", systemPrompt: `<a id="role-spec"></a>\nrole` },
      { _id: "bob", systemPrompt: `<a id="role-spec"></a>\nrole` },
    ];
    const db = makeAgentDefDb(agents);
    const manifest: FrameManifest = {
      name: "test-frame",
      version: "1.0.0",
      rootPath: "/tmp/frame",
      prompts: [{ anchor: "role-spec", agents: ["*"], file: "frag.md" }],
    };
    const resolver = async (sel: string[]) => (sel[0] === "*" ? ["alice", "bob"] : sel);
    await expect(verifyAnchors(db, manifest, resolver)).resolves.toBeUndefined();
  });

  it("adopt mode (no resolver) skips wildcard prompt anchors", async () => {
    const agents: MockAgent[] = [
      { _id: "alice", systemPrompt: `no anchor here` },
    ];
    const db = makeAgentDefDb(agents);
    const manifest: FrameManifest = {
      name: "test-frame",
      version: "1.0.0",
      rootPath: "/tmp/frame",
      prompts: [{ anchor: "role-spec", agents: ["*"], file: "frag.md" }],
    };
    // No resolver passed: wildcard skipped — no throw.
    await expect(verifyAnchors(db, manifest)).resolves.toBeUndefined();
  });
});

interface AdoptAgent {
  _id: string;
  coreServers?: string[];
  systemPrompt?: string;
  schedule?: Array<{ task: string; cron: string }>;
}

interface AdoptMemoryDoc {
  _id: string;
  agentId: string;
  contentHash: string;
}

function makeAdoptDb(opts: {
  agents: AdoptAgent[];
  constitution: string;
  memorySeeds: AdoptMemoryDoc[];
}): Db {
  const memoryColl = {
    findOne: async (q: Record<string, unknown>) => {
      if ((q as { path?: string }).path === "shared/constitution.md") {
        return { path: "shared/constitution.md", content: opts.constitution };
      }
      return null;
    },
  };
  const agentMemoryColl = {
    findOne: async (q: Record<string, unknown>) => {
      const m = opts.memorySeeds.find(
        (s) => s.agentId === q.agentId && s.contentHash === q.contentHash,
      );
      return m ?? null;
    },
  };
  const agentDefsColl = {
    findOne: async (q: Record<string, unknown>) => {
      const id = (q as { _id?: string })._id;
      return opts.agents.find((a) => a._id === id) ?? null;
    },
    find: (q: Record<string, unknown>) => {
      const idClause = (q?._id as { $in?: string[] } | undefined)?.$in;
      const out = idClause
        ? opts.agents.filter((a) => idClause.includes(a._id))
        : opts.agents;
      return {
        toArray: async () => out,
        sort: () => ({
          toArray: async () => [...out].sort((a, b) => a._id.localeCompare(b._id)),
        }),
      };
    },
  };
  const collection = (name: string): unknown => {
    if (name === "memory") return memoryColl;
    if (name === "agent_definitions") return agentDefsColl;
    if (name === "agent_memory") return agentMemoryColl;
    return { findOne: async () => null, find: () => ({ toArray: async () => [] }) };
  };
  return { collection } as unknown as Db;
}

describe("buildAdoptRecord populates all six asset types", () => {
  it("snapshots skills, seeds, coreservers, schedule, prompts, and constitution", async () => {
    // Set up a frame on disk with a skill bundle and a seed file.
    const frameRoot = mkdtempSync(join(tmpdir(), "adopt-frame-"));
    mkdirSync(join(frameRoot, "skills", "demo-skill"), { recursive: true });
    writeFileSync(
      join(frameRoot, "skills", "demo-skill", "SKILL.md"),
      "# demo skill\n",
    );
    const seedContent = "seed body\n";
    writeFileSync(join(frameRoot, "seed.md"), seedContent);
    const seedHash = sha256Text(seedContent);

    const agentSchedule = { task: "morning-sweep", cron: "0 8 * * *" };
    const constitutionContent = `<a id="cap"></a>\ncap-body\n<a id="end"></a>\nend`;

    const db = makeAdoptDb({
      agents: [
        {
          _id: "alice",
          coreServers: ["memory", "keychain"],
          systemPrompt: `<a id="role-spec"></a>\nalice role`,
          schedule: [agentSchedule],
        },
      ],
      constitution: constitutionContent,
      memorySeeds: [{ _id: "mem-1", agentId: "alice", contentHash: seedHash }],
    });

    const manifest: FrameManifest = {
      name: "adopt-test",
      version: "1.0.0",
      rootPath: frameRoot,
      skills: [{ bundle: "skills/demo-skill" }],
      memorySeeds: [{ agent: "alice", tier: "hot", file: "seed.md" }],
      coreservers: [{ add: ["memory", "structured-memory"], agents: ["alice"] }],
      schedule: [
        { task: "morning-sweep", agents: ["alice"], cron: "0 8 * * *" },
      ],
      prompts: [{ anchor: "role-spec", agents: ["alice"], file: "ignored.md" }],
      constitution: [
        { anchor: "cap", insert: "replace-anchor", file: "ignored.md" },
      ],
    };

    const record = await buildAdoptRecord(db, manifest);

    expect(record.resources.skills?.length).toBe(1);
    expect(record.resources.skills?.[0]).toMatchObject({
      bundle: "skills/demo-skill",
      replacedClaimFrom: null,
    });
    expect(record.resources.skills?.[0].sha256).toMatch(/^[0-9a-f]{64}$/);

    expect(record.resources.memorySeeds?.length).toBe(1);
    expect(record.resources.memorySeeds?.[0]).toMatchObject({
      id: "mem-1",
      agent: "alice",
      tier: "hot",
      contentHash: seedHash,
      replacedClaimFrom: null,
    });

    expect(record.resources.coreservers).toEqual({ alice: ["memory"] });

    expect(record.resources.schedule?.alice?.length).toBe(1);
    expect(record.resources.schedule?.alice?.[0]).toMatchObject({
      task: "morning-sweep",
      cron: "0 8 * * *",
      pattern: "explicit",
      replacedClaimFrom: null,
    });

    expect(record.resources.prompts?.alice?.anchors).toEqual(["role-spec"]);
    expect(record.resources.prompts?.alice?.snapshotBefore).toContain("role-spec");

    expect(record.resources.constitution?.anchors).toEqual(["cap"]);
    expect(record.resources.constitution?.snapshotBefore).toBe(constitutionContent);
    expect(record.resources.constitution?.insertedText.cap).toContain("cap-body");
  });

  it("throws MissingAnchorError when a skill bundle is absent under --adopt", async () => {
    const frameRoot = mkdtempSync(join(tmpdir(), "adopt-missing-"));
    const db = makeAdoptDb({ agents: [], constitution: "", memorySeeds: [] });
    const manifest: FrameManifest = {
      name: "adopt-missing",
      version: "1.0.0",
      rootPath: frameRoot,
      skills: [{ bundle: "skills/not-there" }],
    };
    await expect(buildAdoptRecord(db, manifest)).rejects.toThrow(MissingAnchorError);
  });

  it("skips seed records when content-hash is not in agent_memory", async () => {
    const frameRoot = mkdtempSync(join(tmpdir(), "adopt-seed-skip-"));
    writeFileSync(join(frameRoot, "seed.md"), "uncovered seed\n");
    const db = makeAdoptDb({
      agents: [{ _id: "alice" }],
      constitution: "",
      memorySeeds: [], // no match
    });
    const manifest: FrameManifest = {
      name: "adopt-seed-skip",
      version: "1.0.0",
      rootPath: frameRoot,
      memorySeeds: [{ agent: "alice", tier: "hot", file: "seed.md" }],
    };
    const record = await buildAdoptRecord(db, manifest);
    expect(record.resources.memorySeeds).toBeUndefined();
  });
});
