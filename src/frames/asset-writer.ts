import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { ulid } from "ulid";
import type { Db } from "mongodb";
import { AppliedFramesStore } from "./applied-frames-store.js";
import { FrameError } from "./errors.js";
import {
  computeBundleHash,
  escapeRe,
  extractAnchorNeighborhood,
  sha256Text,
} from "./text-utils.js";
import type {
  AppliedScheduleRecord,
  AppliedSeedRecord,
  AppliedSkillRecord,
  ConstitutionInsertMode,
  CoreServerAsset,
  FrameManifest,
  MemorySeedAsset,
  ScheduleAsset,
} from "./types.js";

export class ConflictError extends FrameError {
  constructor(
    public readonly resource: string,
    public readonly peerFrame: string,
    detail: string,
  ) {
    super(`Conflict on ${resource}: peer frame "${peerFrame}" already claims it. ${detail}`);
    this.name = "ConflictError";
  }
}

// ---------------------------------------------------------------- skill bundles

export async function writeSkillBundle(
  db: Db,
  manifest: FrameManifest,
  bundle: string,
  servicePath: string,
  opts: { forceOverride?: boolean } = {},
): Promise<AppliedSkillRecord> {
  const store = new AppliedFramesStore(db);
  const src = join(manifest.rootPath, bundle);
  const dest = join(servicePath, "skills", basename(bundle));

  const sha = computeBundleHash(src);

  const peers = (await store.findClaimsForSkill(bundle)).filter((p) => p._id !== manifest.name);
  let replacedClaimFrom: string | null = null;
  for (const peer of peers) {
    const peerSkill = (peer.resources.skills ?? []).find((s) => s.bundle === bundle);
    if (!peerSkill) continue;
    if (peerSkill.sha256 === sha) continue;
    if (!opts.forceOverride) {
      throw new ConflictError(
        `skills:${basename(bundle)}`,
        peer._id,
        `peer hash ${peerSkill.sha256.slice(0, 8)} differs from new hash ${sha.slice(0, 8)}. Pass --force-override to replace.`,
      );
    }
    replacedClaimFrom = peer._id;
  }

  cpSync(src, dest, { recursive: true });

  return { bundle, sha256: sha, replacedClaimFrom };
}

export async function removeSkillBundle(
  db: Db,
  record: AppliedSkillRecord,
  frameName: string,
  servicePath: string,
): Promise<void> {
  const store = new AppliedFramesStore(db);
  const peers = (await store.findClaimsForSkill(record.bundle)).filter((p) => p._id !== frameName);
  if (peers.length > 0) return;
  const dest = join(servicePath, "skills", basename(record.bundle));
  if (!existsSync(dest)) return;
  const currentHash = computeBundleHash(dest);
  if (currentHash !== record.sha256) {
    process.stderr.write(
      `warn: skill bundle ${record.bundle} hash diverged from recorded sha; removing anyway\n`,
    );
  }
  rmSync(dest, { recursive: true, force: true });
}

// ---------------------------------------------------------------- memory seeds

interface AgentMemoryDoc {
  _id: string;
  agentId: string;
  content: string;
  tier: "hot" | "warm" | "cold";
  contentHash: string;
}

export async function writeMemorySeed(
  db: Db,
  manifest: FrameManifest,
  seed: MemorySeedAsset,
  opts: { allowSeedOverride?: boolean } = {},
): Promise<AppliedSeedRecord> {
  const store = new AppliedFramesStore(db);
  const filePath = join(manifest.rootPath, seed.file);
  const content = readFileSync(filePath, "utf-8");
  const contentHash = sha256Text(content);

  const existing = await db
    .collection<AgentMemoryDoc>("agent_memory")
    .findOne({ agentId: seed.agent, contentHash });
  if (existing) {
    return {
      id: existing._id,
      contentHash,
      tier: seed.tier,
      agent: seed.agent,
      replacedClaimFrom: null,
    };
  }

  const peers = (await store.findClaimsForSeedAgent(seed.agent)).filter(
    (p) => p._id !== manifest.name,
  );
  let replacedClaimFrom: string | null = null;
  for (const peer of peers) {
    const peerSeeds = (peer.resources.memorySeeds ?? []).filter((s) => s.agent === seed.agent);
    const conflicting = peerSeeds.find((s) => s.contentHash !== contentHash);
    if (!conflicting) continue;
    if (!opts.allowSeedOverride) {
      throw new ConflictError(
        `seeds:${seed.agent}:${contentHash.slice(0, 8)}`,
        peer._id,
        `peer seed for agent "${seed.agent}" has different content. Pass --allow-seed-override to add anyway.`,
      );
    }
    replacedClaimFrom = peer._id;
    break;
  }

  const id = ulid();
  await db.collection<AgentMemoryDoc>("agent_memory").insertOne({
    _id: id,
    agentId: seed.agent,
    content,
    tier: seed.tier,
    contentHash,
  });

  return { id, contentHash, tier: seed.tier, agent: seed.agent, replacedClaimFrom };
}

