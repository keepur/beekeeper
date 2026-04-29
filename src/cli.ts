#!/usr/bin/env node
import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const command = process.argv[2];

function printHelp(): void {
  console.log(`beekeeper — operator CLI for the Beekeeper gateway

USAGE
  beekeeper <command> [args]

SERVICE
  install [<configDir>]      Install the LaunchAgent (~/.beekeeper by default)
  uninstall                  Remove the LaunchAgent
  serve                      Run the gateway in the foreground (dev only)

USERS & DEVICES
  user list                  List registered users
  user add <id> <display>    Add a user
  user rm <id>               Deactivate a user
  pair <user> [label]        Issue a pairing code for a device

INSTANCES
  frame <subcommand>         Manage instance frames (apply / render / etc.)
  init-state <instance>      Detect a Hive instance's init state

PIPELINE
  pipeline-tick <scope>      Run a Linear pipeline tick

OTHER
  help                       Show this help
  version                    Show the installed version

The gateway runs as a macOS LaunchAgent (io.keepur.beekeeperd). It is started
by launchd, not by this CLI. To run it in the foreground for development, use
\`beekeeper serve\`.`);
}

function printVersion(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(here, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  console.log(pkg.version ?? "unknown");
}

if (command === undefined || command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

if (command === "version" || command === "--version" || command === "-v") {
  printVersion();
  process.exit(0);
}

switch (command) {
  case "install": {
    const configDir = process.argv[3];
    const { install } = await import("./service/generate-plist.js");
    install(configDir);
    break;
  }
  case "uninstall": {
    const { uninstall } = await import("./service/generate-plist.js");
    uninstall();
    break;
  }
  case "pair": {
    const userId = (process.argv[3] ?? "").trim();
    const label = process.argv.slice(4).join(" ").trim() || "Unnamed device";
    if (!userId) {
      console.error("Usage: beekeeper pair <user> [label]");
      process.exit(1);
    }
    let deviceRegistry: import("./device-registry.js").DeviceRegistry | undefined;
    let pairExitCode = 0;
    try {
      const { loadConfig } = await import("./config.js");
      const { DeviceRegistry } = await import("./device-registry.js");
      const config = loadConfig();
      const dbPath = join(config.dataDir, "devices.db");
      deviceRegistry = new DeviceRegistry(dbPath, config.jwtSecret, config.dataDir);
      deviceRegistry.open();
      const user = deviceRegistry.getUser(userId);
      if (!user || !user.active) {
        console.error(`unknown user "${userId}"`);
        console.error("");
        console.error("List known users:   beekeeper user list");
        console.error("Add a new user:     beekeeper user add <id> <display>");
        pairExitCode = 1;
      } else {
        const device = deviceRegistry.createDevice(user.id, label);
        console.log(`Created device for user: ${user.id}`);
        console.log(`Device ID:  ${device._id}`);
        console.log(`Label:      ${device.label}`);
        console.log(`Pair code:  ${device.pairingCode}`);
        console.log(`Expires in: 10 minutes`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`beekeeper pair failed: ${msg}`);
      pairExitCode = 1;
    } finally {
      try {
        deviceRegistry?.close();
      } catch {
        // ignore close errors
      }
    }
    if (pairExitCode) process.exit(pairExitCode);
    break;
  }
  case "user": {
    const sub = process.argv[3];
    let deviceRegistry: import("./device-registry.js").DeviceRegistry | undefined;
    let userExit = 0;
    try {
      const { loadConfig } = await import("./config.js");
      const { DeviceRegistry } = await import("./device-registry.js");
      const config = loadConfig();
      const dbPath = join(config.dataDir, "devices.db");
      deviceRegistry = new DeviceRegistry(dbPath, config.jwtSecret, config.dataDir);
      deviceRegistry.open();
      if (sub === "add") {
        const id = (process.argv[4] ?? "").trim();
        const display = process.argv.slice(5).join(" ").trim();
        if (!id || !display) {
          console.error("Usage: beekeeper user add <id> <display>");
          userExit = 1;
        } else {
          const user = deviceRegistry.addUser(id, display);
          console.log(`Added user: ${user.id} (${user.display})`);
        }
      } else if (sub === "list") {
        const users = deviceRegistry.listUsers();
        if (users.length === 0) {
          console.log("(no users — add one with: beekeeper user add <id> <display>)");
        } else {
          for (const u of users) {
            console.log(`${u.id}\t${u.display}\t[${u.active ? "active" : "inactive"}]`);
          }
        }
      } else if (sub === "rm") {
        const id = (process.argv[4] ?? "").trim();
        if (!id) {
          console.error("Usage: beekeeper user rm <id>");
          userExit = 1;
        } else {
          const ok = deviceRegistry.removeUser(id);
          if (!ok) {
            console.error(`User not found or already inactive: ${id}`);
            userExit = 1;
          } else {
            console.log(`Removed user: ${id}`);
            console.log(
              "Their devices' tokens are rejected while the user is inactive. Re-running `beekeeper user add` with the same id reactivates the user and their existing tokens resume working.",
            );
          }
        }
      } else {
        console.error("Usage: beekeeper user <add|list|rm> [args]");
        console.error("  beekeeper user add <id> <display>");
        console.error("  beekeeper user list");
        console.error("  beekeeper user rm <id>");
        userExit = 1;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`beekeeper user failed: ${msg}`);
      userExit = 1;
    } finally {
      try {
        deviceRegistry?.close();
      } catch {
        // ignore close errors
      }
    }
    if (userExit) process.exit(userExit);
    break;
  }
  case "frame": {
    let frameExit = 0;
    try {
      const { runFrameCli } = await import("./frames/cli.js");
      frameExit = await runFrameCli(process.argv.slice(3));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`beekeeper frame failed: ${msg}`);
      frameExit = 1;
    }
    if (frameExit) process.exit(frameExit);
    break;
  }
  case "init-state": {
    let initStateExit = 0;
    try {
      const { runInitStateCli } = await import("./init/cli.js");
      const result = await runInitStateCli(process.argv.slice(3));
      initStateExit = result.exitCode;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`beekeeper init-state failed: ${msg}`);
      initStateExit = 1;
    }
    if (initStateExit) process.exit(initStateExit);
    break;
  }
  case "pipeline-tick": {
    const { loadConfig } = await import("./config.js");
    const { runPipelineCli } = await import("./pipeline/cli.js");
    const { resolveBeekeeperSecret } = await import("./pipeline/honeypot-reader.js");
    const config = loadConfig();
    const result = await runPipelineCli({
      argv: process.argv.slice(3),
      config: config.pipeline,
      apiKey: resolveBeekeeperSecret("LINEAR_API_KEY"),
    });
    for (const line of result.output) console.log(line);
    for (const line of result.errors) console.error(line);
    if (result.exitCode) process.exit(result.exitCode);
    break;
  }
  case "serve": {
    // Foreground daemon — for dev only. launchd uses dist/index.js directly.
    await import("./index.js");
    break;
  }
  default: {
    console.error(`Unknown command: ${command}`);
    console.error("");
    printHelp();
    process.exit(1);
  }
}
