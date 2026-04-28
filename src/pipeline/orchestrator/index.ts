import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { ulid } from "ulid";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../../logging/logger.js";
import type { LinearClient } from "../linear-client.js";
import type { OrchestratorConfig } from "../../types.js";
import { PipelineGuardian } from "./pipeline-guardian.js";
import { createAskUserQuestionTrap } from "./ask-user-question-trap.js";
import { consumeMessages } from "./consume-messages.js";
import { StallScanner } from "./stall-scanner.js";
import {
  TicketBusyError,
  type PipelineJob,
  type SpawnInput,
  type SpawnResult,
} from "./types.js";
import type { SubagentKind } from "../subagent-spawn.js";

const log = createLogger("pipeline-orchestrator");

// Same SDK CLI-path workaround SessionManager uses; see comments at the top
// of session-manager.ts. Centralized here so orchestrator picks up the same
// fix.
const sdkRequire = createRequire(import.meta.url);
const claudeCodeCliPath = join(
  dirname(sdkRequire.resolve("@anthropic-ai/claude-agent-sdk")),
  "cli.js",
);

export interface PipelineOrchestratorOptions {
  config: OrchestratorConfig;
  linear: LinearClient;
  /** Resolves human ticket identifier → Linear issue UUID. Orchestrator
   *  caches this on each spawn() call from the input.ticketId; tests inject. */
  resolveIssueId: (ticketId: string) => Promise<string>;
}

const KIND_TO_MODEL_BUCKET: Record<SubagentKind, "drafting" | "review" | "implementer"> = {
  "draft-spec": "drafting",
  "draft-plan": "drafting",
  "code-review": "review",
  "implementer": "implementer",
};

interface ActiveQueryEntry {
  query: Query;
  job: PipelineJob;
}

export class PipelineOrchestrator {
  private jobs = new Map<string, PipelineJob>();
  private activeByTicket = new Map<string, string>(); // ticketId → agentId
  private queries = new Map<string, ActiveQueryEntry>();
  private issueIds = new Map<string, string>(); // ticketId → issueId (cached at spawn)
  private guardian: PipelineGuardian;
  private scanner: StallScanner;
  private opts: PipelineOrchestratorOptions;
  private evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: PipelineOrchestratorOptions) {
    this.opts = opts;
    this.guardian = new PipelineGuardian({ allowlist: PipelineGuardian.compile(opts.config.bashAllowlist) });
    this.scanner = new StallScanner({
      thresholds: opts.config.stallThresholds,
      getActiveJobs: () => Array.from(this.jobs.values()).filter((j) => j.state === "running"),
      linear: opts.linear,
      cancel: (agentId) => this.cancel(agentId),
      resolveIssueId: (ticketId) => this.issueIds.get(ticketId),
    });
  }

  start(): void { this.scanner.start(); }
  stop(): void { this.scanner.stop(); }

  async spawn(input: SpawnInput): Promise<SpawnResult> {
    const existing = this.activeByTicket.get(input.ticketId);
    if (existing && this.jobs.get(existing)?.state === "running") {
      throw new TicketBusyError(input.ticketId, existing);
    }
    const issueId = await this.opts.resolveIssueId(input.ticketId);
    this.issueIds.set(input.ticketId, issueId);

    const agentId = `agent-${ulid()}`;
    const startedAt = new Date().toISOString();
    const job: PipelineJob = {
      agentId,
      ticketId: input.ticketId,
      kind: input.kind,
      cwd: input.repoPath,
      startedAt,
      state: "running",
      lastMessageAt: startedAt,
      messages: [],
    };
    this.jobs.set(agentId, job);
    this.activeByTicket.set(input.ticketId, agentId);

    const askTrap = createAskUserQuestionTrap({
      linear: this.opts.linear,
      ticketIssueId: issueId,
      job,
      onTrap: async () => {
        try {
          const entry = this.queries.get(agentId);
          if (entry) await entry.query.interrupt();
        } catch (err) {
          log.warn("askTrap onTrap interrupt failed", { agentId, error: String(err) });
        }
      },
    });

    const modelBucket = KIND_TO_MODEL_BUCKET[input.kind];
    const model = this.opts.config.pipelineModel[modelBucket];

    const activeQuery = query({
      prompt: input.prompt,
      options: {
        pathToClaudeCodeExecutable: claudeCodeCliPath,
        model,
        permissionMode: "bypassPermissions",
        includePartialMessages: true,
        cwd: input.repoPath,
        hooks: {
          PreToolUse: [
            { hooks: [this.guardian.createHookCallback(agentId)] },
            { hooks: [askTrap] },
          ],
        },
        env: {
          ...process.env,
          PIPELINE_AGENT_ID: agentId,
          PIPELINE_TICKET_ID: input.ticketId,
          PIPELINE_KIND: input.kind,
        },
      },
    });

    this.queries.set(agentId, { query: activeQuery, job });

    // Background consumer — NOT awaited.
    void consumeMessages({
      job,
      activeQuery,
      linear: this.opts.linear,
      ticketIssueId: issueId,
      cancel: () => this.cancel(agentId),
      onTerminal: (j) => this.scheduleEviction(j),
    }).catch((err) => log.error("consumeMessages threw at top level", { agentId, error: String(err) }));

    log.info("Subagent spawned", { agentId, kind: input.kind, ticketId: input.ticketId, model });
    return { agentId, status: "started", ticketId: input.ticketId, startedAt };
  }

  async cancel(agentId: string): Promise<void> {
    const entry = this.queries.get(agentId);
    if (!entry) return;
    const job = entry.job;
    if (!job._terminalReason) {
      job._terminalReason = "interrupted";
      job.cancelRequested = true;
    }
    try {
      await entry.query.interrupt();
    } catch (err) {
      log.warn("cancel: interrupt threw", { agentId, error: String(err) });
    }
  }

  get(agentId: string): PipelineJob | null {
    return this.jobs.get(agentId) ?? null;
  }

  getActiveByTicket(ticketId: string): PipelineJob | null {
    const aid = this.activeByTicket.get(ticketId);
    if (!aid) return null;
    const job = this.jobs.get(aid);
    return job && job.state === "running" ? job : null;
  }

  listActive(): PipelineJob[] {
    return Array.from(this.jobs.values()).filter((j) => j.state === "running");
  }

  /** For startup-recovery wiring — the running agentIds the orchestrator owns. */
  activeAgentIds(): Set<string> {
    return new Set(this.listActive().map((j) => j.agentId));
  }

  private scheduleEviction(job: PipelineJob): void {
    // Drop active-by-ticket binding immediately (frees the ticket for re-spawn).
    if (this.activeByTicket.get(job.ticketId) === job.agentId) {
      this.activeByTicket.delete(job.ticketId);
    }
    // TTL-evict the job descriptor itself (so GET /admin/pipeline/jobs/:id can
    // continue serving recently-completed jobs for a window).
    const t = setTimeout(() => {
      this.jobs.delete(job.agentId);
      this.queries.delete(job.agentId);
      this.evictionTimers.delete(job.agentId);
    }, this.opts.config.jobTtlMs);
    // Allow process exit when only eviction timers remain.
    if (typeof t.unref === "function") t.unref();
    this.evictionTimers.set(job.agentId, t);
  }

  /** Stop all active jobs (used on server shutdown). */
  async stopAll(): Promise<void> {
    this.stop();
    const ids = Array.from(this.queries.keys());
    for (const id of ids) {
      try { await this.cancel(id); } catch { /* ignore */ }
    }
  }
}
