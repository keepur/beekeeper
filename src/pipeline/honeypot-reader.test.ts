import { describe, expect, it, vi, beforeEach } from "vitest";

const execFileSyncMock = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

beforeEach(() => {
  execFileSyncMock.mockReset();
});

describe("readBeekeeperSecret", () => {
  it("invokes `security find-generic-password` with the honeypot service + beekeeper-prefixed account", async () => {
    execFileSyncMock.mockReturnValue("lin_api_test\n");
    const { readBeekeeperSecret } = await import("./honeypot-reader.js");
    readBeekeeperSecret("LINEAR_API_KEY");
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = execFileSyncMock.mock.calls[0] as [
      string,
      string[],
      { encoding: string; stdio: unknown },
    ];
    expect(bin).toBe("security");
    expect(args).toEqual([
      "find-generic-password",
      "-s",
      "honeypot",
      "-a",
      "beekeeper/LINEAR_API_KEY",
      "-w",
    ]);
    expect(opts.encoding).toBe("utf-8");
    expect(opts.stdio).toEqual(["ignore", "pipe", "ignore"]);
  });

  it("returns undefined when execFileSync throws (key not found)", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("The specified item could not be found in the keychain.");
    });
    const { readBeekeeperSecret } = await import("./honeypot-reader.js");
    expect(readBeekeeperSecret("MISSING_KEY")).toBeUndefined();
  });

  it("returns the trimmed value when execFileSync resolves with a trailing newline", async () => {
    execFileSyncMock.mockReturnValue("lin_api_test\n");
    const { readBeekeeperSecret } = await import("./honeypot-reader.js");
    expect(readBeekeeperSecret("LINEAR_API_KEY")).toBe("lin_api_test");
  });
});

describe("resolveBeekeeperSecret", () => {
  it("returns the env value when env is set (no Honeypot lookup)", async () => {
    const prev = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "from_env";
    try {
      const { resolveBeekeeperSecret } = await import("./honeypot-reader.js");
      expect(resolveBeekeeperSecret("LINEAR_API_KEY")).toBe("from_env");
      expect(execFileSyncMock).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = prev;
    }
  });

  it("falls through to Honeypot when env var is unset", async () => {
    const prev = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    execFileSyncMock.mockReturnValue("from_honeypot\n");
    try {
      const { resolveBeekeeperSecret } = await import("./honeypot-reader.js");
      expect(resolveBeekeeperSecret("LINEAR_API_KEY")).toBe("from_honeypot");
      expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    } finally {
      if (prev !== undefined) process.env.LINEAR_API_KEY = prev;
    }
  });
});
