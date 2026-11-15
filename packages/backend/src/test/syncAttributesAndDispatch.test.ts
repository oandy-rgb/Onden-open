import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActorCtx } from "../types.js";

const actorCtx = (id: string, type: "human" | "agent" = "human"): ActorCtx => ({ id, name: id, role: "admin", type });

// Inline `key:: value` / `#key=value` derivation hands each parsed value to
// services/attributeChange.ts (which owns precedence, the no-op rule, the row
// and its event — see attributeEvents.integration.test.ts) and fires tag
// behaviours for what was written. Here: which values are recorded, how, and
// how the results map back. The store is a fake that applies the "priority"
// rule the way recordAttributeChange does.
type Row = { value: string; source: string };
let store = new Map<string, Row>();
const recorded: Array<{ key: string; value: string | undefined; source: string | undefined; rule: string; actor: string }> = [];

vi.mock("../services/attributeChange.js", () => ({
  recordAttributeChange: vi.fn(async (change: {
    key: string; actor: ActorCtx; rule: string;
    next: { value: string; source?: string } | null;
    within?: (ctx: { eventId: string; previous: Row | null; previousUpdatedAt: null; row: Row | null }) => Promise<void>;
  }) => {
    recorded.push({ key: change.key, value: change.next?.value, source: change.next?.source, rule: change.rule, actor: change.actor.id });
    const previous = store.get(change.key) ?? null;
    if (previous?.value === change.next!.value) return { written: false, current: previous };
    const row = { value: change.next!.value, source: change.next!.source! };
    store.set(change.key, row);
    await change.within?.({ eventId: `ev-${change.key}`, previous, previousUpdatedAt: null, row });
    return { written: true, previous, row, eventId: `ev-${change.key}` };
  }),
}));
// The cascade root checks write_node and opens the store; pass through here.
vi.mock("../spine/mutate.js", () => ({ runCascade: vi.fn(async (_opts: unknown, body: () => Promise<unknown>) => body()) }));
vi.mock("../db.js", () => ({ q: vi.fn(async () => ({ rows: [], rowCount: 0 })), pool: { query: vi.fn() } }));

const { syncAttributesAndDispatch } = await import("../services/nodes.js");

beforeEach(() => {
  store = new Map();
  recorded.length = 0;
});

describe("syncAttributesAndDispatch — no inline attrs", () => {
  it("plain markdown with no #key=value: nothing recorded", async () => {
    const r = await syncAttributesAndDispatch("ws", "node", "just plain prose", actorCtx("actor"));
    expect(r.changed).toEqual([]);
    expect(recorded).toEqual([]);
  });
});

describe("syncAttributesAndDispatch — fresh attrs (none existed)", () => {
  it("records each parsed value on the markdown rail", async () => {
    const r = await syncAttributesAndDispatch("ws", "node", "before #status=done after #priority=high", actorCtx("actor"));
    expect(recorded).toEqual([
      { key: "status", value: "done", source: "markdown", rule: "priority", actor: "actor" },
      { key: "priority", value: "high", source: "markdown", rule: "priority", actor: "actor" },
    ]);
    expect(r.changed).toEqual([
      { key: "status", old: null, new: "done" },
      { key: "priority", old: null, new: "high" },
    ]);
  });
});

describe("syncAttributesAndDispatch — no-op when value unchanged", () => {
  it("an unchanged value is not reported", async () => {
    store.set("status", { value: "done", source: "markdown" });
    const r = await syncAttributesAndDispatch("ws", "node", "#status=done", actorCtx("actor"));
    expect(r.changed).toEqual([]);
  });
});

describe("syncAttributesAndDispatch — mixed (one changed, one same)", () => {
  it("only the changed attribute is reported", async () => {
    store.set("status", { value: "todo", source: "markdown" });
    store.set("priority", { value: "high", source: "markdown" });
    const r = await syncAttributesAndDispatch("ws", "node", "#status=done #priority=high", actorCtx("actor"));
    expect(r.changed).toEqual([{ key: "status", old: "todo", new: "done" }]);
  });
});

describe("syncAttributesAndDispatch — attribution", () => {
  it("records as the supplied actor (submitter, not reviewer)", async () => {
    const submitter = actorCtx("submitter-agent", "agent");
    await syncAttributesAndDispatch("ws", "node", "#status=done", submitter);
    expect(recorded[0]!.actor).toBe("submitter-agent");
  });
});

describe("syncAttributesAndDispatch — reserved keys stay with their domains", () => {
  it("a `_`-prefixed key in the body is never recorded", async () => {
    await syncAttributesAndDispatch("ws", "node", "#_published=true #status=done", actorCtx("actor"));
    expect(recorded.map((r) => r.key)).toEqual(["status"]);
  });
});
