import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRepo } from "../repo-resolver.js";
import { buildPlanDraftingPrompt, buildSpecDraftingPrompt } from "../prompts/drafting.js";
import { blockHuman, type HandlerContext, type HandlerResult } from "./types.js";

const OPEN_QUESTIONS_HEADING = /^##\s+Open design questions\s*$/m;
const NONE_LINE = /None\s*[—-]\s*review-clean\.?/i;

/**
 * Returns the canonical artifact path under the resolved repo, given the
 * ticket and decision kind. Phase 1 convention:
 *   - draft-spec → docs/specs/<YYYY-MM-DD>-<ticket-id>-design.md
 *   - draft-plan → docs/plans/<YYYY-MM-DD>-<ticket-id>.md
 * The drafting subagent commits to `_pending_review/` first per the open-questions
 * contract; this resolver checks both locations.
 */
export function artifactCandidatePaths(
  repoPath: string,
  kind: "spec" | "plan",
  ticketId: string,
): string[] {
  const subdir = kind === "spec" ? "specs" : "plans";
  const ticketLower = ticketId.toLowerCase();
  return [
    join(repoPath, "docs", subdir, "_pending_review"),
    join(repoPath, "docs", subdir),
  ].flatMap((dir) => [
    join(dir, `${ticketLower}.md`),
    join(dir, `${ticketLower}-design.md`),
  ]);
}

function findExistingArtifact(repoPath: string, kind: "spec" | "plan", ticketId: string): string | undefined {
  // Pattern-match by date prefix is brittle; the drafting subagent posts the
  // exact path back via Linear comment. For Phase 1 we accept the canonical
  // locations and the simple ticketId-named candidates.
  for (const path of artifactCandidatePaths(repoPath, kind, ticketId)) {
    if (existsSync(path)) return path;
  }
  return undefined;
}

/**
 * Drafting handler — handles draft-spec, draft-plan, spec-review, plan-review.
 *
 * Behavior:
 *   1. Resolve repo. If unresolvable → block:human.
 *   2. If a draft exists at the canonical path AND has zero open questions
 *      ("None — review-clean.") → advance state past Spec/Plan Drafting.
 *   3. If a draft exists with open questions → block:human, post the questions
 *      inline.
 *   4. If no draft yet → launch drafting subagent, return spawned.
 */
export async function handleDrafting(ctx: HandlerContext): Promise<HandlerResult> {
  const repo = resolveRepo(ctx.ticket, ctx.config);
  if (!repo) {
    return blockHuman(
      ctx.client,
      ctx.ticket,
      "could not resolve target repo from ticket description (add a repo: label or update the description)",
    );
  }

  const kind: "spec" | "plan" = ctx.decision.kind === "draft-spec" || ctx.decision.kind === "spec-review" ? "spec" : "plan";
  const existing = findExistingArtifact(repo.path, kind, ctx.ticket.identifier);

  if (existing) {
    const text = readFileSync(existing, "utf8");
    const hasHeading = OPEN_QUESTIONS_HEADING.test(text);
    if (!hasHeading) {
      // Subagent didn't follow the contract — block for human review.
      return blockHuman(
        ctx.client,
        ctx.ticket,
        `draft at ${existing} is missing the \`## Open design questions\` section`,
      );
    }
    const tail = text.slice(text.search(OPEN_QUESTIONS_HEADING));
    if (NONE_LINE.test(tail)) {
      // Review-clean → advance state.
      const nextState = kind === "spec" ? "Plan Drafting" : "Ready";
      await ctx.client.setState(ctx.ticket.id, nextState);
      await ctx.client.addComment(
        ctx.ticket.id,
        `Drafting handler: ${kind} review-clean → state ${nextState}.`,
      );
      return { outcome: "transitioned", detail: `${kind} clean → ${nextState}` };
    }
    // Open questions present → block for operator review.
    return blockHuman(
      ctx.client,
      ctx.ticket,
      `draft at ${existing} has unresolved open questions; operator must answer before pipeline advances`,
    );
  }

  // No draft yet → launch.
  const outputPath = kind === "spec"
    ? `docs/specs/_pending_review/${ctx.ticket.identifier.toLowerCase()}-design.md`
    : `docs/plans/_pending_review/${ctx.ticket.identifier.toLowerCase()}.md`;
  const prompt = kind === "spec"
    ? buildSpecDraftingPrompt({
        ticketId: ctx.ticket.identifier,
        repoPath: repo.path,
        title: ctx.ticket.title,
        description: ctx.ticket.description,
        outputPath,
      })
    : buildPlanDraftingPrompt({
        ticketId: ctx.ticket.identifier,
        repoPath: repo.path,
        title: ctx.ticket.title,
        description: ctx.ticket.description,
        outputPath,
      });

  const result = await ctx.spawn({
    kind: kind === "spec" ? "draft-spec" : "draft-plan",
    prompt,
    repoPath: repo.path,
    ticketId: ctx.ticket.identifier,
  });

  // Transition into Spec/Plan Drafting state if we're not already there.
  const targetState = kind === "spec" ? "Spec Drafting" : "Plan Drafting";
  if (ctx.ticket.state !== targetState) {
    await ctx.client.setState(ctx.ticket.id, targetState);
  }

  return { outcome: "spawned", detail: `${kind} drafting subagent launched`, agentId: result.agentId };
}
