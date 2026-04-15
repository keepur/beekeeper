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
              "Warning: all of their devices' tokens are now invalid — they'll need to re-pair if reactivated.",
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
  case "migrate": {
    const flag = process.argv[3];
    if (flag !== "--from-mongo") {
      console.error("Usage: beekeeper migrate --from-mongo");
      console.error("\nExports devices from MongoDB beekeeper_devices collection to SQLite.");
      console.error("Requires: MONGO_URI env var set to your MongoDB connection string.");
      process.exit(1);
    }
    const mongoUri = process.env.MONGO_URI;
    if (!mongoUri) {
      console.error("MONGO_URI env var is required for migration.");
      process.exit(1);
    }
    try {
      // @ts-ignore — mongodb is optional, only imported at runtime
      const { MongoClient } = await import("mongodb");
      const Database = (await import("better-sqlite3")).default;
      const { loadConfig } = await import("./config.js");
      const { mkdirSync } = await import("node:fs");
      const config = loadConfig();
      const dbPath = join(config.dataDir, "devices.db");
      mkdirSync(config.dataDir, { recursive: true });

      // Read from MongoDB
      const mongo = new MongoClient(mongoUri);
      await mongo.connect();
      const collection = mongo.db("hive").collection("beekeeper_devices");
      // @ts-ignore
      const docs = await collection.find({}).toArray();

      // Write to SQLite (direct DB access — pairing codes are ephemeral, skip encryption)
      const db = new Database(dbPath);
      db.pragma("journal_mode = WAL");
      db.exec(`CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER DEFAULT 1,
        created_at TEXT NOT NULL, paired_at TEXT, last_seen TEXT NOT NULL,
        pairing_code TEXT, pairing_code_exp TEXT
      )`);

      const insert = db.prepare(
        `INSERT OR IGNORE INTO devices (id, name, active, created_at, paired_at, last_seen)
         VALUES (@id, @name, @active, @created_at, @paired_at, @last_seen)`
      );

      let migrated = 0;
      for (const doc of docs) {
        insert.run({
          id: doc._id,
          name: doc.name,
          active: doc.active ? 1 : 0,
          created_at: doc.createdAt?.toISOString() ?? new Date().toISOString(),
          paired_at: doc.pairedAt?.toISOString() ?? null,
          last_seen: doc.lastSeenAt?.toISOString() ?? new Date().toISOString(),
        });
        console.log(`  Migrated device: ${doc.name} (${doc._id})`);
        migrated++;
      }

      db.close();
      await mongo.close();
      console.log(`\nMigrated ${migrated} devices from MongoDB to ${dbPath}`);
      console.log("Note: Pairing codes were not migrated (ephemeral). Use POST /devices/:id/refresh-code to re-pair.");
      console.log("Verify with: beekeeper (start server, check GET /devices)");
    } catch (err: any) {
      if (err.code === "MODULE_NOT_FOUND" || err.code === "ERR_MODULE_NOT_FOUND") {
        console.error("mongodb package not installed. Run: npm install mongodb");
        console.error("\nAlternative: manual migration (see below).");
        console.error("1. Export from MongoDB: mongoexport --db=hive --collection=beekeeper_devices --jsonArray --out=devices.json");
        console.error("2. For each device, use the admin API: POST /devices { name: '...' }");
        console.error("3. Re-pair each device with the new pairing codes.");
      } else {
        console.error("Migration failed:", err.message);
      }
      process.exit(1);
    }
    break;
  }
  default:
    // No command — start the server
    await import("./index.js");
}
