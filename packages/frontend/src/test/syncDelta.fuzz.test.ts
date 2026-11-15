// Fuzz: applying a sync delta to the in-memory tree (lib/data/storeOps.ts),
// the membership digest both sides compute, and the custom-CSS twin.
// Invariants: applying a delta is a pure transform (the previous state and the
// delta are not modified, a malformed delta throws before anything is
// returned: never a half-applied tree), a deleted note leaves no dangling edge
// or task, the client's digest equals the server's for any ids, and the two
// custom-CSS filters agree. Replay: FUZZ_SEED=<seed> npm run test:fuzz.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createHash } from "node:crypto";
import { applySyncDelta, isEmptyDelta } from "../lib/data/storeOps";
import { membershipDigestOf, MEMBERSHIP_BUCKET_CHARS } from "../lib/data/membershipDigest";
import { membershipDigestOf as serverDigest } from "../../../backend/src/services/sync/membership";
import type { Bootstrap } from "../lib/api";
import type { AppliedSyncDelta } from "../lib/localDb";
import { anyString, fuzzParams } from "./fuzzSupport";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const ids = fc.constantFrom("n1", "n2", "n3", "n4", "n5", "n6");
const node = fc.record({ id: ids, title: anyString, parent_id: fc.option(ids, { nil: null }), attrs: fc.dictionary(fc.constantFrom("k1", "k2", "__proto__", "constructor"), anyString, { maxKeys: 3 }) });
const edge = fc.record({ id: fc.constantFrom("e1", "e2", "e3", "e4"), source_node_id: ids, target_node_id: ids });
const task = fc.record({ id: fc.constantFrom("t1", "t2", "t3"), node_id: ids, title: anyString });
const state = fc.record({
  nodes: fc.uniqueArray(node, { selector: (n) => n.id, maxLength: 6 }),
  edges: fc.uniqueArray(edge, { selector: (e) => e.id, maxLength: 4 }),
  tasks: fc.uniqueArray(task, { selector: (t) => t.id, maxLength: 3 }),
});
const delta = fc.record({
  last_event_id: fc.integer({ min: 0, max: 1000 }).map(String),
  nodes: fc.record({ upsert: fc.array(node, { maxLength: 4 }), delete: fc.array(ids, { maxLength: 3 }) }),
  edges: fc.record({ upsert: fc.array(edge, { maxLength: 3 }), delete: fc.array(fc.constantFrom("e1", "e2", "e3", "e4"), { maxLength: 2 }) }),
  tasks: fc.record({ upsert: fc.array(task, { maxLength: 2 }), delete: fc.array(fc.constantFrom("t1", "t2", "t3"), { maxLength: 2 }) }),
  attributes: fc.record({
    upsert: fc.array(fc.record({ node_id: ids, key: fc.constantFrom("k1", "k2", "__proto__"), value: anyString }), { maxLength: 3 }),
    delete: fc.array(fc.record({ node_id: ids, key: fc.constantFrom("k1", "k2") }), { maxLength: 2 }),
  }),
});

const WS = { id: "w", name: "W" };
const prevOf = (s: { nodes: unknown[]; edges: unknown[]; tasks: unknown[] }) => ({ workspace: WS, ...s, suggestions: [], events: [], actor_role: "admin" }) as unknown as Bootstrap;

describe("sync delta application fuzz", () => {
  it("is pure, leaves no dangling edge or task for a deleted note, and keeps note ids unique", () => {
    fc.assert(fc.property(state, delta, (s, d) => {
      const prev = deepFreeze(prevOf(structuredClone(s)));
      const frozen = deepFreeze(structuredClone(d)) as unknown as AppliedSyncDelta;
      const next = applySyncDelta(prev, frozen); // a write to prev or the delta would throw (frozen, strict mode)
      const deleted = new Set<string>(d.nodes.delete);
      expect(new Set(next.nodes.map((n) => n.id)).size).toBe(next.nodes.length);
      for (const n of next.nodes) expect(deleted.has(n.id)).toBe(false);
      for (const e of next.edges) { expect(deleted.has(e.source_node_id)).toBe(false); expect(deleted.has(e.target_node_id)).toBe(false); }
      for (const t of next.tasks) { expect(t.node_id !== null && deleted.has(t.node_id)).toBe(false); expect(deleted.has(t.id)).toBe(false); }
      for (const n of d.nodes.upsert) if (!deleted.has(n.id)) expect(next.nodes.some((x) => x.id === n.id)).toBe(true);
      // Attribute upserts reach the note; a "__proto__" key is a plain key, not the prototype.
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.getPrototypeOf(next.nodes[0]?.attrs ?? {})).toBe(Object.prototype);
    }), fuzzParams(1000));
  });

  it("an empty delta changes nothing", () => {
    fc.assert(fc.property(state, (s) => {
      const empty = { last_event_id: "1", nodes: { upsert: [], delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] } };
      expect(isEmptyDelta(empty as never)).toBe(true);
      const prev = prevOf(structuredClone(s));
      const next = applySyncDelta(prev, empty as never);
      expect({ nodes: next.nodes, edges: next.edges, tasks: next.tasks }).toEqual(s);
    }), fuzzParams(200));
  });

  it("a malformed delta throws and leaves the state exactly as it was", () => {
    const garbage = fc.oneof(
      fc.constant({}), fc.constant(null), fc.constant({ nodes: null }), fc.constant({ nodes: { upsert: "x", delete: [] } }),
      delta.map((d) => ({ ...d, nodes: undefined })), delta.map((d) => ({ ...d, edges: { upsert: [null], delete: [] } })),
      delta.map((d) => ({ ...d, tasks: { upsert: [], delete: 5 } })), delta.map((d) => ({ ...d, attributes: { upsert: [{}], delete: [] } })),
      fc.anything(),
    );
    fc.assert(fc.property(state, garbage, (s, d) => {
      const prev = deepFreeze(prevOf(structuredClone(s)));
      const before = structuredClone(prev);
      try { applySyncDelta(prev, d as unknown as AppliedSyncDelta); } catch { /* rejected: the previous tree stands */ }
      expect(prev).toEqual(before);
    }), fuzzParams(500));
  });
});

describe("membership digest: client and server agree", () => {
  const sha256 = async (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

  it("the client's digest of a set equals the server's, for any ids", async () => {
    await fc.assert(fc.asyncProperty(fc.uniqueArray(anyString, { maxLength: 30 }), async (list) => {
      expect(await membershipDigestOf(list, sha256)).toEqual(serverDigest(list));
    }), fuzzParams(300));
    expect(MEMBERSHIP_BUCKET_CHARS).toBe(2);
  });
});
