import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeSet, EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { anchorStartingAt, carriedInUpdate, editorAnchors, editorAnchorsOf, forgetClipboardAnchors, setEditorAnchors } from "../lib/editorAnchors";
import { recordEditorUpdate, resetEditorChanges, restoreEditorChanges, takeEditorChanges } from "../lib/editorChangeLog";

// A person's edit, as the editor reports one.
const recordEditorChange = (noteId: string, changes: Parameters<typeof recordEditorUpdate>[1], carried: { id: string; from: number; to: number }[] = []) =>
  recordEditorUpdate(noteId, changes, { external: false, carried });

// The editor's own copy of where the paragraphs are: it moves with typing, loses a deleted paragraph, and follows a
// paragraph that is cut and pasted inside the note (proposal §5.2). Run against real CodeMirror state.

const views: EditorView[] = [];
let note: string | undefined = "n1";
function open(doc: string, anchors: Array<{ id: string; from: number; to: number }>) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [editorAnchors(() => note)] }) });
  view.dispatch({ effects: setEditorAnchors.of(anchors) });
  views.push(view);
  return view;
}
const cutOrCopy = (view: EditorView, type: "cut" | "copy", from: number, to: number) => {
  view.dispatch({ selection: { anchor: from, head: to } });
  view.contentDOM.dispatchEvent(new Event(type));
  if (type === "cut") view.dispatch({ changes: { from, to }, userEvent: "delete.cut" });
};
const paste = (view: EditorView, at: number, text: string) => {
  let carried: ReturnType<typeof carriedInUpdate> = [];
  view.dispatch({ effects: StateEffect.appendConfig.of(EditorView.updateListener.of((u) => { carried = carriedInUpdate(u); })) });
  view.dispatch({ changes: { from: at, insert: text }, userEvent: "input.paste" });
  return carried;
};
const ids = (view: EditorView) => editorAnchorsOf(view.state).map((a) => [a.id, a.from, a.to]);

beforeEach(() => { note = "n1"; forgetClipboardAnchors(); });
afterEach(() => { views.splice(0).forEach((v) => { v.dom.parentElement?.remove(); v.destroy(); }); });

const DOC = "alpha words\n\nbeta words\n\ngamma words";
const A = { id: "a", from: 0, to: 11 }, B = { id: "b", from: 13, to: 23 }, G = { id: "g", from: 25, to: 36 };

describe("the anchors follow typing", () => {
  it("move with text typed before them and grow with text typed in them", () => {
    const v = open(DOC, [A, B, G]);
    v.dispatch({ changes: { from: 0, insert: "XX" } });
    expect(ids(v)).toEqual([["a", 0, 13], ["b", 15, 25], ["g", 27, 38]]);
    v.dispatch({ changes: { from: 20, insert: "!" } });
    expect(editorAnchorsOf(v.state).find((a) => a.id === "b")).toMatchObject({ from: 15, to: 26 });
  });

  it("a paragraph whose text is all deleted leaves the list; one only shortened stays", () => {
    const v = open(DOC, [A, B, G]);
    v.dispatch({ changes: { from: 13, to: 23 } });
    expect(editorAnchorsOf(v.state).map((a) => a.id)).toEqual(["a", "g"]);
    v.dispatch({ changes: { from: 0, to: 5 } });
    expect(editorAnchorsOf(v.state).map((a) => a.id)).toEqual(["a", "g"]);
  });

  it("anchorStartingAt finds the anchor of the block that starts there, past an indent", () => {
    const v = open("  indented\n\nnext", [{ id: "i", from: 0, to: 10 }]);
    expect(anchorStartingAt(v.state, 2)?.id).toBe("i");
    expect(anchorStartingAt(v.state, 12)).toBeNull();
  });
});

describe("cut and paste inside the note", () => {
  it("the cut paragraph's anchor goes where it is pasted: same id, new place", () => {
    const v = open(DOC, [A, B, G]);
    cutOrCopy(v, "cut", 13, 25); // "beta words\n\n"
    expect(editorAnchorsOf(v.state).map((a) => a.id)).toEqual(["a", "g"]);
    const at = v.state.doc.length;
    const carried = paste(v, at, "beta words\n\n");
    expect(v.state.doc.toString()).toBe("alpha words\n\ngamma wordsbeta words\n\n");
    expect(editorAnchorsOf(v.state).find((a) => a.id === "b")).toEqual({ id: "b", from: at, to: at + 10 });
    expect(carried).toEqual([{ id: "b", from: at, to: at + 10 }]);
  });

  it("a copy does not take the anchor: the pasted paragraph is a new one", () => {
    const v = open(DOC, [A, B, G]);
    cutOrCopy(v, "copy", 13, 23);
    expect(paste(v, v.state.doc.length, "beta words")).toEqual([]);
    expect(editorAnchorsOf(v.state).filter((a) => a.id === "b")).toHaveLength(1);
    expect(editorAnchorsOf(v.state).find((a) => a.id === "b")).toMatchObject({ from: 13, to: 23 });
  });

  it("a second paste of the same cut does not make a second holder of the id", () => {
    const v = open(DOC, [A, B, G]);
    cutOrCopy(v, "cut", 13, 25);
    paste(v, 0, "beta words\n\n");
    expect(paste(v, v.state.doc.length, "beta words\n\n")).toEqual([]);
    expect(editorAnchorsOf(v.state).filter((a) => a.id === "b")).toHaveLength(1);
  });

  it("text that is not what was cut carries nothing", () => {
    const v = open(DOC, [A, B, G]);
    cutOrCopy(v, "cut", 13, 25);
    expect(paste(v, 0, "something else")).toEqual([]);
    expect(editorAnchorsOf(v.state).map((a) => a.id)).toEqual(["a", "g"]);
  });

  it("pasted into another note it carries nothing: the paragraph there gets its own anchor from the server", () => {
    const v = open(DOC, [A, B, G]);
    cutOrCopy(v, "cut", 13, 25);
    note = "n2";
    expect(paste(v, 0, "beta words\n\n")).toEqual([]);
    expect(editorAnchorsOf(v.state).map((a) => a.id)).toEqual(["a", "g"]);
  });

  it("only paragraphs wholly inside the cut go: half a paragraph stays with its remainder", () => {
    const v = open(DOC, [A, B, G]);
    cutOrCopy(v, "cut", 6, 23); // "words\n\nbeta words": half of alpha, all of beta
    expect(paste(v, v.state.doc.length, "words\n\nbeta words").map((c) => c.id)).toEqual(["b"]);
    expect(editorAnchorsOf(v.state).map((a) => a.id).sort()).toEqual(["a", "b", "g"]);
  });

  it("a cut with several ranges or an empty selection carries nothing", () => {
    const v = open(DOC, [A, B, G]);
    v.dispatch({ selection: { anchor: 3 } });
    v.contentDOM.dispatchEvent(new Event("cut"));
    expect(paste(v, 0, "")).toEqual([]);
  });
});

