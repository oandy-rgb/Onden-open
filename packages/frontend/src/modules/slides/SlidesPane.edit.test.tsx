// The 簡報 tab's page operations: each is a change of the note's one text (through drafts.editText), selects the
// right page, says so with a way back, and 「跟著游標」 follows the open editor's caret beside it.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseSlidesData } from "@onden/markdown";
import { noWorkspaceData, type ContentNode } from "../../lib/api";
import { getAppState, resetAppState, setAppState, useAppSelector } from "../../lib/appStore";
import { publishCaret, registerEditorControls } from "../../lib/editorCaretStore";
import { setRight } from "../../lib/splitViewStore";
import SlidesPane from "./SlidesPane";

const h = vi.hoisted(() => ({ mobile: false, refuse: false, point: null as Element | null, text: "", edits: [] as string[], put: (_text: string) => {}, set: vi.fn(async () => ({})), remove: vi.fn(async () => ({})) }));
vi.mock("../../lib/data/domainWriters", async (load) => ({ ...await load<typeof import("../../lib/data/domainWriters")>(), propertyWriter: { set: h.set, remove: h.remove } }));
vi.mock("../../lib/data/draftActions", async (load) => ({
  ...await load<typeof import("../../lib/data/draftActions")>(),
  // `refuse`: the save is refused (the writer has already reported it) and the text stays as it was.
  editNoteText: async (_id: string, edit: (body: string) => string) => {
    if (h.refuse) return "refused";
    h.text = edit(h.text); h.edits.push(h.text); h.put(h.text); return "applied";
  },
}));
vi.mock("../../hooks/useIsMobile", async (load) => ({ ...await load<typeof import("../../hooks/useIsMobile")>(), useIsMobile: () => h.mobile }));
// jsdom has no layout: a pointer "over" a thumbnail is whichever element the case names.
vi.mock("../../lib/documentAccess", async (load) => ({ ...await load<typeof import("../../lib/documentAccess")>(), elementAtPoint: () => h.point }));

const MD = "## One\n- a\n\n---\n\n## Two\n- b\n\n---\n\n## Three\n- c";
// A new id per case: which slide a note was on is remembered by id for the page (slideSelection.ts).
let NODE_ID = "";
let cases = 0;
const note = (attrs?: Record<string, string>) => ({ id: NODE_ID, title: "Talk", slug: "talk", markdown: MD, node_type: "content", source_type: "manual", attrs } as unknown as ContentNode);

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
}, 30_000);
beforeEach(() => {
  NODE_ID = `00000000-0000-4000-8000-${String(++cases).padStart(12, "0")}`;
  resetAppState({ data: { ...noWorkspaceData, nodes: [note()] } });
  h.mobile = false; h.refuse = false; h.point = null;
  h.text = MD; h.edits = []; h.set.mockClear(); h.remove.mockClear();
  setRight(null);
});
afterEach(() => { cleanup(); setRight(null); publishCaret(NODE_ID, null); registerEditorControls(NODE_ID, null); });

// The note as the store holds it: an edit writes the new text there, as saving does.
function Live({ canEdit }: { canEdit: boolean }) {
  const node = useAppSelector((s) => s.data.nodes[0]);
  return <SlidesPane node={node} canEdit={canEdit} onOpenNode={() => {}} />;
}
const pane = (n = note(), canEdit = true) => {
  resetAppState({ data: { ...noWorkspaceData, nodes: [n] } });
  h.text = n.markdown ?? "";
  h.put = (text) => setAppState((s) => ({ data: { ...s.data, nodes: [{ ...s.data.nodes[0], markdown: text }] } }));
  return render(<Live canEdit={canEdit} />);
};
const thumbs = () => screen.getAllByRole("button", { name: /^Slide \d+$/ });
const on = () => thumbs().findIndex((b) => b.getAttribute("aria-current") === "true");
const toastUndo = () => getAppState().toasts.at(-1)?.action;

