import { describe, expect, it } from "vitest";
import { Budget } from "./budget.js";

describe("Budget", () => {
  it("tracks action consumption up to limit", () => {
    const b = new Budget(3, 5);
    expect(b.tryConsumeAction()).toBe(true);
    expect(b.tryConsumeAction()).toBe(true);
    expect(b.tryConsumeAction()).toBe(true);
    expect(b.tryConsumeAction()).toBe(true);
    expect(b.tryConsumeAction()).toBe(true);
    expect(b.tryConsumeAction()).toBe(false);
  });

  it("spawn consumes both spawn and action slots", () => {
    const b = new Budget(2, 5);
    expect(b.tryConsumeSpawn()).toBe(true);
    expect(b.tryConsumeSpawn()).toBe(true);
    expect(b.tryConsumeSpawn()).toBe(false); // spawn exhausted
    expect(b.summary()).toEqual({
      spawnUsed: 2,
      spawnLimit: 2,
      actionUsed: 2,
      actionLimit: 5,
    });
  });

  it("spawn fails when action-budget exhausted even if spawn available", () => {
    const b = new Budget(5, 1);
    expect(b.tryConsumeAction()).toBe(true);
    expect(b.tryConsumeSpawn()).toBe(false); // action exhausted
  });

  it("rejects negative limits", () => {
    expect(() => new Budget(-1, 1)).toThrow();
    expect(() => new Budget(1, -1)).toThrow();
  });
});
