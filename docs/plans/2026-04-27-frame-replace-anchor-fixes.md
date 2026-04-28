# Frame replace-anchor fixes — KPR-100 + KPR-99 implementation plan

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan. Each task is self-contained; commit after each.

**Goal:** Fix two correctness bugs in the frame engine's `replace-anchor` insertion mode that surfaced together during KPR-86 hive-baseline validation against keepur. Both bugs live in the same call site (`writeConstitutionAnchor` in `asset-writer.ts`) and are exercised by the same `frame apply` flow, so they ship in a single PR.

- **KPR-100 (Urgent):** `extractAnchorNeighborhood` ends the neighborhood at the next anchor of *any kind*. When a frame's `replace-anchor` anchors are non-adjacent in the operator's document, intermediate unrelated content is silently devoured. On keepur this destroyed ~2800 chars of constitution.
- **KPR-99 (High):** `replace-anchor` substitutes raw fragment text with no surrounding `<a id>` tag and no heading, so the anchor disappears from the document and the manifest's `title:` field is silently dropped. Subsequent `frame audit` reports false `constitution-anchor-missing` drift.

**Prerequisites:** KPR-83 frames epic (Phases 1+2) merged into the `KPR-83-frames` branch. Both bugs were introduced by KPR-85 Phase 2 (`asset-writer.ts` + `text-utils.ts`). KPR-86 hive-baseline content is the in-tree consumer that exposed the bugs.

**PR base:** `KPR-83-frames` epic branch (per `feedback_pr_base_on_epic_branches.md`). Do **not** target `main` directly — frames code does not yet exist on main.

**Branch:** `KPR-100-anchor-fixes` (single branch covering both tickets; KPR-100 is higher priority).

**Architecture:** Both fixes thread through three files. `text-utils.ts` gains an optional `frameAnchors` arg on `extractAnchorNeighborhood` so callers in apply/drift-detection can request *frame-scoped* neighborhood semantics. `asset-writer.ts:writeConstitutionAnchor` (a) accepts that scoped set, (b) re-emits the anchor + title heading + fragment text as the replacement body, and (c) uses the same scoped extraction for its post-write `insertedText` snapshot so the recorded snapshot matches what audit will later see. `apply.ts` builds the frame's anchor set once and passes it plus the per-anchor `title` to the writer; it also passes the same set into the post-write neighborhood snapshot in `buildAdoptRecord` and `drift-detector.ts:checkConstitution` so audit and adopt agree with apply about what "this anchor's neighborhood" means.

**Tech Stack:** TypeScript (strict, NodeNext), Vitest, MongoDB driver. ESM `.js` import extensions. No new external dependencies. `npm run check` runs typecheck + tests.

**Spec reference:** Linear KPR-99 (description) and KPR-100 (Option A — frame-scoped neighborhood — confirmed by May).

---

## File Structure

### Files to create

None. (Test additions go into existing test files.)

### Files to modify

| File | Reason |
|---|---|
| `src/frames/text-utils.ts` | `extractAnchorNeighborhood(markdown, anchor, frameAnchors?: Set<string>)`. When `frameAnchors` is provided, neighborhood scan walks past anchors that are NOT in the set; it ends at the next anchor that IS in the set, or end-of-document. Default behavior (no arg) is unchanged so existing callers keep working until upgraded. |
| `src/frames/asset-writer.ts` | `writeConstitutionAnchor` signature gains `title: string \| undefined` and `frameAnchors: Set<string>` parameters. `replace-anchor` body becomes `<a id="${anchor}"></a>\n### ${title}\n\n${fragmentText.trim()}\n` (heading line omitted when `title` undefined). All three calls to `extractAnchorNeighborhood` in this function pass `frameAnchors` for consistency. |
| `src/frames/commands/apply.ts` | Build `frameAnchors` from `manifest.constitution.map(c => c.anchor)`. Pass `c.title` and `frameAnchors` into `writeConstitutionAnchor`. In `buildAdoptRecord` constitution loop, pass `frameAnchors` to `extractAnchorNeighborhood` so adopt records agree with apply records. |
| `src/frames/drift-detector.ts` | In `checkConstitution`, build `frameAnchors` from `record.manifest.constitution.map(c => c.anchor)` and pass it to `extractAnchorNeighborhood` so post-apply audit produces the same neighborhood the writer recorded. |
| `src/frames/asset-writer.test.ts` | New describe block: `writeConstitutionAnchor / replace-anchor`. Tests against a mocked `Db`: (a) preserves `<a id>` tag and emits `### title` heading; (b) with non-adjacent unrelated anchors interleaved, neighborhood extraction does NOT over-replace. |
| `src/frames/commands/apply.test.ts` | New tests in the existing `extractAnchorNeighborhood` describe block: (a) `frameAnchors` arg scopes scan to set members; (b) anchors outside the set are walked past. Plus one assertion in `buildAdoptRecord` test that the recorded `insertedText` matches the frame-scoped neighborhood. |
| `src/frames/drift-detector.test.ts` | New test: post-apply, when constitution has non-frame anchors interleaved, the drift detector re-extracts the same neighborhood the writer stored — no false `constitution-text-changed` finding. |

