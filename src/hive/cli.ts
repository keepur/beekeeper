/**
 * Dispatcher for `beekeeper hive <subcommand>`. Lives in its own module so
 * src/cli.ts stays a thin top-level switch. Parses a small CLI here:
 *
 *   beekeeper hive setup [--force]
 *   beekeeper hive list  [--json]
 *
 * Returns a numeric exit code; src/cli.ts propagates it via process.exit.
 */

import { renderTable } from "../cli/admin-client.js";
import { discoverHiveInstances, type HiveInstance } from "./discover.js";
import { setup, type LifecycleEnv } from "./lifecycle.js";

export interface HiveCliDeps {
  /** Lets tests inject a stub discoverer; defaults to the real one. */
  discover?: () => HiveInstance[];
  /** Pass-through to setup() for tests that want a fake LifecycleEnv. */
  lifecycleEnv?: LifecycleEnv;
}

export async function runHiveCli(argv: string[], deps: HiveCliDeps = {}): Promise<number> {
  const sub = argv[0];
  const discover = deps.discover ?? (() => discoverHiveInstances());

  if (sub === "setup") {
    const force = argv.includes("--force");
    await setup({ force }, deps.lifecycleEnv);
    return 0;
  }

  if (sub === "list") {
    const json = argv.includes("--json");
    const instances = discover();
    if (json) {
      console.log(JSON.stringify(instances, null, 2));
      return 0;
    }
    if (instances.length === 0) {
      console.log("(no hive instances installed at ~/services/hive — try `beekeeper hive setup`)");
      return 0;
    }
    console.log(renderInstancesTable(instances));
    return 0;
  }

  console.error("Usage:");
  console.error("  beekeeper hive setup [--force]   Guided installer (downloads hive, opens Claude Code)");
  console.error("  beekeeper hive list  [--json]    Enumerate installed hive instances");
  return 1;
}

export function renderInstancesTable(instances: HiveInstance[]): string {
  return renderTable(
    ["INSTANCE", "VERSION", "RUNNING", "PORT", "PATH"],
    instances.map((i) => [
      i.id,
      i.version ?? "incomplete",
      i.running === null ? "?" : i.running ? "yes" : "no",
      i.port === null ? "—" : String(i.port),
      i.path,
    ]),
  );
}
