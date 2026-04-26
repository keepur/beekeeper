import { describe, it, expect } from "vitest";
import { extractAnchorNeighborhood } from "./apply.js";

describe("extractAnchorNeighborhood", () => {
  it("extracts text from anchor to next anchor", () => {
    const md = `<a id="a"></a>\nA-body\n<a id="b"></a>\nB-body`;
    const r = extractAnchorNeighborhood(md, "a");
    expect(r).toContain("A-body");
    expect(r).not.toContain("B-body");
  });

  it("extracts to end of document if no next anchor", () => {
    const md = `pre\n<a id="last"></a>\nfinal-body`;
    expect(extractAnchorNeighborhood(md, "last")).toContain("final-body");
  });

  it("returns empty when anchor missing", () => {
    expect(extractAnchorNeighborhood(`no anchors`, "x")).toBe("");
  });
});
