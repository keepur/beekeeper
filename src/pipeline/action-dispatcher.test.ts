import { describe, expect, it } from "vitest";
import { decideAction } from "./action-dispatcher.js";
import type { TicketState } from "./types.js";

function makeTicket(over: Partial<TicketState>): TicketState {
  return {
    id: "id",
    identifier: "KPR-1",
    title: "t",
    description: "",
    state: "Backlog",
    labels: [],
    blockedBy: [],
    comments: [],
    attachments: [],
    ...over,
  };
}

describe("decideAction", () => {
  it("Backlog + type:trivial + pipeline-auto → advance to Ready", () => {
    const d = decideAction(makeTicket({ labels: ["type:trivial", "pipeline-auto"] }));
    expect(d.kind).toBe("advance");
    expect(d.payload?.nextState).toBe("Ready");
    expect(d.spawns).toBe(false);
  });

  it("Backlog + type:plan-only + pipeline-auto → draft-plan", () => {
    const d = decideAction(makeTicket({ labels: ["type:plan-only", "pipeline-auto"] }));
    expect(d.kind).toBe("draft-plan");
    expect(d.spawns).toBe(true);
  });

  it("Backlog + type:spec-and-plan + pipeline-auto → draft-spec", () => {
    const d = decideAction(makeTicket({ labels: ["type:spec-and-plan", "pipeline-auto"] }));
    expect(d.kind).toBe("draft-spec");
    expect(d.spawns).toBe(true);
  });

  it("Backlog without pipeline-auto → skip", () => {
    const d = decideAction(makeTicket({ labels: ["type:plan-only"] }));
    expect(d.kind).toBe("skip");
  });

  it("Backlog with blockedBy → skip", () => {
    const d = decideAction(
      makeTicket({ labels: ["type:plan-only", "pipeline-auto"], blockedBy: ["KPR-2"] }),
    );
    expect(d.kind).toBe("skip");
  });

  it("Spec Drafting → spec-review (handler interrogates)", () => {
    const d = decideAction(makeTicket({ state: "Spec Drafting" }));
    expect(d.kind).toBe("spec-review");
    expect(d.spawns).toBe(false);
  });

  it("Plan Drafting → plan-review", () => {
    const d = decideAction(makeTicket({ state: "Plan Drafting" }));
    expect(d.kind).toBe("plan-review");
  });

  it("Ready not blockedBy → pickup", () => {
    const d = decideAction(makeTicket({ state: "Ready" }));
    expect(d.kind).toBe("pickup");
    expect(d.spawns).toBe(true);
  });

  it("Ready blockedBy → skip", () => {
    const d = decideAction(makeTicket({ state: "Ready", blockedBy: ["KPR-2"] }));
    expect(d.kind).toBe("skip");
  });

  it("In Progress → code-review (handler reads PR state)", () => {
    const d = decideAction(makeTicket({ state: "In Progress" }));
    expect(d.kind).toBe("code-review");
  });

  it("In Review → code-review", () => {
    const d = decideAction(makeTicket({ state: "In Review" }));
    expect(d.kind).toBe("code-review");
  });

  it("Done → skip", () => {
    expect(decideAction(makeTicket({ state: "Done" })).kind).toBe("skip");
  });

  it("Canceled → skip", () => {
    expect(decideAction(makeTicket({ state: "Canceled" })).kind).toBe("skip");
  });

  it("block:human short-circuits → report-only", () => {
    const d = decideAction(makeTicket({ state: "Ready", labels: ["block:human"] }));
    expect(d.kind).toBe("report-only");
  });

  it("block:ci short-circuits → report-only (handler will re-decide on green)", () => {
    const d = decideAction(makeTicket({ state: "In Review", labels: ["block:ci"] }));
    expect(d.kind).toBe("report-only");
  });

  it("block:external short-circuits → report-only", () => {
    const d = decideAction(makeTicket({ state: "Ready", labels: ["block:external"] }));
    expect(d.kind).toBe("report-only");
  });
});
