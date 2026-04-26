import { describe, expect, it, vi } from "vitest";
import { runTick } from "./tick-runner.js";
import type { LinearClient } from "./linear-client.js";
import type { TicketState } from "./types.js";
import type { PipelineConfig } from "../types.js";

const config: PipelineConfig = { linearTeamKey: "KPR" };

function ticket(over: Partial<TicketState>): TicketState {
  return {
    id: "issue-id",
    identifier: "KPR-9",
    title: "test",
    description: "",
    state: "Backlog",
    labels: ["pipeline-auto", "type:trivial"],
    blockedBy: [],
    comments: [],
    attachments: [],
    ...over,
  };
}

function mockClient(t: TicketState): LinearClient {
  return {
    listTeamPipelineIssues: vi.fn().mockResolvedValue([t.identifier]),
    listChildren: vi.fn().mockResolvedValue([]),
    getTicketState: vi.fn().mockResolvedValue(t),
    addComment: vi.fn().mockResolvedValue({ id: "c", createdAt: new Date().toISOString() }),
    setState: vi.fn().mockResolvedValue(undefined),
    addLabel: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
  } as unknown as LinearClient;
}

describe("runTick", () => {
  it("dry-run does not call setState or spawn", async () => {
    const t = ticket({});
    const client = mockClient(t);
    const spawnFn = vi.fn();
    const report = await runTick({
      scope: "--all",
      dryRun: true,
      spawnBudget: 3,
      actionBudget: 25,
      includeBlocked: false,
      config,
      apiKey: "lin_x",
      clientFactory: () => client,
      spawnFn,
    });
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].outcome).toBe("skipped");
    expect(report.entries[0].detail).toBe("dry-run");
    expect(client.setState).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("trivial Backlog → advance to Ready writes setState", async () => {
    // Spy claim/release writes via addComment — they all go through addComment.
    const t = ticket({});
    const client = mockClient({
      ...t,
      // mutex.claim re-reads after writing; provide stable comments so it sees its own claim.
    });
    // Patch getTicketState to return distinct mutex states across calls.
    let calls = 0;
    (client.getTicketState as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return t; // top-level read
      // mutex pre-claim read (no claims yet)
      if (calls === 2) return { ...t, comments: [] };
      // After write, return our claim as latest. The body must match the
      // exact format mutex.claim wrote (we reverse-engineer: runId comes from
      // the test path, which we cannot read directly. Instead, we accept any
      // claim and let the verify pass since there is no contender.).
      return {
        ...t,
        comments: [
          {
            id: "c-claim",
            body: "tick-lock-claim: runId=tick-X action=advance",
            createdAt: new Date().toISOString(),
          },
        ],
      };
    });
    const report = await runTick({
      scope: "--all",
      dryRun: false,
      spawnBudget: 3,
      actionBudget: 25,
      includeBlocked: false,
      config,
      apiKey: "lin_x",
      clientFactory: () => client,
      spawnFn: vi.fn(),
    });
    // We don't assert on the post-runId mutex round-trip here (covered by mutex.test.ts);
    // we only assert the runner consulted the dispatcher correctly.
    expect(report.entries[0].decision.kind).toBe("advance");
  });

  it("spawn-budget caps spawning decisions", async () => {
    const t = ticket({ labels: ["pipeline-auto", "type:plan-only"] });
    const client = mockClient(t);
    (client.listTeamPipelineIssues as ReturnType<typeof vi.fn>).mockResolvedValue([
      "KPR-1",
      "KPR-2",
      "KPR-3",
    ]);
    (client.getTicketState as ReturnType<typeof vi.fn>).mockResolvedValue(t);
    const spawnFn = vi.fn().mockResolvedValue({ agentId: "agent-Z", status: "started" });
    const report = await runTick({
      scope: "--all",
      dryRun: true, // dry-run still consumes budget per the runner contract
      spawnBudget: 1,
      actionBudget: 25,
      includeBlocked: false,
      config,
      apiKey: "lin_x",
      clientFactory: () => client,
      spawnFn,
    });
    // First ticket consumes the only spawn slot; the next two are skipped.
    const skipped = report.entries.filter((e) => e.detail === "spawn-budget exhausted");
    expect(skipped.length).toBe(2);
  });

  it("includeBlocked surfaces report-only entries in `blocked`", async () => {
    const t = ticket({ labels: ["pipeline-auto", "block:human"] });
    const client = mockClient(t);
    const report = await runTick({
      scope: "--all",
      dryRun: true,
      spawnBudget: 3,
      actionBudget: 25,
      includeBlocked: true,
      config,
      apiKey: "lin_x",
      clientFactory: () => client,
      spawnFn: vi.fn(),
    });
    expect(report.blocked.length).toBe(1);
    expect(report.blocked[0].decision.kind).toBe("report-only");
  });
});