export async function removeMemorySeed(
  db: Db,
  seedRec: AppliedSeedRecord,
  frameName: string,
): Promise<void> {
  const store = new AppliedFramesStore(db);
  const peers = (await store.findClaimsForSeedAgent(seedRec.agent)).filter(
    (p) => p._id !== frameName,
  );
  for (const peer of peers) {
    const peerSeeds = (peer.resources.memorySeeds ?? []).filter(
      (s) => s.agent === seedRec.agent && s.contentHash === seedRec.contentHash,
    );
    if (peerSeeds.length > 0) return;
  }
  await db.collection<AgentMemoryDoc>("agent_memory").deleteOne({ _id: seedRec.id });
}

// ---------------------------------------------------------------- core servers

interface AgentDefDoc {
  _id: string;
  coreServers?: string[];
  systemPrompt?: string;
  schedule?: Array<{ task: string; cron: string }>;
}

export async function writeCoreServers(
  db: Db,
  asset: CoreServerAsset,
  resolvedAgents: string[],
): Promise<Record<string, string[]>> {
  const coll = db.collection<AgentDefDoc>("agent_definitions");
  const added: Record<string, string[]> = {};
  for (const agentId of resolvedAgents) {
    const doc = await coll.findOne({ _id: agentId });
    const existing = new Set(doc?.coreServers ?? []);
    const toAdd = asset.add.filter((s) => !existing.has(s));
    if (toAdd.length === 0) continue;
    await coll.updateOne(
      { _id: agentId },
      { $addToSet: { coreServers: { $each: toAdd } } },
    );
    added[agentId] = toAdd;
  }
  return added;
}

export async function removeCoreServers(
  db: Db,
  coreserversResource: Record<string, string[]>,
): Promise<void> {
  const coll = db.collection<AgentDefDoc>("agent_definitions");
  for (const [agentId, servers] of Object.entries(coreserversResource)) {
    if (servers.length === 0) continue;
    await coll.updateOne({ _id: agentId }, { $pullAll: { coreServers: servers } });
  }
}

// ---------------------------------------------------------------- schedule

const DAY_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

export interface ResolvedScheduleSlot {
  agentId: string;
  cron: string;
  pattern: "explicit" | "shared" | "stagger";
  windowSlot: number | null;
}

export function resolveScheduleSlots(
  asset: ScheduleAsset,
  resolvedAgents: string[],
): ResolvedScheduleSlot[] {
  if (!asset.pattern) {
    if (!asset.cron) {
      throw new Error(
        `schedule "${asset.task}": explicit pattern requires a 'cron' field`,
      );
    }
    return resolvedAgents.map((agentId) => ({
      agentId,
      cron: asset.cron as string,
      pattern: "explicit",
      windowSlot: null,
    }));
  }

  if (asset.pattern === "shared") {
    if (!asset.cron) {
      throw new Error(`schedule "${asset.task}": pattern "shared" requires a 'cron' field`);
    }
    return resolvedAgents.map((agentId) => ({
      agentId,
      cron: asset.cron as string,
      pattern: "shared",
      windowSlot: null,
    }));
  }

  // stagger
  if (!asset.window || !asset.interval) {
    throw new Error(
      `schedule "${asset.task}": pattern "stagger" requires 'window' and 'interval' fields`,
    );
  }
  const win = parseStaggerWindow(asset.window, asset.task);
  const intervalMin = parseIntervalMinutes(asset.interval, asset.task);
  const durationMin = win.endMin - win.startMin;
  if (durationMin <= 0) {
    throw new Error(
      `schedule "${asset.task}": window end must be after start (got "${asset.window}")`,
    );
  }
  const slotCount = Math.floor(durationMin / intervalMin);
  if (resolvedAgents.length > slotCount) {
    throw new Error(
      `schedule "${asset.task}": ${resolvedAgents.length} agents but only ${slotCount} stagger slots in window "${asset.window}" with interval "${asset.interval}"`,
    );
  }
  const sorted = [...resolvedAgents].sort();
  return sorted.map((agentId, i) => {
    const offset = win.startMin + i * intervalMin;
    const h = Math.floor(offset / 60);
    const m = offset % 60;
    return {
      agentId,
      cron: `${m} ${h} * * ${win.dayNum}`,
      pattern: "stagger",
      windowSlot: i,
    };
  });
}

