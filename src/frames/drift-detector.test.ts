import { describe, it, expect } from "vitest";
import type { Db } from "mongodb";
import { detectDrift } from "./drift-detector.js";
import { extractAnchorNeighborhood, resourceKey } from "./text-utils.js";
import type { AppliedFrameRecord } from "./types.js";

function makeRecord(overrides: Partial<AppliedFrameRecord> = {}): AppliedFrameRecord {
  return {
    _id: "test-frame",
    version: "1.0.0",
    appliedAt: new Date("2026-04-26T00:00:00Z"),
    appliedBy: "tester",
    manifest: {
      name: "test-frame",
      version: "1.0.0",
      rootPath: "/tmp/frame",
    },
    resources: {},
    ...overrides,
  };
}

interface MockResponses {
  memory?: { content: string } | null;
  agentDefs?: Array<{ _id: string; systemPrompt?: string }>;
}

function makeMockDb(responses: MockResponses): Db {
  // Per-collection mock. `memory` covers constitution; `agent_definitions`
  // covers per-agent systemPrompt for prompt drift checks.
  const memoryColl = {
    findOne: async (q: { path: string }) => {
      void q;
      return responses.memory ?? null;
    },
  };
  const agentDefsColl = {
    findOne: async (q: { _id: string }) => {
      const found = (responses.agentDefs ?? []).find((a) => a._id === q._id);
      return found ?? null;
    },
  };
  const collection = (name: string): unknown => {
    if (name === "memory") return memoryColl;
    if (name === "agent_definitions") return agentDefsColl;
    return {
      findOne: async () => null,
      find: () => ({ toArray: async () => [] }),
    };
  };
  return { collection } as unknown as Db;
}

