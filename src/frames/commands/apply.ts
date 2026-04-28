import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../config.js";
import { resolveInstance } from "../instance-resolver.js";
import { withInstanceDb } from "../mongo-client.js";
import { AppliedFramesStore } from "../applied-frames-store.js";
import { loadManifest } from "../manifest-loader.js";
import { collectAnchorSet, findAnchors } from "../anchor-resolver.js";
import { detectDrift } from "../drift-detector.js";
import { runDriftDialog } from "../drift-dialog.js";
import { applyDriftDecisions } from "./audit.js";
import { DependencyError, MissingAnchorError, PartialApplyError } from "../errors.js";
import {
  computeBundleHash,
  extractAnchorNeighborhood,
  resourceKey,
  sha256Text,
} from "../text-utils.js";
import {
  resolveScheduleSlots,
  removeCoreServers,
  removeMemorySeed,
  removePromptClause,
  removeScheduleEntry,
  removeSkillBundle,
  writeConstitutionAnchor,
  writeCoreServers,
  writeMemorySeed,
  writePromptClause,
  writeScheduleEntry,
  writeSkillBundle,
} from "../asset-writer.js";
import type {
  AppliedFrameRecord,
  AppliedResources,
  AppliedScheduleRecord,
  AppliedSeedRecord,
  AppliedSkillRecord,
  DriftDecision,
  FrameManifest,
} from "../types.js";
import type { Db } from "mongodb";
import type { ResolvedInstance } from "../instance-resolver.js";
import type { DialogResult } from "../drift-dialog.js";

export interface ApplyOptions {
  adopt?: boolean;
  forceOverride?: boolean;
  allowSeedOverride?: boolean;
  /**
   * KPR-107: opt-out of the malformed-finding block. By default, an applied
   * frame whose target document (constitution / agent systemPrompt) cannot
   * be parsed by `collectAnchorSet` causes `apply` to refuse to write.
   * Set this to proceed past that block — useful when the operator knows
   * the document is malformed and wants the frame to overwrite it.
   */
  forceMalformed?: boolean;
  yes?: boolean;
}

interface AgentDefDoc {
  _id: string;
  coreServers?: string[];
  systemPrompt?: string;
  schedule?: Array<{ task: string; cron: string }>;
}

interface ConstitutionDoc {
  path: string;
  content: string;
}

export async function applyFrame(
  framePath: string,
  instanceId: string,
  opts: ApplyOptions,
): Promise<number> {
  const config = loadConfig();
  const instance = resolveInstance(config, instanceId);
  const manifest = loadManifest(framePath);

  return await withInstanceDb(instance, async (db) => {
    if (opts.adopt) {
      return await runAdopt(db, manifest, instance, opts);
    }
    return await executeFullApply(db, manifest, instance, opts);
  });
}

async function runAdopt(
  db: Db,
  manifest: FrameManifest,
  instance: ResolvedInstance,
  opts: ApplyOptions = {},
): Promise<number> {
  const store = new AppliedFramesStore(db);
  const existing = await store.get(manifest.name);
  if (existing && existing.version === manifest.version) {
    console.log(
      `Frame "${manifest.name}" v${manifest.version} already adopted on "${instance.id}". No change.`,
    );
    return 0;
  }
  // KPR-107: malformed-target pre-flight (same as executeFullApply). Adopt
  // recording a baseline against a malformed document is a recipe for
  // confused subsequent audits — refuse unless `--force-malformed`.
  if (!opts.forceMalformed) {
    const blocked = await detectMalformedTargets(db, manifest, (sel) =>
      resolveAgents(db, sel),
    );
    if (blocked.length > 0) {
      console.error(
        `Frame "${manifest.name}" v${manifest.version}: refusing to adopt — ${blocked.length} malformed target document(s):`,
      );
      for (const m of blocked) {
        console.error(`  ${m.kind}: ${m.detail}`);
      }
      console.error(`Pass --force-malformed to adopt anyway.`);
      return 1;
    }
  }
  await verifyAnchors(db, manifest, (sel) => resolveAgents(db, sel));
  const record = await buildAdoptRecord(db, manifest);

  // KPR-105: cross-version --adopt on an already-adopted instance preserves
  // the original snapshotBefore for resource types that have one (constitution,
  // prompts). The new manifest's anchor set + insertedText reflect the current
  // (possibly post-prior-frame-content) document; the immutable
  // pre-first-apply baseline lives on the existing record.
  if (existing) {
    if (record.resources.constitution && existing.resources.constitution) {
      record.resources.constitution.snapshotBefore =
        existing.resources.constitution.snapshotBefore;
    }
    if (record.resources.prompts && existing.resources.prompts) {
      for (const [agentId, block] of Object.entries(record.resources.prompts)) {
        const prev = existing.resources.prompts[agentId];
        if (prev) {
          block.snapshotBefore = prev.snapshotBefore;
        }
      }
    }
  }

  await store.upsert(record);
  console.log(`Adopted frame "${manifest.name}" v${manifest.version} on "${instance.id}".`);
  console.log(
    `Snapshot recorded; future audit/apply will compare against this baseline. No assets were written.`,
  );
  return 0;
}

