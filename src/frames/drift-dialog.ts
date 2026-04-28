import { createInterface } from "node:readline/promises";
import type { Db } from "mongodb";
import { AppliedFramesStore } from "./applied-frames-store.js";
import type { AppliedFrameRecord, DriftDecision, DriftFinding } from "./types.js";

export interface DialogResult {
  decision: DriftDecision["decision"];
  finding: DriftFinding;
  mergedText?: string;
}

export interface DialogReturn {
  results: DialogResult[];
  /** New decisions appended in this session, in the order they were $push-ed.
   *  Caller concatenates with the existingDecisions snapshot taken before the
   *  dialog ran, then stages the combined array on the AppliedFrameRecord
   *  before the upsert in Task 7 step 7. */
  newDecisions: DriftDecision[];
}

export async function runDriftDialog(
  db: Db,
  record: AppliedFrameRecord,
  findings: DriftFinding[],
  opts: { yes: boolean; actor: string },
): Promise<DialogReturn> {
  const store = new AppliedFramesStore(db);
  const results: DialogResult[] = [];
  const newDecisions: DriftDecision[] = [];

  const actionable = findings.filter((f) => !f.informational);
  const existingDecisions = record.driftAccepted ?? [];
  const seenAtVersion = new Set<string>();
  for (const d of existingDecisions) {
    if (d.againstVersion === record.version) {
      seenAtVersion.add(d.resource);
    }
  }

  const remaining = actionable.filter((f) => !seenAtVersion.has(f.resource));
  for (const f of actionable) {
    if (seenAtVersion.has(f.resource)) {
      const prior = pickLatestDecisionForResource(existingDecisions, f.resource, record.version);
      if (prior) {
        results.push({ decision: prior.decision, finding: f, mergedText: undefined });
      }
    }
  }

  if (remaining.length === 0) {
    return { results, newDecisions };
  }

  if (opts.yes) {
    for (const f of remaining) {
      const decision: DriftDecision = {
        resource: f.resource,
        decision: "take-frame",
        decidedAt: new Date(),
        decidedBy: opts.actor,
        againstVersion: record.version,
      };
      await store.appendDriftDecision(record._id, decision);
      newDecisions.push(decision);
      results.push({ decision: "take-frame", finding: f });
    }
    return { results, newDecisions };
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const f of remaining) {
      process.stdout.write(`\nDrift on ${f.resource} [${f.kind}]\n  ${f.detail}\n`);
      let chosen: DriftDecision["decision"] | null = null;
      let mergedText: string | undefined;
      while (chosen === null) {
        const ans = (
          await rl.question(
            "  (a) keep-local  (b) take-frame  (c) merged  (d) deferred  > ",
          )
        ).trim().toLowerCase();
        if (ans === "a" || ans === "keep-local") chosen = "keep-local";
        else if (ans === "b" || ans === "take-frame") chosen = "take-frame";
        else if (ans === "c" || ans === "merged") {
          process.stdout.write(
            "  Paste merged text. Terminate with a line containing only '---'.\n",
          );
          const lines: string[] = [];
          while (true) {
            const line = await rl.question("");
            if (line === "---") break;
            lines.push(line);
          }
          const text = lines.join("\n");
          const confirm = (
            await rl.question(`  Confirm merged text (${text.length} chars)? [y/N] > `)
          ).trim().toLowerCase();
          if (confirm === "y" || confirm === "yes") {
            chosen = "merged";
            mergedText = text;
          }
        } else if (ans === "d" || ans === "deferred") chosen = "deferred";
        else process.stdout.write("  Please answer a, b, c, or d.\n");
      }

      const decision: DriftDecision = {
        resource: f.resource,
        decision: chosen,
        decidedAt: new Date(),
        decidedBy: opts.actor,
        againstVersion: record.version,
        ...(chosen === "merged" && mergedText !== undefined ? { reason: mergedText } : {}),
      };
      await store.appendDriftDecision(record._id, decision);
      newDecisions.push(decision);
      results.push({ decision: chosen, finding: f, mergedText });
    }
  } finally {
    rl.close();
  }

  return { results, newDecisions };
}

function pickLatestDecisionForResource(
  decisions: DriftDecision[],
  resource: string,
  version: string,
): DriftDecision | undefined {
  let chosen: DriftDecision | undefined;
  for (const d of decisions) {
    if (d.resource !== resource) continue;
    if (d.againstVersion !== version) continue;
    if (!chosen || d.decidedAt > chosen.decidedAt) chosen = d;
  }
  return chosen;
}
