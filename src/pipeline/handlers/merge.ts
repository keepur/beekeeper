import { execFileSync } from "node:child_process";
import { resolveRepo } from "../repo-resolver.js";
import { blockHuman, type HandlerContext, type HandlerResult } from "./types.js";

const PR_URL_RE = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

/**
 * Merge handler — picks the strategy per `feedback_merge_strategy.md`:
 *   phase → epic        : merge-commit (preserves per-task history)
 *   single-purpose → main : squash
 *   epic → main           : merge-commit
 *
 * Phase 1: classify by base ref (main = squash unless ticket has `epic` label).
 */
export async function handleMerge(ctx: HandlerContext): Promise<HandlerResult> {
  const repo = resolveRepo(ctx.ticket, ctx.config);
  if (!repo) return blockHuman(ctx.client, ctx.ticket, "could not resolve repo for merge");

  const pr = ctx.ticket.attachments.find((a) => PR_URL_RE.test(a.url));
  if (!pr) return blockHuman(ctx.client, ctx.ticket, "merge: no PR attachment on ticket");

  const baseRef = readPrBaseRef(repo.path, pr.url);
  if (!baseRef) return blockHuman(ctx.client, ctx.ticket, `merge: could not read PR base ref for ${pr.url}`);

  const mainBranch = ctx.config.mainBranch ?? "main";
  const isEpicTicket = ctx.ticket.labels.includes("epic");
  const strategy: "merge" | "squash" =
    baseRef !== mainBranch ? "merge" : isEpicTicket ? "merge" : "squash";

  try {
    execFileSync(
      "gh",
      ["pr", "merge", `--${strategy}`, "--auto", pr.url],
      { cwd: repo.path, stdio: "pipe" },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return blockHuman(ctx.client, ctx.ticket, `merge failed: ${msg}`);
  }

  await ctx.client.setState(ctx.ticket.id, "Done");
  await ctx.client.addComment(
    ctx.ticket.id,
    `Merged via \`gh pr merge --${strategy} --auto\` (base=${baseRef}).`,
  );
  return { outcome: "transitioned", detail: `merged (${strategy})` };
}

function readPrBaseRef(repoPath: string, prUrl: string): string | undefined {
  const m = prUrl.match(PR_URL_RE);
  if (!m) return undefined;
  const [, owner, repo, num] = m;
  try {
    const out = execFileSync(
      "gh",
      ["pr", "view", num, "--repo", `${owner}/${repo}`, "--json", "baseRefName", "-q", ".baseRefName"],
      { cwd: repoPath, stdio: ["ignore", "pipe", "ignore"] },
    ).toString().trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}