async function executeFullApply(
  db: Db,
  manifest: FrameManifest,
  instance: ResolvedInstance,
  opts: ApplyOptions,
): Promise<number> {
  const store = new AppliedFramesStore(db);

  // KPR-107: pre-flight malformed-document check. Catches duplicate-anchor
  // (or any other `collectAnchorSet` throw) on first-time apply too, where
  // there is no existing record for `detectDrift` to run against. Behavior
  // matches the drift-resolved-apply gate below: refuse with a clean error
  // unless the operator passes `--force-malformed`.
  if (!opts.forceMalformed) {
    const blocked = await detectMalformedTargets(db, manifest, (sel) =>
      resolveAgents(db, sel),
    );
    if (blocked.length > 0) {
      console.error(
        `Frame "${manifest.name}" v${manifest.version}: refusing to apply — ${blocked.length} malformed target document(s):`,
      );
      for (const m of blocked) {
        console.error(`  ${m.kind}: ${m.detail}`);
      }
      console.error(`Pass --force-malformed to apply anyway.`);
      return 1;
    }
  }

  // Step 2: validate anchors (with wildcard agent resolution) + requires/conflicts.
  await verifyAnchors(db, manifest, (sel) => resolveAgents(db, sel));
  await verifyRequiresConflicts(store, manifest);

  // Step 3: same-version short-circuit + drift dialog.
  const existing = await store.get(manifest.name);
  let forceWriteResources: Set<string> | undefined;
  let dialogResultsByResource: Map<string, DialogResult> | undefined;
  let existingDecisions: DriftDecision[] = [];
  let newDecisions: DriftDecision[] = [];
  if (existing && existing.version === manifest.version) {
    const raw = await detectDrift(db, existing, instance.servicePath);
    // KPR-107: malformed findings on the same-version drift-resolved-apply
    // path are filtered out here — the pre-flight check above already
    // refuses unless `--force-malformed`. With force, we deliberately let
    // these findings flow through so the operator's take-frame decision can
    // overwrite the malformed document.
    const filtered = applyDriftDecisions(existing, raw).filter(
      (f) => f.kind !== "constitution-malformed" && f.kind !== "prompt-malformed",
    );
    const actionable = filtered.filter((f) => !f.informational);
    if (actionable.length === 0) {
      console.log(
        `Frame "${manifest.name}" v${manifest.version} already applied on "${instance.id}". No drift. No-op.`,
      );
      return 0;
    }
    existingDecisions = existing.driftAccepted ?? [];
    const actor = buildActor();
    const ret = await runDriftDialog(db, existing, raw, {
      yes: opts.yes ?? false,
      actor,
    });
    newDecisions = ret.newDecisions;
    forceWriteResources = new Set();
    dialogResultsByResource = new Map();
    for (const r of ret.results) {
      if (r.decision === "take-frame" || r.decision === "merged") {
        forceWriteResources.add(r.finding.resource);
      }
      dialogResultsByResource.set(r.finding.resource, r);
    }
    if (forceWriteResources.size === 0) {
      // Decisions were keep-local / deferred only. Persist decisions, no asset writes.
      const stagedRecord: AppliedFrameRecord = {
        ...existing,
        driftAccepted: [...existingDecisions, ...newDecisions],
      };
      await store.upsert(stagedRecord);
      console.log(
        `Frame "${manifest.name}" v${manifest.version}: drift decisions recorded; no assets written.`,
      );
      return 0;
    }
  }

  // Step 4: pre-apply hook.
  if (manifest.hooks?.preApply) {
    await runHook(manifest, manifest.hooks.preApply, "pre-apply", opts.yes ?? false);
  }

  // Step 5: pre-resolve all agent selectors used downstream.
  // (Done inline per asset block below, for clarity.)

  // Step 6: apply assets in fixed order.
  const resources: AppliedResources = {};
  const writtenLabels: string[] = [];
  const writtenSkills: AppliedSkillRecord[] = [];
  const writtenSeeds: AppliedSeedRecord[] = [];
  const writtenCoreservers: Record<string, string[]> = {};
  const writtenSchedule: Record<string, AppliedScheduleRecord[]> = {};
  const writtenPrompts: Record<string, { anchors: string[]; snapshotBefore: string; insertedText: Record<string, string> }> = {};
  let constitutionSnapshotBefore: string | undefined;
  const constitutionInsertedText: Record<string, string> = {};
  const constitutionAnchorsWritten: string[] = [];
  // KPR-105: preserve original snapshotBefore (the persisted, "before-first-
  // apply" baseline) across drift-resolved applies. The in-flight rollback
  // target — what reverseBestEffort writes if step 6 throws — remains the
  // pre-this-round state captured by the writer; those two semantics diverge
  // for drift-resolved applies and need separate variables.
  const persistedConstitutionSnapshot =
    existing?.resources.constitution?.snapshotBefore;

  try {
    // 6a. skills
    for (const s of manifest.skills ?? []) {
      const key = resourceKey("skills", s.bundle);
      if (forceWriteResources && !forceWriteResources.has(key)) continue;
      const rec = await writeSkillBundle(db, manifest, s.bundle, instance.servicePath, {
        forceOverride: opts.forceOverride,
      });
      writtenSkills.push(rec);
      writtenLabels.push(key);
    }
    if (writtenSkills.length > 0) resources.skills = writtenSkills;

    // 6b. memory seeds
    for (const seed of manifest.memorySeeds ?? []) {
      const filePath = join(manifest.rootPath, seed.file);
      const content = readFileSync(filePath, "utf-8");
      const contentHash = sha256Text(content);
      const key = resourceKey("seeds", seed.agent, contentHash);
      if (forceWriteResources && !forceWriteResources.has(key)) continue;
      const rec = await writeMemorySeed(db, manifest, seed, {
        allowSeedOverride: opts.allowSeedOverride,
      });
      writtenSeeds.push(rec);
      writtenLabels.push(key);
    }
    if (writtenSeeds.length > 0) resources.memorySeeds = writtenSeeds;

    // 6c. core servers
    for (const cs of manifest.coreservers ?? []) {
      const resolvedAgents = await resolveAgents(db, cs.agents);
      // Per-resource gating: build the (agentId, server) keys, filter to the in-set ones.
      const filteredAgents: string[] = [];
      const agentToServers = new Map<string, string[]>();
      for (const agentId of resolvedAgents) {
        const allowed: string[] = [];
        for (const server of cs.add) {
          const key = resourceKey("coreservers", agentId, server);
          if (forceWriteResources && !forceWriteResources.has(key)) continue;
          allowed.push(server);
        }
        if (allowed.length > 0) {
          filteredAgents.push(agentId);
          agentToServers.set(agentId, allowed);
        }
      }
      if (filteredAgents.length === 0) continue;
      // Call the writer per-agent because the asset-level writer takes one `add` list.
      for (const agentId of filteredAgents) {
        const allowed = agentToServers.get(agentId) ?? [];
        const added = await writeCoreServers(
          db,
          { add: allowed, agents: cs.agents },
          [agentId],
        );
        for (const [aid, servers] of Object.entries(added)) {
          const cur = writtenCoreservers[aid] ?? [];
          writtenCoreservers[aid] = [...cur, ...servers];
          for (const server of servers) {
            writtenLabels.push(resourceKey("coreservers", aid, server));
          }
        }
      }
    }
    if (Object.keys(writtenCoreservers).length > 0) resources.coreservers = writtenCoreservers;

    // 6d. schedule
    for (const sched of manifest.schedule ?? []) {
      const resolvedAgents = await resolveAgents(db, sched.agents);
      const slots = resolveScheduleSlots(sched, resolvedAgents);
      for (const slot of slots) {
        const key = resourceKey("schedule", slot.agentId, sched.task);
        if (forceWriteResources && !forceWriteResources.has(key)) continue;
        const rec = await writeScheduleEntry(
          db,
          slot.agentId,
          sched.task,
          slot.cron,
          slot.pattern,
          slot.windowSlot,
          manifest.name,
          { forceOverride: opts.forceOverride },
        );
        const cur = writtenSchedule[slot.agentId] ?? [];
        writtenSchedule[slot.agentId] = [...cur, rec];
        writtenLabels.push(key);
      }
    }
    if (Object.keys(writtenSchedule).length > 0) resources.schedule = writtenSchedule;

    // 6e. prompts
    for (const p of manifest.prompts ?? []) {
      const resolvedAgents = await resolveAgents(db, p.agents);
      const filePath = join(manifest.rootPath, p.file);
      const clauseText = readFileSync(filePath, "utf-8");
      for (const agentId of resolvedAgents) {
        const key = resourceKey("prompts", agentId, p.anchor);
        let textToWrite = clauseText;
        if (forceWriteResources) {
          if (!forceWriteResources.has(key)) continue;
          const dr = dialogResultsByResource?.get(key);
          if (dr?.decision === "merged" && dr.mergedText !== undefined) {
            textToWrite = dr.mergedText;
          }
        }
        const { snapshotBefore, insertedText } = await writePromptClause(
          db,
          agentId,
          p.anchor,
          textToWrite,
        );
        const cur = writtenPrompts[agentId] ?? {
          anchors: [],
          snapshotBefore,
          insertedText: {},
        };
        if (cur.anchors.length === 0) cur.snapshotBefore = snapshotBefore;
        cur.anchors.push(p.anchor);
        cur.insertedText[p.anchor] = insertedText;
        writtenPrompts[agentId] = cur;
        writtenLabels.push(key);
      }
    }
    // KPR-105: writtenPrompts[*].snapshotBefore is the in-flight rollback
    // target (consumed by reverseBestEffort). The persisted record needs the
    // pre-first-apply baseline, which is preserved from the existing record
    // when this is a drift-resolved apply.
    if (Object.keys(writtenPrompts).length > 0) {
      const persistedPrompts: Record<
        string,
        { anchors: string[]; snapshotBefore: string; insertedText: Record<string, string> }
      > = {};
      for (const [agentId, block] of Object.entries(writtenPrompts)) {
        const existingSnap = existing?.resources.prompts?.[agentId]?.snapshotBefore;
        persistedPrompts[agentId] = {
          anchors: block.anchors,
          snapshotBefore: existingSnap ?? block.snapshotBefore,
          insertedText: block.insertedText,
        };
      }
      resources.prompts = persistedPrompts;
    }

    // 6f. constitution — capture single snapshot before the first write.
    const constitutionFrameAnchors = new Set(
      (manifest.constitution ?? []).map((c) => c.anchor),
    );
    for (const c of manifest.constitution ?? []) {
      const key = resourceKey("constitution", c.anchor);
      if (forceWriteResources && !forceWriteResources.has(key)) continue;
      let fragmentText: string;
      const dr = dialogResultsByResource?.get(key);
      if (dr?.decision === "merged" && dr.mergedText !== undefined) {
        fragmentText = dr.mergedText;
      } else {
        fragmentText = readFileSync(join(manifest.rootPath, c.file), "utf-8");
      }
      const { snapshotBefore, insertedText } = await writeConstitutionAnchor(
        db,
        c.anchor,
        c.insert,
        c.targetAnchor,
        fragmentText,
        c.title,
        constitutionFrameAnchors,
      );
      if (constitutionSnapshotBefore === undefined) constitutionSnapshotBefore = snapshotBefore;
      constitutionInsertedText[c.anchor] = insertedText;
      constitutionAnchorsWritten.push(c.anchor);
      writtenLabels.push(key);
    }
    if (constitutionAnchorsWritten.length > 0) {
      resources.constitution = {
        anchors: constitutionAnchorsWritten,
        // KPR-105: persisted snapshot uses the carried-over original baseline
        // when present (drift-resolved apply); writer-captured value is only
        // used on first-time apply.
        snapshotBefore: persistedConstitutionSnapshot ?? constitutionSnapshotBefore ?? "",
        insertedText: constitutionInsertedText,
      };
    }
  } catch (err) {
    // Reverse-best-effort over what was just written.
    const unreversed = await reverseBestEffort(db, instance, manifest, {
      writtenSkills,
      writtenSeeds,
      writtenCoreservers,
      writtenSchedule,
      writtenPrompts,
      constitutionSnapshotBefore,
    });
    if (unreversed.length > 0) {
      throw new PartialApplyError(writtenLabels, unreversed);
    }
    throw err;
  }

  // Step 8: post-apply hook.
  if (manifest.hooks?.postApply) {
    try {
      await runHook(manifest, manifest.hooks.postApply, "post-apply", opts.yes ?? false);
    } catch (err) {
      const unreversed = await reverseBestEffort(db, instance, manifest, {
        writtenSkills,
        writtenSeeds,
        writtenCoreservers,
        writtenSchedule,
        writtenPrompts,
        constitutionSnapshotBefore,
      });
      if (unreversed.length > 0) {
        throw new PartialApplyError(writtenLabels, unreversed);
      }
      throw err;
    }
  }

  // KPR-105: drift-resolved applies only re-write resources flagged in
  // forceWriteResources. Resources untouched this round must carry forward
  // from the existing record so the persisted record stays a complete
  // description of what the frame contributed. Without this, subsequent
  // audits stop checking untouched resource types and `frame remove` no
  // longer cleans them up.
  if (existing) {
    mergeUntouchedResources(resources, existing.resources);
  }

  // Step 7: stage record (now that all writes succeeded).
  const stagedRecord: AppliedFrameRecord = {
    _id: manifest.name,
    version: manifest.version,
    appliedAt: new Date(),
    appliedBy: buildActor(),
    manifest,
    resources,
    driftAccepted: [...existingDecisions, ...newDecisions],
  };

  // Step 9: commit record.
  await store.upsert(stagedRecord);

  // Step 10: SIGUSR1 if any writes occurred.
  if (writtenLabels.length > 0) {
    sendSigusr1(instance.servicePath);
  }

  console.log(
    `Applied frame "${manifest.name}" v${manifest.version} on "${instance.id}" (${writtenLabels.length} resource(s) written).`,
  );
  return 0;
}

