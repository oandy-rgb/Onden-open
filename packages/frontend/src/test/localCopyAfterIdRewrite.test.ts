// Migration 201 changed the id of the capture tag (and of spaces) on the server. A device's saved local copy (the real sql.js worker
// the app uses) holds the old tag and a note filed under it. The steps the sync engine takes when the membership epoch moves
// (lib/data/syncEngine.ts: isolateRevoked = a node delete, applyProjection = an upsert) must leave the NEW tag only: no second 收件匣.
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const OLD_TAG = "00000000-0000-4000-8000-0000000000a1";
const NEW_TAG = "00000000-0000-5000-8000-0000000000a1";
const OLD_SPACE = "00000000-0000-4000-8000-0000000000c1";
const NEW_SPACE = "00000000-0000-5000-8000-0000000000c1";
const node = (id: string, over: Record<string, unknown> = {}) => ({ id, source_type: "manual", node_type: "content", title: id, slug: id, markdown: "", parent_id: null, hidden: false, sort_order: 0, ...over });
const tagNode = (id: string) => node(id, { node_type: "class_tag", title: "收件匣", tag_schema: { module: "capture" } });
const empty = { edges: { upsert: [], delete: [] }, tasks: { upsert: [], delete: [] } };

beforeEach(async () => { disk.bytes = null; await openWorker(); });

describe("a saved local copy that holds ids the server has since rewritten", () => {
  it("ends with the new tag and the note under it, and no old tag left", async () => {
    await ok("persistBootstrap", {
      bodies: "none", last_event_id: "10", workspace: { id: "w", name: "Test", slug: "test", home_node_id: null }, actor_role: "editor",
      nodes: [tagNode(OLD_TAG), node("note", { space_id: OLD_SPACE, class_tag_ids: [OLD_TAG] })], edges: [], tasks: [], suggestions: [], events: [],
    });
    expect(await ok("getAllMembershipIds")).toEqual(expect.arrayContaining([OLD_TAG, "note"]));

    // the epoch moved: the reconcile finds the old tag is not readable any more (revoked) and the new one is (granted)
    await ok("applySync", { nodes: { upsert: [], delete: [OLD_TAG] }, ...empty, last_event_id: 10, head_event_id: "10" });
    await ok("applySync", { nodes: { upsert: [tagNode(NEW_TAG), node("note", { space_id: NEW_SPACE, class_tag_ids: [NEW_TAG] })], delete: [] }, ...empty, last_event_id: 10, head_event_id: "10" });

    const ids = (await ok("getAllMembershipIds")) as string[];
    expect(ids).toContain(NEW_TAG);
    expect(ids).toContain("note");
    expect(ids).not.toContain(OLD_TAG);
    expect(ids.filter((id) => id === NEW_TAG || id === OLD_TAG)).toHaveLength(1); // one 收件匣, not two
    const kept = (await ok("searchNodes", "收件匣")) as Array<{ id: string }> | { results?: Array<{ id: string }> };
    const found = Array.isArray(kept) ? kept : kept.results ?? [];
    expect(found.filter((n) => n.id === OLD_TAG)).toHaveLength(0);
  });
});
