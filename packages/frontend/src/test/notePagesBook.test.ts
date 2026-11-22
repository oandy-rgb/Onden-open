import { describe, expect, it } from "vitest";
import { blankPageRecord, inkPageOrder, noteDoc, notePages, type InkDocument, type InkPages } from "@onden/markdown/ink";
import { encodeNotePages, type NotePages } from "@onden/markdown/note-pages";
import { buildNoteBook, pagesToStore, type FileState } from "../modules/handwriting/notePagesBook";

// The pages of a note whose list is note_pages, as the page book shows and saves them (modules/handwriting/notePagesBook.ts).

const stroke = { id: "s1", points: [[1, 1], [20, 20]] as [number, number][], color: "#000", size: 2, toolId: "pen" as const };
const withStroke = (): InkDocument => ({ version: 1, strokes: [stroke], erased: {}, page: { width: 1000 } });
const list: NotePages = { version: 1, runs: [{ id: "b1", kind: "blank" }, { id: "r1", kind: "pdf", file: "/api/media/a.pdf", from: 1, to: 3 }, { id: "b2", kind: "blank" }] };
const open = (ratio = 1.4): Record<string, FileState> => ({ "/api/media/a.pdf": { status: "ready", shape: { count: 3, ratio: () => ratio } } });
const none: InkPages = { version: 1, pages: {} };

