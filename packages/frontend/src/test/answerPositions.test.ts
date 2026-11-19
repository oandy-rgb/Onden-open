// lib/answerPositions.ts in the REAL local-copy worker: an answer read below the watermark is not applied and leaves the
// cursor where it was; an applied answer raises the watermark (so an older one arriving later is refused); the watermark
// survives a reload; another server identity starts it over; a copy saved before it existed opens and keeps working;
// a whole bootstrap is judged by the same rule.
import { beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs from "sql.js";
import type { Bootstrap, ContentNode } from "../lib/api";
import type { AppliedSyncDelta } from "../lib/localDb";
import { openWorker, reopen, rpc } from "./helpers/localDbWorkerHarness";
import { isCurrentAnswer, higherPosition } from "../lib/answerPositions";

const disk = vi.hoisted(() => ({ bytes: null as ArrayBuffer | null }));
vi.mock("../lib/indexedDbStorage", () => ({
  idbLoad: async () => disk.bytes,
  idbSave: async (bytes: ArrayBuffer) => { disk.bytes = bytes; },
}));
vi.mock("sql.js", async (original) => {
  const real = await original<typeof import("sql.js")>();
  return { default: () => real.default() };
});

const note = (id: string, markdown: string) =>
  ({ id, source_type: "manual", node_type: "content", title: id, slug: id, markdown, parent_id: null, hidden: false, order_key: "a0" }) as ContentNode;
const answer = (markdown: string, head: number, server = "server-1", last = head) => ({
  last_event_id: last, head_event_id: String(head), server_id: server,
  nodes: { upsert: [note("n1", markdown)], delete: [] }, tasks: { upsert: [], delete: [] },
  edges: { upsert: [], delete: [] }, attributes: { upsert: [], delete: [] }, workspace: null,
});
const text = async () => (await rpc<Bootstrap>("loadBootstrap")).nodes.find((n) => n.id === "n1")?.markdown;
const cursor = () => rpc<number>("getLastEventId");
const boot = (markdown: string, last: string | undefined, server = "server-1") => ({
  workspace: { id: "w", name: "W", slug: "w", home_node_id: null }, actor_role: "editor", nodes: [note("n1", markdown)],
  edges: [], tasks: [], suggestions: [], events: [], pointers: [], server_id: server, ...(last ? { last_event_id: last } : {}),
});

beforeEach(async () => {
  disk.bytes = null;
  await openWorker();
  await rpc("persistBootstrap", boot("m0", undefined));
});

describe("the watermark in the local copy", () => {
  it("an answer read before an acknowledged write is not applied, the cursor stays, the next one is taken", async () => {
    await rpc("applySync", answer("m0", 10));
    await rpc("raiseWatermark", "12"); // the save's response said 12
    const late = await rpc<AppliedSyncDelta>("applySync", answer("old", 11));
    expect(late.stale).toBe(true);
    expect(await text()).toBe("m0");
    expect(await cursor()).toBe(10);
    const next = await rpc<AppliedSyncDelta>("applySync", answer("saved", 13));
    expect(next.stale).toBeUndefined();
    expect([await text(), await cursor()]).toEqual(["saved", 13]);
  });

  it("an older answer arriving after a newer one is refused: the applied head raised the watermark", async () => {
    await rpc("applySync", answer("newer", 20));
    expect((await rpc<AppliedSyncDelta>("applySync", answer("older", 18))).stale).toBe(true);
    expect(await text()).toBe("newer");
  });

  it("survives a reload", async () => {
    await rpc("raiseWatermark", "12");
    await reopen();
    expect(await rpc("getWatermark")).toEqual({ position: "12", server: "server-1", rebuildOwed: false });
    expect((await rpc<AppliedSyncDelta>("applySync", answer("old", 11))).stale).toBe(true);
    expect(await text()).toBe("m0");
  });

  it("another server identity starts the watermark over: a restored server (earlier state, new id) is followed", async () => {
    await rpc("raiseWatermark", "5000");
    const first = await rpc<AppliedSyncDelta>("applySync", answer("restored", 40, "server-2"));
    expect(first.serverChanged).toBe(true); // another log: the engine rebuilds from a whole bootstrap of it
    expect(await text()).toBe("m0");
    expect(await rpc("getWatermark")).toMatchObject({ position: null, rebuildOwed: true }); // owed until it is done
    await rpc("persistBootstrap", boot("restored", "40", "server-2"));
    expect(await text()).toBe("restored");
    expect(await rpc("getWatermark")).toEqual({ position: "40", server: "server-2", rebuildOwed: false });
    expect((await rpc<AppliedSyncDelta>("applySync", answer("after", 41, "server-2"))).stale).toBeUndefined();
    expect(await text()).toBe("after");
  });

  it("a bootstrap is judged by the same rule (its head is the cursor it was read at)", async () => {
    await rpc("raiseWatermark", "12");
    const stale = await rpc<{ answer_stale?: true }>("persistBootstrap", boot("old", "11"));
    expect(stale.answer_stale).toBe(true);
    expect(await text()).toBe("m0");
    await rpc("persistBootstrap", boot("current", "12"));
    expect(await text()).toBe("current");
  });

  it("a copy saved before the watermark existed opens, and is judged from its first acknowledgement", async () => {
    await rpc("flushLocalDbSync");
    const SQL = await initSqlJs();
    const old = new SQL.Database(new Uint8Array(disk.bytes!));
    old.run("DELETE FROM sync_state WHERE key IN ('answer_watermark', 'server_id')");
    disk.bytes = old.export().buffer as ArrayBuffer;
    old.close();
    await openWorker();
    expect(await text()).toBe("m0");
    expect((await rpc<AppliedSyncDelta>("applySync", answer("first", 9))).stale).toBeUndefined();
    await rpc("raiseWatermark", "12");
    expect((await rpc<AppliedSyncDelta>("applySync", answer("old", 11))).stale).toBe(true);
  });

  // Review 2 on #1794, item 1: a slow GET /api/nodes/:id of a big note is still downloading when a save is acknowledged
  // and the sync is applied; then the GET lands. It was read before the save, so it must not put the older text back
  // into the copy (a reload or an offline open would show it, and the next edit would start from it).
  it("the same server went back (same identity): refused until the watermark is forgotten, then taken and the cursor goes back", async () => {
    await rpc("applySync", answer("saved", 9000)); // what this device knew before the restore
    await rpc("raiseWatermark", "9000");
    expect(await cursor()).toBe(9000);
    const restored = await rpc<Bootstrap & { answer_stale?: true }>("persistBootstrap", boot("restored", "120"));
    expect(restored.answer_stale).toBe(true); // the copy refuses the restored log
    expect(await text()).toBe("saved");
    await rpc("forgetCopyWatermark"); // serverTruth.serverLostItsWrites
    const taken = await rpc<Bootstrap & { answer_stale?: true }>("persistBootstrap", boot("restored", "120"));
    expect(taken.answer_stale).toBeUndefined();
    expect([await text(), await cursor()]).toEqual(["restored", 120]);
    // From here the restored log is current: its next answer is taken.
    expect((await rpc<AppliedSyncDelta>("applySync", answer("after", 121))).stale).toBeUndefined();
  });

  it("a rebuild is owed from the going back until a whole bootstrap is stored, across a reload; the person is told once", async () => {
    await rpc("applySync", answer("saved", 9000));
    expect(await rpc("forgetCopyWatermark")).toEqual({ alreadyOwed: false });
    expect(await rpc("forgetCopyWatermark")).toEqual({ alreadyOwed: true }); // a second pass that failed to rebuild
    await reopen();
    expect(await rpc("getWatermark")).toMatchObject({ position: null, rebuildOwed: true });
    await rpc("persistBootstrap", { ...boot("restored", "120"), nodes_omitted: true }); // ?nodes=none is no rebuild
    expect(await rpc("getWatermark")).toMatchObject({ rebuildOwed: true });
    await rpc("persistBootstrap", boot("restored", "120"));
    expect(await rpc("getWatermark")).toMatchObject({ position: "120", rebuildOwed: false });
    await reopen();
    expect(await rpc("getWatermark")).toMatchObject({ rebuildOwed: false });
  });

  it("another identity's ?nodes=none or single read is not its whole state: a rebuild is owed; a slim rebuild pays it", async () => {
    await rpc("raiseWatermark", "5000");
    await rpc("persistBootstrap", { ...boot("m0", "40", "server-2"), nodes_omitted: true });
    expect(await rpc("getWatermark")).toMatchObject({ rebuildOwed: true });
    await rpc("persistBootstrap", { ...boot("restored", "40", "server-2"), bodies: "none" }); // a big workspace's slim rebuild
    expect(await rpc("getWatermark")).toMatchObject({ position: "40", server: "server-2", rebuildOwed: false });
    const read = await rpc<{ answer_stale?: true }>("persistRemoteNode", note("n1", "from server-3"), "7", "server-3");
    expect(read.answer_stale).toBe(true);
    expect(await rpc("getWatermark")).toMatchObject({ rebuildOwed: true });
  });

  it("a refusal carries the copy's watermark (the page learns what other tabs were told)", async () => {
    await rpc("raiseWatermark", "30");
    expect(await rpc<AppliedSyncDelta>("applySync", answer("old", 20))).toMatchObject({ stale: true, answer_watermark: "30" });
    expect(await rpc("persistBootstrap", boot("old", "20"))).toMatchObject({ answer_stale: true, answer_watermark: "30" });
  });

  it("a single read the copy refuses goes on its held list (held_text, kept with the snapshot); the next one taken takes it off", async () => {
    await rpc("applySync", answer("m0", 10));
    await rpc("raiseWatermark", "12");
    await rpc("persistRemoteNode", note("n1", "before the save"), "11");
    expect(await rpc("heldNotesNowSent")).toEqual(["n1"]);
    await reopen();
    expect(await rpc("heldNotesNowSent")).toEqual(["n1"]); // a reload still reads it again
    await rpc("persistRemoteNode", note("n1", "the saved text"), "12");
    expect(await rpc("heldNotesNowSent")).toEqual([]);
  });

  it("a single note read before an acknowledged save is not stored; one read after it is", async () => {
    await rpc("applySync", answer("m0", 10));
    await rpc("raiseWatermark", "12"); // the save's response said 12
    const late = await rpc<{ answer_stale?: true }>("persistRemoteNode", note("n1", "before the save"), "11");
    expect(late.answer_stale).toBe(true);
    expect(await text()).toBe("m0");
    await rpc("persistRemoteNode", note("n1", "the saved text"), "12");
    expect(await text()).toBe("the saved text");
  });

  it("the page can take the cursor back when it refuses an answer the copy took", async () => {
    await rpc("applySync", answer("m0", 10));
    await rpc("applySync", answer("x", 14));
    await rpc("rewindCursor", "10");
    expect(await cursor()).toBe(10);
  });
});

describe("the rule", () => {
  it("compares heads with the watermark; no head is current only while nothing is known", () => {
    expect(isCurrentAnswer("12", "12")).toBe(true);
    expect(isCurrentAnswer("11", "12")).toBe(false);
    expect(isCurrentAnswer(13, "12")).toBe(true);
    expect(isCurrentAnswer(undefined, null)).toBe(true);
    expect(isCurrentAnswer(undefined, "1")).toBe(false);
    expect(isCurrentAnswer("99999999999999999999", "99999999999999999998")).toBe(true); // bigint, not float
    expect(higherPosition("9", "10")).toBe("10");
    expect(higherPosition(null, "3")).toBe("3");
  });
});
