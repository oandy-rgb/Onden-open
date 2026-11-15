import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
const mirror = new Map<string, string>();
const pending: Array<{ path: string }> = [];
const filled = vi.fn(async (_id: string, _rows: unknown[]) => {});
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), apiFetch: (...a: unknown[]) => fetchMock(...a) }));
vi.mock("../lib/localDb", async (original) => ({
  ...await original<typeof import("../lib/localDb")>(),
  getNodeAttribute: async (_id: string, key: string) => mirror.get(key) ?? null,
  getPendingWrites: async () => pending,
  fillNodeAttributes: (id: string, rows: unknown[]) => filled(id, rows),
}));
const { loadInkAttributes, loadInkPage, decodeInk } = await import("../lib/ink/store");
const { decodePdfInk } = await import("../lib/pdf/pdfAdapter");

const stroke = (id: string) => ({ id, points: [[0, 0], [10, 5, 0.5]], color: "#15130d", size: 4, toolId: "pen" });
const serverDoc = JSON.stringify({ version: 1, strokes: [stroke("old")] });
const offlineDoc = JSON.stringify({ version: 1, strokes: [stroke("old"), stroke("drawn-offline")] });

describe("loadInkAttributes", () => {
  beforeEach(() => {
    fetchMock.mockReset(); mirror.clear(); pending.length = 0; filled.mockClear();
    fetchMock.mockResolvedValue({ ok: true, json: async () => [{ key: "ink_data", value: serverDoc }] });
    mirror.set("ink_data", offlineDoc);
  });

  it("reads the local mirror while strokes for this note are still queued (reconnect must not load the older copy)", async () => {
    pending.push({ path: "/api/nodes/n1/attributes/ink_data" });
    expect(await loadInkAttributes("n1", ["ink_data"] as const)).toEqual({ ink_data: offlineDoc });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the server when nothing for this note is queued (another device may have drawn)", async () => {
    pending.push({ path: "/api/nodes/other/attributes/ink_data" });
    expect(await loadInkAttributes("n1", ["ink_data"] as const)).toEqual({ ink_data: serverDoc });
  });

  it("asks the server for only the keys it reads, not the note's every attribute", async () => {
    expect(await loadInkAttributes("n1", ["ink_data", "pdf_url"] as const)).toEqual({ ink_data: serverDoc, pdf_url: null });
    expect(fetchMock).toHaveBeenCalledWith("/api/nodes/n1/attributes?keys=ink_data,pdf_url");
  });

  // Drawings are not in the bootstrap (lean): what was read is kept on the
  // device so the note opens offline; localDbPersist.fillAttributesInto never
  // replaces a copy already there.
  it("keeps a copy of the drawing it read from the server", async () => {
    await loadInkAttributes("n1", ["ink_data"] as const);
    expect(filled).toHaveBeenCalledWith("n1", [{ key: "ink_data", value: serverDoc }]);
  });

  it("keeps no copy when it read the mirror (strokes queued)", async () => {
    pending.push({ path: "/api/nodes/n1/attributes/ink_data" });
    await loadInkAttributes("n1", ["ink_data"] as const);
    expect(filled).not.toHaveBeenCalled();
  });

  it("falls back to the mirror offline", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await loadInkAttributes("n1", ["ink_data", "pdf_url"] as const)).toEqual({ ink_data: offlineDoc, pdf_url: null });
  });

});

describe("loadInkPage — handwriting page and board layer are two attributes", () => {
  const handwriting = JSON.stringify({ version: 1, strokes: [stroke("hand")], erased: {}, page: { width: 1000 } });
  const board = JSON.stringify({ version: 1, strokes: [stroke("board")], erased: {}, page: { width: 1000 } });
  beforeEach(() => {
    fetchMock.mockReset(); mirror.clear(); pending.length = 0;
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => [{ key: "ink_data", value: handwriting }, { key: "board_ink", value: board }].filter((a) => String(url).includes(a.key)),
    }));
  });

  it("the board reads board_ink, the handwriting page reads ink_data", async () => {
    expect((await loadInkPage("n1", "board_ink"))?.strokes.map((s) => s.id)).toEqual(["board"]);
    expect((await loadInkPage("n1"))?.strokes.map((s) => s.id)).toEqual(["hand"]);
  });

  it("a handwriting page's strokes are not on the board, and a board's are not a handwriting page", async () => {
    fetchMock.mockImplementation(async (url: string) => ({ ok: true, json: async () => (String(url).includes("ink_data") ? [{ key: "ink_data", value: handwriting }] : []) }));
    expect(await loadInkPage("n1", "board_ink")).toBeNull();
    fetchMock.mockImplementation(async (url: string) => ({ ok: true, json: async () => (String(url).includes("board_ink") ? [{ key: "board_ink", value: board }] : []) }));
    expect(await loadInkPage("n1")).toBeNull();
  });
});

