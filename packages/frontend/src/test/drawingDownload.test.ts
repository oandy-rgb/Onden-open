// The offline drawing download (syncEngine downloadDrawingsForOffline): a lean
// bootstrap leaves drawing values out, so when idle, online, visible and not
// on Save-Data the device fetches the ones it has no copy of, in small
// batches, and stops when it goes offline or hidden.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hashText, makePatch } from "@onden/markdown";

const local = vi.hoisted(() => ({
  planDrawings: vi.fn(async (pairs: Array<{ node_id: string }>) => ({ missing: [...new Set(pairs.map((p) => p.node_id))], stale: [] as Array<{ node_id: string; key: string; localHash: string }> })),
  fillAttributeRows: vi.fn(async (rows: unknown[]) => rows.length),
  replaceStaleAttributeRows: vi.fn(async (rows: unknown[]) => rows.length),
  getNodeAttribute: vi.fn(async (_id: string, _key: string): Promise<string | null> => null),
}));
vi.mock("../lib/localDb", async (original) => ({ ...await original<typeof import("../lib/localDb")>(), ...local }));
const apiMock = vi.fn();
vi.mock("../lib/api", async (orig) => ({ ...await orig<typeof import("../lib/api")>(), api: (...a: unknown[]) => apiMock(...a) }));

// Fresh module state per test (the download remembers a finished pass).
let downloadDrawingsForOffline: typeof import("../lib/data/syncEngine").downloadDrawingsForOffline;
let setOnline: typeof import("../lib/appStore").setOnline;

const drawingsOf = (ids: string[]) => ids.map((id) => ({ node_id: id, key: "ink_data", value: `strokes of ${id}`, value_type: "text", is_inheritable: false, source: "explicit" }));
let index: Array<{ node_id: string; key: string; size: number }>;
let onPost: ((ids: string[]) => void) | null;
let visibility: DocumentVisibilityState;

beforeEach(async () => {
  vi.resetModules();
  ({ downloadDrawingsForOffline } = await import("../lib/data/syncEngine"));
  const store = await import("../lib/appStore");
  setOnline = store.setOnline;
  store.resetAppState(); setOnline(true);
  apiMock.mockReset(); local.planDrawings.mockClear(); local.fillAttributeRows.mockClear(); local.replaceStaleAttributeRows.mockClear();
  onPost = null; visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  (globalThis as Record<string, unknown>).requestIdleCallback = (cb: () => void) => { queueMicrotask(cb); return 1; };
  index = Array.from({ length: 25 }, (_, i) => ({ node_id: `n${i}`, key: "ink_data", size: 1000 }));
  apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path !== "/api/sync/drawings") throw new Error("unexpected " + path);
    if (init?.method !== "POST") return { drawings: index };
    const ids = (JSON.parse(String(init.body)) as { ids: string[] }).ids;
    onPost?.(ids);
    return { drawings: drawingsOf(ids) };
  });
});
afterEach(() => { vi.restoreAllMocks(); });

const bodies = () => apiMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST").map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { ids: string[]; have?: Record<string, string> });
const posts = () => apiMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST").map(([, init]) => JSON.parse(String((init as RequestInit).body)).ids as string[]);