/**
 * KPR-105: merge untouched resources from a previous applied_frames record
 * into the staged resources for the current drift-resolved apply.
 *
 * Drift-resolved applies only re-write resources flagged in
 * `forceWriteResources`; resources without actionable drift this round are
 * skipped. The staged record must still describe the frame's full footprint,
 * so peer entries (e.g. other skill bundles, other agents' coreservers, other
 * constitution anchors) are carried forward.
 *
 * Within a resource type, this round's freshly-resolved entries win for the
 * keys they touch; the existing record fills in keys this round did not.
 *
 * Snapshot fields (`snapshotBefore`) on resource types that have them are
 * preserved separately at write time (Task 1 / Task 2). This merge does NOT
 * re-derive snapshotBefore — for resources fully carried over, the existing
 * snapshot is used as-is; for resources where this round wrote a partial
 * subset, the snapshot was already preserved when the staged entry was built.
 */
function mergeUntouchedResources(
  staged: AppliedResources,
  prior: AppliedResources,
): void {
  // skills: union by bundle name (this round wins on collision).
  if (prior.skills) {
    const writtenBundles = new Set((staged.skills ?? []).map((s) => s.bundle));
    const carryover = prior.skills.filter((s) => !writtenBundles.has(s.bundle));
    if (carryover.length > 0) {
      staged.skills = [...(staged.skills ?? []), ...carryover];
    }
  }

  // memorySeeds: union by (agent, contentHash).
  if (prior.memorySeeds) {
    const writtenIds = new Set(
      (staged.memorySeeds ?? []).map((s) => `${s.agent}:${s.contentHash}`),
    );
    const carryover = prior.memorySeeds.filter(
      (s) => !writtenIds.has(`${s.agent}:${s.contentHash}`),
    );
    if (carryover.length > 0) {
      staged.memorySeeds = [...(staged.memorySeeds ?? []), ...carryover];
    }
  }

  // coreservers: per-agent server list union (this round's list wins for the
  // agents it touched; other agents carry forward).
  if (prior.coreservers) {
    const merged: Record<string, string[]> = { ...(staged.coreservers ?? {}) };
    for (const [agentId, servers] of Object.entries(prior.coreservers)) {
      const cur = merged[agentId];
      if (cur === undefined) {
        merged[agentId] = [...servers];
        continue;
      }
      const curSet = new Set(cur);
      const carryover = servers.filter((s) => !curSet.has(s));
      if (carryover.length > 0) {
        merged[agentId] = [...cur, ...carryover];
      }
    }
    if (Object.keys(merged).length > 0) staged.coreservers = merged;
  }

  // schedule: per-agent entry list union by task name.
  if (prior.schedule) {
    const merged: Record<string, AppliedScheduleRecord[]> = {
      ...(staged.schedule ?? {}),
    };
    for (const [agentId, entries] of Object.entries(prior.schedule)) {
      const cur = merged[agentId];
      if (cur === undefined) {
        merged[agentId] = [...entries];
        continue;
      }
      const curTasks = new Set(cur.map((e) => e.task));
      const carryover = entries.filter((e) => !curTasks.has(e.task));
      if (carryover.length > 0) {
        merged[agentId] = [...cur, ...carryover];
      }
    }
    if (Object.keys(merged).length > 0) staged.schedule = merged;
  }

  // prompts: per-agent { anchors, snapshotBefore, insertedText } union.
  // For agents touched this round, snapshotBefore was already preserved
  // from existing in Task 2; we union anchors + insertedText here.
  if (prior.prompts) {
    const merged: Record<
      string,
      { anchors: string[]; snapshotBefore: string; insertedText: Record<string, string> }
    > = { ...(staged.prompts ?? {}) };
    for (const [agentId, block] of Object.entries(prior.prompts)) {
      const cur = merged[agentId];
      if (!cur) {
        merged[agentId] = {
          anchors: [...block.anchors],
          snapshotBefore: block.snapshotBefore,
          insertedText: { ...block.insertedText },
        };
        continue;
      }
      const curAnchorSet = new Set(cur.anchors);
      const carryAnchors = block.anchors.filter((a) => !curAnchorSet.has(a));
      cur.anchors = [...cur.anchors, ...carryAnchors];
      for (const [a, txt] of Object.entries(block.insertedText)) {
        if (!(a in cur.insertedText)) cur.insertedText[a] = txt;
      }
    }
    if (Object.keys(merged).length > 0) staged.prompts = merged;
  }

  // constitution: anchors + insertedText union; snapshotBefore already
  // preserved in Task 1.
  if (prior.constitution) {
    const cur = staged.constitution;
    if (!cur) {
      staged.constitution = {
        anchors: [...prior.constitution.anchors],
        snapshotBefore: prior.constitution.snapshotBefore,
        insertedText: { ...prior.constitution.insertedText },
      };
    } else {
      const curAnchorSet = new Set(cur.anchors);
      const carryAnchors = prior.constitution.anchors.filter(
        (a) => !curAnchorSet.has(a),
      );
      cur.anchors = [...cur.anchors, ...carryAnchors];
      for (const [a, txt] of Object.entries(prior.constitution.insertedText)) {
        if (!(a in cur.insertedText)) cur.insertedText[a] = txt;
      }
    }
  }
}