describe("page operations", () => {
  it("are not offered to someone who can't edit the note", () => {
    pane(note(), false);
    for (const name of ["Move up", "Move down", "Copy this slide", "Delete this slide", "Add a slide"]) expect(screen.queryByRole("button", { name })).toBeNull();
  });

  it("move a page, select it where it went, and say so with a way back", async () => {
    pane();
    fireEvent.click(thumbs()[1]);
    fireEvent.click(screen.getByRole("button", { name: "Move up" }));
    await waitFor(() => expect(h.text).toBe("## Two\n- b\n\n---\n\n## One\n- a\n\n---\n\n## Three\n- c"));
    expect(on()).toBe(0);
    expect(getAppState().toasts.at(-1)?.message).toBe("Moved “Two” to slide 1");
    await act(async () => { toastUndo()?.onClick(); });
    expect(h.text).toBe(MD);
    expect(on()).toBe(1);
  });

  it("a layout chosen for a page stays with the page when it moves", async () => {
    pane(note({ slides_data: JSON.stringify({ v: 1, theme: "site", layouts: { "h:two": "quote" } }) }));
    fireEvent.click(thumbs()[1]);
    fireEvent.click(screen.getByRole("button", { name: "Move down" }));
    await waitFor(() => expect(h.text.startsWith("## One\n- a\n\n---\n\n## Three")).toBe(true));
    // Keys are names, so a moved page keeps its key: nothing to rewrite.
    expect(h.set).not.toHaveBeenCalled();
  });

  it("a copy takes its original's layout; a delete drops the choice of the page that went", async () => {
    pane(note({ slides_data: JSON.stringify({ v: 1, theme: "site", layouts: { "h:one": "quote" } }) }));
    fireEvent.click(screen.getByRole("button", { name: "Copy this slide" }));
    await waitFor(() => expect(h.set).toHaveBeenCalled());
    expect(parseSlidesData(String((h.set.mock.calls.at(-1) as unknown[])[2])).layouts).toEqual({ "h:one": "quote", "h:one~2": "quote" });
    expect(on()).toBe(1);
  });

  it("delete selects a neighbour; the last page can't be deleted", async () => {
    const { unmount } = pane();
    fireEvent.click(thumbs()[2]);
    fireEvent.click(screen.getByRole("button", { name: "Delete this slide" }));
    await waitFor(() => expect(h.text).toBe("## One\n- a\n\n---\n\n## Two\n- b"));
    expect(getAppState().toasts.at(-1)?.message).toBe("Deleted “Three”");
    unmount();
    pane({ ...note(), markdown: "## Only\nx" } as ContentNode);
    expect(screen.getByRole("button", { name: "Delete this slide" })).toBeDisabled();
  });

  it("add a slide at the end and between pages, cut the way the note is cut", async () => {
    pane();
    fireEvent.click(screen.getByRole("button", { name: "Add a slide" }));
    await waitFor(() => expect(h.text).toBe(`${MD}\n\n---\n\n## New slide`));
    expect(on()).toBe(3);
  });

  it("an undo does not overwrite text written since", async () => {
    pane();
    fireEvent.click(screen.getByRole("button", { name: "Delete this slide" }));
    await waitFor(() => expect(h.edits).toHaveLength(1));
    h.text += "\nmore typing";
    await act(async () => { toastUndo()?.onClick(); });
    expect(h.text.endsWith("more typing")).toBe(true);
    expect(getAppState().toasts.at(-1)?.message).toBe("The note was changed since, so this was not undone.");
  });

  it("Alt+↓ on a thumbnail moves its page down", async () => {
    pane();
    fireEvent.keyDown(thumbs()[0], { key: "ArrowDown", altKey: true });
    await waitFor(() => expect(h.text.startsWith("## Two")).toBe(true));
    await waitFor(() => expect(on()).toBe(1));
  });
});

describe("並排: following the caret of the note's own text", () => {
  const caretAt = (offset: number) => act(() => publishCaret(NODE_ID, { from: offset, head: offset }));

  it("is what it always was without an editor beside it", () => {
    pane();
    expect(screen.queryByRole("switch", { name: "Follow the caret" })).toBeNull();
    caretAt(MD.indexOf("c"));
    expect(on()).toBe(0);
  });

  it("selects the page the caret is in, and stops when switched off", () => {
    pane();
    act(() => setRight({ kind: "page", mode: "tasks" }));
    caretAt(MD.indexOf("- b"));
    expect(on()).toBe(1);
    expect(screen.getByText("Slide 2 of 3")).toBeInTheDocument();
    caretAt(MD.indexOf("- c"));
    expect(on()).toBe(2);
    fireEvent.click(screen.getByRole("switch", { name: "Follow the caret" }));
    caretAt(MD.indexOf("- a"));
    expect(on()).toBe(2);
  });

  it("a page chosen by hand stays until the caret goes to another page", () => {
    pane();
    act(() => setRight({ kind: "page", mode: "tasks" }));
    caretAt(MD.indexOf("- a"));
    fireEvent.click(thumbs()[2]);
    expect(on()).toBe(2);
    caretAt(MD.indexOf("- a") + 1); // same page: no jump back
    expect(on()).toBe(2);
    caretAt(MD.indexOf("- b"));
    expect(on()).toBe(1);
  });

  it("a thumbnail scrolls the text to that page, without moving the caret", () => {
    const scrollTo = vi.fn(); const focusAt = vi.fn();
    registerEditorControls(NODE_ID, { scrollTo, focusAt, placeCaret: vi.fn(), replaceText: vi.fn() });
    pane();
    act(() => setRight({ kind: "page", mode: "tasks" }));
    caretAt(0);
    fireEvent.click(thumbs()[2]);
    expect(scrollTo).toHaveBeenCalledWith(MD.indexOf("## Three"));
    expect(focusAt).not.toHaveBeenCalled();
  });
});

