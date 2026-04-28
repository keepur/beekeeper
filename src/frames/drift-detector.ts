import type { Db } from "mongodb";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { collectAnchorSet } from "./anchor-resolver.js";
import { computeBundleHash, extractAnchorNeighborhood, resourceKey } from "./text-utils.js";
import type { AppliedFrameRecord, DriftFinding } from "./types.js";

interface ConstitutionDoc {
  path: string;
  content: string;
}

interface AgentDefDoc {
  _id: string;
  coreServers?: string[];
  systemPrompt?: string;
  schedule?: Array<{ task: string; cron: string }>;
}

interface AgentMemoryDoc {
  _id: string;
}

export async function detectDrift(
  db: Db,
  record: AppliedFrameRecord,
  servicePath: string,
): Promise<DriftFinding[]> {
  const findings: DriftFinding[] = [];

  await checkConstitution(db, record, findings);
  checkSkills(record, servicePath, findings);
  await checkCoreServers(db, record, findings);
  await checkSchedule(db, record, findings);
  await checkPrompts(db, record, findings);
  await checkMemorySeeds(db, record, findings);

  return findings;
}

async function checkConstitution(
  db: Db,
  record: AppliedFrameRecord,
  findings: DriftFinding[],
): Promise<void> {
  const block = record.resources.constitution;
  if (!block) return;
  const doc = await db
    .collection<ConstitutionDoc>("memory")
    .findOne({ path: "shared/constitution.md" });
  const content = doc?.content ?? "";
  let present: Set<string>;
  try {
    present = collectAnchorSet(content);
  } catch {
    present = new Set();
  }
  const frameAnchors = new Set(
    (record.manifest.constitution ?? []).map((c) => c.anchor),
  );
  for (const anchor of block.anchors) {
    if (!present.has(anchor)) {
      findings.push({
        frame: record._id,
        kind: "constitution-anchor-missing",
        resource: resourceKey("constitution", anchor),
        detail: `frame "${record._id}" anchor "${anchor}" missing from shared/constitution.md`,
        informational: false,
      });
      continue;
    }
    const expected = block.insertedText[anchor] ?? "";
    const actual = extractAnchorNeighborhood(content, anchor, frameAnchors);
    if (actual !== expected) {
      findings.push({
        frame: record._id,
        kind: "constitution-text-changed",
        resource: resourceKey("constitution", anchor),
        detail: `frame "${record._id}" constitution anchor "${anchor}" text diverged from snapshot`,
        informational: false,
      });
    }
  }
}

function checkSkills(
  record: AppliedFrameRecord,
  servicePath: string,
  findings: DriftFinding[],
): void {
  for (const skill of record.resources.skills ?? []) {
    const dest = join(servicePath, "skills", basename(skill.bundle));
    if (!existsSync(dest)) {
      findings.push({
        frame: record._id,
        kind: "skill-missing",
        resource: resourceKey("skills", skill.bundle),
        detail: `frame "${record._id}" skill bundle "${skill.bundle}" missing at ${dest}`,
        informational: false,
      });
      continue;
    }
    const currentHash = computeBundleHash(dest);
    if (currentHash !== skill.sha256) {
      findings.push({
        frame: record._id,
        kind: "skill-modified-locally",
        resource: resourceKey("skills", skill.bundle),
        detail: `frame "${record._id}" skill bundle "${skill.bundle}" hash ${currentHash.slice(0, 8)} differs from recorded ${skill.sha256.slice(0, 8)}`,
        informational: false,
      });
    }
    if (skill.replacedClaimFrom) {
      findings.push({
        frame: record._id,
        kind: "overridden-claim",
        resource: resourceKey("skills", skill.bundle),
        detail: `frame "${record._id}" skill bundle "${skill.bundle}" overrides peer frame "${skill.replacedClaimFrom}"`,
        informational: true,
      });
    }
  }
}

