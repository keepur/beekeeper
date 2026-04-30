import { describe, it, expect } from "vitest";
import { renderInstallBeeClaudeMd } from "./install-bee-claude-md.js";

describe("renderInstallBeeClaudeMd", () => {
  it("substitutes the version into the npm install line", () => {
    const md = renderInstallBeeClaudeMd({ hiveVersion: "0.3.2" });
    expect(md).toContain("npm i -g @keepur/hive@0.3.2");
    expect(md).toContain("hive-cache/0.3.2");
  });

  it("includes a job list pinning the install steps", () => {
    // The overlay's whole point is telling Claude what its job is. If a
    // future edit accidentally drops the job list, the install session
    // would lose its anchor.
    const md = renderInstallBeeClaudeMd({ hiveVersion: "1.0.0" });
    expect(md).toMatch(/Verify dependencies/);
    expect(md).toMatch(/Install the hive CLI/);
    expect(md).toMatch(/Run `hive init`/);
    expect(md).toMatch(/Slack/);
    expect(md).toMatch(/hive doctor/);
  });

  it("includes a posture section that warns against destructive actions", () => {
    // The operator's machine is unknown territory; we don't want Claude
    // running sudo or wiping configs without asking.
    const md = renderInstallBeeClaudeMd({ hiveVersion: "0.3.2" });
    expect(md).toMatch(/never sudo|sudo without|Confirm before|Conservative by default/);
  });

  it("points at the in-tree package/ as the source of truth", () => {
    // The whole purpose of extracting the tarball is to give Claude the
    // real engine code in scope. If a future edit removes the
    // ./package/ pointer, Claude loses its anchor for ground-truth
    // verification.
    const md = renderInstallBeeClaudeMd({ hiveVersion: "0.3.6" });
    expect(md).toMatch(/\.\/package\//);
    expect(md).toMatch(/ground truth|verify before|Verify before/i);
  });
});
