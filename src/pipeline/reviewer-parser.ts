import type { ReviewerFinding, ReviewerOutput } from "./types.js";

/**
 * Parse the reviewer subagent's structured output. The reviewer is prompted
 * to emit a fenced JSON block with shape:
 *
 *   ```json
 *   {
 *     "verdict": "APPROVE" | "REQUEST CHANGES",
 *     "findings": [
 *       { "severity": "BLOCKER"|"SHOULD-FIX"|"NICE-TO-HAVE",
 *         "body": "...",
 *         "disposition": "fix-in-this-PR"|"file-follow-up" }
 *     ]
 *   }
 *   ```
 *
 * The parser then RE-ASSERTS the pipeline rule: any BLOCKER or SHOULD-FIX
 * forces verdict to REQUEST CHANGES regardless of what the reviewer wrote.
 * This guards against reviewer prompt drift (caught in the KPR-84 trial).
 */
export function parseReviewerOutput(text: string): ReviewerOutput {
  const m = text.match(/```json\s*([\s\S]*?)```/);
  if (!m) throw new Error("Reviewer output missing fenced JSON block");
  const raw = JSON.parse(m[1]) as unknown;
  if (!raw || typeof raw !== "object") {
    throw new Error("Reviewer output is not an object");
  }
  const obj = raw as Record<string, unknown>;
  const verdictRaw = obj.verdict;
  if (verdictRaw !== "APPROVE" && verdictRaw !== "REQUEST CHANGES") {
    throw new Error(`Reviewer output: invalid verdict ${String(verdictRaw)}`);
  }
  if (!Array.isArray(obj.findings)) {
    throw new Error("Reviewer output: findings must be an array");
  }
  const findings: ReviewerFinding[] = obj.findings.map((f, i) => parseFinding(f, i));
  const reasserted = reassertVerdict(verdictRaw, findings);
  return { verdict: reasserted, findings };
}

function parseFinding(raw: unknown, index: number): ReviewerFinding {
  if (!raw || typeof raw !== "object") {
    throw new Error(`findings[${index}] must be an object`);
  }
  const o = raw as Record<string, unknown>;
  if (
    o.severity !== "BLOCKER" &&
    o.severity !== "SHOULD-FIX" &&
    o.severity !== "NICE-TO-HAVE"
  ) {
    throw new Error(`findings[${index}].severity invalid: ${String(o.severity)}`);
  }
  if (typeof o.body !== "string" || o.body.length === 0) {
    throw new Error(`findings[${index}].body must be a non-empty string`);
  }
  let disposition: ReviewerFinding["disposition"];
  if (o.disposition === "fix-in-this-PR" || o.disposition === "file-follow-up") {
    disposition = o.disposition;
  } else if (o.disposition !== undefined) {
    throw new Error(`findings[${index}].disposition invalid: ${String(o.disposition)}`);
  }
  return { severity: o.severity, body: o.body, disposition };
}

/** Pipeline rule: APPROVE means zero BLOCKER and zero SHOULD-FIX. */
export function reassertVerdict(
  reviewerVerdict: "APPROVE" | "REQUEST CHANGES",
  findings: ReviewerFinding[],
): "APPROVE" | "REQUEST CHANGES" {
  const hasBlocking = findings.some(
    (f) => f.severity === "BLOCKER" || f.severity === "SHOULD-FIX",
  );
  if (hasBlocking) return "REQUEST CHANGES";
  return reviewerVerdict;
}