interface ReverseState {
  writtenSkills: AppliedSkillRecord[];
  writtenSeeds: AppliedSeedRecord[];
  writtenCoreservers: Record<string, string[]>;
  writtenSchedule: Record<string, AppliedScheduleRecord[]>;
  writtenPrompts: Record<string, { anchors: string[]; snapshotBefore: string; insertedText: Record<string, string> }>;
  constitutionSnapshotBefore: string | undefined;
}

async function reverseBestEffort(
  db: Db,
  instance: ResolvedInstance,
  manifest: FrameManifest,
  state: ReverseState,
): Promise<string[]> {
  const unreversed: string[] = [];

  // Reverse order of step 6.
  if (state.constitutionSnapshotBefore !== undefined) {
    try {
      const coll = db.collection<ConstitutionDoc>("memory");
      await coll.updateOne(
        { path: "shared/constitution.md" },
        { $set: { content: state.constitutionSnapshotBefore } },
        { upsert: true },
      );
    } catch (e) {
      unreversed.push(`constitution:* (${(e as Error).message})`);
    }
  }

  for (const [agentId, block] of Object.entries(state.writtenPrompts)) {
    const coll = db.collection<AgentDefDoc>("agent_definitions");
    try {
      const doc = await coll.findOne({ _id: agentId });
      const current = doc?.systemPrompt ?? "";
      for (const anchor of block.anchors) {
        try {
          await removePromptClause(
            db,
            agentId,
            anchor,
            block.insertedText[anchor] ?? "",
            block.snapshotBefore,
            current,
          );
        } catch (e) {
          unreversed.push(`${resourceKey("prompts", agentId, anchor)} (${(e as Error).message})`);
        }
      }
    } catch (e) {
      for (const anchor of block.anchors) {
        unreversed.push(`${resourceKey("prompts", agentId, anchor)} (${(e as Error).message})`);
      }
    }
  }

  for (const [agentId, entries] of Object.entries(state.writtenSchedule)) {
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

  if (Object.keys(state.writtenCoreservers).length > 0) {
    try {
      await removeCoreServers(db, state.writtenCoreservers);
    } catch (e) {
      for (const [agentId, servers] of Object.entries(state.writtenCoreservers)) {
        for (const server of servers) {
          unreversed.push(
            `${resourceKey("coreservers", agentId, server)} (${(e as Error).message})`,
          );
        }
      }
    }
  }

  for (const seed of state.writtenSeeds) {
    try {
      await removeMemorySeed(db, seed, manifest.name);
    } catch (e) {
      unreversed.push(
        `${resourceKey("seeds", seed.agent, seed.contentHash)} (${(e as Error).message})`,
      );
    }
  }

  for (const skill of state.writtenSkills) {
    try {
      await removeSkillBundle(db, skill, manifest.name, instance.servicePath);
    } catch (e) {
      unreversed.push(`${resourceKey("skills", skill.bundle)} (${(e as Error).message})`);
    }
  }

  return unreversed;
}

async function runHook(
  manifest: FrameManifest,
  hookPath: string,
  label: "pre-apply" | "post-apply",
  yes: boolean,
): Promise<void> {
  const rootPath = manifest.rootPath;
  const hookAbs = resolve(rootPath, hookPath);
  if (!hookAbs.startsWith(resolve(rootPath) + sep)) {
    throw new Error(`hook path escapes frame root: ${hookPath}`);
  }
  console.log(`Frame "${manifest.name}" ${label} hook: /bin/sh ${hookAbs}`);
  if (!yes && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question("Run hook? [y/N] > ")).trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        throw new Error(`${label} hook declined by operator`);
      }
    } finally {
      rl.close();
    }
  }
  execFileSync("/bin/sh", [hookAbs], { stdio: "inherit" });
}

