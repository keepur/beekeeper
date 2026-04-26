import type { ActionDecision, TicketState } from "./types.js";
import { getBlockLabels, getTypeLabel, hasLabel } from "./labels.js";

/**
 * Pure decision function — given a ticket state, return the next action.
 *
 * Implements the action table from `docs/specs/2026-04-26-pipeline-tick-design.md`.
 * Block labels short-circuit: a `block:human` or `block:external` ticket is
 * `report-only`. `block:ci` is checked by the handler (it polls CI status), so
 * here we just emit `report-only` and let the handler/dispatcher upstream
 * re-decide after it clears.
 */
export function decideAction(state: TicketState): ActionDecision {
  const blocks = getBlockLabels(state.labels);
  if (blocks.includes("block:human")) {
    return {
      kind: "report-only",
      reason: "block:human — operator action required",
      spawns: false,
    };
  }
  if (blocks.includes("block:external")) {
    return {
      kind: "report-only",
      reason: "block:external — vendor/legal/decider action required",
      spawns: false,
    };
  }
  if (blocks.includes("block:ci")) {
    return {
      kind: "report-only",
      reason: "block:ci — auto-clears when CI flips green",
      spawns: false,
    };
  }

  const isAuto = hasLabel(state.labels, "pipeline-auto");
  const blocked = state.blockedBy.length > 0;
  const type = getTypeLabel(state.labels);

  switch (state.state) {
    case "Backlog":
      if (!isAuto) return skip("not pipeline-auto");
      if (blocked) return skip("blockedBy issue dependency");
      if (!type) return skip("missing type:* label");
      if (type === "type:trivial") {
        return {
          kind: "advance",
          reason: "trivial → Ready (no spec, no plan)",
          spawns: false,
          payload: { nextState: "Ready" },
        };
      }
      if (type === "type:plan-only") {
        return {
          kind: "draft-plan",
          reason: "plan-only → spawn plan-drafting subagent",
          spawns: true,
          payload: { nextState: "Plan Drafting" },
        };
      }
      if (type === "type:spec-and-plan") {
        return {
          kind: "draft-spec",
          reason: "spec-and-plan → spawn spec-drafting subagent",
          spawns: true,
          payload: { nextState: "Spec Drafting" },
        };
      }
      // type:research
      return {
        kind: "draft-spec", // research output is a spec-shaped findings doc
        reason: "research → spawn research subagent",
        spawns: true,
        payload: { nextState: "In Progress", research: true },
      };

    case "Spec Drafting":
      // Handler reads the latest tick-spawn-log to know if a draft is in flight.
      // If draft completed and review-clean → advance. If issues → spec-review loop.
      // The dispatcher returns the kind; the handler interrogates the comment trail.
      return {
        kind: "spec-review",
        reason: "in spec drafting — let handler interrogate latest draft + review state",
        spawns: false, // handler may launch a reviewer; that's a separate budget consumption
      };

    case "Plan Drafting":
      return {
        kind: "plan-review",
        reason: "in plan drafting — let handler interrogate latest draft + review state",
        spawns: false,
      };

    case "Ready":
      if (blocked) return skip("blockedBy issue dependency");
      return {
        kind: "pickup",
        reason: "ready → spawn implementer subagent",
        spawns: true,
        payload: { nextState: "In Progress" },
      };

    case "In Progress":
      // Implementer may have opened a PR (attachment) or failed (no PR + spawn-log shows error).
      // Handler interrogates; dispatcher returns the kind.
      return {
        kind: "code-review",
        reason: "in progress — handler reads PR/error state",
        spawns: false,
      };

    case "In Review":
      return {
        kind: "code-review",
        reason: "in review — handler reads CI + reviewer output",
        spawns: false,
      };

    case "Done":
      return skip("done");
    case "Canceled":
      return skip("canceled");
    case "Todo":
      return skip("legacy non-pipeline state");
    default: {
      const exhaustive: never = state.state;
      return skip(`unknown state: ${String(exhaustive)}`);
    }
  }
}

function skip(reason: string): ActionDecision {
  return { kind: "skip", reason, spawns: false };
}
