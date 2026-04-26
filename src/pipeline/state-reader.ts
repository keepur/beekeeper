import type { LinearClient } from "./linear-client.js";
import type { TicketState } from "./types.js";

/** Read joined ticket state from Linear. Wraps the client for testability. */
export async function readTicketState(
  client: LinearClient,
  identifier: string,
): Promise<TicketState> {
  return client.getTicketState(identifier);
}