async function resolveAgents(db: Db, selector: string[]): Promise<string[]> {
  if (selector.length === 1 && selector[0] === "*") {
    const docs = await db
      .collection<{ _id: string }>("agent_definitions")
      .find({}, { projection: { _id: 1 } })
      .sort({ _id: 1 })
      .toArray();
    return docs.map((d) => d._id);
  }
  // Validate each id exists.
  const found = await db
    .collection<{ _id: string }>("agent_definitions")
    .find({ _id: { $in: selector } }, { projection: { _id: 1 } })
    .toArray();
  const foundSet = new Set(found.map((d) => d._id));
  const missing = selector.filter((s) => !foundSet.has(s));
  if (missing.length > 0) {
    throw new Error(
      `agent selector references unknown agent_definitions: ${missing.join(", ")}`,
    );
  }
  return [...selector];
}

async function verifyRequiresConflicts(
  store: AppliedFramesStore,
  manifest: FrameManifest,
): Promise<void> {
  const requires = manifest.requires ?? [];
  const conflicts = manifest.conflicts ?? [];
  const missing: string[] = [];
  for (const req of requires) {
    const got = await store.get(req);
    if (!got) missing.push(req);
  }
  if (missing.length > 0) {
    throw new DependencyError(manifest.name, missing);
  }
  const present: string[] = [];
  for (const conf of conflicts) {
    const got = await store.get(conf);
    if (got) present.push(conf);
  }
  if (present.length > 0) {
    throw new DependencyError(manifest.name, present);
  }
}

