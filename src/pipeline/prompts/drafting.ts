/**
 * Prompt template constants for spec-drafting and plan-drafting subagents.
 *
 * Both bake in the spec §"Drafting subagent contract": the subagent must emit
 * v1 of the artifact PLUS an open-questions list, and must end with a marker
 * the tick's next pass can detect (`## Open design questions` heading).
 *
 * Memory-rule references baked in:
 *   - feedback_pipeline_review_rule.md (open-questions contract)
 *   - feedback_agent_review_workflow.md (multi-round review expectations)
 *
 * Placeholders: `${ticketId}`, `${repoPath}`, `${title}`, `${description}`.
 * The handler substitutes via plain template literals before passing to
 * `spawnSubagent`.
 */

export interface DraftingPromptInput {
  ticketId: string;
  repoPath: string;
  title: string;
  description: string;
  /** Where the artifact must land (relative to repoPath). */
  outputPath: string;
}

const SHARED_PREAMBLE = `You are running as a DETACHED Claude Code session launched by Beekeeper's pipeline-tick.
You will not be polled or watched — you must complete the work and write your results back to Linear yourself.

Audit-trail environment (already in your env):
- PIPELINE_AGENT_ID — your agent id; quote it in every comment you post
- PIPELINE_TICKET_ID — the Linear ticket you are working
- PIPELINE_KIND — your role (draft-spec, draft-plan, code-review, implementer)
- LINEAR_API_KEY — use this to post comments to the ticket via the Linear API or \`linear-cli\`

Memory rules in scope:
- feedback_pipeline_review_rule.md — drafts MUST surface every uncertainty as an open question rather than guessing.
- feedback_agent_review_workflow.md — drafts will be reviewed; expect 2-3 review rounds.`;

const OPEN_QUESTIONS_CONTRACT = `## Open-questions contract (strict)

When you reach any uncertainty — ambiguous requirement, undecided trade-off, missing fact you cannot
verify, contested design — DO NOT GUESS. Stop, list it, and continue.

At the END of your artifact, append a section literally titled \`## Open design questions\`. List each
open question with:
  - The question itself (one sentence)
  - The options you considered (A/B/C with one-line pros/cons)
  - Your lean (and why), if you have one

If there are zero open questions, still append the section with the line "None — review-clean."
The pipeline detects the heading and uses its presence + body to decide \`block:human\` vs. advance.`;

export function buildSpecDraftingPrompt(input: DraftingPromptInput): string {
  return `${SHARED_PREAMBLE}

# Your task: draft the v1 design SPEC for ${input.ticketId}

Repo: ${input.repoPath}
Output path: ${input.outputPath}
Ticket title: ${input.title}

Ticket description (verbatim):
"""
${input.description}
"""

Steps:
1. Read the ticket description and any links it references.
2. Explore the codebase enough to understand the integration surface.
3. Write the spec at ${input.outputPath} following the repo's existing spec conventions
   (look at sibling files in docs/specs/ for the shape).
4. Append \`## Open design questions\` per the contract below.
5. Commit the file: \`git add ${input.outputPath} && git commit -m "spec(${input.ticketId}): v1 draft"\`.
6. Post a Linear comment on ${input.ticketId} announcing the draft is committed and listing the
   open questions inline. Quote your PIPELINE_AGENT_ID in the comment for audit.

${OPEN_QUESTIONS_CONTRACT}
`;
}

export function buildPlanDraftingPrompt(input: DraftingPromptInput): string {
  return `${SHARED_PREAMBLE}

# Your task: draft the v1 implementation PLAN for ${input.ticketId}

Repo: ${input.repoPath}
Output path: ${input.outputPath}
Ticket title: ${input.title}

Ticket description (verbatim):
"""
${input.description}
"""

Steps:
1. Read the ticket description and the linked spec (if any).
2. Explore the codebase enough to identify files-to-create / files-to-modify.
3. Write the plan at ${input.outputPath} matching the shape of
   docs/plans/2026-04-25-frames-foundation.md (task per logical unit, code blocks,
   commit step at the end of each task).
4. Append \`## Open design questions\` per the contract below.
5. Commit: \`git add ${input.outputPath} && git commit -m "plan(${input.ticketId}): v1 draft"\`.
6. Post a Linear comment on ${input.ticketId} announcing the draft + open questions inline,
   quoting your PIPELINE_AGENT_ID.

${OPEN_QUESTIONS_CONTRACT}
`;
}
