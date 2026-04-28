import { describe, it, expect } from "vitest";
import type { Db } from "mongodb";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectInstanceState } from "./detect-instance-state.js";

interface FakeRow {
  [k: string]: unknown;
}

interface MockData {
  /** memory collection: keyed by `path` field. */
  memory?: Record<string, FakeRow>;
  /** applied_frames collection: keyed by `_id`. */
  appliedFrames?: Record<string, FakeRow>;
  /** agent_definitions: keyed by `_id`. */
  agentDefs?: Record<string, FakeRow>;
  /** agent_memory: matched by `agentId` AND `metadata.seededBy`. */
  agentMemory?: FakeRow[];
}

function makeMockDb(data: MockData): Db {
  const memColl = {
    findOne: async (q: { path?: string }) => {
      if (!q.path) return null;
      return data.memory?.[q.path] ?? null;
    },
  };
  const framesColl = {
    findOne: async (q: { _id?: string }) => {
      if (!q._id) return null;
      return data.appliedFrames?.[q._id] ?? null;
    },
  };
  const agentDefsColl = {
    findOne: async (q: { _id?: string }) => {
      if (!q._id) return null;
      return data.agentDefs?.[q._id] ?? null;
    },
  };
  const agentMemColl = {
    findOne: async (q: Record<string, unknown>) => {
      const wantAgent = q.agentId as string | undefined;
      const wantSeededBy = q["metadata.seededBy"] as string | undefined;
      const rows = data.agentMemory ?? [];
      for (const row of rows) {
        if (wantAgent && row.agentId !== wantAgent) continue;
        if (wantSeededBy) {
          const meta = (row as { metadata?: { seededBy?: string } }).metadata;
          if (meta?.seededBy !== wantSeededBy) continue;
        }
        return row;
      }
      return null;
    },
  };

  const collection = (name: string): unknown => {
    if (name === "memory") return memColl;
    if (name === "applied_frames") return framesColl;
    if (name === "agent_definitions") return agentDefsColl;
    if (name === "agent_memory") return agentMemColl;
    return {
      findOne: async () => null,
      find: () => ({ toArray: async () => [] }),
    };
  };
  return { collection } as unknown as Db;
}

const FRESH_INPUT = (servicePath: string) => ({
  instanceId: "init-state-test",
  servicePath,
});

const POPULATED_SECTION_2 = [
  "# Constitution",
  "## Section 1",
  "platform stuff",
  "## Section 2",
  "<!-- section-2:start -->",
  "operator-authored content lives here",
  "<!-- section-2:end -->",
].join("\n");

const EMPTY_SECTION_2 = [
  "# Constitution",
  "<!-- section-2:start -->",
  "<!-- section-2:end -->",
].join("\n");

const LONG_PROMPT = "a".repeat(400); // > 280 threshold
const SHORT_PROMPT = "frame template baseline only"; // ~30 chars

/**
 * Verbatim copy of the engine-shipped default CoS `systemPrompt` from
 * the hive repo `seeds/chief-of-staff/agent.yaml` (the YAML `|` block
 * scalar at the `systemPrompt:` field). Length: 230 chars.
 *
 * This fixture locks `COS_PROMPT_NONDEFAULT_THRESHOLD` to real content —
 * if the engine default grows past the threshold, the
 * "engine-shipped default verbatim" test below will fail and force us
 * to re-derive the constant rather than silently regress to a false
 * positive that masks a `partial` instance as `completed`.
 */
const ENGINE_DEFAULT_COS_PROMPT = `You are the Chief of Staff agent. Your role:
- Coordinate across agents when needed
- Handle administrative tasks
- Advise the owner on agent team management
- Troubleshoot agent issues

Always be direct, concise, and actionable.
`;

const ULID_STR = "01HW0000000000000000000001";

