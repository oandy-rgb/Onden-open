import { describe, it, expect } from "vitest";
import { currentUnits, decodeInk, encodeInk, INK_KNOWN_FEATURES, legacyFingerprint, inkPageOrder, withPageAppended, withPageDoc, noteDoc, notePages, pdfPageOfKey, pdfPageRecord, inkUnknownRequirements, isInkReadOnly, mergeInk, mergeIntervals, revertInkConflicts, type InkDocument, type InkEnvelope, type InkStroke } from "./ink.js";

// Fixtures in the shapes the app stores (frontend test/ink.test.ts,
// overviewEditorPdfInk.test.tsx, lib/pdf/pdfAdapter): pressure and plain
// points, both tools, erasure, shapes, a PDF envelope with records.
const stroke = (id: string, n = 4, extra: Partial<InkStroke> = {}): InkStroke => ({
  id, points: Array.from({ length: n }, (_, i) => [i * 10, i * 5] as [number, number]), color: "#000", size: 2, toolId: "pen", ...extra,
});
const page = (strokes: InkStroke[], erased: InkDocument["erased"] = {}, extra: Partial<InkDocument> = {}): InkDocument =>
  ({ version: 1, strokes, erased, page: { width: 1000 }, ...extra });
const enc = (doc: InkDocument | InkEnvelope) => encodeInk(doc);
const merged = (base: InkDocument | InkEnvelope | null, stored: InkDocument | InkEnvelope, incoming: InkDocument | InkEnvelope) =>
  mergeInk(base ? enc(base) : null, enc(stored), enc(incoming));
const ids = (raw: string) => {
  const d = decodeInk(raw);
  return d.kind === "page" ? d.doc.strokes.map((s) => s.id) : [];
};

const S1 = stroke("s1"), S2 = stroke("s2"), S3 = stroke("s3");

describe("ink codec — the stored format round-trips unchanged", () => {
  const fixtures: string[] = [
    JSON.stringify({ version: 1, strokes: [
      { id: "p1", points: [[1, 2, 0.6], [3, 4, 0.8]], color: "#7a2e33", size: 2.5, toolId: "pen" },
      { id: "h1", points: [[5, 6], [7, 8]], color: "#c2871d", size: 7, toolId: "highlighter" },
    ], erased: { p1: [[0, 0]] }, page: { width: 800, background: "#fff" } }),
    JSON.stringify({ version: 1, strokes: [{ id: "s1", points: [[0, 0]], color: "#000", size: 2, toolId: "pen" }], erased: {}, page: { width: 1000 },
      shapes: [{ id: "r1", kind: "rectangle", start: [0, 0], end: [1, 1], color: "#f00", size: 2 }] }),
    JSON.stringify({ version: 1, pages: { 1: { version: 1, strokes: [{ id: "h1:0", points: [[0, 0], [2, 2]], color: "#000", size: 2, toolId: "pen" }], erased: {}, page: { width: 1000 } } },
      annotations: [{ id: "h1", type: "drawing", content: { strokes: [], frame: { w: 10, h: 10 } }, position: { boundingRect: { x1: 0, y1: 0, x2: 10, y2: 10, width: 600, height: 800, pageNumber: 1 }, rects: [] } }] }),
  ];

  it("decode → encode gives back the same value", () => {
    for (const raw of fixtures) {
      const d = decodeInk(raw);
      expect(d.kind).not.toBe("none");
      if (d.kind !== "none") expect(encodeInk(d.doc)).toBe(raw);
    }
  });

  it("merging a value with itself changes nothing", () => {
    for (const raw of fixtures) expect(mergeInk(raw, raw, raw)).toEqual({ value: raw, conflicts: [] });
  });

  it("a save made from what is stored is stored as sent", () => {
    for (const raw of fixtures) {
      const d = decodeInk(raw);
      const next = d.kind === "page" ? enc({ ...d.doc, strokes: [...d.doc.strokes, S3] })
        : d.kind === "pdf" ? enc({ ...d.doc, annotations: [] }) : raw;
      expect(mergeInk(raw, raw, next)).toEqual({ value: next, conflicts: [] });
    }
  });

  it("decodes defaults for a page missing erasure and width; none for unreadable values", () => {
    expect(decodeInk(JSON.stringify({ strokes: [] }))).toEqual({ kind: "page", doc: page([]) });
    for (const raw of [null, "", "{not json", "{}", "[]", JSON.stringify({ version: 2, pages: {} })]) expect(decodeInk(raw)).toEqual({ kind: "none" });
  });

  it("mergeIntervals collapses overlapping and adjacent intervals", () => {
    expect(mergeIntervals([[5, 7], [0, 2], [3, 4], [9, 9]])).toEqual([[0, 7], [9, 9]]);
  });
});

