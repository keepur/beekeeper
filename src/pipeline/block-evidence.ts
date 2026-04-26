import type { TicketComment } from "./types.js";

// Pipeline-authored mutex/spawn comments — internal mechanics, never operator evidence.
const PIPELINE_PREFIXES = ["tick-lock-claim:", "tick-lock-release:", "tick-spawn-log:"];

// Block-diagnostic comments are tick-authored too. They start with the label
// name + " — " (em dash). Treat them as pipeline comments for the unblock-evidence
// check so removing a block label without a separate operator comment correctly
// re-applies the block.
const BLOCK_DIAGNOSTIC_PREFIXES = ["block:human —", "block:external —", "block:ci —"];

// Tick-authored status comments posted by handlers as work progresses (drafting
// transitions, merge confirmations, review-output JSON). These are operational
// breadcrumbs, not operator evidence. New tick-authored comment shapes should
// be added here as handlers grow — convention: any tick-authored prose comment
// that is not a real human resolution belongs in this list.
const TICK_STATUS_PREFIXES = [
  "Drafting handler:",
  "Merged via",
  "review-output",
  "tick-",  // catch-all for any future tick-* comment shape
];

/**
 * Per spec §"Default unblock flow": for `block:human` and `block:external`,
 * the operator must post a non-pipeline comment between the original block
 * diagnostic and the unblock. If the most recent non-pipeline comment is the
 * block diagnostic itself, no resolution evidence exists — the tick re-applies
 * the block label.
 *
 * For Phase 1 we use a simple heuristic: was there ANY non-pipeline comment
 * authored AFTER the block label was added (we approximate "label-added time"
 * by the most recent pipeline comment that mentions the block label, falling
 * back to the most recent block-diagnostic-style comment from the tick).
 *
 * `block:ci` does NOT route through this function — the dispatcher polls CI
 * directly and clears `block:ci` automatically.
 */
export function hasUnblockEvidence(comments: TicketComment[]): boolean {
  const sorted = [...comments].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  // Walk from the end; first non-pipeline comment wins as evidence
  // unless it itself is a block-diagnostic written by the tick (those start
  // with a recognizable prefix; for Phase 1 we accept any non-pipeline comment
  // as evidence).
  for (let i = sorted.length - 1; i >= 0; i--) {
    const c = sorted[i];
    const trimmed = c.body.trim();
    if (PIPELINE_PREFIXES.some((p) => trimmed.startsWith(p))) continue;
    // Tick-authored block-diagnostic comments are not operator evidence either.
    if (BLOCK_DIAGNOSTIC_PREFIXES.some((p) => trimmed.startsWith(p))) continue;
    // Tick-authored status comments (handler transitions, merge confirmations,
    // reviewer-output JSON) are also tick mechanics, not operator evidence.
    if (TICK_STATUS_PREFIXES.some((p) => trimmed.startsWith(p))) continue;
    return true;
  }
  return false;
}