/**
 * KPR-107: pre-flight scan for malformed target documents. Returns a list of
 * malformed findings (one per affected document). Mirrors the drift detector's
 * `constitution-malformed` / `prompt-malformed` emission, but runs against the
 * frame's manifest (rather than an applied record) so it covers first-time
 * apply too.
 *
 * Only the documents the frame actually targets are scanned — a malformed
 * agent systemPrompt for an agent the frame doesn't touch is not the frame's
 * concern.
 */
interface MalformedFinding {
  kind: "constitution-malformed" | "prompt-malformed";
  detail: string;
}
async function detectMalformedTargets(
  db: Db,
  manifest: FrameManifest,
  agentResolver: (selector: string[]) => Promise<string[]>,
): Promise<MalformedFinding[]> {
  const out: MalformedFinding[] = [];

  if ((manifest.constitution ?? []).length > 0) {
    const doc = await db
      .collection<{ path: string; content: string }>("memory")
      .findOne({ path: "shared/constitution.md" });
    if (doc) {
      try {
        collectAnchorSet(doc.content);
      } catch (e) {
        out.push({
          kind: "constitution-malformed",
          detail: `cannot parse shared/constitution.md: ${(e as Error).message}`,
        });
      }
    }
  }

  if ((manifest.prompts ?? []).length > 0) {
    const targetAgents = new Set<string>();
    for (const p of manifest.prompts ?? []) {
      const ids =
        p.agents.length === 1 && p.agents[0] === "*"
          ? await agentResolver(["*"])
          : p.agents.filter((a) => a !== "*");
      for (const id of ids) targetAgents.add(id);
    }
    if (targetAgents.size > 0) {
      const agents = await db
        .collection<{ _id: string; systemPrompt?: string }>("agent_definitions")
        .find({ _id: { $in: [...targetAgents] } })
        .toArray();
      for (const a of agents) {
        try {
          collectAnchorSet(a.systemPrompt ?? "");
        } catch (e) {
          out.push({
            kind: "prompt-malformed",
            detail: `cannot parse agent_definitions[${a._id}].systemPrompt: ${(e as Error).message}`,
          });
        }
      }
    }
  }

  return out;
}

