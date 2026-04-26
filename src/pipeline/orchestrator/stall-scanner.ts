import { createLogger } from "../../logging/logger.js";
import type { LinearClient } from "../linear-client.js";
import type { PipelineJob } from "./types.js";
import type { OrchestratorStallThresholds } from "../../types.js";
import type { SubagentKind } from "../subagent-spawn.js";

const log = createLogger("pipeline-stall");

export interface StallScannerOptions {
  thresholds: OrchestratorStallThresholds;
  /** Active jobs accessor (orchestrator's job map filtered to running). */
  getActiveJobs: () => PipelineJob[];
  linear: LinearClient;
  /** Cancel hook (orchestrator.cancel) for the hard tier. */
  cancel: (agentId: string) => Promise<void>;
  /** ms — the interval cadence (default 30000). */
  intervalMs?: number;
  /** Map ticketId → linear issue UUID (orchestrator builds this on spawn). */
  resolveIssueId: (ticketId: string) => string | undefined;
  /** Now() injection for tests. */
  now?: () => number;
}

const KIND_TO_BUCKET: Record<SubagentKind, "drafting" | "review" | "implementer"> = {
  "draft-spec": "drafting",
  "draft-plan": "drafting",
  "code-review": "review",
  "implementer": "implementer",
};

export class StallScanner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private opts: Required<StallScannerOptions>;

  constructor(opts: StallScannerOptions) {
    this.opts = {
      intervalMs: 30_000,
      now: () => Date.now(),
      ...opts,
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.scan().catch((err) => log.error("scan() threw", { error: String(err) }));
    }, this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Public for testability. */
  async scan(): Promise<void> {
    const now = this.opts.now();
    for (const job of this.opts.getActiveJobs()) {
      if (job.state !== "running") continue;
      const lastMs = new Date(job.lastMessageAt).getTime();
      const idle = now - lastMs;
      const bucket = KIND_TO_BUCKET[job.kind];
      const t = this.opts.thresholds[bucket];
      const issueId = this.opts.resolveIssueId(job.ticketId);
      if (!issueId) {
        log.warn("stall-scan: cannot resolve issueId", { ticketId: job.ticketId });
        continue;
      }
      if (idle >= t.hard) {
        // Hard tier: cancel + block:human.
        if (!job._terminalReason) {
          job._terminalReason = "stalled-timeout";
          job.cancelRequested = true;
          try {
            await this.opts.linear.addComment(
              issueId,
              `pipeline-tick: subagent ${job.agentId} stalled (no messages for ${Math.round(idle / 60_000)}min); cancelling and flagging block:human`,
            );
            await this.opts.linear.addLabel(issueId, "block:human");
          } catch (err) {
            log.error("hard-stall Linear write failed", { agentId: job.agentId, error: String(err) });
          }
          try {
            await this.opts.cancel(job.agentId);
          } catch (err) {
            log.error("hard-stall cancel failed", { agentId: job.agentId, error: String(err) });
          }
        }
        continue;
      }
      if (idle >= t.soft) {
        // Soft tier: warn-only, idempotent. Emit only if softWarnedAt is unset
        // (consumeMessages clears it on every fresh msg, so a flapping subagent
        // earns one warning per fresh quiet period).
        if (!job.softWarnedAt) {
          job.softWarnedAt = new Date(now).toISOString();
          try {
            await this.opts.linear.addComment(
              issueId,
              `pipeline-tick: subagent ${job.agentId} has been quiet for ${Math.round(idle / 60_000)}min, monitoring`,
            );
          } catch (err) {
            log.error("soft-stall Linear write failed", { agentId: job.agentId, error: String(err) });
          }
        }
      }
    }
  }
}
