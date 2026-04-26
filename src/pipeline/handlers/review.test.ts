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

  it("In Review + spawn-log present + no reviewer output → wait, do not re-spawn", async () => {
    // Reviewer is in flight: spawn-log on the ticket but no JSON verdict
    // comment yet. The handler must skip (not re-spawn) so the in-flight
    // reviewer's output is what advances the state on the next tick.
    const comments: TicketComment[] = [
      {
        id: "c-spawn",
        body: "tick-spawn-log: runId=tick-1 agentId=agent-01ABC",
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