async function verifyAnchors(
  db: Db,
  manifest: FrameManifest,
  agentResolver?: (selector: string[]) => Promise<string[]>,
): Promise<void> {
  // Constitution anchors.
  const constitutionRequired = new Set<string>();
  for (const c of manifest.constitution ?? []) {
    constitutionRequired.add(c.anchor);
    if (c.targetAnchor) constitutionRequired.add(c.targetAnchor);
  }
  if (constitutionRequired.size > 0) {
    const doc = await db.collection<{ path: string; content: string }>("memory").findOne({
      path: "shared/constitution.md",
    });
    if (!doc) {
      throw new MissingAnchorError(
        manifest.name,
        "constitution",
        [...constitutionRequired][0],
        "shared/constitution.md (not found)",
      );
    }
    // KPR-107: verifyAnchors only checks anchor *presence* — duplicates do
    // not invalidate that check (the anchor IS present, just twice). The
    // malformed condition is surfaced separately by the drift detector and
    // gated by `--force-malformed` in executeFullApply. Use the permissive
    // anchor list (no duplicate-throw) here so a malformed document doesn't
    // get rejected with an unhandled throw before reaching the gate.
    const present = new Set(findAnchors(doc.content).map((a) => a.anchor));
    for (const a of constitutionRequired) {
      if (!present.has(a)) {
        throw new MissingAnchorError(manifest.name, "constitution", a, "shared/constitution.md");
      }
    }
  }

  // Per-agent prompt anchors. Wildcards expanded via agentResolver when provided.
  const promptAnchorsByAgent = new Map<string, string[]>();
  for (const p of manifest.prompts ?? []) {
    let agentIds: string[];
    if (p.agents.length === 1 && p.agents[0] === "*") {
      if (!agentResolver) continue; // adopt path: skip wildcards.
      agentIds = await agentResolver(["*"]);
    } else {
      agentIds = p.agents.filter((a) => a !== "*");
    }
    for (const agent of agentIds) {
      const list = promptAnchorsByAgent.get(agent) ?? [];
      list.push(p.anchor);
      promptAnchorsByAgent.set(agent, list);
    }
  }
  if (promptAnchorsByAgent.size > 0) {
    const agents = await db
      .collection<{ _id: string; systemPrompt?: string }>("agent_definitions")
      .find({ _id: { $in: [...promptAnchorsByAgent.keys()] } })
      .toArray();
    const byId = new Map(agents.map((a) => [a._id, a.systemPrompt ?? ""]));
    for (const [agentId, anchors] of promptAnchorsByAgent) {
      const text = byId.get(agentId) ?? "";
      // KPR-107: see comment on the constitution branch above.
      const present = new Set(findAnchors(text).map((a) => a.anchor));
      for (const a of anchors) {
        if (!present.has(a)) {
          throw new MissingAnchorError(
            manifest.name,
            `prompts:${agentId}`,
            a,
            `agent_definitions[${agentId}].systemPrompt`,
          );
        }
      }
    }
  }
}

