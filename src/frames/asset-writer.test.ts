import { describe, it, expect } from "vitest";
import { resolveScheduleSlots, writeConstitutionAnchor } from "./asset-writer.js";
import { sha256Text } from "./text-utils.js";
import type { ScheduleAsset } from "./types.js";
import type { Db } from "mongodb";

function makeMemoryDb(initialContent: string): { db: Db; current: () => string } {
  const state = { content: initialContent };
  const memoryColl = {
    findOne: async (q: Record<string, unknown>) => {
      if ((q as { path?: string }).path === "shared/constitution.md") {
        return { path: "shared/constitution.md", content: state.content };
      }
      return null;
    },
    updateOne: async (
      _q: unknown,
      upd: { $set?: { content?: string } },
      _opts?: unknown,
    ) => {
      if (upd.$set?.content !== undefined) state.content = upd.$set.content;
      return { acknowledged: true };
    },
  };
  const collection = (name: string): unknown => {
    if (name === "memory") return memoryColl;
    return { findOne: async () => null };
  };
  const db = { collection } as unknown as Db;
  return { db, current: () => state.content };
}

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

describe("writeConstitutionAnchor / replace-anchor", () => {
  it("KPR-99: re-emits the anchor tag and title heading", async () => {
    const before = [
      "<a id=\"memory\"></a>",
      "### Old memory section",
      "",
      "old prose that should be replaced",
      "",
      "<a id=\"capabilities\"></a>",
      "### Capabilities",
      "cap-body",
      "",
    ].join("\n");
    const { db, current } = makeMemoryDb(before);
    const frameAnchors = new Set(["memory", "capabilities"]);

    const { insertedText } = await writeConstitutionAnchor(
      db,
      "memory",
      "replace-anchor",
      undefined,
      "new memory prose\nspanning lines",
      "Manage your memory lifecycle",
      frameAnchors,
    );

    const after = current();
    expect(after).toContain("<a id=\"memory\"></a>");
    expect(after).toContain("### Manage your memory lifecycle");
    expect(after).toContain("new memory prose");
    expect(after).not.toContain("old prose that should be replaced");
    // Capabilities section must be intact (not over-replaced).
    expect(after).toContain("<a id=\"capabilities\"></a>");
    expect(after).toContain("cap-body");
    // insertedText returned from the writer should match the post-write
    // neighborhood so audit will compare equal.
    expect(insertedText).toContain("<a id=\"memory\"></a>");
    expect(insertedText).toContain("### Manage your memory lifecycle");
    expect(insertedText).toContain("new memory prose");
  });

  it("KPR-99: omits heading line when title is undefined", async () => {
    const before = "<a id=\"x\"></a>\nold\n";
    const { db, current } = makeMemoryDb(before);
    const frameAnchors = new Set(["x"]);

    await writeConstitutionAnchor(
      db,
      "x",
      "replace-anchor",
      undefined,
      "new",
      undefined,
      frameAnchors,
    );

    const after = current();
    expect(after).toContain("<a id=\"x\"></a>");
    expect(after).toContain("new");
    // No empty "### " heading line.
    expect(after).not.toMatch(/^### \s*$/m);
  });

  it("KPR-100: replace-anchor stops at next FRAME anchor, not at unrelated operator anchors", async () => {
    // Setup: frame anchors {memory, capabilities} are document-adjacent, but
    // the operator has injected <a id="internal-x"> inside the memory section
    // AND has unrelated content with <a id="post-x"> AFTER capabilities.
    //
    // Legacy bug: replacing "memory" stops at <a id="internal-x"> — premature,
    // misses the actual memory-section content the frame owns.
    //
    // Option A fix: scan walks past <a id="internal-x"> (not in frame set) and
    // ends at <a id="capabilities"> (in frame set). The post-capabilities
    // section with <a id="post-x"> is fully preserved (outside memory's
    // neighborhood entirely).
    const before = [
      "intro",
      "",
      "<a id=\"memory\"></a>",
      "### old memory",
      "old memory body",
      "<a id=\"internal-x\"></a>",
      "operator-injected note inside memory — engine will replace this with memory",
      "",
      "<a id=\"capabilities\"></a>",
      "### capabilities",
      "cap-body",
      "",
      "<a id=\"post-x\"></a>",
      "operator's post-frame section — must survive untouched",
      "",
    ].join("\n");
    const { db, current } = makeMemoryDb(before);
    const frameAnchors = new Set(["memory", "capabilities"]);

    await writeConstitutionAnchor(
      db,
      "memory",
      "replace-anchor",
      undefined,
      "fresh memory body",
      "Manage your memory lifecycle",
      frameAnchors,
    );

    const after = current();
    // Memory section was replaced (memory's neighborhood reached capabilities,
    // walking past internal-x without prematurely terminating).
    expect(after).toContain("fresh memory body");
    expect(after).not.toContain("old memory body");
    expect(after).not.toContain("operator-injected note inside memory");
    // Capabilities section is intact (it's the frame-anchor boundary, not part
    // of memory's neighborhood).
    expect(after).toContain("<a id=\"capabilities\"></a>");
    expect(after).toContain("cap-body");
    // Post-capabilities operator content is fully preserved — outside
    // memory's frame-scoped neighborhood entirely.
    expect(after).toContain("<a id=\"post-x\"></a>");
    expect(after).toContain("operator's post-frame section — must survive untouched");
  });

  it("KPR-100 (legacy comparison): unscoped extraction WOULD prematurely terminate at unrelated anchor", async () => {
    // This pins the contrast: with NO frameAnchors arg (legacy behavior), the
    // scan ends at the very first anchor encountered — including operator-added
    // ones. This is what KPR-100 fixes.
    const md = [
      "<a id=\"memory\"></a>",
      "memory body",
      "<a id=\"internal-x\"></a>",
      "operator note",
      "<a id=\"capabilities\"></a>",
      "cap body",
    ].join("\n");
    // Hand-extract via the helper (no frame set) — should end at internal-x.
    const { extractAnchorNeighborhood } = await import("./text-utils.js");
    const legacyHood = extractAnchorNeighborhood(md, "memory");
    expect(legacyHood).toContain("memory body");
    expect(legacyHood).not.toContain("operator note"); // legacy stops here
    // Frame-scoped: should walk past internal-x and stop at capabilities.
    const scopedHood = extractAnchorNeighborhood(
      md,
      "memory",
      new Set(["memory", "capabilities"]),
    );
    expect(scopedHood).toContain("memory body");
    expect(scopedHood).toContain("operator note"); // walks past internal-x
    expect(scopedHood).not.toContain("cap body"); // stops at capabilities
  });

  it("KPR-106: strips leading in-fragment anchor tag matching the same id (no duplicate anchors post-write)", async () => {
    // A frame author who includes `<a id="capabilities"></a>` at the top of
    // their fragment file should still produce a single-anchor document — the
    // engine's emitted anchor wins; the fragment's leading tag is stripped.
    // Without this guard the document would contain two tags for the same id
    // and `collectAnchorSet` would throw during audit, producing a spurious
    // `constitution-anchor-missing` finding.
    const before = "<a id=\"capabilities\"></a>\noriginal body\n";
    const { db, current } = makeMemoryDb(before);
    const frameAnchors = new Set(["capabilities"]);

    await writeConstitutionAnchor(
      db,
      "capabilities",
      "replace-anchor",
      undefined,
      `<a id="capabilities"></a>\nreplacement body\n`,
      undefined,
      frameAnchors,
    );

    const after = current();
    // Exactly one anchor for this id.
    const anchorMatches = after.match(/<a\s+id\s*=\s*"capabilities"\s*(?:\/?>\s*<\/a>|\/>|>)/g) ?? [];
    expect(anchorMatches.length).toBe(1);
    // Body is preserved (the in-fragment anchor was stripped, not the prose).
    expect(after).toContain("replacement body");
    // collectAnchorSet must succeed (proxy for "audit-clean").
    const { collectAnchorSet } = await import("./anchor-resolver.js");
    expect(() => collectAnchorSet(after)).not.toThrow();
  });

  it("KPR-106: leading anchor tag for a DIFFERENT id is left intact", async () => {
    // The strip is scoped to the same anchor id only — an in-fragment anchor
    // for some other id is not necessarily a mistake (separate concern, out of
    // scope for the KPR-106 guard).
    const before = "<a id=\"a\"></a>\nold-a\n";
    const { db, current } = makeMemoryDb(before);
    const frameAnchors = new Set(["a"]);

    await writeConstitutionAnchor(
      db,
      "a",
      "replace-anchor",
      undefined,
      `<a id="other-id"></a>\nfragment body\n`,
      undefined,
      frameAnchors,
    );

    const after = current();
    expect(after).toContain("<a id=\"a\"></a>");
    expect(after).toContain("<a id=\"other-id\"></a>");
    expect(after).toContain("fragment body");
  });

  it("KPR-100: empty frameAnchors set runs scan to end-of-document", async () => {
    // Sanity: with an explicit empty set, no anchor is "in the frame", so the
    // loop never breaks — scan reaches end-of-document. Pins documented
    // semantics; production callers always pass a non-empty set built from
    // manifest.constitution.
    const before = [
      "<a id=\"a\"></a>",
      "a-body",
      "<a id=\"b\"></a>",
      "b-body",
    ].join("\n");
    const { db, current } = makeMemoryDb(before);

    await writeConstitutionAnchor(
      db,
      "a",
      "replace-anchor",
      undefined,
      "new-a",
      "A title",
      new Set(),
    );

    const after = current();
    expect(after).toContain("<a id=\"a\"></a>");
    expect(after).toContain("### A title");
    expect(after).toContain("new-a");
    // Empty set means scan walks past <a id="b"> too — both old bodies removed.
    expect(after).not.toContain("a-body");
    expect(after).not.toContain("b-body");
  });
});
