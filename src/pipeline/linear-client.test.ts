import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const createCommentMock = vi.fn();
vi.mock("@linear/sdk", () => ({
  LinearClient: class {
    createComment = createCommentMock;
  },
}));

import { LinearClient } from "./linear-client.js";

describe("LinearClient.addComment retry", () => {
  beforeEach(() => createCommentMock.mockReset());

  it("returns first-attempt result without retrying on success", async () => {
    createCommentMock.mockResolvedValueOnce({
      success: true,
      comment: Promise.resolve({ id: "c1", createdAt: new Date("2026-04-26T00:00:00Z") }),
    });
    const c = new LinearClient({ apiKey: "k", teamKey: "KPR" });
    const r = await c.addComment("issue-1", "hello");
    expect(r.id).toBe("c1");
    expect(createCommentMock).toHaveBeenCalledTimes(1);
  });

  it("retries once after a transient failure and returns the second result", async () => {
    createCommentMock
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockResolvedValueOnce({
        success: true,
        comment: Promise.resolve({ id: "c2", createdAt: new Date("2026-04-26T00:00:00Z") }),
      });
    const c = new LinearClient({ apiKey: "k", teamKey: "KPR" });
    const r = await c.addComment("issue-1", "hello");
    expect(r.id).toBe("c2");
    expect(createCommentMock).toHaveBeenCalledTimes(2);
  });

  it("propagates the error when the second attempt also fails", async () => {
    createCommentMock
      .mockRejectedValueOnce(new Error("ETIMEDOUT"))
      .mockRejectedValueOnce(new Error("ETIMEDOUT"));
    const c = new LinearClient({ apiKey: "k", teamKey: "KPR" });
    await expect(c.addComment("issue-1", "hello")).rejects.toThrow("ETIMEDOUT");
    expect(createCommentMock).toHaveBeenCalledTimes(2);
  });
});
