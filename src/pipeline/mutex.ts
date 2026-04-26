import { ulid } from "ulid";
import type { LinearClient } from "./linear-client.js";
import type { TicketComment } from "./types.js";

const CLAIM_PREFIX = "tick-lock-claim:";
const RELEASE_PREFIX = "tick-lock-release:";
const SPAWN_PREFIX = "tick-spawn-log:";
const TTL_MS = 60_000;

export interface ClaimResult {
  /** True if this caller now holds the lock; false if another runId beat them. */
  acquired: boolean;
  /** The runId that beat us, when acquired=false. */
  contendedBy?: string;
  /** The comment ID we wrote (so the release step can pair it). */
  claimCommentId?: string;
}

export interface ReleaseInput {
  outcome: "spawned" | "transitioned" | "skipped";
}

interface ParsedClaim {
  runId: string;
  action: string;
  postedAt: Date;
}

interface ParsedRelease {
  runId: string;
  outcome: string;
}

/**
 * Generate a fresh runId for one tick invocation.
 * Format: `tick-<ulid>`. ULID is monotonic + lexicographic, useful for log-grepping.
 */
export function newRunId(): string {
  return `tick-${ulid()}`;
}

/**
 * Try to claim the per-ticket lock. Posts a `tick-lock-claim` comment,
 * then re-reads to verify the latest claim is ours.
 */
export async function claim(
  client: LinearClient,
  ticketId: string,
  runId: string,
  action: string,
): Promise<ClaimResult> {
  // Step 1: read existing claims; bail if a *different* fresh claim exists.
  const issue = await client.getTicketState(ticketId);
  const existing = latestClaim(issue.comments);
  if (existing && existing.runId !== runId && Date.now() - existing.postedAt.getTime() < TTL_MS) {
    const released = hasMatchingRelease(issue.comments, existing.runId, existing.postedAt);
    if (!released) {
      return { acquired: false, contendedBy: existing.runId };
    }
  }

  // Step 2: write our claim.
  const written = await client.addComment(
    issue.id,
    `${CLAIM_PREFIX} runId=${runId} action=${action}`,
  );

  // Step 3: re-read and verify our claim is the most recent tick-lock-claim.
  const verify = await client.getTicketState(ticketId);
  const newest = latestClaim(verify.comments);
  if (!newest || newest.runId !== runId) {
    return { acquired: false, contendedBy: newest?.runId, claimCommentId: written.id };
  }
  return { acquired: true, claimCommentId: written.id };
}

export async function release(
  client: LinearClient,
  ticketId: string,
  runId: string,
  input: ReleaseInput,
): Promise<void> {
  const issue = await client.getTicketState(ticketId);
  await client.addComment(
    issue.id,
    `${RELEASE_PREFIX} runId=${runId} outcome=${input.outcome}`,
  );
}

export async function logSpawn(
  client: LinearClient,
  ticketId: string,
  runId: string,
  agentId: string,
  /** Action kind that produced the spawn — drives state-specific spawn-log lookups. */
  kind: string,
): Promise<void> {
  const issue = await client.getTicketState(ticketId);
  await client.addComment(
    issue.id,
    `${SPAWN_PREFIX} runId=${runId} agentId=${agentId} kind=${kind}`,
  );
}

/** Find the most recent `tick-lock-claim`-typed comment, ignoring releases/spawn-logs/non-pipeline. */
export function latestClaim(comments: TicketComment[]): ParsedClaim | undefined {
  const claims: ParsedClaim[] = [];
  for (const c of comments) {
    const trimmed = c.body.trim();
    if (!trimmed.startsWith(CLAIM_PREFIX)) continue;
    const parsed = parseClaim(trimmed, new Date(c.createdAt));
    if (parsed) claims.push(parsed);
  }
  if (claims.length === 0) return undefined;
  return claims.reduce((a, b) => (a.postedAt >= b.postedAt ? a : b));
}

export function parseClaim(body: string, postedAt: Date): ParsedClaim | undefined {
  // Body shape: "tick-lock-claim: runId=tick-XXXX action=draft-plan"
  const m = body.match(/^tick-lock-claim:\s+runId=(\S+)\s+action=(\S+)\s*$/);
  if (!m) return undefined;
  return { runId: m[1], action: m[2], postedAt };
}

export function parseRelease(body: string): ParsedRelease | undefined {
  const m = body.trim().match(/^tick-lock-release:\s+runId=(\S+)\s+outcome=(\S+)\s*$/);
  if (!m) return undefined;
  return { runId: m[1], outcome: m[2] };
}

/** Returns true if the comment list shows a release for the given runId after `claimedAt`. */
export function hasMatchingRelease(
  comments: TicketComment[],
  runId: string,
  claimedAt: Date,
): boolean {
  for (const c of comments) {
    if (new Date(c.createdAt) <= claimedAt) continue;
    const r = parseRelease(c.body);
    if (r && r.runId === runId) return true;
  }
  return false;
}
