import { loadConfig } from "../config.js";
import { resolveInstance } from "../frames/instance-resolver.js";
import { withInstanceDb } from "../frames/mongo-client.js";
import { detectInstanceState, type InstanceState } from "./detect-instance-state.js";

export interface InitStateCliResult {
  exitCode: number;
  state?: InstanceState;
}

/**
 * `beekeeper init-state <instance-id> [--json] [--cos-agent-id <id>]`
 *
 * Prints the result of `detectInstanceState` for the named instance.
 *
 * - With `--json`: emits a JSON object `{state, detail}` (Date fields ISO-8601)
 *   to stdout. The init-instance SKILL playbook parses this from a Bash
 *   subshell to decide which Phase 0 branch to take.
 * - Without `--json`: emits human-readable lines (one per detail field).
 *
 * `--cos-agent-id` overrides the default `chief-of-staff` slug. Phase 0
 * doesn't know the operator's chosen slug yet, so it uses the default; if
 * Phase 4 wants to re-check after the operator chose a custom slug, it can
 * pass the override.
 */
export async function runInitStateCli(args: string[]): Promise<InitStateCliResult> {
  const instanceId = args[0];
  if (!instanceId || instanceId.startsWith("--")) {
    console.error(
      "Usage: beekeeper init-state <instance-id> [--json] [--cos-agent-id <id>]",
    );
    return { exitCode: 2 };
  }

  const json = args.includes("--json");

  let cosAgentId: string | undefined;
  const cosFlagIdx = args.indexOf("--cos-agent-id");
  if (cosFlagIdx !== -1) {
    cosAgentId = args[cosFlagIdx + 1];
    if (!cosAgentId || cosAgentId.startsWith("--")) {
      console.error("Error: --cos-agent-id requires a value");
      return { exitCode: 2 };
    }
  }

  const config = loadConfig();
  const instance = resolveInstance(config, instanceId);

  const result = await withInstanceDb(instance, (db) =>
    detectInstanceState(db, {
      instanceId: instance.id,
      servicePath: instance.servicePath,
      cosAgentId,
    }),
  );

  if (json) {
    console.log(
      JSON.stringify(
        result,
        (_key, value: unknown) =>
          value instanceof Date ? value.toISOString() : value,
        2,
      ),
    );
  } else {
    console.log(`state: ${result.state}`);
    console.log(`  section2Written: ${result.detail.section2Written}`);
    console.log(`  frameApplied: ${result.detail.frameApplied}`);
    console.log(`  cosSeeded: ${result.detail.cosSeeded}`);
    console.log(`  handoffMemoryWritten: ${result.detail.handoffMemoryWritten}`);
    if (result.detail.lastInitRunId !== null) {
      console.log(`  lastInitRunId: ${result.detail.lastInitRunId}`);
    }
    if (result.detail.lastInitAppliedAt !== null) {
      console.log(
        `  lastInitAppliedAt: ${result.detail.lastInitAppliedAt.toISOString()}`,
      );
    }
  }

  return { exitCode: 0, state: result };
}
