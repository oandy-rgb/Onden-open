import { describe, it, expect } from "vitest";
import {
  decodeNotePages, encodeNotePages, expandNotePages, insertBlankPage, mergeNotePages, mintPageId, notePagesOf, pagesFromPdfUrl,
  summarizeNotePages, type NotePages, type PageRun,
} from "./notePages.js";
import { blankPageRecord, inkPageOrder, noteDoc, notePages as inkNotePages, pdfPageRecord, type InkPages } from "./inkPages.js";
import { pdfPageKey } from "./pageText.js";

const pdf = (id: string, from: number, to: number | null, extra: Partial<Extract<PageRun, { kind: "pdf" }>> = {}): PageRun => ({ id, kind: "pdf", file: "/api/media/a.pdf", from, to, ...extra });
const blank = (id: string): PageRun => ({ id, kind: "blank" });
const list = (...runs: PageRun[]): NotePages => ({ version: 1, runs });
/** Whether a list keeps the rules (what the codec accepts). */
const valid = (pages: unknown) => decodeNotePages(JSON.stringify(pages)).ok;
const counter = (prefix = "n") => { let i = 0; return () => `${prefix}${++i}`; };

describe("note_pages codec", () => {
  it("round-trips the example value and decodes empty / unreadable / newer values as not pages", () => {
    const pages = list(blank("b1"), pdf("r1", 1, 3), blank("b2"));
    expect(decodeNotePages(encodeNotePages(pages))).toEqual({ ok: true, pages });
    expect(decodeNotePages(null)).toEqual({ ok: false, reason: "empty" });
    expect(decodeNotePages("")).toEqual({ ok: false, reason: "empty" });
    expect(decodeNotePages("{not json")).toEqual({ ok: false, reason: "invalid" });
    expect(decodeNotePages(JSON.stringify({ version: 2, runs: [] }))).toEqual({ ok: false, reason: "newer" });
  });

  it("refuses what breaks the rules: duplicate ids, overlapping ranges under one prefix, one prefix for two files, reserved ids", () => {
    expect(valid(list(blank("a"), blank("a")))).toBe(false);
    expect(valid(list(pdf("a", 1, 5), pdf("b", 5, 9, { keyPrefix: "a" })))).toBe(false);
    expect(valid(list(pdf("a", 1, 5), { ...pdf("b", 6, 9, { keyPrefix: "a" }), file: "/api/media/other.pdf" }))).toBe(false);
    expect(valid(list(blank("page")))).toBe(false);
    expect(valid(list(blank("pdf")))).toBe(false);
    expect(valid(list(pdf("a", 5, 2)))).toBe(false);
    expect(valid(list(pdf("a", 0, 2)))).toBe(false);
    expect(valid(list(blank("a:1")))).toBe(false);
    expect(valid(list(pdf("a", 1, 5), pdf("b", 6, null, { keyPrefix: "a" })))).toBe(true);
    expect(valid(list(pdf("a", 1, 5), blank("b"), pdf("c", 6, 9, { keyPrefix: "a" })))).toBe(true);
  });
});

describe("pages of a note, and of a note made before", () => {
  it("an old PDF note's pdf_url is one run whose keys are the pdf:<n> it always had", () => {
    const pages = notePagesOf({ pdf_url: "/api/media/a.pdf" })!;
    const { entries } = expandNotePages(pages, () => 3);
    expect(entries.map((e) => e.key)).toEqual([1, 2, 3].map(pdfPageKey));
    expect(entries.every((e) => e.pdf?.file === "/api/media/a.pdf")).toBe(true);
    expect(pagesFromPdfUrl("/x.pdf")).toEqual(pagesFromPdfUrl("/x.pdf"));
  });

  it("note_pages wins over pdf_url; an unreadable note_pages is not pages", () => {
    const own = list(blank("b1"));
    expect(notePagesOf({ note_pages: encodeNotePages(own), pdf_url: "/x.pdf" })).toEqual(own);
    expect(notePagesOf({ note_pages: "{", pdf_url: "/x.pdf" })).toEqual(pagesFromPdfUrl("/x.pdf"));
    expect(notePagesOf({})).toBeNull();
  });

  it("expands in order; a run to the end waits for the file's page count, a known count cuts a too-long `to` short", () => {
    const pages = list(blank("b1"), pdf("r1", 1, 3), pdf("r2", 1, null, { file: "/api/media/b.pdf" } as never), blank("b2"));
    const unknown = expandNotePages(pages, () => null);
    expect(unknown.entries.map((e) => e.key)).toEqual(["b1", "r1:1", "r1:2", "r1:3", "b2"]);
    expect(unknown.unknownFiles).toEqual(["/api/media/b.pdf"]);
    const known = expandNotePages(pages, (file) => (file.endsWith("b.pdf") ? 2 : 2));
    expect(known.entries.map((e) => e.key)).toEqual(["b1", "r1:1", "r1:2", "r2:1", "r2:2", "b2"]);
    expect(known.unknownFiles).toEqual([]);
  });

  it("says in a sentence how many pages and which are PDF", () => {
    expect(summarizeNotePages(list(blank("b1"), pdf("r1", 1, 3), blank("b2")))).toBe("5 pages: blank, PDF 1-3, blank");
    expect(summarizeNotePages(list(blank("b1"), pdf("r1", 1, null)))).toBe("1+ pages: blank, PDF 1-end");
  });
});