async function buildAdoptRecord(db: Db, manifest: FrameManifest): Promise<AppliedFrameRecord> {
  const resources: AppliedResources = {};

  // Skills: hash each bundle currently on disk.
  const skillRecords: AppliedSkillRecord[] = [];
  for (const s of manifest.skills ?? []) {
    const bundleDir = join(manifest.rootPath, s.bundle);
    if (!existsSync(bundleDir)) {
      throw new MissingAnchorError(
        manifest.name,
        "skills",
        s.bundle,
        `${bundleDir} (not found)`,
      );
    }
    const sha = computeBundleHash(bundleDir);
    skillRecords.push({ bundle: s.bundle, sha256: sha, replacedClaimFrom: null });
  }
  if (skillRecords.length > 0) resources.skills = skillRecords;

  // Memory seeds: only record those whose content-hash already lives in agent_memory.
  const seedRecords: AppliedSeedRecord[] = [];
  for (const seed of manifest.memorySeeds ?? []) {
    const filePath = join(manifest.rootPath, seed.file);
    const content = readFileSync(filePath, "utf-8");
    const contentHash = sha256Text(content);
    const existing = await db
      .collection<{ _id: string; agentId: string; contentHash: string }>("agent_memory")
      .findOne({ agentId: seed.agent, contentHash });
    if (existing) {
      seedRecords.push({
        id: existing._id,
        contentHash,
        tier: seed.tier,
        agent: seed.agent,
        replacedClaimFrom: null,
      });
    }
  }
  if (seedRecords.length > 0) resources.memorySeeds = seedRecords;

  // Core servers: intersection of asset.add with agent's existing coreServers.
  const coreserversRec: Record<string, string[]> = {};
  for (const cs of manifest.coreservers ?? []) {
    const resolvedAgents = await resolveAgents(db, cs.agents);
    const coll = db.collection<AgentDefDoc>("agent_definitions");
    for (const agentId of resolvedAgents) {
      const doc = await coll.findOne({ _id: agentId });
      const have = new Set(doc?.coreServers ?? []);
      const intersect = cs.add.filter((s) => have.has(s));
      if (intersect.length === 0) continue;
      const cur = coreserversRec[agentId] ?? [];
      coreserversRec[agentId] = [...cur, ...intersect];
    }
  }
  if (Object.keys(coreserversRec).length > 0) resources.coreservers = coreserversRec;

  // Schedule: lookup each (agent, task) — record only if currently scheduled.
  const scheduleRec: Record<string, AppliedScheduleRecord[]> = {};
  for (const sched of manifest.schedule ?? []) {
    const resolvedAgents = await resolveAgents(db, sched.agents);
    const slots = resolveScheduleSlots(sched, resolvedAgents);
    const coll = db.collection<AgentDefDoc>("agent_definitions");
    for (const slot of slots) {
      const doc = await coll.findOne({ _id: slot.agentId });
      const entry = (doc?.schedule ?? []).find((e) => e.task === sched.task);
      if (!entry) continue;
      const cur = scheduleRec[slot.agentId] ?? [];
      scheduleRec[slot.agentId] = [
        ...cur,
        {
          task: sched.task,
          cron: entry.cron,
          pattern: slot.pattern,
          windowSlot: slot.windowSlot,
          replacedClaimFrom: null,
        },
      ];
    }
  }
  if (Object.keys(scheduleRec).length > 0) resources.schedule = scheduleRec;

  // Prompts: per-agent neighborhood snapshot.
  const promptRec: Record<
    string,
    { anchors: string[]; snapshotBefore: string; insertedText: Record<string, string> }
  > = {};
  for (const p of manifest.prompts ?? []) {
    const resolvedAgents = await resolveAgents(db, p.agents);
    const coll = db.collection<AgentDefDoc>("agent_definitions");
    for (const agentId of resolvedAgents) {
      const doc = await coll.findOne({ _id: agentId });
      const currentPrompt = doc?.systemPrompt ?? "";
      const neighborhood = extractAnchorNeighborhood(currentPrompt, p.anchor);
      const cur = promptRec[agentId] ?? {
        anchors: [],
        snapshotBefore: currentPrompt,
        insertedText: {},
      };
      if (cur.anchors.length === 0) cur.snapshotBefore = currentPrompt;
      cur.anchors.push(p.anchor);
      cur.insertedText[p.anchor] = neighborhood;
      promptRec[agentId] = cur;
    }
  }
  if (Object.keys(promptRec).length > 0) resources.prompts = promptRec;

  // Constitution: full document snapshot + per-anchor neighborhood (frame-scoped).
  const constitutionAnchors = (manifest.constitution ?? []).map((c) => c.anchor);
  if (constitutionAnchors.length > 0) {
    const doc = await db
      .collection<{ path: string; content: string }>("memory")
      .findOne({ path: "shared/constitution.md" });
    const fullText = doc?.content ?? "";
    const constitutionFrameAnchors = new Set(constitutionAnchors);
    const insertedText: Record<string, string> = {};
    for (const a of constitutionAnchors) {
      insertedText[a] = extractAnchorNeighborhood(fullText, a, constitutionFrameAnchors);
    }
    resources.constitution = {
      anchors: constitutionAnchors,
      snapshotBefore: fullText,
      insertedText,
    };
  }

  // Phase 2: all six asset types fully populated under --adopt.

  return {
    _id: manifest.name,
    version: manifest.version,
    appliedAt: new Date(),
    appliedBy: buildActor(),
    manifest,
    resources,
  };
}

function buildActor(): string {
  const user = process.env.USER ?? process.env.LOGNAME ?? "unknown";
  const host = hostname();
  const version = readPackageVersion();
  return `${user}@${host}+beekeeper-${version}`;
}

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // src/frames/commands -> package root is three levels up from compiled dist as well.
    // Walk up looking for package.json.
    let dir = here;
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf-8"));
        if (pkg.name === "@keepur/beekeeper" && typeof pkg.version === "string") {
          return pkg.version;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // ignore
  }
  return "unknown";
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

// Re-export verifyAnchors for tests.
export { verifyAnchors, resolveAgents, buildAdoptRecord, executeFullApply, runAdopt };