describe("the book of a note with a page list", () => {
  it("lays out blank, the PDF's three pages at the file's shape, blank — in the list's order, the carrier not among them", () => {
    const book = buildNoteBook(list, none, open());
    expect(inkPageOrder(book.pages)).toEqual(["b1", "r1:1", "r1:2", "r1:3", "b2"]);
    expect(book.pages.pages["r1:2"]!.size).toEqual({ width: 1000, height: 1400 });
    expect(book.pages.pages["r1:2"]!.background).toEqual({ kind: "pdf", page: 2 });
    expect(book.pages.pages.b1!.background).toEqual({ kind: "blank" });
    expect(book.sizes).toEqual({ "r1:1": { width: 1000, height: 1400 }, "r1:2": { width: 1000, height: 1400 }, "r1:3": { width: 1000, height: 1400 } });
    expect(book.settled).toBe(true);
  });

  it("is not laid out while a file is still opening", () => {
    expect(buildNoteBook(list, none, {}).settled).toBe(false);
    expect(buildNoteBook(list, none, { "/api/media/a.pdf": { status: "missing" } }).settled).toBe(true);
  });

  it("shows the strokes stored under a page's key; a page the list no longer names is shown after the listed ones, not dropped", () => {
    const stored: InkPages = { version: 1, pages: { "r1:2": { ...blankPageRecord("r1:2"), doc: withStroke() }, gone: { ...blankPageRecord("gone"), doc: withStroke() } } };
    const book = buildNoteBook(list, stored, open());
    expect(book.pages.pages["r1:2"]!.doc.strokes).toHaveLength(1);
    expect(book.unlisted.has("gone")).toBe(true);
    expect(inkPageOrder(book.pages).at(-1)).toBe("gone");
  });

  it("stores only pages with strokes, in the list's order, a PDF page at its file's shape; an empty page has no record", () => {
    const book = buildNoteBook(list, none, open(1.5));
    const edited: InkPages = { ...book.pages, pages: { ...book.pages.pages, "r1:3": { ...book.pages.pages["r1:3"]!, doc: withStroke() }, b1: { ...book.pages.pages.b1!, doc: withStroke() } } };
    const stored = pagesToStore(edited, book);
    expect(stored.order).toEqual(["b1", "r1:3"]);
    expect(Object.keys(stored.pages)).toEqual(["b1", "r1:3"]);
    expect(stored.pages["r1:3"]!.size).toEqual({ width: 1000, height: 1500 });
    expect(stored.carrier).toBe(true);
  });

  it("a file that is not here: its pages that have strokes are listed and kept when saving, the others are not made up", () => {
    const openEnded: NotePages = { version: 1, runs: [{ id: "r1", kind: "pdf", file: "/api/media/a.pdf", from: 1, to: null }, { id: "b2", kind: "blank" }] };
    const stored: InkPages = { version: 1, pages: { "r1:5": { ...blankPageRecord("r1:5"), background: { kind: "pdf", page: 5 }, doc: withStroke() } } };
    const book = buildNoteBook(openEnded, stored, { "/api/media/a.pdf": { status: "missing" } });
    expect(book.missing).toEqual(["/api/media/a.pdf"]);
    expect(inkPageOrder(book.pages)).toEqual(["r1:5", "b2"]);
    expect(Object.keys(pagesToStore(book.pages, book).pages)).toEqual(["r1:5"]);
  });

  it("a page of the note's own list, stored by the list's value, is what NotePagesBook writes (the value round-trips)", () => {
    expect(JSON.parse(encodeNotePages(list))).toEqual({ version: 1, runs: [{ id: "b1", kind: "blank" }, { id: "r1", kind: "pdf", file: "/api/media/a.pdf", from: 1, to: 3 }, { id: "b2", kind: "blank" }] });
  });

  // ── A save never deletes strokes because the list does not name their page ──
  const strokesOn = (key: string): InkPages["pages"][string] => ({ ...blankPageRecord(key), doc: withStroke() });
  const bytesOf = (pages: InkPages, key: string) => JSON.stringify(pages.pages[key]);

  it("a page with strokes that the list does not name (another device took it out) is shown after the listed pages and kept byte for byte when something else is saved", () => {
    const stored: InkPages = { version: 1, pages: { orphan: strokesOn("orphan") }, carrier: true, order: ["orphan"] };
    const book = buildNoteBook(list, stored, open());
    expect(inkPageOrder(book.pages)).toEqual(["b1", "r1:1", "r1:2", "r1:3", "b2", "orphan"]);
    expect([...book.unlisted]).toEqual(["orphan"]);
    const edited: InkPages = { ...book.pages, pages: { ...book.pages.pages, b1: { ...book.pages.pages.b1!, doc: withStroke() } } };
    const saved = pagesToStore(edited, book);
    expect(bytesOf(saved, "orphan")).toBe(bytesOf(stored, "orphan"));
    expect(Object.keys(saved.pages).sort()).toEqual(["b1", "orphan"]);
  });

  it("a notebook that had pages of its own before it had a list keeps them: its first page and its further pages are shown, not hidden, and saved back as they were", () => {
    const own = notePages({ ...withStroke(), morePages: { version: 1, pages: { u1: strokesOn("u1") }, order: ["page", "u1"] } });
    const book = buildNoteBook(list, own, open());
    expect(inkPageOrder(book.pages)).toEqual(["b1", "r1:1", "r1:2", "r1:3", "b2", "page", "u1"]);
    const saved = pagesToStore(book.pages, book);
    expect(bytesOf(saved, "u1")).toBe(bytesOf(own, "u1"));
    const doc = noteDoc(saved)!;
    expect(doc.strokes).toHaveLength(1); // the notebook's own first page is still the document's first page
    expect(doc.morePages?.carrier).toBeUndefined();
    expect(Object.keys(doc.morePages!.pages)).toEqual(["u1"]);
  });

  it("an empty carrier is not a page; a carrier that something was drawn on (an app from before wrote there) is", () => {
    const carrier = notePages(noteDoc({ version: 1, pages: { u1: strokesOn("u1") }, carrier: true }));
    expect(buildNoteBook(list, carrier, open()).unlisted.has("page")).toBe(false);
    const drawnOn: InkPages = { ...carrier, pages: { ...carrier.pages, page: strokesOn("page") } };
    const book = buildNoteBook(list, drawnOn, open());
    expect(book.unlisted.has("page")).toBe(true);
    expect(pagesToStore(book.pages, book).pages.page!.doc.strokes).toHaveLength(1);
  });

  it("taking the last stroke away is a save too: the document is still written (nothing is left in it but the carrier)", () => {
    const stored: InkPages = { version: 1, pages: { "r1:2": strokesOn("r1:2") }, order: ["r1:2"], carrier: true };
    const book = buildNoteBook(list, stored, open());
    const edited: InkPages = { ...book.pages, pages: { ...book.pages.pages, "r1:2": { ...book.pages.pages["r1:2"]!, doc: { ...withStroke(), strokes: [] } } } };
    const doc = noteDoc(pagesToStore(edited, book));
    expect(doc).not.toBeNull();
    expect(doc!.morePages?.carrier).toBe(true);
    expect(doc!.requires).toEqual(["note-pages"]);
    expect(Object.keys(doc!.morePages!.pages)).toEqual([]);
  });
});