describe("writing: the one place that makes ids", () => {
  it("never mints an id that is in use or reserved, and takes the next one from the source", () => {
    const next = ["page", "pdf", "taken", "fresh"];
    expect(mintPageId(["taken"], () => next.shift()!)).toBe("fresh");
    expect(() => mintPageId(["x"], () => "x")).toThrow();
  });

  it("inserting a blank page in the middle of a PDF run cuts it: the halves have different ids, no page key changes", () => {
    const before = list(pdf("r1", 1, 5));
    const result = insertBlankPage(before, "r1:2", [], counter())!;
    expect(result.pages.runs).toEqual([pdf("r1", 1, 2), blank("n2"), pdf("n1", 3, 5, { keyPrefix: "r1" })]);
    expect(valid(result.pages)).toBe(true);
    const keys = (p: NotePages) => expandNotePages(p, () => 5).entries.map((e) => e.key).filter((k) => k !== result.key);
    expect(keys(result.pages)).toEqual(keys(before));
  });

  it("an old note's run is cut the same way, so its pages keep their pdf:<n> keys; the id `pdf` is never minted again", () => {
    const result = insertBlankPage(pagesFromPdfUrl("/api/media/a.pdf"), "pdf:3", [], counter())!;
    const keys = expandNotePages(result.pages, () => 6).entries.map((e) => e.key);
    expect(keys).toEqual(["pdf:1", "pdf:2", "pdf:3", "n2", "pdf:4", "pdf:5", "pdf:6"]);
    expect(result.pages.runs.map((r) => r.id)).not.toContain("pdf:4");
  });

  it("the page after the last page of a run, a blank page, and the end need no cut; a key that is no page is refused", () => {
    expect(insertBlankPage(list(pdf("r1", 1, 3), blank("b")), "r1:3", [], counter())!.pages.runs.map((r) => r.id)).toEqual(["r1", "n1", "b"]);
    expect(insertBlankPage(list(blank("b"), pdf("r1", 1, 3)), "b", [], counter())!.pages.runs.map((r) => r.id)).toEqual(["b", "n1", "r1"]);
    expect(insertBlankPage(list(blank("b")), "end", [], counter())!.pages.runs.map((r) => r.id)).toEqual(["b", "n1"]);
    expect(insertBlankPage(list(blank("b")), "zzz", [], counter())).toBeNull();
  });

  it("a key the note's ink already holds is not minted (a deleted page's key stays given up)", () => {
    const result = insertBlankPage(list(blank("b")), "end", ["n1"], counter())!;
    expect(result.key).toBe("n2");
  });
});

