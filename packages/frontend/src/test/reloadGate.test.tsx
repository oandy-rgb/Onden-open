// @vitest-environment jsdom
// "Reload now" must only be blocked by text that lives ONLY in memory
// (lib/data/draftActions prepareEditorForReload). A refused save whose text
// sits in recovery survives a reload; a device without an offline copy has no
// queue to lose. Sign-out keeps the stricter prepareEditorForExit.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

const localDb = vi.hoisted(() => ({
  storeRejectedWrite: vi.fn(),
}));
vi.mock("../lib/api", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/api")>();
  return { ...mod, api: vi.fn(async () => ({})) };
});
vi.mock("../lib/localDb", () => ({
  storeRejectedWrite: localDb.storeRejectedWrite,
  getPendingWrites: vi.fn(async () => []),
  flushLocalDbSync: vi.fn(async () => {}),
  searchNodes: vi.fn(async () => []),
  upsertNode: vi.fn(async () => null),
  addPendingWrite: vi.fn(async () => null),
}));

import { api, ApiError, noWorkspaceData, type Bootstrap, type ContentNode } from "../lib/api";
import { useOverviewMode } from "../hooks/useOverviewMode";
import { resetAppState, getAppState } from "../lib/appStore";
import { typeIntoDraft, prepareEditorForExit, prepareEditorForReload, __resetDraftStateForTests } from "../lib/data/draftActions";
import { setPending } from "../lib/data/syncStatus";
import { flushLocalDbSync } from "../lib/localDb";
import { setLocalCopy, _resetLocalCopyForTests } from "../lib/localCopyState";
import { bindAccountStorage } from "../lib/accountStorage";
import { saveInk } from "../lib/data";
import { emptyInkDocument } from "../lib/ink/types";
import { chunkReloadPage, reloadForNewVersion } from "../lib/lazyWithReload";
import { installStaleChunkReload } from "../lib/installStaleChunkReload";

const apiMock = vi.mocked(api);
const patches = () => apiMock.mock.calls.filter(([, init]) => init?.method === "PATCH");

const node = (id: string, markdown: string, title = `Node ${id}`): ContentNode => ({
  id, title, slug: `node-${id}`, markdown, source_type: "manual", node_type: "content",
});
const makeData = (): Bootstrap => ({ ...noWorkspaceData, nodes: [node("a", "# A\n\noriginal"), node("b", "# B\n\nother")] });

