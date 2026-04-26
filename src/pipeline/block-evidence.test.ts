import { describe, expect, it } from "vitest";
import { hasUnblockEvidence } from "./block-evidence.js";
import type { TicketComment } from "./types.js";

const c = (body: string, ts: string): TicketComment => ({ id: ts, body, createdAt: ts });

describe("hasUnblockEvidence", () => {
  it("returns false when only pipeline comments exist", () => {
    expect(
      hasUnblockEvidence([
        c("tick-lock-claim: runId=tick-1 action=pickup", "2026-04-26T00:00:00.000Z"),
        c("tick-spawn-log: runId=tick-1 agentId=x", "2026-04-26T00:00:01.000Z"),
        c("tick-lock-release: runId=tick-1 outcome=spawned", "2026-04-26T00:00:02.000Z"),
      ]),
    ).toBe(false);
  });

  it("returns true when at least one non-pipeline comment exists", () => {
    expect(
      hasUnblockEvidence([
        c("tick-lock-claim: runId=tick-1 action=pickup", "2026-04-26T00:00:00.000Z"),
        c("Operator: I rebased and pushed.", "2026-04-26T00:01:00.000Z"),
      ]),
    ).toBe(true);
  });

  it("returns false on empty comment list", () => {
    expect(hasUnblockEvidence([])).toBe(false);
  });

  it("returns false when only the tick's own block-diagnostic comment is present (operator removed label without evidence)", () => {
    expect(
      hasUnblockEvidence([
        c("tick-lock-claim: runId=tick-1 action=draft-plan", "2026-04-26T00:00:00.000Z"),
        c("block:human — could not resolve target repo from ticket description", "2026-04-26T00:01:00.000Z"),
        c("tick-lock-release: runId=tick-1 outcome=skipped", "2026-04-26T00:01:30.000Z"),
      ]),
    ).toBe(false);
  });

  it("returns false on a blocked→advanced→re-blocked cycle with no operator evidence", () => {
    // Realistic Phase 1 sequence: ticket gets blocked, later advances and the
    // drafting handler posts a transition comment, then re-blocks. The
    // transition comment is tick-authored — must not register as evidence.
    expect(
      hasUnblockEvidence([
        c("block:human — initial block", "2026-04-26T00:00:00.000Z"),
        c("Drafting handler: draft-plan review-clean → state Ready.", "2026-04-26T01:00:00.000Z"),
        c("block:human — could not resolve target repo on second pass", "2026-04-26T02:00:00.000Z"),
      ]),
    ).toBe(false);
  });
});
