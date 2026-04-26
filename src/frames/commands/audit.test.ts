import { describe, it, expect } from "vitest";
import { summarizeAudit, type AuditFinding } from "./audit.js";

describe("summarizeAudit", () => {
  it("returns exit 0 with 'nothing to audit' when no frames are applied", () => {
    const summary = summarizeAudit("dodi", 0, []);
    expect(summary.exitCode).toBe(0);
    expect(summary.message).toContain('No frames applied to "dodi"');
    expect(summary.message).toContain("Nothing to audit");
  });

  it("returns exit 0 with 'clean' message when records exist and findings are empty", () => {
    const summary = summarizeAudit("dodi", 3, []);
    expect(summary.exitCode).toBe(0);
    expect(summary.message).toContain("Audit clean");
    expect(summary.message).toContain("3 frame(s) applied");
  });

  it("returns exit 1 and lists findings when drift is detected", () => {
    const findings: AuditFinding[] = [
      {
        frame: "dodi-cabinets@1.0.0",
        resource: "constitution:section-2",
        kind: "missing-anchor",
        detail: 'anchor "section-2" not present in shared/constitution.md',
      },
      {
        frame: "dodi-cabinets@1.0.0",
        resource: "memory-seed:seed-1",
        kind: "missing-seed",
        detail: "agent_memory record seed-1 no longer present",
      },
    ];
    const summary = summarizeAudit("dodi", 1, findings);
    expect(summary.exitCode).toBe(1);
    expect(summary.message).toContain("Audit found 2 drift item(s):");
    expect(summary.message).toContain("[missing-anchor] dodi-cabinets@1.0.0 -> constitution:section-2");
    expect(summary.message).toContain("[missing-seed] dodi-cabinets@1.0.0 -> memory-seed:seed-1");
  });
});
