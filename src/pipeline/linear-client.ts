import { LinearClient as LinearSdk } from "@linear/sdk";
import type {
  PipelineLabel,
  TicketAttachment,
  TicketComment,
  TicketState,
  WorkflowState,
} from "./types.js";
import { isPipelineLabel } from "./labels.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("pipeline-linear");

export interface LinearClientOptions {
  apiKey: string;
  teamKey: string;
}

/** Thin facade over @linear/sdk. All pipeline I/O against Linear flows through this. */
export class LinearClient {
  private readonly sdk: LinearSdk;
  private readonly teamKey: string;
  private teamIdCache?: string;
  private stateIdCache: Map<WorkflowState, string> = new Map();

  constructor(opts: LinearClientOptions) {
    if (!opts.apiKey) throw new Error("LinearClient: apiKey required");
    if (!opts.teamKey) throw new Error("LinearClient: teamKey required");
    this.sdk = new LinearSdk({ apiKey: opts.apiKey });
    this.teamKey = opts.teamKey;
  }

  async getTeamId(): Promise<string> {
    if (this.teamIdCache) return this.teamIdCache;
    const teams = await this.sdk.teams({ filter: { key: { eq: this.teamKey } } });
    const team = teams.nodes[0];
    if (!team) throw new Error(`Linear team not found for key: ${this.teamKey}`);
    this.teamIdCache = team.id;
    return team.id;
  }

  /** Look up a workflow state ID by name on the configured team. Cached after first hit. */
  async getStateId(name: WorkflowState): Promise<string> {
    const cached = this.stateIdCache.get(name);
    if (cached) return cached;
    const teamId = await this.getTeamId();
    const states = await this.sdk.workflowStates({
      filter: { team: { id: { eq: teamId } }, name: { eq: name } },
    });
    const state = states.nodes[0];
    if (!state) throw new Error(`Workflow state "${name}" not found on team ${this.teamKey}`);
    this.stateIdCache.set(name, state.id);
    return state.id;
  }

  /** Read a single issue and join labels + comments + attachments + parent + blockedBy. */
  async getTicketState(identifier: string): Promise<TicketState> {
    const issue = await this.sdk.issue(identifier);

    const [labelsConn, commentsConn, attachmentsConn, inverseRelationsConn, stateRel, parentRel] =
      await Promise.all([
        issue.labels(),
        issue.comments(),
        issue.attachments(),
        // For blockedBy semantics we need INCOMING block relations: other
        // issues with type=blocks pointing at this ticket. `issue.relations()`
        // returns OUTGOING relations (this issue blocking others) — wrong
        // direction. `issue.inverseRelations()` returns relations where this
        // issue is the relatedIssue, i.e., on the receiving end of "blocks".
        // Filter is client-side because @linear/sdk 39.x doesn't accept a
        // server-side filter on relations queries.
        issue.inverseRelations(),
        issue.state,
        issue.parent,
      ]);
    const blockedByRelations = inverseRelationsConn.nodes.filter((rel) => rel.type === "blocks");

    const labels: PipelineLabel[] = labelsConn.nodes
      .map((l) => l.name)
      .filter(isPipelineLabel);

    const comments: TicketComment[] = await Promise.all(
      commentsConn.nodes.map(async (c) => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
        authorId: (await c.user)?.id,
      })),
    );

    const attachments: TicketAttachment[] = attachmentsConn.nodes.map((a) => ({
      id: a.id,
      url: a.url,
      title: a.title,
    }));

    const blockedBy: string[] = await Promise.all(
      blockedByRelations.map(async (rel) => (await rel.relatedIssue)?.identifier ?? ""),
    ).then((arr) => arr.filter((s) => s.length > 0));

    const state = stateRel ? ((await stateRel).name as WorkflowState) : "Backlog";
    const parent = parentRel ? (await parentRel)?.identifier : undefined;

    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? "",
      state,
      labels,
      blockedBy,
      parent,
      comments,
      attachments,
    };
  }

  /** List children of an epic, identifier-form. */
  async listChildren(parentIdentifier: string): Promise<string[]> {
    const parent = await this.sdk.issue(parentIdentifier);
    const children = await parent.children();
    return children.nodes.map((c) => c.identifier);
  }

  /** List all `pipeline-auto` issues on the team. */
  async listTeamPipelineIssues(): Promise<string[]> {
    const teamId = await this.getTeamId();
    const issues = await this.sdk.issues({
      filter: {
        team: { id: { eq: teamId } },
        labels: { name: { eq: "pipeline-auto" } },
      },
      first: 100,
    });
    return issues.nodes.map((i) => i.identifier);
  }

  async addComment(issueId: string, body: string): Promise<{ id: string; createdAt: string }> {
    const result = await this.sdk.createComment({ issueId, body });
    if (!result.success || !result.comment) {
      throw new Error("Failed to create Linear comment");
    }
    const c = await result.comment;
    return { id: c.id, createdAt: c.createdAt.toISOString() };
  }

  async setState(issueId: string, state: WorkflowState): Promise<void> {
    const stateId = await this.getStateId(state);
    const result = await this.sdk.updateIssue(issueId, { stateId });
    if (!result.success) throw new Error(`Failed to set state ${state} on ${issueId}`);
  }

  async addLabel(issueId: string, labelName: PipelineLabel): Promise<void> {
    const teamId = await this.getTeamId();
    const labels = await this.sdk.issueLabels({
      filter: { team: { id: { eq: teamId } }, name: { eq: labelName } },
    });
    const label = labels.nodes[0];
    if (!label) throw new Error(`Label "${labelName}" not found on team ${this.teamKey}`);
    const issue = await this.sdk.issue(issueId);
    const current = await issue.labels();
    const ids = [...new Set([...current.nodes.map((l) => l.id), label.id])];
    const result = await this.sdk.updateIssue(issueId, { labelIds: ids });
    if (!result.success) throw new Error(`Failed to add label ${labelName} on ${issueId}`);
  }

  async removeLabel(issueId: string, labelName: PipelineLabel): Promise<void> {
    const issue = await this.sdk.issue(issueId);
    const current = await issue.labels();
    const ids = current.nodes.filter((l) => l.name !== labelName).map((l) => l.id);
    const result = await this.sdk.updateIssue(issueId, { labelIds: ids });
    if (!result.success) throw new Error(`Failed to remove label ${labelName} on ${issueId}`);
    log.debug("Label removed", { issueId, labelName });
  }
}
