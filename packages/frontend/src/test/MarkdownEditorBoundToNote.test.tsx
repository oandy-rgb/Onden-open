import { beforeEach, describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { foldedRanges } from "@codemirror/language";
import type { Tag } from "../lib/api";
import MarkdownEditor from "../components/MarkdownEditor";
import { bindAccountStorage } from "../lib/accountStorage";
import { saveFoldMarks } from "../lib/editorFoldStore";
import { setPendingFind } from "../lib/findInNote";
import { getAppState, setAppState } from "../lib/appStore";
import { SESSION_KEYS, readSession } from "../lib/sessionPrefs";

// The editor is not remounted per note, so every deferred or once-only piece of
// work has to know which note it belongs to: the caret it stores, the link a
// created page writes, and what runs when a note's text arrives a render after
// its id (the draft store resets in an ancestor effect).

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

const viewOf = (container: HTMLElement) => EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
const foldCount = (view: EditorView) => { let n = 0; foldedRanges(view.state).between(0, view.state.doc.length, () => { n++; }); return n; };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const ENTITY_TAG = { id: "tag-1", name: "Idea", color: null, schema_id: "schema-1", schema_module: null } as unknown as Tag;

type Extra = Partial<React.ComponentProps<typeof MarkdownEditor>>;
function setup(initial: { key: string; value: string }, extra: Extra = {}) {
  const onChange = vi.fn();
  const editor = (nodeKey: string, value: string) => (
    <MarkdownEditor nodeKey={nodeKey} value={value} onChange={onChange} nodes={[]} onMediaInsert={vi.fn(async () => null)} {...extra} />
  );
  const utils = render(editor(initial.key, initial.value));
  return { ...utils, onChange, switchTo: (nodeKey: string, value: string) => utils.rerender(editor(nodeKey, value)) };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  bindAccountStorage("unit-test-account", "");
  setAppState({ toasts: [] });
});

describe("the caret stored for a note", () => {
  it("after switching notes in the same editor, a caret move is stored under the note now open", () => {
    const s = setup({ key: "note-a", value: "alpha text" });
    act(() => { viewOf(s.container).dispatch({ selection: { anchor: 2 } }); });
    expect(JSON.parse(readSession(SESSION_KEYS.cursor("note-a"))!)).toEqual({ anchor: 2, head: 2 });

    s.switchTo("note-b", "bravo text is longer");
    act(() => { viewOf(s.container).dispatch({ selection: { anchor: 9 } }); });

    expect(JSON.parse(readSession(SESSION_KEYS.cursor("note-b"))!)).toEqual({ anchor: 9, head: 9 });
    expect(JSON.parse(readSession(SESSION_KEYS.cursor("note-a"))!)).toEqual({ anchor: 2, head: 2 });
  });
});

