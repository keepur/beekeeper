import { describe, expect, it, vi } from "vitest";
import { claim, latestClaim, hasMatchingRelease, newRunId } from "./mutex.js";
import type { LinearClient } from "./linear-client.js";
import type { TicketComment, TicketState } from "./types.js";

function comment(body: string, createdAt: string, id = body.slice(0, 8)): TicketComment {
  return { id, body, createdAt };
}

describe("mutex helpers", () => {
  it("latestClaim ignores release and spawn-log comments", () => {
    const comments: TicketComment[] = [
      comment("tick-lock-claim: runId=tick-1 action=pickup", "2026-04-26T00:00:00.000Z"),
      comment("tick-spawn-log: runId=tick-1 agentId=foo", "2026-04-26T00:00:01.000Z"),
      comment("tick-lock-release: runId=tick-1 outcome=spawned", "2026-04-26T00:00:02.000Z"),
      comment("just a note", "2026-04-26T00:00:03.000Z"),
    ];
    const c = latestClaim(comments);
    expect(c?.runId).toBe("tick-1");
  });

  it("latestClaim returns most recent claim by createdAt", () => {
    const comments: TicketComment[] = [
      comment("tick-lock-claim: runId=tick-1 action=pickup", "2026-04-26T00:00:00.000Z"),
      comment("tick-lock-claim: runId=tick-2 action=pickup", "2026-04-26T00:00:05.000Z"),
    ];
    expect(latestClaim(comments)?.runId).toBe("tick-2");
  });

  it("hasMatchingRelease finds release after claim", () => {
    const comments: TicketComment[] = [
      comment("tick-lock-release: runId=tick-1 outcome=spawned", "2026-04-26T00:00:10.000Z"),
    ];
    expect(hasMatchingRelease(comments, "tick-1", new Date("2026-04-26T00:00:00.000Z"))).toBe(true);
  });
});

describe("claim", () => {
  function mockClient(initial: TicketComment[], afterWrite: TicketComment[]): LinearClient {
    const calls: string[] = [];
    const stateCommon: Omit<TicketState, "comments"> = {
      id: "issue-id",
      identifier: "KPR-1",
      title: "t",
      description: "",
      state: "Backlog",
      labels: [],
      blockedBy: [],
      attachments: [],
    };
    return {
      getTicketState: vi
        .fn()
        .mockResolvedValueOnce({ ...stateCommon, comments: initial })
        .mockResolvedValueOnce({ ...stateCommon, comments: afterWrite }),
      addComment: vi.fn(async (_id: string, body: string) => {
        calls.push(body);
        return { id: `c-${calls.length}`, createdAt: "2026-04-26T00:00:30.000Z" };
      }),
    } as unknown as LinearClient;
  }

  it("acquires lock when no contention", async () => {
    const runId = newRunId();
    const after: TicketComment[] = [
      comment(`tick-lock-claim: runId=${runId} action=pickup`, "2026-04-26T00:00:30.000Z"),
    ];
    const result = await claim(mockClient([], after), "KPR-1", runId, "pickup");
    expect(result.acquired).toBe(true);
  });

  it("backs off when a different fresh claim exists", async () => {
    const runId = "tick-mine";
    const recent = new Date(Date.now() - 1_000).toISOString();
    const initial: TicketComment[] = [
      comment("tick-lock-claim: runId=tick-other action=pickup", recent),
    ];
    const result = await claim(mockClient(initial, initial), "KPR-1", runId, "pickup");
    expect(result.acquired).toBe(false);
    expect(result.contendedBy).toBe("tick-other");
  });

  it("ignores stale claim past TTL", async () => {
    const runId = "tick-mine";
    const stale = new Date(Date.now() - 120_000).toISOString();
    const after: TicketComment[] = [
      comment("tick-lock-claim: runId=tick-old action=pickup", stale),
      comment(`tick-lock-claim: runId=${runId} action=pickup`, new Date().toISOString()),
    ];
    const initial: TicketComment[] = [
      comment("tick-lock-claim: runId=tick-old action=pickup", stale),
    ];
    const result = await claim(mockClient(initial, after), "KPR-1", runId, "pickup");
    expect(result.acquired).toBe(true);
  });

  it("loses race if a different runId becomes most-recent on verify", async () => {
    const runId = "tick-mine";
    const initial: TicketComment[] = [];
    const after: TicketComment[] = [
      comment(`tick-lock-claim: runId=${runId} action=pickup`, "2026-04-26T00:00:30.000Z"),
      comment(
        "tick-lock-claim: runId=tick-other action=pickup",
        "2026-04-26T00:00:31.000Z",
      ),
    ];
    const result = await claim(mockClient(initial, after), "KPR-1", runId, "pickup");
    expect(result.acquired).toBe(false);
    expect(result.contendedBy).toBe("tick-other");
  });
});
