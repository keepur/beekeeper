/**
 * KPR-105 — snapshotBefore preservation across drift-resolved applies.
 *
 * Mongo-gated like smoke-e2e.test.ts. When MONGODB_TEST_URI is absent the
 * suite is skipped. CI on the self-hosted Mac Mini runner can opt in by
 * exporting the URI.
 *
 * Covers:
 *   1. apply -> drift -> take-frame -> remove                 (constitution)
 *   2. apply -> drift -> take-frame -> drift -> take-frame -> remove (snapshot
 *      doesn't drift across N cycles)
 *   3. apply -> drift -> keep-local (pre-seeded decision) -> remove
 *   4. apply -> drift -> merged -> remove
 *   5. apply -> drift on prompts -> take-frame -> remove      (parallel path)
 *   6. apply (full) -> drift on constitution only -> take-frame -> remove
 *      (resource-preservation: skills/seeds/coreservers/schedule must
 *      carry forward).
 *   7. first-time apply records writer-captured snapshots (regression guard).
 *   8. cross-version --adopt preserves the original snapshotBefore.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeFullApply, runAdopt } from "./apply.js";
import { removeFrameWithDb } from "./remove.js";
import { AppliedFramesStore } from "../applied-frames-store.js";
import type { AppliedFrameRecord, DriftDecision, FrameManifest } from "../types.js";
import type { ResolvedInstance } from "../instance-resolver.js";

const HAS_TEST_URI = !!process.env.MONGODB_TEST_URI;
const TEST_URI = process.env.MONGODB_TEST_URI ?? "mongodb://localhost:27017";
const TEST_DB = "frames_kpr105";

let client: MongoClient;
let db: Db;
let servicePath: string;
let frameRoot: string;

const FRAME_NAME = "kpr105-frame";
const FRAME_VERSION = "1.0.0";

const ORIGINAL_CONSTITUTION =
  `<a id="cap"></a>\nORIGINAL CAP BODY\n<a id="end"></a>\nend`;
const ORIGINAL_PROMPT = `<a id="role-spec"></a>\nORIGINAL ROLE`;

describe.runIf(HAS_TEST_URI)("KPR-105 snapshotBefore preservation", () => {
  beforeAll(async () => {
    client = new MongoClient(TEST_URI, { serverSelectionTimeoutMS: 3000 });
    await client.connect();
    db = client.db(TEST_DB);
  });

  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
    if (frameRoot && existsSync(frameRoot))
      rmSync(frameRoot, { recursive: true, force: true });
    if (servicePath && existsSync(servicePath))
      rmSync(servicePath, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.collection("applied_frames").deleteMany({});
    await db.collection("agent_definitions").deleteMany({});
    await db.collection("agent_memory").deleteMany({});
    await db.collection("memory").deleteMany({});

    servicePath = mkdtempSync(join(tmpdir(), "kpr105-svc-"));
    mkdirSync(join(servicePath, "skills"), { recursive: true });

    frameRoot = mkdtempSync(join(tmpdir(), "kpr105-frame-"));
    mkdirSync(join(frameRoot, "skills", "kpr105-skill"), { recursive: true });
    writeFileSync(
      join(frameRoot, "skills", "kpr105-skill", "SKILL.md"),
      "# kpr105 skill\n",
    );
    writeFileSync(join(frameRoot, "seed.md"), "kpr105 seed body\n");
    writeFileSync(
      join(frameRoot, "prompt-clause.md"),
      "kpr105 prompt clause\n",
    );
    // NOTE: writeConstitutionAnchor with replace-anchor wraps the fragment
    // text with `<a id="${anchor}"></a>\n` before inserting, so the fragment
    // file should NOT include the anchor tag itself — otherwise the document
    // ends up with two duplicate <a id="cap"> anchors.
    writeFileSync(
      join(frameRoot, "constitution-frag.md"),
      `FRAME CAP BODY\n`,
    );

    await db.collection("agent_definitions").insertOne({
      _id: "rae",
      coreServers: ["memory"],
      systemPrompt: ORIGINAL_PROMPT,
      schedule: [],
    });

    await db.collection("memory").insertOne({
      path: "shared/constitution.md",
      content: ORIGINAL_CONSTITUTION,
    });
  });

  function makeFullManifest(): FrameManifest {
    return {
      name: FRAME_NAME,
      version: FRAME_VERSION,
      rootPath: frameRoot,
      skills: [{ bundle: "skills/kpr105-skill" }],
      memorySeeds: [{ agent: "rae", tier: "hot", file: "seed.md" }],
      coreservers: [{ add: ["keychain"], agents: ["rae"] }],
      schedule: [{ task: "kpr105-task", agents: ["rae"], cron: "0 9 * * *" }],
      prompts: [
        { anchor: "role-spec", agents: ["rae"], file: "prompt-clause.md" },
      ],
      constitution: [
        {
          anchor: "cap",
          insert: "replace-anchor",
          file: "constitution-frag.md",
        },
      ],
    };
  }

  function makeConstitutionOnlyManifest(): FrameManifest {
    return {
      name: FRAME_NAME,
      version: FRAME_VERSION,
      rootPath: frameRoot,
      constitution: [
        {
          anchor: "cap",
          insert: "replace-anchor",
          file: "constitution-frag.md",
        },
      ],
    };
  }

  function makePromptOnlyManifest(): FrameManifest {
    return {
      name: FRAME_NAME,
      version: FRAME_VERSION,
      rootPath: frameRoot,
      prompts: [
        { anchor: "role-spec", agents: ["rae"], file: "prompt-clause.md" },
      ],
    };
  }

  function makeInstance(): ResolvedInstance {
    return {
      id: "kpr105",
      servicePath,
      mongoUri: TEST_URI,
      dbName: TEST_DB,
    };
  }

  async function readConstitutionContent(): Promise<string> {
    const doc = await db
      .collection<{ path: string; content: string }>("memory")
      .findOne({ path: "shared/constitution.md" });
    return doc?.content ?? "";
  }

  async function readRecord(): Promise<AppliedFrameRecord | null> {
    return new AppliedFramesStore(db).get(FRAME_NAME);
  }

  async function injectConstitutionDrift(marker: string): Promise<void> {
    // Drift detection compares the neighborhood AFTER the anchor (frame-scoped
    // via extractAnchorNeighborhood with frameAnchors={cap}, which runs to
    // EOD). To register as drift, the marker must land inside the cap
    // neighborhood — i.e., somewhere after `<a id="cap"></a>`.
    const cur = await readConstitutionContent();
    const driftedContent = cur.replace(
      `<a id="cap"></a>`,
      `<a id="cap"></a>\n${marker}`,
    );
    await db
      .collection<{ path: string; content: string }>("memory")
      .updateOne(
        { path: "shared/constitution.md" },
        { $set: { content: driftedContent } },
      );
  }

  async function injectPromptDrift(): Promise<void> {
    // Prompt drift detection compares whether the recorded `insertedText`
    // appears verbatim in the current systemPrompt. To register as drift,
    // we mutate the inserted clause text itself.
    const coll = db.collection<{ _id: string; systemPrompt?: string }>("agent_definitions");
    const doc = await coll.findOne({ _id: "rae" });
    const cur = doc?.systemPrompt ?? "";
    const drifted = cur.replace("kpr105 prompt clause", "OPERATOR-EDITED CLAUSE");
    await coll.updateOne({ _id: "rae" }, { $set: { systemPrompt: drifted } });
  }

  it("Test 1: apply -> drift -> take-frame -> remove restores pre-first-apply constitution", async () => {
    const manifest = makeConstitutionOnlyManifest();
    const instance = makeInstance();

    expect(await executeFullApply(db, manifest, instance, { yes: true })).toBe(0);

    const recAfterApply = await readRecord();
    expect(recAfterApply?.resources.constitution?.snapshotBefore).toBe(
      ORIGINAL_CONSTITUTION,
    );

    // Inject drift directly in mongo (lands inside the cap neighborhood).
    await injectConstitutionDrift("LOCALLY-EDITED");
    expect(await readConstitutionContent()).toContain("LOCALLY-EDITED");

    // Drift-resolved apply (auto-take-frame via yes).
    expect(await executeFullApply(db, manifest, instance, { yes: true })).toBe(0);

    const recAfterDriftApply = await readRecord();
    expect(recAfterDriftApply?.resources.constitution?.snapshotBefore).toBe(
      ORIGINAL_CONSTITUTION,
    );
    // Drift-resolved apply replaced the cap anchor's neighborhood with frame
    // content; the LOCALLY-EDITED prefix lives outside the anchor and
    // intentionally remains. The key assertion is that on remove, snapshot
    // restoration wipes everything back to ORIGINAL_CONSTITUTION.

    // Remove and verify rollback to original.
    expect(await removeFrameWithDb(db, instance, FRAME_NAME, { force: false })).toBe(0);
    expect(await readConstitutionContent()).toBe(ORIGINAL_CONSTITUTION);
  });

  it("Test 2: snapshot survives multiple drift cycles", async () => {
    const manifest = makeConstitutionOnlyManifest();
    const instance = makeInstance();

    expect(await executeFullApply(db, manifest, instance, { yes: true })).toBe(0);

    await injectConstitutionDrift("DRIFT-A ");
    expect(await executeFullApply(db, manifest, instance, { yes: true })).toBe(0);

    await injectConstitutionDrift("DRIFT-B ");
    expect(await executeFullApply(db, manifest, instance, { yes: true })).toBe(0);

    const rec = await readRecord();
    expect(rec?.resources.constitution?.snapshotBefore).toBe(ORIGINAL_CONSTITUTION);

    expect(await removeFrameWithDb(db, instance, FRAME_NAME, { force: false })).toBe(0);
    expect(await readConstitutionContent()).toBe(ORIGINAL_CONSTITUTION);
  });

  it("Test 3: pre-seeded keep-local decision short-circuits apply; snapshot untouched", async () => {
    const manifest = makeConstitutionOnlyManifest();
    const instance = makeInstance();

    expect(await executeFullApply(db, manifest, instance, { yes: true })).toBe(0);
    const recAfterApply = await readRecord();
    expect(recAfterApply?.resources.constitution?.snapshotBefore).toBe(
      ORIGINAL_CONSTITUTION,
    );

    await injectConstitutionDrift("KEEP-LOCAL ");

    // Pre-seed a keep-local decision for the constitution resource so audit
    // treats the drift as already-resolved and apply returns "no actionable
    // drift" without entering step 6.
    const keepLocal: DriftDecision = {
      resource: "constitution:cap",
      decision: "keep-local",
      decidedAt: new Date(),
      decidedBy: "test",
      againstVersion: FRAME_VERSION,
    };
    await db.collection("applied_frames").updateOne(
      { _id: FRAME_NAME },
      { $set: { driftAccepted: [keepLocal] } },
    );

    // No-op apply; snapshot must be untouched.
    expect(await executeFullApply(db, manifest, instance, { yes: true })).toBe(0);
    const recAfterNoop = await readRecord();
    expect(recAfterNoop?.resources.constitution?.snapshotBefore).toBe(
      ORIGINAL_CONSTITUTION,
    );

    // Remove should still restore to original (operator's local edit is wiped
    // — that's the contract of keep-local + remove; the snapshot wins).
    expect(await removeFrameWithDb(db, instance, FRAME_NAME, { force: false })).toBe(0);
    expect(await readConstitutionContent()).toBe(ORIGINAL_CONSTITUTION);
  });

  it("Test 4: merged decision preserves snapshot; remove restores pre-first-apply", async () => {
    // Note on coverage equivalence: the persisted-snapshot logic in apply.ts
    // does not branch on `take-frame` vs `merged` — both go into
    // forceWriteResources and follow the same step 6 path. Both decisions
    // also follow the same `existingDecisions + newDecisions` flow into the
    // staged record. The take-frame variant (Test 1) exercises the same
    // persisted-snapshot branch this test would.
    //
    // For an isolated merged-path assertion, we pre-seed a `merged` decision
    // whose `againstVersion` matches FRAME_VERSION so audit treats it as
    // already-resolved (no actionable drift), then run apply — which goes
    // through the keep-local-style short-circuit. The persisted record is
    // {...existing, driftAccepted: [...]} (line 154-157 of apply.ts), which
    // by definition preserves snapshotBefore as the existing record's.
    const manifest = makeConstitutionOnlyManifest();
    const instance = makeInstance();

    expect(await executeFullApply(db, manifest, instance, { yes: true })).toBe(0);

    await injectConstitutionDrift("MERGED-DRIFT ");

    const merged: DriftDecision = {
      resource: "constitution:cap",
      decision: "merged",
      decidedAt: new Date(),
      decidedBy: "test",
      againstVersion: FRAME_VERSION,
      reason: "<merged text body>",
    };
    await db.collection("applied_frames").updateOne(
      { _id: FRAME_NAME },
      { $set: { driftAccepted: [merged] } },
    );

    expect(await executeFullApply(db, manifest, instance, { yes: true })).toBe(0);

    const rec = await readRecord();
    expect(rec?.resources.constitution?.snapshotBefore).toBe(ORIGINAL_CONSTITUTION);

    expect(await removeFrameWithDb(db, instance, FRAME_NAME, { force: false })).toBe(0);
    expect(await readConstitutionContent()).toBe(ORIGINAL_CONSTITUTION);
  });

  it("Test 5: prompts drift-resolved apply preserves per-agent snapshot", async () => {
    const manifest = makePromptOnlyManifest();
    const instance = makeInstance();

    expect(await executeFullApply(db, manifest, instance, { yes: true })).toBe(0);
    const recAfterApply = await readRecord();
    expect(recAfterApply?.resources.prompts?.rae?.snapshotBefore).toBe(ORIGINAL_PROMPT);

    await injectPromptDrift();

    expect(await executeFullApply(db, manifest, instance, { yes: true })).toBe(0);

    const recAfterDriftApply = await readRecord();
    expect(recAfterDriftApply?.resources.prompts?.rae?.snapshotBefore).toBe(
      ORIGINAL_PROMPT,
    );

    expect(await removeFrameWithDb(db, instance, FRAME_NAME, { force: false })).toBe(0);
    const raeAfter = await db
      .collection<{ _id: string; systemPrompt?: string }>("agent_definitions")
      .findOne({ _id: "rae" });
    // removePromptClause uses naive removal of the inserted clause and falls
    // back to keeping operator drift around it (see asset-writer.ts), so a
    // wholesale revert to ORIGINAL_PROMPT is not the contract for prompts.
    // The contract this test verifies: the inserted clause is gone, and
    // snapshotBefore on the persisted record was preserved across the
    // drift-resolved apply (so a future cleaner-state operator action could
    // restore it if desired).
    expect(raeAfter?.systemPrompt).not.toContain("kpr105 prompt clause");
    expect(raeAfter?.systemPrompt).toContain("ORIGINAL ROLE");
  });

  it("Test 6: drift on constitution only carries forward all other resources", async () => {
    const manifest = makeFullManifest();
    const instance = makeInstance();

    // First-time apply (all 6 resource types).
    expect(await executeFullApply(db, manifest, instance, { yes: true })).toBe(0);

    const recBefore = await readRecord();
    expect(recBefore?.resources.skills?.length).toBe(1);
    expect(recBefore?.resources.memorySeeds?.length).toBe(1);
    expect(recBefore?.resources.coreservers?.rae).toEqual(["keychain"]);
    expect(recBefore?.resources.schedule?.rae?.[0]?.task).toBe("kpr105-task");
    expect(recBefore?.resources.prompts?.rae?.anchors).toEqual(["role-spec"]);
    expect(recBefore?.resources.constitution?.anchors).toEqual(["cap"]);

    // Drift on constitution only.
    await injectConstitutionDrift("ONLY-CONSTITUTION-DRIFT ");

    // Drift-resolved apply — only the constitution resource should be in
    // forceWriteResources.
    expect(await executeFullApply(db, manifest, instance, { yes: true })).toBe(0);

    // Adjacent-bug fix: applied_frames record must still describe ALL 6
    // resource types, with carry-over from `existing` for the 5 untouched.
    const recAfter = await readRecord();
    expect(recAfter?.resources.skills?.length).toBe(1);
    expect(recAfter?.resources.skills?.[0]?.bundle).toBe("skills/kpr105-skill");
    expect(recAfter?.resources.memorySeeds?.length).toBe(1);
    expect(recAfter?.resources.coreservers?.rae).toEqual(["keychain"]);
    expect(recAfter?.resources.schedule?.rae?.[0]?.task).toBe("kpr105-task");
    expect(recAfter?.resources.prompts?.rae?.anchors).toEqual(["role-spec"]);
    expect(recAfter?.resources.constitution?.anchors).toEqual(["cap"]);

    // Snapshots preserved.
    expect(recAfter?.resources.constitution?.snapshotBefore).toBe(ORIGINAL_CONSTITUTION);
    expect(recAfter?.resources.prompts?.rae?.snapshotBefore).toBe(ORIGINAL_PROMPT);

    // Remove cleans everything up.
    expect(await removeFrameWithDb(db, instance, FRAME_NAME, { force: false })).toBe(0);
    expect(existsSync(join(servicePath, "skills", "kpr105-skill"))).toBe(false);
    expect(await readConstitutionContent()).toBe(ORIGINAL_CONSTITUTION);
    const raeAfter = await db
      .collection<{ _id: string; systemPrompt?: string; coreServers?: string[]; schedule?: Array<{ task: string; cron: string }> }>("agent_definitions")
      .findOne({ _id: "rae" });
    // Prompt: inserted clause gone (no wholesale revert — see Test 5 note).
    expect(raeAfter?.systemPrompt).not.toContain("kpr105 prompt clause");
    expect(raeAfter?.systemPrompt).toContain("ORIGINAL ROLE");
    expect(raeAfter?.coreServers ?? []).not.toContain("keychain");
    expect(raeAfter?.schedule?.find((e) => e.task === "kpr105-task")).toBeUndefined();
    const seeds = await db.collection("agent_memory").find({ agentId: "rae" }).toArray();
    expect(seeds.length).toBe(0);
  });

  it("Test 7: first-time apply records writer-captured snapshots (regression guard)", async () => {
    const manifest = makeFullManifest();
    const instance = makeInstance();

    expect(await executeFullApply(db, manifest, instance, { yes: true })).toBe(0);

    const rec = await readRecord();
    // First-time apply: existing was null, so persistedConstitutionSnapshot
    // and existingPromptSnapshot are both undefined; writer-captured values
    // win, exactly as before this fix.
    expect(rec?.resources.constitution?.snapshotBefore).toBe(ORIGINAL_CONSTITUTION);
    expect(rec?.resources.prompts?.rae?.snapshotBefore).toBe(ORIGINAL_PROMPT);
    // All 6 resource types populated.
    expect(rec?.resources.skills?.length).toBe(1);
    expect(rec?.resources.memorySeeds?.length).toBe(1);
    expect(rec?.resources.coreservers?.rae).toEqual(["keychain"]);
    expect(rec?.resources.schedule?.rae?.[0]?.task).toBe("kpr105-task");
  });

  it("Test 8: cross-version --adopt preserves original snapshotBefore", async () => {
    // Pre-seed a v1.0.0 record with a custom snapshotBefore that's distinct
    // from the current document state.
    const customSnapshot = `<a id="cap"></a>\nVERY-OLD-BASELINE\n<a id="end"></a>\nend`;
    const customPromptSnapshot = `<a id="role-spec"></a>\nVERY-OLD-ROLE`;
    const seedRecord: AppliedFrameRecord = {
      _id: FRAME_NAME,
      version: FRAME_VERSION,
      appliedAt: new Date(),
      appliedBy: "seed",
      manifest: makeFullManifest(),
      resources: {
        constitution: {
          anchors: ["cap"],
          snapshotBefore: customSnapshot,
          insertedText: { cap: "<previous insertedText>" },
        },
        prompts: {
          rae: {
            anchors: ["role-spec"],
            snapshotBefore: customPromptSnapshot,
            insertedText: { "role-spec": "<previous insertedText>" },
          },
        },
      },
    };
    await db.collection("applied_frames").insertOne(seedRecord);

    // Adopt with a different version (1.1.0) — this triggers buildAdoptRecord
    // since the same-version short-circuit doesn't fire.
    const v110Manifest: FrameManifest = {
      ...makeFullManifest(),
      version: "1.1.0",
    };

    // Exercise the actual runAdopt code path with cross-version snapshot
    // preservation logic (Task 4 in KPR-105 plan).
    expect(await runAdopt(db, v110Manifest, makeInstance())).toBe(0);

    const rec = await readRecord();
    expect(rec?.version).toBe("1.1.0");
    expect(rec?.resources.constitution?.snapshotBefore).toBe(customSnapshot);
    expect(rec?.resources.prompts?.rae?.snapshotBefore).toBe(customPromptSnapshot);
  });
});
