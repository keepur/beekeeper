import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../config.js";
import { resolveInstance } from "../instance-resolver.js";
import { withInstanceDb } from "../mongo-client.js";
import { AppliedFramesStore } from "../applied-frames-store.js";
import { DependencyError, PartialApplyError } from "../errors.js";
import { resourceKey } from "../text-utils.js";
import {
  removeConstitutionAnchor,
  removeCoreServers,
  removeMemorySeed,
  removePromptClause,
  removeScheduleEntry,
  removeSkillBundle,
} from "../asset-writer.js";
import type { Db } from "mongodb";
import type { AppliedFrameRecord } from "../types.js";
import type { ResolvedInstance } from "../instance-resolver.js";

export interface RemoveOptions {
  force?: boolean;
}

interface AgentDefDoc {
  _id: string;
  systemPrompt?: string;
}

export async function removeFrame(
  frameName: string,
  instanceId: string,
  opts: RemoveOptions,
): Promise<number> {
  const config = loadConfig();
  const instance = resolveInstance(config, instanceId);

  return await withInstanceDb(instance, (db) =>
    removeFrameWithDb(db, instance, frameName, opts),
  );
}

export async function removeFrameWithDb(
  db: Db,
  instance: ResolvedInstance,
  frameName: string,
  opts: RemoveOptions,
): Promise<number> {
  const store = new AppliedFramesStore(db);
  const dependents = await store.findDependents(frameName);
  if (dependents.length > 0 && !opts.force) {
    throw new DependencyError(frameName, dependents);
  }
  if (dependents.length > 0 && opts.force) {
    process.stderr.write(
      `warn: --force in effect; removing "${frameName}" despite dependents: ${dependents.join(", ")}\n`,
    );
  }

  const record = await store.get(frameName);
  if (!record) {
    console.log(`Frame "${frameName}" is not applied to "${instance.id}". No-op.`);
    return 0;
  }

  const unreversed = await reverseFromSnapshot(db, instance, record);

  if (unreversed.length > 0) {
    throw new PartialApplyError([], unreversed);
  }

  await store.remove(frameName);
  sendSigusr1(instance.servicePath);
  console.log(`Removed frame "${frameName}" from "${instance.id}".`);
  return 0;
}

async function reverseFromSnapshot(
  db: Db,
  instance: ResolvedInstance,
  record: AppliedFrameRecord,
): Promise<string[]> {
  const unreversed: string[] = [];

  // 1. constitution
  const constitution = record.resources.constitution;
  if (constitution) {
    try {
      await removeConstitutionAnchor(db, constitution.snapshotBefore);
    } catch (e) {
      for (const a of constitution.anchors) {
        unreversed.push(`${resourceKey("constitution", a)} (${(e as Error).message})`);
      }
    }
  }

  // 2. prompts
  const prompts = record.resources.prompts;
  if (prompts) {
    const coll = db.collection<AgentDefDoc>("agent_definitions");
    for (const [agentId, block] of Object.entries(prompts)) {
      let currentPrompt = "";
      try {
        const doc = await coll.findOne({ _id: agentId });
        currentPrompt = doc?.systemPrompt ?? "";
      } catch (e) {
        for (const anchor of block.anchors) {
          unreversed.push(
            `${resourceKey("prompts", agentId, anchor)} (${(e as Error).message})`,
          );
        }
        continue;
      }
      for (const anchor of block.anchors) {
        try {
          await removePromptClause(
            db,
            agentId,
            anchor,
            block.insertedText[anchor] ?? "",
            block.snapshotBefore,
            currentPrompt,
          );
        } catch (e) {
          unreversed.push(
            `${resourceKey("prompts", agentId, anchor)} (${(e as Error).message})`,
          );
        }
      }
    }
  }

  // 3. schedule
  const schedule = record.resources.schedule;
  if (schedule) {
    for (const [agentId, entries] of Object.entries(schedule)) {
      for (const entry of entries) {
        try {
          await removeScheduleEntry(db, agentId, entry);
        } catch (e) {
          unreversed.push(
            `${resourceKey("schedule", agentId, entry.task)} (${(e as Error).message})`,
          );
        }
      }
    }
  }

  // 4. coreservers
  const coreservers = record.resources.coreservers;
  if (coreservers && Object.keys(coreservers).length > 0) {
    try {
      await removeCoreServers(db, coreservers);
    } catch (e) {
      for (const [agentId, servers] of Object.entries(coreservers)) {
        for (const server of servers) {
          unreversed.push(
            `${resourceKey("coreservers", agentId, server)} (${(e as Error).message})`,
          );
        }
      }
    }
  }

  // 5. seeds
  for (const seed of record.resources.memorySeeds ?? []) {
    try {
      await removeMemorySeed(db, seed, record._id);
    } catch (e) {
      unreversed.push(
        `${resourceKey("seeds", seed.agent, seed.contentHash)} (${(e as Error).message})`,
      );
    }
  }

  // 6. skills
  for (const skill of record.resources.skills ?? []) {
    try {
      await removeSkillBundle(db, skill, record._id, instance.servicePath);
    } catch (e) {
      unreversed.push(`${resourceKey("skills", skill.bundle)} (${(e as Error).message})`);
    }
  }

  return unreversed;
}

function sendSigusr1(servicePath: string): void {
  const pidPath = join(servicePath, "hive.pid");
  if (!existsSync(pidPath)) return;
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    if (Number.isFinite(pid) && pid > 0) {
      process.kill(pid, "SIGUSR1");
    }
  } catch (e) {
    process.stderr.write(`warn: failed to send SIGUSR1 to hive: ${(e as Error).message}\n`);
  }
}
