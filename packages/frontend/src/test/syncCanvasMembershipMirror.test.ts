// D98, real sql.js worker RPCs with a simulated disk: "Appears on canvases"
// and hand-placed graph positions survive an offline warm start, and the sync
// delta's membership channel adds, retires and cascades them — in the mirror
// and, through the same resolved delta, in the store.
import { beforeEach, describe, it, expect, vi } from "vitest";
import type { AppliedSyncDelta } from "../lib/localDb";
import type { Bootstrap } from "../lib/api";
import { applySyncDelta } from "../lib/data/storeOps";
import type { CanvasMembership } from "@onden/contract";

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
async function coldStart(): Promise<Bootstrap> {
  await ok("flushLocalDbSync");
  await openWorker();
  return await ok("loadBootstrap") as Bootstrap;
}

const node = (id: string, node_type = "content") => ({ id, source_type: "manual", node_type, title: id, slug: id, markdown: "", parent_id: null, hidden: false, order_key: "a0" });
const on = (canvas_id: string, node_id: string, canvas_title = canvas_id.toUpperCase()): CanvasMembership => ({ canvas_id, canvas_title, node_id });
const bootstrap = {
  workspace: { id: "w", name: "Test", slug: "test", home_node_id: null }, actor_role: "editor",
  nodes: [node("a"), node("b"), node("c"), node("k1", "canvas"), node("k2", "canvas")], edges: [], tasks: [], suggestions: [], events: [],
  canvas_memberships: [on("k1", "a"), on("k1", "b"), on("k2", "a")],
  graph_positions: [{ nodeId: "a", x: 1, y: 2 }],
};
const delta = (over: Record<string, unknown>) => ({
  last_event_id: 9, nodes: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] },
  edges: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null, ...over,
});
const pairs = (rows: readonly CanvasMembership[] | undefined) => (rows ?? []).map(m => `${m.canvas_id}|${m.node_id}|${m.canvas_title}`).sort();
async function mirrored() { return pairs((await ok("loadBootstrap") as Bootstrap).canvas_memberships); }

beforeEach(async () => {
  disk.bytes = null;
  await openWorker();
  await ok("persistBootstrap", bootstrap);
});

describe("canvas memberships and graph positions in the local mirror", () => {
  it("keep across an offline warm start", async () => {
    const loaded = await coldStart();
    expect(pairs(loaded.canvas_memberships)).toEqual(["k1|a|K1", "k1|b|K1", "k2|a|K2"]);
    expect(loaded.graph_positions).toEqual([{ nodeId: "a", x: 1, y: 2 }]);
  });

  it("a ?nodes=none refresh replaces them too", async () => {
    await ok("persistBootstrap", { ...bootstrap, nodes: [], nodes_omitted: true, canvas_memberships: [on("k2", "c")], graph_positions: [] });
    const loaded = await coldStart();
    expect(pairs(loaded.canvas_memberships)).toEqual(["k2|c|K2"]);
    expect(loaded.graph_positions).toEqual([]);
  });

  it("a delta re-ships a canvas: a note dropped on it joins, one taken off leaves, others stay", async () => {
    // k1 now holds a and c (b was taken off); k2 is untouched by this delta.
    const applied = await ok("applySync", delta({
      nodes: { upsert: [node("k1", "canvas")], delete: [] },
      canvas_memberships: { upsert: [on("k1", "a"), on("k1", "c")], replace_for: ["k1"] },
    })) as AppliedSyncDelta;
    expect(applied.canvas_memberships).toEqual({ upsert: [on("k1", "a"), on("k1", "c")], delete: [{ canvas_id: "k1", node_id: "b" }] });
    expect(await mirrored()).toEqual(["k1|a|K1", "k1|c|K1", "k2|a|K2"]);
    const memory = applySyncDelta(bootstrap as unknown as Bootstrap, applied);
    expect(pairs(memory.canvas_memberships)).toEqual(["k1|a|K1", "k1|c|K1", "k2|a|K2"]);
    expect(pairs((await coldStart()).canvas_memberships)).toEqual(["k1|a|K1", "k1|c|K1", "k2|a|K2"]);
  });

  it("a shipped note brings every board it is on; a renamed canvas its new title", async () => {
    const applied = await ok("applySync", delta({
      nodes: { upsert: [node("a")], delete: [] },
      canvas_memberships: { upsert: [on("k1", "a", "Renamed")], replace_for: ["a"] },
    })) as AppliedSyncDelta;
    expect(await mirrored()).toEqual(["k1|a|Renamed", "k1|b|K1"]);
    const memory = applySyncDelta(bootstrap as unknown as Bootstrap, applied);
    expect(pairs(memory.canvas_memberships)).toEqual(["k1|a|Renamed", "k1|b|K1"]);
  });

  it("a deleted canvas or note takes its memberships and position along", async () => {
    const applied = await ok("applySync", delta({ nodes: { upsert: [], delete: ["k1", "a"] } })) as AppliedSyncDelta;
    expect(await mirrored()).toEqual([]);
    expect((await ok("loadBootstrap") as Bootstrap).graph_positions).toEqual([]);
    const memory = applySyncDelta(bootstrap as unknown as Bootstrap, applied);
    expect(memory.canvas_memberships).toEqual([]);
  });

  it("this device's own board change and graph placement reach the mirror", async () => {
    await ok("putCanvasMemberships", "k2", ["b", "a"], [on("k2", "b")]);
    await ok("putGraphPosition", "b", { x: 5, y: 6 });
    await ok("putGraphPosition", "a", null);
    const loaded = await coldStart();
    expect(pairs(loaded.canvas_memberships)).toEqual(["k1|a|K1", "k1|b|K1", "k2|b|K2"]);
    expect(loaded.graph_positions).toEqual([{ nodeId: "b", x: 5, y: 6 }]);
  });
});
