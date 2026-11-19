import { bindAccountStorage } from "../lib/accountStorage";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), api: mocks.api }));
vi.mock("../lib/localDb", () => ({
  upsertNode: vi.fn(), removeNode: vi.fn(), upsertAttribute: vi.fn(), removeAttribute: vi.fn(async () => {}),
  addPendingWrite: vi.fn(), getPendingWrites: vi.fn(async () => []), clearPendingWrite: vi.fn(async () => {}),
  storeRejectedWrite: vi.fn(async (request, rejection) => ({ ...request, id: 301, attempts: 0, rejection })),
}));

import { ApiError, type ContentNode } from "../lib/api";
import { upsertNode, removeNode, addPendingWrite, upsertAttribute, removeAttribute, getPendingWrites, clearPendingWrite } from "../lib/localDb";
import { memoryQueue } from "./helpers/memoryQueue";

// What is left queued once a write settled (every save is recorded first; see helpers/memoryQueue).
let queue: { rows: unknown[] };
import { makeNoteWriter } from "../lib/data/noteWriter";
import { makeNodeMutations } from "../lib/data/nodeMutations";
import { makeTagWriter } from "../lib/data/tagWriter";
import { WriteStorageError } from "../lib/data/writeErrors";
import type { DataCtx } from "../lib/data/types";
import { setPending } from "../lib/data/syncStatus";
import { setLocalePref } from "../lib/i18n";
import { getRecoveryWrites } from "../lib/data/writeRecovery";
import { ownerData } from "./ownerData";
import { isWhiteboardNote, opensOnWhiteboard } from "../lib/whiteboardNote";

const note: ContentNode = { id: "n1", title: "Original", markdown: "old body", slug: "original", source_type: "manual", node_type: "content", hidden: true };
function harness(online = true) {
  let state = { ...ownerData, nodes: [{ ...note }] };
  const ctx: DataCtx = {
    get data() { return state; }, online,
    setData: (update) => { state = typeof update === "function" ? update(state) : update; },
    addToast: vi.fn(), scheduleUserFolderSync: vi.fn(), refresh: vi.fn(async () => {}),
  };
  return { ctx, writer: makeNoteWriter(ctx), get: () => state };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.mockReset();
  vi.mocked(upsertNode).mockReset().mockResolvedValue();
  vi.mocked(removeNode).mockReset().mockResolvedValue();
  vi.mocked(addPendingWrite).mockReset();
  queue = memoryQueue({ addPendingWrite, getPendingWrites, clearPendingWrite });
  setPending(0);
  setLocalePref("en");
});

