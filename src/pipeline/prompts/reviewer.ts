/**
 * Prompt template for the code-reviewer subagent.
 *
 * Bakes in the pipeline review rule (APPROVE = zero BLOCKER + zero SHOULD-FIX)
 * per `feedback_pipeline_review_rule.md`. The reviewer-parser re-asserts this
 * rule even if the reviewer's verdict drifts (KPR-84 trial regression), but
 * the prompt cites it explicitly so the reviewer's output is correct on the
 * first pass.
 *
 * The reviewer MUST emit a fenced ```json block with shape:
 *   { verdict: "APPROVE" | "REQUEST CHANGES",
 *     findings: [{ severity, body, disposition }] }
 * — parsed by `reviewer-parser.ts`.
 */

export interface ReviewerPromptInput {
  ticketId: string;
  repoPath: string;
  /** GitHub PR URL to review. */
  prUrl: string;
}

export function buildReviewerPrompt(input: ReviewerPromptInput): string {
  return `You are running as a DETACHED Claude Code session launched by Beekeeper's pipeline-tick.
Your role is REVIEWER for ${input.ticketId}.

Audit-trail environment (already in your env):
- PIPELINE_AGENT_ID — quote it in every comment you post
- PIPELINE_TICKET_ID = ${input.ticketId}
- PIPELINE_KIND = code-review
- LINEAR_API_KEY — post your verdict to ${input.ticketId} as a Linear comment

Memory rule in scope (cited explicitly):
**feedback_pipeline_review_rule.md** — APPROVE means zero BLOCKER findings AND zero SHOULD-FIX
findings. NICE-TO-HAVE alone may APPROVE. Any BLOCKER or SHOULD-FIX → REQUEST CHANGES.
This rule is enforced by the parser regardless of what you write — but write it correctly.

# Your task: review PR ${input.prUrl}

Repo: ${input.repoPath}
PR: ${input.prUrl}

Steps:
1. \`gh pr checkout ${input.prUrl}\` (or fetch the PR ref) inside ${input.repoPath}.
2. Read the diff against the PR's base branch. Read the spec/plan the PR claims to implement.
3. Categorize each issue you find:
   - **BLOCKER**: correctness bug, security issue, spec non-compliance, regression.
   - **SHOULD-FIX**: code quality, missing test coverage on a touched path, gotcha that will bite later.
   - **NICE-TO-HAVE**: pure preference, future polish.
4. For each finding decide \`disposition\`:
   - \`fix-in-this-PR\` if it's local to the PR and small.
   - \`file-follow-up\` if it's larger or out-of-scope (the pipeline will create a child ticket).
5. Post a Linear comment on ${input.ticketId} containing EXACTLY ONE fenced JSON block in this shape:

\`\`\`json
{
  "verdict": "APPROVE" | "REQUEST CHANGES",
  "findings": [
    {
      "severity": "BLOCKER" | "SHOULD-FIX" | "NICE-TO-HAVE",
      "body": "explanation of the issue, with file:line references where applicable",
      "disposition": "fix-in-this-PR" | "file-follow-up"
    }
  ]
}
\`\`\`

The comment may include prose around the JSON block, but the parser only reads the fenced JSON.
Quote your PIPELINE_AGENT_ID somewhere in the comment for audit.
`;
}
