/**
 * Prompt template for the implementer subagent (pickup action).
 *
 * Memory-rule references baked in:
 *   - feedback_pr_base_on_epic_branches.md — phase tickets must \`--base <epic-branch>\`,
 *     never main.
 *   - feedback_merge_strategy.md — chosen strategy depends on PR shape; the implementer
 *     does not merge (the tick's merge handler does), but the implementer must open the PR
 *     with the correct base ref so the merge strategy resolves correctly.
 */

export interface ImplementerPromptInput {
  ticketId: string;
  repoPath: string;
  /** Absolute path (or repo-relative) to the plan file. */
  planPath: string;
  /** The branch that the PR's base should be — typically the parent epic's branch. */
  epicBranch: string;
  /** The branch the implementer should work on (created if it doesn't exist). */
  workBranch: string;
}

export function buildImplementerPrompt(input: ImplementerPromptInput): string {
  return `You are running as a DETACHED Claude Code session launched by Beekeeper's pipeline-tick.
Your role is IMPLEMENTER for ${input.ticketId}.

Audit-trail environment (already in your env):
- PIPELINE_AGENT_ID — quote it in every comment you post
- PIPELINE_TICKET_ID = ${input.ticketId}
- PIPELINE_KIND = implementer
- LINEAR_API_KEY — post status to ${input.ticketId} via Linear API

Memory rules in scope (cited explicitly):
**feedback_pr_base_on_epic_branches.md** — when ${input.ticketId} is a phase/sub-task of an epic,
the PR MUST be opened with \`--base ${input.epicBranch}\`. Main is branch-protected; never PR
phase tickets directly to main.
**feedback_merge_strategy.md** — phase→epic uses merge-commit; single-purpose→main uses squash;
epic→main uses merge-commit. The pipeline's merge handler picks the strategy based on base ref —
your job is to set the correct base ref.

# Your task: implement ${input.ticketId} per the plan

Repo: ${input.repoPath}
Plan: ${input.planPath}
Base branch (PR target): ${input.epicBranch}
Work branch: ${input.workBranch}

Steps:
1. \`cd ${input.repoPath}\`
2. \`git fetch origin && git checkout -B ${input.workBranch} origin/${input.epicBranch}\`
3. Read ${input.planPath} end-to-end.
4. Execute each task in the plan: implement, run \`npm run check\`, commit. One commit per task.
5. Push: \`git push -u origin ${input.workBranch}\`
6. Open the PR with \`gh pr create --base ${input.epicBranch} --title "<title>" --body "<body>"\`.
   The body must reference ${input.ticketId} and the plan path.
7. Post a Linear comment on ${input.ticketId} with the PR URL, quoting PIPELINE_AGENT_ID.
8. Exit cleanly. The pipeline's next tick will see the PR attached to the ticket and route to review.

If you hit a blocker (failing tests you can't fix, missing context, ambiguous spec):
- Stop committing.
- Post a Linear comment on ${input.ticketId} starting with "BLOCKED:" describing what you need.
- Quote PIPELINE_AGENT_ID. Exit. The pipeline's next tick will see the BLOCKED comment and apply
  \`block:human\`.
`;
}
