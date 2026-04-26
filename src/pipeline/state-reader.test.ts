import { describe, expect, it, vi } from "vitest";
import { readTicketState } from "./state-reader.js";
import type { LinearClient } from "./linear-client.js";
import type { TicketState } from "./types.js";

describe("readTicketState", () => {
  it("delegates to LinearClient.getTicketState", async () => {
    const sample: TicketState = {
      id: "id-1",
      identifier: "KPR-1",
      title: "test",
      description: "",
      state: "Backlog",
      labels: ["pipeline-auto"],
      blockedBy: [],
      comments: [],
      attachments: [],
    };
    const client = { getTicketState: vi.fn().mockResolvedValue(sample) } as unknown as LinearClient;
    const result = await readTicketState(client, "KPR-1");
    expect(result).toEqual(sample);
    expect(client.getTicketState).toHaveBeenCalledWith("KPR-1");
  });
});
