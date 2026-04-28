import { resolveBeekeeperSecret } from "./honeypot-reader.js";
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
  /** Phase 2 keeps the same shape: tick does not wait. */
  status: "started";
}

export class BeekeeperServerNotRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BeekeeperServerNotRunningError";
  }
}

const DEFAULT_PORT = 8420;

/**
 * Phase 2: thin HTTP client to the in-server PipelineOrchestrator. The CLI
 * runs on the same machine as the server (Mac Mini); fetch is loopback-only.
 *
 * No fallback to Phase 1's detached spawn — Phase 1's observability gaps are
 * exactly what this work exists to close.
 */
export async function spawnSubagent(input: SpawnInput): Promise<SpawnResult> {
  const port = Number(process.env.BEEKEEPER_PORT ?? DEFAULT_PORT);
  const adminSecret = resolveBeekeeperSecret("BEEKEEPER_ADMIN_SECRET");
  if (!adminSecret) {
    throw new Error(
      "BEEKEEPER_ADMIN_SECRET not resolvable (set in env or via `honeypot set beekeeper/BEEKEEPER_ADMIN_SECRET <value>`)",
    );
  }

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/admin/pipeline/jobs`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${adminSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });
  } catch (err) {
    // ECONNREFUSED, network unreachable, etc. — translate to actionable diagnostic.
    throw new BeekeeperServerNotRunningError(
      `Cannot reach Beekeeper server at http://127.0.0.1:${port}.\n\n` +
      "Pipeline-tick Phase 2 runs orchestration in-server. Start the server first:\n" +
      "  - On your Mac (LaunchAgent installed): launchctl kickstart -k gui/$(id -u)/com.keepur.beekeeper\n" +
      "  - Foreground/dev: beekeeper serve\n\n" +
      `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (response.status === 409) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; existingAgentId?: string };
    throw new Error(
      `Ticket ${input.ticketId} already has running subagent ${body.existingAgentId ?? "(unknown)"} — concurrent spawn refused`,
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Spawn failed: ${response.status} ${text}`);
  }
  const result = (await response.json()) as { agentId: string; status: "started" };
  log.info("Subagent spawn POSTed to orchestrator", {
    agentId: result.agentId,
    kind: input.kind,
    ticketId: input.ticketId,
    repoPath: input.repoPath,
  });
  return { agentId: result.agentId, status: result.status };
}
