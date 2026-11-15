import { bindAccountStorage } from "../../lib/accountStorage";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../lib/api", async (original) => ({ ...await original<typeof import("../../lib/api")>(), api: vi.fn() }));
vi.mock("../../lib/localDb", () => ({
  storeRejectedWrite: async (request: import("../../lib/localDb").RejectedRequest, rejection: string) => ({ ...request, id: 901, attempts: 0, rejection }), upsertWorkspace: vi.fn(), upsertNode: vi.fn(), removeNode: vi.fn(), getPendingWrites: vi.fn(), addPendingWrite: vi.fn() }));
import { api, ApiError, noWorkspaceData, type Bootstrap, type ContentNode } from "../../lib/api";
import * as db from "../../lib/localDb";
import { makeWorkspaceWriter } from "../../lib/data/workspaceWriter";
import { isDesignStale, makeWebsiteWriter } from "./websiteWriter";
import { makeNoteHistoryWriter } from "../../lib/data/noteHistoryWriter";
import { makeNoteWriter } from "../../lib/data/noteWriter";
import { makeNodeMutations } from "../../lib/data/nodeMutations";
import { WriteActionError, WriteStorageError } from "../../lib/data/writeErrors";
import { setPending } from "../../lib/data/syncStatus";
import { setLocalePref } from "../../lib/i18n";
import { getAppState, resetAppState } from "../../lib/appStore";
import type { DataCtx } from "../../lib/data/types";
import { defaultDesignV2 } from "@onden/site";

const note: ContentNode = { id: "n", title: "Note", markdown: "original", slug: "note", node_type: "content", source_type: "manual" };
function harness(online = true) {
  let state: Bootstrap = { ...noWorkspaceData, workspace: { ...noWorkspaceData.workspace, home_node_id: null }, site_config: { brand: "Original", tagline: "Keep" }, nodes: [note] };
  const ctx: DataCtx = { get data() { return state; }, online, setData: (next) => { state = typeof next === "function" ? next(state) : next; }, addToast: vi.fn(), scheduleUserFolderSync: vi.fn(), refresh: vi.fn(async () => {}) };
  return { ctx, get: () => state };
}
/** The website writer works on the app store (writersFor): seed it with the harness state. */
function storeOptions(h: ReturnType<typeof harness>) {
  resetAppState({ data: h.get(), online: h.ctx.online });
  return { online: h.ctx.online, notify: h.ctx.addToast };
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => { vi.resetAllMocks(); vi.mocked(db.getPendingWrites).mockResolvedValue([]); setPending(0); setLocalePref("en"); });