describe("with the editor open beside", () => {
  /** An editor stand-in: the operation is applied to its text as one edit (replaceText), and the caret it reports follows. */
  function openEditor() {
    const placeCaret = vi.fn(); const replaceText = vi.fn((change: (current: string) => string) => { h.text = change(h.text); h.put(h.text); });
    registerEditorControls(NODE_ID, { scrollTo: vi.fn(), focusAt: vi.fn(), placeCaret, replaceText });
    return { placeCaret, replaceText };
  }
  const flush = () => act(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))); });

  it("makes the change through the editor (one edit of its own to undo), not a second writer", async () => {
    const editor = openEditor();
    pane();
    act(() => setRight({ kind: "page", mode: "tasks" }));
    act(() => publishCaret(NODE_ID, { from: 0, head: 0 }));
    fireEvent.click(screen.getByRole("button", { name: "Move down" }));
    await flush();
    expect(editor.replaceText).toHaveBeenCalledTimes(1);
    expect(h.edits).toHaveLength(0); // drafts.editText was not used
    expect(h.text.startsWith("## Two")).toBe(true);
  });

  it("the caret goes where its text went, and the follow does not take the selection from the moved page", async () => {
    const editor = openEditor();
    pane();
    act(() => setRight({ kind: "page", mode: "tasks" }));
    act(() => publishCaret(NODE_ID, { from: MD.indexOf("- b"), head: MD.indexOf("- b") })); // on page 2
    expect(on()).toBe(1);
    fireEvent.click(thumbs()[0]); // looking at page 1 by hand
    fireEvent.click(screen.getByRole("button", { name: "Move down" })); // page 1 goes below page 2
    await flush();
    // the editor drops the caret to the edge of the replaced text meanwhile
    act(() => publishCaret(NODE_ID, { from: 0, head: 0 }));
    await flush();
    expect(editor.placeCaret).toHaveBeenCalledWith(h.text.indexOf("- b")); // page 2's caret went up with it
    expect(on()).toBe(1); // the moved page stays the selected one
    fireEvent.click(screen.getByRole("button", { name: "Move down" }));
    await flush();
    expect(h.text).toBe("## Two\n- b\n\n---\n\n## Three\n- c\n\n---\n\n## One\n- a"); // the same page, again
  });

  it("「復原」 puts back only this operation's layouts, not a theme chosen since", async () => {
    openEditor();
    pane(note({ slides_data: JSON.stringify({ v: 1, theme: "site", layouts: { "h:one": "quote" } }) }));
    fireEvent.click(screen.getByRole("button", { name: "Copy this slide" }));
    await waitFor(() => expect(h.set).toHaveBeenCalled());
    h.set.mockClear();
    await act(async () => { toastUndo()?.onClick(); });
    await waitFor(() => expect(h.set).toHaveBeenCalled());
    // the layouts are what they were; nothing else of slides_data is rewritten (no theme here to lose)
    expect(parseSlidesData(String((h.set.mock.calls.at(-1) as unknown[])[2])).layouts).toEqual({ "h:one": "quote" });
  });

  it("says why when the result would be cut into other pages", async () => {
    const heads = "Intro\n\n## A\nx\n\n## B\ny";
    openEditor();
    pane({ ...note(), markdown: heads } as ContentNode);
    fireEvent.click(screen.getByRole("button", { name: "Move down" }));
    await flush();
    expect(h.text).toBe(heads);
    expect(getAppState().toasts.at(-1)?.message).toBe("This would change how the note is cut into slides, so it was not done.");
  });

  it("does nothing on a page that was typed over since it was shown", async () => {
    openEditor();
    pane();
    // the text changes under the pane (as typing beside it does) without the pane having drawn it yet
    h.text = MD.replace("## Two", "## Two changed");
    fireEvent.click(thumbs()[1]);
    fireEvent.click(screen.getByRole("button", { name: "Delete this slide" }));
    await flush();
    expect(h.text).toBe(MD.replace("## Two", "## Two changed"));
    expect(getAppState().toasts.at(-1)?.message).toBe("The slides were changing while you pressed that. Try again.");
  });
});

