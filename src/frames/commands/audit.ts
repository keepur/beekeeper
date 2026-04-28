import { loadConfig } from "../../config.js";
import { resolveInstance } from "../instance-resolver.js";
import { withInstanceDb } from "../mongo-client.js";
import { AppliedFramesStore } from "../applied-frames-store.js";
import { detectDrift } from "../drift-detector.js";
import type { AppliedFrameRecord, DriftDecision, DriftFinding } from "../types.js";

export interface AuditSummary {
  exitCode: 0 | 1;
  message: string;
}

/**
 * Pure helper: derive the audit exit code + console message from records and findings.
 *
 * Findings are pre-filtered against each record's `driftAccepted` decisions per spec:
 * - `keep-local`, `take-frame`, `merged` decisions suppress the finding entirely.
 * - `deferred` decisions keep the finding visible but demote it to informational
 *   (`info:`), so it doesn't trip the actionable-drift exit code.
 * - A decision whose `againstVersion` doesn't match the record's current version
 *   is treated as no-decision and re-surfaces the finding as actionable.
 *
 * Exit codes:
 * - 0 when no frames are applied, no findings exist, or only informational findings remain.
 * - 1 when one or more actionable drift findings remain.
 */
export function summarizeAudit(
  instanceId: string,
  recordCount: number,
  findings: DriftFinding[],
): AuditSummary {
  if (recordCount === 0) {
    return {
      exitCode: 0,
      message: `No frames applied to "${instanceId}". Nothing to audit.`,
    };
  }
  const actionable = findings.filter((f) => !f.informational);
  const informational = findings.filter((f) => f.informational);
  if (findings.length === 0) {
    return {
      exitCode: 0,
      message: `Audit clean: ${recordCount} frame(s) applied, no drift detected.`,
    };
  }
  const lines: string[] = [
    `Audit found ${actionable.length} actionable + ${informational.length} informational drift item(s):`,
    "",
  ];
  for (const f of actionable) {
    lines.push(`  drift: [${f.kind}] ${f.frame} -> ${f.resource}: ${f.detail}`);
  }
  for (const f of informational) {
    lines.push(`  info: [${f.kind}] ${f.frame} -> ${f.resource}: ${f.detail}`);
  }
  return {
    exitCode: actionable.length > 0 ? 1 : 0,
    message: lines.join("\n"),
  };
}

/**
 * Apply per-record `driftAccepted` filtering to a raw set of detector findings.
 *
 * Decision lookup is keyed by the canonical `resource` string (produced by
 * `text-utils.resourceKey`) — the same identifier the detector emits and the
 * dialog records.
 */
export function applyDriftDecisions(
  record: AppliedFrameRecord,
  findings: DriftFinding[],
): DriftFinding[] {
  const decisions = record.driftAccepted ?? [];
  const out: DriftFinding[] = [];
  for (const f of findings) {
    const decision = pickDecisionForResource(decisions, f.resource);
    if (!decision) {
      out.push(f);
      continue;
    }
    if (decision.againstVersion !== undefined && decision.againstVersion !== record.version) {
      // Frame moved past the version this decision was made against — re-surface.
      out.push(f);
      continue;
    }
    if (decision.againstVersion === undefined) {
      // Older record without version pinning — treat as "ask again".
      out.push(f);
      continue;
    }
    if (decision.decision === "deferred") {
      out.push({ ...f, informational: true });
      continue;
    }
    // keep-local / take-frame / merged: silently honored.
  }
  return out;
}

function pickDecisionForResource(
  decisions: DriftDecision[],
  resource: string,
): DriftDecision | undefined {
  // Latest decision wins if multiple recorded for the same resource.
  let chosen: DriftDecision | undefined;
  for (const d of decisions) {
    if (d.resource !== resource) continue;
    if (!chosen || d.decidedAt > chosen.decidedAt) {
      chosen = d;
    }
  }
  return chosen;
}

export async function auditInstance(instanceId: string): Promise<number> {
  const config = loadConfig();
  const instance = resolveInstance(config, instanceId);

  return await withInstanceDb(instance, async (db) => {
    const store = new AppliedFramesStore(db);
    const records = await store.list();

    const findings: DriftFinding[] = [];
    for (const rec of records) {
      const raw = await detectDrift(db, rec, instance.servicePath);
      findings.push(...applyDriftDecisions(rec, raw));
    }

    const summary = summarizeAudit(instanceId, records.length, findings);
    console.log(summary.message);
    return summary.exitCode;
  });
}