describe("detectInstanceState", () => {
  let tmpRoot: string;

  function mkServicePath(label: string, withFallback = false): string {
    tmpRoot = mkdtempSync(join(tmpdir(), `init-state-${label}-`));
    const sp = join(tmpRoot, "service");
    mkdirSync(sp, { recursive: true });
    if (withFallback) {
      mkdirSync(join(sp, "shared"), { recursive: true });
      writeFileSync(join(sp, "shared", "business-context.md"), "stub\n");
    }
    return sp;
  }

  function cleanup(): void {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  }

  it("returns fresh on a brand-new instance with no artifacts", async () => {
    const sp = mkServicePath("fresh");
    try {
      const db = makeMockDb({});
      const result = await detectInstanceState(db, FRESH_INPUT(sp));
      expect(result.state).toBe("fresh");
      expect(result.detail.section2Written).toBe(false);
      expect(result.detail.frameApplied).toBe(false);
      expect(result.detail.cosSeeded).toBe(false);
      expect(result.detail.handoffMemoryWritten).toBe(false);
      expect(result.detail.lastInitRunId).toBeNull();
      expect(result.detail.lastInitAppliedAt).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("returns completed when all four artifacts are present", async () => {
    const sp = mkServicePath("completed");
    try {
      const seededAt = new Date("2026-04-27T15:00:00Z");
      const db = makeMockDb({
        memory: {
          "shared/constitution.md": {
            path: "shared/constitution.md",
            content: POPULATED_SECTION_2,
          },
        },
        appliedFrames: {
          "hive-baseline": {
            _id: "hive-baseline",
            appliedAt: seededAt,
            appliedBy: `beekeeper-init-instance:${ULID_STR}`,
          },
        },
        agentDefs: {
          "chief-of-staff": {
            _id: "chief-of-staff",
            systemPrompt: LONG_PROMPT,
          },
        },
        agentMemory: [
          {
            _id: "01HW1",
            agentId: "chief-of-staff",
            metadata: {
              seededBy: "beekeeper-init-instance",
              seedRunId: ULID_STR,
              seededAt,
            },
          },
        ],
      });

      const result = await detectInstanceState(db, FRESH_INPUT(sp));
      expect(result.state).toBe("completed");
      expect(result.detail.section2Written).toBe(true);
      expect(result.detail.frameApplied).toBe(true);
      expect(result.detail.cosSeeded).toBe(true);
      expect(result.detail.handoffMemoryWritten).toBe(true);
      expect(result.detail.lastInitRunId).toBe(ULID_STR);
      expect(result.detail.lastInitAppliedAt).toEqual(seededAt);
    } finally {
      cleanup();
    }
  });

  it("returns partial when only section 2 is written", async () => {
    const sp = mkServicePath("partial-s2");
    try {
      const db = makeMockDb({
        memory: {
          "shared/constitution.md": {
            path: "shared/constitution.md",
            content: POPULATED_SECTION_2,
          },
        },
      });
      const result = await detectInstanceState(db, FRESH_INPUT(sp));
      expect(result.state).toBe("partial");
      expect(result.detail.section2Written).toBe(true);
      expect(result.detail.frameApplied).toBe(false);
      expect(result.detail.cosSeeded).toBe(false);
      expect(result.detail.handoffMemoryWritten).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("returns partial when phase 4 stopped after step 4c (4a-4c done, 4d-4f missing)", async () => {
    const sp = mkServicePath("partial-mid");
    try {
      const db = makeMockDb({
        memory: {
          "shared/constitution.md": {
            path: "shared/constitution.md",
            content: POPULATED_SECTION_2,
          },
        },
        appliedFrames: {
          "hive-baseline": {
            _id: "hive-baseline",
            appliedAt: new Date(),
            appliedBy: `beekeeper-init-instance:${ULID_STR}`,
          },
        },
      });
      const result = await detectInstanceState(db, FRESH_INPUT(sp));
      expect(result.state).toBe("partial");
      expect(result.detail.section2Written).toBe(true);
      expect(result.detail.frameApplied).toBe(true);
      expect(result.detail.cosSeeded).toBe(false);
      expect(result.detail.handoffMemoryWritten).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("returns cosSeeded=false when CoS prompt is well below frame-template baseline length", async () => {
    const sp = mkServicePath("partial-cos-default");
    try {
      const db = makeMockDb({
        agentDefs: {
          "chief-of-staff": {
            _id: "chief-of-staff",
            systemPrompt: SHORT_PROMPT,
          },
        },
      });
      const result = await detectInstanceState(db, FRESH_INPUT(sp));
      expect(result.state).toBe("fresh");
      expect(result.detail.cosSeeded).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("returns cosSeeded=false when CoS prompt is the engine-shipped default verbatim", async () => {
    // This is the realistic boundary case: the hive setup wizard inserts
    // `seeds/chief-of-staff/agent.yaml` verbatim into `agent_definitions`
    // on a fresh install, so a freshly-seeded but un-tuned instance has
    // exactly this prompt (230 chars). The threshold MUST classify this
    // as default, not operator-tuned, or `detectInstanceState` returns a
    // false-positive `completed` for an instance that's actually
    // `partial`.
    const sp = mkServicePath("partial-cos-engine-default");
    try {
      const db = makeMockDb({
        agentDefs: {
          "chief-of-staff": {
            _id: "chief-of-staff",
            systemPrompt: ENGINE_DEFAULT_COS_PROMPT,
          },
        },
      });
      const result = await detectInstanceState(db, FRESH_INPUT(sp));
      expect(result.state).toBe("fresh");
      expect(result.detail.cosSeeded).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("returns section2Written=false when the anchor pair exists but is empty", async () => {
    const sp = mkServicePath("partial-empty-s2");
    try {
      const db = makeMockDb({
        memory: {
          "shared/constitution.md": {
            path: "shared/constitution.md",
            content: EMPTY_SECTION_2,
          },
        },
      });
      const result = await detectInstanceState(db, FRESH_INPUT(sp));
      expect(result.detail.section2Written).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("falls back to filesystem business-context.md when the constitution doc is absent", async () => {
    const sp = mkServicePath("partial-fs-fallback", true);
    try {
      const db = makeMockDb({});
      const result = await detectInstanceState(db, FRESH_INPUT(sp));
      expect(result.detail.section2Written).toBe(true);
      // Fallback alone is still partial overall.
      expect(result.state).toBe("partial");
    } finally {
      cleanup();
    }
  });

  it("reads lastInitRunId from the handoff memory record verbatim when present", async () => {
    const sp = mkServicePath("lastrun-handoff");
    try {
      const seededAt = new Date("2026-04-27T18:30:00Z");
      const handoffRunId = "01HW9999999999999999999999";
      const db = makeMockDb({
        appliedFrames: {
          "hive-baseline": {
            _id: "hive-baseline",
            appliedAt: new Date("2026-04-27T18:00:00Z"),
            appliedBy: `beekeeper-init-instance:${ULID_STR}`,
          },
        },
        agentMemory: [
          {
            _id: "01HW1",
            agentId: "chief-of-staff",
            metadata: {
              seededBy: "beekeeper-init-instance",
              seedRunId: handoffRunId,
              seededAt,
            },
          },
        ],
      });
      const result = await detectInstanceState(db, FRESH_INPUT(sp));
      // Handoff record's seedRunId wins over the frame appliedBy ULID.
      expect(result.detail.lastInitRunId).toBe(handoffRunId);
      expect(result.detail.lastInitAppliedAt).toEqual(seededAt);
    } finally {
      cleanup();
    }
  });

  it("falls back to parsing appliedBy when the handoff record is missing", async () => {
    const sp = mkServicePath("lastrun-frame-fallback");
    try {
      const appliedAt = new Date("2026-04-27T19:00:00Z");
      const db = makeMockDb({
        appliedFrames: {
          "hive-baseline": {
            _id: "hive-baseline",
            appliedAt,
            appliedBy: `beekeeper-init-instance:${ULID_STR}`,
          },
        },
      });
      const result = await detectInstanceState(db, FRESH_INPUT(sp));
      expect(result.detail.lastInitRunId).toBe(ULID_STR);
      expect(result.detail.lastInitAppliedAt).toEqual(appliedAt);
    } finally {
      cleanup();
    }
  });

  it("returns null lastInitRunId when neither artifact carries a parseable id", async () => {
    const sp = mkServicePath("lastrun-none");
    try {
      const db = makeMockDb({
        appliedFrames: {
          "hive-baseline": {
            _id: "hive-baseline",
            appliedAt: new Date(),
            appliedBy: "non-init-source",
          },
        },
      });
      const result = await detectInstanceState(db, FRESH_INPUT(sp));
      expect(result.detail.lastInitRunId).toBeNull();
    } finally {
      cleanup();
    }
  });

  it("respects an operator-overridden cosAgentId", async () => {
    const sp = mkServicePath("custom-cos-id");
    try {
      const db = makeMockDb({
        agentDefs: {
          mokie: { _id: "mokie", systemPrompt: LONG_PROMPT },
        },
        agentMemory: [
          {
            _id: "01HW1",
            agentId: "mokie",
            metadata: { seededBy: "beekeeper-init-instance" },
          },
        ],
      });
      const result = await detectInstanceState(db, {
        ...FRESH_INPUT(sp),
        cosAgentId: "mokie",
      });
      expect(result.detail.cosSeeded).toBe(true);
      expect(result.detail.handoffMemoryWritten).toBe(true);
    } finally {
      cleanup();
    }
  });
});
