// The note save path must never lose or overwrite text (data-integrity review
// 2026-10-24: #1 switch away and back mid-save, #2 page exit behind a save in
// flight, #11 title sent with every body save, #12 refused saves re-sent,
// #15 the open note evicted from the body cache).
import { bindAccountStorage, accountStorageKey } from "../lib/accountStorage";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/api")>();
  return { ...mod, api: vi.fn(async () => ({})) };
});
vi.mock("../lib/localDb", () => ({
  storeRejectedWrite: async (request: import("../lib/localDb").RejectedRequest, rejection: string) => ({ ...request, id: 901, attempts: 0, rejection }),
  getPendingWrites: vi.fn(async () => []),
  flushLocalDbSync: vi.fn(async () => {}),
  searchNodes: vi.fn(async () => []),
  upsertNode: vi.fn(async () => null),
  addPendingWrite: vi.fn(async () => null),
}));

import { api, ApiError, type Bootstrap, type ContentNode } from "../lib/api";
import { useOverviewMode } from "../hooks/useOverviewMode";
import { resetAppState, setSelectedId, getAppState } from "../lib/appStore";
import { typeIntoDraft, flushPendingSave, isBodyInUse, __resetDraftStateForTests } from "../lib/data/draftActions";
import { addPendingWrite, upsertNode, flushLocalDbSync } from "../lib/localDb";
import { ownerData } from "./ownerData";

const apiMock = vi.mocked(api);
const node = (id: string, markdown: string): ContentNode => ({
  id, title: `Node ${id}`, slug: `node-${id}`, markdown, source_type: "manual", node_type: "content",
});
const makeData = (): Bootstrap => ({ ...ownerData, nodes: [node("a", "base one"), node("b", "other")] });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const patchesTo = (id: string) => apiMock.mock.calls.filter(([path]) => path === `/api/nodes/${id}`);
const bodyOf = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string) as { markdown?: string; title?: string; base_markdown?: string };

describe("note save path never loses text", () => {
  beforeEach(() => {
    bindAccountStorage("unit-test-account", "");
    localStorage.clear();
    vi.mocked(flushLocalDbSync).mockReset().mockResolvedValue();
    vi.useFakeTimers();
    apiMock.mockReset().mockResolvedValue({});
    vi.mocked(addPendingWrite).mockReset().mockResolvedValue(null as never);
    vi.mocked(upsertNode).mockReset().mockResolvedValue();
    __resetDraftStateForTests();
    resetAppState({ data: makeData(), online: true, selectedId: "a" });
  });
  afterEach(() => {
    __resetDraftStateForTests();
    resetAppState();
    vi.useRealTimers();
  });
  const setup = () => renderHook(() => useOverviewMode({ setMode: vi.fn(), setNotesView: vi.fn() }));
  const type = (text: string, extra: { title?: string } = {}) => act(() => { typeIntoDraft(getAppState().selectedId!, { markdown: text, ...extra }); });

  it("#1 switching to another note and back mid-save keeps the typed text, and the next save does not delete it", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    apiMock.mockImplementation((async (path: string) => {
      if (path !== "/api/nodes/a") return {};
      return patchesTo("a").length === 1 ? first.promise : second.promise;
    }) as unknown as typeof api);
    setup();

    type("base one");
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); }); // first save in flight
    type("base one two");
    act(() => { setSelectedId("b"); });                                  // flushes the second behind the first
    act(() => { setSelectedId("a"); });                                  // back while both are unsettled
    expect(getAppState().overviewDraft).toBe("base one two");

    await act(async () => { first.resolve({ ...node("a", "base one"), title: "Node a" }); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    second.resolve({ ...node("a", "base one two"), title: "Node a" });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(getAppState().overviewDraft).toBe("base one two");

    type("base one two!");
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    const last = bodyOf(patchesTo("a").at(-1)!);
    expect(last.markdown).toBe("base one two!");
    expect(last.base_markdown).toBe("base one two"); // the text the server holds, so " two" is not read as deleted
  });

  it("#2 a page-exit save is handed to the writer and protected at once, not after the save in flight", async () => {
    const first = deferred<unknown>();
    apiMock.mockImplementation((async (path: string) =>
      path === "/api/nodes/a" && patchesTo("a").length === 1 ? first.promise : {}) as unknown as typeof api);
    setup();
    type("base one first");
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(patchesTo("a")).toHaveLength(1);

    type("base one first newest");
    act(() => { void flushPendingSave({ keepalive: true }); });
    // Synchronously: the writer has it and kept it for recovery (the write
    // lane sends it after the save in flight), based on that save's text.
    const kept = JSON.parse(localStorage.getItem(accountStorageKey("onden.lostWrites")) ?? "[]") as Array<{ body: string; init?: { keepalive?: boolean } }>;
    expect(kept, "the page-exit text was not handed to the writer before the previous save settled").toHaveLength(1);
    expect(JSON.parse(kept[0]!.body)).toMatchObject({ markdown: "base one first newest", base_markdown: "base one first" });
    first.resolve({});
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  });

  it("#11 a body autosave does not send a title the draft still shares with its base", async () => {
    setup();
    type("base one more");
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(bodyOf(patchesTo("a")[0]!)).not.toHaveProperty("title");

    type("base one more", { title: "Renamed here" });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(bodyOf(patchesTo("a")[1]!).title).toBe("Renamed here");
  });

  it("a body typed while the title field is empty is saved without the empty title", async () => {
    setup();
    type("pasted before a title", { title: "" });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    const body = bodyOf(patchesTo("a")[0]!);
    expect(body).not.toHaveProperty("title");
    expect(body.markdown).toBe("pasted before a title");

    type("pasted before a title", { title: "Named later" });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(bodyOf(patchesTo("a")[1]!).title).toBe("Named later");
  });

  it("#12 a refused autosave is not sent again on a node switch or pagehide", async () => {
    apiMock.mockImplementation((async (path: string) => {
      if (path === "/api/nodes/a") throw new ApiError(403, "forbidden");
      return {};
    }) as unknown as typeof api);
    setup();
    type("base one refused");
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(patchesTo("a")).toHaveLength(1);
    expect(getAppState().saveStatus).toBe("rejected");

    await act(async () => { window.dispatchEvent(new Event("pagehide")); await Promise.resolve(); });
    act(() => { setSelectedId("b"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(patchesTo("a")).toHaveLength(1);
    // The refused input does not keep the next note "dirty": it still follows the server.
    expect(getAppState().overviewDraft).toBe("other");
  });

  it("#12 an explicit save retries the refused text", async () => {
    let refuse = true;
    apiMock.mockImplementation((async (path: string) => {
      if (path === "/api/nodes/a" && refuse) throw new ApiError(403, "forbidden");
      return {};
    }) as unknown as typeof api);
    setup();
    type("base one retry me");
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    refuse = false;
    const { saveDraft } = await import("../lib/data/draftActions");
    await act(async () => { await saveDraft("a"); });
    expect(patchesTo("a")).toHaveLength(2);
    expect(getAppState().saveStatus).toBe("saved");
  });

  it("#15 the body-cache eviction skips the open note (full eviction case: useAppDataLru.test.tsx)", () => {
    setup();
    expect(isBodyInUse("a")).toBe(true);
    expect(isBodyInUse("b")).toBe(false);
  });
});
