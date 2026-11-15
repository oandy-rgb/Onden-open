// Model test of catching up by deltas (lib/data/storeOps applySyncDelta, the only
// door a sync response goes through). A tiny in-memory server mutates rows and
// can say "what changed since event k" as a delta; clients poll at random
// moments, so they apply deltas that cover different stretches, sometimes the
// same one twice (a reply that was delivered again).
//
//   1 following the server by deltas ends equal to the server, whatever the
//     polling moments, with nodes, edges, tasks and attributes compared as sets
//   2 applying a delta twice equals applying it once
//   3 catching up in two steps (a→b, then b→c) equals one step (a→c)
//   4 a deleted note leaves no edge, task or attribute behind, and
//     a note that was deleted and created again shows only its new rows
//
// Titles and attribute values include empty text, CJK, emoji and lone
// surrogates, zero-width characters, CRLF and very long lines.
//
// Replay:  PROPS_SEED=<seed> PROPS_RUNS=<n> npx vitest run <this file>

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { applySyncDelta } from "../../lib/data/storeOps";
import type { Bootstrap } from "../../lib/api";
import type { AppliedSyncDelta } from "../../lib/localDb";
import { PROPS_RUNS, PROPS_SEED } from "../helpers/propsConfig";

type Attrs = Record<string, string>;
type N = { id: string; title: string; parent_id: string | null; attrs: Attrs };
type E = { id: string; source_node_id: string; target_node_id: string };
type T = { id: string; node_id: string; title: string };
type State = { nodes: Map<string, N>; edges: Map<string, E>; tasks: Map<string, T> };

const NODE_IDS = ["n1", "n2", "n3", "n4"];
const EDGE_IDS = ["e1", "e2", "e3"];
const TASK_IDS = ["t1", "t2"];
const KEYS = ["k1", "k2", "路徑", "emoji😀"];

const text: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom("", "字", "日本語のタイトル", "😀", "👨‍👩‍👧", "a​b", "line\r\nbreak", "\ud83d", "\ud800x", "́", " "),
  fc.string({ unit: "grapheme", maxLength: 12 }),
  fc.string({ unit: "binary", maxLength: 12 }),
  fc.integer({ min: 200, max: 3000 }).map((n) => "長い行-".repeat(n)),
);

type Op =
  | { t: "putNode"; id: string; title: string; parent: string | null }
  | { t: "delNode"; id: string }
  | { t: "setAttr"; id: string; key: string; value: string }
  | { t: "delAttr"; id: string; key: string }
  | { t: "putEdge"; id: string; from: string; to: string }
  | { t: "delEdge"; id: string }
  | { t: "putTask"; id: string; node: string; title: string }
  | { t: "delTask"; id: string };
const nodeId = fc.constantFrom(...NODE_IDS);
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant("putNode" as const), id: nodeId, title: text, parent: fc.option(nodeId, { nil: null }) }),
  fc.record({ t: fc.constant("delNode" as const), id: nodeId }),
  fc.record({ t: fc.constant("setAttr" as const), id: nodeId, key: fc.constantFrom(...KEYS), value: text }),
  fc.record({ t: fc.constant("delAttr" as const), id: nodeId, key: fc.constantFrom(...KEYS) }),
  fc.record({ t: fc.constant("putEdge" as const), id: fc.constantFrom(...EDGE_IDS), from: nodeId, to: nodeId }),
  fc.record({ t: fc.constant("delEdge" as const), id: fc.constantFrom(...EDGE_IDS) }),
  fc.record({ t: fc.constant("putTask" as const), id: fc.constantFrom(...TASK_IDS), node: nodeId, title: text }),
  fc.record({ t: fc.constant("delTask" as const), id: fc.constantFrom(...TASK_IDS) }),
);

class Server {
  s: State = { nodes: new Map(), edges: new Map(), tasks: new Map() };
  /** One history line per event: what the delta since an older cursor must cover. */
  log: Array<{ n: number; op: Op }> = [];
  head = 0;

