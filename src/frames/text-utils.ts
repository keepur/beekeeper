import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract the text from `<a id="anchor">` to the next anchor (or end-of-document).
 * Returns empty string if anchor is not found.
 */
export function extractAnchorNeighborhood(markdown: string, anchor: string): string {
  const startRe = new RegExp(`<a\\s+id\\s*=\\s*"${escapeRe(anchor)}"\\s*(?:/?>\\s*</a>|/>|>)`);
  const startMatch = markdown.match(startRe);
  if (!startMatch || startMatch.index === undefined) return "";
  const startIdx = startMatch.index;
  const afterStart = startIdx + startMatch[0].length;
  const nextAnchorRe = /<a\s+id\s*=\s*"[^"]+"\s*(?:\/?>\s*<\/a>|\/>|>)/g;
  nextAnchorRe.lastIndex = afterStart;
  const next = nextAnchorRe.exec(markdown);
  const endIdx = next?.index ?? markdown.length;
  return markdown.slice(startIdx, endIdx);
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function computeBundleHash(dir: string): string {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((e) => {
      const p = join(dir, e);
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return sha256Text("");
  }
  if (entries.length === 0) return sha256Text("");
  if (entries.includes("SKILL.md")) return sha256File(join(dir, "SKILL.md"));
  entries.sort();
  return sha256File(join(dir, entries[0]));
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
