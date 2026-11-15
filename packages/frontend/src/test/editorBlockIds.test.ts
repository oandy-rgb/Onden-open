import { afterEach, describe, expect, it } from "vitest";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { editorBlocks } from "../lib/editorBlocks";

// A paragraph's identity is not in the text (段落錨點批 3): the editor hides nothing and protects nothing, so what the
// person types is what the note says. Run against real CodeMirror state.
// Not covered here (jsdom has no input method): a phone keyboard's composing at a line end. The bug it was
// (2026-11-01) needed a hidden `^id` after the caret; with no mark in the text there is nothing to land after.

const views: EditorView[] = [];
function open(doc: string, cursor = 0) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc, selection: { anchor: cursor }, extensions: [history(), editorBlocks] }) });
  views.push(view);
  return view;
}
afterEach(() => { views.splice(0).forEach((v) => { v.dom.parentElement?.remove(); v.destroy(); }); });

const text = (v: EditorView) => v.state.doc.toString();
const edit = (v: EditorView, spec: TransactionSpec) => v.dispatch(spec);

describe("a caret-like text `^id` is just text", () => {
  it("is shown as typed: nothing in the line is hidden", () => {
    const v = open("段落 ^a1");
    expect(v.contentDOM.textContent).toContain("^a1");
  });

  it("deleting a paragraph's words takes nothing else with them", () => {
    const v = open("第一段\n\n第二段 ^b2");
    edit(v, { changes: { from: 0, to: 3 }, userEvent: "delete.selection" });
    expect(text(v)).toBe("\n\n第二段 ^b2");
  });

  it("a Backspace never skips over the end of a line", () => {
    const doc = "段落 ^a1";
    const v = open(doc, doc.length);
    edit(v, { changes: { from: doc.length - 1, to: doc.length }, userEvent: "delete.backward" });
    expect(text(v)).toBe("段落 ^a");
  });
});

describe("typing at the end of a line lands where the caret is", () => {
  it("a typed letter", () => {
    const doc = "段落 {複習}";
    const v = open(doc, doc.length);
    edit(v, { changes: { from: doc.length, insert: "x" }, selection: { anchor: doc.length + 1 }, userEvent: "input.type" });
    expect(text(v)).toBe("段落 {複習}x");
    expect(v.state.selection.main.head).toBe(doc.length + 1);
  });

  it("composed text keeps its place and the tag stays in the text", () => {
    const doc = "- [x] 17:45–21:15 吃飯 {task}";
    const v = open(doc, doc.length);
    edit(v, { changes: { from: doc.length, insert: "好" }, selection: { anchor: doc.length + 1 }, userEvent: "input.type.compose" });
    expect(text(v)).toBe("- [x] 17:45–21:15 吃飯 {task}好");
    expect(v.state.selection.main.head).toBe(text(v).length);
  });

  it("while composing no block is lost: the tag still makes the line a block", () => {
    const v = open("寫程式 {複習}");
    v.contentDOM.dispatchEvent(new Event("compositionstart"));
    edit(v, { changes: { from: 3, insert: "ㄅ" }, userEvent: "input.type.compose" });
    v.contentDOM.dispatchEvent(new Event("compositionend"));
    expect(text(v)).toBe("寫程式ㄅ {複習}");
    expect(text(v)).toContain("{複習}");
  });

  it("Enter at the end of a line opens a new line, undone in one step", () => {
    const doc = "段落";
    const v = open(doc, doc.length);
    edit(v, { changes: { from: doc.length, insert: "\n" }, selection: { anchor: doc.length + 1 }, userEvent: "input" });
    expect(text(v)).toBe("段落\n");
    expect(undo(v)).toBe(true);
    expect(text(v)).toBe(doc);
  });
});
