/** Pipeline-tick types — the shape consumed and produced by the action dispatcher. */

export type TypeLabel = "type:trivial" | "type:plan-only" | "type:spec-and-plan" | "type:research";
export type BlockLabel = "block:human" | "block:ci" | "block:external";
export type QaLabel = "qa:meta-review-due" | "qa:rollback";
/** Open-namespace `repo:<name>` label used by the pipeline-tick repo resolver. */
export type RepoLabel = `repo:${string}`;
export type PipelineLabel = TypeLabel | BlockLabel | QaLabel | RepoLabel | "pipeline-auto" | "epic";

/** Linear workflow state names per `reference_pipeline_taxonomy.md`. */
export type WorkflowState =
  | "Backlog"
  | "Spec Drafting"
  | "Plan Drafting"
  | "Ready"
  | "In Progress"
  | "In Review"
  | "Done"
  | "Canceled"
  | "Todo"; // legacy non-pipeline state — surfaces as "skip" decision

export interface TicketComment {
  id: string;
  body: string;
  /** ISO timestamp; Linear-assigned, globally ordered for race detection. */
  createdAt: string;
  authorId?: string;
}

export interface TicketAttachment {
  id: string;
  url: string;
  /** GitHub PR URLs are auto-attached by Linear's GitHub integration. */
  title?: string;
}

/** Joined ticket state — the action-dispatcher's input. */
export interface TicketState {
  id: string;
  identifier: string; // e.g., "KPR-90"
  title: string;
  description: string;
  state: WorkflowState;
  labels: PipelineLabel[];
  blockedBy: string[]; // identifiers of blocking issues
  parent?: string; // identifier
  comments: TicketComment[];
  attachments: TicketAttachment[];
}

export type ActionKind =
  | "draft-spec"
  | "draft-plan"
  | "spec-review"
  | "plan-review"
  | "pickup"
  | "code-review"
  | "merge"
  | "advance" // pure state transition, no spawn
  | "report-only" // for blocked tickets
  | "skip";

export interface ActionDecision {
  kind: ActionKind;
  /** Human-readable reason — surfaces in tick output and in the spawn-log comment. */
  reason: string;
  /** True if this action consumes the spawn-budget (launches a long-running subagent). */
  spawns: boolean;
  /** Optional payload the handler needs (e.g., target state, label changes). */
  payload?: Record<string, unknown>;
}

export interface ResolvedRepo {
  /** Short name, e.g., "hive" or "beekeeper". */
  name: string;
  /** Absolute path on disk. */
  path: string;
}

export interface ReviewerFinding {
  severity: "BLOCKER" | "SHOULD-FIX" | "NICE-TO-HAVE";
  body: string;
  /** Reviewer's recommendation per finding: in-PR fix or follow-up. */
  disposition?: "fix-in-this-PR" | "file-follow-up";
}

export interface ReviewerOutput {
  verdict: "APPROVE" | "REQUEST CHANGES";
  findings: ReviewerFinding[];
}

export interface LockClaim {
  runId: string;
  action: string;
  postedAt: string; // ISO
}

export interface BudgetCounters {
  spawnUsed: number;
  spawnLimit: number;
  actionUsed: number;
  actionLimit: number;
}

export interface TickReportEntry {
  ticket: string;
  decision: ActionDecision;
  outcome: "spawned" | "transitioned" | "skipped" | "blocked" | "report-only";
  detail?: string;
}

export interface TickReport {
  runId: string;
  scope: string;
  startedAt: string;
  endedAt: string;
  budget: BudgetCounters;
  entries: TickReportEntry[];
  blocked: TickReportEntry[];
}
