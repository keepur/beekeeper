import { existsSync, statSync } from "node:fs";
import type { BeekeeperConfig, InstanceConfig } from "../types.js";
import { InstanceNotFoundError } from "./errors.js";

export interface ResolvedInstance {
  id: string;
  servicePath: string;
  mongoUri: string;
  dbName: string;
}

/**
 * Resolve an instance id to its full config. Applies defaults where needed.
 * Throws InstanceNotFoundError if the id is not in the config.
 */
export function resolveInstance(config: BeekeeperConfig, instanceId: string): ResolvedInstance {
  const instances = config.instances ?? {};
  const entry: InstanceConfig | undefined = instances[instanceId];
  if (!entry) throw new InstanceNotFoundError(instanceId);

  if (!existsSync(entry.servicePath) || !statSync(entry.servicePath).isDirectory()) {
    throw new Error(
      `Instance "${instanceId}" servicePath does not exist or is not a directory: ${entry.servicePath}`,
    );
  }

  return {
    id: instanceId,
    servicePath: entry.servicePath,
    mongoUri: entry.mongoUri ?? "mongodb://localhost:27017",
    dbName: entry.dbName ?? `hive_${instanceId}`,
  };
}
