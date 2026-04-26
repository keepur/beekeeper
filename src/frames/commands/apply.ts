import { loadConfig } from "../../config.js";
import { resolveInstance } from "../instance-resolver.js";
import { withInstanceDb } from "../mongo-client.js";
import { AppliedFramesStore } from "../applied-frames-store.js";
import { loadManifest } from "../manifest-loader.js";
import { collectAnchorSet } from "../anchor-resolver.js";
import { MissingAnchorError } from "../errors.js";
import type { AppliedFrameRecord, AppliedResources, FrameManifest } from "../types.js";
import type { Db } from "mongodb";

export interface ApplyOptions {
  adopt: boolean;
}

export async function applyFrame(
  framePath: string,
  instanceId: string,
  opts: ApplyOptions,
): Promise<number> {
  if (!opts.adopt) {
    console.error(
      "Asset-write apply is not implemented in this plan. Pass --adopt to record the current instance state as conformant to this frame.",
    );
    return 2;
  }

  const config = loadConfig();
  const instance = resolveInstance(config, instanceId);
  const manifest = loadManifest(framePath);

  return await withInstanceDb(instance, async (db) => {
    const store = new AppliedFramesStore(db);

    // Conflict check: same name not already applied at a different version.
    const existing = await store.get(manifest.name);
    if (existing && existing.version === manifest.version) {
      console.log(
        `Frame "${manifest.name}" v${manifest.version} already adopted on "${instanceId}". No change.`,
      );
      return 0;
    }

    // Resolvability checks (adopt: anchors must exist, but do not check ownership).
    await verifyAnchors(db, manifest);

    // Build the record from current state.
    const record = await buildAdoptRecord(db, manifest);
    await store.upsert(record);

    console.log(`Adopted frame "${manifest.name}" v${manifest.version} on "${instanceId}".`);
    console.log(
      `Snapshot recorded; future audit/apply will compare against this baseline. No assets were written.`,
    );
    return 0;
  });
}

async function verifyAnchors(db: Db, manifest: FrameManifest): Promise<void> {
  // Collect both the frame's own anchors and any targetAnchor used in insert specs.
  // For replace-anchor the target equals the frame's anchor; for after/before/append-to
  // the target is a different anchor that must already exist in the doc.
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
    const present = collectAnchorSet(doc.content);
    for (const a of constitutionRequired) {
      if (!present.has(a)) {
        throw new MissingAnchorError(manifest.name, "constitution", a, "shared/constitution.md");
      }
    }
  }

  // Per-agent prompt anchors.
  const promptAnchorsByAgent = new Map<string, string[]>();
  for (const p of manifest.prompts ?? []) {
    for (const agent of p.agents) {
      // Wildcards skipped in Phase-1 adopt; manifest authors must list explicit ids.
      if (agent === "*") continue;
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
      const present = collectAnchorSet(text);
      for (const a of anchors) {
        if (!present.has(a)) {
          throw new MissingAnchorError(manifest.name, `prompts:${agentId}`, a, `agent_definitions[${agentId}].systemPrompt`);
        }
      }
    }
  }
}

async function buildAdoptRecord(db: Db, manifest: FrameManifest): Promise<AppliedFrameRecord> {
  const resources: AppliedResources = {};

  const constitutionAnchors = (manifest.constitution ?? []).map((c) => c.anchor);
  if (constitutionAnchors.length > 0) {
    const doc = await db
      .collection<{ path: string; content: string }>("memory")
      .findOne({ path: "shared/constitution.md" });
    const fullText = doc?.content ?? "";
    const insertedText: Record<string, string> = {};
    for (const a of constitutionAnchors) {
      insertedText[a] = extractAnchorNeighborhood(fullText, a);
    }
    resources.constitution = {
      anchors: constitutionAnchors,
      snapshotBefore: fullText,
      insertedText,
    };
  }

  // Other asset types under adopt: not populated in this plan. Subsequent plans
  // extend the adopt path to snapshot coreservers/schedule/prompts/seeds/skills.

  return {
    _id: manifest.name,
    version: manifest.version,
    appliedAt: new Date(),
    appliedBy: `beekeeper@${process.env.USER ?? "unknown"}`,
    manifest,
    resources,
  };
}

/**
 * Extract the text from `<a id="anchor">` to the next anchor (or end-of-document).
 * Returns empty string if anchor is not found.
 */
export function extractAnchorNeighborhood(markdown: string, anchor: string): string {
  const startRe = new RegExp(`<a\\s+id\\s*=\\s*"${escapeRe(anchor)}"\\s*(?:/?>\\s*</a>|/>|>)`);
  const startMatch = markdown.match(startRe);
  if (!startMatch || startMatch.index === undefined) return "";
  const startIdx = startMatch.index;
  const afterStart = startIdx + startMatch[0].length;
  const nextAnchorRe = /<a\s+id\s*=\s*"[^"]+"\s*(?:\/?>\s*<\/a>|\/>|>)/g;
  nextAnchorRe.lastIndex = afterStart;
  const next = nextAnchorRe.exec(markdown);
  const endIdx = next?.index ?? markdown.length;
  return markdown.slice(startIdx, endIdx);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
