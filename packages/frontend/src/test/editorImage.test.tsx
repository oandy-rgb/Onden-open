// Whole-line markdown images `![alt](url)` in the editor (lib/editorEmbeds):
// shown as pictures while the cursor is elsewhere, text again on the cursor.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { editorEmbeds, editorImageSrc, embedEditorFocus, estimateImageLineHeight, forgetImageSizes, imageLineRanges, rememberImageSize } from "../lib/editorEmbeds";

const views: EditorView[] = [];
afterEach(() => { for (const v of views.splice(0)) v.destroy(); forgetImageSizes(); });

const MEDIA = "![Screenshot](/api/media/c32c0f0c.webp)";
function open(doc: string, anchor = 0) {
  const view = new EditorView({
    parent: document.body.appendChild(document.createElement("div")),
    state: EditorState.create({ doc, selection: { anchor }, extensions: [markdown({ base: markdownLanguage }), editorEmbeds(() => ({ nodes: [], from: null }))] }),
  });
  views.push(view);
  act(() => { view.dispatch({ effects: embedEditorFocus.of(true) }); });
  return view;
}
const ranges = (doc: string) => imageLineRanges(open(doc, doc.length).state);

describe("markdown images in the editor", () => {
  it("turns a whole-line image into a picture and leaves the text unchanged", () => {
    const doc = `intro\n\n${MEDIA}\n\nafter`;
    const view = open(doc);
    const img = view.dom.querySelector<HTMLImageElement>(".cm-embed img.cm-md-image");
    expect(img?.getAttribute("src")).toBe("/api/media/c32c0f0c.webp");
    expect(img?.alt).toBe("Screenshot");
    expect(img?.loading).toBe("eager");
    expect(img?.decoding).toBe("async");
    expect(view.state.doc.toString()).toBe(doc);
  });

  it("shows several images of one line, and the text again while the cursor is on it", () => {
    const doc = "![a](https://x.test/a.png) ![b](/api/media/b.png)";
    expect(imageLineRanges(open(doc, doc.length + 0).state).length).toBe(0);
    const view = open(`hi\n${doc}`);
    expect(view.dom.querySelectorAll(".cm-embed img").length).toBe(2);
    act(() => { view.dispatch({ selection: { anchor: 5 } }); });
    expect(view.dom.querySelector(".cm-embed")).toBeNull();
    expect(view.contentDOM.textContent).toContain("![a](https://x.test/a.png)");
  });

  it("keeps mid-sentence, linked, code, frontmatter and unsafe images as text", () => {
    expect(ranges("see ![a](/api/media/a.png) here\n\nend")).toEqual([]);
    expect(ranges("[![a](/api/media/a.png)](https://x.test)\n\nend")).toEqual([]);
    expect(ranges("```\n![a](/api/media/a.png)\n```\n\nend")).toEqual([]);
    expect(ranges("---\ncover: x\n![a](/api/media/a.png)\n---\n\nend")).toEqual([]);
    expect(ranges("![a](javascript:alert(1))\n\nend")).toEqual([]);
    expect(ranges("![a](data:text/html;base64,AAAA)\n\nend")).toEqual([]);
    expect(ranges("![a](//evil.test/a.png)\n\nend")).toEqual([]);
    expect(editorImageSrc("ftp://x.test/a.png")).toBeNull();
  });

  it("falls back to the alt text, not a broken-image icon, when the picture fails", () => {
    const view = open(`hi\n${MEDIA}`);
    act(() => { view.dom.querySelector("img")!.dispatchEvent(new Event("error")); });
    expect(view.dom.querySelector("img")).toBeNull();
    expect(view.dom.querySelector(".cm-md-image-missing")?.textContent).toBe("Screenshot");
  });

  it("shows the picture once the markdown parse arrives, without a click or an edit", () => {
    // The tablet case: the first screen is drawn before the syntax tree covers
    // the line, so the line starts as text.
    const language = new Compartment();
    const view = new EditorView({
      parent: document.body.appendChild(document.createElement("div")),
      state: EditorState.create({ doc: `${MEDIA}\n\nafter`, extensions: [language.of([]), editorEmbeds(() => ({ nodes: [], from: null }))] }),
    });
    views.push(view);
    act(() => { view.dispatch({ effects: embedEditorFocus.of(true), selection: { anchor: view.state.doc.length } }); });
    expect(view.dom.querySelector(".cm-embed img")).toBeNull();
    act(() => { view.dispatch({ effects: language.reconfigure(markdown({ base: markdownLanguage })) }); });
    expect(view.dom.querySelector(".cm-embed img.cm-md-image")?.getAttribute("src")).toBe("/api/media/c32c0f0c.webp");
  });

  it("fetches a picture as soon as it is drawn, not when a scroll container decides it is near", () => {
    // CodeMirror only draws widgets near the viewport, so "lazy" only adds a delay.
    const view = open(`hi\n${MEDIA}`);
    expect(view.dom.querySelector<HTMLImageElement>("img.cm-md-image")?.loading).toBe("eager");
  });
});

// A phone photo is ~600 px tall; CodeMirror draws the widget only near the viewport and builds a new <img> each time,
// so a redrawn picture must keep its size (no 0 → 600 jump while the person scrolls).
describe("image sizes survive a redraw", () => {
  const photo = "/api/media/photo.webp";
  const line = [{ alt: "p", src: photo }];

  it("estimates a never-loaded picture blind, and a loaded one from its real shape at the content width", () => {
    expect(estimateImageLineHeight(line, 360, 520)).toBe(120 + 28);
    rememberImageSize(photo, 1200, 1600);
    // 1200×1600 at width 360 is 480 tall, under the 520 cap.
    expect(estimateImageLineHeight(line, 360, 520)).toBe(480 + 28);
    // A wider column hits the height cap instead.
    expect(estimateImageLineHeight(line, 1000, 520)).toBe(520 + 28);
    // Never enlarged past its own size.
    rememberImageSize("/api/media/small.webp", 100, 50);
    expect(estimateImageLineHeight([{ alt: "", src: "/api/media/small.webp" }], 360, 520)).toBe(50 + 28);
  });

  it("ignores a size of 0 (a failed decode)", () => {
    rememberImageSize(photo, 0, 0);
    expect(estimateImageLineHeight(line, 360, 520)).toBe(120 + 28);
  });

  it("gives a redrawn <img> its box at once, and drops that box once the pixels are in", () => {
    rememberImageSize(photo, 1200, 1600);
    // happy-dom has no layout: give the content a 360 px width.
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(360);
    const innerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { value: 1000, configurable: true });
    try {
      const view = open(`intro\n\n![p](${photo})\n\nafter`);
      const img = view.dom.querySelector<HTMLImageElement>("img.cm-md-image")!;
      expect([img.style.width, img.style.height]).toEqual(["360px", "480px"]);
      img.dispatchEvent(new Event("load"));
      expect([img.style.width, img.style.height]).toEqual(["", ""]);
    } finally { width.mockRestore(); Object.defineProperty(window, "innerHeight", { value: innerHeight, configurable: true }); }
  });

  it("learns the size from the first load", () => {
    const view = open(`intro\n\n![p](${photo})\n\nafter`);
    const img = view.dom.querySelector<HTMLImageElement>("img.cm-md-image")!;
    Object.defineProperty(img, "naturalWidth", { value: 1200 });
    Object.defineProperty(img, "naturalHeight", { value: 1600 });
    img.dispatchEvent(new Event("load"));
    expect(estimateImageLineHeight(line, 360, 520)).toBe(480 + 28);
  });
});