describe("decodeInk — the one ink_data decoder", () => {
  const page = { version: 1, strokes: [stroke("s")], erased: {}, page: { width: 800 } };

  it("a single page (handwriting note, canvas layer)", () => {
    const d = decodeInk(JSON.stringify(page));
    expect(d.kind).toBe("page");
    expect(d.kind === "page" && d.doc.strokes).toHaveLength(1);
  });

  it("fills a page's missing erasure and width instead of failing", () => {
    const d = decodeInk(JSON.stringify({ strokes: [] }));
    expect(d).toEqual({ kind: "page", doc: { version: 1, strokes: [], erased: {}, page: { width: 1000 } } });
  });

  it("a PDF envelope: readable pages and its highlight records", () => {
    const d = decodeInk(JSON.stringify({ version: 1, pages: { 1: page, 2: { nope: true } }, annotations: [{ id: "h" }] }));
    expect(d.kind).toBe("pdf");
    if (d.kind !== "pdf") return;
    expect(Object.keys(d.doc.pages)).toEqual(["1"]);
    expect(d.doc.annotations).toEqual([{ id: "h" }]);
  });

  it("none for empty, broken or unrecognised values (no strokes array, wrong version)", () => {
    for (const raw of [null, "", "{not json", "{}", "[]", JSON.stringify({ version: 2, pages: {} }),
      JSON.stringify({ version: 1 }), JSON.stringify({ version: 1, strokes: null }), JSON.stringify({ strokes: "x" }), "null", "42"]) {
      expect(decodeInk(raw)).toEqual({ kind: "none" });
    }
  });
  // GAP-230 (records the engine cannot draw are dropped) is the shared
  // codec's: packages/markdown/src/ink.test.ts.
});

describe("decodePdfInk — legacy pdf_annotations", () => {
  const envelope = { version: 1, pages: { 1: { version: 1, strokes: [stroke("s")], erased: {}, page: { width: 1 } } } };

  it("folds the old attribute into an envelope saved before records moved in", () => {
    const doc = decodePdfInk(JSON.stringify(envelope), JSON.stringify([{ id: "old" }]));
    expect(doc.annotations).toEqual([{ id: "old" }]);
    expect(doc.pages[1]?.strokes).toHaveLength(1);
  });

  it("reads records alone when the PDF has no ink yet", () => {
    expect(decodePdfInk(null, JSON.stringify([{ id: "old" }]))).toEqual({ version: 1, pages: {}, annotations: [{ id: "old" }] });
  });

  it("prefers the envelope's own records over the stale old attribute", () => {
    const doc = decodePdfInk(JSON.stringify({ ...envelope, annotations: [] }), JSON.stringify([{ id: "stale" }]));
    expect(doc.annotations).toEqual([]);
  });

  it("treats an unreadable old attribute as no records", () => {
    expect(decodePdfInk(null, "{broken").annotations).toEqual([]);
  });
});

describe("loadInkPage — the canvas ink layer", () => {
  beforeEach(() => { fetchMock.mockReset(); mirror.clear(); pending.length = 0; });
  const serve = (value: string) => fetchMock.mockResolvedValue({ ok: true, json: async () => [{ key: "ink_data", value }] });

  it("loads the canvas's page", async () => {
    serve(serverDoc);
    expect((await loadInkPage("c1"))?.strokes).toEqual([stroke("old")]);
  });

  it("never loads a PDF envelope as a page (saving over it would lose the PDF's ink)", async () => {
    serve(JSON.stringify({ version: 1, pages: {} }));
    expect(await loadInkPage("c1")).toBeNull();
  });

  it("an empty or unreadable value is an empty layer", async () => {
    serve("{broken");
    expect(await loadInkPage("c1")).toBeNull();
  });
});