describe("mergeInk — two devices drawing from the same base", () => {
  it("D88: laptop saves {S1,S2}; the tablet's offline {S1,S3} replays → {S1,S2,S3}", () => {
    const result = merged(page([S1]), page([S1, S2]), page([S1, S3]));
    expect(ids(result.value).sort()).toEqual(["s1", "s2", "s3"]);
    expect(result.conflicts).toEqual([]);
  });

  it("a stroke undone on one device stays gone; one drawn on the other stays", () => {
    const result = merged(page([S1, S2]), page([S1, S2, S3]), page([S1]));
    expect(ids(result.value)).toEqual(["s1", "s3"]);
  });

  it("erase on one side, draw on the other → both applied", () => {
    const result = merged(page([S1]), page([S1], { s1: [[0, 1]] }), page([S1, S2]));
    const d = decodeInk(result.value);
    expect(d.kind === "page" && d.doc.erased).toEqual({ s1: [[0, 1]] });
    expect(ids(result.value)).toEqual(["s1", "s2"]);
    expect(result.conflicts).toEqual([]);
  });

  it("erasures on both sides are unioned; an undone erase stays restored", () => {
    const both = merged(page([S1], { s1: [[0, 0]] }), page([S1], { s1: [[0, 1]] }), page([S1], { s1: [[0, 0], [3, 3]] }));
    const d = decodeInk(both.value);
    expect(d.kind === "page" && d.doc.erased).toEqual({ s1: [[0, 1], [3, 3]] });
    const undone = merged(page([S1], { s1: [[0, 1]] }), page([S1], { s1: [[0, 1]] }), page([S1]));
    const u = decodeInk(undone.value);
    expect(u.kind === "page" && u.doc.erased).toEqual({});
  });

  it("the same stroke changed on both sides → incoming wins and a conflict is reported", () => {
    const result = merged(page([S1]), page([stroke("s1", 4, { color: "#f00" })]), page([stroke("s1", 4, { color: "#00f" })]));
    const d = decodeInk(result.value);
    expect(d.kind === "page" && d.doc.strokes[0]!.color).toBe("#00f");
    expect(result.conflicts).toEqual([{ kind: "stroke", id: "s1" }]);
  });

  it("a stroke changed on one side and removed on the other is kept and reported", () => {
    const result = merged(page([S1]), page([stroke("s1", 4, { color: "#f00" })]), page([]));
    expect(ids(result.value)).toEqual(["s1"]);
    expect(result.conflicts).toEqual([{ kind: "stroke", id: "s1" }]);
  });

  it("no base (first save from an empty surface) keeps everything either side has", () => {
    expect(ids(merged(null, page([S2]), page([S3])).value)).toEqual(["s3", "s2"]);
  });

  it("shapes merge by id like strokes", () => {
    const shape = (id: string) => ({ id, kind: "arrow" as const, start: [0, 0] as [number, number], end: [1, 1] as [number, number], color: "#000", size: 2 });
    const result = merged(page([], {}, { shapes: [] }), page([], {}, { shapes: [shape("a")] }), page([], {}, { shapes: [shape("b")] }));
    const d = decodeInk(result.value);
    expect(d.kind === "page" && d.doc.shapes?.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("page settings: the side that changed them; both → incoming, reported", () => {
    const wide = { ...page([S1]), page: { width: 1200 } };
    expect(decodeInk(merged(page([S1]), wide, page([S1, S2])).value)).toMatchObject({ doc: { page: { width: 1200 } } });
    const narrow = { ...page([S1]), page: { width: 800 } };
    const both = merged(page([S1]), wide, narrow);
    expect(decodeInk(both.value)).toMatchObject({ doc: { page: { width: 800 } } });
    expect(both.conflicts).toEqual([{ kind: "page" }]);
  });

  it("a page against a PDF envelope cannot merge: incoming kept, reported", () => {
    const pdf: InkEnvelope = { version: 1, pages: {}, annotations: [] };
    const incoming = enc(page([S1]));
    expect(mergeInk(enc(page([])), enc(pdf), incoming)).toEqual({ value: incoming, conflicts: [{ kind: "format" }] });
  });

  it("nothing stored (or unreadable) → the incoming value as sent", () => {
    const incoming = enc(page([S1]));
    expect(mergeInk(null, null, incoming)).toEqual({ value: incoming, conflicts: [] });
    expect(mergeInk(null, "{broken", incoming)).toEqual({ value: incoming, conflicts: [] });
  });
});

describe("mergeInk — the PDF envelope (strokes per page + highlight records)", () => {
  const rec = (id: string, color = "yellow") => ({ id, type: "area", content: { text: color }, position: {} });
  const env = (pages: InkEnvelope["pages"], annotations?: ReturnType<typeof rec>[]): InkEnvelope =>
    ({ version: 1, pages, ...(annotations ? { annotations } : {}) });
  const decodePdf = (raw: string) => {
    const d = decodeInk(raw);
    if (d.kind !== "pdf") throw new Error("not a PDF envelope");
    return d.doc;
  };

  it("highlights and strokes added on two devices are all kept, page by page", () => {
    const base = env({ 1: page([S1]) }, [rec("h1")]);
    const stored = env({ 1: page([S1, S2]) }, [rec("h1"), rec("h2")]);
    const incoming = env({ 1: page([S1]), 2: page([S3]) }, [rec("h1"), rec("h3")]);
    const result = merged(base, stored, incoming);
    const doc = decodePdf(result.value);
    expect(doc.pages[1]!.strokes.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(doc.pages[2]!.strokes.map((s) => s.id)).toEqual(["s3"]);
    expect(doc.annotations!.map((a) => a.id)).toEqual(["h1", "h3", "h2"]);
    expect(result.conflicts).toEqual([]);
  });

  it("a highlight deleted on one device stays deleted", () => {
    const result = merged(env({}, [rec("h1"), rec("h2")]), env({}, [rec("h1"), rec("h2"), rec("h3")]), env({}, [rec("h2")]));
    expect(decodePdf(result.value).annotations!.map((a) => a.id)).toEqual(["h2", "h3"]);
  });

  it("a highlight changed on both → incoming's, reported", () => {
    const result = merged(env({}, [rec("h1")]), env({}, [rec("h1", "red")]), env({}, [rec("h1", "blue")]));
    expect(decodePdf(result.value).annotations).toEqual([rec("h1", "blue")]);
    expect(result.conflicts).toEqual([{ kind: "annotation", id: "h1" }]);
  });

  it("a stored envelope from before records moved in keeps the base's records (not 'all removed')", () => {
    const result = merged(env({}, [rec("old")]), env({ 1: page([S1]) }), env({}, [rec("old"), rec("new")]));
    const doc = decodePdf(result.value);
    expect(doc.annotations!.map((a) => a.id)).toEqual(["old", "new"]);
    expect(doc.pages[1]!.strokes.map((s) => s.id)).toEqual(["s1"]);
  });

  it("a conflicting stroke is reported with its page", () => {
    const result = merged(env({ 2: page([S1]) }), env({ 2: page([stroke("s1", 2)]) }), env({ 2: page([stroke("s1", 3)]) }));
    expect(result.conflicts).toEqual([{ kind: "stroke", id: "s1", page: 2 }]);
  });
});

describe("revertInkConflicts — undoing what a merge decided, item by item (D90)", () => {
  const red = stroke("s1", 4, { color: "#f00" }), blue = stroke("s1", 4, { color: "#00f" });
  const doc = (raw: string) => {
    const d = decodeInk(raw);
    if (d.kind !== "page") throw new Error("not a page");
    return d.doc;
  };

  it("takes back only the conflicting stroke; the rest of the merge stays", () => {
    // stored had red s1 (+ S2), the incoming save blue s1 (+ S3): merged = blue s1, S3, S2.
    const result = merged(page([S1]), page([red, S2]), page([blue, S3]));
    const reverted = revertInkConflicts(result.value, enc(page([red, S2])), result.conflicts);
    expect(doc(reverted).strokes.map((s) => [s.id, s.color])).toEqual([["s1", "#f00"], ["s3", "#000"], ["s2", "#000"]]);
  });

  it("re-applied with mergeInk onto a drawing changed since, it keeps the newer strokes", () => {
    const result = merged(page([S1]), page([red]), page([blue]));
    const reverted = revertInkConflicts(result.value, enc(page([red])), result.conflicts);
    const now = enc(page([blue, S2], { s2: [[0, 1]] })); // another device drew S2 after the merge
    const applied = mergeInk(result.value, now, reverted);
    expect(doc(applied.value).strokes.map((s) => [s.id, s.color])).toEqual([["s1", "#f00"], ["s2", "#000"]]);
    expect(doc(applied.value).erased).toEqual({ s2: [[0, 1]] });
    expect(applied.conflicts).toEqual([]);
  });

  it("a stroke the overridden side had deleted is deleted again, with its erasure", () => {
    // removed on the stored side, changed (and erased) on the incoming side: kept and reported.
    const result = merged(page([S1, S2]), page([S2]), page([blue, S2], { s1: [[0, 0]] }));
    expect(result.conflicts).toEqual([{ kind: "stroke", id: "s1" }]);
    const reverted = doc(revertInkConflicts(result.value, enc(page([S2])), result.conflicts));
    expect(reverted.strokes.map((s) => s.id)).toEqual(["s2"]);
    expect(reverted.erased).toEqual({});
  });

  it("PDF: a conflicting highlight and a stroke on page 2 are taken back; page 1 untouched", () => {
    const rec = (id: string, color: string) => ({ id, type: "area", content: { text: color }, position: {} });
    const env = (pages: InkEnvelope["pages"], annotations: ReturnType<typeof rec>[]): InkEnvelope => ({ version: 1, pages, annotations });
    const base = env({ 1: page([]), 2: page([S1]) }, [rec("h1", "yellow")]);
    const stored = env({ 1: page([]), 2: page([red]) }, [rec("h1", "red")]);
    const incoming = env({ 1: page([S3]), 2: page([blue]) }, [rec("h1", "blue")]);
    const result = merged(base, stored, incoming);
    expect(result.conflicts).toEqual([{ kind: "stroke", id: "s1", page: 2 }, { kind: "annotation", id: "h1" }]);
    const d = decodeInk(revertInkConflicts(result.value, enc(stored), result.conflicts));
    if (d.kind !== "pdf") throw new Error("not a PDF envelope");
    expect(d.doc.pages[1]!.strokes.map((s) => s.id)).toEqual(["s3"]);
    expect(d.doc.pages[2]!.strokes).toEqual([red]);
    expect(d.doc.annotations).toEqual([rec("h1", "red")]);
  });

  it("page settings and a format conflict: the overridden settings, the overridden value whole", () => {
    const result = merged(page([S1]), page([S1], {}, { page: { width: 800 } }), page([S1], {}, { page: { width: 600 } }));
    expect(result.conflicts).toEqual([{ kind: "page" }]);
    expect(doc(revertInkConflicts(result.value, enc(page([S1], {}, { page: { width: 800 } })), result.conflicts)).page).toEqual({ width: 800 });
    const pdf = enc({ version: 1, pages: {} });
    expect(revertInkConflicts(enc(page([S1])), pdf, [{ kind: "format" }])).toBe(pdf);
  });
});

describe("ink codec — a record nothing can draw never breaks a reader (GAP-230)", () => {
  const stroke = (id: string) => ({ id, points: [[0, 0], [10, 5, 0.5]], color: "#15130d", size: 4, toolId: "pen" });
  // A board whose ink_data held records the engine cannot draw took
  // the whole app into the error boundary. Bad records are dropped, never thrown.
  it("drops strokes and points it cannot draw, keeps the rest, and never throws", () => {
    const raw = JSON.stringify({
      version: 1,
      strokes: [
        null, 7, "s", [], {}, { id: "no-points" }, { id: "bad-points", points: "0,0" },
        { id: "empty", points: [] }, { id: "junk", points: [null, [1], ["a", 2], [NaN, 1], {}] },
        { id: "", points: [[0, 0]] },
        { id: "mixed", points: [[0, 0], null, [5, "y"], [6, 7, "p"], [8, 9, 0.4]], color: 3, size: -1, toolId: "laser" },
        stroke("ok"), stroke("ok"),
      ],
      erased: { ok: [[0, 1], [3, 2], "x", [1.5, 2]], mixed: "all", gone: [] },
      page: { width: "wide" },
      shapes: [{ id: "r", kind: "rectangle", start: [0, 0], end: [5, 5], color: "#000", size: 2 }, { id: "x", kind: "blob", start: [0, 0], end: [1, 1] }, null],
    });
    expect(() => decodeInk(raw)).not.toThrow();
    const decoded = decodeInk(raw);
    expect(decoded.kind).toBe("page");
    if (decoded.kind !== "page") return;
    expect(decoded.doc.strokes).toEqual([
      { id: "mixed", points: [[0, 0], [6, 7], [8, 9, 0.4]], color: "#15130d", size: 4, toolId: "laser" }, // an unknown tool is kept (T1-0)
      stroke("ok"),
    ]);
    expect(decoded.doc.erased).toEqual({ ok: [[0, 1]], gone: [] });
    expect(decoded.doc.page).toEqual({ width: 1000 });
    // an unknown kind is kept for a newer app; malformed entries are dropped
    expect(decoded.doc.shapes?.map((shape) => shape.id)).toEqual(["r", "x"]);
  });

  it("reads a PDF page's strokes the same way", () => {
    const d = decodeInk(JSON.stringify({ version: 1, pages: { 1: { strokes: [null, stroke("s"), { id: "t" }] } } }));
    expect(d.kind === "pdf" && d.doc.pages[1]?.strokes).toEqual([stroke("s")]);
  });

  it("a merge over a broken stored value keeps every drawable stroke", () => {
    const stored = JSON.stringify({ version: 1, strokes: [null, { id: "bad" }, stroke("a")], erased: {}, page: { width: 1000 } });
    const incoming = JSON.stringify({ version: 1, strokes: [stroke("a"), stroke("b")], erased: {}, page: { width: 1000 } });
    expect(ids(mergeInk(stored, stored, incoming).value)).toEqual(["a", "b"]);
  });
});

// ── T1-0: a newer writer's data survives an older reader ───────────────────
// An old app loads a drawing written by a newer one and saves it back after an
// unrelated edit. Nothing it does not understand may change on the way.
describe("ink codec — forward compatibility", () => {
  const future = {
    version: 1,
    features: ["pencil-tool", "spiral-shape"],
    requires: [],
    futureDoc: { clips: [{ id: "c1" }] },
    strokes: [
      { id: "p1", points: [[0, 0, 0.5], [4, 4, 0.7]], color: "#123456", size: 3, toolId: "pencil", grain: 0.3 },
      { id: "s1", points: [[0, 0], [9, 9]], color: "#000", size: 2, toolId: "pen" },
    ],
    erased: {},
    page: { width: 900, template: "grid", futurePage: 7 },
    shapes: [
      { id: "spiral1", kind: "spiral", points: [[0, 0], [5, 9], [10, 0]], color: "oklch(0.5 0.1 20)", size: 2, spikes: 5 },
      { id: "r1", kind: "rectangle", start: [0, 0], end: [3, 3], color: "#f00", size: 2, rounded: true },
    ],
  };
  const futureRaw = JSON.stringify(future);

  it("page: unknown toolId, shape kind and fields at every level round-trip deep-equal", () => {
    const d = decodeInk(futureRaw);
    expect(d.kind).toBe("page");
    if (d.kind !== "page") return;
    expect(JSON.parse(encodeInk(d.doc))).toEqual(future);
  });

  it("envelope: unknown envelope and per-page fields round-trip deep-equal", () => {
    const env = { version: 1, features: ["f1"], futureEnv: { a: 1 }, pages: { 1: future }, annotations: [{ id: "h1", type: "text" }] };
    const d = decodeInk(JSON.stringify(env));
    expect(d.kind).toBe("pdf");
    if (d.kind !== "pdf") return;
    expect(JSON.parse(encodeInk(d.doc))).toEqual(env);
  });

  it("mergeInk: an old app's unrelated edit keeps the pencil toolId and the spiral shape, no conflict", () => {
    // What the OLD app writes after adding one pen stroke: it re-serialises
    // what it parsed (the pre-fix parse rewrote toolId and dropped the spiral).
    const parsed = decodeInk(futureRaw);
    if (parsed.kind !== "page") throw new Error("page expected");
    const oldSide = { ...parsed.doc, strokes: [...parsed.doc.strokes, stroke("new1")] };
    const r = mergeInk(futureRaw, futureRaw, encodeInk(oldSide));
    expect(r.conflicts).toEqual([]);
    const out = JSON.parse(r.value);
    expect(out.strokes.map((s: InkStroke) => s.id)).toEqual(["p1", "s1", "new1"]);
    expect(out.strokes[0].toolId).toBe("pencil");
    expect(out.strokes[0].grain).toBe(0.3);
    expect(out.shapes.map((s: { id: string }) => s.id)).toEqual(["spiral1", "r1"]);
    expect(out.shapes[0]).toEqual(future.shapes[0]);
  });

  it("mergeInk: unknown top-level and page fields merge as values, three-way", () => {
    const base = { ...future };
    const stored = { ...future, futureDoc: { clips: [] }, page: { ...future.page, futurePage: 8 } }; // another device changed these
    const incoming = { ...future, extraNew: "x", strokes: [...future.strokes, stroke("n1")] }; // this one added a field + a stroke
    const r = mergeInk(JSON.stringify(base), JSON.stringify(stored), JSON.stringify(incoming));
    const out = JSON.parse(r.value);
    expect(out.futureDoc).toEqual({ clips: [] }); // changed there only
    expect(out.extraNew).toBe("x"); // added here only
    expect(out.page.futurePage).toBe(8);
    expect(out.page.template).toBe("grid");
    expect(r.conflicts).toEqual([]);
  });

  it("mergeInk: the union of features/requires survives from either side", () => {
    const a = { ...future, features: ["a"], requires: ["a"] };
    const b = { ...future, features: ["b"], requires: [] };
    const r = mergeInk(JSON.stringify({ ...future, features: [], requires: [] }), JSON.stringify(a), JSON.stringify(b));
    const out = JSON.parse(r.value);
    expect([...out.features].sort()).toEqual(["a", "b"]);
    expect(out.requires).toEqual(["a"]);
  });

  it("still rejects or clamps malformed data", () => {
    const raw = JSON.stringify({ version: 1, strokes: [
      { id: "ok", points: [[0, 0], [NaN, 1], [2, 2]], color: 5, size: -3, toolId: 7 },
      { id: "", points: [[0, 0]] },
    ], erased: {}, page: { width: -1 }, shapes: [{ id: "bad", kind: "rectangle", start: [0], end: [1, 1] }, { id: "k", kind: 5 }], features: "nope" });
    const d = decodeInk(raw);
    expect(d.kind).toBe("page");
    if (d.kind !== "page") return;
    expect(d.doc.strokes).toHaveLength(1);
    expect(d.doc.strokes[0]).toMatchObject({ color: "#15130d", size: 4, toolId: "pen" });
    expect(d.doc.page.width).toBe(1000);
    expect(d.doc.shapes).toEqual([]);
    expect(d.doc.features).toBeUndefined();
  });
});

describe("ink codec — features / requires (read-only rule)", () => {
  it("writes none today: this version knows every feature it writes", () => {
    expect(INK_KNOWN_FEATURES).toEqual([]);
    expect(isInkReadOnly(page([S1]))).toBe(false);
  });
  it("features a reader does not know are fine unless the writer REQUIRES them", () => {
    expect(isInkReadOnly({ ...page([S1]), features: ["pencil-tool"] })).toBe(false);
    const gated = { ...page([S1]), features: ["clips"], requires: ["clips"] };
    expect(isInkReadOnly(gated)).toBe(true);
    expect(inkUnknownRequirements(gated)).toEqual(["clips"]);
  });
  it("an envelope is read-only when it or any of its pages requires an unknown feature", () => {
    const env: InkEnvelope = { version: 1, pages: { 1: page([S1]), 2: { ...page([S2]), requires: ["x"] } } };
    expect(isInkReadOnly(env)).toBe(true);
    expect(isInkReadOnly({ ...env, pages: { 1: page([S1]) } })).toBe(false);
    expect(isInkReadOnly({ version: 1, pages: {}, requires: ["y"] })).toBe(true);
  });
  it("survives decode → encode", () => {
    const raw = JSON.stringify({ ...page([S1]), features: ["clips"], requires: ["clips"] });
    const d = decodeInk(raw);
    expect(d.kind === "page" && isInkReadOnly(d.doc)).toBe(true);
    if (d.kind === "page") expect(JSON.parse(encodeInk(d.doc))).toEqual(JSON.parse(raw));
  });
});

// ── Page units in the PDF envelope (InkPages in `units`) ───────────────────

describe("InkPages — the pages of a drawing in page units", () => {
  const record = (key: string, doc: InkDocument, extra: Record<string, unknown> = {}) =>
    ({ key, background: key.startsWith("pdf:") ? { kind: "pdf", page: Number(key.slice(4)) } : { kind: "blank" }, size: { width: 1000, height: 1414 }, doc, ...extra });
  const pdfRec = (id: string, pageNumber = 1) =>
    ({ id, type: "drawing", content: { strokes: [], frame: { w: 10, h: 10 } }, position: { boundingRect: { x1: 0, y1: 0, x2: 10, y2: 10, width: 600, height: 800, pageNumber }, rects: [] } });
  /** An envelope as the app writes it: older fields + units with their fingerprint. */
  const written = (pages: Record<string, InkDocument>, annotations: ReturnType<typeof pdfRec>[] = []): InkEnvelope => {
    const legacy = { version: 1 as const, pages: Object.fromEntries(Object.entries(pages).map(([key, d]) => [Number(key.slice(4)), d])), annotations };
    return {
      ...legacy,
      units: { version: 1, pages: Object.fromEntries(Object.entries(pages).map(([key, d]) => [key, record(key, d) as never])) },
      unitsFrom: legacyFingerprint(legacy),
    };
  };
  const decodePdf = (raw: string) => {
    const d = decodeInk(raw);
    if (d.kind !== "pdf") throw new Error("not a PDF envelope");
    return d.doc;
  };

  it("keys and records: a PDF page is pdf:<n>, a handwriting note's page is `page`", () => {
    expect(pdfPageRecord(3, page([S1]), 1.4)).toMatchObject({ key: "pdf:3", background: { kind: "pdf", page: 3 }, size: { width: 1000, height: 1400 } });
    expect(pdfPageOfKey("pdf:12")).toBe(12);
    expect(pdfPageOfKey("page")).toBeNull();
    expect(pdfPageOfKey("slide:abc")).toBeNull();
    const note = notePages(page([S1]));
    expect(Object.keys(note.pages)).toEqual(["page"]);
    expect(note.pages.page).toMatchObject({ key: "page", background: { kind: "blank" }, size: { width: 1000 } });
    expect(noteDoc(note)).toEqual(page([S1]));
    expect(noteDoc(notePages(null))).toBeNull();
  });

  it("round-trips through the codec unchanged, unknown fields and backgrounds included", () => {
    const env = written({ "pdf:1": page([S1]) });
    env.units!.pages["slide:x"] = { key: "slide:x", background: { kind: "slide", slideId: "x" }, size: { width: 1920, height: 1080 }, doc: page([S2]), note: "kept" } as never;
    (env.units as unknown as Record<string, unknown>).futureUnits = { a: 1 };
    (env as unknown as Record<string, unknown>).futureEnv = 7;
    const raw = JSON.stringify(env);
    expect(JSON.parse(encodeInk(decodePdf(raw)))).toEqual(JSON.parse(raw));
  });

  it("an unreadable page of `units` is dropped (the older fields still hold the drawing); a malformed units value is not an error", () => {
    const env = JSON.parse(JSON.stringify(written({ "pdf:1": page([S1]) })));
    env.units.pages["pdf:2"] = { key: "pdf:2", doc: { not: "a page" } };
    expect(Object.keys(decodePdf(JSON.stringify(env)).units!.pages)).toEqual(["pdf:1"]);
    env.units = "garbage";
    const doc = decodePdf(JSON.stringify(env));
    expect(doc.units).toBeUndefined();
    expect(doc.pages[1]!.strokes).toHaveLength(1);
  });

  it("an old app's edit of the older fields keeps `units` and `unitsFrom` (it re-serialises what it parsed)", () => {
    const base = written({ "pdf:1": page([S1]) });
    const parsed = decodePdf(encodeInk(base));
    const oldAppSave = { ...parsed, pages: { 1: page([S1, S2]) } } satisfies InkEnvelope;
    const back = decodePdf(encodeInk(oldAppSave));
    expect(back.units).toEqual(base.units);
    expect(back.unitsFrom).toBe(base.unitsFrom);
    expect(currentUnits(back)).toBeNull(); // …and the fingerprint tells the new app they are old
    expect(currentUnits(base)).toEqual(base.units);
  });

  it("the fingerprint ignores order, text and area records; it sees every stroke, erased span, shape and drawing record", () => {
    const a = written({ "pdf:1": page([S1, S2], { s1: [[0, 1]] }) });
    const reordered = { ...a, pages: { 1: page([S2, S1], { s1: [[0, 1]] }) } };
    expect(legacyFingerprint(reordered)).toBe(legacyFingerprint(a));
    const text = { id: "t", type: "text", position: {} };
    expect(legacyFingerprint({ ...a, annotations: [text as never] })).toBe(legacyFingerprint(a));
    expect(legacyFingerprint({ ...a, pages: { 1: page([S1, S2], { s1: [[0, 2]] }) } })).not.toBe(legacyFingerprint(a));
    expect(legacyFingerprint({ ...a, pages: { 1: page([S1, S2], { s1: [[0, 1]] }, { shapes: [{ id: "r", kind: "rectangle", start: [0, 0], end: [9, 9], color: "#000", size: 2 }] }) } })).not.toBe(legacyFingerprint(a));
    expect(legacyFingerprint({ ...a, annotations: [pdfRec("d")] })).not.toBe(legacyFingerprint(a));
    expect(legacyFingerprint({})).toBe(legacyFingerprint({ pages: {}, annotations: [] }));
  });

  describe("mergeInk of two new-format saves", () => {
    const withStrokes = (strokes: InkStroke[], pdfPage = 1, annotations: ReturnType<typeof pdfRec>[] = []) => written({ [`pdf:${pdfPage}`]: page(strokes) }, annotations);

    it("different strokes on one page merge by id, and the merged units match the merged older fields", () => {
      const base = withStrokes([S1]);
      const result = merged(base, withStrokes([S1, S2]), withStrokes([S1, S3]));
      const doc = decodePdf(result.value);
      expect(doc.units!.pages["pdf:1"]!.doc.strokes.map((s) => s.id).sort()).toEqual(["s1", "s2", "s3"]);
      expect(doc.pages[1]!.strokes.map((s) => s.id).sort()).toEqual(["s1", "s2", "s3"]);
      expect(currentUnits(doc)).not.toBeNull();
      expect(result.conflicts).toEqual([]);
    });

    it("different pages never conflict", () => {
      const result = merged(written({}), written({ "pdf:1": page([S1]) }), written({ "pdf:2": page([S2]) }));
      const doc = decodePdf(result.value);
      expect(Object.keys(doc.units!.pages).sort()).toEqual(["pdf:1", "pdf:2"]);
      expect(result.conflicts).toEqual([]);
      expect(currentUnits(doc)).not.toBeNull();
    });

    it("an erase on one side and a stroke on the other both stay", () => {
      const base = withStrokes([S1]);
      const doc = decodePdf(merged(base, written({ "pdf:1": page([S1], { s1: [[0, 1]] }) }), withStrokes([S1, S2])).value);
      expect(doc.units!.pages["pdf:1"]!.doc.erased).toEqual({ s1: [[0, 1]] });
      expect(doc.units!.pages["pdf:1"]!.doc.strokes.map((s) => s.id)).toEqual(["s1", "s2"]);
    });

    it("a stroke undone on one side stays gone", () => {
      const base = withStrokes([S1, S2]);
      const doc = decodePdf(merged(base, withStrokes([S1, S2, S3]), withStrokes([S1])).value);
      expect(doc.units!.pages["pdf:1"]!.doc.strokes.map((s) => s.id)).toEqual(["s1", "s3"]);
    });

    it("the same stroke edited on both sides is one conflict, reported once (by the older fields)", () => {
      const base = withStrokes([S1]);
      const result = merged(base, withStrokes([stroke("s1", 2)]), withStrokes([stroke("s1", 3)]));
      expect(result.conflicts.filter((c) => c.kind === "stroke")).toHaveLength(1);
    });

    it("a page record's own fields merge three-way: a newer size wins over an unchanged one", () => {
      const base = withStrokes([S1]);
      const resized = withStrokes([S1]);
      resized.units!.pages["pdf:1"]!.size = { width: 1000, height: 1500 };
      expect(decodePdf(merged(base, base, resized).value).units!.pages["pdf:1"]!.size).toEqual({ width: 1000, height: 1500 });
      expect(decodePdf(merged(base, resized, base).value).units!.pages["pdf:1"]!.size).toEqual({ width: 1000, height: 1500 });
    });

    it("unknown fields of the units object and of a page record survive the merge", () => {
      const base = withStrokes([S1]);
      const stored = withStrokes([S1, S2]);
      (stored.units!.pages["pdf:1"] as unknown as Record<string, unknown>).future = { x: 1 };
      (stored.units as unknown as Record<string, unknown>).futureUnits = "u";
      const doc = decodePdf(merged(base, stored, withStrokes([S1, S3])).value);
      expect(doc.units!.pages["pdf:1"] as unknown as Record<string, unknown>).toMatchObject({ future: { x: 1 } });
      expect((doc.units as unknown as Record<string, unknown>).futureUnits).toBe("u");
    });
  });

  describe("mergeInk when an older app edited the older fields", () => {
    const base = written({ "pdf:1": page([S1]) });
    // the older app: more strokes in the older fields, `units` kept as it found them
    const oldApp = { ...base, pages: { 1: page([S1, S2]) } } as InkEnvelope;
    const newApp = written({ "pdf:1": page([S1, S3]) });

    it("both strokes are in the older fields; `units` are marked stale so a reader converts them", () => {
      const doc = decodePdf(merged(base, oldApp, newApp).value);
      expect(doc.pages[1]!.strokes.map((s) => s.id).sort()).toEqual(["s1", "s2", "s3"]);
      expect(currentUnits(doc)).toBeNull();
      expect(doc.unitsFrom).toBeUndefined();
    });

    it("the older app saving over a newer save: the same, in the other order", () => {
      const doc = decodePdf(merged(base, newApp, oldApp).value);
      expect(doc.pages[1]!.strokes.map((s) => s.id).sort()).toEqual(["s1", "s2", "s3"]);
      expect(currentUnits(doc)).toBeNull();
    });

    it("an older app's text highlight leaves the newer app's units trusted", () => {
      const text = { id: "t", type: "text", position: {} };
      const oldText = { ...base, annotations: [...(base.annotations ?? []), text] } as InkEnvelope;
      const doc = decodePdf(merged(base, newApp, oldText).value);
      expect(doc.annotations!.some((a) => a.id === "t")).toBe(true);
      expect(currentUnits(doc)).not.toBeNull();
      expect(doc.units!.pages["pdf:1"]!.doc.strokes.map((s) => s.id)).toEqual(["s1", "s3"]);
    });

    it("the next new-format save heals: its base is read from the older fields, so it matches the stored ones", () => {
      const stale = decodePdf(merged(base, oldApp, newApp).value);
      // a new app reads the stale value (converting the older fields) and saves an edit:
      const read = { ...stale, units: written({ "pdf:1": page(stale.pages[1]!.strokes) }).units, unitsFrom: legacyFingerprint(stale) } as InkEnvelope;
      const edited = { ...read, units: { ...read.units!, pages: { "pdf:1": record("pdf:1", page([...stale.pages[1]!.strokes, stroke("s4")])) as never } } } as InkEnvelope;
      edited.pages = { 1: page([...stale.pages[1]!.strokes, stroke("s4")]) };
      edited.unitsFrom = legacyFingerprint(edited);
      const doc = decodePdf(mergeInk(encodeInk(read), encodeInk(stale), encodeInk(edited)).value);
      expect(currentUnits(doc)).not.toBeNull();
      expect(doc.units!.pages["pdf:1"]!.doc.strokes.map((s) => s.id).sort()).toEqual(["s1", "s2", "s3", "s4"]);
    });
  });

  it("a stored value from before this format merges with a new one: no side loses strokes", () => {
    const before: InkEnvelope = { version: 1, pages: { 1: page([S1]) }, annotations: [] };
    const result = merged(before, before, written({ "pdf:1": page([S1, S2]) }, []));
    const doc = decodePdf(result.value);
    expect(doc.pages[1]!.strokes.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("units only count for read-only checks too: a page of units that `requires` an unknown feature is read-only", () => {
    const env = written({ "pdf:1": page([S1]) });
    env.units!.pages["pdf:1"]!.doc = { ...env.units!.pages["pdf:1"]!.doc, requires: ["quantum-ink"] };
    expect(inkUnknownRequirements(env)).toEqual(["quantum-ink"]);
    expect(isInkReadOnly(decodePdf(JSON.stringify(env)))).toBe(true);
  });
});

describe("a handwriting note of several pages (`morePages`)", () => {
  const blank = (key: string, doc: InkDocument) => ({ key, background: { kind: "blank" as const }, size: { width: 1000, height: 1414 }, doc });
  /** A note whose first page has `first`, then the pages `more` (key → strokes). */
  const note = (first: InkStroke[], more: Record<string, InkStroke[]>, order?: string[]): InkDocument => page(first, {}, {
    morePages: { version: 1, pages: Object.fromEntries(Object.entries(more).map(([key, s]) => [key, blank(key, page(s))])), ...(order ? { order } : {}) },
  });
  const decodeNote = (raw: string) => {
    const d = decodeInk(raw);
    if (d.kind !== "page") throw new Error("not a handwriting page");
    return d.doc;
  };
  const strokesOn = (raw: string, key: string) => {
    const pages = notePages(decodeNote(raw)).pages;
    return pages[key]?.doc.strokes.map((s) => s.id) ?? null;
  };

  it("pages and back: the first is `page`, the rest come from morePages, in their order", () => {
    const doc = note([S1], { b: [S2], a: [S3] }, ["page", "b", "a"]);
    const pages = notePages(doc);
    expect(inkPageOrder(pages)).toEqual(["page", "b", "a"]);
    expect(pages.pages.page!.doc.morePages).toBeUndefined();
    expect(pages.pages.b!.doc.strokes).toEqual([S2]);
    expect(noteDoc(pages)).toEqual(doc);
    expect(noteDoc(notePages(page([S1])))).toEqual(page([S1]));
  });

  it("order: a key it does not name comes after, `page` first, then PDF pages by number; a missing key is skipped", () => {
    const pages = notePages(note([S1], { "pdf:2": [], u: [], "pdf:1": [] }, ["u", "gone"]));
    expect(inkPageOrder(pages)).toEqual(["u", "page", "pdf:1", "pdf:2"]);
  });

  it("a page appended goes last, with a fixed blank sheet, and survives noteDoc → notePages", () => {
    const first = withPageAppended(notePages(page([S1])), "u1");
    const second = withPageAppended(first, "u2");
    expect(inkPageOrder(second)).toEqual(["page", "u1", "u2"]);
    expect(second.pages.u2!.size).toEqual({ width: 1000, height: 1400 });
    expect(withPageAppended(second, "u1")).toBe(second); // a key already there is kept
    const back = notePages(noteDoc(second));
    expect(inkPageOrder(back)).toEqual(["page", "u1", "u2"]);
    expect(back.pages.page!.doc.strokes).toEqual([S1]);
  });

  it("withPageDoc replaces one page's drawing and keeps its size; an unknown key changes nothing", () => {
    const pages = withPageAppended(notePages(page([S1])), "u");
    const next = withPageDoc(pages, "u", page([S2]));
    expect(next.pages.u!.doc.strokes).toEqual([S2]);
    expect(next.pages.u!.size).toEqual(pages.pages.u!.size);
    expect(next.pages.page).toBe(pages.pages.page);
    expect(withPageDoc(pages, "nope", page([S3]))).toBe(pages);
  });

  it("round-trips through the codec; an unreadable page or order is dropped, `page` inside is ignored", () => {
    const doc = note([S1], { u: [S2] }, ["page", "u"]);
    expect(decodeNote(enc(doc))).toEqual(doc);
    const raw = JSON.stringify({ ...page([S1]), morePages: { version: 1, order: "x", pages: { u: { key: "u", doc: { nope: 1 } }, page: blank("page", page([S3])), v: blank("v", page([S2])) } } });
    const read = decodeNote(raw);
    expect(Object.keys(read.morePages!.pages)).toEqual(["v"]);
    expect(read.morePages!.order).toBeUndefined();
    expect(decodeNote(JSON.stringify({ ...page([S1]), morePages: 7 })).morePages).toBeUndefined();
  });

  it("an older app (it knows only the first page) carries the other pages along", () => {
    const stored = note([S1], { u: [S2] });
    const older = { ...stored, strokes: [S1, S3] };
    const out = merged(stored, stored, older).value;
    expect(strokesOn(out, "page")).toEqual(["s1", "s3"]);
    expect(strokesOn(out, "u")).toEqual(["s2"]);
  });

  it("two devices: strokes on different pages, and a page each adds, all stay", () => {
    const base = note([S1], { u: [] });
    const stored = note([S1], { u: [S2], v: [] }, ["page", "v", "u"]);
    const incoming = note([S1, S3], { u: [stroke("s4")], w: [stroke("s5")] });
    const out = decodeNote(merged(base, stored, incoming).value);
    const pages = notePages(out);
    expect(pages.pages.u!.doc.strokes.map((s) => s.id).sort()).toEqual(["s2", "s4"]);
    expect(Object.keys(pages.pages).sort()).toEqual(["page", "u", "v", "w"]);
    expect(pages.pages.page!.doc.strokes.map((s) => s.id)).toEqual(["s1", "s3"]);
    expect(inkPageOrder(pages).slice(0, 3)).toEqual(["page", "v", "u"]);
  });

  it("a page one device removed goes, unless the other drew on it meanwhile", () => {
    const base = note([S1], { u: [S2], v: [S3] });
    const removed = note([S1], { v: [S3] });
    expect(strokesOn(merged(base, base, removed).value, "u")).toBeNull();
    const drewOn = note([S1], { u: [S2, stroke("s9")], v: [S3] });
    expect(strokesOn(merged(base, drewOn, removed).value, "u")).toEqual(["s2", "s9"]);
    expect(strokesOn(merged(base, removed, drewOn).value, "u")).toEqual(["s2", "s9"]);
  });

  it("a stroke both devices changed on a further page is reported with its page, and reverts there", () => {
    const base = note([S1], { u: [S2] });
    const stored = note([S1], { u: [{ ...S2, color: "#f00" }] });
    const incoming = note([S1], { u: [{ ...S2, color: "#00f" }] });
    const result = merged(base, stored, incoming);
    expect(result.conflicts).toEqual([{ kind: "stroke", id: "s2", pageKey: "u" }]);
    const reverted = revertInkConflicts(result.value, enc(stored), result.conflicts);
    expect(notePages(decodeNote(reverted)).pages.u!.doc.strokes[0]!.color).toBe("#f00");
  });
});
