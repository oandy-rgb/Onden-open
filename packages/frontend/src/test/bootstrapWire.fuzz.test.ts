// Fuzz: the compact bootstrap decoder (lib/data/bootstrapWire.ts, the wire
// format defined by backend services/sync/bootstrapWire.ts). Invariants:
// decode(encode(rows)) gives the rows back for any text in them; a garbage or
// truncated payload is rejected (an Error) or decodes to a state in which
// every id, key and dictionary-resolved field is a string or null, never a
// hole; the input object is not modified; nothing hangs.
// Replay: FUZZ_SEED=<seed> npm run test:fuzz.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { decodeBootstrapWire } from "../lib/data/bootstrapWire";
import { encodeBootstrapNodes } from "../../../backend/src/services/sync/bootstrapWire";
import type { Bootstrap } from "../lib/api";
import { anyString, expectWithinBudget, fuzzParams, loadCorpus, mutated } from "./fuzzSupport";

const corpus = loadCorpus("bootstrap");
const WS = "11111111-1111-4111-8111-111111111111";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** What decode must not leave behind. */
function holes(state: Bootstrap): string[] {
  const found: string[] = [];
  const stringOrNull = (v: unknown) => v === null || typeof v === "string";
  state.nodes.forEach((n, i) => {
    if (typeof n.id !== "string") found.push(`node ${i} id is ${typeof n.id}`);
    for (const key of ["space_id", "last_actor"] as const) if (!stringOrNull(n[key])) found.push(`node ${i} ${key} is ${typeof n[key]}`);
    for (const key of ["class_tag_ids", "label_tag_ids", "recent_actors"] as const) {
      const list = n[key];
      if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) found.push(`node ${i} ${key} holds a non-string`);
    }
  });
  (state.attributes ?? []).forEach((a: Record<string, unknown>, i) => {
    if (typeof a.node_id !== "string") found.push(`attribute ${i} node_id is ${typeof a.node_id}`);
    if (typeof a.key !== "string") found.push(`attribute ${i} key is ${typeof a.key}`);
    for (const key of ["value_type", "source"]) if (!stringOrNull(a[key])) found.push(`attribute ${i} ${key} is ${typeof a[key]}`);
  });
  return found;
}

/** Whether every node of a compact payload has a string id, every dictionary index points inside `dict` and every group names a node. The
 *  payloads that fail this are the findings below; the property skips them. */
function indexesInRange(payload: unknown): boolean {
  const p = payload as { dict?: unknown; nodes?: unknown; attribute_groups?: unknown } | null;
  if (!p || !Array.isArray(p.dict) || !Array.isArray(p.nodes)) return false;
  const size = p.dict.length;
  const ok = (i: unknown) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < size;
  for (const n of p.nodes as Array<Record<string, unknown>>) {
    if (!n || typeof n !== "object" || typeof n.id !== "string") return false;
    for (const key of ["space_id", "last_actor"]) if (typeof n[key] === "number" && !ok(n[key])) return false;
    for (const key of ["class_tag_ids", "label_tag_ids", "recent_actors"]) {
      const list = n[key];
      if (list !== undefined && (!Array.isArray(list) || !list.every(ok))) return false;
    }
  }
  const loose = (payload as { attributes?: unknown }).attributes;
  if (loose !== undefined && (!Array.isArray(loose) || loose.some((a) => !a || typeof a !== "object" || Array.isArray(a)))) return false;
  if (p.attribute_groups === undefined) return true;
  if (!Array.isArray(p.attribute_groups)) return false;
  return p.attribute_groups.every((g) => Array.isArray(g) && Number.isInteger(g[0]) && g[0] >= 0 && g[0] < (p.nodes as unknown[]).length && Array.isArray(g[1])
    && g[1].every((r: unknown) => Array.isArray(r) && r.length === 5 && ok(r[0]) && (r[2] === null || ok(r[2])) && (r[4] === null || ok(r[4]))));
}

function decodeText(text: string): { state: Bootstrap } | { error: unknown } | "unparsed" {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return "unparsed"; }
  try { return { state: decodeBootstrapWire(deepFreeze(data) as Bootstrap) }; } catch (error) { return { error }; }
}

const row = fc.record({
  id: fc.uuid(), title: anyString, slug: anyString, markdown: anyString,
  parent_id: fc.option(fc.uuid(), { nil: null }), hidden: fc.boolean(), order_key: fc.constantFrom("a0", "a1", "Zz", "a0V"), order_stamp: fc.constantFrom("", "000001700000000000000001"),
  source_type: fc.constantFrom("manual", "system", "import"), node_type: fc.constantFrom("content", "class_tag", "task"),
  space_id: fc.option(fc.uuid(), { nil: null }), last_actor: fc.option(anyString, { nil: null }),
  class_tag_ids: fc.array(fc.uuid(), { maxLength: 3 }), label_tag_ids: fc.array(fc.uuid(), { maxLength: 3 }), recent_actors: fc.array(anyString, { maxLength: 3 }),
});
const attribute = (ids: readonly string[]) => fc.record({
  node_id: ids.length ? fc.constantFrom(...ids, "not-a-node") : fc.constant("not-a-node"), key: anyString, value: fc.oneof(anyString, fc.constant(null)),
  value_type: fc.option(fc.constantFrom("text", "number", "date"), { nil: null }), is_inheritable: fc.option(fc.boolean(), { nil: null }), source: fc.option(anyString, { nil: null }),
});

