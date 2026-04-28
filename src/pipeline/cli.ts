import { runTick, type RunTickOptions } from "./tick-runner.js";
import type { TickReport } from "./types.js";
import type { PipelineConfig } from "../types.js";
import { resolveBeekeeperSecret } from "./honeypot-reader.js";

export interface PipelineCliInputs {
  argv: string[];
  config: PipelineConfig | undefined;
  apiKey: string | undefined;
}

export interface PipelineCliResult {
  exitCode: number;
  report?: TickReport;
  /** Lines to print to stdout (for slash-command callers). */
  output: string[];
  /** Lines to print to stderr (for human errors). */
  errors: string[];
}

const DEFAULTS = { spawnBudget: 3, actionBudget: 25 } as const;

/**
 * Pure entry point — parses argv, validates env+config, runs the tick, and
 * returns a structured result. The CLI wrapper (called from `src/cli.ts`)
 * prints+exits; the slash-command wrapper formats the same data into a
 * single message. Both surfaces share this function so behavior stays
 * consistent.
 */
export async function runPipelineCli(inputs: PipelineCliInputs): Promise<PipelineCliResult> {
  const out: string[] = [];
  const err: string[] = [];

  if (!inputs.config) {
    err.push("pipeline-tick: missing `pipeline:` block in beekeeper.yaml");
    return { exitCode: 1, output: out, errors: err };
  }
  // tail / cancel don't need LINEAR_API_KEY (they only talk to the loopback server).
  const sub = inputs.argv[0];
  if (sub === "tail" || sub === "cancel") {
    return runOrchestratorClient(sub, inputs.argv.slice(1));
  }
  if (!inputs.apiKey) {
    err.push("pipeline-tick: missing LINEAR_API_KEY (set in env or via `honeypot set beekeeper/LINEAR_API_KEY <value>`)");
    return { exitCode: 1, output: out, errors: err };
  }

  const parsed = parseArgs(inputs.argv);
  if (parsed.error) {
    err.push(parsed.error);
    err.push("Usage:");
    err.push("  beekeeper pipeline-tick <scope> [--dry-run] [--include-blocked] [--spawn-budget N] [--action-budget N]");
    err.push("  beekeeper pipeline-tick tail <agentId>");
    err.push("  beekeeper pipeline-tick cancel <agentId>");
    return { exitCode: 1, output: out, errors: err };
  }

  const opts: RunTickOptions = {
    scope: parsed.scope,
    dryRun: parsed.dryRun,
    spawnBudget: parsed.spawnBudget ?? DEFAULTS.spawnBudget,
    actionBudget: parsed.actionBudget ?? DEFAULTS.actionBudget,
    includeBlocked: parsed.includeBlocked,
    config: inputs.config,
    apiKey: inputs.apiKey,
  };

  let report: TickReport;
  try {
    report = await runTick(opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err.push(`pipeline-tick: infra failure: ${msg}`);
    return { exitCode: 1, output: out, errors: err };
  }

  out.push(formatReport(report));
  return { exitCode: 0, report, output: out, errors: err };
}

interface ParsedArgs {
  scope: string;
  dryRun: boolean;
  includeBlocked: boolean;
  spawnBudget?: number;
  actionBudget?: number;
  error?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let scope: string | undefined;
  let dryRun = false;
  let includeBlocked = false;
  let spawnBudget: number | undefined;
  let actionBudget: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--include-blocked") includeBlocked = true;
    else if (a === "--all") scope = "--all";
    else if (a === "--spawn-budget") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) return errOut(`--spawn-budget expects a non-negative integer`);
      spawnBudget = v;
    } else if (a === "--action-budget") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0) return errOut(`--action-budget expects a non-negative integer`);
      actionBudget = v;
    } else if (a.startsWith("--")) {
      return errOut(`unknown flag: ${a}`);
    } else if (!scope) {
      scope = a;
    } else {
      return errOut(`unexpected positional: ${a}`);
    }
  }

  if (!scope) return errOut("scope required (e.g., KPR-90 or --all)");
  return { scope, dryRun, includeBlocked, spawnBudget, actionBudget };
}

function errOut(msg: string): ParsedArgs {
  return { scope: "", dryRun: false, includeBlocked: false, error: msg };
}

export function formatReport(report: TickReport): string {
  const lines: string[] = [];
  lines.push(`pipeline-tick runId=${report.runId} scope=${report.scope}`);
  for (const e of report.entries) {
    lines.push(`  ${e.ticket}\t${e.decision.kind}\t${e.outcome}${e.detail ? `\t(${e.detail})` : ""}`);
  }
  if (report.blocked.length > 0) {
    lines.push("blocked:");
    for (const e of report.blocked) {
      lines.push(`  ${e.ticket}\t${e.decision.reason}`);
    }
  }
  const b = report.budget;
  lines.push(`budget: spawn ${b.spawnUsed}/${b.spawnLimit}  action ${b.actionUsed}/${b.actionLimit}`);
  return lines.join("\n");
}

async function runOrchestratorClient(
  sub: "tail" | "cancel",
  args: string[],
): Promise<PipelineCliResult> {
  const out: string[] = [];
  const err: string[] = [];
  const agentId = args[0];
  if (!agentId) {
    err.push(`Usage: beekeeper pipeline-tick ${sub} <agentId>`);
    return { exitCode: 1, output: out, errors: err };
  }
  const port = Number(process.env.BEEKEEPER_PORT ?? 8420);
  const secret = resolveBeekeeperSecret("BEEKEEPER_ADMIN_SECRET");
  if (!secret) {
    err.push("BEEKEEPER_ADMIN_SECRET not resolvable");
    return { exitCode: 1, output: out, errors: err };
  }
  const headers = { "Authorization": `Bearer ${secret}` };

  if (sub === "cancel") {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/admin/pipeline/jobs/${agentId}/cancel`, { method: "POST", headers });
      if (res.status === 404) { err.push(`unknown agentId: ${agentId}`); return { exitCode: 1, output: out, errors: err }; }
      if (!res.ok) { err.push(`cancel failed: ${res.status}`); return { exitCode: 1, output: out, errors: err }; }
      out.push(`cancelled ${agentId}`);
      return { exitCode: 0, output: out, errors: err };
    } catch (e) {
      err.push(`Beekeeper server unreachable: ${e instanceof Error ? e.message : String(e)}`);
      return { exitCode: 1, output: out, errors: err };
    }
  }

  // tail — poll at 1s cadence; print every NEW message tail (cursor is messages.length).
  let cursor = 0;
  while (true) {
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${port}/admin/pipeline/jobs/${agentId}`, { headers });
    } catch (e) {
      err.push(`server unreachable: ${e instanceof Error ? e.message : String(e)}`);
      return { exitCode: 1, output: out, errors: err };
    }
    if (res.status === 404) { err.push(`unknown agentId: ${agentId}`); return { exitCode: 1, output: out, errors: err }; }
    if (!res.ok) { err.push(`fetch failed: ${res.status}`); return { exitCode: 1, output: out, errors: err }; }
    const job = (await res.json()) as { state: string; messages: Array<{ type: string; receivedAt: string }> };
    while (cursor < job.messages.length) {
      const m = job.messages[cursor++];
      out.push(`[${m.receivedAt}] ${m.type}`);
    }
    if (job.state !== "running") {
      out.push(`-- ${agentId} state=${job.state} --`);
      return { exitCode: 0, output: out, errors: err };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
