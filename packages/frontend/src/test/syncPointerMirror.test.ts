// Real sql.js worker RPCs with a simulated disk: sidebar pointers are mirrored
// locally (so pins survive an offline cold start) and /api/sync deltas add,
// retire and cascade them.
import { beforeEach, describe, it, expect, vi } from "vitest";
import type { AppliedSyncDelta } from "../lib/localDb";
import type { Bootstrap, NotePointer } from "../lib/api";
import { applySyncDelta } from "../lib/data/storeOps";

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

const note = (id: string) => ({ id, source_type: "manual", node_type: "content", title: id, slug: id, markdown: "", parent_id: null, hidden: false, sort_order: 0 });
const pointer = (id: string, parent: string | null, target: string): NotePointer =>
  ({ id, parent_id: parent, target_id: target, sort_order: 0, display_prefix: null });
const pinAUnderB = pointer("ab", "b", "a"), pinCUnderA = pointer("ca", "a", "c"), pinYUnderX = pointer("yx", "x", "y");
const bootstrap = {
  workspace: { id: "w", name: "Test", slug: "test", home_node_id: null }, actor_role: "editor",
  nodes: ["a", "b", "c", "x", "y"].map(note), edges: [], tasks: [], suggestions: [], events: [],
  pointers: [pinAUnderB, pinCUnderA, pinYUnderX],
};
const delta = (over: Record<string, unknown>) => ({
  last_event_id: 9, nodes: { upsert: [note("a")], delete: [] }, tasks: { upsert: [], delete: [] },
  edges: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null, ...over,
});
async function mirroredPointerIds() {
  const loaded = await ok("loadBootstrap") as Bootstrap;
  return (loaded.pointers ?? []).map(row => row.id).sort();
}

beforeEach(async () => {
  disk.bytes = null;
  await openWorker();
  await ok("persistBootstrap", bootstrap);
});

describe("sidebar pointer mirror", () => {
  it("keeps pointers across an offline cold start", async () => {
    await ok("flushLocalDbSync");
    await openWorker();
    expect(await mirroredPointerIds()).toEqual(["ab", "ca", "yx"]);
  });

  it("retires pointers touching a replaced node that the server no longer ships", async () => {
    const applied = await ok("applySync", delta({
      pointers: { upsert: [pinAUnderB], delete: [], replace_for: ["a"] },
    })) as AppliedSyncDelta;
    // Both "a under b" and "c under a" touch a; only the shipped one survives.
    expect(applied.pointers).toEqual({ upsert: [pinAUnderB], delete: ["ca"] });
    expect(await mirroredPointerIds()).toEqual(["ab", "yx"]);
    const memory = applySyncDelta(bootstrap as unknown as Bootstrap, applied);
    expect(memory.pointers?.map(row => row.id).sort()).toEqual(["ab", "yx"]);
  });

  it("adds a pointer created on another device", async () => {
    const pinAUnderX = pointer("ax", "x", "a");
    const applied = await ok("applySync", delta({
      pointers: { upsert: [pinAUnderB, pinCUnderA, pinAUnderX], delete: [], replace_for: ["a"] },
    })) as AppliedSyncDelta;
    expect(await mirroredPointerIds()).toEqual(["ab", "ax", "ca", "yx"]);
    expect(applySyncDelta(bootstrap as unknown as Bootstrap, applied).pointers?.map(row => row.id))
      .toContain("ax");
  });

  it("drops pointers under or to a deleted node", async () => {
    const applied = await ok("applySync", delta({ nodes: { upsert: [], delete: ["b"] } })) as AppliedSyncDelta;
    expect(await mirroredPointerIds()).toEqual(["ca", "yx"]);
    const memory = applySyncDelta(bootstrap as unknown as Bootstrap, applied);
    expect(memory.pointers?.map(row => row.id).sort()).toEqual(["ca", "yx"]);
  });

  it("leaves pointers alone when an older server sends no pointer channel", async () => {
    await ok("applySync", delta({}));
    expect(await mirroredPointerIds()).toEqual(["ab", "ca", "yx"]);
  });
});
