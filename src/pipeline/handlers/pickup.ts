import { execFileSync } from "node:child_process";
import { resolveRepo } from "../repo-resolver.js";
import { buildImplementerPrompt } from "../prompts/implementer.js";
import { blockHuman, type HandlerContext, type HandlerResult } from "./types.js";

/**
 * Pickup handler — launches the implementer subagent for a Ready ticket.
 *
 * 1. Resolve repo. If unresolvable → block:human.
 * 2. Verify epic branch exists locally or on origin; create from main if missing.
 * 3. Launch implementer with plan path + repo path + epic branch in the prompt.
 * 4. Transition state → In Progress.
 */
export async function handlePickup(ctx: HandlerContext): Promise<HandlerResult> {
  const repo = resolveRepo(ctx.ticket, ctx.config);
  if (!repo) {
    return blockHuman(
      ctx.client,
      ctx.ticket,
      "could not resolve target repo from ticket description",
    );
  }

  const epicBranch = ctx.ticket.parent
    ? `${ctx.ticket.parent}-epic`
    : ctx.config.mainBranch ?? "main";
  const workBranch = ctx.ticket.identifier.toLowerCase();

  // Ensure epicBranch exists on origin (fail-soft: log and continue if not — implementer
  // will surface the error in its blocking comment).
  try {
    execFileSync("git", ["-C", repo.path, "fetch", "origin", epicBranch], { stdio: "ignore" });
  } catch {
    // Branch may not exist on origin yet; implementer's prompt assumes it does.
    // If it doesn't, the implementer will fail and post a BLOCKED comment, which the
    // next tick converts to block:human.
  }

  const planPath = `docs/plans/${ctx.ticket.identifier.toLowerCase()}.md`;
  // Per spec §"Pickup action" item 1: refuse to pick up if the plan is not
  // committed on the epic branch the implementer's worktree will resolve.
  // `git show <epicBranch>:<planPath>` is the authoritative check —
  // succeeds only if the file exists on that ref. A working-tree check
  // (existsSync) would pass for plans that exist locally but haven't been
  // pushed to the epic branch yet, exactly the failure mode this guard
  // is supposed to catch.
  let planOnEpicBranch = false;
  try {
    execFileSync("git", ["-C", repo.path, "show", `${epicBranch}:${planPath}`], { stdio: "ignore" });
    planOnEpicBranch = true;
  } catch {
    // git show errors when the path is missing on the ref
  }
  if (!planOnEpicBranch) {
    return blockHuman(
      ctx.client,
      ctx.ticket,
      `plan file not found at ${planPath} on branch ${epicBranch} — ensure plan is committed and pushed before pickup`,
    );
  }

  const prompt = buildImplementerPrompt({
    ticketId: ctx.ticket.identifier,
    repoPath: repo.path,
    planPath,
    epicBranch,
    workBranch,
  });

  const result = await ctx.spawn({
    kind: "implementer",
    prompt,
    repoPath: repo.path,
    ticketId: ctx.ticket.identifier,
  });

  if (ctx.ticket.state !== "In Progress") {
    await ctx.client.setState(ctx.ticket.id, "In Progress");
  }

  return { outcome: "spawned", detail: "implementer launched", agentId: result.agentId };
}
