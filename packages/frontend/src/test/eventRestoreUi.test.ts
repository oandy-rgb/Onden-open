
// ER7 child-count cascade hint. Whether Restore is offered at all is the
// server's per-row `restorable` (D33); the rule's tests live with it in
// packages/backend/src/test/restoreBlockedReason.test.ts.

import { describe, it, expect } from "vitest";

type EventLite = {
  id: number;
  triggered_by_event_id?: string | number | null;
};

// Same Map-build the component does (kept in sync intentionally).
function buildChildCounts(events: EventLite[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const e of events) {
    const parent = e.triggered_by_event_id;
    if (parent == null) continue;
    const key = typeof parent === "number" ? parent : parseInt(String(parent), 10);
    if (Number.isFinite(key)) m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

describe("ER7 cascade child counts", () => {
  it("counts direct children only (not transitive)", () => {
    const events: EventLite[] = [
      { id: 1 }, // root
      { id: 2, triggered_by_event_id: 1 },
      { id: 3, triggered_by_event_id: 1 },
      { id: 4, triggered_by_event_id: 2 }, // grandchild — counts under 2, not 1
    ];
    const counts = buildChildCounts(events);
    expect(counts.get(1)).toBe(2);
    expect(counts.get(2)).toBe(1);
    expect(counts.get(3)).toBeUndefined();
  });

  it("parses string-form triggered_by (PG bigint stringified by pg.js)", () => {
    const events: EventLite[] = [
      { id: 1 },
      { id: 2, triggered_by_event_id: "1" },
    ];
    expect(buildChildCounts(events).get(1)).toBe(1);
  });

  it("ignores null/undefined parents (root events)", () => {
    const events: EventLite[] = [
      { id: 1, triggered_by_event_id: null },
      { id: 2 },
    ];
    expect(buildChildCounts(events).size).toBe(0);
  });

  it("ignores non-numeric parent ids (malformed input)", () => {
    const events: EventLite[] = [
      { id: 1, triggered_by_event_id: "not-a-number" },
    ];
    expect(buildChildCounts(events).size).toBe(0);
  });
});
