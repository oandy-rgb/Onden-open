// @vitest-environment jsdom
// `![[note|ink=頁@x,y,w,h]]` in the app: a quoted area of a handwriting page, drawn in the preview
// (MarkdownRenderer → lib/embedDom) and in the editor (lib/editorEmbeds), redrawn when the source's
// strokes are saved, opened at the area on a tap, and never shown as its syntax or as an empty frame.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { encodeInk, type InkDocument } from "@onden/markdown/ink";
import type { ContentNode } from "../lib/api";

const stroke = (id: string, points: Array<[number, number]>) => ({ id, color: "#1e1e1e", size: 4, toolId: "pen" as const, points });
const inkOf = (strokes: InkDocument["strokes"]): InkDocument => ({ version: 1, erased: {}, page: { width: 1000 }, strokes });
const stored = new Map<string, Record<string, string | null>>();
const { reads } = await import("../lib/data");
const fake = (async (id: string, keys: readonly string[]) =>
  Object.fromEntries(keys.map((k) => [k, stored.get(id)?.[k] ?? null]))) as typeof reads.notes.attributeValues;
let loadInk = vi.spyOn(reads.notes, "attributeValues").mockImplementation(fake);

const { resolveEmbed } = await import("../lib/embeds");
const { resetDrawingCache } = await import("../lib/embedSources");
const { announceDrawingChange, announceDrawingChangesOf } = await import("../lib/drawingChanges");
const { takeInkRegionFocus } = await import("../lib/inkRegionFocus");
const { editorEmbeds, embedEditorFocus } = await import("../lib/editorEmbeds");
const { default: MarkdownRenderer } = await import("../components/MarkdownRenderer");

const drawing = { id: "d1", title: "手寫 筆記", slug: "ink", markdown: "", node_type: "content" } as unknown as ContentNode;
const twin = { id: "d2", title: "手寫 筆記", slug: "ink-2", markdown: "", node_type: "content" } as unknown as ContentNode;
const nodes = [drawing];
const IN = "![[手寫 筆記|ink=page@100,100,300,200]]";
const EMPTY = "![[手寫 筆記|ink=page@600,600,100,100]]";
const GONE = "![[手寫 筆記|ink=deleted-page@0,0,100,100]]";

beforeEach(() => {
  resetDrawingCache();
  loadInk = vi.spyOn(reads.notes, "attributeValues").mockImplementation(fake);
  stored.clear();
  stored.set("d1", { ink_data: encodeInk(inkOf([stroke("a", [[120, 120], [200, 160], [300, 130]])])) });
});

describe("resolution", () => {
  it("names the note by title, or by id when the title cannot say which", () => {
    expect(resolveEmbed("手寫 筆記|ink=page@1,2,30,40", null, nodes)).toMatchObject({ kind: "note", node: { id: "d1" }, ref: { inkRegion: { page: "page", x: 1, y: 2, w: 30, h: 40 } } });
    expect(resolveEmbed("onden://node/00000000-0000-4000-8000-000000000002|ink=page@1,2,30,40", null, [drawing, { ...twin, id: "00000000-0000-4000-8000-000000000002" } as ContentNode]))
      .toMatchObject({ kind: "note", node: { slug: "ink-2" } });
    expect(resolveEmbed("onden://node/00000000-0000-4000-8000-000000000009|ink=page@1,2,30,40", null, nodes).kind).toBe("missing");
  });
});