describe("a notebook without a first page of its own (carrier)", () => {
  const strokes = { version: 1 as const, strokes: [{ id: "s", points: [[1, 1]] as [number, number][], color: "#000", size: 2, toolId: "pen" as const }], erased: {}, page: { width: 1000 } };
  it("stores an empty carrier `page` marked as one; reading shows only the listed pages", () => {
    const pages: InkPages = { version: 1, pages: { "r1:1": pdfPageRecord(1, strokes, 1.4, "r1:1"), b1: blankPageRecord("b1") }, order: ["r1:1", "b1"] };
    const stored = noteDoc(pages)!;
    expect(stored.strokes).toEqual([]);
    expect(stored.morePages?.order).toEqual(["r1:1", "b1"]);
    expect(stored.morePages?.carrier).toBe(true);
    const back = inkNotePages(stored);
    expect(Object.keys(back.pages).sort()).toEqual(["b1", "page", "r1:1"]);
    expect(inkPageOrder(back)).toEqual(["r1:1", "b1"]);
  });
  it("a carrier needs no order; an order that does not name `page` hides nothing in a notebook that is not marked (as before)", () => {
    const pages: InkPages = { version: 1, pages: { b1: blankPageRecord("b1") } };
    expect(inkPageOrder(inkNotePages(noteDoc(pages)))).toEqual(["b1"]);
    expect(inkPageOrder({ version: 1, pages: { page: { ...blankPageRecord("page") }, b1: blankPageRecord("b1") }, order: ["b1"] })).toEqual(["b1", "page"]);
    expect(noteDoc({ version: 1, pages: {} })).toBeNull();
    const first = { ...blankPageRecord("page"), key: "page" };
    expect(inkPageOrder({ version: 1, pages: { page: first, b1: blankPageRecord("b1") }, order: ["page", "b1"] })).toEqual(["page", "b1"]);
    expect(inkPageOrder({ version: 1, pages: { page: first, b1: blankPageRecord("b1") }, order: [] })).toEqual(["page", "b1"]);
    expect(inkPageOrder({ version: 1, pages: { page: first, b1: blankPageRecord("b1") } })).toEqual(["page", "b1"]);
  });
});

describe("mergeNotePages", () => {
  it("keeps what both devices added, in an order that does not depend on who is incoming", () => {
    const base = list(blank("b1"), blank("b2"));
    const a = list(blank("b1"), blank("x"), blank("b2"));
    const b = list(blank("b1"), blank("y"), blank("b2"));
    const ab = mergeNotePages(encodeNotePages(base), encodeNotePages(a), encodeNotePages(b));
    const ba = mergeNotePages(encodeNotePages(base), encodeNotePages(b), encodeNotePages(a));
    expect(ab).toEqual(ba);
    expect(ab.clean).toBe(true);
    expect((JSON.parse(ab.merged) as NotePages).runs.map((r) => r.id)).toEqual(["b1", "x", "y", "b2"]);
  });

  it("a page either side removed is removed; without a base nothing is removed and the merge is not clean", () => {
    const base = list(blank("b1"), blank("b2"), blank("b3"));
    const merged = mergeNotePages(encodeNotePages(base), encodeNotePages(list(blank("b1"), blank("b3"))), encodeNotePages(base));
    expect((JSON.parse(merged.merged) as NotePages).runs.map((r) => r.id)).toEqual(["b1", "b3"]);
    const noBase = mergeNotePages(null, encodeNotePages(list(blank("b1"), blank("b3"))), encodeNotePages(list(blank("b1"), blank("b2"))));
    expect((JSON.parse(noBase.merged) as NotePages).runs.map((r) => r.id)).toEqual(["b1", "b2", "b3"]);
    expect(noBase.clean).toBe(false);
  });

  it("two devices cut the same run at once: each page once, ids unique, no page's key changes", () => {
    const base = list(pdf("r1", 1, 10));
    const one = insertBlankPage(base, "r1:5", [], counter("p"))!.pages;
    const two = insertBlankPage(base, "r1:3", [], counter("q"))!.pages;
    const merged = mergeNotePages(encodeNotePages(base), encodeNotePages(one), encodeNotePages(two));
    const result = decodeNotePages(merged.merged);
    expect(result.ok).toBe(true);
    const keys = expandNotePages((result as { ok: true; pages: NotePages }).pages, () => 10).entries.map((e) => e.key);
    expect(keys.filter((k) => k.startsWith("r1:"))).toEqual(Array.from({ length: 10 }, (_, i) => `r1:${i + 1}`));
    expect(keys.filter((k) => !k.startsWith("r1:")).sort()).toEqual(["p2", "q2"]);
    expect(mergeNotePages(encodeNotePages(base), encodeNotePages(two), encodeNotePages(one))).toEqual(merged);
  });

  it("a page deleted in the middle of a run on one device is gone, and the id of the second half stays unique", () => {
    const base = list(pdf("r1", 1, 10));
    const deleted = list(pdf("r1", 1, 4), pdf("d", 6, 10, { keyPrefix: "r1" }));
    const merged = mergeNotePages(encodeNotePages(base), encodeNotePages(deleted), encodeNotePages(base));
    expect(merged.merged).toBe(encodeNotePages(deleted));
    const withTail = mergeNotePages(encodeNotePages(base), encodeNotePages(deleted), encodeNotePages(list(pdf("r1", 1, 10), blank("n"))));
    const { runs } = JSON.parse(withTail.merged) as NotePages;
    expect(new Set(runs.map((r) => r.id)).size).toBe(runs.length);
  });

  it("a side this version cannot read leaves the other side and says so", () => {
    const good = encodeNotePages(list(blank("b1")));
    expect(mergeNotePages(good, "{", good)).toEqual({ merged: good, clean: false });
  });

  it("a list of a version this one does not read is neither merged nor replaced, whichever side it is on", () => {
    const v1 = encodeNotePages(list(blank("b1")));
    const newer = JSON.stringify({ version: 2, runs: [] });
    expect(mergeNotePages(v1, v1.replace("b1", "b2"), newer)).toEqual({ merged: newer, clean: false });
    expect(mergeNotePages(v1, newer, v1)).toEqual({ merged: v1, clean: false });
  });

  it("two sides each valid but not valid together (a blank page's id is the other side's key prefix) give the stored list back, not an invalid one", () => {
    const base = encodeNotePages(list(blank("x")));
    const current = encodeNotePages(list(blank("x"), blank("r1")));
    const incoming = encodeNotePages(list(blank("x"), pdf("r1", 1, 2)));
    expect(mergeNotePages(base, incoming, current)).toEqual({ merged: current, clean: false });
  });

  it("two pages one device added keep its order when a base page that is gone stood between them", () => {
    const base = list(pdf("f1", 1, 3));
    const a = list(pdf("f1", 1, 1), blank("b9"), pdf("a1", 2, 2, { keyPrefix: "f1" }), blank("b1"), pdf("a2", 3, 3, { keyPrefix: "f1" }));
    const c = list(pdf("f1", 1, 1), pdf("c1", 3, 3, { keyPrefix: "f1" }));
    const keys = (merged: string) => expandNotePages((decodeNotePages(merged) as { ok: true; pages: NotePages }).pages, () => 3).entries.map((e) => e.key);
    expect(keys(mergeNotePages(encodeNotePages(base), encodeNotePages(a), encodeNotePages(c)).merged)).toEqual(["f1:1", "b9", "b1", "f1:3"]);
    expect(keys(mergeNotePages(encodeNotePages(base), encodeNotePages(c), encodeNotePages(a)).merged)).toEqual(["f1:1", "b9", "b1", "f1:3"]);
  });
});

