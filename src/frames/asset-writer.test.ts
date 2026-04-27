import { describe, it, expect } from "vitest";
import { resolveScheduleSlots } from "./asset-writer.js";
import { sha256Text } from "./text-utils.js";
import type { ScheduleAsset } from "./types.js";

describe("resolveScheduleSlots", () => {
  it("explicit cron: every agent gets the same cron string", () => {
    const asset: ScheduleAsset = {
      task: "daily-sweep",
      agents: ["a", "b"],
      cron: "0 9 * * *",
    };
    const slots = resolveScheduleSlots(asset, ["a", "b"]);
    expect(slots).toEqual([
      { agentId: "a", cron: "0 9 * * *", pattern: "explicit", windowSlot: null },
      { agentId: "b", cron: "0 9 * * *", pattern: "explicit", windowSlot: null },
    ]);
  });

  it("pattern: shared mirrors explicit but records pattern label", () => {
    const asset: ScheduleAsset = {
      task: "shared-task",
      agents: ["a", "b"],
      pattern: "shared",
      cron: "30 14 * * 1",
    };
    const slots = resolveScheduleSlots(asset, ["b", "a"]);
    expect(slots.every((s) => s.pattern === "shared")).toBe(true);
    expect(slots.every((s) => s.cron === "30 14 * * 1")).toBe(true);
  });

  it("stagger: assigns slots in sorted-agent order across the window", () => {
    const asset: ScheduleAsset = {
      task: "weekly-checkin",
      agents: ["b", "a", "c"],
      pattern: "stagger",
      window: "fri 14:00-17:00 America/Los_Angeles",
      interval: "15m",
    };
    const slots = resolveScheduleSlots(asset, ["b", "a", "c"]);
    expect(slots.map((s) => s.agentId)).toEqual(["a", "b", "c"]);
    expect(slots[0].cron).toBe("0 14 * * 5");
    expect(slots[1].cron).toBe("15 14 * * 5");
    expect(slots[2].cron).toBe("30 14 * * 5");
    expect(slots.map((s) => s.windowSlot)).toEqual([0, 1, 2]);
  });

  it("stagger: throws when agents exceed slot count", () => {
    const asset: ScheduleAsset = {
      task: "weekly-checkin",
      agents: ["a", "b", "c"],
      pattern: "stagger",
      window: "fri 14:00-14:30 America/Los_Angeles",
      interval: "15m",
    };
    expect(() => resolveScheduleSlots(asset, ["a", "b", "c"])).toThrow(/only 2 stagger slots/);
  });

  it("stagger: rejects non-IANA timezone abbreviations", () => {
    const asset: ScheduleAsset = {
      task: "weekly-checkin",
      agents: ["a"],
      pattern: "stagger",
      window: "fri 14:00-17:00 PT",
      interval: "15m",
    };
    expect(() => resolveScheduleSlots(asset, ["a"])).toThrow(/canonical IANA zone/);
  });

  it("sha256Text is deterministic", () => {
    expect(sha256Text("hello")).toBe(sha256Text("hello"));
    expect(sha256Text("hello")).not.toBe(sha256Text("world"));
    expect(sha256Text("")).toMatch(/^[0-9a-f]{64}$/);
  });
});
