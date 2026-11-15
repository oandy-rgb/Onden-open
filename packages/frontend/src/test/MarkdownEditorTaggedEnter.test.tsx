import { describe, it, expect, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { parseBlocks } from "@onden/markdown";
import MarkdownEditor from "../components/MarkdownEditor";

// 2026-11-07 (Android 注音): Enter once after `文字 {複習}`, then typing, left `{複習}` mid-paragraph — plain
// text, the paragraph lost its tag. Enter after a paragraph's `{…}` now opens a new paragraph, by keyboard
// and by the touch keyboard's beforeinput; during composition the editor does not touch the text.

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

function setup(value: string, at?: number) {
  const { container } = render(<MarkdownEditor value={value} onChange={vi.fn()} nodes={[]} onMediaInsert={vi.fn(async () => null)} />);
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
  view.focus();
  view.dispatch({ selection: { anchor: at ?? view.state.doc.length } });
  return view;
}
const type = (view: EditorView, text: string) => {
  const at = view.state.selection.main.head;
  view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: "input.type" });
};
const tagged = (doc: string) => parseBlocks(doc).filter((b) => b.tags.includes("複習"));

const key = (view: EditorView, init: KeyboardEventInit) => fireEvent.keyDown(view.contentDOM, { key: "Enter", ...init });
const touchEnter = (view: EditorView, inputType = "insertParagraph") =>
  view.contentDOM.dispatchEvent(new InputEvent("beforeinput", { inputType, bubbles: true, cancelable: true }));

describe("Enter in a paragraph with a {…} cuts it in two (業主 2026-11-08)", () => {
  it("after the tag: a new paragraph, so the tag stays on its own paragraph after typing", () => {
    const view = setup("我發現不 {複習}");
    key(view, {});
    expect(view.state.doc.toString()).toBe("我發現不 {複習}\n\n");
    type(view, "新打的字");
    const doc = view.state.doc.toString();
    expect(tagged(doc)).toHaveLength(1);
    expect(doc.slice(tagged(doc)[0]!.start, tagged(doc)[0]!.end)).toBe("我發現不 {複習}");
  });

  it("in the middle of the text: two paragraphs, the tag with the second half, the caret at its start", () => {
    const view = setup("前半後半 {複習}", "前半".length);
    key(view, {});
    expect(view.state.doc.toString()).toBe("前半\n\n後半 {複習}");
    expect(view.state.selection.main.head).toBe("前半\n\n".length);
    expect(tagged(view.state.doc.toString())).toHaveLength(1);
  });

  it("with the caret inside the braces: cuts after the `}`, the tag is not broken", () => {
    const view = setup("文字 {複習}", "文字 {複".length);
    key(view, {});
    expect(view.state.doc.toString()).toBe("文字 {複習}\n\n");
  });

  it("Shift+Enter is a line break inside the same paragraph", () => {
    const view = setup("前半後半 {複習}", "前半".length);
    key(view, { shiftKey: true });
    expect(view.state.doc.toString()).toBe("前半\n後半 {複習}");
  });

  it("a touch keyboard (no Shift, beforeinput only) always cuts, for insertParagraph and insertLineBreak", () => {
    const a = setup("前半後半 {複習}", "前半".length);
    touchEnter(a);
    expect(a.state.doc.toString()).toBe("前半\n\n後半 {複習}");
    const b = setup("前半後半 {複習}", "前半".length);
    touchEnter(b, "insertLineBreak");
    expect(b.state.doc.toString()).toBe("前半\n\n後半 {複習}");
  });

  it("leaves Enter to the IME while composing — the text is not rewritten, anywhere in the paragraph", () => {
    for (const at of [undefined, "前半".length, "前半後半 {複".length]) {
      const view = setup("前半後半 {複習}", at);
      Object.defineProperty(view, "composing", { get: () => true });
      touchEnter(view);
      touchEnter(view, "insertLineBreak");
      // (A keydown mid-composition never reaches the keymap in a browser; jsdom cannot start a real composition.)
      expect(view.state.doc.toString()).toBe("前半後半 {複習}");
    }
  });

  it("does not change Enter after plain text or in a list item, and a `^word` after the tag is plain text", () => {
    const plain = setup("沒有標籤");
    key(plain, {});
    expect(plain.state.doc.toString()).toBe("沒有標籤\n");
    const item = setup("- 清單 {複習}");
    key(item, {});
    expect(item.state.doc.toString()).toBe("- 清單 {複習}\n- ");
    const word = setup("文字 {複習} ^18ee1c");
    key(word, {});
    expect(word.state.doc.toString()).toBe("文字 {複習} ^18ee1c\n");
  });
});