describe("what a stored list may name", () => {
  const withFile = (file: string) => JSON.stringify({ version: 1, runs: [{ id: "r1", kind: "pdf", file, from: 1, to: 2 }] });
  it("only this site's own media files: no other address, no path out of the media folder", () => {
    expect(decodeNotePages(withFile("/api/media/a1b2.pdf")).ok).toBe(true);
    for (const file of ["https://example.com/a.pdf", "//example.com/a.pdf", "/api/media/", "/api/media/../x", "/other/a.pdf", "javascript:alert(1)", "a.pdf"]) expect(decodeNotePages(withFile(file)).ok).toBe(false);
  });
  it("is bounded: pages, files and the pages a list can be expanded to", () => {
    const run = (i: number, to: number | null): PageRun => ({ id: `r${i}`, kind: "pdf", file: `/api/media/f${i}.pdf`, from: 1, to });
    expect(decodeNotePages(JSON.stringify({ version: 1, runs: [pdf("r1", 1, 10_001)] })).ok).toBe(false);
    expect(decodeNotePages(JSON.stringify({ version: 1, runs: Array.from({ length: 51 }, (_, i) => run(i, 1)) })).ok).toBe(false);
    expect(decodeNotePages(JSON.stringify({ version: 1, runs: [run(1, 10_000), run(2, 10_000), run(3, 10_000)] })).ok).toBe(false);
    const open = decodeNotePages(JSON.stringify({ version: 1, runs: Array.from({ length: 50 }, (_, i) => run(i, null)) }));
    expect(open.ok).toBe(true);
    expect(expandNotePages((open as { ok: true; pages: NotePages }).pages, () => 10_000).entries.length).toBeLessThanOrEqual(20_000);
  });
});