describe("detectDrift", () => {
  it("returns no findings when nothing is recorded in resources", async () => {
    const record = makeRecord();
    const db = makeMockDb({ memory: { content: "" } });
    const findings = await detectDrift(db, record, "/tmp/svc");
    expect(findings).toEqual([]);
  });

  it("flags constitution-text-changed when current text diverges from snapshot", async () => {
    const original = `prefix\n<a id="capabilities"></a>\noriginal-body\n<a id="next"></a>\ntail`;
    const drifted = `prefix\n<a id="capabilities"></a>\nLOCALLY-EDITED\n<a id="next"></a>\ntail`;
    const expectedNeighborhood = extractAnchorNeighborhood(original, "capabilities");

    const record = makeRecord({
      resources: {
        constitution: {
          anchors: ["capabilities"],
          snapshotBefore: original,
          insertedText: { capabilities: expectedNeighborhood },
        },
      },
    });

    const db = makeMockDb({ memory: { content: drifted } });
    const findings = await detectDrift(db, record, "/tmp/svc");
    expect(findings.length).toBe(1);
    const [f] = findings;
    expect(f.kind).toBe("constitution-text-changed");
    expect(f.resource).toBe(resourceKey("constitution", "capabilities"));
    expect(f.informational).toBe(false);
    expect(f.frame).toBe("test-frame");
  });

  it("flags constitution-anchor-missing when the anchor is gone from the document", async () => {
    const original = `<a id="capabilities"></a>\nbody\n<a id="next"></a>\ntail`;
    const expectedNeighborhood = extractAnchorNeighborhood(original, "capabilities");

    const record = makeRecord({
      resources: {
        constitution: {
          anchors: ["capabilities"],
          snapshotBefore: original,
          insertedText: { capabilities: expectedNeighborhood },
        },
      },
    });

    // The anchor was removed from the live document.
    const db = makeMockDb({ memory: { content: `no anchors here at all` } });
    const findings = await detectDrift(db, record, "/tmp/svc");
    expect(findings.length).toBe(1);
    const [f] = findings;
    expect(f.kind).toBe("constitution-anchor-missing");
    expect(f.resource).toBe(resourceKey("constitution", "capabilities"));
    expect(f.informational).toBe(false);
  });

  it("KPR-99/100: no false drift when constitution has non-frame anchors interleaved", async () => {
    // Reproduces the post-apply audit scenario: writer used frame-scoped
    // extraction with frameAnchors = {memory, capabilities}, recording a
    // neighborhood that walks past the operator's <a id="internal-x">. Audit
    // must use the same scoping (built from record.manifest.constitution),
    // otherwise the re-extracted neighborhood would diverge and falsely
    // report constitution-text-changed.
    const content = [
      "intro",
      "",
      "<a id=\"memory\"></a>",
      "### Manage your memory lifecycle",
      "",
      "memory body",
      "",
      "<a id=\"internal-x\"></a>",
      "operator's own subsection",
      "",
      "<a id=\"capabilities\"></a>",
      "### capabilities",
      "cap-body",
      "",
    ].join("\n");
    const frameAnchors = new Set(["memory", "capabilities"]);
    const memoryNeighborhood = extractAnchorNeighborhood(content, "memory", frameAnchors);
    const capabilitiesNeighborhood = extractAnchorNeighborhood(
      content,
      "capabilities",
      frameAnchors,
    );

    const record = makeRecord({
      manifest: {
        name: "test-frame",
        version: "1.0.0",
        rootPath: "/tmp/frame",
        constitution: [
          { anchor: "memory", insert: "replace-anchor", file: "ignored.md" },
          { anchor: "capabilities", insert: "replace-anchor", file: "ignored.md" },
        ],
      },
      resources: {
        constitution: {
          anchors: ["memory", "capabilities"],
          snapshotBefore: content,
          insertedText: {
            memory: memoryNeighborhood,
            capabilities: capabilitiesNeighborhood,
          },
        },
      },
    });

    const db = makeMockDb({ memory: { content } });
    const findings = await detectDrift(db, record, "/tmp/svc");
    const constitutionDrift = findings.filter(
      (f) =>
        f.kind === "constitution-text-changed" ||
        f.kind === "constitution-anchor-missing",
    );
    expect(constitutionDrift).toEqual([]);
  });

  it("KPR-107: duplicate constitution anchor emits constitution-malformed (not N anchor-missing)", async () => {
    // Setup: the recorded frame has two anchors. The live document has a
    // duplicate of one of them — `collectAnchorSet` will throw. Pre-KPR-107
    // this would silently produce an empty Set and emit
    // `constitution-anchor-missing` for both anchors. Now we expect a single
    // `constitution-malformed` finding pointing at the underlying error.
    const original = `<a id="memory"></a>\nbody-m\n<a id="capabilities"></a>\nbody-c`;
    const drifted = `<a id="memory"></a>\nbody-m\n<a id="capabilities"></a>\n<a id="capabilities"></a>\nbody-c`;
    const expectedM = extractAnchorNeighborhood(original, "memory");
    const expectedC = extractAnchorNeighborhood(original, "capabilities");

    const record = makeRecord({
      manifest: {
        name: "test-frame",
        version: "1.0.0",
        rootPath: "/tmp/frame",
        constitution: [
          { anchor: "memory", insert: "replace-anchor", file: "ignored.md" },
          { anchor: "capabilities", insert: "replace-anchor", file: "ignored.md" },
        ],
      },
      resources: {
        constitution: {
          anchors: ["memory", "capabilities"],
          snapshotBefore: original,
          insertedText: { memory: expectedM, capabilities: expectedC },
        },
      },
    });

    const db = makeMockDb({ memory: { content: drifted } });
    const findings = await detectDrift(db, record, "/tmp/svc");

    const malformed = findings.filter((f) => f.kind === "constitution-malformed");
    expect(malformed.length).toBe(1);
    expect(malformed[0].informational).toBe(false);
    expect(malformed[0].detail).toContain("Duplicate anchor");
    expect(malformed[0].detail).toContain("capabilities");

    // Should NOT emit anchor-missing for either anchor — those would be
    // misleading given the real cause.
    const anchorMissing = findings.filter(
      (f) => f.kind === "constitution-anchor-missing",
    );
    expect(anchorMissing).toEqual([]);
  });

  it("KPR-107: duplicate prompt anchor on one agent emits prompt-malformed for that agent only", async () => {
    // Setup: prompts block for two agents. Agent A's systemPrompt has a
    // duplicate anchor — should emit `prompt-malformed` and skip per-anchor
    // checks for A. Agent B's prompt is well-formed but missing the required
    // anchor — should still emit `prompt-anchor-missing`.
    const aliceDuplicate = `<a id="role-spec"></a>\n<a id="role-spec"></a>\nbody`;
    const bobMissing = `no anchors here`;

    const record = makeRecord({
      resources: {
        prompts: {
          alice: {
            anchors: ["role-spec"],
            snapshotBefore: aliceDuplicate,
            insertedText: { "role-spec": "expected" },
          },
          bob: {
            anchors: ["role-spec"],
            snapshotBefore: bobMissing,
            insertedText: { "role-spec": "expected" },
          },
        },
      },
    });

    const db = makeMockDb({
      memory: { content: "" },
      agentDefs: [
        { _id: "alice", systemPrompt: aliceDuplicate },
        { _id: "bob", systemPrompt: bobMissing },
      ],
    });
    const findings = await detectDrift(db, record, "/tmp/svc");

    const malformed = findings.filter((f) => f.kind === "prompt-malformed");
    expect(malformed.length).toBe(1);
    expect(malformed[0].resource).toContain("alice");
    expect(malformed[0].detail).toContain("Duplicate anchor");
    expect(malformed[0].informational).toBe(false);

    const missing = findings.filter((f) => f.kind === "prompt-anchor-missing");
    expect(missing.length).toBe(1);
    expect(missing[0].resource).toContain("bob");
  });
});