describe("downloadDrawingsForOffline", () => {
  it("fetches only the drawings this device lacks, in small batches, and keeps them as local copies", async () => {
    local.planDrawings.mockImplementationOnce(async () => ({ missing: index.slice(3).map((d) => d.node_id), stale: [] })); // n0–n2 already here
    await downloadDrawingsForOffline();
    const batches = posts();
    expect(batches.flat()).toEqual(index.slice(3).map((d) => d.node_id));
    expect(Math.max(...batches.map((b) => b.length))).toBeLessThanOrEqual(10);
    expect(local.fillAttributeRows).toHaveBeenCalledTimes(batches.length);
    // Done: a second pass asks nothing.
    apiMock.mockClear();
    await downloadDrawingsForOffline();
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("keeps big drawings to a few per request", async () => {
    index = index.slice(0, 4).map((d) => ({ ...d, size: 400 * 1024 }));
    await downloadDrawingsForOffline();
    expect(posts()).toEqual([["n0"], ["n1"], ["n2"], ["n3"]]);
  });

  it("stops when the connection drops, and when the tab is hidden", async () => {
    onPost = () => setOnline(false);
    await downloadDrawingsForOffline();
    expect(posts()).toHaveLength(1);

    setOnline(true); apiMock.mockClear(); onPost = () => { visibility = "hidden"; };
    await downloadDrawingsForOffline();
    expect(posts()).toHaveLength(1);
  });

  it("does nothing hidden, offline or on Save-Data — unless forced (the folder export)", async () => {
    visibility = "hidden";
    await downloadDrawingsForOffline();
    expect(apiMock).not.toHaveBeenCalled();
    visibility = "visible";
    Object.defineProperty(navigator, "connection", { value: { saveData: true }, configurable: true });
    await downloadDrawingsForOffline();
    expect(apiMock).not.toHaveBeenCalled();
    await downloadDrawingsForOffline({ force: true });
    expect(posts().flat()).toHaveLength(25);
    Object.defineProperty(navigator, "connection", { value: undefined, configurable: true });
  });

  it("replaces a stale copy only through the guarded path, with the hash it was planned with", async () => {
    index = [{ node_id: "n0", key: "ink_data", size: 10 }, { node_id: "n1", key: "ink_data", size: 10 }];
    local.planDrawings.mockImplementationOnce(async () => ({ missing: ["n1"], stale: [{ node_id: "n0", key: "ink_data", localHash: "old-hash" }] }));
    expect(await downloadDrawingsForOffline()).toEqual({ complete: true, missing: 0 });
    expect(local.fillAttributeRows).toHaveBeenCalledWith([expect.objectContaining({ node_id: "n1" })]);
    expect(local.replaceStaleAttributeRows).toHaveBeenCalledWith([expect.objectContaining({ node_id: "n0", expected_hash: "old-hash" })]);
  });

  it("a forced call during a background pass that stops early runs a forced pass of its own", async () => {
    onPost = () => { visibility = "hidden"; };
    const background = downloadDrawingsForOffline();
    const forced = downloadDrawingsForOffline({ force: true });
    expect(await background).toMatchObject({ complete: false });
    expect(await forced).toEqual({ complete: true, missing: 0 });
    expect(posts().flat()).toEqual(expect.arrayContaining(index.map((d) => d.node_id)));
  });

  it("forced while offline: nothing fetched, and it says how many are missing (from the last list read)", async () => {
    onPost = () => setOnline(false);
    await downloadDrawingsForOffline(); // read the list, then went offline
    local.planDrawings.mockImplementationOnce(async () => ({ missing: ["n1", "n2"], stale: [] }));
    apiMock.mockClear();
    expect(await downloadDrawingsForOffline({ force: true })).toEqual({ complete: false, missing: 2 });
    expect(apiMock).not.toHaveBeenCalled();
  });

  it("forced before any list was read and offline: missing is unknown", async () => {
    setOnline(false);
    expect(await downloadDrawingsForOffline({ force: true })).toEqual({ complete: false, missing: null });
  });

  describe("a drawing this device holds an older copy of", () => {
    const OLD = JSON.stringify({ strokes: Array.from({ length: 300 }, (_, i) => `stroke ${i}`) });
    const NEW = JSON.stringify({ strokes: Array.from({ length: 301 }, (_, i) => `stroke ${i}`) });
    beforeEach(() => {
      index = [{ node_id: "n0", key: "ink_data", size: NEW.length }];
      local.planDrawings.mockImplementationOnce(async () => ({ missing: [], stale: [{ node_id: "n0", key: "ink_data", localHash: hashText(OLD) }] }));
      local.getNodeAttribute.mockImplementation(async () => OLD);
    });

    it("asks for the change from its copy and applies the patch to it", async () => {
      apiMock.mockImplementation(async (_path: string, init?: RequestInit) => init?.method !== "POST" ? { drawings: index }
        : { drawings: [{ node_id: "n0", key: "ink_data", value_patch: makePatch(OLD, NEW), value_type: "text", is_inheritable: false, source: "explicit" }] });
      await downloadDrawingsForOffline();
      expect(bodies()).toEqual([{ ids: ["n0"], have: { "n0:ink_data": hashText(OLD) } }]);
      expect(local.replaceStaleAttributeRows).toHaveBeenCalledWith([expect.objectContaining({ node_id: "n0", value: NEW, expected_hash: hashText(OLD) })]);
    });

    it("asks again, whole, when the patch does not fit the copy as it is now", async () => {
      local.getNodeAttribute.mockImplementation(async () => OLD + " changed meanwhile");
      apiMock.mockImplementation(async (_path: string, init?: RequestInit) => {
        if (init?.method !== "POST") return { drawings: index };
        const body = JSON.parse(String(init.body)) as { have?: unknown };
        return { drawings: body.have
          ? [{ node_id: "n0", key: "ink_data", value_patch: makePatch(OLD, NEW), value_type: "text", is_inheritable: false, source: "explicit" }]
          : [{ node_id: "n0", key: "ink_data", value: NEW, value_type: "text", is_inheritable: false, source: "explicit" }] };
      });
      await downloadDrawingsForOffline();
      expect(bodies().map((b) => Boolean(b.have))).toEqual([true, false]);
      expect(local.replaceStaleAttributeRows).toHaveBeenCalledWith([expect.objectContaining({ value: NEW })]);
    });

    it("a drawing it has no copy of is asked for without `have`", async () => {
      local.planDrawings.mockReset();
      local.planDrawings.mockImplementationOnce(async () => ({ missing: ["n0"], stale: [] }));
      await downloadDrawingsForOffline();
      expect(bodies()).toEqual([{ ids: ["n0"] }]);
    });
  });
});
