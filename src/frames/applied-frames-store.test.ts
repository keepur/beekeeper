import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { AppliedFramesStore } from "./applied-frames-store.js";
import type { AppliedFrameRecord } from "./types.js";

// Guard skips the suite cleanly when the env var is unset (no live MongoDB).
// Inside the suite we still need a real URI; default to localhost when present.
const HAS_TEST_URI = !!process.env.MONGODB_TEST_URI;
const TEST_URI = process.env.MONGODB_TEST_URI ?? "mongodb://localhost:27017";
const TEST_DB = "frames_test";

let client: MongoClient;
let db: Db;

const sample = (id: string, requires: string[] = []): AppliedFrameRecord => ({
  _id: id,
  version: "0.1.0",
  appliedAt: new Date(),
  appliedBy: "test",
  manifest: {
    name: id,
    version: "0.1.0",
    rootPath: "/tmp/x",
    requires,
  },
  resources: {},
});

describe.runIf(HAS_TEST_URI)("AppliedFramesStore", () => {
  beforeAll(async () => {
    client = new MongoClient(TEST_URI, { serverSelectionTimeoutMS: 3000 });
    await client.connect();
    db = client.db(TEST_DB);
  });

  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  beforeEach(async () => {
    await db.collection("applied_frames").deleteMany({});
  });

  it("upsert then get", async () => {
    const store = new AppliedFramesStore(db);
    await store.upsert(sample("hive-baseline"));
    const got = await store.get("hive-baseline");
    expect(got?._id).toBe("hive-baseline");
  });

  it("list returns empty when nothing applied", async () => {
    const store = new AppliedFramesStore(db);
    expect(await store.list()).toEqual([]);
  });

  it("upsert is idempotent (replace not duplicate)", async () => {
    const store = new AppliedFramesStore(db);
    await store.upsert(sample("x"));
    await store.upsert(sample("x"));
    expect((await store.list()).length).toBe(1);
  });

  it("remove deletes record", async () => {
    const store = new AppliedFramesStore(db);
    await store.upsert(sample("x"));
    expect(await store.remove("x")).toBe(true);
    expect(await store.get("x")).toBeNull();
  });

  it("findDependents returns frames that require the target", async () => {
    const store = new AppliedFramesStore(db);
    await store.upsert(sample("a"));
    await store.upsert(sample("b", ["a"]));
    await store.upsert(sample("c", ["a", "b"]));
    expect((await store.findDependents("a")).sort()).toEqual(["b", "c"]);
    expect(await store.findDependents("c")).toEqual([]);
  });
});
