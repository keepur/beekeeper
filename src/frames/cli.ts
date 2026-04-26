import { listFrames } from "./commands/list.js";

export async function runFrameCli(args: string[]): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case "audit": {
      const instanceId = args[1];
      if (!instanceId) {
        console.error("Usage: beekeeper frame audit <instance>");
        return 1;
      }
      const { auditInstance } = await import("./commands/audit.js");
      return await auditInstance(instanceId);
    }
    case "list": {
      const instanceId = args[1];
      if (!instanceId) {
        console.error("Usage: beekeeper frame list <instance>");
        return 1;
      }
      await listFrames(instanceId);
      return 0;
    }
    case undefined:
    case "--help":
    case "-h":
    case "help": {
      printUsage();
      return 0;
    }
    default: {
      console.error(`Unknown frame subcommand: ${sub}`);
      printUsage();
      return 1;
    }
  }
}

function printUsage(): void {
  console.log(`Usage: beekeeper frame <subcommand>

Subcommands:
  list   <instance>                  List frames applied to an instance
  audit  <instance>                  Audit instance for drift (read-only)
  apply  <frame> <instance> [flags]  Apply a frame; --adopt for record-only

Examples:
  beekeeper frame list dodi
  beekeeper frame audit dodi
  beekeeper frame apply ~/.beekeeper/frames/hive-baseline dodi --adopt
`);
}
