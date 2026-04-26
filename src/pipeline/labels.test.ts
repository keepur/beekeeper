import { describe, expect, it } from "vitest";
import { getBlockLabels, getTypeLabel, hasLabel, isPipelineLabel } from "./labels.js";

describe("labels", () => {
  it("identifies pipeline labels", () => {
    expect(isPipelineLabel("type:trivial")).toBe(true);
    expect(isPipelineLabel("block:ci")).toBe(true);
    expect(isPipelineLabel("pipeline-auto")).toBe(true);
    expect(isPipelineLabel("epic")).toBe(true);
    expect(isPipelineLabel("random-label")).toBe(false);
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
