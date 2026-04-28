import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResolvedRepo, TicketState } from "./types.js";
import type { PipelineConfig } from "../types.js";

const DESCRIPTION_HINTS: Array<{ name: string; pattern: RegExp }> = [
  { name: "hive", pattern: /\b(hive\b|~\/github\/hive|github\.com\/[\w-]+\/hive\b)/i },
  { name: "beekeeper", pattern: /\b(beekeeper\b|~\/github\/beekeeper|github\.com\/[\w-]+\/beekeeper\b)/i },
];

/**
 * Resolve the target repo from a ticket. Order of checks:
 *   1. `repo:<name>` label (Phase 1: TBD per spec; we accept it if present).
 *   2. config.repoPaths keys grepped against ticket description.
 *   3. Built-in DESCRIPTION_HINTS as a fallback for hive/beekeeper.
 * Returns null when ambiguous or unresolvable; caller marks `block:human`.
 */
export function resolveRepo(
  ticket: TicketState,
  config?: PipelineConfig,
): ResolvedRepo | null {
  // 1. repo:<name> label
  for (const label of ticket.labels) {
    if (label.startsWith("repo:")) {
      const name = label.slice("repo:".length);
      const path = lookupPath(name, config);
      if (path && existsSync(path)) return { name, path };
    }
  }

  // 2. config.repoPaths keys grepped in description
  if (config?.repoPaths) {
    const matches: ResolvedRepo[] = [];
    for (const [name, path] of Object.entries(config.repoPaths)) {
      const re = new RegExp(`\\b${escapeRegex(name)}\\b`, "i");
      if (re.test(ticket.description) && existsSync(path)) {
        matches.push({ name, path });
      }
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null; // ambiguous
  }

  // 3. Built-in fallback
  const matches: ResolvedRepo[] = [];
  for (const hint of DESCRIPTION_HINTS) {
    if (hint.pattern.test(ticket.description)) {
      const path = lookupPath(hint.name, config);
      if (path && existsSync(path)) matches.push({ name: hint.name, path });
    }
  }
  if (matches.length === 1) return matches[0];
  return null;
}

function lookupPath(name: string, config?: PipelineConfig): string | undefined {
  if (config?.repoPaths?.[name]) return config.repoPaths[name];
  return join(homedir(), "github", name);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
