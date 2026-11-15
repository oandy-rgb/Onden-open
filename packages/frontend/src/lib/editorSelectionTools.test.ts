import { afterEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { SELECTION_MATCH_CAP, editorSelectionTools } from "./editorSelectionTools";

const views: EditorView[] = [];
function mount(doc: string) {
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [editorSelectionTools()] }) });
  views.push(view);
  return view;
}
afterEach(() => { views.splice(0).forEach((v) => { v.destroy(); v.dom.parentElement?.remove(); }); });

const marks = (view: EditorView) => view.dom.querySelectorAll(".cm-selectionMatch").length;
const select = (view: EditorView, word: string) => {
  const from = view.state.doc.toString().indexOf(word);
  view.dispatch({ selection: { anchor: from, head: from + word.length } });
};

describe("same words as the selection", () => {
  it("marks the other copies of a selected Chinese phrase (no spaces around it)", () => {
    const view = mount("今天的同步很順利，同步完成後再檢查同步結果。");
    select(view, "同步");
    expect(marks(view)).toBe(2);
  });

  it("marks part of an English word too", () => {
    const view = mount("note notebook footnote");
    select(view, "note");
    expect(marks(view)).toBe(2);
  });

  it("marks nothing for a single character or while only a caret is placed", () => {
    const view = mount("aaa bbb aaa");
    select(view, "a");
    expect(marks(view)).toBe(0);
    view.dispatch({ selection: { anchor: 2 } });
    expect(marks(view)).toBe(0);
  });

  it("stops at the cap in a note full of them", () => {
    const view = mount("ab cd\n".repeat(2000));
    select(view, "ab");
    expect(marks(view)).toBeGreaterThan(0);
    expect(marks(view)).toBeLessThanOrEqual(SELECTION_MATCH_CAP);
  });
});

describe("column selection", () => {
  it("keeps several ranges on a desktop, so Alt + drag can select a column", () => {
    const view = mount("ab\ncd\nef");
    view.dispatch({ selection: EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.range(3, 4), EditorSelection.range(6, 7)]) });
    expect(view.state.selection.ranges).toHaveLength(3);
  });
});

describe("who made the selection decides whether the editor draws it", () => {
  const press = (view: EditorView, pointerType: string) => {
    const event = new MouseEvent("pointerdown", { bubbles: true });
    Object.defineProperty(event, "pointerType", { value: pointerType });
    view.contentDOM.dispatchEvent(event);
  };
  const drawsOwnSelection = (view: EditorView) => view.dom.querySelector(".cm-selectionLayer") !== null;

  it("draws it for a mouse and not for a finger or a pen, whatever the screen said when the editor was made", () => {
    const view = mount("ab\ncd");
    expect(drawsOwnSelection(view)).toBe(true);
    press(view, "touch");
    expect(drawsOwnSelection(view)).toBe(false);
    press(view, "mouse");
    expect(drawsOwnSelection(view)).toBe(true);
    press(view, "pen");
    expect(drawsOwnSelection(view)).toBe(false);
  });
});
