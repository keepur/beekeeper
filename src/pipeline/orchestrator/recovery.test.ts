import { describe, it, expect, vi } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { runStartupRecovery } from "./recovery.js";
import type { TicketState } from "../types.js";

const NOW = new Date("2026-04-26T12:00:00Z").getTime();
const SPAWN_AT = new Date("2026-04-26T11:00:00Z").toISOString();
const POST_SPAWN = new Date("2026-04-26T11:30:00Z").toISOString();

function ticket(over: Partial<TicketState> = {}): TicketState {
  return {
    id: "iid",
    identifier: "KPR-79",
    title: "t",
    description: "",
    state: "Spec Drafting",
    labels: [],
    blockedBy: [],
    comments: [],
    attachments: [],
    ...over,
  };
}

function spawnLogComment(agentId: string, kind: string, createdAt = SPAWN_AT) {
  return {
    id: `c-spawn-${agentId}`,
    body: `tick-spawn-log: runId=tick-XYZ agentId=${agentId} kind=${kind}`,
    createdAt,
  };
}

function makeLinear(t: TicketState[]) {
  return {
    listTeamPipelineIssues: vi.fn().mockResolvedValue(t.map((x) => x.identifier)),
    getTicketState: vi.fn(async (id: string) => t.find((x) => x.identifier === id)!),
    addComment: vi.fn().mockResolvedValue({ id: "c", createdAt: "" }),
    addLabel: vi.fn().mockResolvedValue(undefined),
  };
}

describe("runStartupRecovery", () => {
  it("skips ticket when agentId is in active set", async () => {
    const t = ticket({ comments: [spawnLogComment("agent-A", "draft-spec")] });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(["agent-A"]), now: () => NOW });
    expect(r.orphaned).toBe(0);
    expect(lin.addComment).not.toHaveBeenCalled();
  });

  it("skips when prior self-write sentinel exists (idempotency)", async () => {
    const t = ticket({
      comments: [
        spawnLogComment("agent-A", "draft-spec"),
        {
          id: "c-self",
          body: "pipeline-tick: subagent agent-A was lost in a Beekeeper server restart at 2026-04-26T05:00:00Z; ...",
          createdAt: POST_SPAWN,
        },
      ],
    });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(), now: () => NOW });
    expect(r.orphaned).toBe(0);
    expect(lin.addComment).not.toHaveBeenCalled();
  });

  it("drafting kind: skips when state moved off drafting", async () => {
    const t = ticket({
      state: "Ready",
      comments: [spawnLogComment("agent-A", "draft-plan")],
    });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(), now: () => NOW });
    expect(r.orphaned).toBe(0);
  });

  it("drafting kind: skips when sentinel comment posted after spawn", async () => {
    const t = ticket({
      comments: [
        spawnLogComment("agent-A", "draft-spec"),
        { id: "c-q", body: "thinking...\n=== OPEN QUESTIONS (BLOCK:HUMAN) ===\n1. q\n=== END OPEN QUESTIONS ===", createdAt: POST_SPAWN },
      ],
    });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(), now: () => NOW });
    expect(r.orphaned).toBe(0);
  });

  it("drafting kind: orphan when still in drafting + no signals", async () => {
    const t = ticket({ comments: [spawnLogComment("agent-A", "draft-spec")] });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(), now: () => NOW });
    expect(r.orphaned).toBe(1);
    expect(lin.addComment).toHaveBeenCalled();
    expect(lin.addLabel).toHaveBeenCalledWith("iid", "block:human");
  });

  it("code-review kind: skips when reviewer verdict JSON appears post-spawn", async () => {
    const t = ticket({
      state: "In Review",
      comments: [
        spawnLogComment("agent-R", "code-review"),
        { id: "c-rev", body: '```json\n{ "verdict": "APPROVE", "findings": [] }\n```', createdAt: POST_SPAWN },
      ],
    });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(), now: () => NOW });
    expect(r.orphaned).toBe(0);
  });

  it("code-review kind: orphan when no verdict + no fallback", async () => {
    const t = ticket({
      state: "In Review",
      comments: [spawnLogComment("agent-R", "code-review")],
    });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(), now: () => NOW });
    expect(r.orphaned).toBe(1);
  });

  it("implementer kind: skips when PR attachment created after spawn", async () => {
    const t = ticket({
      state: "In Progress",
      comments: [spawnLogComment("agent-I", "implementer")],
      attachments: [{ id: "a", url: "https://github.com/x/y/pull/1", title: "PR", createdAt: POST_SPAWN }],
    });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(), now: () => NOW });
    expect(r.orphaned).toBe(0);
  });

  it("implementer kind: skips when state moved out of In Progress", async () => {
    const t = ticket({
      state: "In Review",
      comments: [spawnLogComment("agent-I", "implementer")],
    });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(), now: () => NOW });
    expect(r.orphaned).toBe(0);
  });

  it("implementer kind: orphan when still In Progress + no PR + no fallback", async () => {
    const t = ticket({
      state: "In Progress",
      comments: [spawnLogComment("agent-I", "implementer")],
    });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(), now: () => NOW });
    expect(r.orphaned).toBe(1);
  });

  it("universal fallback: skips when ticket has any block:* label", async () => {
    const t = ticket({
      labels: ["block:human"],
      comments: [spawnLogComment("agent-A", "draft-spec")],
    });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(), now: () => NOW });
    expect(r.orphaned).toBe(0);
  });

  it("ignores spawn-logs older than the 24h window", async () => {
    const old = new Date("2026-04-24T00:00:00Z").toISOString(); // 60h ago
    const t = ticket({ comments: [spawnLogComment("agent-A", "draft-spec", old)] });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(), now: () => NOW });
    expect(r.orphaned).toBe(0);
  });

  it("uses post-spawn-log timestamp ordering for PR-attachment", async () => {
    // PR attachment from BEFORE the spawn-log should not count as completion.
    const t = ticket({
      state: "In Progress",
      comments: [spawnLogComment("agent-I", "implementer")],
      attachments: [{ id: "a", url: "https://github.com/x/y/pull/1", title: "PR", createdAt: new Date("2026-04-26T10:00:00Z").toISOString() }],
    });
    const lin = makeLinear([t]);
    const r = await runStartupRecovery({ linear: lin as never, activeAgentIds: new Set(), now: () => NOW });
    expect(r.orphaned).toBe(1);
  });
});