describe("a note created from the link menu", () => {
  async function startCreate(s: ReturnType<typeof setup>, onExtract: Extra["onExtract"]) {
    void onExtract;
    const view = viewOf(s.container);
    const end = view.state.doc.length;
    act(() => { view.dispatch({ changes: { from: end, insert: "[[New idea" }, selection: { anchor: end + 10 }, userEvent: "input.type" }); });
    fireEvent.mouseDown(await screen.findByRole("button", { name: /Create note/ }, { timeout: 5000 }));
  }

  it("is linked where the trigger was when the note is still open and the trigger text is unchanged", async () => {
    const created = deferred<{ title: string } | null>();
    const onExtract = vi.fn(() => created.promise) as unknown as Extra["onExtract"];
    const s = setup({ key: "note-a", value: "x " }, { extractTags: [ENTITY_TAG], onExtract });
    await startCreate(s, onExtract);
    await act(async () => { created.resolve({ title: "New idea" }); });
    expect(viewOf(s.container).state.doc.toString()).toBe("x [[New idea]]");
  }, 30_000);

  it("leaves the text alone and says so when the person typed more or moved on in the meantime", async () => {
    const created = deferred<{ title: string } | null>();
    const onExtract = vi.fn(() => created.promise) as unknown as Extra["onExtract"];
    const s = setup({ key: "note-a", value: "x " }, { extractTags: [ENTITY_TAG], onExtract });
    await startCreate(s, onExtract);
    const view = viewOf(s.container);
    // The trigger text changed under the pending insert.
    act(() => { view.dispatch({ changes: { from: 2, to: 4, insert: "OLD" } }); });
    const before = view.state.doc.toString();
    await act(async () => { created.resolve({ title: "New idea" }); });
    expect(viewOf(s.container).state.doc.toString()).toBe(before);
    expect(onExtract).toHaveBeenCalledTimes(1);
    expect(getAppState().toasts.map((t) => t.message).join("\n")).toMatch(/link was not added/i);
  }, 30_000);

  it("still links the trigger when text was typed before it during the wait", async () => {
    const created = deferred<{ title: string } | null>();
    const onExtract = vi.fn(() => created.promise) as unknown as Extra["onExtract"];
    const s = setup({ key: "note-a", value: "x " }, { extractTags: [ENTITY_TAG], onExtract });
    await startCreate(s, onExtract);
    act(() => { viewOf(s.container).dispatch({ changes: { from: 0, insert: "Intro. " } }); });
    await act(async () => { created.resolve({ title: "New idea" }); });
    expect(viewOf(s.container).state.doc.toString()).toBe("Intro. x [[New idea]]");
  }, 30_000);

  it("does not touch the note now open (and does not throw) when the person switched notes", async () => {
    const created = deferred<{ title: string } | null>();
    const onExtract = vi.fn(() => created.promise) as unknown as Extra["onExtract"];
    const s = setup({ key: "note-a", value: "x " }, { extractTags: [ENTITY_TAG], onExtract });
    await startCreate(s, onExtract);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    s.switchTo("note-b", "b");
    await act(async () => { created.resolve({ title: "New idea" }); });
    await new Promise((r) => setTimeout(r, 0));
    process.off("unhandledRejection", unhandled);
    expect(viewOf(s.container).state.doc.toString()).toBe("b");
    expect(unhandled).not.toHaveBeenCalled();
    expect(getAppState().toasts.map((t) => t.message).join("\n")).toMatch(/opened another note/i);
  }, 30_000);
});

describe("what a note's text arriving after its id still gets", () => {
  // The draft store resets in an ancestor effect: for one render the editor
  // has the new note's id with the old note's text.
  it("restores the folds of the new note against the new note's text", () => {
    const NOTE_A = "# A\ntext a\n# A2\nmore a";
    const NOTE_B = "# B\ntext b\n# B2\nmore b";
    saveFoldMarks("note-b", [{ text: "# B2", nth: 0 }]);
    const s = setup({ key: "note-a", value: NOTE_A });
    expect(foldCount(viewOf(s.container))).toBe(0);
    s.switchTo("note-b", NOTE_A);
    s.switchTo("note-b", NOTE_B);
    expect(foldCount(viewOf(s.container))).toBe(1);
  });

  it("scrolls to the words of the search that opened the note once the note's own text is in", () => {
    const NOTE_A = "first note\nnothing here";
    const NOTE_B = "second note\nthe needle is here";
    const s = setup({ key: "note-a", value: NOTE_A });
    setPendingFind("note-b", "needle");
    s.switchTo("note-b", NOTE_A);
    s.switchTo("note-b", NOTE_B);
    const flashed = viewOf(s.container).dom.querySelector(".cm-findFlash");
    expect(flashed?.textContent).toBe("needle");
  });

  it("puts the caret of the new note where it was left, measured against the new note's text", () => {
    const s = setup({ key: "note-a", value: "alpha" });
    s.switchTo("note-b", "alpha");
    s.switchTo("note-b", "bravo is much longer");
    act(() => { viewOf(s.container).dispatch({ selection: { anchor: 12 } }); });
    s.switchTo("note-a", "alpha");
    s.switchTo("note-b", "alpha");
    s.switchTo("note-b", "bravo is much longer");
    expect(viewOf(s.container).state.selection.main.head).toBe(12);
  });
});

describe("continuing a list with Enter", () => {
  it.each(["-", "*", "+"])("Tab indents a `%s` list line the same way Enter continues it", (mark) => {
    const s = setup({ key: "note-a", value: `${mark} item` });
    const view = viewOf(s.container);
    act(() => { view.dispatch({ selection: { anchor: view.state.doc.length } }); });
    fireEvent.keyDown(view.contentDOM, { key: "Tab" });
    expect(view.state.doc.toString()).toBe(`  ${mark} item`);
  });
});
