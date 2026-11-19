// @vitest-environment jsdom
// The 「手寫」 tab of a note whose pages are listed in `note_pages`: blank pages and three pages of a PDF file, in order, with the
// file as each PDF page's background; strokes drawn on a PDF page and on a blank page come back after a reload; a PDF file that
// is not on this device is said in a sentence; a note made before (note_ink alone, a PDF note) is shown as it was.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import HandwritingPane from "../modules/handwriting/HandwritingPane";
import { apiFetch, type ContentNode } from "../lib/api";
import { saveInk } from "../lib/data/inkWriter";
import { saveNotePages } from "../lib/data/notePagesWriter";
import { encodeInk, type InkDocument } from "@onden/markdown/ink";
import { encodeNotePages, type NotePages } from "@onden/markdown/note-pages";
import { fakePdf, settlePdf } from "./helpers/fakePdf";

vi.mock("../lib/pdf/pdfjs", async () => (await import("./helpers/fakePdf")).fakePdfjsModule());
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), apiFetch: vi.fn() }));
vi.mock("../lib/data/notePagesWriter", () => ({ saveNotePages: vi.fn() }));
vi.mock("../lib/data/inkWriter", async (original) => ({ ...await original<typeof import("../lib/data/inkWriter")>(), saveInk: vi.fn() }));

const node: ContentNode = { id: "n1", title: "Lecture", slug: "lecture", markdown: "words", node_type: "content", source_type: "manual" };
const list: NotePages = { version: 1, runs: [{ id: "b1", kind: "blank" }, { id: "r1", kind: "pdf", file: "/api/media/a.pdf", from: 1, to: 3 }, { id: "b2", kind: "blank" }] };
const sheets = () => [...document.querySelectorAll<HTMLElement>("[data-page-key]")].map((s) => s.dataset.pageKey);

async function open(attrs: Array<{ key: string; value: string }>, canEdit = true) {
  vi.mocked(apiFetch).mockImplementation(async (path) => new Response(JSON.stringify(String(path).startsWith(`/api/nodes/${node.id}/attributes?`) ? attrs : []), { status: 200 }));
  const view = render(<HandwritingPane node={node} canEdit={canEdit} onOpenNode={() => {}} />);
  await waitFor(() => expect(document.querySelector(".pagebook, .handwriting-pane-notice")).not.toBeNull(), { timeout: 15_000 });
  await settlePdf();
  await act(async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); });
  return view;
}

let clock = 0;
function drag(key: string, points: Array<[number, number]>) {
  const surface = document.querySelector(`[data-page-key="${key}"] .page-ink-surface`) as HTMLElement;
  Object.assign(surface, { setPointerCapture: () => {}, releasePointerCapture: () => {} });
  const event = (type: string, [x, y]: [number, number], t: number) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, { pointerId: 1, pointerType: "pen", button: 0, clientX: x, clientY: y, pressure: 0.5, getCoalescedEvents: () => [] });
    Object.defineProperty(e, "timeStamp", { value: t });
    return e;
  };
  clock += 2000;
  act(() => {
    surface.dispatchEvent(event("pointerdown", points[0]!, clock));
    points.slice(1).forEach((p, i) => surface.dispatchEvent(event("pointermove", p, clock + 20 * (i + 1))));
    surface.dispatchEvent(event("pointerup", points[points.length - 1]!, clock + 20 * points.length));
  });
}

beforeEach(() => {
  fakePdf.reset();
  fakePdf.pages = [{ width: 600, height: 800 }, { width: 600, height: 800 }, { width: 600, height: 800 }];
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) { return this.classList.contains("pagebook-scroll") ? 624 : 0; });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return (this.classList.contains("page-ink-canvas") ? null : {}) as unknown as CanvasRenderingContext2D;
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(saveInk).mockReset(); vi.mocked(saveNotePages).mockReset(); localStorage.clear(); });