### Files NOT modified (and why)

- `src/frames/types.ts` — `ConstitutionAsset.title` is already optional-string; no schema change needed.
- `src/frames/manifest-loader.ts` — already parses and forwards `title` to `ConstitutionAsset`.
- `src/frames/commands/audit.ts` — delegates to drift-detector; no direct anchor-extraction logic of its own.

---

## Task 1 — Extend `extractAnchorNeighborhood` with optional frame-scope set

**Files:** Modify `src/frames/text-utils.ts`

**Why:** This is the KPR-100 root-cause fix. Today the regex `nextAnchorRe = /<a\s+id\s*=\s*"[^"]+"\s*(?:\/?>\s*<\/a>|\/>|>)/g` matches *any* anchor. When the frame manages anchors A and B but the operator's document also has anchor X between them (or unrelated anchors before/after), the neighborhood for A ends at X — over- or under-replacing relative to "everything until the next *frame* anchor".

Option A (per ticket, May confirmed): pass the frame's anchor set down so the scan can skip anchors not in the set. We keep the old, unscoped behavior as the default so the change is additive — existing call sites (e.g. tests, code paths that don't yet thread the set) keep working unchanged.

- [ ] **Step 1.1** Replace the body of `extractAnchorNeighborhood` with the scoped variant:

```typescript
/**
 * Extract the text from `<a id="anchor">` to the next anchor (or end-of-document).
 *
 * When `frameAnchors` is provided, the scan ends at the next anchor whose id is in
 * that set. Anchors not in the set are walked past — they are part of the
 * operator's document, not part of the frame's managed surface, and the frame's
 * neighborhood should not be cut short by them.
 *
 * Returns empty string if `anchor` itself is not found in `markdown`.
 */
export function extractAnchorNeighborhood(
  markdown: string,
  anchor: string,
  frameAnchors?: Set<string>,
): string {
  const startRe = new RegExp(`<a\\s+id\\s*=\\s*"${escapeRe(anchor)}"\\s*(?:/?>\\s*</a>|/>|>)`);
  const startMatch = markdown.match(startRe);
  if (!startMatch || startMatch.index === undefined) return "";
  const startIdx = startMatch.index;
  const afterStart = startIdx + startMatch[0].length;
  const anyAnchorRe = /<a\s+id\s*=\s*"([^"]+)"\s*(?:\/?>\s*<\/a>|\/>|>)/g;
  anyAnchorRe.lastIndex = afterStart;
  let endIdx = markdown.length;
  let m: RegExpExecArray | null;
  while ((m = anyAnchorRe.exec(markdown)) !== null) {
    if (frameAnchors === undefined || frameAnchors.has(m[1])) {
      endIdx = m.index;
      break;
    }
    // continue scanning; this anchor is outside the frame's managed surface.
  }
  return markdown.slice(startIdx, endIdx);
}
```

Notes:
- Capture group `([^"]+)` extracts the anchor id for membership checks.
- When `frameAnchors === undefined`, the loop's first hit always satisfies the predicate, so behavior matches the pre-change code exactly.
- `frameAnchors` SHOULD include the starting `anchor` itself; the loop already begins scanning *after* the start match, so a self-membership is safe and not re-matched.

- [ ] **Step 1.2** Verify by inspection that no existing callers are broken: the three production call sites that need updating are listed in Tasks 2-4. Tests still call the function with two args in `apply.test.ts` and `drift-detector.test.ts` — those continue to exercise the no-set default and remain valid.