interface ParsedWindow {
  dayNum: number;
  startMin: number;
  endMin: number;
}

function parseStaggerWindow(window: string, task: string): ParsedWindow {
  const trimmed = window.trim();
  // <day> HH:MM-HH:MM [<iana-tz>]
  const m = trimmed.match(
    /^([a-zA-Z]{3})\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})(?:\s+(\S+))?$/,
  );
  if (!m) {
    throw new Error(
      `schedule "${task}": window must be '<day> HH:MM-HH:MM [<iana-tz>]'; got "${window}"`,
    );
  }
  const [, dayRaw, h1, m1, h2, m2, tzRaw] = m;
  const dayNum = DAY_NAMES[dayRaw.toLowerCase()];
  if (dayNum === undefined) {
    throw new Error(
      `schedule "${task}": unknown day "${dayRaw}" — use mon|tue|wed|thu|fri|sat|sun`,
    );
  }
  if (tzRaw !== undefined) {
    validateIanaTz(tzRaw, task);
  }
  return {
    dayNum,
    startMin: Number(h1) * 60 + Number(m1),
    endMin: Number(h2) * 60 + Number(m2),
  };
}

function validateIanaTz(tz: string, task: string): void {
  if (!tz.includes("/")) {
    throw new Error(
      `schedule "${task}": timezone "${tz}" is not a canonical IANA zone (e.g. America/Los_Angeles). Abbreviations like PT/EST/UTC-7 are not accepted.`,
    );
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(
      `schedule "${task}": timezone "${tz}" is not a recognized IANA zone (e.g. America/Los_Angeles).`,
    );
  }
}

function parseIntervalMinutes(interval: string, task: string): number {
  const m = interval.trim().match(/^(\d+)m$/);
  if (!m) {
    throw new Error(`schedule "${task}": interval must be 'NNm' (minutes); got "${interval}"`);
  }
  const n = Number(m[1]);
  if (n <= 0) {
    throw new Error(`schedule "${task}": interval must be > 0; got "${interval}"`);
  }
  return n;
}

export async function writeScheduleEntry(
  db: Db,
  agentId: string,
  task: string,
  cron: string,
  pattern: "explicit" | "shared" | "stagger",
  windowSlot: number | null,
  frameName: string,
  opts: { forceOverride?: boolean } = {},
): Promise<AppliedScheduleRecord> {
  const store = new AppliedFramesStore(db);
  const peers = (await store.findClaimsForSchedule(agentId, task)).filter(
    (p) => p._id !== frameName,
  );
  let replacedClaimFrom: string | null = null;
  for (const peer of peers) {
    const peerEntries = peer.resources.schedule?.[agentId] ?? [];
    const conflicting = peerEntries.find((e) => e.task === task);
    if (!conflicting) continue;
    if (!opts.forceOverride) {
      throw new ConflictError(
        `schedule:${agentId}:${task}`,
        peer._id,
        `peer cron "${conflicting.cron}" already claims (${agentId}, ${task}). Pass --force-override to replace.`,
      );
    }
    replacedClaimFrom = peer._id;
    break;
  }

  const coll = db.collection<AgentDefDoc>("agent_definitions");
  await coll.updateOne({ _id: agentId }, { $pull: { schedule: { task } } });
  await coll.updateOne(
    { _id: agentId },
    { $push: { schedule: { task, cron } } },
    { upsert: true },
  );

  return { task, cron, pattern, windowSlot, replacedClaimFrom };
}

export async function removeScheduleEntry(
  db: Db,
  agentId: string,
  entry: AppliedScheduleRecord,
): Promise<void> {
  const coll = db.collection<AgentDefDoc>("agent_definitions");
  await coll.updateOne({ _id: agentId }, { $pull: { schedule: { task: entry.task } } });
}

