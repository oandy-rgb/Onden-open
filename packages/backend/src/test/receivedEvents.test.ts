// The map of what a received unit records in this node's event log (services/receivedEvents.ts RECEIVED_EVENTS; own-node-transport §2.12.5, batch 4b):
// every label a change bundle carries says which events it records or why it goes past /api/sync, and nothing else is in the map. The module checks it
// when it loads (a table that starts to travel without an entry would be taken silently: its rows written, no client told), so loading it is the test.
import { describe, expect, it } from "vitest";

describe("what each carried unit records when a node takes it by bundle", () => {
  it("the map covers exactly the labels a bundle carries, each with an event or a reason: the module that writes received events loads", async () => {
    await expect(import("../services/receivedEvents.js")).resolves.toHaveProperty("receivedEventsOf");
  });
});
