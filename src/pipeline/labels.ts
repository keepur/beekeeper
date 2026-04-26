import type { PipelineLabel, TypeLabel, BlockLabel } from "./types.js";

export const TYPE_LABELS: readonly TypeLabel[] = [
  "type:trivial",
  "type:plan-only",
  "type:spec-and-plan",
  "type:research",
] as const;

export const BLOCK_LABELS: readonly BlockLabel[] = [
  "block:human",
  "block:ci",
  "block:external",
] as const;

export function isTypeLabel(s: string): s is TypeLabel {
  return (TYPE_LABELS as readonly string[]).includes(s);
}

export function isBlockLabel(s: string): s is BlockLabel {
  return (BLOCK_LABELS as readonly string[]).includes(s);
}

export function isPipelineLabel(s: string): s is PipelineLabel {
  return (
    isTypeLabel(s) ||
    isBlockLabel(s) ||
    s === "pipeline-auto" ||
    s === "epic" ||
    s === "qa:meta-review-due" ||
    s === "qa:rollback"
  );
}

/** Returns the single `type:*` label on the ticket, or undefined if none/multiple. */
export function getTypeLabel(labels: PipelineLabel[]): TypeLabel | undefined {
  const matched = labels.filter(isTypeLabel);
  return matched.length === 1 ? matched[0] : undefined;
}

/** Returns all `block:*` labels on the ticket. */
export function getBlockLabels(labels: PipelineLabel[]): BlockLabel[] {
  return labels.filter(isBlockLabel);
}

export function hasLabel(labels: PipelineLabel[], target: PipelineLabel): boolean {
  return labels.includes(target);
}
