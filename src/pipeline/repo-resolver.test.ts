import { describe, expect, it } from "vitest";
import { resolveRepo } from "./repo-resolver.js";
import type { TicketState } from "./types.js";

function ticket(over: Partial<TicketState>): TicketState {
  return {
    id: "id",
    identifier: "KPR-1",
    title: "t",
    description: "",
    state: "Backlog",
    labels: [],
    blockedBy: [],
    comments: [],
    attachments: [],
    ...over,
  };
}

// NOTE: paths here must exist on the test runner. We use the actual checkout
// dirs since they're known to exist on the dev machine. CI will need either
// fake fixtures or skipping; deferring fixture-based tests to Phase 2.
describe("resolveRepo", () => {
  const config = {
    linearTeamKey: "KPR",
    repoPaths: {
      hive: "/Users/mokie/github/hive",
      beekeeper: "/Users/mokie/github/beekeeper",
    },
  };

  it("returns null when description has no repo hints", () => {
    expect(resolveRepo(ticket({ description: "fix the thing" }), config)).toBeNull();
  });

  it("matches single repo by config key", () => {
    const r = resolveRepo(ticket({ description: "Update beekeeper config." }), config);
    expect(r?.name).toBe("beekeeper");
  });

  it("returns null when description matches multiple", () => {
    const r = resolveRepo(
      ticket({ description: "Cross-repo touching hive and beekeeper." }),
      config,
    );
    expect(r).toBeNull();
  });
});
