import { describe, it, expect } from "vitest";
import { detectOpenQuestions } from "./sentinel.js";

describe("detectOpenQuestions", () => {
  it("returns complete=false when no fence present", () => {
    expect(detectOpenQuestions("nothing here")).toEqual({ complete: false, openOnly: false });
  });

  it("returns openOnly when only opening fence present (mid-stream)", () => {
    const text = "intro text\n=== OPEN QUESTIONS (BLOCK:HUMAN) ===\n1. partial...";
    expect(detectOpenQuestions(text)).toEqual({ complete: false, openOnly: true });
  });

  it("returns complete=true with parsed questions when both fences present", () => {
    const text = [
      "intro",
      "=== OPEN QUESTIONS (BLOCK:HUMAN) ===",
      "1. Should we use poll or SSE?",
      "2. What sentinel format?",
      "=== END OPEN QUESTIONS ===",
      "trailing",
    ].join("\n");
    const m = detectOpenQuestions(text);
    expect(m.complete).toBe(true);
    expect(m.questions).toEqual([
      "Should we use poll or SSE?",
      "What sentinel format?",
    ]);
  });

  it("ignores non-numbered lines inside the block", () => {
    const text = [
      "=== OPEN QUESTIONS (BLOCK:HUMAN) ===",
      "header line (not a question)",
      "1. first",
      "    indented continuation",
      "2. second",
      "=== END OPEN QUESTIONS ===",
    ].join("\n");
    const m = detectOpenQuestions(text);
    expect(m.questions).toEqual(["first", "second"]);
  });
});
