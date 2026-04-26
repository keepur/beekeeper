import { describe, it, expect } from "vitest";
import type { Db } from "mongodb";
import { extractAnchorNeighborhood } from "../text-utils.js";
import { verifyAnchors } from "./apply.js";
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