describe("the change log hands the carried anchors to the save", () => {
  const set = (len: number, from: number, to: number, insert: string) => ChangeSet.of({ from, to, insert }, len);

  it("keeps them, at their places after later edits, in what the save takes", () => {
    resetEditorChanges("c");
    recordEditorChange("c", set(10, 10, 10, "XYZ"), [{ id: "b", from: 10, to: 13 }]);
    recordEditorChange("c", set(13, 0, 0, "--"));
    const taken = takeEditorChanges("c", 10, 15)!;
    expect(taken.body.carried_anchors).toEqual([{ id: "b", from: 12, to: 15 }]);
  });

  it("a save that did not go out gives them back for the next one", () => {
    resetEditorChanges("d");
    recordEditorChange("d", set(10, 10, 10, "XYZ"), [{ id: "b", from: 10, to: 13 }]);
    const taken = takeEditorChanges("d", 10, 13)!;
    restoreEditorChanges("d", taken.taken, taken.body.carried_anchors);
    expect(takeEditorChanges("d", 10, 13)!.body.carried_anchors).toEqual([{ id: "b", from: 10, to: 13 }]);
  });

  it("an ordinary edit sends none", () => {
    resetEditorChanges("e");
    recordEditorChange("e", set(5, 0, 0, "x"));
    expect(takeEditorChanges("e", 5, 6)!.body).not.toHaveProperty("carried_anchors");
  });
});

// 業主 2026-11-08: a paragraph cut in two (Enter) keeps its anchor on the half with the `{…}`, else the first half —
// the same rule the server applies (@onden/markdown splitAnchorSpan), so the 「被引用」 number and the frame sit on the item.
describe("a paragraph cut in two", () => {
  const TAGGED = "前半文字後半文字 {複習}\n\n別段";
  it("the tag in the second half: the anchor moves to the second half", () => {
    const v = open(TAGGED, [{ id: "t", from: 0, to: 13 }, { id: "o", from: 15, to: 17 }]);
    v.dispatch({ changes: { from: 4, insert: "\n\n" }, userEvent: "input" });
    const t = editorAnchorsOf(v.state).find((a) => a.id === "t")!;
    expect(v.state.sliceDoc(t.from, t.to)).toBe("後半文字 {複習}");
    expect(v.state.sliceDoc(editorAnchorsOf(v.state).find((a) => a.id === "o")!.from, v.state.doc.length)).toBe("別段");
  });
  it("the tag in the first half (Enter after it): the anchor stays on the first half", () => {
    const v = open(TAGGED, [{ id: "t", from: 0, to: 13 }]);
    v.dispatch({ changes: { from: 13, insert: "\n\n" }, userEvent: "input" });
    expect(editorAnchorsOf(v.state)[0]).toMatchObject({ from: 0, to: 13 });
  });
  it("no tag: the anchor stays on the first half (§5.3)", () => {
    const v = open("前半文字後半文字\n\n別段", [{ id: "p", from: 0, to: 8 }]);
    v.dispatch({ changes: { from: 4, insert: "\n\n" }, userEvent: "input" });
    expect(editorAnchorsOf(v.state)[0]).toMatchObject({ from: 0, to: 4 });
  });
  it("Enter before the whole paragraph leaves the anchor on the tagged text, not on the blank line", () => {
    const v = open(TAGGED, [{ id: "t", from: 0, to: 13 }]);
    v.dispatch({ changes: { from: 0, insert: "\n\n" }, userEvent: "input" });
    const t = editorAnchorsOf(v.state)[0]!;
    expect(v.state.sliceDoc(t.from, t.to)).toBe("前半文字後半文字 {複習}");
  });
  it("a plain typed character does not change which part an anchor covers", () => {
    const v = open(TAGGED, [{ id: "t", from: 0, to: 13 }]);
    v.dispatch({ changes: { from: 4, insert: "字" }, userEvent: "input.type" });
    expect(editorAnchorsOf(v.state)[0]).toMatchObject({ from: 0, to: 14 });
  });
});
