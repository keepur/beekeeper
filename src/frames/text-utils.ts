import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
  // Search only the region after the start anchor for the next boundary.
  const tail = markdown.slice(afterStart);
  const anyAnchorRe = /<a\s+id\s*=\s*"([^"]+)"\s*(?:\/?>\s*<\/a>|\/>|>)/g;
  let endIdx = markdown.length;
  for (const match of tail.matchAll(anyAnchorRe)) {
    if (frameAnchors === undefined || frameAnchors.has(match[1])) {
      endIdx = afterStart + (match.index ?? 0);
      break;
    }
    // continue scanning; this anchor is outside the frame's managed surface.
  }
  return markdown.slice(startIdx, endIdx);
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Compute a content-derived sha256 over a skill bundle directory.
 *
 * Two paths:
 * 1. **Flat-bundle fast path:** if the bundle root contains a regular file
 *    named `SKILL.md`, return `sha256File(SKILL.md)`. This preserves the
 *    legacy hash for existing `applied_frames` records on flat bundles —
 *    no spurious drift on existing instances after this fix lands.
 * 2. **Recursive walk:** for nested-only bundles (and any bundle without
 *    `SKILL.md` at root), depth-first sorted walk the tree and fold each
 *    file's `(posix-relative-path + "\0" + bytes)` into a single sha256.
 *    Stable across reorderings; sensitive to renames; cross-platform via
 *    `posix.join` for the relative-path key.
 *
 * Symlinks and other non-regular entries are skipped — matches the spirit
 * of the legacy `statSync(p).isFile()` filter.
 *
 * Missing/unreadable directory → returns `sha256Text("")` (legacy contract).
 */
export function computeBundleHash(dir: string): string {
  try {
    const rootEntries = readdirSync(dir);
    if (rootEntries.includes("SKILL.md")) {
      const skillPath = join(dir, "SKILL.md");
      if (statSync(skillPath).isFile()) {
        return sha256File(skillPath);
      }
    }
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

export function resourceKey(kind: "constitution", anchor: string): string;
export function resourceKey(kind: "skills", bundle: string): string;
export function resourceKey(kind: "coreservers", agentId: string, server: string): string;
export function resourceKey(kind: "schedule", agentId: string, task: string): string;
export function resourceKey(kind: "prompts", agentId: string, anchor: string): string;
export function resourceKey(kind: "seeds", agentId: string, contentHash: string): string;
export function resourceKey(kind: string, a: string, b?: string): string {
  switch (kind) {
    case "constitution":
      return `constitution:${a}`;
    case "skills": {
      const base = a.split("/").filter(Boolean).pop() ?? a;
      return `skills:${base}`;
    }
    case "coreservers":
      return `coreservers:${a}:${b}`;
    case "schedule":
      return `schedule:${a}:${b}`;
    case "prompts":
      return `prompts:${a}:${b}`;
    case "seeds":
      return `seeds:${a}:${(b ?? "").slice(0, 8)}`;
    default:
      throw new Error(`resourceKey: unknown kind "${kind}"`);
  }
}