describe("note write lifecycle", () => {
  it("queues a duplicate with one UUID and retry key after a lost response", async () => {
    const h = harness();
    mocks.api.mockRejectedValueOnce(new TypeError("response lost"));
    const result = await h.writer.duplicate(note);
    expect(result.status).toBe("queued");
    expect(result.node).toMatchObject({ id: expect.any(String), title: "Original (Copy)", parent_id: null });
    expect(h.get().nodes.some(row => row.id === result.node.id)).toBe(true);
    const key = (mocks.api.mock.calls[0]![1].headers as Record<string, string>)["Idempotency-Key"];
    expect(mocks.api).toHaveBeenCalledWith("/api/nodes/n1/duplicate", expect.objectContaining({ method: "POST" }));
    expect(addPendingWrite).toHaveBeenCalledExactlyOnceWith("POST", "/api/nodes/n1/duplicate",
      JSON.stringify({ id: result.node.id }), key);
  });

  it("rolls back only a permanently refused duplicate and retains its rejected intent", async () => {
    const h = harness();
    mocks.api.mockRejectedValueOnce(new ApiError(403, "forbidden"));
    await expect(h.writer.duplicate(note)).rejects.toMatchObject({ status: 403 });
    expect(h.get().nodes.map(row => row.id)).toEqual([note.id]);
    expect(queue.rows).toEqual([]);
    expect(h.ctx.addToast).toHaveBeenCalled();
  });

  it("protects a started card save on pagehide while its mirror is still pending", async () => {
    const h = harness();
    const mirror = deferred<void>();
    vi.mocked(upsertNode).mockReturnValueOnce(mirror.promise);
    mocks.api.mockResolvedValueOnce({ ...note, markdown: "exit before mirror" });
    const saving = h.writer.patch(note.id, { markdown: "exit before mirror" });
    expect(getRecoveryWrites().some(row => row.text === "exit before mirror")).toBe(false);
    window.dispatchEvent(new Event("pagehide"));
    const copy = getRecoveryWrites().find(row => row.text === "exit before mirror");
    mirror.resolve();
    await saving;
    expect(copy).toMatchObject({ path: "/api/nodes/n1", method: "PATCH", idemKey: expect.any(String) });
    expect(mocks.api).toHaveBeenCalledWith('/api/nodes/n1', expect.objectContaining({
      headers: expect.objectContaining({ "Idempotency-Key": copy!.idemKey }),
    }));
    expect(getRecoveryWrites().some(row => row.id === copy!.id)).toBe(false);
  });
  it("does not reintroduce an unconfirmed copy after acknowledgement while refreshing the mirror", async () => {
    const h = harness();
    const mirror = deferred<void>();
    vi.mocked(upsertNode).mockResolvedValueOnce().mockReturnValueOnce(mirror.promise);
    mocks.api.mockResolvedValueOnce({ ...note, markdown: "already accepted" });
    const saving = h.writer.patch(note.id, { markdown: "already accepted" });
    await vi.waitFor(() => expect(upsertNode).toHaveBeenCalledTimes(2));
    window.dispatchEvent(new Event("pagehide"));
    const copy = getRecoveryWrites().find(row => row.text === "already accepted");
    mirror.resolve();
    await saving;
    expect(copy).toBeUndefined();
  });

  it("protects both the active save and a newer save waiting in the resource lane", async () => {
    const h = harness();
    const mirror = deferred<void>();
    vi.mocked(upsertNode).mockReturnValueOnce(mirror.promise);
    mocks.api.mockResolvedValueOnce({ ...note, markdown: "lane first" }).mockResolvedValueOnce({ ...note, markdown: "lane second" });
    const first = h.writer.patch(note.id, { markdown: "lane first" });
    const second = h.writer.patch(note.id, { markdown: "lane second" });
    window.dispatchEvent(new Event("pagehide"));
    const copies = getRecoveryWrites().filter(row => /lane (first|second)/.test(row.text));
    mirror.resolve();
    await Promise.all([first, second]);
    expect(copies.map(copy => copy.text)).toEqual(["lane first", "lane second"]);
    expect(new Set(copies.map(copy => copy.idemKey)).size).toBe(2);
    expect(mocks.api.mock.calls.map(call => (call[1].headers as Record<string, string>)["Idempotency-Key"])).toEqual(copies.map(copy => copy.idemKey));
    expect(getRecoveryWrites().some(row => copies.some(copy => copy.id === row.id))).toBe(false);
  });
  it("forwards card page-exit protection through the existing writer", async () => {
    const h = harness();
    mocks.api.mockResolvedValueOnce({ ...note, markdown: "exit draft" });
    await h.writer.patch(note.id, { markdown: "exit draft" }, { keepalive: true });
    expect(mocks.api).toHaveBeenCalledWith(`/api/nodes/${note.id}`, expect.objectContaining({
      method: "PATCH", keepalive: true, body: expect.stringContaining('"markdown":"exit draft"'),
      headers: expect.objectContaining({ "Idempotency-Key": expect.any(String) }),
    }));
  });
  it("rejects duplicate tag names without queueing and explains how to correct them", async () => {
    const h = harness();
    setLocalePref("zh-TW");
    h.ctx.setData(s => ({ ...s, nodes: [{ ...note, node_type: "class_tag" }],
      tags: [{ id: note.id, name: note.title, color: "#888888", schema_id: null }] }));
    mocks.api.mockRejectedValueOnce(new ApiError(409, JSON.stringify({ error: "tag_name_conflict", detail: "Conflict" })));
    await expect(h.writer.patch(note.id, { title: "Occupied" })).rejects.toMatchObject({ status: 409 });
    expect(h.get().nodes[0]!.title).toBe("Original");
    expect(h.get().tags![0]!.name).toBe("Original");
    expect(queue.rows).toEqual([]);
    expect(h.ctx.addToast).not.toHaveBeenCalled(); // the recovery entry (reason + kept input) is the one notification
  });

  it("reconciles tag headings and chips without renaming the independent schema pack", async () => {
    const h = harness();
    const tagNode: ContentNode = { ...note, node_type: "class_tag", tag_schema: { name: "Pack identity", slug: "pack", fields: [] } };
    h.ctx.setData(s => ({ ...s, nodes: [tagNode], tags: [{ id: note.id, name: note.title, color: "#888888", schema_id: note.id }] }));
    mocks.api.mockResolvedValueOnce({ ...tagNode, title: "Resolved tag" });
    await h.writer.patch(note.id, { title: "Draft tag" });
    expect(h.get().tags![0]!.name).toBe("Resolved tag");
    expect(h.get().nodes[0]!.tag_schema).toMatchObject({ name: "Pack identity" });
  });

  it("returns an explicit rename acknowledgement for forms", async () => {
    const h = harness();
    const actions = makeNodeMutations(h.ctx);
    await expect(actions.renameNode(note.id, "  ")).resolves.toBe(false);
    expect(mocks.api).not.toHaveBeenCalled();
    mocks.api.mockRejectedValueOnce(new ApiError(409, JSON.stringify({ error: "tag_name_conflict" })));
    await expect(actions.renameNode(note.id, "Occupied")).resolves.toBe(false);
    mocks.api.mockResolvedValueOnce({ ...note, title: "Available" });
    await expect(actions.renameNode(note.id, "Available")).resolves.toBe(true);
  });

  it("a saved rename leaves a whiteboard a whiteboard: the answer carries the note's views, and the store and local copy keep them", async () => {
    const views = [{ id: "tab", layout: "canvas", layout_config: { opens_first: true } }] as ContentNode["collection_views"];
    const h = harness();
    h.ctx.setData((state) => ({ ...state, nodes: state.nodes.map((row) => ({ ...row, collection_views: views })) }));
    const actions = makeNodeMutations(h.ctx);
    mocks.api.mockResolvedValueOnce({ ...note, title: "Renamed", collection_views: views });
    await expect(actions.renameNode(note.id, "Renamed")).resolves.toBe(true);
    const stored = h.get().nodes.find((row) => row.id === note.id)!;
    expect(stored).toMatchObject({ title: "Renamed", collection_views: views });
    expect(isWhiteboardNote(stored)).toBe(true);
    expect(opensOnWhiteboard(stored)).toBe(true);
    expect(vi.mocked(upsertNode).mock.calls.at(-1)?.[0]).toMatchObject({ collection_views: views });
  });

  it("renaming a note to the name it already has writes nothing", async () => {
    const h = harness();
    const actions = makeNodeMutations(h.ctx);
    await expect(actions.renameNode(note.id, `  ${note.title}  `)).resolves.toBe(true);
    expect(mocks.api).not.toHaveBeenCalled();
  });

  // The queue row comes first: the local copy changes only once it is durable, so no stored copy ever holds text the
  // queue does not (docs/architecture/note-writes.md 送出前先記下). The save is acknowledged after both.
  it("mirrors an offline creation only after its queue row is durable, and acknowledges it then", async () => {
    const h = harness(false);
    const commit = deferred<void>();
    vi.mocked(addPendingWrite).mockReturnValueOnce(commit.promise);
    const saving = h.writer.create({ title: "New note" });
    await vi.waitFor(() => expect(addPendingWrite).toHaveBeenCalledOnce());
    expect(upsertNode).not.toHaveBeenCalled();
    commit.resolve();
    await vi.waitFor(() => expect(upsertNode).toHaveBeenCalledWith(expect.objectContaining({ title: "New note" })));
    const result = await saving;
    expect(result.status).toBe("queued");
    expect(h.get().nodes).toContainEqual(result.node);
    expect(JSON.parse(vi.mocked(addPendingWrite).mock.calls[0]![2]!)).toMatchObject({ id: result.node.id, markdown: "" });
  });

  it("draws a note made under a kept-off note as kept off too (as the server will) and mirrors it; under any other it is plain", async () => {
    const h = harness(false);
    const parent = (id: string, attrs?: Record<string, string>): ContentNode => ({ ...note, id, hidden: false, ...(attrs ? { attrs } : {}) });
    const first = parent("off", { _published: "false" });
    h.ctx.setData((state) => ({ ...state, nodes: [first, parent("plain"), parent("back", { _published: "true" })] }));
    const underOff = await h.writer.create({ title: "Under off", parent_id: "off" });
    expect(h.get().nodes.find((n) => n.id === underOff.node.id)!.attrs).toEqual({ _published: "false", _published_by_parent: "true" });
    expect(vi.mocked(upsertAttribute)).toHaveBeenCalledWith(underOff.node.id, "_published", "false", "text", false, "ui");
    // The request carries no attributes of its own: the server decides from the parent it holds.
    expect(JSON.parse(vi.mocked(addPendingWrite).mock.calls[0]![2]!)).not.toHaveProperty("attributes");
    for (const parent_id of ["plain", "back", undefined]) {
      const made = await h.writer.create({ title: `Under ${parent_id}`, ...(parent_id ? { parent_id } : {}) });
      expect(h.get().nodes.find((n) => n.id === made.node.id)!.attrs, String(parent_id)).toBeUndefined();
    }
  });

  it("settles the drawn site default on what the server answers: a stale parent is corrected, an agreeing one stays", async () => {
    const parent = (attrs?: Record<string, string>): ContentNode => ({ ...note, id: "p", hidden: false, ...(attrs ? { attrs } : {}) });
    const run = async (answer: Record<string, string>) => {
      const h = harness();
      h.ctx.setData((state) => ({ ...state, nodes: [parent({ _published: "false" })] }));
      mocks.api.mockImplementationOnce(async (_path: string, init: { body: string }) => ({ ...JSON.parse(init.body), attrs: answer }));
      const made = await h.writer.create({ title: "C", parent_id: "p" });
      return h.get().nodes.find((n) => n.id === made.node.id)!.attrs ?? {};
    };
    // The parent was put back on the site on another device: the server gave the note no flag.
    expect(await run({})).toEqual({});
    expect(vi.mocked(removeAttribute)).toHaveBeenCalledWith(expect.any(String), "_published");
    expect(await run({ _published: "false", _published_by_parent: "true" })).toEqual({ _published: "false", _published_by_parent: "true" });
  });

  it("reconciles the server's resolved title into memory and the local mirror", async () => {
    const h = harness();
    mocks.api.mockResolvedValue({ ...note, title: "Resolved title", slug: "resolved-title" });
    await h.writer.patch(note.id, { title: "Draft title" });
    expect(h.get().nodes[0]).toMatchObject({ title: "Resolved title", slug: "resolved-title" });
    expect(upsertNode).toHaveBeenLastCalledWith(h.get().nodes[0]);
  });

  it("does not let a late response replace a newer edit", async () => {
    const h = harness();
    const firstResponse = deferred<ContentNode>();
    const secondResponse = deferred<ContentNode>();
    mocks.api.mockReturnValueOnce(firstResponse.promise).mockReturnValueOnce(secondResponse.promise);
    const first = h.writer.patch(note.id, { markdown: "first edit" });
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    const second = h.writer.patch(note.id, { markdown: "second edit" });
    firstResponse.resolve({ ...note, markdown: "first edit" });
    await first;
    expect(h.get().nodes[0]!.markdown).toBe("second edit");
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(2));
    expect(upsertNode).toHaveBeenLastCalledWith(expect.objectContaining({ markdown: "second edit" }));
    secondResponse.resolve({ ...note, markdown: "second edit" });
    await second;
  });

  it("rolls back only rejected fields and does not mirror a stale snapshot from the next operation", async () => {
    const h = harness();
    const response = deferred<ContentNode>();
    mocks.api.mockReturnValueOnce(response.promise).mockRejectedValueOnce(new TypeError("offline"));
    const renamed = h.writer.patch(note.id, { title: "Rejected title" });
    const rejection = expect(renamed).rejects.toMatchObject({ status: 422 });
    await vi.waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    const edited = h.writer.patch(note.id, { markdown: "New body" });
    response.reject(new ApiError(422, JSON.stringify({ error: "field_invalid", detail: "Title is invalid" })));
    await rejection;
    await edited;
    expect(h.get().nodes[0]).toMatchObject({ title: "Original", markdown: "New body" });
    expect(upsertNode).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Original", markdown: "New body" }));
    expect(h.ctx.addToast).not.toHaveBeenCalled(); // shown by the recovery entry
  });

  it("keeps a failed save observable to the editor and does not announce a successful rename", async () => {
    const h = harness(false);
    vi.mocked(addPendingWrite).mockRejectedValue(new Error("quota exceeded"));
    const actions = makeNodeMutations(h.ctx);
    await actions.renameNode(note.id, "Unsaved title");
    await expect(h.writer.patch(note.id, { markdown: "Unsaved body" })).rejects.toBeInstanceOf(WriteStorageError);
    expect(h.get().nodes[0]).toMatchObject({ title: "Unsaved title", markdown: "Unsaved body" });
    expect(h.ctx.addToast).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(h.ctx.addToast).mock.calls) {
      expect(call).toEqual([expect.stringContaining("recovery panel"), "error"]);
    }
  });

  it("continues a server save when only the note mirror fails, and reports the cache limitation", async () => {
    const h = harness();
    vi.mocked(upsertNode).mockRejectedValue(new Error("cache failed"));
    mocks.api.mockResolvedValue({ ...note, markdown: "saved" });
    await expect(h.writer.patch(note.id, { markdown: "saved" })).resolves.toMatchObject({ status: "synced" });
    expect(h.ctx.addToast).toHaveBeenCalledWith(expect.stringContaining("local copy"), "error");
    expect(h.get().nodes[0]!.markdown).toBe("saved");
  });

  it("restores a rejected deletion's dependents and never destroys their local copies", async () => {
    const h = harness();
    const edge = { id: "e1", source_node_id: note.id, target_node_id: "n2", edge_type: "knowledge_link" as const, status: "active" as const };
    const task = { id: "t1", node_id: note.id, title: "Task", status: "todo" as const };
    h.ctx.setData((state) => ({ ...state, edges: [edge], tasks: [task] }));
    // The server refuses the delete but still serves the note (the device reads it back after the refusal).
    mocks.api.mockImplementation(async (_path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") throw new ApiError(403, "Cannot delete this note");
      return note;
    });
    await expect(h.writer.remove(note.id)).rejects.toMatchObject({ status: 403 });
    expect(h.get()).toMatchObject({ nodes: [note], edges: [edge], tasks: [task] });
    expect(removeNode).not.toHaveBeenCalled();
  });

  it("a rejected deletion also restores the note's tag row and pointers", async () => {
    const h = harness();
    const tag = { id: note.id, name: "Tag", color: "#fff" } as NonNullable<typeof ownerData.tags>[number];
    const pointer = { id: "p1", parent_id: "root", target_id: note.id, order_key: "a0", display_prefix: null };
    const other = { id: "p2", parent_id: "root", target_id: "elsewhere", order_key: "a1", display_prefix: null };
    h.ctx.setData((state) => ({ ...state, tags: [tag], pointers: [pointer, other] }));
    mocks.api.mockRejectedValue(new ApiError(409, "tag in use"));
    await expect(h.writer.remove(note.id)).rejects.toMatchObject({ status: 409 });
    expect(h.get().tags).toEqual([tag]);
    expect(h.get().pointers).toEqual(expect.arrayContaining([pointer, other]));
    expect(h.get().pointers).toHaveLength(2);
  });

  it("refuses a note over a size cap before showing or queueing it (D67)", async () => {
    const h = harness(false);
    await expect(h.writer.patch(note.id, { markdown: "x".repeat(2_000_001) })).rejects.toThrow("2,000,000-character limit");
    await expect(h.writer.patch(note.id, { title: "t".repeat(501) })).rejects.toThrow("500 characters");
    await expect(h.writer.create({ title: "New", markdown: "x".repeat(2_000_001) })).rejects.toThrow("2,000,000-character limit");
    expect(h.get().nodes).toEqual([note]);
    expect(mocks.api).not.toHaveBeenCalled();
    expect(queue.rows).toEqual([]);
    // The two refused saves of typed text are in recovery (that entry is their notice); the create has none.
    expect(h.ctx.addToast).toHaveBeenCalledTimes(1);
    // (the mocked local database gives every refusal row the same id, so one entry stands for both)
    expect(getRecoveryWrites().filter((w) => w.path === `/api/nodes/${note.id}` && w.rejection).map((w) => w.rejection)).toEqual(["A note title can't be longer than 500 characters."]);
    // At the caps exactly, the write goes ahead.
    mocks.api.mockResolvedValueOnce({ ...note, title: "t".repeat(500) });
    await expect(harness().writer.patch(note.id, { title: "t".repeat(500) })).resolves.toMatchObject({ status: "synced" });
  });

  it("reports unavailable notes through the same user-facing error boundary", async () => {
    const h = harness();
    await expect(h.writer.patch("missing", { markdown: "draft" })).rejects.toThrow("Keep your draft");
    // The typed text is in recovery with the reason; that entry is the notice.
    expect(h.ctx.addToast).not.toHaveBeenCalled();
    expect(getRecoveryWrites().filter((w) => w.path === "/api/nodes/missing" && w.noteText?.markdown === "draft")).toHaveLength(1);
    expect(mocks.api).not.toHaveBeenCalled();
  });
});

