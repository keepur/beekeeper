import { loadConfig } from "../../config.js";
import { resolveInstance } from "../instance-resolver.js";
import { withInstanceDb } from "../mongo-client.js";
import { AppliedFramesStore } from "../applied-frames-store.js";

export async function listFrames(instanceId: string): Promise<void> {
  const config = loadConfig();
  const instance = resolveInstance(config, instanceId);

  await withInstanceDb(instance, async (db) => {
    const store = new AppliedFramesStore(db);
    const records = await store.list();
    if (records.length === 0) {
      console.log(`No frames applied to "${instanceId}".`);
      return;
    }
    console.log(`Applied frames on "${instanceId}":`);
    for (const r of records) {
      const drift = (r.driftAccepted?.length ?? 0) > 0 ? ` (${r.driftAccepted!.length} drift accepted)` : "";
      console.log(`  ${r._id}  ${r.version}  applied=${r.appliedAt.toISOString()}  by=${r.appliedBy}${drift}`);
    }
  });
}
