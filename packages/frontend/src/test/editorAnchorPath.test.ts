import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorAnchors, editorAnchorsOf, setEditorAnchors } from "../lib/editorAnchors";

// Anchor path (proposal docs/architecture/proposals/anchors-deterministic-2026-11-16.md §1, "does the frontend compute anchors too?"):
// the editor moves its own copy of the anchors on every keystroke (display only; the local copy `note_anchors` is just the server's
// rows and is never computed on the device). Its boundary rule is NOT the server's: typing right after the last character of a
// paragraph widens the editor's span (mapPos(to, +1)), while the server keeps the block as it was (services/blockAnchors/mapping.ts:
// TrackDel with assoc -1, pinned in backend src/test/anchorPath.test.ts and blockAnchorsMapping.test.ts "typing at the end of the block
// does not widen it"). Until the next server delta replaces the editor's spans (setEditorAnchors), the two disagree by the typed text.

const views: EditorView[] = [];
afterEach(() => { while (views.length) views.pop()!.destroy(); });

describe("anchor path: the editor's own span rule", () => {
  it("typing at the end of a paragraph widens the editor's span (the server's rule keeps the block as it was)", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const doc = "alpha words\n\nbeta words";
    const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [editorAnchors(() => "n1")] }) });
    views.push(view);
    view.dispatch({ effects: setEditorAnchors.of([{ id: "a", from: 0, to: 11 }]) });
    view.dispatch({ changes: { from: 11, insert: "!" } });
    expect(editorAnchorsOf(view.state)).toEqual([{ id: "a", from: 0, to: 12 }]);
  });

  it("typing at the start of a paragraph keeps the editor's span before the typed text (the server moves its start past it)", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const doc = "alpha words\n\nbeta words";
    const view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [editorAnchors(() => "n1")] }) });
    views.push(view);
    view.dispatch({ effects: setEditorAnchors.of([{ id: "b", from: 13, to: 22 }]) });
    view.dispatch({ changes: { from: 13, insert: "X" } });
    expect(editorAnchorsOf(view.state)).toEqual([{ id: "b", from: 13, to: 23 }]);
  });
});
