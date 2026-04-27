import { describe, it, expect } from "vitest";
import { applyDriftDecisions, summarizeAudit } from "./audit.js";
import { resourceKey } from "../text-utils.js";
import type { AppliedFrameRecord, DriftFinding } from "../types.js";

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

describe("summarizeAudit", () => {
  it("returns exit 0 with 'nothing to audit' when no frames are applied", () => {
    const summary = summarizeAudit("dodi", 0, []);
    expect(summary.exitCode).toBe(0);
    expect(summary.message).toContain('No frames applied to "dodi"');
    expect(summary.message).toContain("Nothing to audit");
  });

  it("clean state: no findings → exit 0, no drift: lines", () => {
    const summary = summarizeAudit("dodi", 3, []);
    expect(summary.exitCode).toBe(0);
    expect(summary.message).toContain("Audit clean");
    expect(summary.message).toContain("3 frame(s) applied");
    expect(summary.message).not.toContain("drift:");
  });

  it("actionable drift: one constitution-text-changed → exit 1, line begins with drift:", () => {
    const findings: DriftFinding[] = [
      {
        frame: "dodi-cabinets@1.0.0",
        kind: "constitution-text-changed",
        resource: resourceKey("constitution", "section-2"),
        detail: 'frame "dodi-cabinets@1.0.0" constitution anchor "section-2" text diverged from snapshot',
        informational: false,
      },
    ];
    const summary = summarizeAudit("dodi", 1, findings);
    expect(summary.exitCode).toBe(1);
    expect(summary.message).toContain("Audit found 1 actionable + 0 informational drift item(s):");
    expect(summary.message).toMatch(/^\s*drift:\s+\[constitution-text-changed\] dodi-cabinets@1\.0\.0/m);
  });

  it("informational-only findings → exit 0, line begins with info:", () => {
    const findings: DriftFinding[] = [
      {
        frame: "dodi-cabinets@1.0.0",
        kind: "constitution-text-changed",
        resource: resourceKey("constitution", "section-2"),
        detail: 'frame "dodi-cabinets@1.0.0" constitution anchor "section-2" text diverged from snapshot',
        informational: true,
      },
    ];
    const summary = summarizeAudit("dodi", 1, findings);
    expect(summary.exitCode).toBe(0);
    expect(summary.message).toMatch(/^\s*info:\s+\[constitution-text-changed\]/m);
    expect(summary.message).not.toMatch(/^\s*drift:/m);
  });

  it("prints actionable findings before informational", () => {
    const findings: DriftFinding[] = [
      {
        frame: "f",
        kind: "overridden-claim",
        resource: resourceKey("skills", "memory-hygiene"),
        detail: "info-line",
        informational: true,
      },
      {
        frame: "f",
        kind: "skill-modified-locally",
        resource: resourceKey("skills", "memory-hygiene"),
        detail: "actionable-line",
        informational: false,
      },
    ];
    const summary = summarizeAudit("dodi", 1, findings);
    const driftIdx = summary.message.indexOf("drift:");
    const infoIdx = summary.message.indexOf("info:");
    expect(driftIdx).toBeGreaterThan(-1);
    expect(infoIdx).toBeGreaterThan(driftIdx);
    expect(summary.exitCode).toBe(1);
  });
});

describe("applyDriftDecisions", () => {
  const finding: DriftFinding = {
    frame: "test-frame",
    kind: "constitution-text-changed",
    resource: resourceKey("constitution", "capabilities"),
    detail: "...",
    informational: false,
  };

  it("clean state: no decisions → finding passes through unchanged", () => {
    const record = makeRecord();
    const out = applyDriftDecisions(record, [finding]);
    expect(out).toEqual([finding]);
  });

  it("actionable drift with no prior decision → still actionable", () => {
    const record = makeRecord({ driftAccepted: [] });
    const out = applyDriftDecisions(record, [finding]);
    expect(out.length).toBe(1);
    expect(out[0].informational).toBe(false);
  });

  it("deferred decision against current version → demoted to informational", () => {
    const record = makeRecord({
      driftAccepted: [
        {
          resource: finding.resource,
          decision: "deferred",
          decidedAt: new Date("2026-04-26T00:00:00Z"),
          decidedBy: "tester",
          againstVersion: "1.0.0",
        },
      ],
    });
    const out = applyDriftDecisions(record, [finding]);
    expect(out.length).toBe(1);
    expect(out[0].informational).toBe(true);
  });

  it("keep-local decision against current version → suppressed entirely", () => {
    const record = makeRecord({
      driftAccepted: [
        {
          resource: finding.resource,
          decision: "keep-local",
          decidedAt: new Date("2026-04-26T00:00:00Z"),
          decidedBy: "tester",
          againstVersion: "1.0.0",
        },
      ],
    });
    const out = applyDriftDecisions(record, [finding]);
    expect(out).toEqual([]);
  });

  it("take-frame decision against an older version → re-surfaces as actionable", () => {
    const record = makeRecord({
      version: "2.0.0",
      driftAccepted: [
        {
          resource: finding.resource,
          decision: "take-frame",
          decidedAt: new Date("2026-04-26T00:00:00Z"),
          decidedBy: "tester",
          againstVersion: "1.0.0",
        },
      ],
    });
    const out = applyDriftDecisions(record, [finding]);
    expect(out.length).toBe(1);
    expect(out[0].informational).toBe(false);
  });

  it("decision with missing againstVersion → re-surfaces (treat as ask-again)", () => {
    const record = makeRecord({
      driftAccepted: [
        {
          resource: finding.resource,
          decision: "keep-local",
          decidedAt: new Date("2026-04-26T00:00:00Z"),
          decidedBy: "tester",
        },
      ],
    });
    const out = applyDriftDecisions(record, [finding]);
    expect(out.length).toBe(1);
    expect(out[0].informational).toBe(false);
  });

  it("multiple decisions for same resource: latest decidedAt wins", () => {
    const record = makeRecord({
      driftAccepted: [
        {
          resource: finding.resource,
          decision: "deferred",
          decidedAt: new Date("2026-04-25T00:00:00Z"),
          decidedBy: "tester",
          againstVersion: "1.0.0",
        },
        {
          resource: finding.resource,
          decision: "take-frame",
          decidedAt: new Date("2026-04-26T00:00:00Z"),
          decidedBy: "tester",
          againstVersion: "1.0.0",
        },
      ],
    });
    const out = applyDriftDecisions(record, [finding]);
    // Latest is take-frame at current version → suppressed.
    expect(out).toEqual([]);
  });
});