describe("a note whose pages are listed in note_pages", () => {
  it("shows blank, the PDF's three pages, blank — in order, each PDF page drawn from the file", async () => {
    await open([{ key: "note_pages", value: encodeNotePages(list) }]);
    expect(sheets()).toEqual(["b1", "r1:1", "r1:2", "r1:3", "b2"]);
    expect([...document.querySelectorAll("[data-pdf-page]")].map((el) => el.getAttribute("data-pdf-page"))).toEqual(["1", "2", "3"]);
    expect(document.querySelector(".handwriting-pane-notice")).toBeNull();
  });

  it("saves strokes drawn on a PDF page and on a blank page under their keys, and shows them again after a reload", async () => {
    await open([{ key: "note_pages", value: encodeNotePages(list) }]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    drag("r1:2", [[100, 100], [200, 150], [300, 200], [320, 260]]);
    drag("b1", [[100, 100], [200, 150], [300, 200], [320, 260]]);
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(saveInk).toHaveBeenCalled();
    const doc = vi.mocked(saveInk).mock.calls.at(-1)![1] as InkDocument;
    expect(doc.morePages?.carrier).toBe(true);
    expect(Object.keys(doc.morePages!.pages).sort()).toEqual(["b1", "r1:2"]);
    expect(doc.morePages!.order).toEqual(["b1", "r1:2"]);
    expect(doc.strokes).toEqual([]); // the carrier first page is empty

    cleanup();
    vi.useRealTimers();
    await open([{ key: "note_pages", value: encodeNotePages(list) }, { key: "note_ink", value: encodeInk(doc) }], false); // read-only: the pages draw their strokes as pictures
    expect(sheets()).toEqual(["b1", "r1:1", "r1:2", "r1:3", "b2"]);
    const inked = (key: string) => document.querySelector(`[data-page-key="${key}"] .page-ink-svg`) !== null;
    expect(["b1", "r1:1", "r1:2", "r1:3", "b2"].map(inked)).toEqual([true, false, true, false, false]);
  });

  it("a PDF file that is not on this device is said in a sentence, not shown as a blank notebook; strokes already on its pages stay", async () => {
    fakePdf.failOpen = true;
    const openEnded: NotePages = { version: 1, runs: [{ id: "r1", kind: "pdf", file: "/api/media/a.pdf", from: 1, to: null }, { id: "b2", kind: "blank" }] };
    await open([{ key: "note_pages", value: encodeNotePages(openEnded) }]);
    expect(document.querySelector(".handwriting-pane-notice")?.textContent).toBe("A PDF of this note is not on this device yet. It appears when you are online.");
    expect(sheets()).toEqual(["b2"]);
  });

  it("a page with strokes that the list does not name (its list write was lost, or another device removed it) is shown last with a line saying so", async () => {
    const stroke = { id: "s1", points: [[1, 1], [30, 30], [60, 40]], color: "#000", size: 2, toolId: "pen" };
    const ink: InkDocument = { version: 1, strokes: [], erased: {}, page: { width: 1000 }, requires: ["note-pages"], morePages: { version: 1, carrier: true, order: ["lost1"], pages: { lost1: { key: "lost1", background: { kind: "blank" }, size: { width: 1000, height: 1400 }, doc: { version: 1, strokes: [stroke], erased: {}, page: { width: 1000 } } } } } } as unknown as InkDocument;
    await open([{ key: "note_pages", value: encodeNotePages(list) }, { key: "note_ink", value: encodeInk(ink) }]);
    expect(sheets()).toEqual(["b1", "r1:1", "r1:2", "r1:3", "b2", "lost1"]);
    expect(document.querySelector('[data-page-key="lost1"] .handwriting-unlisted-note')?.textContent).toBe("This page is not in the note's page list.");
    expect(document.querySelectorAll(".handwriting-unlisted-note")).toHaveLength(1);
  });

  it("'+ Add page' writes the list first (a blank run at the end) and then shows the page", async () => {
    await open([{ key: "note_pages", value: encodeNotePages(list) }]);
    fireEvent.click(screen.getByText("+ Add page"));
    await act(async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); });
    expect(sheets()).toHaveLength(6);
    expect(saveNotePages).toHaveBeenCalledTimes(1);
    const [nodeId, value, base] = vi.mocked(saveNotePages).mock.calls[0]!;
    expect([nodeId, base]).toEqual(["n1", encodeNotePages(list)]);
    const written = JSON.parse(value) as NotePages;
    expect(written.runs.slice(0, 3)).toEqual(list.runs);
    expect(written.runs[3]).toMatchObject({ kind: "blank" });
    expect(sheets()[5]).toBe(written.runs[3]!.id);
  });
});

describe("a note made before note_pages is shown as it was", () => {
  const first: InkDocument = { version: 1, strokes: [{ id: "s1", points: [[1, 1], [30, 30], [60, 40]], color: "#000", size: 2, toolId: "pen" }], erased: {}, page: { width: 1000 } };

  it("a handwriting notebook (note_ink alone): its first page, `page`, is a page", async () => {
    await open([{ key: "note_ink", value: encodeInk(first) }]);
    expect(sheets()).toEqual(["page"]);
    expect(document.querySelector(".handwriting-pane-notice")).toBeNull();
  });

  it("a notebook with several pages keeps them all, `page` first", async () => {
    const more: InkDocument = { ...first, morePages: { version: 1, pages: { u1: { key: "u1", background: { kind: "blank" }, size: { width: 1000, height: 1400 }, doc: first } }, order: ["page", "u1"] } };
    await open([{ key: "note_ink", value: encodeInk(more) }]);
    expect(sheets()).toEqual(["page", "u1"]);
  });

  it("a note with a pdf_url but no note_pages is not turned into PDF pages in the 「手寫」 tab (its strokes live in ink_data, shown by the content tab)", async () => {
    await open([{ key: "pdf_url", value: "/api/media/a.pdf" }, { key: "note_ink", value: encodeInk(first) }]);
    expect(sheets()).toEqual(["page"]);
    expect(document.querySelector("[data-pdf-page]")).toBeNull();
  });
});
