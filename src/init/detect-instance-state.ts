import type { Db } from "mongodb";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logging/logger.js";

const log = createLogger("init-instance-state");

export type InstanceStateName = "fresh" | "partial" | "completed";

export interface InstanceStateDetail {
  /**
   * True iff `memory[shared/constitution.md]` carries a populated
   * `<!-- section-2:start -->...<!-- section-2:end -->` anchor pair, OR the
   * filesystem fallback `<servicePath>/shared/business-context.md` exists.
   */
  section2Written: boolean;
  /** True iff `applied_frames` has a `hive-baseline` record. */
  frameApplied: boolean;
  /**
   * True iff `agent_definitions` has the CoS agent with a non-default
   * `systemPrompt`. Heuristic: prompt length > 200 chars (frame template
   * baseline is ~120). The 200 magic number is documented in `instance-state`
   * spec; replace with a frame-manifest constant once KPR-86 exposes one.
   */
  cosSeeded: boolean;
  /**
   * True iff `agent_memory` has a record on the CoS agent with
   * `metadata.seededBy: "beekeeper-init-instance"`.
   */
  handoffMemoryWritten: boolean;
  /** ULID parsed from the most recent init artifact (best-effort). */
  lastInitRunId: string | null;
  /** Timestamp of the most recent init artifact (best-effort). */
  lastInitAppliedAt: Date | null;
}

export interface InstanceState {
  state: InstanceStateName;
  detail: InstanceStateDetail;
}

export interface DetectInstanceStateInput {
  /** The instance slug, e.g. "dodi". Used only for log context. */
  instanceId: string;
  /** Resolved service path, e.g. ~/services/hive/<instanceId>/. */
  servicePath: string;
  /**
   * Default CoS slug; per spec open-design item 3, default is
   * `chief-of-staff` but operator may rename during interview. Detection
   * accepts either the default OR the operator's chosen slug if provided
   * by the caller (Phase 0 invokes after Phase 1 may pass an override).
   */
  cosAgentId?: string;
}

const SECTION_2_BUSINESS_CONTEXT_FALLBACK = "shared/business-context.md";
const APPLIED_FRAMES_COLLECTION = "applied_frames";
const HIVE_BASELINE_FRAME_ID = "hive-baseline";
const AGENT_DEFINITIONS_COLLECTION = "agent_definitions";
const AGENT_MEMORY_COLLECTION = "agent_memory";
const CONSTITUTION_MEMORY_COLLECTION = "memory";
const CONSTITUTION_PATH = "shared/constitution.md";
const SECTION_2_ANCHOR_NAME = "section-2";

/** Minimum systemPrompt length to consider CoS "operator-tuned" rather than frame-template baseline. */
const COS_PROMPT_NONDEFAULT_THRESHOLD = 200;

interface AppliedFrameRow {
  _id: string;
  appliedAt?: Date;
  appliedBy?: string;
}

interface AgentDefRow {
  _id: string;
  systemPrompt?: string;
}

interface AgentMemoryRow {
  _id: string;
  agentId?: string;
  metadata?: {
    seededBy?: string;
    seedRunId?: string;
    seededAt?: Date;
  };
}

interface ConstitutionMemoryRow {
  _id: string;
  path?: string;
  content?: string;
}

/**
 * Detect whether an instance is fresh, partial, or completed with respect
 * to `init-instance` artifacts.
 *
 * Per spec section detectInstanceState shared primitive:
 *   - All four detail booleans `true`  → "completed"
 *   - All four `false`                  → "fresh"
 *   - Any other combination             → "partial"
 *
 * Best-effort `lastInitRunId` / `lastInitAppliedAt`: read from the handoff
 * memory record's `metadata.seedRunId` (verbatim) OR fall back to parsing
 * the embedded ULID from the `applied_frames` record's `appliedBy`. Null
 * if not resolvable; Phase 0 prose to operator just omits the timestamp.
 *
 * Both Phase 0 (idempotency check) and Phase 4 (mid-run resume detection)
 * MUST consume this single function so the two cannot disagree about what
 * "initialized" means.
 */
