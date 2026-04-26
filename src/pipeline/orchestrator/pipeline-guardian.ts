import type { HookInput, HookJSONOutput, HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../../logging/logger.js";

const log = createLogger("pipeline-guardian");

/**
 * Strip trailing shell-redirection / chaining segments from a command string.
 * Returns the stripped command. If `stripped !== input`, the command contains
 * shell composition; the guardian rejects any such command early as a hard
 * rule (plan-stage decision: option (a) — disallow piping/redirection).
 */
function stripRedirection(cmd: string): string {
  // Order matters: longer operators first to avoid `>` swallowing `>>` etc.
  // We strip from the FIRST occurrence of any operator to end-of-string.
  const operators = [" 2>&1", " 2>", " >>", " >", " <", " | ", " || ", " && ", " ; ", " & "];
  let earliest = cmd.length;
  for (const op of operators) {
    const idx = cmd.indexOf(op);
    if (idx !== -1 && idx < earliest) earliest = idx;
  }
  return cmd.slice(0, earliest);
}

/**
 * Validate `chmod` mode arg. Rejects setuid/setgid/sticky-bit modes.
 * Accepts: numeric `0755`, `755` (3-4 digits, leading digit 0 or 1);
 *          symbolic `u+x`, `go-r`, `a=rw` (mode letters from [rwxX] only).
 * Rejects: `+s`, `g+s`, `=t`, `4755`, `2755`, `6755`, anything else.
 */
function chmodModeAllowed(mode: string | undefined): boolean {
  if (!mode) return false;
  // Numeric: 3 or 4 octal digits; if 4 digits, leading must be 0 or 1.
  if (/^[0-7]{3,4}$/.test(mode)) {
    if (mode.length === 4 && !/^[01]/.test(mode)) return false;
    return true;
  }
  // Symbolic: who-set [+-=] mode-letters; mode-letters limited to rwxX.
  if (/^[ugoa]*[+\-=][rwxX]+$/.test(mode)) return true;
  return false;
}

export interface PipelineGuardianOptions {
  /** Compiled regexes — caller compiles from config strings (so config-validation surfaces bad regexes early). */
  allowlist: RegExp[];
}

export class PipelineGuardian {
  private allowlist: RegExp[];

  constructor(opts: PipelineGuardianOptions) {
    this.allowlist = opts.allowlist;
  }

  /** Compile a list of regex strings; throws on the first invalid pattern. */
  static compile(patterns: string[]): RegExp[] {
    return patterns.map((p, i) => {
      try {
        return new RegExp(p);
      } catch (err) {
        throw new Error(`pipeline.orchestrator.bashAllowlist[${i}] is not a valid regex: ${p} (${String(err)})`);
      }
    });
  }

  createHookCallback(agentId: string): HookCallback {
    return async (
      input: HookInput,
      _toolUseId: string | undefined,
      _options: { signal: AbortSignal },
    ): Promise<HookJSONOutput> => {
      if (input.hook_event_name !== "PreToolUse") return { decision: "approve" };
      if (input.tool_name !== "Bash") return { decision: "approve" };
      const command = ((input.tool_input as { command?: string })?.command ?? "").trim();
      if (!command) {
        log.warn("Empty bash command rejected", { agentId });
        return { decision: "block", reason: "empty bash command" };
      }
      const stripped = stripRedirection(command);
      if (stripped !== command) {
        log.warn("Bash rejected: shell-redirection not allowed", { agentId, redacted: redactCommand(command) });
        return {
          decision: "block",
          reason: "shell redirection / piping / chaining is denied for pipeline subagents (plan-stage rule v1)",
        };
      }
      // chmod-specific mode-arg whitelist (denies +s / 4xxx / 2xxx).
      if (/^chmod\s/.test(stripped)) {
        const parts = stripped.split(/\s+/);
        const modeArg = parts[1];
        if (!chmodModeAllowed(modeArg)) {
          log.warn("Bash rejected: chmod mode not allowed", { agentId, redacted: redactCommand(command) });
          return { decision: "block", reason: `chmod mode not allowed: ${modeArg ?? "(missing)"}` };
        }
      }
      const allowed = this.allowlist.some((re) => re.test(stripped));
      if (!allowed) {
        log.warn("Bash rejected: not in allowlist", { agentId, redacted: redactCommand(command) });
        return { decision: "block", reason: "command not in pipeline-subagent bash allowlist" };
      }
      return { decision: "approve" };
    };
  }
}

/**
 * Redact a command for logging — keep the first token (binary name) and a
 * truncated tail. Avoids leaking arg values that may contain credentials
 * (e.g., `gh api -H "Authorization: Bearer $TOKEN"`).
 */
function redactCommand(cmd: string): string {
  const firstSpace = cmd.indexOf(" ");
  if (firstSpace === -1) return cmd.slice(0, 32);
  const head = cmd.slice(0, firstSpace);
  const tailLen = Math.min(48, cmd.length - firstSpace - 1);
  return `${head} <${tailLen} chars redacted>`;
}
