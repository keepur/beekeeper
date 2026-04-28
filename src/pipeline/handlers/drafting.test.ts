import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleDrafting } from "./drafting.js";
import type { LinearClient } from "../linear-client.js";
import type { ActionDecision, TicketState } from "../types.js";
import type { PipelineConfig } from "../../types.js";

function ticket(over: Partial<TicketState>): TicketState {
  return {
    id: "issue-id",
    identifier: "KPR-9",
    title: "test",
    description: "Update beekeeper config.",
    state: "Backlog",
    labels: ["pipeline-auto", "type:plan-only"],
    blockedBy: [],
    comments: [],
    attachments: [],
    ...over,
  };
}

function decision(kind: ActionDecision["kind"]): ActionDecision {
  return { kind, reason: "test", spawns: kind === "draft-plan" || kind === "draft-spec" };
}

function clientStub(): LinearClient {
  return {
    addLabel: vi.fn().mockResolvedValue(undefined),
    addComment: vi.fn().mockResolvedValue({ id: "c1", createdAt: new Date().toISOString() }),
    setState: vi.fn().mockResolvedValue(undefined),
  } as unknown as LinearClient;
}

describe("handleDrafting", () => {
  it("blocks when repo cannot be resolved", async () => {
    const config: PipelineConfig = { linearTeamKey: "KPR", repoPaths: {} };
    const client = clientStub();
    const result = await handleDrafting({
      client,
      ticket: ticket({ description: "no hints here" }),
      decision: decision("draft-plan"),
      config,
      spawn: vi.fn(),
    });
    expect(result.outcome).toBe("blocked");
    expect(client.addLabel).toHaveBeenCalledWith("issue-id", "block:human");
  });

  it("spawns drafting subagent when no draft exists", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "drafting-"));
    try {
      const config: PipelineConfig = { linearTeamKey: "KPR", repoPaths: { repoX: tmp } };
      const client = clientStub();
      const spawn = vi.fn().mockResolvedValue({ agentId: "agent-Z", status: "started" });
      const result = await handleDrafting({
        client,
        ticket: ticket({ description: "fix repoX bug" }),
        decision: decision("draft-plan"),
        config,
        spawn,
      });
      expect(result.outcome).toBe("spawned");
      expect(result.agentId).toBe("agent-Z");
      expect(spawn).toHaveBeenCalledTimes(1);
      const call = (spawn.mock.calls[0] as [{ kind: string; repoPath: string }])[0];
      expect(call.kind).toBe("draft-plan");
      expect(call.repoPath).toBe(tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("blocks when existing draft has open questions", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "drafting-"));
    try {
      mkdirSync(join(tmp, "docs", "plans", "_pending_review"), { recursive: true });
      writeFileSync(
        join(tmp, "docs", "plans", "_pending_review", "kpr-9.md"),
        "# Plan\n\nbody\n\n## Open design questions\n\n### OQ-1: foo\nWhat?\n",
      );
      const config: PipelineConfig = { linearTeamKey: "KPR", repoPaths: { repoX: tmp } };
      const client = clientStub();
      const result = await handleDrafting({
        client,
        ticket: ticket({ description: "do thing in repoX", state: "Plan Drafting" }),
        decision: decision("plan-review"),
        config,
        spawn: vi.fn(),
      });
      expect(result.outcome).toBe("blocked");
      expect(client.addLabel).toHaveBeenCalledWith("issue-id", "block:human");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("transitions when existing draft is review-clean", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "drafting-"));
    try {
      mkdirSync(join(tmp, "docs", "plans", "_pending_review"), { recursive: true });
      writeFileSync(
        join(tmp, "docs", "plans", "_pending_review", "kpr-9.md"),
        "# Plan\n\nbody\n\n## Open design questions\n\nNone — review-clean.\n",
      );
      const config: PipelineConfig = { linearTeamKey: "KPR", repoPaths: { repoX: tmp } };
      const client = clientStub();
      const result = await handleDrafting({
        client,
        ticket: ticket({ description: "do thing in repoX", state: "Plan Drafting" }),
        decision: decision("plan-review"),
        config,
        spawn: vi.fn(),
      });
      expect(result.outcome).toBe("transitioned");
      expect(client.setState).toHaveBeenCalledWith("issue-id", "Ready");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
