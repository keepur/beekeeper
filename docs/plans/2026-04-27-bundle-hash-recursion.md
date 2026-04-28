# KPR-98 — `computeBundleHash` Recursion Fix Implementation Plan

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan. Each task is self-contained; commit after each.

**Goal:** Fix `computeBundleHash` in `src/frames/text-utils.ts` so that skill bundles whose root contains only subdirectories (no top-level files) produce a real, content-derived sha256 instead of the empty-string hash. After this lands, drift detection will fire correctly for nested-only bundles (e.g. dodi's legacy `skills/<name>/skills/<sub>/SKILL.md` shape used by `hive-baseline`).

**Prerequisites:** KPR-83-frames epic branch (Phase 1 + Phase 2 already merged). KPR-100/99 PR #33 may or may not be merged when this PR opens — its diff in the same file is confined to `extractAnchorNeighborhood` and does not collide with `computeBundleHash`.

**PR base:** `KPR-83-frames` epic branch (per `feedback_pr_base_on_epic_branches.md`). Do **not** target main directly.

**Architecture:** Single-file source change in `src/frames/text-utils.ts` plus a new dedicated test file `src/frames/text-utils.test.ts`. No new dependencies. No call-site changes — the function signature is unchanged (`(dir: string) => string`).

**Tech Stack:** TypeScript (strict, NodeNext), Vitest, `node:crypto`, `node:fs` (`readdirSync`/`statSync`/`readFileSync`), `node:path` (`join`, `posix.join`). ESM `.js` import extensions.

**Spec reference:** Linear ticket KPR-98 (full cause analysis + reference pseudocode in description).

---

## File Structure

### Files to create

| File | Responsibility |
|---|---|
| `src/frames/text-utils.test.ts` | Unit tests for `computeBundleHash`: flat bundle backwards-compat, nested-only bundle non-empty + stable, reordering invariance, content-rename sensitivity, empty/missing dir behavior. |

### Files to modify

| File | Reason |
|---|---|
| `src/frames/text-utils.ts` | Replace the body of `computeBundleHash` with a recursive walk; preserve the flat-bundle fast path so existing `applied_frames` records keep matching (decision (i) below). |

### Files NOT touched

- `src/frames/asset-writer.ts`, `src/frames/drift-detector.ts`, `src/frames/commands/apply.ts` — all callers of `computeBundleHash` keep the same signature; no edits needed.

---

## Backwards-Compatibility Decision

The ticket cites three options. **Decision: (i) — preserve flat-bundle hash exactly, recurse only for nested-only bundles.**

- **(i) Flat-bundle fast path + recursive fallback.** If the bundle root contains a file named `SKILL.md`, return `sha256File(SKILL.md)` (legacy behavior). Otherwise walk recursively. **Chosen.**
  - **Pro:** Existing `applied_frames` records for flat bundles continue to match — no spurious drift on existing dodi/keepur instances. Only the buggy nested-only path is corrected. Smallest blast radius. Addresses the actual bug.
  - **Con:** Two semantically different hash schemes for "flat" vs "nested" bundles. Acceptable: the flat-bundle case is provably equivalent to its recursive form modulo path-prefix bytes, but reproducing it exactly avoids any migration churn for existing records.

- **(ii) Always recurse, no fast path.** Uniform semantics, but every existing flat-bundle `applied_frames` record reports drift on next audit. Larger blast radius for zero behavioral upside in the bug-fix scope.

- **(iii) Hash version marker.** Engineering overhead (record-shape change, audit special-casing) for a one-off migration window. Overkill.

**Migration impact under (i):**
- Flat bundles with `SKILL.md` at root: **no change**, no drift, no operator action.
- Nested-only bundles (e.g. `hive-baseline`'s `memory-hygiene` shape): existing records have empty-hash entries; first audit after this PR ships will report `skill-modified-locally` drift; operator picks `take-frame` in the drift dialog to refresh the snapshot. Note this in PR body.

**Edge case:** A bundle with no `SKILL.md` at root but other files at root (e.g. only `notes.md` at root and a `skills/` subdir). Today the legacy path picks the first file alphabetically and hashes only that — silently wrong but not the empty-hash bug. Under (i), since `SKILL.md` is absent at root, we fall through to the recursive walk, which is strictly more correct than the legacy single-file behavior. This is a quiet improvement, not a regression: any existing record matching the legacy "first file" hash will now report drift exactly as the nested-only case does, and `take-frame` resolves it the same way. Document this in PR body alongside the nested-only migration note.

---

## Implementation

### Task 1 — Refactor `computeBundleHash` to recurse

**File:** `src/frames/text-utils.ts`

**Change shape:**

1. Keep imports as-is (`createHash`, `readFileSync`, `readdirSync`, `statSync`, `join`). Add `posix` to the `node:path` import.
2. Replace the body of `computeBundleHash(dir: string): string`:
   - Wrap the entire operation in `try { ... } catch { return sha256Text(""); }` — preserves legacy "missing/unreadable dir → empty-string hash" contract.
   - Inside the try: `readdirSync(dir)` to get root entries. If the root entries include a regular file named `SKILL.md`, return `sha256File(join(dir, "SKILL.md"))` (flat-bundle fast path — preserves existing record hashes).
   - Otherwise, perform a depth-first sorted walk. For each file encountered, fold `(relativePath + "\0" + fileBytes)` into a single `createHash("sha256")` accumulator. Use `posix.join` for relative paths so the hash is stable across macOS/Linux/Windows.
   - Skip non-file, non-directory entries (symlinks, sockets, etc.) — `statSync` then check `isFile()` or `isDirectory()`. This matches the spirit of the legacy filter.
   - Return `acc.digest("hex")`.

**Reference (from the ticket, with the fast path layered on):**

```typescript
export function computeBundleHash(dir: string): string {
  try {
    const rootEntries = readdirSync(dir);
    // Fast path: flat bundle with SKILL.md at root — preserves legacy hash
    // so existing applied_frames records continue to match.
    if (rootEntries.includes("SKILL.md")) {
      const skillPath = join(dir, "SKILL.md");
      if (statSync(skillPath).isFile()) {
        return sha256File(skillPath);
      }
    }
    // Recursive walk for nested-only bundles (and bundles without SKILL.md at root).
    const acc = createHash("sha256");
    const walk = (d: string, rel: string): void => {
      const entries = readdirSync(d).sort();
      for (const e of entries) {
        const full = join(d, e);
        const relPath = rel === "" ? e : posix.join(rel, e);
        const st = statSync(full);
        if (st.isFile()) {
          acc.update(relPath + "\0");
          acc.update(readFileSync(full));
        } else if (st.isDirectory()) {
          walk(full, relPath);
        }
        // ignore symlinks / other non-regular entries
      }
    };
    walk(dir, "");
    return acc.digest("hex");
  } catch {
    return sha256Text("");
  }
}
```

**Verify after edit:** `npm run typecheck` clean.

**Commit:** `fix(frames): KPR-98 — computeBundleHash recurses into nested skill bundles`

### Task 2 — Add tests for `computeBundleHash`

**File:** `src/frames/text-utils.test.ts` (new)

**Test fixtures use `mkdtempSync(join(tmpdir(), "khash-"))` per test** (no shared state, no leftover dirs). Pattern: each test builds the bundle shape with `mkdirSync({ recursive: true })` + `writeFileSync`, calls `computeBundleHash`, asserts, then `rmSync({ recursive: true, force: true })` in `afterEach` or a try/finally.

**Test cases:**

1. **Flat bundle with `SKILL.md` at root → matches legacy `sha256File(SKILL.md)`.**
   - Fixture: `<bundle>/SKILL.md` containing `"# legacy skill\n"`.
   - Assert: `computeBundleHash(bundle) === sha256File(<bundle>/SKILL.md)`. This pins the backwards-compat path so future refactors don't drift.

2. **Nested-only bundle → produces a non-empty, non-`sha256Text("")` hash.**
   - Fixture: `<bundle>/skills/<sub>/SKILL.md` (mirrors `hive-baseline/memory-hygiene` shape).
   - Assert: hash is a 64-hex string, not equal to `sha256Text("")` (i.e. not `e3b0c44...`).

3. **Nested-only bundle is stable across calls.**
   - Same fixture as (2). Compute twice. Assert equality.

4. **Reordering files within a bundle does not change the hash.**
   - Two fixtures with identical file content but written in different `writeFileSync` orders (this exercises the `readdirSync().sort()` invariance). Use multiple files at the same depth: e.g. `<bundle>/skills/sub/a.md` and `<bundle>/skills/sub/b.md`. Compute hashes of both; assert equal. (Filesystem readdir order varies — sort makes it deterministic.)

5. **Renaming a file inside the bundle changes the hash.**
   - Two fixtures: `<bundle>/skills/sub/SKILL.md` (content `"X"`) vs `<bundle>/skills/sub/RENAMED.md` (content `"X"`). Same byte content, different relative path. Assert hashes differ. (This validates the `relativePath + "\0"` mixing — without it, a rename would be invisible.)

6. **Modifying file content changes the hash.**
   - Two fixtures with same path layout but different file content. Assert hashes differ.

7. **Empty directory → returns `sha256Text("")` (preserves legacy contract for "nothing to hash").**
   - Fixture: empty `<bundle>/`. Assert `computeBundleHash(bundle) === sha256Text("")`.

8. **Missing/unreadable directory → returns `sha256Text("")` (preserves legacy contract).**
   - Path that doesn't exist. Assert `computeBundleHash("/nonexistent/path") === sha256Text("")`.

9. **Bundle with file at root but no `SKILL.md` falls through to recursive walk.**
   - Fixture: `<bundle>/notes.md` + `<bundle>/skills/sub/SKILL.md`. Compute hash. Assert non-empty and not equal to `sha256File(<bundle>/notes.md)` (which is what the legacy code would have returned). This documents the "quiet improvement" called out in the migration section of the PR body.

**Verify after add:** `npm run test -- src/frames/text-utils.test.ts` all pass; `npm run typecheck` clean.

**Commit:** `test(frames): KPR-98 — cover computeBundleHash recursion + flat-path compat`

---

## Verification

After both commits land in the worktree:

1. `npm run check` (typecheck + full test suite) passes.
2. Manual sanity (optional): build a temp dir mirroring `~/.beekeeper/frames/hive-baseline/skills/memory-hygiene/skills/memory-hygiene-review/SKILL.md` and call `computeBundleHash` from a one-liner — confirm it returns a non-empty hex string. Not required if test (2) passes.

---

## Out of Scope

- Migrating existing `applied_frames` records. Per ticket, drift dialog handles this naturally on first audit.
- Touching the flat-bundle "first file alphabetically" legacy hash beyond preserving it for the `SKILL.md` case. The non-`SKILL.md`-at-root edge case (very rare in practice) gets a quiet upgrade to recursive hashing — documented in the PR body, not gated.
- Bumping a hash version marker on `applied_frames` records (option (iii)).
- Any change to `computeBundleHash` callers (`asset-writer.ts`, `drift-detector.ts`, `commands/apply.ts`) — signature unchanged, semantics tightened in the failure case only.

## Risks

- **Coexistence with PR #33.** Both PRs touch `src/frames/text-utils.ts` but on disjoint blocks (`extractAnchorNeighborhood` vs `computeBundleHash`). Expected to be a clean three-way merge. If PR #33 lands first, rebase on the updated epic before pushing — should be a no-op auto-merge of the import-line changes (only `posix` is added here; PR #33 doesn't touch imports).
- **Cross-platform path determinism.** Using `posix.join` for relative paths inside the hash ensures hashes are byte-identical regardless of host OS path separator. Tests run on macOS in CI; Windows path separators in the relative key would otherwise produce different hashes — `posix.join` neutralizes this.
- **Symlinks.** Skipped (not file, not dir). If an operator symlinks files into a bundle, those won't contribute to the hash. This matches today's `statSync(p).isFile()` filter behavior — no regression.
