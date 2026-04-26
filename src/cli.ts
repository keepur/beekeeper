#!/usr/bin/env node
import "dotenv/config";
import { join } from "node:path";

const command = process.argv[2];

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
  default:
    // No command — start the server
    await import("./index.js");
}
