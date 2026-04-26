export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

export class MissingAnchorError extends FrameError {
  constructor(
    public readonly frame: string,
    public readonly asset: string,
    public readonly anchor: string,
    public readonly target: string,
  ) {
    super(
      `Frame "${frame}" references anchor "${anchor}" in ${asset}, but it was not found in ${target}.`,
    );
    this.name = "MissingAnchorError";
  }
}

export class DependencyError extends FrameError {
  constructor(
    public readonly target: string,
    public readonly dependents: string[],
  ) {
    super(
      `Cannot remove frame "${target}" because the following applied frame(s) depend on it: ${dependents.join(", ")}. Remove them first or pass --force.`,
    );
    this.name = "DependencyError";
  }
}

export class PartialApplyError extends FrameError {
  constructor(
    public readonly written: string[],
    public readonly unreversed: string[],
  ) {
    super(
      `Apply failed mid-stream. Reverse-best-effort completed for: [${written.join(", ")}]. Could not reverse: [${unreversed.join(", ")}]. Manual cleanup may be required.`,
    );
    this.name = "PartialApplyError";
  }
}

export class InstanceNotFoundError extends FrameError {
  constructor(public readonly instanceId: string) {
    super(
      `Instance "${instanceId}" not found in beekeeper.yaml. Add it under the 'instances:' section.`,
    );
    this.name = "InstanceNotFoundError";
  }
}