beforeEach(() => { bindAccountStorage("unit-test-account", ""); });

describe("hiding is for tags only (D104)", () => {
  const withTag = (hidden = false) => {
    const h = harness();
    const tag = { id: "t1", title: "secret", slug: "tag-secret", markdown: "", source_type: "manual", node_type: "class_tag", hidden } as ContentNode;
    h.ctx.setData((state) => ({ ...state, nodes: [{ ...note, hidden: false }, tag], tags: [{ id: "t1", name: "secret", color: "", schema_id: null, hidden }] }));
    return { h, tags: makeTagWriter(h.ctx) };
  };

  it("the note actions have no hide", () => {
    expect("hideNode" in makeNodeMutations(harness().ctx)).toBe(false);
  });

  it("hides a tag through the node update, reflecting it on the node and in the catalog at once", async () => {
    const { h, tags } = withTag();
    mocks.api.mockResolvedValueOnce({ id: "t1", hidden: true });
    await expect(tags.setHidden("t1", true)).resolves.toEqual({ queued: false });
    expect(mocks.api).toHaveBeenCalledWith("/api/nodes/t1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ hidden: true }) }));
    expect(h.get().nodes.find((n) => n.id === "t1")!.hidden).toBe(true);
    expect(h.get().tags!.find((tag) => tag.id === "t1")!.hidden).toBe(true);
  });

  it("a refused hide puts the tag back and reports why", async () => {
    const { h, tags } = withTag();
    mocks.api.mockRejectedValueOnce(new ApiError(403, "forbidden"));
    await expect(tags.setHidden("t1", true)).rejects.toThrow();
    expect(h.get().tags!.find((tag) => tag.id === "t1")!.hidden).toBe(false);
    expect(h.get().nodes.find((n) => n.id === "t1")!.hidden).toBe(false);
    expect(h.ctx.addToast).toHaveBeenCalledWith(expect.any(String), "error");
  });

  it("unhides a hidden tag the same way", async () => {
    const { h, tags } = withTag(true);
    mocks.api.mockResolvedValueOnce({ id: "t1", hidden: false });
    await tags.setHidden("t1", false);
    expect(mocks.api).toHaveBeenCalledWith("/api/nodes/t1", expect.objectContaining({ body: JSON.stringify({ hidden: false }) }));
    expect(h.get().tags!.find((tag) => tag.id === "t1")!.hidden).toBe(false);
  });
});
