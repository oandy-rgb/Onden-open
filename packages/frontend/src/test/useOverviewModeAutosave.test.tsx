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

import { api, ApiError, noWorkspaceData, type Bootstrap, type ContentNode } from "../lib/api";
import { useOverviewMode } from "../hooks/useOverviewMode";
import { resetAppState, setSelectedId, getAppState, setData } from "../lib/appStore";
import { typeIntoDraft, restoreOverviewDraft, prepareEditorForExit, editNoteText, saveNoteBody, beginBodyRewrite, __resetDraftStateForTests } from "../lib/data/draftActions";
import { addPendingWrite, upsertNode, flushLocalDbSync } from "../lib/localDb";

const apiMock = vi.mocked(api);
const addPendingWriteMock = vi.mocked(addPendingWrite);

const node = (id: string, markdown: string): ContentNode => ({
  id, title: `Node ${id}`, slug: `node-${id}`, markdown, source_type: "manual", node_type: "content",
});

function makeData(): Bootstrap {
  return { ...noWorkspaceData, nodes: [node("a", "# A\n\noriginal"), node("b", "# B\n\nother")] };
}

// The three silent-loss windows for an in-flight (debounced) edit:
//   1. switching nodes before the 1.5s autosave fires
//   2. the page going away (pagehide / hidden)
//   3. (regression) the autosave path must carry base_markdown for 3-way merge
// H4: draft state + the flush machinery live in the app store / draftActions —
// the test drives them the way the editor host does (typeIntoDraft), with
// selection moved via the store instead of a hook prop.
describe("overview draft autosave reliability", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(flushLocalDbSync).mockReset().mockResolvedValue();
    vi.useFakeTimers();
    apiMock.mockClear();
    apiMock.mockResolvedValue({});
    addPendingWriteMock.mockClear();
    addPendingWriteMock.mockResolvedValue(null as never);
    vi.mocked(upsertNode).mockReset().mockResolvedValue();
    __resetDraftStateForTests();
    resetAppState({ data: makeData(), online: true, selectedId: "a" });
  });
  afterEach(() => {
    __resetDraftStateForTests();
    resetAppState();
    vi.useRealTimers();
  });

  function setup() {
    return renderHook(() =>
      useOverviewMode({ setMode: vi.fn(), setNotesView: vi.fn() }),
    );
  }

  function typeInto(text: string) {
    act(() => {
      typeIntoDraft(getAppState().selectedId!, { markdown: text });
    });
  }

  it("a removed selection cannot switch the inspector or a late edit to another note", async () => {
    const { result } = setup();
    apiMock.mockClear();
    act(() => { setData({ ...makeData(), nodes: [node("b", "# B\n\nother")] }); });
    expect(result.current.overviewSelectedNode).toBeNull();
    expect(getAppState().overviewDraft).toBe("");
    typeInto("late input belonging to missing a");
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(apiMock.mock.calls.filter(([path]) => path.startsWith("/api/nodes/b"))).toEqual([]);
    expect(getAppState().data.nodes[0].markdown).toBe("# B\n\nother");

    // A temporarily missing deep-link target can still arrive later. Keeping
    // its requested ID is different from silently choosing the first note.
    act(() => { setData(makeData()); });
    expect(result.current.overviewSelectedNode?.id).toBe("a");
    expect(getAppState().overviewDraft).toBe("# A\n\noriginal");
  });

  it("switching nodes flushes the pending edit of the PREVIOUS node (with base_markdown)", async () => {
    setup();
    typeInto("# A\n\nedited but not yet autosaved");

    // switch before the 1.5s debounce fires
    act(() => { setSelectedId("b"); });
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    const patch = apiMock.mock.calls.find(([path]) => path === "/api/nodes/a");
    expect(patch, "the previous node's edit must be saved, not dropped").toBeTruthy();
    const body = JSON.parse((patch![1] as RequestInit).body as string);
    expect(body.markdown).toBe("# A\n\nedited but not yet autosaved");
    expect(body.base_markdown).toBe("# A\n\noriginal");
  });

  it("typing then going back to the list saves into the note that was open, never the first note", async () => {
    // "a" sorts first; open "b", type, then clear the selection like the phone's back key.
    setup();
    act(() => { setSelectedId("b"); });
    typeInto("# B\n\ntyped just before back");
    act(() => { setSelectedId(null); });
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });

    const patches = apiMock.mock.calls.filter(([path, init]) => String(path).startsWith("/api/nodes/") && (init as RequestInit | undefined)?.method === "PATCH");
    expect(patches.map(([path]) => path)).toEqual(["/api/nodes/b"]);
    expect(JSON.parse((patches[0][1] as RequestInit).body as string).markdown).toBe("# B\n\ntyped just before back");
    expect(getAppState().data.nodes.find((n) => n.id === "a")?.markdown).toBe("# A\n\noriginal");
    expect(getAppState().overviewDraft).toBe("");
  });

  it("pagehide flushes the pending edit with keepalive", async () => {
    setup();
    typeInto("# A\n\ntyped right before closing the tab");

    await act(async () => {
      window.dispatchEvent(new Event("pagehide"));
      await Promise.resolve();
    });

    const patch = apiMock.mock.calls.find(([path]) => path === "/api/nodes/a");
    expect(patch, "closing the tab must not lose the debounce window").toBeTruthy();
    expect((patch![1] as RequestInit & { keepalive?: boolean }).keepalive).toBe(true);
  });

  it("the debounced autosave itself sends base_markdown (three-way merge protection)", async () => {
    setup();
    typeInto("# A\n\nplain autosave");

    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });

    const patch = apiMock.mock.calls.find(([path]) => path === "/api/nodes/a");
    expect(patch).toBeTruthy();
    const body = JSON.parse((patch![1] as RequestInit).body as string);
    expect(body.base_markdown).toBe("# A\n\noriginal");
  });

  // GAP-186: another writer's newer body reaches the store (sync/SSE) while
  // this note is open. A clean editor shows it; a later edit must merge on top
  // of the text the draft came from, never send the newer store row as base.
  const remote = (markdown: string) => act(() => {
    setData({ ...getAppState().data, nodes: getAppState().data.nodes.map((n) => n.id === "a" ? { ...n, markdown } : n) });
  });

  it("a clean editor shows another writer's newer body (GAP-186)", () => {
    setup();
    remote("# A\n\noriginal\nline3 B");
    expect(getAppState().overviewDraft).toBe("# A\n\noriginal\nline3 B");
    expect(getAppState().saveStatus).toBe("saved");
    expect(apiMock.mock.calls.filter(([path]) => path === "/api/nodes/a")).toEqual([]);
  });

  it("an edit after a remote change merges from the shown text, keeping the other writer's line (GAP-186)", async () => {
    setup();
    remote("# A\n\noriginal\nline3 B");
    // The user edits what the editor now shows (with the other writer's line).
    typeInto(getAppState().overviewDraft.replace("# A", "# A edited"));
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    const body = JSON.parse((apiMock.mock.calls.find(([path]) => path === "/api/nodes/a")![1] as RequestInit).body as string);
    expect(body.base_markdown).toBe("# A\n\noriginal\nline3 B");
    expect(body.markdown).toContain("line3 B");
  });

  it("unsaved input is kept when a remote body arrives, and its save uses the pre-remote base (GAP-186)", async () => {
    setup();
    typeInto("# A\n\noriginal\nmine");
    remote("# A\n\noriginal\nline3 B");
    expect(getAppState().overviewDraft).toBe("# A\n\noriginal\nmine");
    typeInto("# A\n\noriginal\nmine more"); // the snapshot is taken after the remote row landed
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    const body = JSON.parse((apiMock.mock.calls.find(([path]) => path === "/api/nodes/a")![1] as RequestInit).body as string);
    // Old base → the server three-way merge sees "line3 B" as theirs, not as deleted by us.
    expect(body.base_markdown).toBe("# A\n\noriginal");
  });

  it("after a save, the next save's base is what was sent, not the store row (GAP-186)", async () => {
    setup();
    typeInto("# A\n\nfirst");
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    apiMock.mockClear();
    typeInto("# A\n\nfirst second");
    remote("# A\n\nfirst\nline3 B"); // arrives while dirty: kept out of the draft
    typeInto("# A\n\nfirst second third");
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    const body = JSON.parse((apiMock.mock.calls.find(([path]) => path === "/api/nodes/a")![1] as RequestInit).body as string);
    expect(body.base_markdown).toBe("# A\n\nfirst");
  });

  it("a stale /versions response for the previous node doesn't overwrite the current node's history (M13)", async () => {
    let resolveA: ((v: unknown) => void) | null = null;
    let resolveB: ((v: unknown) => void) | null = null;
    const ver = (id: string) => [{ id, title: "", markdown: "", changed_at: "", actor_name: null, actor_type: null }];
    apiMock.mockImplementation(((path: string) => {
      if (path === "/api/nodes/a/versions") return new Promise((r) => { resolveA = r; });
      if (path === "/api/nodes/b/versions") return new Promise((r) => { resolveB = r; });
      return Promise.resolve({});
    }) as unknown as typeof api);

    const { result } = setup(); // selectedId "a" → a/versions in flight
    await act(async () => { await Promise.resolve(); });
    act(() => { setSelectedId("b"); }); // switch → b/versions in flight, a's effect cleaned up
    await act(async () => { await Promise.resolve(); });

    await act(async () => { resolveB?.(ver("vb")); await Promise.resolve(); });
    expect(result.current.nodeVersions.map((v) => v.id)).toEqual(["vb"]);

    // The STALE node-a response now resolves — it must be ignored.
    await act(async () => { resolveA?.(ver("va")); await Promise.resolve(); });
    expect(result.current.nodeVersions.map((v) => v.id)).toEqual(["vb"]);
  });

  // MEDIUM gap #5: a debounced autosave that the server REJECTS (4xx) used to
  // be papered over as "saved" and then the offline drain silently dropped it —
  // on reload the content vanished. The flush must now surface the reject and
  // must NOT queue a write the drain would discard.
  it("a 4xx reject during autosave does NOT show 'saved' and does NOT queue", async () => {
    setup();
    apiMock.mockRejectedValueOnce(new ApiError(403, JSON.stringify({ error: "forbidden", detail: "no write permission" })));
    typeInto("# A\n\nedit the server will refuse");

    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });

    // the PATCH was attempted...
    expect(apiMock.mock.calls.find(([path]) => path === "/api/nodes/a")).toBeTruthy();
    // ...and the result is an HONEST error state, never the lie "saved".
    expect(getAppState().saveStatus).toBe("rejected");
    // the recovery entry (not a second toast) told the user
    expect(getAppState().toasts.some((tt) => tt.kind === "error")).toBe(false);
    // and the terminal reject was NOT queued (the drain would silently drop it)
    expect(addPendingWriteMock).not.toHaveBeenCalled();
  });

  it("retains both title and body after a name conflict and saves them after correction", async () => {
    setup();
    apiMock.mockRejectedValueOnce(new ApiError(409, JSON.stringify({ error: "tag_name_conflict" })));
    act(() => { typeIntoDraft(getAppState().selectedId!, { title: "Occupied", markdown: "Keep this body" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(getAppState()).toMatchObject({ overviewTitleDraft: "Occupied", overviewDraft: "Keep this body", saveStatus: "rejected" });
    expect(addPendingWriteMock).not.toHaveBeenCalled();
    expect(getAppState().data.nodes.find(n => n.id === "a")).toMatchObject({ title: "Node a", markdown: "# A\n\noriginal" });
    apiMock.mockResolvedValueOnce({ ...node("a", "Keep this body"), title: "Available" });
    act(() => { typeIntoDraft(getAppState().selectedId!, { title: "Available" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(getAppState()).toMatchObject({ overviewTitleDraft: "Available", overviewDraft: "Keep this body", saveStatus: "saved" });
  });

  it("a transient (5xx) failure during autosave queues the write and shows the honest local-saved state", async () => {
    setup();
    apiMock.mockRejectedValueOnce(new ApiError(500, "internal"));
    typeInto("# A\n\nedit lost to a flaky server");

    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });

    expect(apiMock.mock.calls.find(([path]) => path === "/api/nodes/a")).toBeTruthy();
    // saved locally + queued for the reconnect drain: "queued", never "saved"
    expect(getAppState().saveStatus).toBe("queued");
    const queued = addPendingWriteMock.mock.calls.find(([, path]) => path === "/api/nodes/a");
    expect(queued, "a transient failure must be queued, not dropped").toBeTruthy();
  });

  it("a flush is a no-op when nothing is dirty (no phantom PATCH on mount/switch)", async () => {
    setup();
    act(() => { setSelectedId("b"); });
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    const patches = apiMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
    expect(patches.length).toBe(0);
  });

  it("keeps the offline autosave pending until durable storage commits", async () => {
    resetAppState({ data: makeData(), online: false, selectedId: "a" });
    setup();
    let commit!: () => void;
    addPendingWriteMock.mockImplementationOnce(() => new Promise<void>((resolve) => { commit = resolve; }));
    typeInto("Offline body");
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(getAppState().saveStatus).toBe("saving");
    await act(async () => { commit(); });
    expect(getAppState().saveStatus).toBe("queued");
  });

  it("keeps a recoverable draft and reports failure when offline persistence fails", async () => {
    resetAppState({ data: makeData(), online: false, selectedId: "a" });
    setup();
    addPendingWriteMock.mockRejectedValueOnce(new Error("quota full"));
    typeInto("Must not disappear");
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(getAppState().saveStatus).toBe("rejected");
    expect(getAppState().overviewDraft).toBe("Must not disappear");
    expect(localStorage.getItem(accountStorageKey("onden.lostWrites"))).toContain("Must not disappear");
    expect(getAppState().toasts.at(-1)?.message).toContain("recovery panel");
  });

  it("protects page-exit text synchronously before any worker operation resolves", async () => {
    setup();
    let finishMirror!: () => void;
    vi.mocked(upsertNode).mockReturnValueOnce(new Promise<void>((resolve) => { finishMirror = resolve; }));
    typeInto("Page-exit draft");
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
      expect(localStorage.getItem(accountStorageKey("onden.lostWrites"))).toContain("Page-exit draft");
    });
    const stored = JSON.parse(localStorage.getItem(accountStorageKey("onden.lostWrites"))!)[0];
    await act(async () => { finishMirror(); });
    const patch = apiMock.mock.calls.find(([path]) => path === "/api/nodes/a")!;
    expect(new Headers(patch[1]?.headers).get("Idempotency-Key")).toBe(stored.idemKey);
    expect(localStorage.getItem(accountStorageKey("onden.lostWrites"))).toBeNull();
  });

  // Scan finding #1: a save sent while the previous one was still in flight
  // carried the base captured at keystroke time (the text BEFORE the first
  // save), so the server's three-way merge re-applied the first save's text
  // and the note ended up with it twice.
  describe("text typed while a save is in flight", () => {
    const patches = () => apiMock.mock.calls.filter(([path, init]) => path === "/api/nodes/a" && init?.method === "PATCH");
    const sent = (i: number) => JSON.parse(patches()[i]![1]!.body as string) as { markdown: string; base_markdown: string };
    function holdFirstSave() {
      let release!: (saved: ContentNode) => void;
      apiMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve as typeof release; }));
      return (markdown: string) => release(node("a", markdown));
    }

    it("is saved on top of that save, so the server cannot duplicate it", async () => {
      setup();
      const releaseFirst = holdFirstSave();
      typeInto("# A\n\noriginal\nhello");
      await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
      typeInto("# A\n\noriginal\nhello world");
      await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
      expect(patches(), "the second save waits for the first").toHaveLength(1);

      await act(async () => { releaseFirst("# A\n\noriginal\nhello"); await vi.advanceTimersByTimeAsync(0); });
      expect(patches()).toHaveLength(2);
      expect(sent(0).base_markdown).toBe("# A\n\noriginal");
      expect(sent(1)).toMatchObject({ markdown: "# A\n\noriginal\nhello world", base_markdown: "# A\n\noriginal\nhello" });
    });

    it("still builds on that save after the editor moves to another note", async () => {
      setup();
      const releaseFirst = holdFirstSave();
      typeInto("# A\n\noriginal\nhello");
      await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
      typeInto("# A\n\noriginal\nhello world");
      act(() => { setSelectedId("b"); }); // flushes a's pending edit behind the first save
      await act(async () => { releaseFirst("# A\n\noriginal\nhello"); await vi.advanceTimersByTimeAsync(0); });
      expect(sent(1)).toMatchObject({ markdown: "# A\n\noriginal\nhello world", base_markdown: "# A\n\noriginal\nhello" });
    });

    it("an edit for a note the editor left is saved behind its earlier saves (editNoteText)", async () => {
      setup();
      const releaseFirst = holdFirstSave();
      typeInto("# A\n\noriginal\nhello");
      await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
      act(() => { setSelectedId("b"); });
      let result!: Promise<string>;
      act(() => { result = editNoteText("a", (body) => `${body}\n\n![photo](u)`); });
      expect(patches()).toHaveLength(1);
      await act(async () => { releaseFirst("# A\n\noriginal\nhello"); await vi.advanceTimersByTimeAsync(0); });
      expect(await result).toBe("applied");
      expect(sent(1)).toMatchObject({ markdown: "# A\n\noriginal\nhello\n\n![photo](u)", base_markdown: "# A\n\noriginal\nhello" });
      expect(getAppState().overviewDraft, "the open note b is untouched").toBe("# B\n\nother");
    });

    it("a canvas card's save waits for the note's save in flight and merges from the card's base", async () => {
      setup();
      const releaseFirst = holdFirstSave();
      typeInto("# A\n\noriginal\nhello");
      await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
      act(() => { setSelectedId("b"); });
      let saving!: Promise<void>;
      act(() => { saving = saveNoteBody("a", "# A\n\noriginal\ncard line", "# A\n\noriginal"); });
      expect(patches(), "the card save waits for the editor's save").toHaveLength(1);
      await act(async () => { releaseFirst("# A\n\noriginal\nhello"); await vi.advanceTimersByTimeAsync(0); });
      await saving;
      // The card's own base, so the server keeps the editor's "hello".
      expect(sent(1)).toMatchObject({ markdown: "# A\n\noriginal\ncard line", base_markdown: "# A\n\noriginal" });
      expect(getAppState().overviewDraft).toBe("# B\n\nother");
    });

    it("a card save for the open note shows the merged body in a clean editor, and keeps typed input", async () => {
      setup();
      apiMock.mockResolvedValueOnce(node("a", "# A\n\noriginal\ncard line"));
      await act(async () => { await saveNoteBody("a", "# A\n\noriginal\ncard line", "# A\n\noriginal"); });
      expect(getAppState().overviewDraft).toBe("# A\n\noriginal\ncard line");

      typeInto("# A\n\noriginal\ncard line\ntyped");
      apiMock.mockResolvedValueOnce(node("a", "# A\n\noriginal\ncard line\nsecond card"));
      await act(async () => { await saveNoteBody("a", "# A\n\noriginal\ncard line\nsecond card", "# A\n\noriginal\ncard line"); });
      expect(getAppState().overviewDraft, "typed input stays").toBe("# A\n\noriginal\ncard line\ntyped");
      expect(getAppState().saveStatus).toBe("unsaved");
    });

    it("typing tagged with a note the editor left never reaches the open note", async () => {
      setup();
      act(() => { setSelectedId("b"); });
      act(() => { typeIntoDraft("a", { markdown: "late keystroke for a" }); });
      expect(getAppState().overviewDraft).toBe("# B\n\nother");
      expect(getAppState().saveStatus).toBe("saved");
      await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
      expect(apiMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
    });

    it("a body rewrite that finishes after a note switch leaves the open note alone", async () => {
      setup();
      const rewrite = await beginBodyRewrite(getAppState().data.nodes[0]!);
      act(() => { setSelectedId("b"); });
      act(() => { rewrite!.adopt("# A\n\nrewritten"); });
      expect(getAppState().overviewDraft).toBe("# B\n\nother");
      expect(rewrite!.shown()).toBe(false);
    });

    it("a card save that lands while the editor's own save waits leaves that save's base alone (no lost lines)", async () => {
      setup();
      const releaseCard = holdFirstSave();
      typeInto("# A\n\noriginal\neditor line");
      let card!: Promise<void>;
      act(() => { card = saveNoteBody("a", "# A\n\noriginal\ncard line", "# A\n\noriginal"); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1600); }); // the editor's autosave waits behind the card
      expect(patches()).toHaveLength(1);
      apiMock.mockImplementation(async (_path, init) => node("a", JSON.parse((init as RequestInit).body as string).markdown));
      await act(async () => { releaseCard("# A\n\noriginal\ncard line"); await card; await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      // The editor's save still builds on the text it was typed onto, so the
      // server keeps the card's line instead of reading it as deleted.
      expect(sent(1)).toMatchObject({ markdown: "# A\n\noriginal\neditor line", base_markdown: "# A\n\noriginal" });
      expect(getAppState().overviewDraft).toContain("editor line");
    });

    it("the same holds when the user switches notes while the card save is in flight", async () => {
      setup();
      const releaseCard = holdFirstSave();
      typeInto("# A\n\noriginal\neditor line");
      let card!: Promise<void>;
      act(() => { card = saveNoteBody("a", "# A\n\noriginal\ncard line", "# A\n\noriginal"); });
      act(() => { setSelectedId("b"); }); // flushes a's edit behind the card save
      apiMock.mockImplementation(async (_path, init) => node("a", JSON.parse((init as RequestInit).body as string).markdown));
      await act(async () => { releaseCard("# A\n\noriginal\ncard line"); await card; await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(sent(1)).toMatchObject({ markdown: "# A\n\noriginal\neditor line", base_markdown: "# A\n\noriginal" });
    });

    it("a card's page-exit save behind the note's in-flight save is kept for exit at once", async () => {
      bindAccountStorage("unit-test-account", "");
      const releaseFirst = holdFirstSave();
      let first!: Promise<void>, exit!: Promise<void>;
      act(() => {
        first = saveNoteBody("a", "# A\n\noriginal\nfirst", "# A\n\noriginal");
        exit = saveNoteBody("a", "# A\n\noriginal\nfirst\nlast words", "# A\n\noriginal\nfirst", { keepalive: true });
      });
      // Synchronously, before the page could go away.
      expect(localStorage.getItem(accountStorageKey("onden.lostWrites")) ?? "").toContain("last words");
      await act(async () => { await vi.advanceTimersByTimeAsync(0); releaseFirst("# A\n\noriginal\nfirst"); await first; await exit; });
    });

    it("an edit for the open note goes into its draft and autosaves like typing", async () => {
      setup();
      let result!: Promise<string>;
      act(() => { result = editNoteText("a", (body) => `${body} [@key]`); });
      expect(await result).toBe("applied");
      expect(getAppState().overviewDraft).toBe("# A\n\noriginal [@key]");
      expect(getAppState().saveStatus).toBe("unsaved");
    });

    it("a page-exit save also builds on it", async () => {
      setup();
      const releaseFirst = holdFirstSave();
      typeInto("# A\n\noriginal\nhello");
      await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
      typeInto("# A\n\noriginal\nhello world");
      await act(async () => { window.dispatchEvent(new Event("pagehide")); await Promise.resolve(); });
      await act(async () => { releaseFirst("# A\n\noriginal\nhello"); await vi.advanceTimersByTimeAsync(0); });
      expect((patches()[1]![1] as RequestInit & { keepalive?: boolean }).keepalive).toBe(true);
      expect(sent(1).base_markdown).toBe("# A\n\noriginal\nhello");
    });
  });

  it("a late rejection does not replace a newer dirty draft or its save status", async () => {
    setup();
    let rejectFirst!: (error: unknown) => void;
    apiMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }));
    typeInto("First draft");
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    typeInto("Newer draft");
    await act(async () => { rejectFirst(new ApiError(422, "Rejected first draft")); });
    expect(getAppState().overviewDraft).toBe("Newer draft");
    expect(getAppState().saveStatus).toBe("unsaved");
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    const patches = apiMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(patches.at(-1)![1]!.body as string).markdown).toBe("Newer draft");
    expect(getAppState().saveStatus).toBe("saved");
  });

  it("shows and mirrors the server's merged body", async () => {
    setup();
    apiMock.mockResolvedValueOnce(node("a", "Merged body"));
    typeInto("My edit");
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(getAppState().overviewDraft).toBe("Merged body");
    expect(getAppState().data.nodes.find((n) => n.id === "a")?.markdown).toBe("Merged body");
    expect(upsertNode).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a", markdown: "Merged body" }));
  });

  it.each([false, true])("saves pre-restore text before restoring, including an already-started autosave (%s)", async (autosaveStarted) => {
    let acceptSave!: (value: ContentNode) => void;
    let acceptRestore!: (value: ContentNode) => void;
    apiMock.mockImplementation((async (_path, init) => init?.method === "PATCH"
      ? new Promise<ContentNode>((resolve) => { acceptSave = resolve; }) : []) as typeof api);
    const restoreFn = vi.fn(() => new Promise<ContentNode>((resolve) => { acceptRestore = resolve; }));
    setup();
    typeInto("Draft before clicking restore");
    if (autosaveStarted) await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    let restoring!: Promise<boolean>;
    act(() => { restoring = restoreOverviewDraft("a", restoreFn); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(restoreFn).not.toHaveBeenCalled();
    expect(apiMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    await act(async () => { acceptSave(node("a", "Draft before clicking restore")); });
    expect(restoreFn).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(apiMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    await act(async () => { acceptRestore(node("a", "Historical body")); await restoring; });
    expect(getAppState().overviewDraft).toBe("Historical body");
  });

  it("a restore that finishes after a note switch leaves the open note alone", async () => {
    let acceptRestore!: (value: ContentNode) => void;
    const restoreFn = vi.fn(() => new Promise<ContentNode>((resolve) => { acceptRestore = resolve; }));
    setup();
    let restoring!: Promise<boolean>;
    act(() => { restoring = restoreOverviewDraft("a", restoreFn); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    act(() => { setSelectedId("b"); });
    await act(async () => { acceptRestore(node("a", "Historical body")); await restoring; });
    expect(getAppState().overviewDraft).toBe("# B\n\nother");
    expect(getAppState().overviewTitleDraft).toBe("Node b");
  });

  it("retains a rejected pre-restore draft and never starts restore", async () => {
    const restoreFn = vi.fn(async () => node("a", "Historical body"));
    apiMock.mockImplementation((async (_path, init) => {
      if (init?.method === "PATCH") throw new ApiError(403, "No write permission");
      return [];
    }) as typeof api);
    setup();
    typeInto("Keep this rejected draft");
    await act(async () => { await restoreOverviewDraft("a", restoreFn); });
    expect(restoreFn).not.toHaveBeenCalled();
    expect(getAppState().overviewDraft).toBe("Keep this rejected draft");
    expect(getAppState().saveStatus).toBe("rejected");
  });

  it("cancels restore preparation if the user edits while the preceding save is pending", async () => {
    let acceptSave!: (value: ContentNode) => void;
    apiMock.mockImplementation((async (_path, init) => init?.method === "PATCH"
      ? new Promise<ContentNode>((resolve) => { acceptSave = resolve; }) : []) as typeof api);
    const restoreFn = vi.fn(async () => node("a", "Historical body"));
    setup();
    typeInto("Draft before clicking restore");
    let restoring!: Promise<boolean>;
    act(() => { restoring = restoreOverviewDraft("a", restoreFn); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    typeInto("New input while saving");
    await act(async () => { acceptSave(node("a", "Draft before clicking restore")); await restoring; });
    expect(restoreFn).not.toHaveBeenCalled();
    expect(getAppState().overviewDraft).toBe("New input while saving");
    expect(getAppState().saveStatus).toBe("unsaved");
  });

  it("preserves input typed while the restore request is pending and keeps its autosave", async () => {
    let acceptRestore!: (value: ContentNode) => void;
    const restoreFn = vi.fn(() => new Promise<ContentNode>((resolve) => { acceptRestore = resolve; }));
    setup();
    let restoring!: Promise<boolean>;
    act(() => { restoring = restoreOverviewDraft("a", restoreFn); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    typeInto("New input during restore");
    await act(async () => { acceptRestore(node("a", "Historical body")); await restoring; });
    expect(getAppState().overviewDraft).toBe("New input during restore");
    expect(getAppState().saveStatus).toBe("unsaved");
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    const patch = apiMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(patch![1]!.body as string).markdown).toBe("New input during restore");
  });

  it("refreshes stored versions after saving", async () => {
    const oldVersion = { id: "old-version", title: "Old", markdown: "Old body", changed_at: "2026-09-12T00:00:00Z", actor_name: null, actor_type: "user" };
    apiMock.mockResolvedValueOnce([oldVersion]);
    const { result } = setup();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    apiMock.mockResolvedValueOnce([{ ...oldVersion, id: "saved-version" }, oldVersion]);
    act(() => {
      setData((data) => ({ ...data, nodes: data.nodes.map((n) => n.id === "a" ? { ...n, updated_at: "2026-09-12T01:00:00Z" } : n) }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.nodeVersions.map((v) => v.id)).toEqual(["saved-version", "old-version"]);
  });

  it("does not flush or replace an unrelated note's pending draft", async () => {
    setup();
    typeInto("Keep A's pending draft");
    const restoreFn = vi.fn(async () => node("b", "B restored"));
    await act(async () => { expect(await restoreOverviewDraft("b", restoreFn)).toBe(true); });
    expect(restoreFn).toHaveBeenCalledOnce();
    expect(apiMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
    expect(getAppState().overviewDraft).toBe("Keep A's pending draft");
    expect(getAppState().saveStatus).toBe("unsaved");
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    const patch = apiMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(patch?.[0]).toBe("/api/nodes/a");
  });

  it("does not adopt a missing result after an acknowledged restore", async () => {
    setup();
    const restoreFn = vi.fn(async () => undefined);
    await act(async () => { await restoreOverviewDraft("a", restoreFn); });
    expect(getAppState().overviewDraft).toBe("# A\n\noriginal");
  });
  it("sign-out preparation waits for both queued input and the snapshot commit", async () => {
    setup(); typeInto("Unsaved input before sign-out");
    apiMock.mockRejectedValue(new ApiError(503, "offline"));
    let commit!: () => void;
    vi.mocked(flushLocalDbSync).mockImplementationOnce(() => new Promise(resolve => { commit = resolve; }));
    let ready = false;
    const preparing = prepareEditorForExit().then(result => { ready = result; });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(addPendingWriteMock).toHaveBeenCalled(); expect(ready).toBe(false);
    await act(async () => { commit(); await preparing; }); expect(ready).toBe(true);
  });

  it("does not authorize leaving after a refused save", async () => {
    setup(); typeInto("Keep refused input"); apiMock.mockRejectedValue(new ApiError(403, "Denied"));
    await act(async () => { expect(await prepareEditorForExit()).toBe(false); });
    expect(getAppState().overviewDraft).toBe("Keep refused input");
    expect(flushLocalDbSync).not.toHaveBeenCalled();
  });

  it("a failed local commit prevents leaving and retains the draft", async () => {
    setup(); typeInto("Keep the local draft");
    vi.mocked(flushLocalDbSync).mockRejectedValueOnce(new Error("disk full"));
    await act(async () => { await expect(prepareEditorForExit()).rejects.toMatchObject({ name: "WriteStorageError" }); });
    expect(getAppState().overviewDraft).toBe("Keep the local draft");
  });

  it("new input during exit preparation cancels leaving instead of discarding it", async () => {
    setup(); typeInto("First draft");
    let commit!: () => void;
    vi.mocked(flushLocalDbSync).mockImplementationOnce(() => new Promise(resolve => { commit = resolve; }));
    const preparing = prepareEditorForExit();
    const check = expect(preparing).rejects.toThrow("note changed");
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    typeInto("Newer draft");
    await act(async () => { commit(); await check; });
    expect(getAppState().overviewDraft).toBe("Newer draft");
  });

  it("waits for an earlier note's active save even after switching to a clean note", async () => {
    setup(); typeInto("Pending A");
    let finish!: () => void;
    apiMock.mockImplementation(path => path === "/api/nodes/a" ? new Promise(resolve => { finish = () => resolve({}); }) : Promise.resolve([]));
    act(() => setSelectedId("b"));
    let ready = false;
    const preparing = prepareEditorForExit().then(result => { ready = result; });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(ready).toBe(false); expect(flushLocalDbSync).not.toHaveBeenCalled();
    await act(async () => { finish(); await preparing; }); expect(ready).toBe(true);
  });

});

beforeEach(() => { bindAccountStorage("unit-test-account", ""); });