  do(o: Op): void {
    const { s } = this;
    switch (o.t) {
      case "putNode": {
        const old = s.nodes.get(o.id);
        s.nodes.set(o.id, { id: o.id, title: o.title, parent_id: o.parent, attrs: old ? { ...old.attrs } : {} });
        break;
      }
      case "delNode": {
        if (!s.nodes.delete(o.id)) return;
        for (const [id, e] of s.edges) if (e.source_node_id === o.id || e.target_node_id === o.id) s.edges.delete(id);
        for (const [id, t] of s.tasks) if (t.node_id === o.id) s.tasks.delete(id);
        break;
      }
      case "setAttr": { const n = s.nodes.get(o.id); if (!n) return; n.attrs = { ...n.attrs, [o.key]: o.value }; break; }
      case "delAttr": { const n = s.nodes.get(o.id); if (!n || !(o.key in n.attrs)) return; const { [o.key]: _, ...rest } = n.attrs; n.attrs = rest; break; }
      case "putEdge": if (!s.nodes.has(o.from) || !s.nodes.has(o.to)) return; s.edges.set(o.id, { id: o.id, source_node_id: o.from, target_node_id: o.to }); break;
      case "delEdge": if (!s.edges.delete(o.id)) return; break;
      case "putTask": if (!s.nodes.has(o.node)) return; s.tasks.set(o.id, { id: o.id, node_id: o.node, title: o.title }); break;
      case "delTask": if (!s.tasks.delete(o.id)) return; break;
    }
    this.log.push({ n: ++this.head, op: o });
  }

  /** The delta from a client that is at event `since`: the current rows that changed after it,
   *  the ids that are gone now and were not before, and the attribute changes of rows it keeps. */
  deltaSince(since: number): AppliedSyncDelta {
    const after = this.log.filter((l) => l.n > since).map((l) => l.op);
    const nodeTouched = new Set<string>(), edgeTouched = new Set<string>(), taskTouched = new Set<string>();
    const attrTouched = new Set<string>();
    for (const o of after) {
      if (o.t === "putNode" || o.t === "delNode") nodeTouched.add(o.id);
      if (o.t === "putEdge" || o.t === "delEdge") edgeTouched.add(o.id);
      if (o.t === "putTask" || o.t === "delTask") taskTouched.add(o.id);
      if (o.t === "setAttr" || o.t === "delAttr") attrTouched.add(JSON.stringify([o.id, o.key]));
      if (o.t === "delNode") {
        for (const e of EDGE_IDS) edgeTouched.add(e);
        for (const t of TASK_IDS) taskTouched.add(t);
      }
    }
    const { s } = this;
    const attrs: AppliedSyncDelta["attributes"] = { upsert: [], delete: [] };
    for (const pair of attrTouched) {
      const [id, key] = JSON.parse(pair) as [string, string];
      const n = s.nodes.get(id);
      if (!n || nodeTouched.has(id)) continue; // gone, or re-sent whole below
      if (key in n.attrs) attrs.upsert.push({ node_id: id, key, value: n.attrs[key]!, value_type: "text", is_inheritable: false, source: "ui" });
      else attrs.delete.push({ node_id: id, key });
    }
    const pick = <V,>(touched: Set<string>, rows: Map<string, V>) => ({
      upsert: [...touched].filter((id) => rows.has(id)).map((id) => structuredClone(rows.get(id)!)),
      delete: [...touched].filter((id) => !rows.has(id)),
    });
    const nodes = pick(nodeTouched, s.nodes);
    // Rows the client never had are harmless to delete: the protocol names ids that vanished.
    return {
      last_event_id: String(this.head),
      nodes, edges: pick(edgeTouched, s.edges), tasks: pick(taskTouched, s.tasks), attributes: attrs,
    } as unknown as AppliedSyncDelta;
  }
}

const empty = (): Bootstrap => ({ workspace: { id: "w", name: "W" }, nodes: [], edges: [], tasks: [], suggestions: [], events: [], actor_role: "admin" }) as unknown as Bootstrap;