export async function detectInstanceState(
  db: Db,
  input: DetectInstanceStateInput,
): Promise<InstanceState> {
  const { instanceId, servicePath, cosAgentId = "chief-of-staff" } = input;

  const section2Written = await checkSection2Written(db, servicePath);
  const frameRecord = await db
    .collection<AppliedFrameRow>(APPLIED_FRAMES_COLLECTION)
    .findOne({ _id: HIVE_BASELINE_FRAME_ID });
  const frameApplied = frameRecord !== null;

  const cosSeeded = await checkCosSeeded(db, cosAgentId);

  const handoffRecord = await db
    .collection<AgentMemoryRow>(AGENT_MEMORY_COLLECTION)
    .findOne({
      agentId: cosAgentId,
      "metadata.seededBy": "beekeeper-init-instance",
    });
  const handoffMemoryWritten = handoffRecord !== null;

  const { lastInitRunId, lastInitAppliedAt } = extractLastInitMetadata(
    frameRecord,
    handoffRecord,
  );

  const detail: InstanceStateDetail = {
    section2Written,
    frameApplied,
    cosSeeded,
    handoffMemoryWritten,
    lastInitRunId,
    lastInitAppliedAt,
  };

  const allTrue =
    section2Written && frameApplied && cosSeeded && handoffMemoryWritten;
  const allFalse =
    !section2Written && !frameApplied && !cosSeeded && !handoffMemoryWritten;

  const state: InstanceStateName = allTrue
    ? "completed"
    : allFalse
      ? "fresh"
      : "partial";

  log.info("detectInstanceState", { instanceId, state, detail });
  return { state, detail };
}

async function checkSection2Written(
  db: Db,
  servicePath: string,
): Promise<boolean> {
  // Primary: the rendered constitution doc in the `memory` collection should
  // carry a populated section-2 anchor pair after Phase 4 step 4b.
  const constitutionDoc = await db
    .collection<ConstitutionMemoryRow>(CONSTITUTION_MEMORY_COLLECTION)
    .findOne({ path: CONSTITUTION_PATH });
  if (constitutionDoc !== null) {
    const content = constitutionDoc.content ?? "";
    const startTag = `<!-- ${SECTION_2_ANCHOR_NAME}:start -->`;
    const endTag = `<!-- ${SECTION_2_ANCHOR_NAME}:end -->`;
    const startIdx = content.indexOf(startTag);
    const endIdx = content.indexOf(endTag);
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      const inner = content.slice(startIdx + startTag.length, endIdx).trim();
      if (inner.length > 0) return true;
    }
  }
  // Fallback: legacy filesystem layout where Section 2 lives in
  // shared/business-context.md (pre-frame instances). Existence alone
  // counts; we don't introspect the file's content.
  return existsSync(join(servicePath, SECTION_2_BUSINESS_CONTEXT_FALLBACK));
}

async function checkCosSeeded(db: Db, cosAgentId: string): Promise<boolean> {
  const cosDoc = await db
    .collection<AgentDefRow>(AGENT_DEFINITIONS_COLLECTION)
    .findOne({ _id: cosAgentId });
  if (cosDoc === null) return false;
  const systemPrompt = cosDoc.systemPrompt ?? "";
  return systemPrompt.length > COS_PROMPT_NONDEFAULT_THRESHOLD;
}

const APPLIED_BY_INIT_RE = /^beekeeper-init-instance:([0-9A-HJKMNP-TV-Z]{26})$/;

function extractLastInitMetadata(
  frameRecord: AppliedFrameRow | null,
  handoffRecord: AgentMemoryRow | null,
): { lastInitRunId: string | null; lastInitAppliedAt: Date | null } {
  const seedRunId = handoffRecord?.metadata?.seedRunId ?? null;
  const seededAt = handoffRecord?.metadata?.seededAt ?? null;
  if (seedRunId !== null) {
    return { lastInitRunId: seedRunId, lastInitAppliedAt: seededAt };
  }
  const appliedBy = frameRecord?.appliedBy ?? "";
  const m = APPLIED_BY_INIT_RE.exec(appliedBy);
  return {
    lastInitRunId: m?.[1] ?? null,
    lastInitAppliedAt: frameRecord?.appliedAt ?? null,
  };
}
