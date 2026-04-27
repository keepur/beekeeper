/**
 * Phase 2 end-to-end smoke test (Task 10).
 *
 * Mongo-gated (uses MONGODB_TEST_URI like applied-frames-store.test.ts). When
 * the env var is absent, the suite is skipped — CI on the self-hosted Mac
 * Mini runner can opt in by exporting the URI.
 *
 * The plan's Task 10 calls for manual validation against a live `dodi` instance
 * (apply -> audit -> remove on a real frame fixture). This automated suite
 * mirrors that sequence at unit-cost: it builds a synthetic frame with one of
 * each asset type, runs `executeFullApply`, asserts the applied_frames record
 * + agent state, then runs `removeFrameWithDb` and asserts everything reverts.
 *
 * Manual smoke per plan steps 10.1–10.7 (drift dialog, requires/conflicts, hive
 * SIGUSR1 reload) is still required against the live dodi instance and is
 * documented in the plan.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeFullApply } from "./apply.js";
import { removeFrameWithDb } from "./remove.js";
import { auditInstance as _auditInstance } from "./audit.js";
import { AppliedFramesStore } from "../applied-frames-store.js";
import { detectDrift } from "../drift-detector.js";
import { applyDriftDecisions, summarizeAudit } from "./audit.js";
import type { FrameManifest, DriftFinding } from "../types.js";
import type { ResolvedInstance } from "../instance-resolver.js";

void _auditInstance;

const HAS_TEST_URI = !!process.env.MONGODB_TEST_URI;
const TEST_URI = process.env.MONGODB_TEST_URI ?? "mongodb://localhost:27017";
const TEST_DB = "frames_phase2_smoke";

let client: MongoClient;
let db: Db;
let servicePath: string;
let frameRoot: string;

const FRAME_NAME = "smoke-test-full";
const FRAME_VERSION = "1.0.0";

describe.runIf(HAS_TEST_URI)("frames Phase 2 e2e smoke (apply -> audit -> remove)", () => {
  beforeAll(async () => {
    client = new MongoClient(TEST_URI, { serverSelectionTimeoutMS: 3000 });
    await client.connect();
    db = client.db(TEST_DB);
  });

  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
    if (frameRoot && existsSync(frameRoot)) rmSync(frameRoot, { recursive: true, force: true });
    if (servicePath && existsSync(servicePath))
      rmSync(servicePath, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.collection("applied_frames").deleteMany({});
    await db.collection("agent_definitions").deleteMany({});
    await db.collection("agent_memory").deleteMany({});
    await db.collection("memory").deleteMany({});

    // service path with skills/ subdir
    servicePath = mkdtempSync(join(tmpdir(), "smoke-svc-"));
    mkdirSync(join(servicePath, "skills"), { recursive: true });

    // frame fixture
    frameRoot = mkdtempSync(join(tmpdir(), "smoke-frame-"));
    mkdirSync(join(frameRoot, "skills", "smoke-skill"), { recursive: true });
    writeFileSync(
      join(frameRoot, "skills", "smoke-skill", "SKILL.md"),
      "# smoke skill\nbody\n",
    );
    writeFileSync(join(frameRoot, "seed.md"), "smoke seed body\n");
    writeFileSync(
      join(frameRoot, "prompt-clause.md"),
      "Smoke prompt clause for rae.\n",
    );
    writeFileSync(
      join(frameRoot, "constitution-frag.md"),
      `<a id="capabilities"></a>\nSmoke replacement capabilities clause.\n`,
    );

    // Seed agent_definitions: rae has both anchors needed.
    await db.collection("agent_definitions").insertOne({
      _id: "rae",
      coreServers: ["memory"],
      systemPrompt: `<a id="role-spec"></a>\nrae original role`,
      schedule: [],
    });

    // Seed constitution with the anchor we'll replace.
    await db.collection("memory").insertOne({
      path: "shared/constitution.md",
      content: `<a id="capabilities"></a>\noriginal capabilities body\n<a id="end"></a>\nend`,
    });
  });

  function makeManifest(): FrameManifest {
    return {
      name: FRAME_NAME,
      version: FRAME_VERSION,
      rootPath: frameRoot,
      skills: [{ bundle: "skills/smoke-skill" }],
      memorySeeds: [{ agent: "rae", tier: "hot", file: "seed.md" }],
      coreservers: [{ add: ["keychain"], agents: ["rae"] }],
      schedule: [{ task: "smoke-task", agents: ["rae"], cron: "0 9 * * *" }],
      prompts: [
        { anchor: "role-spec", agents: ["rae"], file: "prompt-clause.md" },
      ],
      constitution: [
        {
          anchor: "capabilities",
          insert: "replace-anchor",
          file: "constitution-frag.md",
        },
      ],
    };
  }

  function makeInstance(): ResolvedInstance {
    return {
      id: "smoke",
      servicePath,
      mongoUri: TEST_URI,
      dbName: TEST_DB,
    };
  }

  it("applies all six asset types, audits clean, then removes all six", async () => {
    const manifest = makeManifest();
    const instance = makeInstance();

    // 1. apply
    const exit = await executeFullApply(db, manifest, instance, { yes: true });
    expect(exit).toBe(0);

    // applied_frames record present
    const store = new AppliedFramesStore(db);
    const record = await store.get(FRAME_NAME);
    expect(record).not.toBeNull();
    expect(record!.resources.skills?.length).toBe(1);
    expect(record!.resources.memorySeeds?.length).toBe(1);
    expect(record!.resources.coreservers?.rae).toEqual(["keychain"]);
    expect(record!.resources.schedule?.rae?.[0]?.task).toBe("smoke-task");
    expect(record!.resources.prompts?.rae?.anchors).toEqual(["role-spec"]);
    expect(record!.resources.constitution?.anchors).toEqual(["capabilities"]);

    // skill bundle on disk
    expect(existsSync(join(servicePath, "skills", "smoke-skill", "SKILL.md"))).toBe(true);

    // agent state
    const rae = await db
      .collection<{ _id: string; coreServers?: string[]; systemPrompt?: string; schedule?: Array<{ task: string; cron: string }> }>("agent_definitions")
      .findOne({ _id: "rae" });
    expect(rae?.coreServers).toContain("keychain");
    expect(rae?.coreServers).toContain("memory");
    expect(rae?.schedule?.find((e) => e.task === "smoke-task")?.cron).toBe("0 9 * * *");
    expect(rae?.systemPrompt).toContain("Smoke prompt clause");

    // constitution updated
    const constDoc = await db
      .collection<{ path: string; content: string }>("memory")
      .findOne({ path: "shared/constitution.md" });
    expect(constDoc?.content).toContain("Smoke replacement capabilities clause");

    // 2. audit — should be clean
    const findings: DriftFinding[] = [];
    const records = await store.list();
    for (const rec of records) {
      const raw = await detectDrift(db, rec, instance.servicePath);
      findings.push(...applyDriftDecisions(rec, raw));
    }
    const summary = summarizeAudit(instance.id, records.length, findings);
    expect(summary.exitCode).toBe(0);

    // 3. remove
    const rmExit = await removeFrameWithDb(db, instance, FRAME_NAME, { force: false });
    expect(rmExit).toBe(0);

    // record gone
    expect(await store.get(FRAME_NAME)).toBeNull();

    // skill bundle gone (no peer claims)
    expect(existsSync(join(servicePath, "skills", "smoke-skill"))).toBe(false);

    // agent state reverted
    const raeAfter = await db
      .collection<{ _id: string; coreServers?: string[]; systemPrompt?: string; schedule?: Array<{ task: string; cron: string }> }>("agent_definitions")
      .findOne({ _id: "rae" });
    expect(raeAfter?.coreServers ?? []).not.toContain("keychain");
    expect(raeAfter?.schedule?.find((e) => e.task === "smoke-task")).toBeUndefined();
    expect(raeAfter?.systemPrompt).not.toContain("Smoke prompt clause");

    // memory seed deleted
    const seeds = await db.collection("agent_memory").find({ agentId: "rae" }).toArray();
    expect(seeds.length).toBe(0);

    // constitution reverted
    const constAfter = await db
      .collection<{ path: string; content: string }>("memory")
      .findOne({ path: "shared/constitution.md" });
    expect(constAfter?.content).not.toContain("Smoke replacement capabilities clause");
    expect(constAfter?.content).toContain("original capabilities body");
  });
});