function norm(b: Bootstrap) {
  const byId = <V extends { id: string }>(rows: V[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    nodes: byId(b.nodes as unknown as N[]).map((n) => ({ id: n.id, title: n.title, parent_id: n.parent_id, attrs: Object.entries(n.attrs ?? {}).sort() })),
    edges: byId(b.edges as unknown as E[]),
    tasks: byId(b.tasks as unknown as T[]),
  };
}
const serverNorm = (srv: Server) => norm({ ...empty(), nodes: [...srv.s.nodes.values()], edges: [...srv.s.edges.values()], tasks: [...srv.s.tasks.values()] } as unknown as Bootstrap);
const apply = (b: Bootstrap, d: AppliedSyncDelta) => applySyncDelta(b, structuredClone(d));

/** A client's catch-up plan: after how many ops it polls, and whether a reply arrives twice. */
const script = fc.record({
  ops: fc.array(op, { maxLength: 40 }),
  polls: fc.array(fc.record({ at: fc.nat(40), twice: fc.boolean() }), { maxLength: 8 }),
});

const params = { seed: PROPS_SEED, numRuns: PROPS_RUNS };

describe("sync delta replay", () => {
  it("1 deltas applied at random moments, some twice, end equal to the server", () => {
    fc.assert(fc.property(script, ({ ops, polls }) => {
      const srv = new Server();
      let client = empty();
      let cursor = 0;
      const pollAt = new Map<number, boolean>();
      for (const p of polls) pollAt.set(Math.min(p.at, ops.length), (pollAt.get(Math.min(p.at, ops.length)) ?? false) || p.twice);
      const sync = (twice: boolean) => {
        const d = srv.deltaSince(cursor);
        client = apply(client, d);
        if (twice) client = apply(client, d);
        cursor = srv.head;
      };
      ops.forEach((o, i) => { if (pollAt.has(i)) sync(pollAt.get(i)!); srv.do(o); });
      sync(false);
      expect(norm(client)).toEqual(serverNorm(srv));
    }), params);
  });

  it("2 applying a delta twice equals applying it once", () => {
    fc.assert(fc.property(fc.array(op, { maxLength: 40 }), fc.nat(40), (ops, cut) => {
      const srv = new Server();
      const first = Math.min(cut, ops.length);
      ops.slice(0, first).forEach((o) => srv.do(o));
      const client = apply(empty(), srv.deltaSince(0));
      const at = srv.head;
      ops.slice(first).forEach((o) => srv.do(o));
      const d = srv.deltaSince(at);
      expect(norm(apply(apply(client, d), d))).toEqual(norm(apply(client, d)));
    }), params);
  });

  it("3 two catch-up steps equal one", () => {
    fc.assert(fc.property(fc.array(op, { maxLength: 40 }), fc.nat(40), (ops, cut) => {
      const srv = new Server();
      const first = Math.min(cut, ops.length);
      let client = empty();
      ops.slice(0, first).forEach((o) => srv.do(o));
      const a = srv.head;
      const toB = srv.deltaSince(0);
      ops.slice(first).forEach((o) => srv.do(o));
      const twoStep = apply(apply(client, toB), srv.deltaSince(a));
      client = apply(empty(), srv.deltaSince(0));
      expect(norm(twoStep)).toEqual(norm(client));
    }), params);
  });

  it("4 a deleted note leaves no edge, task or attribute behind", () => {
    fc.assert(fc.property(fc.array(op, { maxLength: 40 }), fc.constantFrom(...NODE_IDS), (ops, victim) => {
      const srv = new Server();
      ops.forEach((o) => srv.do(o));
      let client = apply(empty(), srv.deltaSince(0));
      const before = srv.head;
      srv.do({ t: "delNode", id: victim });
      client = apply(client, srv.deltaSince(before));
      const state = norm(client);
      expect(state.nodes.some((n) => n.id === victim)).toBe(false);
      expect(state.edges.some((e) => e.source_node_id === victim || e.target_node_id === victim)).toBe(false);
      expect(state.tasks.some((t) => t.node_id === victim)).toBe(false);
      srv.do({ t: "putNode", id: victim, title: "again", parent: null });
      client = apply(client, srv.deltaSince(before));
      const again = norm(client).nodes.find((n) => n.id === victim);
      expect(again).toEqual({ id: victim, title: "again", parent_id: null, attrs: [] });
    }), params);
  });

  // A property key named "__proto__" is a plain key everywhere (the fuzz test pins that): applySyncDelta
  // writes it as an own property instead of assigning through the prototype setter.
  it("an attribute delta for a key named __proto__ reaches the note", () => {
    fc.assert(fc.property(text, (value) => {
      const srv = new Server();
      srv.do({ t: "putNode", id: "n1", title: "t", parent: null });
      const client = apply(empty(), srv.deltaSince(0));
      const at = srv.head;
      srv.do({ t: "setAttr", id: "n1", key: "__proto__", value });
      const state = norm(apply(client, srv.deltaSince(at)));
      expect(state.nodes[0]!.attrs).toEqual([["__proto__", value]]);
    }), params);
  });
});
