# KPR-106 — smoke-e2e double-anchor fix

## Symptom

`src/frames/commands/smoke-e2e.test.ts` audit step fails on `main` (post-Frames-epic merge). The post-clean-apply audit reports `summary.exitCode === 1` instead of `0`, even though no operator drift has been injected.

## Diagnosis (actual mechanism — differs from ticket hypothesis)

The ticket's hypothesis was: double-anchor → empty inter-anchor `insertedText` → audit comparison fails. Reproduction proved the mechanism is different.

Reproduced locally:

```
BLOCK: "<a id=\"capabilities\"></a>\noriginal capabilities body\n<a id=\"end\"></a>\nend"
REPLACEMENT: "<a id=\"capabilities\"></a>\n<a id=\"capabilities\"></a>\nSmoke replacement capabilities clause.\n"
UPDATED: "<a id=\"capabilities\"></a>\n<a id=\"capabilities\"></a>\nSmoke replacement capabilities clause.\n"
INSERTED_TEXT (write): "<a id=\"capabilities\"></a>\n"
collectAnchorSet(updated): THROWS "Duplicate anchor in document: \"capabilities\""
```

The fixture's `constitution-frag.md` literally contains `<a id="capabilities"></a>` as the first line. `writeConstitutionAnchor` re-emits its own anchor tag (KPR-99 fix), producing a document with two `<a id="capabilities">` tags.

On the audit pass, `checkConstitution` in `drift-detector.ts` calls `collectAnchorSet(content)` which throws on the duplicate anchor. The `try/catch` swallows the throw and produces an empty `present` set. The subsequent `present.has(anchor)` check is then false, so a `constitution-anchor-missing` finding is emitted, causing audit exit code 1.

The reviewer's reasoning ("audit *should* be clean since the same extraction runs both ways") was correct only for the `extractAnchorNeighborhood` path — but `checkConstitution` calls `collectAnchorSet` *first*, and that's what blows up.

## Fix (Option C — fixture cleanup + defensive engine guard)

### 1. Fixture cleanup

`src/frames/commands/smoke-e2e.test.ts` line 86 — remove the in-fragment `<a id="capabilities"></a>` tag from the `constitution-frag.md` write. Frame fragment files should not contain anchor tags; the engine emits them.

Convention to document in the engine guard's code comment: "frame fragment files should NOT contain anchor tags — the engine emits them in `replace-anchor` mode."

### 2. Defensive engine guard

`writeConstitutionAnchor` in `src/frames/asset-writer.ts:469-521`. Before constructing the `replacement` string, strip any leading `<a id="<same-anchor>"></a>` tag (with optional surrounding whitespace/newlines) from `fragmentText`. Defensive against real-world frame authors who include the tag by habit.

The strip should ONLY remove the tag if it matches the same anchor being written; an in-fragment anchor for a *different* id is not necessarily a mistake (though it's a separate concern — out of scope for this fix).

Pseudocode:

```ts
const leadingAnchorRe = new RegExp(
  `^\\s*<a\\s+id\\s*=\\s*"${escapeRe(anchor)}"\\s*(?:/?>\\s*</a>|/>|>)\\s*\\n?`
);
const cleanedFragment = fragmentText.replace(leadingAnchorRe, "");
const replacement = `<a id="${anchor}"></a>\n${heading}${cleanedFragment.trim()}\n`;
```

Apply only in `replace-anchor` branch (that's where the engine prepends a new anchor). For `before-anchor`/`after-anchor`/`append-to-anchor`, the engine does not emit a new tag — the fragment is inserted verbatim — so the guard does not apply.

### 3. Test for the engine guard

Add to `src/frames/asset-writer.test.ts` under the `writeConstitutionAnchor / replace-anchor` describe block: a test that writes a fragment with leading `<a id="<anchor>"></a>` text, asserts the resulting document has exactly one anchor tag (no duplicate), and asserts `collectAnchorSet` succeeds (proxy for "audit-clean").

## Verification

1. `npm run check` clean on the worktree.
2. `MONGODB_TEST_URI=mongodb://localhost:27017 npx vitest run smoke-e2e` — passes (audit exitCode 0).
3. New asset-writer test for the guard passes.

## Out of scope

- The `<a id="end"></a>` tail-clause loss in the smoke fixture (a separate edge case where `replace-anchor` walks past non-frame anchors to end-of-document; documented in `writeConstitutionAnchor` line 484 contract).
- Renaming `collectAnchorSet`'s throw-on-duplicate behavior (it's intentional; the fix is to not produce duplicates in the first place).
- Reviewing other places that swallow `collectAnchorSet` throws — orthogonal hardening.

## Commits

1. `KPR-106: clean up smoke-e2e fixture — frame fragments must not contain anchor tags` — single-file fixture change.
2. `KPR-106: defensive engine guard — strip in-fragment anchor tag in writeConstitutionAnchor` — engine + test.
