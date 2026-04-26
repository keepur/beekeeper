import { listFrames } from "./commands/list.js";

export async function runFrameCli(args: string[]): Promise<number> {
  const sub = args[0];
  switch (sub) {
    case "apply": {
      const framePath = args[1];
      const instanceId = args[2];
      if (!framePath || !instanceId) {
        console.error(
          "Usage: beekeeper frame apply <framePath> <instance> [--adopt] [--force-override] [--allow-seed-override] [--yes]",
        );
        return 1;
      }
      const flags = args.slice(3);
      const adopt = flags.includes("--adopt");
      const forceOverride = flags.includes("--force-override");
      const allowSeedOverride = flags.includes("--allow-seed-override");
      const yes = flags.includes("--yes");
      const { applyFrame } = await import("./commands/apply.js");
      return await applyFrame(framePath, instanceId, {
        adopt,
        forceOverride,
        allowSeedOverride,
        yes,
      });
    }
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
  apply  <frame> <instance> [flags]  Apply a frame
                                     Flags:
                                       --adopt              record current state as conformant (no writes)
                                       --force-override     replace conflicting peer claims (skills, schedule)
                                       --allow-seed-override insert a memory seed despite a peer claim
                                       --yes                non-interactive: auto-accept hooks + drift dialog (take-frame)

Examples:
  beekeeper frame list dodi
  beekeeper frame audit dodi
  beekeeper frame apply ~/.beekeeper/frames/hive-baseline dodi --adopt
  beekeeper frame apply ~/.beekeeper/frames/hive-baseline dodi --yes
`);
}
