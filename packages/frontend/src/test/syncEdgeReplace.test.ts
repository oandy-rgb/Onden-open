// Real sql.js worker RPCs: `edges.replace_for` makes the shipped edges touching
// a node authoritative, so derived links (wikilinks) removed on the server stop
// lingering locally, while the user's own queued edge writes are preserved.
import { beforeEach, describe, it, expect, vi } from "vitest";
import type { AppliedSyncDelta } from "../lib/localDb";
import type { Bootstrap, NodeEdge } from "../lib/api";
import { applySyncDelta } from "../lib/data/storeOps";

vi.mock("../lib/indexedDbStorage", () => ({ idbLoad: async () => null, idbSave: async () => {} }));
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

const note = (id: string) => ({ id, source_type: "manual", node_type: "content", title: id, slug: id, markdown: "", parent_id: null, hidden: false, sort_order: 0 });
const edge = (id: string, source: string, target: string): NodeEdge =>
  ({ id, source_node_id: source, target_node_id: target, edge_type: "knowledge_link", status: "active" });
const linkAB = edge("ab", "a", "b"), linkAC = edge("ac", "a", "c"), linkCA = edge("ca", "c", "a"), linkXY = edge("xy", "x", "y");
const bootstrap = {
  workspace: { id: "w", name: "Test", slug: "test", home_node_id: null }, actor_role: "editor",
  nodes: ["a", "b", "c", "x", "y"].map(note), tasks: [], suggestions: [], events: [],
  edges: [linkAB, linkAC, linkCA, linkXY],
};
const delta = (edges: { upsert: NodeEdge[]; delete?: string[]; replace_for?: string[] }) => ({
  last_event_id: 9, nodes: { upsert: [note("a")], delete: [] }, tasks: { upsert: [], delete: [] },
  edges: { delete: [], ...edges }, attributes: { upsert: [], delete: [] }, workspace: null,
});
async function mirroredEdgeIds() {
  const loaded = await ok("loadBootstrap") as Bootstrap;
  return loaded.edges.map(row => row.id).sort();
}

beforeEach(async () => {
  vi.resetModules();
  const worker = { onmessage: null, postMessage: (reply: Reply & { id: number }) => {
    replies.get(reply.id)?.(reply); replies.delete(reply.id);
  } };
  vi.stubGlobal("self", worker);
  await import("../lib/localDbWorker");
  receive = worker.onmessage!;
  await ok("initLocalDb");
  await ok("persistBootstrap", bootstrap);
});

describe("authoritative edge sets in sync deltas", () => {
  it("deletes local edges touching a replaced node that the server no longer ships", async () => {
    const applied = await ok("applySync", delta({ upsert: [linkAB], replace_for: ["a"] })) as AppliedSyncDelta;
    // Both directions touch "a"; the unrelated x→y edge is outside the scope.
    expect([...applied.edges.delete].sort()).toEqual(["ac", "ca"]);
    expect(applied.edges.replace_for).toBeUndefined();
    expect(await mirroredEdgeIds()).toEqual(["ab", "xy"]);
    const memory = applySyncDelta(bootstrap as unknown as Bootstrap, applied);
    expect(memory.edges.map(row => row.id).sort()).toEqual(["ab", "xy"]);
  });

  it("keeps queued edge creations and does not revive queued edge deletions", async () => {
    const queued = edge("queued", "a", "y");
    await ok("upsertEdge", queued);
    await ok("addPendingWrite", "POST", "/api/edges", JSON.stringify(queued), "queued");
    await ok("addPendingWrite", "DELETE", "/api/edges/ab", null, "drop-ab");
    await ok("removeEdge", "ab");
    const applied = await ok("applySync", delta({ upsert: [linkAB, linkAC], replace_for: ["a"] })) as AppliedSyncDelta;
    expect(applied.edges.upsert.map(row => row.id)).toEqual(["ac"]);
    expect(applied.edges.delete).toEqual(["ca"]);
    expect(await mirroredEdgeIds()).toEqual(["ac", "queued", "xy"]);
  });

  it("without replace_for (an older server) only applies explicit edge changes", async () => {
    const applied = await ok("applySync", delta({ upsert: [linkAB], delete: ["xy"] })) as AppliedSyncDelta;
    expect(applied.edges.delete).toEqual(["xy"]);
    expect(await mirroredEdgeIds()).toEqual(["ab", "ac", "ca"]);
  });
});
