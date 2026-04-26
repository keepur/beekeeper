import { spawn } from "node:child_process";
import { ulid } from "ulid";
import { createLogger } from "../logging/logger.js";

const log = createLogger("pipeline-spawn");

export type SubagentKind = "draft-spec" | "draft-plan" | "code-review" | "implementer";

export interface SpawnInput {
  kind: SubagentKind;
  prompt: string;
  /** Working directory the subagent runs in (resolved repo path). */
  repoPath: string;
  /** For audit logging on the Linear ticket. */
  ticketId: string;
}

export interface SpawnResult {
  agentId: string;
  /** Phase 1: always "started". Tick does not wait. */
  status: "started";
}

/**
 * Per OQ-1: detached `claude` CLI children. The tick CLI exits immediately;
 * each subagent runs to completion in the background and writes its result
 * back to Linear via the inherited `LINEAR_API_KEY`. `child.unref()` so the
 * parent can exit without waiting.
 *
 * `claude -p <prompt>` is the documented non-interactive (print) mode; tools
 * are still permitted, so the subagent can read/write files, call `git`,
 * `gh`, and similar. The subagent is responsible for posting its own audit
 * comments on the ticket.
 *
 * NOTE: This is the lone documented exception to the "no execFile-on-shell"
 * convention. The arg array is still strictly `[binary, ...args]` form — no
 * shell-string concatenation.
 */
export async function spawnSubagent(input: SpawnInput): Promise<SpawnResult> {
  const agentId = `agent-${ulid()}`;
  const args = ["-p", input.prompt];
  const child = spawn("claude", args, {
    cwd: input.repoPath,
    env: {
      ...process.env,
      PIPELINE_AGENT_ID: agentId,
      PIPELINE_TICKET_ID: input.ticketId,
      PIPELINE_KIND: input.kind,
    },
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();
  log.info("Subagent launched", {
    agentId,
    kind: input.kind,
    ticketId: input.ticketId,
    repoPath: input.repoPath,
    pid: child.pid,
  });
  return { agentId, status: "started" };
}