describe("the reload gate", () => {
  beforeEach(() => {
    bindAccountStorage("reload-gate-account", "");
    localStorage.clear();
    vi.mocked(flushLocalDbSync).mockReset().mockResolvedValue();
    localDb.storeRejectedWrite.mockReset().mockImplementation(async (request: object, rejection: string) => ({ ...request, id: Math.floor(Math.random() * 1e9), attempts: 0, rejection }));
    vi.useFakeTimers();
    apiMock.mockReset().mockResolvedValue({});
    _resetLocalCopyForTests();
    setPending(0);
    __resetDraftStateForTests();
    resetAppState({ data: makeData(), online: true, selectedId: "a" });
    renderHook(() => useOverviewMode({ setMode: vi.fn(), setNotesView: vi.fn() }));
  });
  afterEach(() => {
    __resetDraftStateForTests();
    resetAppState();
    _resetLocalCopyForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const type = (text: string) => act(() => { typeIntoDraft("a", { markdown: text }); });
  const refuse = async (text: string) => {
    apiMock.mockRejectedValue(new ApiError(403, "Denied"));
    type(text);
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(getAppState().saveStatus).toBe("rejected");
  };

  it("lets a reload through when the refused text sits in recovery, without sending it again", async () => {
    await refuse("refused but recovered");
    const sent = patches().length;
    let gate: Awaited<ReturnType<typeof prepareEditorForReload>> | undefined;
    await act(async () => { gate = await prepareEditorForReload(); });
    expect(gate).toEqual({ kind: "safe", recovered: ["Node a"] });
    expect(patches()).toHaveLength(sent);
    expect(getAppState().overviewDraft).toBe("refused but recovered");
  });

  it("sign-out still refuses to leave on that same refused text, and tries it again", async () => {
    await refuse("refused, then signing out");
    const sent = patches().length;
    await act(async () => { expect(await prepareEditorForExit()).toBe(false); });
    expect(patches().length).toBe(sent + 1);
  });

  it("does not block when the device has no offline copy and every save was accepted", async () => {
    setLocalCopy("none");
    vi.mocked(flushLocalDbSync).mockRejectedValue(new Error("This device has no local copy"));
    type("accepted by the server");
    let gate: Awaited<ReturnType<typeof prepareEditorForReload>> | undefined;
    await act(async () => { gate = await prepareEditorForReload(); });
    expect(gate).toEqual({ kind: "safe", recovered: [] });
    expect(patches()).toHaveLength(1);
    expect(flushLocalDbSync).not.toHaveBeenCalled();
  });

  it("does not block while the local copy restarts and nothing waits in its queue", async () => {
    setLocalCopy("restarting");
    vi.mocked(flushLocalDbSync).mockRejectedValue(new Error("localDb flushLocalDbSync timed out"));
    await act(async () => { expect(await prepareEditorForReload()).toEqual({ kind: "safe", recovered: [] }); });
  });

  it("blocks when the local copy does not answer while changes wait in its queue", async () => {
    vi.mocked(flushLocalDbSync).mockRejectedValue(new Error("disk full"));
    setPending(2);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await act(async () => { expect(await prepareEditorForReload()).toEqual({ kind: "local-queue", waiting: 2 }); });
    expect(warn).toHaveBeenCalled();
  });

  it("blocks and names the note when refused text is in neither recovery nor the queue", async () => {
    localDb.storeRejectedWrite.mockRejectedValue(new Error("no space"));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await refuse("only in memory");
    let gate: Awaited<ReturnType<typeof prepareEditorForReload>> | undefined;
    await act(async () => { gate = await prepareEditorForReload(); });
    expect(gate).toEqual({ kind: "memory-only", notes: [{ title: "Node a", text: "only in memory" }] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("only in memory"), { noteId: "a" });
  });

  it("is not a verdict while the person is still typing", async () => {
    let commit!: () => void;
    vi.mocked(flushLocalDbSync).mockImplementationOnce(() => new Promise<void>((resolve) => { commit = resolve; }));
    type("first");
    let gate: Awaited<ReturnType<typeof prepareEditorForReload>> | undefined;
    const preparing = prepareEditorForReload().then((g) => { gate = g; });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    type("first, and more");
    await act(async () => { commit(); await preparing; });
    expect(gate).toEqual({ kind: "typing" });
  });

  // The report: a PDF / handwriting note is open, nobody is typing, and the
  // reload is still refused. Neither surface touches the text draft (the text
  // editor is not mounted there), and a drawing is saved by saveInk, a
  // background write outside the draft's saves — so a refused drawing must
  // neither dirty the draft nor block a reload or a sign-out.
  it("an open PDF/handwriting note that nobody typed in does not block, even when its drawing is refused", async () => {
    apiMock.mockRejectedValue(new ApiError(413, "Too large"));
    saveInk("a", emptyInkDocument());
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(patches()).toHaveLength(0);
    await act(async () => { expect(await prepareEditorForReload()).toMatchObject({ kind: "safe" }); });
    await act(async () => { expect(await prepareEditorForExit()).toBe(true); });
  });

  // 2026-10-29 phone: after a deploy the page's code-split files are gone, so a
  // reload-time import() of the data layer resolved empty and every 「有新版，
  // 重新載入」 ended in "couldn't confirm". The gate is registered when the data
  // layer loads; the boot wiring must not replace it.
  it("the new-version reload asks the draft gate itself, without fetching any file", async () => {
    installStaleChunkReload();
    const reload = vi.spyOn(chunkReloadPage, "reload").mockImplementation(() => {});
    type("typed just before the reload");
    let verdict: Awaited<ReturnType<typeof reloadForNewVersion>> | undefined;
    await act(async () => { verdict = await reloadForNewVersion(); });
    expect(verdict).toEqual({ kind: "safe", recovered: [] });
    expect(patches()).toHaveLength(1);
    expect(reload).toHaveBeenCalledOnce();
  });
});