describe("website and workspace domain contract", () => {
  it("does not acknowledge offline home selection until its durable queue confirms", async () => {
    const h = harness(false); const gate = deferred<void>(); vi.mocked(db.addPendingWrite).mockReturnValue(gate.promise);
    let done = false;
    const save = makeWorkspaceWriter(h.ctx).setHome("n").then((result) => { done = true; return result; });
    await vi.waitFor(() => expect(db.addPendingWrite).toHaveBeenCalledOnce());
    expect(done).toBe(false); expect(h.get().workspace.home_node_id).toBe("n");
    gate.resolve(); expect((await save).status).toBe("queued");
    expect(db.upsertWorkspace).toHaveBeenLastCalledWith(h.get().workspace, { site_config: h.get().site_config, chrome: undefined });
  });

  it("restores the original home after two permanent rejections", async () => {
    const h = harness(); const writer = makeWorkspaceWriter(h.ctx); const gate = deferred<unknown>();
    vi.mocked(api).mockReturnValueOnce(gate.promise).mockRejectedValueOnce(new ApiError(403, "Denied"));
    const a = writer.setHome("a").catch(() => {});
    await vi.waitFor(() => expect(api).toHaveBeenCalledOnce());
    const b = writer.setHome("b").catch(() => {}); gate.reject(new ApiError(403, "Denied"));
    await Promise.all([a, b]); expect(h.get().workspace.home_node_id).toBe(null);
  });

  it("rejected settings preserve a later layout and an unrelated setting", async () => {
    const h = harness(); const writer = makeWorkspaceWriter(h.ctx); const gate = deferred<unknown>();
    vi.mocked(api).mockReturnValueOnce(gate.promise).mockResolvedValueOnce({});
    const a = writer.saveDesign({ config: { brand: "Rejected" } }).catch(() => {});
    await vi.waitFor(() => expect(api).toHaveBeenCalledOnce());
    const b = writer.saveDesign({ chrome: { blocks: [] }, config: { tagline: "New tagline" } });
    gate.reject(new ApiError(422, "Invalid")); await Promise.all([a, b]);
    expect(h.get()).toMatchObject({ site_config: { brand: "Original", tagline: "New tagline" }, chrome: { blocks: [] } });
  });

  it("design saves name the revision they start from, chained before the replies (D119)", async () => {
    const h = harness(); h.ctx.setData((state) => ({ ...state, chrome: { ...defaultDesignV2(), studio_draft: true, rev: "r0" } }));
    const gate = deferred<unknown>();
    vi.mocked(api).mockReturnValueOnce(gate.promise).mockResolvedValueOnce({});
    const writer = makeWebsiteWriter(storeOptions(h));
    const first = writer.saveHomeDesign(defaultDesignV2());
    const second = writer.saveHomeDesign(defaultDesignV2({ homeNoteId: "n" }));
    gate.resolve({}); await Promise.all([first, second]);
    const bodies = vi.mocked(api).mock.calls.filter(([path]) => path === "/api/workspace/config")
      .map(([, init]) => JSON.parse(String(init!.body)) as { chrome: { rev: string }; chrome_base: string | null });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.chrome_base).toBe("r0");
    expect(bodies[1]!.chrome_base).toBe(bodies[0]!.chrome.rev);
    expect(bodies[1]!.chrome.rev).not.toBe(bodies[0]!.chrome.rev);
  });

  it("a stale design save is rolled back, and reloading takes the server's design (D119)", async () => {
    const h = harness(); h.ctx.setData((state) => ({ ...state, chrome: { ...defaultDesignV2(), studio_draft: true, rev: "r0" } }));
    const writer = makeWebsiteWriter(storeOptions(h));
    const newer = { ...defaultDesignV2({ homeNoteId: "newer" }), studio_draft: true, rev: "r9" };
    vi.mocked(api).mockRejectedValueOnce(new ApiError(409, JSON.stringify({ error: "design_stale" })))
      .mockResolvedValueOnce({ config: {}, chrome: newer });
    const refused = await writer.saveHomeDesign(defaultDesignV2({ homeNoteId: "mine" })).catch((error: unknown) => error);
    expect(isDesignStale(refused)).toBe(true);
    expect(getAppState().data.chrome).toMatchObject({ ...defaultDesignV2(), rev: "r0" });
    await writer.reloadDesign();
    expect(getAppState().data.chrome).toEqual(newer);
  });

  it("storage failure retains the site intent without claiming success", async () => {
    const h = harness(false); vi.mocked(db.addPendingWrite).mockRejectedValue(new Error("quota"));
    await expect(makeWorkspaceWriter(h.ctx).saveDesign({ config: { brand: "Keep draft" } })).rejects.toBeInstanceOf(WriteStorageError);
    expect(h.get().site_config?.brand).toBe("Keep draft");
    expect(h.ctx.addToast).toHaveBeenCalledWith(expect.stringContaining("recovery panel"), "error");
  });

  it("publishing refuses queued changes and reuses the key after a lost response", async () => {
    const h = harness(); const writer = makeWebsiteWriter(storeOptions(h)); const input = { title: "Site", home_node_id: null, presentation: {}, preview_hash: "a".repeat(64) };
    vi.mocked(db.getPendingWrites).mockResolvedValueOnce([{ id: 1, idem_key: "k", method: "PATCH", path: "/api/workspace", body: "{}", attempts: 0 }]);
    await expect(writer.publish(input)).rejects.toBeInstanceOf(WriteActionError);
    expect(api).not.toHaveBeenCalled();
    vi.mocked(api).mockRejectedValueOnce(new TypeError("lost response")).mockResolvedValueOnce({ url: "/site" });
    await expect(writer.publish(input)).rejects.toThrow("lost response");
    await expect(writer.publish(input)).resolves.toEqual({ url: "/site" });
    const calls = vi.mocked(api).mock.calls;
    expect(calls[0]![1]?.headers).toEqual(calls[1]![1]?.headers);
    expect(db.addPendingWrite).not.toHaveBeenCalled();
  });

  it("version restore merges its body without overwriting a newer title, then mirrors current data", async () => {
    const h = harness(); const gate = deferred<ContentNode>();
    vi.mocked(api).mockReturnValueOnce(gate.promise).mockResolvedValueOnce({});
    const restore = makeNoteHistoryWriter(h.ctx).restoreVersion("n", "v1", { restoreTitle: false });
    await vi.waitFor(() => expect(api).toHaveBeenCalledOnce());
    const edit = makeNoteWriter(h.ctx).patch("n", { title: "Later title" });
    gate.resolve({ ...note, title: "Past title", markdown: "restored" });
    await Promise.all([restore, edit]);
    expect(h.get().nodes[0]).toMatchObject({ title: "Later title", markdown: "restored" });
    expect(db.upsertNode).toHaveBeenLastCalledWith(h.get().nodes[0]);
  });

  it("loads the real node after a lost restore response is acknowledged as a replay", async () => {
    const h = harness(); const writer = makeNoteHistoryWriter(h.ctx);
    vi.mocked(api).mockRejectedValueOnce(new TypeError("lost response"))
      .mockResolvedValueOnce({ deduped: true })
      .mockResolvedValueOnce({ ...note, markdown: "Restored on server" });
    await expect(writer.restoreVersion("n", "v1", { restoreTitle: false })).rejects.toThrow("lost response");
    await expect(writer.restoreVersion("n", "v1", { restoreTitle: false })).resolves.toMatchObject({ markdown: "Restored on server" });
    expect(vi.mocked(api).mock.calls[0]![1]?.headers).toEqual(vi.mocked(api).mock.calls[1]![1]?.headers);
    expect(api).toHaveBeenNthCalledWith(3, "/api/nodes/n");
    expect(h.get().nodes[0]?.markdown).toBe("Restored on server");
    expect(db.upsertNode).toHaveBeenLastCalledWith(expect.objectContaining({ markdown: "Restored on server" }));
  });

  it("sends the title choice with the restore, and a changed choice is a new operation", async () => {
    const h = harness(); const writer = makeNoteHistoryWriter(h.ctx);
    vi.mocked(api).mockRejectedValueOnce(new TypeError("lost response")).mockResolvedValueOnce({ ...note, markdown: "restored" });
    await expect(writer.restoreVersion("n", "v1", { restoreTitle: false })).rejects.toThrow("lost response");
    await expect(writer.restoreVersion("n", "v1", { restoreTitle: true })).resolves.toMatchObject({ markdown: "restored" });
    expect(vi.mocked(api).mock.calls.map((call) => call[1]?.body)).toEqual([
      JSON.stringify({ restore_title: false }), JSON.stringify({ restore_title: true }),
    ]);
    // Not the same decision: the retry does not reuse the first attempt's idempotency key.
    expect(vi.mocked(api).mock.calls[0]![1]?.headers).not.toEqual(vi.mocked(api).mock.calls[1]![1]?.headers);
  });

  it("keeps an acknowledged restore successful when its result read fails; retry only reads", async () => {
    const h = harness(); const writer = makeNodeMutations(h.ctx);
    vi.mocked(api).mockResolvedValueOnce({ deduped: true })
      .mockRejectedValueOnce(new TypeError("read offline"))
      .mockResolvedValueOnce({ ...note, markdown: "A newer server edit after restoration" });
    await expect(writer.restoreVersion("n", "v1", { restoreTitle: false })).resolves.toBeUndefined();
    expect(h.get().nodes[0]?.markdown).toBe("original");
    expect(h.ctx.addToast).toHaveBeenCalledWith(expect.stringContaining("change is saved"), "info");
    expect(h.ctx.addToast).not.toHaveBeenCalledWith("Version restored");
    await expect(writer.restoreVersion("n", "v1", { restoreTitle: false })).resolves.toMatchObject({ markdown: "A newer server edit after restoration" });
    expect(vi.mocked(api).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(vi.mocked(api).mock.calls.slice(1).map(([path]) => path)).toEqual(["/api/nodes/n", "/api/nodes/n"]);
  });

  it("takes the restore baseline after an earlier queued save applies its server merge", async () => {
    const h = harness(); const gate = deferred<ContentNode>();
    vi.mocked(api).mockReturnValueOnce(gate.promise)
      .mockResolvedValueOnce({ ...note, markdown: "Historical body" });
    const edit = makeNoteWriter(h.ctx).patch("n", { markdown: "My pending edit" });
    await vi.waitFor(() => expect(api).toHaveBeenCalledOnce());
    const restore = makeNoteHistoryWriter(h.ctx).restoreVersion("n", "v1", { restoreTitle: false });
    gate.resolve({ ...note, markdown: "My pending edit plus another device's edit" });
    await edit;
    await expect(restore).resolves.toMatchObject({ markdown: "Historical body" });
    expect(h.get().nodes[0]?.markdown).toBe("Historical body");
    expect(db.upsertNode).toHaveBeenLastCalledWith(expect.objectContaining({ markdown: "Historical body" }));
  });

  it("a restored local mirror failure does not reject an accepted restore", async () => {
    const h = harness(); vi.mocked(api).mockResolvedValueOnce({ ...note, markdown: "Historical body" });
    vi.mocked(db.upsertNode).mockRejectedValueOnce(new Error("quota"));
    await expect(makeNoteHistoryWriter(h.ctx).restoreVersion("n", "v1", { restoreTitle: false })).resolves.toMatchObject({ markdown: "Historical body" });
    expect(h.ctx.addToast).toHaveBeenCalledWith(expect.stringContaining("change is saved"), "error");
  });

  it("an undelete refresh failure stays an accepted write", async () => {
    const h = harness(); vi.mocked(api).mockResolvedValue({ undeleted: true }); vi.mocked(h.ctx.refresh).mockRejectedValue(new Error("read failed"));
    expect((await makeNoteHistoryWriter(h.ctx).undelete("n")).status).toBe("synced");
    expect(h.ctx.addToast).toHaveBeenCalledWith(expect.stringContaining("Refresh"), "info");
  });

  it("partial extraction returns the created note and explains the rejected tag", async () => {
    const h = harness();
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/nodes") return { ...note, ...JSON.parse(init!.body as string) };
      throw new ApiError(403, "Tag is restricted");
    });
    const result = await makeNodeMutations(h.ctx).extractToEntity("Concept", "class");
    expect(result?.title).toBe("Concept");
    expect(h.get().nodes).toContainEqual(expect.objectContaining({ id: result!.id }));
    expect(result?.class_tag_ids ?? []).not.toContain("class");
    expect(h.ctx.addToast).toHaveBeenCalledWith(expect.stringContaining("note was created"), "info");
  });
});

beforeEach(() => { bindAccountStorage("unit-test-account", ""); });
