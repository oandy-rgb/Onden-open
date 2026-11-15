import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { redo, undo, undoDepth } from "@codemirror/commands";
import MarkdownEditor from "../components/MarkdownEditor";

// Undo and redo cover what the user typed, never text that arrived from
// outside (a save's reflection, a remote edit, another note). An outside
// change used to replace the whole document inside the undo history, so
// redo brought back stale text and a second undo emptied the note.

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

const viewOf = (container: HTMLElement) => EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;

function setup(nodeKey: string, value: string) {
  const onChange = vi.fn();
  const editor = (key: string, text: string) => (
    <MarkdownEditor nodeKey={key} value={text} onChange={onChange} nodes={[]} onMediaInsert={vi.fn(async () => null)} />
  );
  const utils = render(editor(nodeKey, value));
  const view = viewOf(utils.container);
  /** Type at the end as its own undo step, as a pause between bursts would. */
  const type = (text: string) => {
    const end = view.state.doc.length;
    view.dispatch({ changes: { from: end, insert: text }, selection: { anchor: end + text.length }, userEvent: "input.type", scrollIntoView: true });
    view.dispatch({ annotations: [] }); // a separate transaction
  };
  const text = () => view.state.doc.toString();
  return { ...utils, view, type, text, show: (key: string, value: string) => utils.rerender(editor(key, value)) };
}

/** A new undo group, like the pause between two typing bursts. */
function newGroup(view: EditorView) {
  const end = view.state.doc.length;
  view.dispatch({ selection: { anchor: 0 } });
  view.dispatch({ selection: { anchor: end } });
}

describe("editor undo history", () => {
  it("an outside change of the same note never enters the undo history", () => {
    const e = setup("note-a", "start");
    const before = undoDepth(e.view.state);
    e.show("note-a", "start\nfrom another device");
    expect(e.text()).toBe("start\nfrom another device");
    expect(undoDepth(e.view.state)).toBe(before);
    expect(undo(e.view)).toBe(false);
    expect(e.text()).toBe("start\nfrom another device");
  });

  it("type, undo, redo gives back exactly what was typed, with the save echoing in between", () => {
    const e = setup("note-a", "");
    e.type("alpha");
    e.show("note-a", e.text());          // the save's reflection
    newGroup(e.view);
    e.type(" beta");
    e.show("note-a", e.text());
    expect(undo(e.view)).toBe(true);
    expect(e.text()).toBe("alpha");
    e.show("note-a", e.text());
    expect(redo(e.view)).toBe(true);
    expect(e.text()).toBe("alpha beta");
  });

  it("after a background sync, undo takes back only the user's typing and never empties the note", () => {
    const e = setup("note-a", "Intro");
    e.type(" mine");
    // Someone else appends a paragraph; the sync reflects it while the
    // user's edit is still undoable.
    e.show("note-a", "Intro mine\n\nTheirs");
    while (undo(e.view)) { /* undo everything undoable */ }
    expect(e.text()).toBe("Intro\n\nTheirs");
  });

  it("a note switch starts a fresh history: undo cannot bring the previous note's text", () => {
    const e = setup("note-a", "A");
    e.type(" typed in A");
    e.show("note-b", "B text");
    expect(undoDepth(e.view.state)).toBe(0);
    expect(undo(e.view)).toBe(false);
    expect(e.text()).toBe("B text");
  });
});