**Verify:** No test changes yet. Run `npm run typecheck` — should pass (signature is additive, optional arg).

**Commit:** `fix(frames/p2): KPR-100 — frame-scoped neighborhood in extractAnchorNeighborhood`

---

## Task 2 — Re-emit anchor tag + title heading in `replace-anchor`

**Files:** Modify `src/frames/asset-writer.ts`

**Why:** This is the KPR-99 fix. Today `writeConstitutionAnchor` substitutes raw `fragmentText` with no anchor wrapper, so the document loses the anchor. Manifest's `title:` field never reaches the writer. The fix is structural: the writer must know the title and re-emit `<a id="anchor"></a>\n### ${title}\n\n${fragmentText.trim()}\n`.

This task also threads `frameAnchors` through every `extractAnchorNeighborhood` call in `writeConstitutionAnchor` so the writer's behavior is consistent with the apply orchestrator's frame-scoped intent (KPR-100 ties in).

- [ ] **Step 2.1** Update the signature and body of `writeConstitutionAnchor`. Current signature (asset-writer.ts:469-475):

```typescript
export async function writeConstitutionAnchor(
  db: Db,
  anchor: string,
  insertMode: ConstitutionInsertMode,
  targetAnchor: string | undefined,
  fragmentText: string,
): Promise<{ snapshotBefore: string; insertedText: string }> {
```

Replace with:

```typescript
export async function writeConstitutionAnchor(
  db: Db,
  anchor: string,
  insertMode: ConstitutionInsertMode,
  targetAnchor: string | undefined,
  fragmentText: string,
  title: string | undefined,
  frameAnchors: Set<string>,
): Promise<{ snapshotBefore: string; insertedText: string }> {
```

- [ ] **Step 2.2** Replace the `replace-anchor` block body (current lines 481-487):

```typescript
  if (insertMode === "replace-anchor") {
    const block = extractAnchorNeighborhood(before, anchor);
    if (!block) {
      throw new Error(`constitution anchor "${anchor}" not found for replace-anchor`);
    }
    const idx = before.indexOf(block);
    updated = before.slice(0, idx) + fragmentText + before.slice(idx + block.length);
  }
```

with:

```typescript
  if (insertMode === "replace-anchor") {
    const block = extractAnchorNeighborhood(before, anchor, frameAnchors);
    if (!block) {
      throw new Error(`constitution anchor "${anchor}" not found for replace-anchor`);
    }
    const idx = before.indexOf(block);
    const heading = title ? `### ${title}\n\n` : "";
    const replacement = `<a id="${anchor}"></a>\n${heading}${fragmentText.trim()}\n`;
    updated = before.slice(0, idx) + replacement + before.slice(idx + block.length);
  }
```

Notes:
- `title` may be undefined (manifest field is optional); when omitted, only the anchor tag is re-emitted, no heading. This keeps frames that don't supply a title from injecting an empty `### ` line.
- Trailing `\n` on the replacement keeps subsequent content separated by a blank line consistent with the original document shape.
- `fragmentText.trim()` strips whatever trailing whitespace the operator's `.md` file shipped with — predictable boundaries.

- [ ] **Step 2.3** Update the two non-replace `extractAnchorNeighborhood` calls (current lines 494, 515) to also pass `frameAnchors`. The non-replace branch needs scoped target neighborhood for the same reason; and the post-write `insertedText` snapshot must use the same scoping the orchestrator+drift-detector will use. Replace the relevant lines:

Line 494 (inside the else-branch of `replace-anchor`):
```typescript
    const targetBlock = extractAnchorNeighborhood(before, targetAnchor);
```
becomes:
```typescript
    const targetBlock = extractAnchorNeighborhood(before, targetAnchor, frameAnchors);
```

Line 515 (post-write snapshot):
```typescript
  const insertedText = extractAnchorNeighborhood(updated, anchor);
```
becomes:
```typescript
  const insertedText = extractAnchorNeighborhood(updated, anchor, frameAnchors);
```

**Verify:** `npm run typecheck` will fail until Task 3 updates the call site in `apply.ts`. That's expected; defer commit until Task 3.

**Commit:** Hold this commit until Task 3 also lands so the tree typechecks. Bundle Tasks 2 + 3 in a single commit:
`fix(frames/p2): KPR-99 — re-emit anchor + title heading in replace-anchor + thread title/frameAnchors through writer`

