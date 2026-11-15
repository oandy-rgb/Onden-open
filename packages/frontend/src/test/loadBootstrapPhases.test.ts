// Warm boot in two phases (perf F4): loadBootstrapList is the first paint
// (notes, no edges/tasks/attrs), loadBootstrapRelations and loadAttributePage
// the rest. Together they must say what loadBootstrap says, and the first
// paint must keep the queue's text.
import { beforeEach, describe, it, expect, vi } from "vitest";
import type { Bootstrap } from "../lib/api";
import { SLIM_MODE_NODE_THRESHOLD } from "../lib/slimMode";

const disk = vi.hoisted(() => ({ bytes: null as ArrayBuffer | null }));
vi.mock("../lib/indexedDbStorage", () => ({
  idbLoad: async () => disk.bytes,
  idbSave: async (bytes: ArrayBuffer) => { disk.bytes = bytes; },
}));
vi.mock("sql.js", async original => {
  const real = await original<typeof import("sql.js")>();
  return { default: () => real.default() };
});
type Reply = { ok: boolean; result?: unknown; error?: string };
let receive: (event: { data: { id: number; op: string; args: unknown[]; storageScope: string | null } }) => void;
let sequence = 0;
const replies = new Map<number, (reply: Reply) => void>();
async function ok(op: string, ...args: unknown[]) {
  const id = ++sequence;
  const reply = await new Promise<Reply>(resolve => { replies.set(id, resolve); receive({ data: { id, op, args, storageScope: null } }); });
  expect(reply.ok, reply.error).toBe(true);
  return reply.result;
}
async function openWorker() {
  vi.resetModules();
  const worker = { onmessage: null, postMessage: (reply: Reply & { id: number }) => {
    replies.get(reply.id)?.(reply); replies.delete(reply.id);
  } };
  vi.stubGlobal("self", worker);
  await import("../lib/localDbWorker");
  receive = worker.onmessage!;
  await ok("initLocalDb");
}


const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const note = (n: number, extra: object = {}) => ({ id: id(n), source_type: "manual", node_type: "content", title: `n${n}`, slug: `n${n}`, markdown: `body ${n}`, parent_id: null, hidden: false, sort_order: n, ...extra });
const boot = (nodes: object[], more: object = {}) => ({
  workspace: { id: "w", name: "Test", slug: "test", home_node_id: null }, actor_role: "editor",
  nodes, edges: [], tasks: [], suggestions: [], events: [], pointers: [], ...more,
});

beforeEach(async () => { disk.bytes = null; await openWorker(); });

async function rest() {
  const relations = await ok("loadBootstrapRelations") as Pick<Bootstrap, "edges" | "tasks" | "suggestions" | "pointers" | "graph_positions">;
  const rows: Array<{ node_id: string; key: string; value: string }> = [];
  for (let after = 0; ;) {
    const page = await ok("loadAttributePage", after, 2) as { rows: typeof rows; next: number | null };
    rows.push(...page.rows);
    if (page.next === null) return { relations, rows };
    after = page.next;
  }
}

