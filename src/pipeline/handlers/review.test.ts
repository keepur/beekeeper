import { describe, expect, it, vi } from "vitest";
import { handleReview } from "./review.js";
import type { LinearClient } from "../linear-client.js";
import type { ActionDecision, TicketState, TicketComment, TicketAttachment } from "../types.js";
import type { PipelineConfig } from "../../types.js";

const config: PipelineConfig = { linearTeamKey: "KPR" };

function ticket(over: Partial<TicketState>): TicketState {
  return {
    id: "issue-id",
    identifier: "KPR-9",
    title: "test",
    description: "",
    state: "In Progress",
    labels: ["pipeline-auto"],
    blockedBy: [],
    comments: [],
    attachments: [],
    ...over,
  };
}

const decision: ActionDecision = { kind: "code-review", reason: "test", spawns: false };

function clientStub(): LinearClient {
  return {
    addLabel: vi.fn().mockResolvedValue(undefined),
    addComment: vi.fn().mockResolvedValue({ id: "c1", createdAt: new Date().toISOString() }),
    setState: vi.fn().mockResolvedValue(undefined),
  } as unknown as LinearClient;
}

describe("handleReview", () => {
  it("waits when In Progress with no PR", async () => {
    const result = await handleReview({
      client: clientStub(),
      ticket: ticket({}),
      decision,
      config,
      spawn: vi.fn(),
    });
    expect(result.outcome).toBe("skipped");
  });

  it("transitions to In Review when In Progress + PR present", async () => {
    const attachments: TicketAttachment[] = [
      { id: "a1", url: "https://github.com/x/y/pull/1", title: "PR" },
    ];
    const client = clientStub();
    const result = await handleReview({
      client,
      ticket: ticket({ attachments }),
      decision,
      config,
      spawn: vi.fn(),
    });
    expect(result.outcome).toBe("transitioned");
    expect(client.setState).toHaveBeenCalledWith("issue-id", "In Review");
  });

  it("APPROVE → ready to merge", async () => {
    const comments: TicketComment[] = [
      {
        id: "c1",
        body: '```json\n{"verdict":"APPROVE","findings":[]}\n```',
        createdAt: new Date().toISOString(),
      },
    ];
    const result = await handleReview({
      client: clientStub(),
      ticket: ticket({ state: "In Review", comments }),
      decision,
      config,
      spawn: vi.fn(),
    });
    expect(result.outcome).toBe("transitioned");
    expect(result.detail).toContain("APPROVE");
  });

  it("In Review + prior-state spawn-log (kind!=code-review) → does NOT suppress (no 'reviewer in flight' wait)", async () => {
    // Regression guard for round-2 fix: a spawn-log carried over from a
    // prior-state action (drafting/pickup/implementer) must not register
    // as a reviewer in flight. Without the kind=code-review filter, this
    // ticket would short-circuit to "reviewer in flight — waiting for output"
    // on every tick and the reviewer would never be spawned.
    //
    // Asserting the negation: the handler must NOT return that wait detail.
    // Whether it then spawns, blocks, or transitions depends on PR/repo
    // fixtures — orthogonal to this regression's guarantee.
    const comments: TicketComment[] = [
      {
        id: "c-old-spawn",
        body: "tick-spawn-log: runId=tick-old agentId=agent-pickup-01 kind=pickup",
        createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      },
    ];
    const result = await handleReview({
      client: clientStub(),
      ticket: ticket({ state: "In Review", comments }),
      decision,
      config,
      spawn: vi.fn(),
    });
    expect(result.detail).not.toContain("reviewer in flight");
  });

  it("In Review + spawn-log present + no reviewer output → wait, do not re-spawn", async () => {
    // Reviewer is in flight: spawn-log on the ticket but no JSON verdict
    // comment yet. The handler must skip (not re-spawn) so the in-flight
    // reviewer's output is what advances the state on the next tick.
    const comments: TicketComment[] = [
      {
        id: "c-spawn",
        body: "tick-spawn-log: runId=tick-1 agentId=agent-01ABC kind=code-review",
        createdAt: new Date().toISOString(),
      },
    ];
    const spawn = vi.fn();
    const result = await handleReview({
      client: clientStub(),
      ticket: ticket({ state: "In Review", comments }),
      decision,
      config,
      spawn,
    });
    expect(result.outcome).toBe("skipped");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("REQUEST CHANGES → block:human with finding summary", async () => {
    const comments: TicketComment[] = [
      {
        id: "c1",
        body: '```json\n{"verdict":"REQUEST CHANGES","findings":[{"severity":"BLOCKER","body":"x"}]}\n```',
        createdAt: new Date().toISOString(),
      },
    ];
    const client = clientStub();
    const result = await handleReview({
      client,
      ticket: ticket({ state: "In Review", comments }),
      decision,
      config,
      spawn: vi.fn(),
    });
    expect(result.outcome).toBe("blocked");
    expect(client.addLabel).toHaveBeenCalledWith("issue-id", "block:human");
  });
});
