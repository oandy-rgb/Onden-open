// A note's saved views live in the local mirror too: a board opened from the
// cached copy (a reload, offline) still knows its whiteboard tab and opens there
// (lib/viewTabs defaultTabKey). Found by the e2e sweep 2026-11-01: a
// deep link to a board this browser had seen opened on 內容.
import { beforeEach, describe, it, expect, vi } from "vitest";
import type { Bootstrap, ContentNode } from "../lib/api";
import { isRetiredBoardKind } from "../lib/whiteboardNote";
import { buildViewTabs, defaultTabKey } from "../lib/viewTabs";

const opensOnWhiteboard = (node: ContentNode) => defaultTabKey(buildViewTabs({
  views: (node.collection_views ?? []) as never, canvasImported: true, earnsWhiteboard: isRetiredBoardKind(node), canManage: false, contentName: "", whiteboardName: "", retiredBoard: isRetiredBoardKind(node),
})) === "canvas";


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
async function reload(): Promise<Bootstrap> {
  await ok("flushLocalDbSync");
  await openWorker();
  return await ok("loadBootstrap") as Bootstrap;
}

const VIEWS = [{ id: "tab-1", layout: "canvas", layout_config: { opens_first: true } }];
const note = (id: string, extra: Partial<ContentNode> = {}) =>
  ({ id, source_type: "manual", node_type: "content", title: id, slug: id, markdown: "", parent_id: null, hidden: false, order_key: "a0", ...extra }) as ContentNode;
const bootstrap = {
  workspace: { id: "w", name: "Test", slug: "test", home_node_id: null }, actor_role: "editor",
  nodes: [note("board", { collection_views: VIEWS }), note("plain", { collection_views: null })],
  edges: [], tasks: [], suggestions: [], events: [], pointers: [],
};
const byId = (b: Bootstrap, id: string) => b.nodes.find((n) => n.id === id)!;

beforeEach(async () => {
  disk.bytes = null;
  await openWorker();
  await ok("persistBootstrap", bootstrap);
});

describe("saved views in the local mirror", () => {
  it("a board read back from the cache keeps its whiteboard tab and opens there", async () => {
    const loaded = await reload();
    expect(byId(loaded, "board").collection_views).toEqual(VIEWS);
    expect(opensOnWhiteboard(byId(loaded, "board"))).toBe(true);
    expect(byId(loaded, "plain").collection_views ?? null).toBeNull();
  });

  it("a local edit that does not carry the views keeps them; a synced row replaces them", async () => {
    const { collection_views: _dropped, ...withoutViews } = note("board", { title: "Renamed" });
    await ok("upsertNode", withoutViews);
    expect(byId(await reload(), "board")).toMatchObject({ title: "Renamed", collection_views: VIEWS });

    await ok("applySync", {
      last_event_id: 9, nodes: { upsert: [note("board", { collection_views: [] })], delete: [] }, tasks: { upsert: [], delete: [] },
      edges: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null,
    });
    expect(byId(await reload(), "board").collection_views).toEqual([]);
  });
});