---

## Task 3 — Thread `title` + `frameAnchors` from apply orchestrator into writer

**Files:** Modify `src/frames/commands/apply.ts`

**Why:** Manifest carries `title` per constitution entry but the orchestrator drops it before calling the writer. Same applies for `frameAnchors`. This task plumbs both through. Also updates `buildAdoptRecord`'s constitution snapshot loop to use the frame-scoped neighborhood, so adopt and apply produce equivalent recorded `insertedText` for the same input.

- [ ] **Step 3.1** In `executeFullApply`, build the frame's constitution-anchor set once at the top of the constitution loop (around line 312) and pass it plus `c.title` into `writeConstitutionAnchor`. Replace the existing block (current lines 311-333):

```typescript
    // 6f. constitution — capture single snapshot before the first write.
    for (const c of manifest.constitution ?? []) {
      const key = resourceKey("constitution", c.anchor);
      if (forceWriteResources && !forceWriteResources.has(key)) continue;
      let fragmentText: string;
      const dr = dialogResultsByResource?.get(key);
      if (dr?.decision === "merged" && dr.mergedText !== undefined) {
        fragmentText = dr.mergedText;
      } else {
        fragmentText = readFileSync(join(manifest.rootPath, c.file), "utf-8");
      }
      const { snapshotBefore, insertedText } = await writeConstitutionAnchor(
        db,
        c.anchor,
        c.insert,
        c.targetAnchor,
        fragmentText,
      );
      if (constitutionSnapshotBefore === undefined) constitutionSnapshotBefore = snapshotBefore;
      constitutionInsertedText[c.anchor] = insertedText;
      constitutionAnchorsWritten.push(c.anchor);
      writtenLabels.push(key);
    }
```

with:

```typescript
    // 6f. constitution — capture single snapshot before the first write.
    const constitutionFrameAnchors = new Set(
      (manifest.constitution ?? []).map((c) => c.anchor),
    );
    for (const c of manifest.constitution ?? []) {
      const key = resourceKey("constitution", c.anchor);
      if (forceWriteResources && !forceWriteResources.has(key)) continue;
      let fragmentText: string;
      const dr = dialogResultsByResource?.get(key);
      if (dr?.decision === "merged" && dr.mergedText !== undefined) {
        fragmentText = dr.mergedText;
      } else {
        fragmentText = readFileSync(join(manifest.rootPath, c.file), "utf-8");
      }
      const { snapshotBefore, insertedText } = await writeConstitutionAnchor(
        db,
        c.anchor,
        c.insert,
        c.targetAnchor,
        fragmentText,
        c.title,
        constitutionFrameAnchors,
      );
      if (constitutionSnapshotBefore === undefined) constitutionSnapshotBefore = snapshotBefore;
      constitutionInsertedText[c.anchor] = insertedText;
      constitutionAnchorsWritten.push(c.anchor);
      writtenLabels.push(key);
    }
```

- [ ] **Step 3.2** Update `buildAdoptRecord`'s constitution snapshot loop (current lines 757-773). Replace:

```typescript
  // Constitution: full document snapshot + per-anchor neighborhood.
  const constitutionAnchors = (manifest.constitution ?? []).map((c) => c.anchor);
  if (constitutionAnchors.length > 0) {
    const doc = await db
      .collection<{ path: string; content: string }>("memory")
      .findOne({ path: "shared/constitution.md" });
    const fullText = doc?.content ?? "";
    const insertedText: Record<string, string> = {};
    for (const a of constitutionAnchors) {
      insertedText[a] = extractAnchorNeighborhood(fullText, a);
    }
    resources.constitution = {
      anchors: constitutionAnchors,
      snapshotBefore: fullText,
      insertedText,
    };
  }
```

with:

```typescript
  // Constitution: full document snapshot + per-anchor neighborhood (frame-scoped).
  const constitutionAnchors = (manifest.constitution ?? []).map((c) => c.anchor);
  if (constitutionAnchors.length > 0) {
    const doc = await db
      .collection<{ path: string; content: string }>("memory")
      .findOne({ path: "shared/constitution.md" });
    const fullText = doc?.content ?? "";
    const constitutionFrameAnchors = new Set(constitutionAnchors);
    const insertedText: Record<string, string> = {};
    for (const a of constitutionAnchors) {
      insertedText[a] = extractAnchorNeighborhood(fullText, a, constitutionFrameAnchors);
    }
    resources.constitution = {
      anchors: constitutionAnchors,
      snapshotBefore: fullText,
      insertedText,
    };
  }
```

