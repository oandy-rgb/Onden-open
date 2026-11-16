// D64: an offline cold start lists notes in the sibling order every other
// surface uses (order_key, then stamp, then id — lib/childOrder), not in the
// order the local database happens to hold its rows. A synced edit rewrites
// the row (and used to move it last).
import { beforeEach, describe, it, expect, vi } from "vitest";
import type { Bootstrap } from "../lib/api";

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

const at = (i: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString();
const note = (id: string, place: number, created: number, title = id) =>
  ({ id, source_type: "manual", node_type: "content", title, slug: id, markdown: "", parent_id: "p", hidden: false, order_key: `a${place}`, created_at: at(created) });
// Shipped out of order on purpose: the mirror must not depend on it.
const bootstrap = {
  workspace: { id: "w", name: "Test", slug: "test", home_node_id: null }, actor_role: "editor",
  nodes: [note("c", 2, 3), note("d", 0, 9), note("a", 0, 1), note("b", 1, 2)],
  edges: [], tasks: [], suggestions: [], events: [], pointers: [],
};

beforeEach(async () => {
  disk.bytes = null;
  await openWorker();
  await ok("persistBootstrap", bootstrap);
});

describe("local mirror sibling order", () => {
  it("boots offline in key order (ties by id), keeping created_at", async () => {
    await ok("flushLocalDbSync");
    await openWorker();
    const loaded = await ok("loadBootstrap") as Bootstrap;
    expect(loaded.nodes.map((n) => n.id)).toEqual(["a", "d", "b", "c"]);
    expect(loaded.nodes[0].created_at).toBe(at(1));
  });

  it("a synced title edit does not move the note", async () => {
    await ok("applySync", {
      last_event_id: 9, nodes: { upsert: [note("a", 0, 1, "A renamed")], delete: [] }, tasks: { upsert: [], delete: [] },
      edges: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null,
    });
    await ok("flushLocalDbSync");
    await openWorker();
    const loaded = await ok("loadBootstrap") as Bootstrap;
    expect(loaded.nodes.map((n) => n.id)).toEqual(["a", "d", "b", "c"]);
    expect(loaded.nodes[0].title).toBe("A renamed");
  });
});
