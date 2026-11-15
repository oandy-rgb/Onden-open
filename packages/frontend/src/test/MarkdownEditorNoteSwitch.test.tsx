import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import MarkdownEditor from "../components/MarkdownEditor";

// The editor is not remounted per note. Every insert that awaits the network
// (a created page, a minted task) must land in the note
// it was started in — handed to editLeftNote when the user switched notes
// meanwhile — and never in the note now open. (Image uploads:
// MarkdownEditorImageInsert.test.tsx.)

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

const viewOf = (container: HTMLElement) => EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

type Extra = Partial<React.ComponentProps<typeof MarkdownEditor>>;
function setup(extra: Extra) {
  const onChange = vi.fn();
  const editLeftNote = vi.fn();
  const editor = (nodeKey: string, value: string) => (
    <MarkdownEditor nodeKey={nodeKey} value={value} onChange={onChange} nodes={[]}
      onMediaInsert={vi.fn(async () => null)} editLeftNote={editLeftNote} {...extra} />
  );
  const utils = render(editor("note-a", "text of a"));
  const switchTo = (nodeKey: string, value: string) => utils.rerender(editor(nodeKey, value));
  const wroteIntoOpenNote = (needle: string) => onChange.mock.calls.some(([text]) => String(text).includes(needle));
  return { ...utils, onChange, editLeftNote, switchTo, wroteIntoOpenNote };
}

// Each step below may wait up to 5 s (a first CodeMirror render and the slash
// menu are slow on a loaded machine), so the test's own limit sits above the
// sum instead of at vitest's 5 s default, which a slow first step used up.
describe("an editor insert that finishes after a note switch", { timeout: 30_000 }, () => {
  it("a page created from the slash menu is linked in the note it was started in", async () => {
    const page = deferred<string | null>();
    const onInsertPage = vi.fn(() => page.promise);
    const s = setup({ onInsertPage });
    const view = viewOf(s.container);
    const end = view.state.doc.length;
    // In act: the popup's state reaches popupRef in an effect, which must run
    // before the click below (outside act it may still be pending).
    act(() => { view.dispatch({ changes: { from: end, insert: "\n/hand" }, selection: { anchor: end + 6 }, userEvent: "input.type" }); });
    fireEvent.mouseDown(await screen.findByRole("button", { name: /Handwriting page/ }, { timeout: 5000 }));
    await waitFor(() => expect(onInsertPage).toHaveBeenCalled(), { timeout: 5000 });
    s.switchTo("note-b", "text of b");
    await act(async () => { page.resolve("Sketch"); });

    await waitFor(() => expect(s.editLeftNote).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const [nodeKey, edit] = s.editLeftNote.mock.calls[0]!;
    expect(nodeKey).toBe("note-a");
    expect(edit("text of a")).toContain("[[Sketch]]");
    expect(viewOf(s.container).state.doc.toString()).toBe("text of b");
  });

  it("a checkbox promoted to a task is ticked in the note it was started in", async () => {
    const minted = deferred<boolean>();
    const s = setup({ onCreateTask: vi.fn(() => minted.promise) });
    s.switchTo("note-a", "- [ ] buy milk");
    const view = viewOf(s.container);
    act(() => { view.dispatch({ selection: { anchor: 3 } }); });
    fireEvent.keyDown(view.contentDOM, { key: "Enter", ctrlKey: true, shiftKey: true });
    s.switchTo("note-b", "- [ ] buy milk");
    await act(async () => { minted.resolve(true); });

    expect(s.editLeftNote).toHaveBeenCalledTimes(1);
    const [nodeKey, edit] = s.editLeftNote.mock.calls[0]!;
    expect(nodeKey).toBe("note-a");
    expect(edit("- [ ] buy milk")).toBe("- [x] buy milk");
    // The same line in the note now open stays unticked.
    expect(viewOf(s.container).state.doc.toString()).toBe("- [ ] buy milk");
    expect(s.wroteIntoOpenNote("[x]")).toBe(false);
  });
});