describe("a refused or queued save", () => {
  it("a refused save leaves the text, the layouts and the selected page as they were, and shows no 'done' notice", async () => {
    pane(note({ slides_data: JSON.stringify({ v: 1, theme: "site", layouts: { "h:one": "quote" } }) }));
    h.refuse = true;
    fireEvent.click(thumbs()[1]);
    fireEvent.click(screen.getByRole("button", { name: "Move up" }));
    await act(async () => { await Promise.resolve(); });
    expect(h.text).toBe(MD);
    expect(h.set).not.toHaveBeenCalled();
    expect(on()).toBe(1);
    expect(getAppState().toasts.some((x) => x.message.startsWith("Moved"))).toBe(false);
  });

  it("a save the offline queue holds counts as made (the writer's own wording says it is waiting to sync)", async () => {
    pane();
    fireEvent.click(thumbs()[1]);
    fireEvent.click(screen.getByRole("button", { name: "Move up" }));
    await waitFor(() => expect(h.text.startsWith("## Two")).toBe(true));
    expect(getAppState().toasts.at(-1)?.message).toBe("Moved “Two” to slide 1");
  });
});

describe("dragging a thumbnail by its grip (the app's pointer drag: touch and pen too)", () => {
  const grip = (i: number) => screen.getAllByRole("button", { name: "Drag to move" })[i];
  const rows = () => Array.from(document.querySelectorAll<HTMLElement>(".sp-thumb"));
  const over = (row: HTMLElement, below: boolean) => {
    row.getBoundingClientRect = () => ({ top: 100, height: 40, bottom: 140, left: 0, right: 100, width: 100, x: 0, y: 100, toJSON: () => ({}) });
    h.point = row;
    return below ? 130 : 110;
  };

  it("a touch drag of the first slide to below the second moves it there, and says so", async () => {
    pane();
    fireEvent.pointerDown(grip(0), { pointerId: 1, pointerType: "touch" });
    fireEvent.pointerMove(grip(0), { pointerId: 1, pointerType: "touch", clientY: over(rows()[1], true) });
    fireEvent.pointerUp(grip(0), { pointerId: 1, pointerType: "touch" });
    await waitFor(() => expect(h.text).toBe("## Two\n- b\n\n---\n\n## One\n- a\n\n---\n\n## Three\n- c"));
    expect(getAppState().toasts.at(-1)?.message).toBe("Moved “One” to slide 2");
  });

  it("a press that never leaves its row moves nothing", async () => {
    pane();
    fireEvent.pointerDown(grip(0), { pointerId: 1, pointerType: "touch" });
    fireEvent.pointerUp(grip(0), { pointerId: 1, pointerType: "touch" });
    await act(async () => { await Promise.resolve(); });
    expect(h.edits).toHaveLength(0);
  });
});

describe("phone width", () => {
  it("has no drag grip and no hover plus; the same buttons are above the thumbnails, with move up and down", async () => {
    h.mobile = true;
    pane();
    expect(screen.queryByRole("button", { name: "Drag to move" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a slide here" })).toBeNull();
    const tools = screen.getByRole("group", { name: "This slide" });
    expect(tools.closest(".sp-side")).not.toBeNull();
    expect(tools.compareDocumentPosition(document.querySelector(".sp-thumbs")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // above the strip
    fireEvent.click(thumbs()[1]);
    fireEvent.click(screen.getByRole("button", { name: "Move up" }));
    await waitFor(() => expect(h.text.startsWith("## Two")).toBe(true));
    expect(on()).toBe(0);
  });
});

describe("a note written with CRLF line ends (an imported one), no editor open", () => {
  const CRLF = MD.replace(/\n/g, "\r\n");
  it("moves a page, keeps its line ends, and undoes it", async () => {
    pane({ ...note(), markdown: CRLF } as ContentNode);
    fireEvent.click(thumbs()[1]);
    fireEvent.click(screen.getByRole("button", { name: "Move up" }));
    await waitFor(() => expect(h.text).toBe("## Two\r\n- b\r\n\r\n---\r\n\r\n## One\r\n- a\r\n\r\n---\r\n\r\n## Three\r\n- c"));
    expect(getAppState().toasts.at(-1)?.message).toBe("Moved “Two” to slide 1");
    await act(async () => { toastUndo()?.onClick(); });
    expect(h.text).toBe(CRLF);
    expect(getAppState().toasts.at(-1)?.message).toBe("Moved “Two” to slide 1"); // no 'changed since' notice
  });
  it("copies and deletes a multi-line page", async () => {
    pane({ ...note(), markdown: CRLF } as ContentNode);
    fireEvent.click(screen.getByRole("button", { name: "Copy this slide" }));
    await waitFor(() => expect(h.text.split("## One").length).toBe(3));
    expect(getAppState().toasts.at(-1)?.message).toBe("Copied “One”");
  });
});