// ---------------------------------------------------------------- prompts

export async function writePromptClause(
  db: Db,
  agentId: string,
  anchor: string,
  clauseText: string,
): Promise<{ snapshotBefore: string; insertedText: string }> {
  const coll = db.collection<AgentDefDoc>("agent_definitions");
  const doc = await coll.findOne({ _id: agentId });
  const before = doc?.systemPrompt ?? "";
  const startRe = new RegExp(`<a\\s+id\\s*=\\s*"${escapeRe(anchor)}"\\s*(?:/?>\\s*</a>|/>|>)`);
  const match = before.match(startRe);
  if (!match || match.index === undefined) {
    throw new Error(
      `prompt anchor "${anchor}" not found in agent_definitions[${agentId}].systemPrompt`,
    );
  }
  const insertAt = match.index + match[0].length;
  const insertedText = `\n${clauseText}`;
  const updated = before.slice(0, insertAt) + insertedText + before.slice(insertAt);
  await coll.updateOne({ _id: agentId }, { $set: { systemPrompt: updated } });
  return { snapshotBefore: before, insertedText };
}

export async function removePromptClause(
  db: Db,
  agentId: string,
  anchor: string,
  insertedText: string,
  snapshotBefore: string,
  currentPrompt: string,
): Promise<void> {
  const coll = db.collection<AgentDefDoc>("agent_definitions");
  void anchor;
  if (currentPrompt.includes(insertedText)) {
    const expected = snapshotBefore;
    const naive = currentPrompt.replace(insertedText, "");
    if (naive === expected) {
      await coll.updateOne({ _id: agentId }, { $set: { systemPrompt: snapshotBefore } });
      return;
    }
    await coll.updateOne({ _id: agentId }, { $set: { systemPrompt: naive } });
    process.stderr.write(
      `warn: prompt for "${agentId}" diverged around anchor; removed inserted clause but surrounding context shifted\n`,
    );
    return;
  }
  process.stderr.write(
    `warn: prompt for "${agentId}" no longer contains the inserted clause verbatim; nothing to remove\n`,
  );
}

// ---------------------------------------------------------------- constitution

interface ConstitutionDoc {
  path: string;
  content: string;
}

export async function writeConstitutionAnchor(
  db: Db,
  anchor: string,
  insertMode: ConstitutionInsertMode,
  targetAnchor: string | undefined,
  fragmentText: string,
): Promise<{ snapshotBefore: string; insertedText: string }> {
  const coll = db.collection<ConstitutionDoc>("memory");
  const doc = await coll.findOne({ path: "shared/constitution.md" });
  const before = doc?.content ?? "";

  let updated: string;
  if (insertMode === "replace-anchor") {
    const block = extractAnchorNeighborhood(before, anchor);
    if (!block) {
      throw new Error(`constitution anchor "${anchor}" not found for replace-anchor`);
    }
    const idx = before.indexOf(block);
    updated = before.slice(0, idx) + fragmentText + before.slice(idx + block.length);
  } else {
    if (!targetAnchor) {
      throw new Error(
        `constitution insert mode "${insertMode}" requires a targetAnchor`,
      );
    }
    const targetBlock = extractAnchorNeighborhood(before, targetAnchor);
    if (!targetBlock) {
      throw new Error(`constitution targetAnchor "${targetAnchor}" not found`);
    }
    const targetStart = before.indexOf(targetBlock);
    const targetEnd = targetStart + targetBlock.length;
    if (insertMode === "before-anchor") {
      updated = before.slice(0, targetStart) + fragmentText + before.slice(targetStart);
    } else {
      // after-anchor and append-to-anchor both insert at the end of targetAnchor's block.
      const insertion = `\n\n${fragmentText}\n`;
      updated = before.slice(0, targetEnd) + insertion + before.slice(targetEnd);
    }
  }

  await coll.updateOne(
    { path: "shared/constitution.md" },
    { $set: { content: updated } },
    { upsert: true },
  );

  const insertedText = extractAnchorNeighborhood(updated, anchor);
  return { snapshotBefore: before, insertedText };
}

export async function removeConstitutionAnchor(
  db: Db,
  snapshotBefore: string,
): Promise<void> {
  const coll = db.collection<ConstitutionDoc>("memory");
  await coll.updateOne(
    { path: "shared/constitution.md" },
    { $set: { content: snapshotBefore } },
    { upsert: true },
  );
}
