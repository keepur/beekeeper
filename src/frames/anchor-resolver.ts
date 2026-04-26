/**
 * Locate HTML anchor IDs in markdown text.
 * Used to resolve frame anchor references against constitution/systemPrompt content.
 */

export interface AnchorLocation {
  anchor: string;
  /** Character offset into the source text where `<a id="...">` starts. */
  start: number;
  /** Character offset where the anchor tag ends. */
  end: number;
}

/**
 * Match `<a id="anchor-name"></a>` with optional whitespace and self-close variants.
 * Captures the anchor id.
 */
const ANCHOR_RE = /<a\s+id\s*=\s*"([^"]+)"\s*(?:\/?>\s*<\/a>|\/>|>)/g;

export function findAnchors(markdown: string): AnchorLocation[] {
  const results: AnchorLocation[] = [];
  ANCHOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANCHOR_RE.exec(markdown)) !== null) {
    results.push({ anchor: m[1], start: m.index, end: m.index + m[0].length });
  }
  return results;
}

export function findAnchor(markdown: string, anchor: string): AnchorLocation | undefined {
  return findAnchors(markdown).find((a) => a.anchor === anchor);
}

/**
 * Return the set of anchors present in the document.
 * If the same anchor appears more than once, throws - anchors must be unique.
 */
export function collectAnchorSet(markdown: string): Set<string> {
  const all = findAnchors(markdown);
  const seen = new Set<string>();
  for (const a of all) {
    if (seen.has(a.anchor)) {
      throw new Error(`Duplicate anchor in document: "${a.anchor}"`);
    }
    seen.add(a.anchor);
  }
  return seen;
}

/**
 * Verify that every anchor in `required` is present in the document.
 * Returns the list of missing anchors (empty if all present).
 */
export function checkAnchorsPresent(markdown: string, required: string[]): string[] {
  const present = collectAnchorSet(markdown);
  return required.filter((a) => !present.has(a));
}
