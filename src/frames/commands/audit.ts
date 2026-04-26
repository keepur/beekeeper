import type { Db } from "mongodb";
import { loadConfig } from "../../config.js";
import { resolveInstance } from "../instance-resolver.js";
import { withInstanceDb } from "../mongo-client.js";
import { AppliedFramesStore } from "../applied-frames-store.js";
import { collectAnchorSet } from "../anchor-resolver.js";
import type { AppliedFrameRecord } from "../types.js";

export interface AuditFinding {
  frame: string;
  resource: string;
  kind: "missing-anchor" | "missing-seed";
  detail: string;
}

export interface AuditSummary {
  exitCode: 0 | 1;
  message: string;
}

/**
 * Pure helper: derive the audit exit code + console message from records and findings.
 *
 * Exit codes:
 * - 0 when no frames are applied (nothing to audit) or when no findings exist (clean).
 * - 1 when one or more drift findings exist — non-zero so CI / `frame audit` callers
 *   can gate on drift.
 */
export function summarizeAudit(
  instanceId: string,
  recordCount: number,
  findings: AuditFinding[],
): AuditSummary {
  if (recordCount === 0) {
    return {
      exitCode: 0,
      message: `No frames applied to "${instanceId}". Nothing to audit.`,
    };
  }
  if (findings.length === 0) {
    return {
      exitCode: 0,
      message: `Audit clean: ${recordCount} frame(s) applied, no drift detected.`,
    };
  }
  const lines = [`Audit found ${findings.length} drift item(s):`, ""];
  for (const f of findings) {
    lines.push(`  [${f.kind}] ${f.frame} -> ${f.resource}: ${f.detail}`);
  }
  return {
    exitCode: 1,
    message: lines.join("\n"),
  };
}

export async function auditInstance(instanceId: string): Promise<number> {
  const config = loadConfig();
  const instance = resolveInstance(config, instanceId);

  return await withInstanceDb(instance, async (db) => {
    const store = new AppliedFramesStore(db);
    const records = await store.list();

    const findings: AuditFinding[] = [];
    for (const rec of records) {
      findings.push(...(await auditFrame(db, rec)));
    }

    const summary = summarizeAudit(instanceId, records.length, findings);
    console.log(summary.message);
    return summary.exitCode;
  });
}

async function auditFrame(
  db: Db,
  record: AppliedFrameRecord,
): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];

  // Constitution anchor presence check.
  // Mirror verifyAnchors() in apply.ts: include both c.anchor (the frame's own
  // declared anchor) and c.targetAnchor (the structural anchor a replace/after/before
  // insert depends on). Both must remain present for the frame's insertion to be
  // reverse-able and audit-meaningful.
  const constitutionAnchors = new Set<string>();
  for (const c of record.manifest.constitution ?? []) {
    constitutionAnchors.add(c.anchor);
    if (c.targetAnchor) constitutionAnchors.add(c.targetAnchor);
  }
  if (constitutionAnchors.size > 0) {
    const doc = await db.collection<{ path: string; content: string }>("memory").findOne({
      path: "shared/constitution.md",
    });
    if (!doc) {
      findings.push({
        frame: record._id,
        resource: "constitution",
        kind: "missing-anchor",
        detail: "shared/constitution.md not found in db.memory",
      });
    } else {
      let present: Set<string>;
      try {
        present = collectAnchorSet(doc.content);
      } catch (err) {
        findings.push({
          frame: record._id,
          resource: "constitution",
          kind: "missing-anchor",
          detail: `anchor scan failed: ${(err as Error).message}`,
        });
        present = new Set();
      }
      for (const a of constitutionAnchors) {
        if (!present.has(a)) {
          findings.push({
            frame: record._id,
            resource: `constitution:${a}`,
            kind: "missing-anchor",
            detail: `anchor "${a}" not present in shared/constitution.md`,
          });
        }
      }
    }
  }

  // Memory-seed presence check.
  for (const seed of record.resources.memorySeeds ?? []) {
    const exists = await db.collection<{ _id: string }>("agent_memory").findOne(
      { _id: seed.id },
      { projection: { _id: 1 } },
    );
    if (!exists) {
      findings.push({
        frame: record._id,
        resource: `memory-seed:${seed.id}`,
        kind: "missing-seed",
        detail: `agent_memory record ${seed.id} no longer present`,
      });
    }
  }

  return findings;
}
