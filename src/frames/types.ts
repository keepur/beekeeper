/**
 * Frame manifest — the parsed, validated form of a frame.yaml.
 * Mirrors the schema in /tmp/2026-04-25-frames-design.md "Manifest schema".
 */
export interface FrameManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  targets?: { hiveVersion?: string };
  requires?: string[];
  conflicts?: string[];

  constitution?: ConstitutionAsset[];
  skills?: SkillAsset[];
  coreservers?: CoreServerAsset[];
  schedule?: ScheduleAsset[];
  memorySeeds?: MemorySeedAsset[];
  prompts?: PromptAsset[];
  hooks?: { preApply?: string; postApply?: string };

  /** Absolute path to the frame's root directory on disk. Populated by the loader. */
  rootPath: string;
}

export type ConstitutionInsertMode =
  | "after-anchor"
  | "before-anchor"
  | "append-to-anchor"
  | "replace-anchor";

export interface ConstitutionAsset {
  anchor: string;
  title?: string;
  insert: ConstitutionInsertMode;
  /** When mode is *-anchor (other than replace), the target anchor whose neighborhood we modify. */
  targetAnchor?: string;
  /** Path to the markdown fragment, relative to the frame's rootPath. */
  file: string;
}

export interface SkillAsset {
  /** Path to the skill bundle directory, relative to the frame's rootPath. */
  bundle: string;
}

export interface CoreServerAsset {
  /** MCP server names to add. */
  add: string[];
  /** Agent IDs or `["*"]` for all agents. */
  agents: string[];
}

export type SchedulePattern = "stagger" | "shared";

export interface ScheduleAsset {
  task: string;
  agents: string[];
  /** Either an explicit cron string or a named pattern with parameters. */
  cron?: string;
  pattern?: SchedulePattern;
  /** Required for stagger pattern. Free-text window descriptor (e.g., "fri 14:00-17:00 PT"). */
  window?: string;
  /** Required for stagger pattern. Slot duration descriptor (e.g., "15m"). */
  interval?: string;
}

export interface MemorySeedAsset {
  agent: string;
  tier: "hot" | "warm" | "cold";
  /** Path relative to the frame's rootPath. */
  file: string;
  dedupeBy?: "content-hash";
}

export interface PromptAsset {
  anchor: string;
  agents: string[];
  /** Path relative to the frame's rootPath. */
  file: string;
}

/** Record stored in the `applied_frames` collection (per Hive instance). */
export interface AppliedFrameRecord {
  _id: string;
  version: string;
  appliedAt: Date;
  appliedBy: string;
  /** Snapshot of the manifest at apply time. */
  manifest: FrameManifest;
  resources: AppliedResources;
  driftAccepted?: DriftDecision[];
}

export interface AppliedResources {
  constitution?: {
    anchors: string[];
    snapshotBefore: string;
    insertedText: Record<string, string>;
  };
  skills?: Array<{ bundle: string; sha256: string }>;
  coreservers?: Record<string, string[]>;
  schedule?: Record<string, Array<{ task: string; cron: string }>>;
  memorySeeds?: Array<{ id: string; contentHash: string }>;
  prompts?: Record<
    string,
    { anchors: string[]; snapshotBefore: string; insertedText: Record<string, string> }
  >;
}

export interface DriftDecision {
  resource: string;
  decision: "keep-local" | "take-frame" | "merged" | "deferred";
  decidedAt: Date;
  decidedBy: string;
  reason?: string;
}
