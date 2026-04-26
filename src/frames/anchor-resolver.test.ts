import { describe, it, expect } from "vitest";
import { findAnchor, findAnchors, collectAnchorSet, checkAnchorsPresent } from "./anchor-resolver.js";

describe("anchor-resolver", () => {
  it("finds a single anchor with explicit close", () => {
    const md = `# Title\n\n<a id="memory"></a>\n### 7.3 Memory\nbody\n`;
    const a = findAnchor(md, "memory");
    expect(a).toBeDefined();
    expect(a!.anchor).toBe("memory");
  });

  it("finds a self-closed anchor", () => {
    const md = `<a id="capabilities"/>\n### 7.4 Capabilities\n`;
    expect(findAnchor(md, "capabilities")).toBeDefined();
  });

  it("returns undefined for missing anchor", () => {
    expect(findAnchor("no anchors here", "missing")).toBeUndefined();
  });

  it("collects all anchors", () => {
    const md = `<a id="a"></a>\n<a id="b"></a>\n<a id="c"/>`;
    const set = collectAnchorSet(md);
    expect(set.size).toBe(3);
    expect(set.has("a")).toBe(true);
  });

  it("throws on duplicate anchors", () => {
    const md = `<a id="x"></a>\n<a id="x"></a>`;
    expect(() => collectAnchorSet(md)).toThrow(/Duplicate anchor/);
  });

  it("checkAnchorsPresent reports missing", () => {
    const md = `<a id="memory"></a>`;
    expect(checkAnchorsPresent(md, ["memory", "capabilities"])).toEqual(["capabilities"]);
    expect(checkAnchorsPresent(md, ["memory"])).toEqual([]);
  });

  it("findAnchors returns sequential locations", () => {
    const md = `<a id="a"></a>middle<a id="b"></a>`;
    const list = findAnchors(md);
    expect(list).toHaveLength(2);
    expect(list[0].start).toBeLessThan(list[1].start);
  });
});
