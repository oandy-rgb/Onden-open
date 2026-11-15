// Offline copy for large workspaces, through the real sql.js worker: bodies
// are downloaded into the local database only, never replace newer text or
// queued input, survive slim bootstraps and slim row writes, and a large cached
// workspace paints slim (bodies read on open).
import { beforeEach, describe, it, expect, vi } from "vitest";

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

import type { Bootstrap } from "../lib/api";
import { SLIM_MODE_NODE_THRESHOLD } from "../lib/slimMode";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const slimNote = (n: number, bodyLen: number) => ({ id: id(n), source_type: "manual", node_type: "content", title: `n${n}`, slug: `n${n}`, markdown: "", body_len: bodyLen, parent_id: null, hidden: false, sort_order: n, updated_at: `2026-10-0${n % 10}T00:00:00Z` });
const slimBoot = (nodes: ReturnType<typeof slimNote>[]) => ({
  bodies: "none", workspace: { id: "w", name: "Test", slug: "test", home_node_id: null }, actor_role: "editor",
  nodes, edges: [], tasks: [], suggestions: [], events: [],
});

beforeEach(async () => { disk.bytes = null; await openWorker(); });

describe("offline copy of note bodies", () => {
  it("lists only notes whose body is missing, newest first in pages, and stores downloaded bodies", async () => {
    await ok("persistBootstrap", slimBoot([slimNote(1, 5), slimNote(2, 0), slimNote(3, 7), slimNote(4, 2)]));
    expect(await ok("missingBodyIds", "", 10)).toEqual({ ids: [id(4), id(3), id(1)], next: null });
    const first = await ok("missingBodyIds", "", 2) as { ids: string[]; next: string };
    expect(first.ids).toEqual([id(4), id(3)]);
    expect(await ok("missingBodyIds", first.next, 2)).toEqual({ ids: [id(1)], next: null });
    expect(await ok("storeDownloadedBodies", [{ id: id(1), markdown: "hello" }])).toBe(1);
    expect(await ok("getStoredBody", id(1))).toBe("hello");
    expect(await ok("getStoredBody", id(3))).toBeNull();      // not downloaded
    expect(await ok("getStoredBody", id(2))).toBe("");        // really empty
    expect((await ok("missingBodyIds", "", 10) as { ids: string[] }).ids).toEqual([id(4), id(3)]);
  });

  it("forgets a body the server refused, unless local edits are still queued", async () => {
    await ok("persistBootstrap", slimBoot([slimNote(1, 5), slimNote(2, 5)]));
    await ok("storeDownloadedBodies", [{ id: id(1), markdown: "hello" }, { id: id(2), markdown: "mine!" }]);
    await ok("addPendingWrite", "PATCH", `/api/nodes/${id(2)}`, JSON.stringify({ markdown: "mine!!" }), "k0");
    expect(await ok("forgetBody", id(1))).toBe(true);
    expect(await ok("forgetBody", id(2))).toBe(false);
    expect(await ok("getStoredBody", id(1))).toBeNull();
    expect(await ok("getStoredBody", id(2))).toBe("mine!");
    // A create queued offline carries the id in its body, not its path.
    await ok("storeDownloadedBodies", [{ id: id(1), markdown: "hello again" }]);
    await ok("addPendingWrite", "POST", "/api/nodes", JSON.stringify({ id: id(1), title: "n1" }), "k-create");
    expect(await ok("forgetBody", id(1))).toBe(false);
    expect(await ok("getStoredBody", id(1))).toBe("hello again");
  });

  it("never replaces newer text from a sync, nor a note with queued writes", async () => {
    await ok("persistBootstrap", slimBoot([slimNote(1, 5), slimNote(2, 5)]));
    await ok("applySync", { last_event_id: 9, nodes: { upsert: [{ ...slimNote(1, 0), markdown: "newer", body_len: undefined }], delete: [] }, edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null });
    await ok("addPendingWrite", "PATCH", `/api/nodes/${id(2)}`, JSON.stringify({ title: "t" }), "k1");
    expect(await ok("storeDownloadedBodies", [{ id: id(1), markdown: "older" }, { id: id(2), markdown: "server" }])).toBe(0);
    expect(await ok("getStoredBody", id(1))).toBe("newer");
  });

  it("a download that arrives after the note was emptied writes nothing back (copy or search)", async () => {
    await ok("persistBootstrap", slimBoot([slimNote(1, 5), slimNote(2, 5)]));
    // Emptied while the download was in flight: a real empty body, body_len 0.
    await ok("upsertNode", { ...slimNote(1, 0), markdown: "" });
    expect(await ok("storeDownloadedBodies", [{ id: id(1), markdown: "hello" }])).toBe(0);
    expect(await ok("getStoredBody", id(1))).toBe("");
    expect(await ok("searchNodes", "hello")).toEqual([]);
    // A note whose body really is not downloaded yet still takes the download.
    expect(await ok("storeDownloadedBodies", [{ id: id(2), markdown: "hello" }])).toBe(1);
    expect(await ok("getStoredBody", id(2))).toBe("hello");
    expect((await ok("searchNodes", "hello") as Array<{ id: string }>).map((h) => h.id)).toEqual([id(2)]);
  });

  it("a later slim bootstrap and a slim row write keep a downloaded body", async () => {
    await ok("persistBootstrap", slimBoot([slimNote(1, 5)]));
    await ok("storeDownloadedBodies", [{ id: id(1), markdown: "hello" }]);
    await ok("persistBootstrap", slimBoot([slimNote(1, 5)]));
    await ok("upsertNode", { ...slimNote(1, 5), title: "renamed" });
    expect(await ok("getStoredBody", id(1))).toBe("hello");
  });

  it("a large cached workspace paints slim; queued notes keep their text", async () => {
    const nodes = Array.from({ length: SLIM_MODE_NODE_THRESHOLD }, (_, i) => slimNote(i + 1, 3));
    await ok("persistBootstrap", slimBoot(nodes));
    await ok("storeDownloadedBodies", [{ id: id(1), markdown: "abc" }, { id: id(2), markdown: "def" }]);
    await ok("upsertNode", { ...slimNote(2, 0), markdown: "def edited" });
    await ok("addPendingWrite", "PATCH", `/api/nodes/${id(2)}`, JSON.stringify({ markdown: "def edited" }), "k2");
    const painted = await ok("loadBootstrap") as Bootstrap;
    expect(painted.bodies).toBe("none");
    expect(painted.nodes.find((n) => n.id === id(1))).toMatchObject({ markdown: "", body_len: 3 });
    expect(painted.nodes.find((n) => n.id === id(2))).toMatchObject({ markdown: "def edited" });
  });

  it("a large cached workspace keeps the full text of a note whose create is still queued (D45)", async () => {
    const nodes = Array.from({ length: SLIM_MODE_NODE_THRESHOLD }, (_, i) => slimNote(i + 1, 3));
    await ok("persistBootstrap", slimBoot(nodes));
    // Created offline: the optimistic row holds the text, the id is in the body.
    await ok("upsertNode", { ...slimNote(1, 0), markdown: "written offline" });
    await ok("addPendingWrite", "POST", "/api/nodes", JSON.stringify({ id: id(1), title: "n1", markdown: "written offline" }), "k-new");
    const painted = await ok("loadBootstrap") as Bootstrap;
    expect(painted.bodies).toBe("none");
    expect(painted.nodes.find((n) => n.id === id(1))).toMatchObject({ markdown: "written offline", body_len: 15 });
    expect(painted.nodes.find((n) => n.id === id(2))).toMatchObject({ markdown: "" });
    // …and a body download never replaces it.
    expect(await ok("storeDownloadedBodies", [{ id: id(1), markdown: "server" }])).toBe(0);
  });

  it("forgets a refused body even when another queued write mentions its id (D45)", async () => {
    await ok("persistBootstrap", slimBoot([slimNote(1, 5), slimNote(2, 5), slimNote(3, 5)]));
    await ok("storeDownloadedBodies", [{ id: id(1), markdown: "hello" }]);
    await ok("addPendingWrite", "POST", "/api/edges", JSON.stringify({ id: "e1", source_node_id: id(2), target_node_id: id(1) }), "k-edge");
    await ok("addPendingWrite", "PATCH", `/api/nodes/${id(3)}`, JSON.stringify({ markdown: `see onden://node/${id(1)}` }), "k-link");
    expect(await ok("forgetBody", id(1))).toBe(true);
    expect(await ok("getStoredBody", id(1))).toBeNull();
  });

  it("rows queued before targets were recorded are read from their request (D45)", async () => {
    await ok("persistBootstrap", slimBoot([slimNote(1, 5), slimNote(2, 5)]));
    await ok("storeDownloadedBodies", [{ id: id(1), markdown: "hello" }, { id: id(2), markdown: "other" }]);
    await ok("addPendingWrite", "POST", "/api/nodes", JSON.stringify({ id: id(1), title: "n1" }), "k-old");
    await ok("addPendingWrite", "POST", "/api/edges", JSON.stringify({ id: "e1", source_node_id: id(1), target_node_id: id(2) }), "k-old-edge");
    // Rewrite the saved database as an older build left it: no targets.
    const SQL = await (await import("sql.js")).default();
    const old = new SQL.Database(new Uint8Array(disk.bytes!));
    old.run("UPDATE pending_writes SET targets = NULL");
    disk.bytes = old.export().buffer as ArrayBuffer;
    old.close();
    await openWorker();
    const queued = await ok("getPendingWrites") as Array<{ idem_key: string; targets?: unknown }>;
    expect(queued.map((w) => [w.idem_key, w.targets])).toEqual([["k-old", undefined], ["k-old-edge", undefined]]);
    expect(await ok("forgetBody", id(1))).toBe(false);  // its own create, decoded
    expect(await ok("forgetBody", id(2))).toBe(true);   // only mentioned by the edge
  });

  it("a small cached workspace keeps bodies in the painted rows", async () => {
    await ok("persistBootstrap", slimBoot([slimNote(1, 5), slimNote(2, 5)]));
    await ok("storeDownloadedBodies", [{ id: id(1), markdown: "hello" }]);
    const painted = await ok("loadBootstrap") as Bootstrap;
    expect(painted.bodies).toBeUndefined();
    expect(painted.nodes.find((n) => n.id === id(1))).toMatchObject({ markdown: "hello", body_len: 5 });
    expect(painted.nodes.find((n) => n.id === id(2))).toMatchObject({ markdown: "", body_len: 5 }); // still needs its body
  });
});
