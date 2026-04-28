import { describe, expect, it } from "vitest";
import { parseReviewerOutput, reassertVerdict } from "./reviewer-parser.js";

describe("parseReviewerOutput", () => {
  it("parses approve with no findings", () => {
    const out = parseReviewerOutput('```json\n{"verdict":"APPROVE","findings":[]}\n```');
    expect(out.verdict).toBe("APPROVE");
    expect(out.findings).toEqual([]);
  });

  it("re-asserts REQUEST CHANGES when reviewer said APPROVE but had SHOULD-FIX (KPR-84 regression)", () => {
    const out = parseReviewerOutput(
      '```json\n{"verdict":"APPROVE","findings":[{"severity":"SHOULD-FIX","body":"x"}]}\n```',
    );
    expect(out.verdict).toBe("REQUEST CHANGES");
  });

  it("preserves APPROVE when only NICE-TO-HAVE findings", () => {
    const out = parseReviewerOutput(
      '```json\n{"verdict":"APPROVE","findings":[{"severity":"NICE-TO-HAVE","body":"x"}]}\n```',
    );
    expect(out.verdict).toBe("APPROVE");
  });

  it("throws on missing fenced JSON", () => {
    expect(() => parseReviewerOutput("plain prose")).toThrow();
  });

  it("throws on bad severity", () => {
    expect(() =>
      parseReviewerOutput('```json\n{"verdict":"APPROVE","findings":[{"severity":"foo","body":"x"}]}\n```'),
    ).toThrow();
  });
});

describe("reassertVerdict", () => {
  it("BLOCKER forces REQUEST CHANGES", () => {
    expect(
      reassertVerdict("APPROVE", [{ severity: "BLOCKER", body: "x" }]),
    ).toBe("REQUEST CHANGES");
  });

  it("only NICE-TO-HAVE keeps APPROVE", () => {
    expect(
      reassertVerdict("APPROVE", [{ severity: "NICE-TO-HAVE", body: "x" }]),
    ).toBe("APPROVE");
  });
});
