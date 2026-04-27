import { describe, it, expect } from "vitest";
import type { Db } from "mongodb";
import { removeFrameWithDb } from "./remove.js";
import { DependencyError } from "../errors.js";
import type { ResolvedInstance } from "../instance-resolver.js";

interface FakeStore {
  dependents: string[];
  records: Record<string, unknown>;
}

function makeDb(state: FakeStore): Db {
  const coll = {
    find: (q: Record<string, unknown>) => {
      // findDependents query: { "manifest.requires": name }
      if (q && "manifest.requires" in q) {
        return {
          toArray: async () =>
            state.dependents.map((d) => ({ _id: d })),
          project: () => ({
            toArray: async () => state.dependents.map((d) => ({ _id: d })),
          }),
        };
      }
      // Generic find for sort/list — not used here.
      return {
        toArray: async () => [],
        sort: () => ({ toArray: async () => [] }),
      };
    },
    findOne: async (q: Record<string, unknown>) => {
      const id = (q as { _id?: string })._id;
      if (id && state.records[id]) return state.records[id];
      return null;
    },
    deleteOne: async () => ({ deletedCount: 1 }),
    updateOne: async () => ({ matchedCount: 1, modifiedCount: 1 }),
    replaceOne: async () => ({ matchedCount: 1, modifiedCount: 1 }),
  };
  // Mongo driver's find().toArray() with projection inside the same chain — store uses
  // .find({...}, { projection: {...} }) which yields the cursor directly.
  const collection = (): unknown => coll;
  return { collection } as unknown as Db;
}

const instance: ResolvedInstance = {
  id: "test",
  servicePath: "/tmp/nonexistent-service-path",
  mongoUri: "mongodb://localhost:27017",
  dbName: "hive_test",
};

describe("removeFrame dependents check", () => {
  it("throws DependencyError when findDependents returns non-empty and force is false", async () => {
    const db = makeDb({ dependents: ["dependent-frame"], records: {} });
    await expect(
      removeFrameWithDb(db, instance, "target", { force: false }),
    ).rejects.toThrow(DependencyError);
  });

  it("proceeds past dependents check when force is true", async () => {
    // No record present — we expect a no-op (return 0), confirming the dependents
    // gate did not trip. Either way, the thrown error (if any) must NOT be DependencyError.
    const db = makeDb({ dependents: ["dependent-frame"], records: {} });
    let threw: unknown;
    let result: number | undefined;
    try {
      result = await removeFrameWithDb(db, instance, "target", { force: true });
    } catch (e) {
      threw = e;
    }
    expect(threw).not.toBeInstanceOf(DependencyError);
    // With force=true and no record, the function should return 0 (no-op log).
    expect(result).toBe(0);
  });
});
