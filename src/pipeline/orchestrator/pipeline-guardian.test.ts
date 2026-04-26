import { describe, it, expect, vi } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { PipelineGuardian } from "./pipeline-guardian.js";

const allowlist = PipelineGuardian.compile([
  "^gh (issue|pr|repo|api|workflow|auth status|run) ",
  "^git (status|diff|log|show|add|commit|push|fetch|pull|rebase|merge|checkout|switch|branch|worktree|stash|tag|remote|reset --soft|cherry-pick) ",
  "^npm (run|install|ci|test|version|pack) ",
  "^npx (tsc|vitest|eslint|prettier|tsx|@anthropic-ai) ",
  "^node ",
  "^cat ",
  "^ls ",
  "^pwd",
  "^which ",
  "^find ",
  "^mkdir ",
  "^cp ",
  "^mv ",
  "^chmod ",
  "^security find-generic-password ",
  "^mongosh ",
  "^mongo ",
]);

function makeInput(command: string) {
  return {
    hook_event_name: "PreToolUse" as const,
    tool_name: "Bash" as const,
    tool_input: { command },
    tool_use_id: "tu_1",
  } as never;
}

async function decide(g: PipelineGuardian, command: string) {
  const cb = g.createHookCallback("agent-x");
  return cb(makeInput(command), undefined, { signal: new AbortController().signal });
}

describe("PipelineGuardian", () => {
  const g = new PipelineGuardian({ allowlist });

  it("approves allowlisted gh command", async () => {
    const r = await decide(g, "gh pr create --title 'test'");
    expect(r.decision).toBe("approve");
  });

  it("approves allowlisted npm run", async () => {
    expect((await decide(g, "npm run build")).decision).toBe("approve");
  });

  it("denies non-allowlisted command", async () => {
    expect((await decide(g, "rm -rf /tmp/x")).decision).toBe("block");
  });

  it("denies pnpm (not in allowlist)", async () => {
    expect((await decide(g, "pnpm install")).decision).toBe("block");
  });

  it("denies command with shell pipe (npm run build | tee log)", async () => {
    const r = await decide(g, "npm run build | tee build.log");
    expect(r.decision).toBe("block");
    expect((r as { reason: string }).reason).toMatch(/shell redirection/);
  });

  it("denies command with stdout redirection (> file)", async () => {
    expect((await decide(g, "npm test > out.txt")).decision).toBe("block");
  });

  it("denies && chained allowlisted commands", async () => {
    expect((await decide(g, "git status && npm test")).decision).toBe("block");
  });

  it("denies chmod +s", async () => {
    expect((await decide(g, "chmod +s file")).decision).toBe("block");
  });

  it("denies chmod 4755 (setuid numeric)", async () => {
    expect((await decide(g, "chmod 4755 file")).decision).toBe("block");
  });

  it("denies chmod g+s", async () => {
    expect((await decide(g, "chmod g+s file")).decision).toBe("block");
  });

  it("approves chmod 0755", async () => {
    expect((await decide(g, "chmod 0755 file")).decision).toBe("approve");
  });

  it("approves chmod 755", async () => {
    expect((await decide(g, "chmod 755 file")).decision).toBe("approve");
  });

  it("approves chmod u+x", async () => {
    expect((await decide(g, "chmod u+x file")).decision).toBe("approve");
  });

  it("denies empty bash command", async () => {
    expect((await decide(g, "")).decision).toBe("block");
  });

  it("approves non-Bash tools without hitting the allowlist", async () => {
    const cb = g.createHookCallback("a");
    const r = await cb(
      { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {}, tool_use_id: "x" } as never,
      undefined,
      { signal: new AbortController().signal },
    );
    expect(r.decision).toBe("approve");
  });

  it("compile() throws on invalid regex", () => {
    expect(() => PipelineGuardian.compile(["^gh ("])).toThrow(/not a valid regex/);
  });
});
