import { beforeEach, describe, it, expect, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { foldedRanges } from "@codemirror/language";
import MarkdownEditor from "../components/MarkdownEditor";
import { bindAccountStorage } from "../lib/accountStorage";
import { foldAllHeadings, unfoldAllHeadings } from "../lib/editorFold";
import { loadFoldMarks, saveFoldMarks } from "../lib/editorFoldStore";

// Folded headings are a view habit of this device: restored when a note is
// shown, saved when the person folds, never part of the note's text.

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

const NOTE_A = "# A\ntext a\n# A2\nmore a";
const NOTE_B = "# B\ntext b\n# B2\nmore b";
const viewOf = (container: HTMLElement) => EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
const foldCount = (view: EditorView) => { let n = 0; foldedRanges(view.state).between(0, view.state.doc.length, () => { n++; }); return n; };

function setup(initial: { key: string; value: string }) {
  const onChange = vi.fn();
  const editor = (nodeKey: string, value: string) => <MarkdownEditor nodeKey={nodeKey} value={value} onChange={onChange} nodes={[]} onMediaInsert={vi.fn(async () => null)} />;
  const utils = render(editor(initial.key, initial.value));
  return { ...utils, onChange, switchTo: (nodeKey: string, value: string) => utils.rerender(editor(nodeKey, value)) };
}

beforeEach(() => { localStorage.clear(); bindAccountStorage("unit-test-account", ""); });

describe("folded headings in the note editor", () => {
  it("opens a note with the headings this device folded last time, and does not change its text", () => {
    saveFoldMarks("note-a", [{ text: "# A2", nth: 0 }]);
    const s = setup({ key: "note-a", value: NOTE_A });
    const view = viewOf(s.container);
    expect(foldCount(view)).toBe(1);
    expect(view.state.doc.toString()).toBe(NOTE_A);
    expect(s.onChange).not.toHaveBeenCalled();
  });

  it("remembers a fold the person makes, per note, and takes it off with the unfold", () => {
    const s = setup({ key: "note-a", value: NOTE_A });
    const view = viewOf(s.container);
    act(() => { foldAllHeadings(view); });
    expect(loadFoldMarks("note-a")).toHaveLength(2);
    expect(loadFoldMarks("note-b")).toEqual([]);
    act(() => { unfoldAllHeadings(view); });
    expect(loadFoldMarks("note-a")).toEqual([]);
  });

  it("switching notes shows the other note's folds and keeps each note's own", () => {
    saveFoldMarks("note-a", [{ text: "# A", nth: 0 }]);
    saveFoldMarks("note-b", [{ text: "# B", nth: 0 }, { text: "# B2", nth: 0 }]);
    const s = setup({ key: "note-a", value: NOTE_A });
    expect(foldCount(viewOf(s.container))).toBe(1);
    s.switchTo("note-b", NOTE_B);
    expect(foldCount(viewOf(s.container))).toBe(2);
    s.switchTo("note-a", NOTE_A);
    expect(foldCount(viewOf(s.container))).toBe(1);
    expect(loadFoldMarks("note-a")).toEqual([{ text: "# A", nth: 0 }]);
    expect(loadFoldMarks("note-b")).toHaveLength(2);
  });

  it("drops a remembered fold whose heading was edited away, without an error", () => {
    saveFoldMarks("note-a", [{ text: "# Gone", nth: 0 }]);
    const s = setup({ key: "note-a", value: NOTE_A });
    expect(foldCount(viewOf(s.container))).toBe(0);
  });
});