describe("loadBootstrapList + the rest = loadBootstrap", () => {
  beforeEach(async () => {
    await ok("persistBootstrap", boot([note(1), note(2), note(3)], {
      edges: [{ id: "e1", source_node_id: id(1), target_node_id: id(2), edge_type: "link", status: "active", origin: "manual" }],
      attributes: [
        { node_id: id(1), key: "status", value: "open", value_type: "text", is_inheritable: false, source: "explicit" },
        { node_id: id(1), key: "priority", value: "2", value_type: "number", is_inheritable: false, source: "explicit" },
        { node_id: id(3), key: "status", value: "done", value_type: "text", is_inheritable: false, source: "explicit" },
        { node_id: id(2), key: "ink_data", value: "{}", value_type: "text", is_inheritable: false, source: "explicit" },
      ],
    }));
  });

  it("the list has the notes and no relations or attrs", async () => {
    const full = await ok("loadBootstrap") as Bootstrap;
    const list = await ok("loadBootstrapList") as Bootstrap;
    expect(list.nodes.map(({ attrs: _a, ...n }) => n)).toEqual(full.nodes.map(({ attrs: _a, ...n }) => n));
    expect(list.nodes.every((n) => Object.keys(n.attrs ?? {}).length === 0)).toBe(true);
    expect(list).toMatchObject({ edges: [], tasks: [], suggestions: [], graph_positions: [] });
    expect(list.workspace).toEqual(full.workspace);
    expect(list.tags).toEqual(full.tags);
  });

  it("the paged rest carries the edges and exactly the attrs of the full load (drawings excluded)", async () => {
    const full = await ok("loadBootstrap") as Bootstrap;
    const { relations, rows } = await rest();
    expect(relations.edges).toEqual(full.edges);
    expect(relations.edges).toHaveLength(1);
    const attrs: Record<string, Record<string, string>> = {};
    for (const r of rows) (attrs[r.node_id] ??= {})[r.key] = r.value;
    for (const n of full.nodes) expect(attrs[n.id] ?? {}).toEqual(n.attrs ?? {});
    expect(rows.some((r) => r.key === "ink_data")).toBe(false);
    expect(rows).toHaveLength(3);
  });

  it("pages of one row still reach every row once", async () => {
    let after = 0; let seen = 0; let pages = 0;
    for (;;) {
      const page = await ok("loadAttributePage", after, 1) as { rows: unknown[]; next: number | null };
      seen += page.rows.length; pages++;
      if (page.next === null) break;
      after = page.next;
    }
    expect(seen).toBe(3);
    expect(pages).toBeGreaterThanOrEqual(3);
  });
});

describe("the first paint keeps the user's queued text", () => {
  it("applies a queued edit and a queued create, as loadBootstrap does", async () => {
    await ok("persistBootstrap", boot([note(1), note(2)]));
    await ok("addPendingWrite", "PATCH", `/api/nodes/${id(1)}`, JSON.stringify({ title: "mine", markdown: "typed" }), "k1");
    await ok("addPendingWrite", "POST", "/api/nodes", JSON.stringify({ id: id(9), title: "new offline", markdown: "draft" }), "k2");
    const list = await ok("loadBootstrapList") as Bootstrap;
    const full = await ok("loadBootstrap") as Bootstrap;
    expect(list.nodes.find((n) => n.id === id(1))).toMatchObject({ title: "mine", markdown: "typed", body_len: 5 });
    expect(list.nodes.find((n) => n.id === id(9))).toMatchObject({ title: "new offline", markdown: "draft" });
    expect(list.nodes.map(({ attrs: _a, ...n }) => n)).toEqual(full.nodes.map(({ attrs: _a, ...n }) => n));
  });

  it("a slim paint of a large workspace reads no other bodies but keeps body_len and the queued ones", async () => {
    const nodes = Array.from({ length: SLIM_MODE_NODE_THRESHOLD }, (_, i) => note(i + 1, { markdown: i === 4 ? "" : "abc" }));
    await ok("persistBootstrap", boot(nodes));
    await ok("addPendingWrite", "PATCH", `/api/nodes/${id(2)}`, JSON.stringify({ title: "retitled only" }), "k1");
    const list = await ok("loadBootstrapList") as Bootstrap;
    const full = await ok("loadBootstrap") as Bootstrap;
    expect(list.bodies).toBe("none");
    expect(list.nodes.find((n) => n.id === id(1))).toMatchObject({ markdown: "", body_len: 3 });
    expect(list.nodes.find((n) => n.id === id(5))).toMatchObject({ markdown: "" });
    // queued note: its stored text stays, even though the queued change is only a title
    expect(list.nodes.find((n) => n.id === id(2))).toMatchObject({ title: "retitled only", markdown: "abc" });
    expect(list.nodes.map(({ attrs: _a, ...n }) => n)).toEqual(full.nodes.map(({ attrs: _a, ...n }) => n));
  });
});
