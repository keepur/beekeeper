import { describe, expect, it } from "vitest";
import { getBlockLabels, getTypeLabel, hasLabel, isPipelineLabel, isRepoLabel } from "./labels.js";

describe("labels", () => {
  it("identifies pipeline labels", () => {
    expect(isPipelineLabel("type:trivial")).toBe(true);
    expect(isPipelineLabel("block:ci")).toBe(true);
    expect(isPipelineLabel("pipeline-auto")).toBe(true);
    expect(isPipelineLabel("epic")).toBe(true);
    expect(isPipelineLabel("random-label")).toBe(false);
  });

  it("identifies repo:<name> labels (open namespace) — regression for KPR-95 bug where repo:hive was filtered out", () => {
    expect(isRepoLabel("repo:hive")).toBe(true);
    expect(isRepoLabel("repo:beekeeper")).toBe(true);
    expect(isRepoLabel("repo:some-future-repo")).toBe(true);
    expect(isRepoLabel("repo:")).toBe(false); // empty suffix not allowed
    expect(isRepoLabel("not-a-repo-label")).toBe(false);
    // isRepoLabel must flow through isPipelineLabel so labels survive the filter
    // in linear-client.ts and reach the resolver's step-1 label check.
    expect(isPipelineLabel("repo:hive")).toBe(true);
    expect(isPipelineLabel("repo:beekeeper")).toBe(true);
  });

  it("returns single type label or undefined", () => {
    expect(getTypeLabel(["type:plan-only", "pipeline-auto"])).toBe("type:plan-only");
    expect(getTypeLabel([])).toBeUndefined();
    expect(getTypeLabel(["type:plan-only", "type:trivial"])).toBeUndefined(); // ambiguous
  });

  it("returns all block labels", () => {
    expect(getBlockLabels(["block:human", "block:ci", "pipeline-auto"])).toEqual([
      "block:human",
      "block:ci",
    ]);
  });

  it("hasLabel checks membership", () => {
    expect(hasLabel(["pipeline-auto", "epic"], "pipeline-auto")).toBe(true);
    expect(hasLabel(["pipeline-auto"], "epic")).toBe(false);
  });
});