describe("preview", () => {
  it("draws only the area, at a width that follows the area, with an open button", async () => {
    const onNavigate = vi.fn();
    const { container, findByText } = render(<MarkdownRenderer nodes={nodes} onNavigate={onNavigate}>{IN}</MarkdownRenderer>);
    await waitFor(() => expect(container.querySelector(".md-drawing-picture--region svg")).not.toBeNull());
    const svg = container.querySelector(".md-drawing-picture svg")!;
    expect(svg.getAttribute("viewBox")).toBe("100.0 100.0 300.0 200.0");
    expect((container.querySelector(".md-drawing-picture") as HTMLElement).style.getPropertyValue("--region-w")).toBe("300");
    expect(container.textContent).not.toContain("ink=");
    fireEvent.click(await findByText("Open drawing"));
    expect(onNavigate).toHaveBeenCalledWith("ink", "d1", undefined);
    // The handwriting view that opens takes the area once and scrolls to it.
    expect(takeInkRegionFocus("d1")).toMatchObject({ page: "page", x: 100, y: 100, w: 300, h: 200 });
    expect(takeInkRegionFocus("d1")).toBeNull();
  });

  it("an area with nothing in it, a page that is gone, a note that is not readable: a sentence, never syntax or an empty frame", async () => {
    const { container } = render(<MarkdownRenderer nodes={nodes} onNavigate={() => {}}>{`${EMPTY}\n\n${GONE}\n\n![[沒有這則|ink=page@1,2,30,40]]`}</MarkdownRenderer>);
    await waitFor(() => expect([...container.querySelectorAll(".md-embed-notice")].map((n) => n.textContent)).toEqual([
      "Nothing is written in this area now", "This handwriting page was deleted", "Not found",
    ]));
    expect(container.querySelector(".md-drawing-picture")).toBeNull();
    expect(container.textContent).not.toContain("ink=");
  });

  it("redraws when the drawing is saved here", async () => {
    const { container } = render(<MarkdownRenderer nodes={nodes} onNavigate={() => {}}>{IN}</MarkdownRenderer>);
    await waitFor(() => expect(container.querySelectorAll(".md-drawing-picture path")).toHaveLength(1));
    stored.set("d1", { ink_data: encodeInk(inkOf([stroke("a", [[120, 120], [200, 160], [300, 130]]), stroke("b", [[150, 250], [250, 270]])])) });
    act(() => announceDrawingChange("d1"));
    await waitFor(() => expect(container.querySelectorAll(".md-drawing-picture path")).toHaveLength(2));
  });

  it("redraws when the drawing arrives from another device (a sync delta)", async () => {
    const { container } = render(<MarkdownRenderer nodes={nodes} onNavigate={() => {}}>{IN}</MarkdownRenderer>);
    await waitFor(() => expect(container.querySelectorAll(".md-drawing-picture path")).toHaveLength(1));
    stored.set("d1", { ink_data: encodeInk(inkOf([stroke("a", [[120, 120], [200, 160], [300, 130]]), stroke("z", [[150, 250], [250, 270]])])) });
    act(() => announceDrawingChangesOf({ attributes: { upsert: [{ node_id: "d1", key: "ink_data" }] } }));
    await waitFor(() => expect(container.querySelectorAll(".md-drawing-picture path")).toHaveLength(2));
    // A rename (a note row alone) is no change of its drawing: nothing is read again.
    const callsBefore = vi.mocked(loadInk).mock.calls.length;
    act(() => announceDrawingChangesOf({ attributes: { upsert: [{ node_id: "d1", key: "title" }] } }));
    await new Promise((r) => setTimeout(r, 30));
    expect(vi.mocked(loadInk).mock.calls.length).toBe(callsBefore);
  });

  it("many quotes of one drawing share one read per change", async () => {
    const { container } = render(<MarkdownRenderer nodes={nodes} onNavigate={() => {}}>{`${IN}\n\n${IN}\n\n${IN}`}</MarkdownRenderer>);
    await waitFor(() => expect(container.querySelectorAll(".md-drawing-picture svg")).toHaveLength(3));
    const before = vi.mocked(loadInk).mock.calls.length;
    stored.set("d1", { ink_data: encodeInk(inkOf([stroke("a", [[120, 120], [200, 160], [300, 130]]), stroke("q", [[150, 250], [250, 270]])])) });
    act(() => announceDrawingChange("d1"));
    await waitFor(() => expect(container.querySelectorAll(".md-drawing-picture path")).toHaveLength(6));
    expect(vi.mocked(loadInk).mock.calls.length - before).toBe(1);
  });

  it("a note that is not handwriting says so, not that a page was deleted", async () => {
    stored.set("d1", { ink_data: null });
    const { container } = render(<MarkdownRenderer nodes={nodes} onNavigate={() => {}}>{IN}</MarkdownRenderer>);
    await waitFor(() => expect(container.querySelector(".md-embed-notice")?.textContent).toBe("This note has no handwriting"));
    stored.set("d1", { ink_data: null, pdf_url: "/api/media/x.pdf" });
  });

  it("a text box alone in the area is drawn", async () => {
    stored.set("d1", { ink_data: encodeInk(inkOf([])), page_text: JSON.stringify({ v: 1, pages: { page: { boxes: [{ id: "b", x: 120, y: 120, w: 200, text: "推導", size: 22, color: "#1e1e1e", align: "left", updated_at: "" }] } } }) });
    const { container } = render(<MarkdownRenderer nodes={nodes} onNavigate={() => {}}>{IN}</MarkdownRenderer>);
    await waitFor(() => expect(container.querySelector(".md-drawing-picture svg text")?.textContent).toBe("推導"));
  });

  it("an area that was empty shows what is later written in it", async () => {
    const { container } = render(<MarkdownRenderer nodes={nodes} onNavigate={() => {}}>{EMPTY}</MarkdownRenderer>);
    await waitFor(() => expect(container.querySelector(".md-embed-notice")).not.toBeNull());
    stored.set("d1", { ink_data: encodeInk(inkOf([stroke("c", [[620, 620], [680, 660]])])) });
    act(() => announceDrawingChange("d1"));
    await waitFor(() => expect(container.querySelector(".md-drawing-picture svg")).not.toBeNull());
  });
});

describe("editor", () => {
  const views: EditorView[] = [];
  afterEach(() => { views.splice(0).forEach((v) => { v.dom.parentElement?.remove(); v.destroy(); }); });

  it("shows the area in place of the line, and the syntax again when the cursor is on it", async () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({ parent, state: EditorState.create({ doc: `# T\n\n${IN}\n`, selection: { anchor: 0 }, extensions: [editorEmbeds(() => ({ nodes, from: null, onOpen: vi.fn() }))] }) });
    views.push(view);
    await waitFor(() => expect(view.dom.querySelector(".cm-embed .md-drawing-picture--region svg")).not.toBeNull());
    act(() => { view.dispatch({ selection: { anchor: view.state.doc.line(3).from + 4 }, effects: embedEditorFocus.of(true) }); });
    expect(view.dom.querySelector(".cm-embed")).toBeNull();
    expect(view.contentDOM.textContent).toContain(IN);
  });
});