Note: prompts also use `extractAnchorNeighborhood` (line 743), but prompts have no equivalent over-replacement bug — there's only one anchor per prompt clause and `writePromptClause` uses insert-after-anchor semantics, not `replace-anchor`. Leaving prompts unscoped is safe and out of scope for this PR.

**Verify:** `npm run typecheck` should now pass (signature fully matches). `npm run test` should still pass (existing tests don't exercise the new behavior yet — Tasks 5+ add the assertions).

**Commit:** Bundle with Task 2 — `fix(frames/p2): KPR-99 — re-emit anchor + title heading in replace-anchor + thread title/frameAnchors through writer`.

---

## Task 4 — Use frame-scoped neighborhood in drift detector

**Files:** Modify `src/frames/drift-detector.ts`

**Why:** Audit re-extracts the constitution neighborhood post-apply and compares against the snapshot recorded by `writeConstitutionAnchor`. Both sides must use the same scoping or audit will report spurious `constitution-text-changed` findings the moment the operator's document gains an unrelated anchor between two frame anchors. The drift detector has the manifest stored on the record, so it can build the same `frameAnchors` set the writer used.

- [ ] **Step 4.1** Update `checkConstitution` (current lines 41-81). The change is a one-liner inside the existing function: build `frameAnchors` from the record's manifest, and pass it as the third arg to `extractAnchorNeighborhood`. Insert the following lines just before the `for (const anchor of block.anchors)` loop:

```typescript
  const frameAnchors = new Set(
    (record.manifest.constitution ?? []).map((c) => c.anchor),
  );
```

Then change the existing line:
```typescript
    const actual = extractAnchorNeighborhood(content, anchor);
```
to:
```typescript
    const actual = extractAnchorNeighborhood(content, anchor, frameAnchors);
```

**Verify:** `npm run check` — typecheck + all existing tests pass.

**Cross-test interaction note:** Existing `drift-detector.test.ts` test "flags constitution-text-changed" builds a record where `manifest.constitution` is left out of the fixture (`makeRecord` only seeds `name`, `version`, `rootPath`). After this change, `frameAnchors` for that record is `new Set()` (empty), which per Task 1's logic causes the scan to walk to end-of-document. The test's recorded `insertedText` was built with the no-arg variant (ends at next anchor). These two extractions differ — but the test expects exactly one `constitution-text-changed` finding, and the actual content also differs anyway, so the assertion still holds. No fixture update required. If a future test is added that asserts "no drift on identical content" with `manifest.constitution` undefined, that test would need to populate `manifest.constitution` to match the writer-side fixture.

**Commit:** `fix(frames/p2): KPR-99/100 — frame-scoped neighborhood in drift detector for consistency with writer`

---

## Task 5 — Tests for `writeConstitutionAnchor / replace-anchor`

**Files:** Modify `src/frames/asset-writer.test.ts`

**Why:** Lock in both fixes with executable assertions: (a) anchor tag survives, title heading is emitted; (b) non-adjacent unrelated anchors don't cause over-replacement.

The existing `asset-writer.test.ts` only exercises `resolveScheduleSlots` and `sha256Text`. We need a small in-memory `Db` mock for `memory` collection (the writer reads `memory.findOne({path:"shared/constitution.md"})` and writes back via `updateOne`).

- [ ] **Step 5.1** Add the imports and mock helper at the top of the file (after the existing imports):

```typescript
import { writeConstitutionAnchor } from "./asset-writer.js";
import type { Db } from "mongodb";

interface MemoryDoc {
  path: string;
  content: string;
}

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
```

- [ ] **Step 5.2** Add a new describe block at the bottom of the file with four tests covering:
  1. **KPR-99 happy-path:** replace-anchor preserves `<a id="memory">` and emits `### <title>` heading; `insertedText` returned from writer matches the post-write extraction (audit will compare equal).
  2. **KPR-99 no-title:** when `title === undefined`, no `### ` heading line is injected.
  3. **KPR-100 frame scope:** with frame anchors `{memory, capabilities}` and an unrelated `<a id="internal-x">` between them, replacing `memory` does NOT touch `internal-x` or `capabilities` content.
  4. **KPR-100 empty-set sanity:** documenting that an empty `frameAnchors` set falls back to "ends at any next anchor" (no anchor is in the set, so the first anchor encountered satisfies "in set === undefined" check)—WAIT: re-read Task 1 logic. The predicate is `frameAnchors === undefined || frameAnchors.has(m[1])`. With empty set: `undefined === undefined` is false, AND `has(m[1])` is false (set is empty). So scan walks past every anchor and runs to EOD. Adjust this test to assert: empty set causes scan to reach end-of-document.

  Concrete test bodies (paste verbatim):

```typescript
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
    expect(after).toContain("<a id=\"capabilities\"></a>");
    expect(after).toContain("cap-body");
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
    expect(after).not.toMatch(/^### \s*$/m);
  });

  it("KPR-100: replace-anchor stops at next FRAME anchor, walks past unrelated anchors", async () => {
    const before = [
      "intro",
      "",
      "<a id=\"memory\"></a>",
      "### old memory",
      "old memory body",
      "",
      "<a id=\"internal-x\"></a>",
      "operator's own subsection — must survive",
      "",
      "<a id=\"capabilities\"></a>",
      "### capabilities",
      "cap-body",
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
    expect(after).toContain("fresh memory body");
    expect(after).not.toContain("old memory body");
    expect(after).toContain("<a id=\"internal-x\"></a>");
    expect(after).toContain("operator's own subsection — must survive");
    expect(after).toContain("<a id=\"capabilities\"></a>");
    expect(after).toContain("cap-body");
  });

  it("KPR-100: empty frameAnchors set runs scan to end-of-document", async () => {
    // Sanity check: with an explicit empty set, no anchor is "in the frame",
    // so the loop never breaks — scan reaches end-of-document and the entire
    // tail of the doc gets replaced. This pins the documented semantics so
    // callers know what to expect with an empty set. apply.ts always passes
    // a non-empty set built from manifest.constitution.
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
```

- [ ] **Step 5.3** Run `npm run test -- src/frames/asset-writer.test.ts`. All four new tests must pass; existing tests in the file unaffected.

**Verify:** `npm run check` green.

**Commit:** `test(frames/p2): KPR-99/100 — replace-anchor preserves anchor tag, title heading, and frame scope`

---

## Task 6 — Tests for frame-scoped `extractAnchorNeighborhood` and adopt-record consistency

**Files:** Modify `src/frames/commands/apply.test.ts`

**Why:** Lock in the text-utils signature and ensure `buildAdoptRecord` records use the frame-scoped neighborhood.

- [ ] **Step 6.1** Add three tests to the existing `describe("extractAnchorNeighborhood", ...)` block (current lines 11-27):

```typescript
  it("KPR-100: with frameAnchors set, ends at next anchor in the set", () => {
    const md = [
      "<a id=\"a\"></a>",
      "a-body",
      "<a id=\"x\"></a>",
      "operator-injected",
      "<a id=\"b\"></a>",
      "b-body",
    ].join("\n");
    const r = extractAnchorNeighborhood(md, "a", new Set(["a", "b"]));
    expect(r).toContain("a-body");
    expect(r).toContain("operator-injected"); // walks past x
    expect(r).not.toContain("b-body");
  });

  it("KPR-100: with frameAnchors set, walks past anchors not in the set", () => {
    const md = [
      "<a id=\"a\"></a>",
      "a-body",
      "<a id=\"x\"></a>",
      "x-body",
    ].join("\n");
    const r = extractAnchorNeighborhood(md, "a", new Set(["a"]));
    // No other frame anchor — neighborhood runs to end-of-document.
    expect(r).toContain("a-body");
    expect(r).toContain("x-body");
  });

  it("KPR-100: empty frameAnchors set runs scan to end-of-document", () => {
    const md = `<a id="a"></a>\nA-body\n<a id="b"></a>\nB-body`;
    const r = extractAnchorNeighborhood(md, "a", new Set());
    // Empty set: no anchor is in the frame, so scan walks past <a id="b"> too.
    expect(r).toContain("A-body");
    expect(r).toContain("B-body");
  });
```

- [ ] **Step 6.2** Add an assertion to the existing `buildAdoptRecord populates all six asset types` test confirming the recorded `insertedText.cap` matches what frame-scoped extraction produces. The current assertion is `expect(record.resources.constitution?.insertedText.cap).toContain("cap-body");`. Add immediately after:

```typescript
    // KPR-100: adopt's recorded neighborhood is frame-scoped (matches what apply
    // would write later). Single-anchor frame -> neighborhood runs to EOD,
    // including the operator's <a id="end"> marker that the frame doesn't manage.
    expect(record.resources.constitution?.insertedText.cap).toContain(
      "<a id=\"end\"></a>",
    );
    expect(record.resources.constitution?.insertedText.cap).toContain("end");
```

(The test fixture's constitution is `<a id="cap"></a>\ncap-body\n<a id="end"></a>\nend`. With single-anchor frame scope, `cap`'s neighborhood now runs past the unrelated `<a id="end">` anchor to end-of-document. The earlier `toContain("cap-body")` assertion still holds.)

**Verify:** `npm run test -- src/frames/commands/apply.test.ts` passes.

**Commit:** `test(frames/p2): KPR-100 — frameAnchors-scoped neighborhood unit tests + adopt-record consistency assertion`

---

## Task 7 — Test for drift-detector consistency with writer's frame-scoped extraction

**Files:** Modify `src/frames/drift-detector.test.ts`

**Why:** Pin the audit-side contract: when the operator's document has non-frame anchors interleaved between frame anchors, drift detection should NOT report `constitution-text-changed`. This is the regression test for KPR-99's downstream symptom (false drift).

- [ ] **Step 7.1** Read the current `drift-detector.test.ts` to identify the existing fixture pattern. It already builds a record with `manifest.constitution` and an `insertedText` snapshot; we extend the same pattern. If the file lacks a memory-Db helper, factor a small one mirroring Task 5's `makeMemoryDb`.

- [ ] **Step 7.2** Add a new test to the existing describe block that exercises this exact scenario. The test fixture should:
  1. Build a frame manifest with two constitution anchors (e.g. `memory`, `capabilities`).
  2. Build a constitution document where `memory` is followed by an unrelated anchor `<a id="internal-x"></a>` and then `capabilities`.
  3. Compute the expected `insertedText["memory"]` and `insertedText["capabilities"]` using `extractAnchorNeighborhood(content, anchor, new Set(["memory","capabilities"]))` — same as what the writer would store post-apply.
  4. Construct the `AppliedFrameRecord` with that fixture and run `detectDrift`.
  5. Assert: zero `constitution-text-changed` and zero `constitution-anchor-missing` findings.

  The new test (append after existing tests in the same describe block):

```typescript
  it("KPR-99/100: no false drift when constitution has non-frame anchors interleaved", async () => {
    const content = [
      "intro",
      "",
      "<a id=\"memory\"></a>",
      "### Manage your memory lifecycle",
      "",
      "memory body",
      "",
      "<a id=\"internal-x\"></a>",
      "operator's own subsection",
      "",
      "<a id=\"capabilities\"></a>",
      "### capabilities",
      "cap-body",
      "",
    ].join("\n");
    const frameAnchors = new Set(["memory", "capabilities"]);
    const memoryNeighborhood = extractAnchorNeighborhood(content, "memory", frameAnchors);
    const capabilitiesNeighborhood = extractAnchorNeighborhood(
      content,
      "capabilities",
      frameAnchors,
    );

    const db = makeMemoryDb(content); // see Task 5 helper; reuse if already imported
    const record: AppliedFrameRecord = {
      _id: "test-frame",
      version: "1.0.0",
      appliedAt: new Date(),
      appliedBy: "tester",
      manifest: {
        name: "test-frame",
        version: "1.0.0",
        rootPath: "/tmp/frame",
        constitution: [
          { anchor: "memory", insert: "replace-anchor", file: "ignored.md" },
          { anchor: "capabilities", insert: "replace-anchor", file: "ignored.md" },
        ],
      },
      resources: {
        constitution: {
          anchors: ["memory", "capabilities"],
          snapshotBefore: content,
          insertedText: {
            memory: memoryNeighborhood,
            capabilities: capabilitiesNeighborhood,
          },
        },
      },
    };

    const findings = await detectDrift(db, record, "/tmp/svc");
    const constitutionDrift = findings.filter(
      (f) =>
        f.kind === "constitution-text-changed" ||
        f.kind === "constitution-anchor-missing",
    );
    expect(constitutionDrift).toEqual([]);
  });
```

(If the existing test file uses a different helper-name convention or imports, adapt to match. The plan author should adapt to whatever fixture pattern is already in `drift-detector.test.ts` rather than introducing a parallel one.)

**Verify:** `npm run test -- src/frames/drift-detector.test.ts` — all existing tests still green; new test passes.

**Commit:** `test(frames/p2): KPR-99 — drift detector matches writer's frame-scoped neighborhood`

---

## Task 8 — Final quality gate

**Files:** None (verification only)

- [ ] **Step 8.1** Run `npm run check`. Must be 100% green: typecheck clean, all tests pass, no skipped tests added by this PR.

- [ ] **Step 8.2** Run a focused regression check: `npm run test -- src/frames/`. Confirms full frames suite passes including unchanged tests in `applied-frames-store.test.ts`, `anchor-resolver.test.ts`, `manifest-loader.test.ts`, `commands/audit.test.ts`, `commands/remove.test.ts`, `commands/smoke-e2e.test.ts`. The mongo-gated e2e suite is allowed to skip if no `BEEKEEPER_MONGO_URI` env var (default).

- [ ] **Step 8.3** `git log --oneline KPR-83-frames..HEAD` to confirm commits are clean and small (target: 4 commits — Task 1, Tasks 2+3 bundled, Task 4, Tasks 5+6+7 bundled OR split per task; either works, prefer per-task for git bisect).

**Verify:** Both bugs fixed; no test regressions; tree typechecks; all production call sites updated to pass `frameAnchors`; manifest's `title` field reaches the writer.

---

## Out of scope / follow-ups

- Prompts (`writePromptClause`) and other anchor-using paths are NOT scoped to frame-anchors in this PR. Prompts are insert-after-anchor and don't share the over-replacement risk. If a future bug surfaces there, mirror the same pattern.
- Phase-2 design spec (`docs/specs/2026-04-25-frames-design.md`) makes no statement about `replace-anchor`'s exact emission shape; this PR establishes `<a id></a>\n### title\n\n<body>\n` as the contract. The spec should be amended in a follow-up doc PR if needed.
- KPR-86 hive-baseline keepur full-apply (Task 8 of the KPR-86 plan, currently blocked) becomes unblocked once this PR merges into `KPR-83-frames`. That's a separate piece of work, not this ticket.

## Risks

- **Existing applied frames recorded under the old neighborhood semantics.** Any frame already applied (dodi, e.g.) has `insertedText` recorded with un-scoped neighborhoods. Audit after this PR ships will use frame-scoped extraction — for single-anchor or all-adjacent-anchor frames, results are identical (verified in Task 6 Step 6.2 sanity assertion). For frames where the recorded neighborhood differs from the new scoped extraction, audit may report `constitution-text-changed`; the operator can re-apply (with `--yes` if desired) to reconcile. This is acceptable because (a) the only consumers today are dodi (verified single-anchor on adopt) and the broken keepur attempt (`frame remove`'d), and (b) re-apply is the existing recovery path.
- **`fragmentText.trim()` strips trailing whitespace.** Authors who relied on trailing newlines in their fragment files lose that trailing whitespace. The `\n` we append after the trim restores a single trailing newline. Net: one trailing newline guaranteed; multiple trailing newlines collapsed. Acceptable for the hive-baseline use case.
- **No e2e test of full apply→audit cycle in this PR.** The smoke-e2e test (`commands/smoke-e2e.test.ts`) is mongo-gated and not exercised by `npm run check`. Manual verification against keepur is deferred to KPR-86 Task 8 once this lands. Acceptable trade-off — the unit tests pin the bug-fix shapes.

## Verification before submit

- [ ] `npm run check` green
- [ ] All task commits in branch history
- [ ] No accidental edits in `~/github/hive/...` (worktree is `~/github/beekeeper-KPR-100-anchor-fixes`)
- [ ] PR base = `KPR-83-frames`, NOT `main`
- [ ] PR title = `KPR-100 + KPR-99: fix frame replace-anchor neighborhood + anchor re-emission`