describe("bootstrap wire fuzz", () => {
  it("decode(encode(rows)) returns the same nodes and attributes for any text", () => {
    const rows = fc.array(row, { maxLength: 6 }).chain((nodes) => fc.tuple(fc.constant(nodes), fc.array(attribute(nodes.map((n) => n.id)), { maxLength: 8 })));
    fc.assert(fc.property(rows, ([nodes, attributes]) => {
      const wire = encodeBootstrapNodes(WS, nodes, attributes);
      // Over the network it is JSON: that is what the decoder receives.
      const received = JSON.parse(JSON.stringify({ workspace: { id: WS }, ...wire })) as Bootstrap;
      const out = decodeBootstrapWire(received);
      expect(holes(out)).toEqual([]);
      expect(out.nodes.map((n) => n.id)).toEqual(nodes.map((n) => n.id));
      for (const [i, n] of nodes.entries()) {
        const got = out.nodes[i] as unknown as Record<string, unknown>;
        for (const key of ["title", "slug", "markdown", "parent_id", "hidden", "order_key", "order_stamp", "source_type", "node_type", "space_id", "last_actor", "class_tag_ids", "label_tag_ids", "recent_actors"] as const) {
          expect(got[key], `${n.id} ${key}`).toEqual(n[key]);
        }
      }
      const key = (a: { node_id: unknown; key: unknown; value: unknown }) => JSON.stringify([a.node_id, a.key, a.value]);
      expect((out.attributes as Array<Record<string, unknown>>).map((a) => key(a as never)).sort()).toEqual(attributes.map(key).sort());
    }), fuzzParams(300));
  });

  it("corpus seeds and their mutations: rejected with an Error, or decoded without holes; never hang, never modify the input", () => {
    fc.assert(fc.property(mutated(corpus), (text) => {
      expectWithinBudget("decodeBootstrapWire", text, 200, () => {
        const result = decodeText(text);
        if (result === "unparsed") return;
        if ("error" in result) { expect(result.error).toBeInstanceOf(Error); return; }
        // Tolerated here: a payload that is not the compact one passes through as it is.
        const payload = JSON.parse(text) as { wire?: unknown } | null;
        if (payload?.wire === 2 && indexesInRange(payload)) expect(holes(result.state)).toEqual([]);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      });
    }), fuzzParams(1500));
  });

  // The decoder trusts the shape. A payload that parses as JSON but is cut short or corrupt (a proxy's
  // error body that happens to carry `wire`, a dictionary cut by a truncated cache entry) is not rejected:
  it("a dictionary index past the end, or a node without an id, is rejected instead of decoding to `undefined`", () => {
    // dict has one entry; the node says space_id 7, last_actor -1 and tag ids [9, 1.5, null].
    // `dict[i]!` is `undefined`: the node is kept with holes, which syncEngine persists and renders from.
    const result = decodeText(corpus["dict-index-out-of-range"]!);
    expect("error" in (result as object) || holes((result as { state: Bootstrap }).state).length === 0).toBe(true);
    const truncated = decodeText(corpus["dict-truncated"]!);
    expect("error" in (truncated as object) || holes((truncated as { state: Bootstrap }).state).length === 0).toBe(true);
    // Nodes `{"title":"no id"}` and `{"id":5}` are kept as they are.
    const noId = decodeText(corpus["node-without-id"]!);
    expect("error" in (noId as object) || holes((noId as { state: Bootstrap }).state).length === 0).toBe(true);
  });

  // Found by the nightly long fuzz (FUZZ_LONG=1, seed 977906633, path 15176; 1 run in ~6 of the default
  // seeds). A node whose `space_id` index is an array (not an integer) is not rejected: it decodes with an
  // object where a string or null is required.
  it.fails("FINDING a non-integer space_id index (an array) decodes to an object instead of being rejected", () => {
    const text = '{"wire":2,"dict":["a"],"nodes":[{"id":"n1","space_id":[9,1.5,null]}],"workspace":{"id":"w"}}';
    const result = decodeText(text);
    expect("error" in (result as object) || holes((result as { state: Bootstrap }).state).length === 0).toBe(true);
  });

  it("malformed compact payloads are rejected with a typed error, not a bare TypeError", () => {
    // Only an unknown `wire` version throws a message of the decoder's own ("Unsupported bootstrap format").
    // A missing dict, nodes that are not a list, an attribute group naming a node past the end, a missing
    // workspace or a null body all surface as `TypeError: Cannot read properties of undefined`, which
    // callers cannot tell from a bug.
    for (const name of ["wire-no-dict", "nodes-not-array", "group-node-out-of-range", "no-workspace", "null"]) {
      const result = decodeText(corpus[name]!);
      expect("error" in (result as object), name).toBe(true);
      expect((result as { error: Error }).error.constructor, name).not.toBe(TypeError);
    }
  });
});