async function checkCoreServers(
  db: Db,
  record: AppliedFrameRecord,
  findings: DriftFinding[],
): Promise<void> {
  const block = record.resources.coreservers;
  if (!block) return;
  const coll = db.collection<AgentDefDoc>("agent_definitions");
  for (const [agentId, servers] of Object.entries(block)) {
    if (servers.length === 0) continue;
    const doc = await coll.findOne({ _id: agentId });
    const present = new Set(doc?.coreServers ?? []);
    for (const server of servers) {
      if (!present.has(server)) {
        findings.push({
          frame: record._id,
          kind: "coreserver-missing",
          resource: resourceKey("coreservers", agentId, server),
          detail: `frame "${record._id}" coreServer "${server}" missing from agent_definitions[${agentId}].coreServers`,
          informational: false,
        });
      }
    }
  }
}

async function checkSchedule(
  db: Db,
  record: AppliedFrameRecord,
  findings: DriftFinding[],
): Promise<void> {
  const block = record.resources.schedule;
  if (!block) return;
  const coll = db.collection<AgentDefDoc>("agent_definitions");
  for (const [agentId, entries] of Object.entries(block)) {
    if (entries.length === 0) continue;
    const doc = await coll.findOne({ _id: agentId });
    const tasks = new Set((doc?.schedule ?? []).map((e) => e.task));
    for (const entry of entries) {
      if (!tasks.has(entry.task)) {
        findings.push({
          frame: record._id,
          kind: "schedule-missing",
          resource: resourceKey("schedule", agentId, entry.task),
          detail: `frame "${record._id}" schedule task "${entry.task}" missing from agent_definitions[${agentId}].schedule`,
          informational: false,
        });
      }
      if (entry.replacedClaimFrom) {
        findings.push({
          frame: record._id,
          kind: "overridden-claim",
          resource: resourceKey("schedule", agentId, entry.task),
          detail: `frame "${record._id}" schedule task "${entry.task}" on agent "${agentId}" overrides peer frame "${entry.replacedClaimFrom}"`,
          informational: true,
        });
      }
    }
  }
}

async function checkPrompts(
  db: Db,
  record: AppliedFrameRecord,
  findings: DriftFinding[],
): Promise<void> {
  const block = record.resources.prompts;
  if (!block) return;
  const coll = db.collection<AgentDefDoc>("agent_definitions");
  for (const [agentId, promptBlock] of Object.entries(block)) {
    const doc = await coll.findOne({ _id: agentId });
    const currentPrompt = doc?.systemPrompt ?? "";
    let present: Set<string>;
    try {
      present = collectAnchorSet(currentPrompt);
    } catch {
      present = new Set();
    }
    for (const anchor of promptBlock.anchors) {
      if (!present.has(anchor)) {
        findings.push({
          frame: record._id,
          kind: "prompt-anchor-missing",
          resource: resourceKey("prompts", agentId, anchor),
          detail: `frame "${record._id}" prompt anchor "${anchor}" missing from agent_definitions[${agentId}].systemPrompt`,
          informational: false,
        });
        continue;
      }
      const expected = promptBlock.insertedText[anchor] ?? "";
      if (!currentPrompt.includes(expected)) {
        findings.push({
          frame: record._id,
          kind: "prompt-text-changed",
          resource: resourceKey("prompts", agentId, anchor),
          detail: `frame "${record._id}" prompt clause for anchor "${anchor}" on agent "${agentId}" no longer present verbatim`,
          informational: false,
        });
      }
    }
  }
}

async function checkMemorySeeds(
  db: Db,
  record: AppliedFrameRecord,
  findings: DriftFinding[],
): Promise<void> {
  const seeds = record.resources.memorySeeds;
  if (!seeds) return;
  const coll = db.collection<AgentMemoryDoc>("agent_memory");
  for (const seed of seeds) {
    const exists = await coll.findOne({ _id: seed.id }, { projection: { _id: 1 } });
    if (!exists) {
      findings.push({
        frame: record._id,
        kind: "seed-missing",
        resource: resourceKey("seeds", seed.agent, seed.contentHash),
        detail: `frame "${record._id}" memory seed for agent "${seed.agent}" (id ${seed.id}) missing from agent_memory`,
        informational: false,
      });
    }
    if (seed.replacedClaimFrom) {
      findings.push({
        frame: record._id,
        kind: "overridden-claim",
        resource: resourceKey("seeds", seed.agent, seed.contentHash),
        detail: `frame "${record._id}" memory seed for agent "${seed.agent}" overrides peer frame "${seed.replacedClaimFrom}"`,
        informational: true,
      });
    }
  }
}
