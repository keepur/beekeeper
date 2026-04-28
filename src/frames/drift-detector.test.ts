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
}

function makeMockDb(responses: MockResponses): Db {
  // Per-collection mock — only `memory` is exercised for the constitution-only tests.
  const memoryColl = {
    findOne: async (q: { path: string }) => {
      void q;
      return responses.memory ?? null;
    },
  };
  const collection = (name: string): unknown => {
    if (name === "memory") return memoryColl;
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
});
