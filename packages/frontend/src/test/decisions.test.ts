import { describe, expect, it } from "vitest";
import type { InboxEvent } from "../lib/api";
import type { LiveEvent } from "../lib/liveEvent";
import { collectDecisions } from "../lib/decisions";

const event = (id: string, target: string) => ({ id, target_id: target, event_type: "NODE_UPDATED" }) as InboxEvent;
const conflict = (id: number, target: string, payload: Record<string, unknown>) => ({ id, target_id: target, payload }) as unknown as LiveEvent;
const known = new Set(["a", "b"]);

describe("collectDecisions", () => {
  it("groups everything that waits by note and adds up the places", () => {
    const d = collectDecisions({
      events: [event("1", "a"), event("2", "a"), event("3", "gone")],
      heldRequests: 2,
      fieldConflicts: [conflict(10, "a", {})],
      bodyConflicts: [conflict(11, "b", { conflicts: [{}, {}] }), conflict(12, "b", { truncated: true, conflicts: [] })],
      hasNote: (id) => known.has(id),
    });
    expect(d.byNote.get("a")).toMatchObject({ agentChanges: 2, fieldConflicts: 1, bodyConflicts: 0, total: 3 });
    expect(d.byNote.get("b")).toMatchObject({ bodyConflicts: 3, total: 3 }); // a conflict too long to list still counts once
    expect(d.otherEvents.map((e) => e.id)).toEqual(["3"]);
    expect(d.total).toBe(3 + 3 + 1 + 2);
  });

  it("is empty when nothing waits", () => {
    const d = collectDecisions({ events: [], heldRequests: 0, fieldConflicts: [], bodyConflicts: [], hasNote: () => true });
    expect(d.total).toBe(0);
    expect(d.byNote.size).toBe(0);
  });

  it("does not count a conflict on a note the person cannot see", () => {
    const d = collectDecisions({ events: [], heldRequests: 0, fieldConflicts: [conflict(1, "hidden", {})], bodyConflicts: [], hasNote: () => false });
    expect(d.total).toBe(0);
  });
});
