// The screens under test load data on mount; the network is down for the whole file (helpers/offlineNetwork.ts).
import "./helpers/offlineNetwork";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import MarkdownEditor from "../components/MarkdownEditor";
import { effectiveShortcuts } from "../lib/shortcuts";
import { setAppState } from "../lib/appStore";
import type { TagItem } from "../lib/editorCompletion";

// The desktop handle: one grip beside the line under the mouse that opens the
// menu of the same actions the phone bar and the selection bar have. jsdom has no layout, so the pointer's line is
// the y it is given divided by LINE.

const LINE = 20;
/** One animation frame (16 ms) plus the handle's SETTLE_MS (60 ms), with room to spare on the fake clock. */
const HANDLE_SETTLED_MS = 200;
const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

const original = window.matchMedia;
beforeEach(() => {
  // The text box: 1000px tall, 600px wide, left edge at 100.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("cm-content")
      ? ({ ...rect, top: 0, bottom: 1000, left: 100, right: 700, width: 600, height: 1000 } as DOMRect)
      : (rect as DOMRect);
  });
  vi.spyOn(EditorView.prototype, "posAtCoords").mockImplementation(function (this: EditorView, { y }) {
    const lines = this.state.doc.lines;
    return this.state.doc.line(Math.min(lines, Math.floor(y / LINE) + 1)).from;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  window.matchMedia = original;
  setAppState({ toasts: [] });
});

function media(matching: string[]) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: matching.includes(query), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}
const phone = () => media(["(pointer: coarse)", "(max-width: 900px)"]);
const desktop = () => media([]);

const TAGS: TagItem[] = [{ id: "t1", name: "idea", kind: "own" }, { id: "t2", name: "review", kind: "own" }];

function setup(value: string, extra: Partial<React.ComponentProps<typeof MarkdownEditor>> = {}) {
  const utils = render(
    <MarkdownEditor nodeKey="n1" noteTitle="My note" value={value} onChange={vi.fn()} nodes={[]} workspaceTags={TAGS}
      onMediaInsert={vi.fn(async () => null)} {...extra} />,
  );
  const view = EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const wrap = utils.container.querySelector<HTMLElement>(".md-editor-wrap")!;
  const handle = () => utils.container.querySelector<HTMLElement>(".md-paragraph-handle");
  /** The mouse on line `n` (1-based). The handle waits for an animation frame and then SETTLE_MS (ParagraphHandle.tsx),
   *  so those two timers run on a fake clock that is advanced past both: no wall-clock guess that a slow machine can miss. */
  const hover = async (n: number) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    try {
      await act(async () => {
        fireEvent.mouseMove(wrap, { clientX: 400, clientY: (n - 1) * LINE + 5 });
        await vi.advanceTimersByTimeAsync(HANDLE_SETTLED_MS);
      });
    } finally {
      vi.useRealTimers();
    }
  };
  const caret = (from: number, to = from) => act(() => { view.dispatch({ selection: { anchor: from, head: to } }); });
  act(() => { view.contentDOM.focus(); });
  return { ...utils, view, wrap, handle, hover, caret, text: () => view.state.doc.toString() };
}

const itemsOf = () => within(screen.getByRole("menu", { name: "This paragraph" })).getAllByRole("menuitem").map((i) => i.textContent);

describe("when the handle shows", { timeout: 30_000 }, () => {
  it("none until the mouse is on a paragraph; then one handle, on that paragraph's first line", async () => {
    desktop();
    const s = setup("first\n\nsecond line\nwraps on");
    expect(s.handle()).toBeNull();
    await s.hover(1);
    expect(s.handle()).toBeTruthy();
    expect(s.container.querySelectorAll(".md-paragraph-handle")).toHaveLength(1);
    // Line 4 belongs to the paragraph that starts on line 3: the handle belongs to the paragraph.
    await s.hover(4);
    await act(async () => { fireEvent.click(s.handle()!); });
    expect(s.view.state.selection.main.head).toBe(s.text().indexOf("second"));
  });

  it("after the note changed under a resting handle, a click acts on the paragraph beside it, never a stale position", async () => {
    desktop();
    const s = setup("first\n\nsecond line\nwraps on");
    await s.hover(4);
    // A sync (or undo, a paste) shortens the note while the handle stays where it is.
    act(() => { s.view.dispatch({ changes: { from: 5, to: s.view.state.doc.length } }); });
    await act(async () => { fireEvent.click(s.handle()!); });
    expect(s.text()).toBe("first");
    expect(s.view.state.selection.main.head).toBe(0);
  });

  it.each([
    ["a code block", "```\ncode\n```", 2],
    ["a table", "| a | b |\n| - | - |\n| 1 | 2 |", 3],
    ["front matter", "---\ntitle: x\n---\n\nbody", 2],
    ["a blank line", "one\n\ntwo", 2],
  ])("not on %s", async (_name, doc, line) => {
    desktop();
    const s = setup(doc);
    await s.hover(line);
    expect(s.handle()).toBeNull();
  });

  it("shows on a heading and a list item", async () => {
    desktop();
    const s = setup("# Title\n\n- item");
    await s.hover(1);
    expect(s.handle()).toBeTruthy();
    await s.hover(3);
    expect(s.handle()).toBeTruthy();
  });

  it("not on a phone or touch screen", async () => {
    phone();
    const s = setup("some text");
    await s.hover(1);
    expect(s.handle()).toBeNull();
    media(["(pointer: coarse)"]);
    const t = setup("some text");
    await t.hover(1);
    expect(t.handle()).toBeNull();
  });

  it("goes away while typing and comes back with the mouse", async () => {
    desktop();
    const s = setup("some text");
    await s.hover(1);
    expect(s.handle()).toBeTruthy();
    act(() => { fireEvent.keyDown(s.view.contentDOM, { key: "a" }); });
    expect(s.handle()).toBeNull();
    await s.hover(1);
    expect(s.handle()).toBeTruthy();
  });

  it("a read-only note shows it only for what reads: the paragraph's history", async () => {
    desktop();
    const s = setup("some text", { readOnly: true });
    await s.hover(1);
    await act(async () => { fireEvent.click(s.handle()!); });
    expect(itemsOf()).toEqual(["History of this part…", "Edit the toolbar…"]);
    const noHistory = setup("other text", { readOnly: true, nodeKey: undefined });
    await noHistory.hover(1);
    expect(noHistory.handle()).toBeNull();
  });
});

describe("the handle's menu", { timeout: 30_000 }, () => {
  const doc = "one\n\n- [ ] call Sam";
  const extra = { onCreateTask: vi.fn(async () => true) };

  it("is the toolbars' action list: the same actions, from the same code, in the same order", async () => {
    phone();
    const p = setup(doc, extra);
    p.caret(doc.indexOf("call"));
    // The phone bar draws two of them in words; the rest wait in 更多.
    const bar = within(p.container.querySelector<HTMLElement>(".md-mobile-toolbar")!);
    const drawn = Array.from(p.container.querySelectorAll<HTMLElement>(".md-mobile-toolbar [data-tool]")).map((b) => b.getAttribute("aria-label")!);
    await act(async () => { fireEvent.pointerDown(bar.getByLabelText("More")); fireEvent.click(bar.getByLabelText("More")); });
    const inMore = within(screen.getByRole("menu", { name: "More" })).getAllByRole("menuitem").map((i) => i.textContent!.replace(/Needs a connection.*$/, ""));
    const onPhone = new Set([
      ...drawn,
      ...inMore.filter((label) => !["Bold", "Heading 1", "Heading 2", "Italic", "Inline code", "Bullet list", "Numbered list", "Checklist", "Quote", "Link to a note", "Insert file"].includes(label)),
    ]);
    p.unmount();
    document.body.innerHTML = "";

    desktop();
    const s = setup(doc, extra);
    await s.hover(3);
    await act(async () => { fireEvent.click(s.handle()!); });
    const onDesktop = itemsOf().map((label) => label.replace(/Needs a connection.*$/, ""));
    expect(onDesktop).toEqual(["Add tag", "Copy block link", "History of this part…", "Turn into a child note", "Convert this checkbox into an agenda task", "Edit the toolbar…"]);
    for (const label of ["Copy block link", "History of this part…", "Turn into a child note", "Convert this checkbox into an agenda task"]) expect(onPhone.has(label), label).toBe(true);
    expect(drawn).toContain("Add tag");
    // 「這段」 as a menu of its own is gone: the handle's menu is the action list.
    expect(onDesktop).not.toContain("Make this block a review card");
  });

  it("acts on the handle's paragraph, not where the caret was", async () => {
    desktop();
    const s = setup("one\n\ntwo words");
    s.caret(1);
    await s.hover(3);
    await act(async () => { fireEvent.click(s.handle()!); });
    act(() => { fireEvent.click(screen.getByText("Add tag")); });
    act(() => { fireEvent.click(within(screen.getByRole("dialog", { name: "Tag this paragraph" })).getByText("idea")); });
    expect(s.text()).toBe("one\n\ntwo words {idea}");
  });

  it("copies the block link of that paragraph", async () => {
    desktop();
    const writeText = vi.fn(async (_t: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const s = setup("one\n\ntwo words");
    await s.hover(3);
    await act(async () => { fireEvent.click(s.handle()!); });
    await act(async () => { fireEvent.click(screen.getByText("Copy block link")); });
    expect(s.text()).toBe("one\n\ntwo words"); // nothing is written into the note
    expect(writeText).toHaveBeenCalledWith("[[My note/two words]]");
  });

  it("the handle stays put while the menu is open, and leaves when it closes", async () => {
    desktop();
    const s = setup("one\n\ntwo");
    await s.hover(1);
    await act(async () => { fireEvent.click(s.handle()!); });
    await s.hover(3);
    expect(s.handle()!.getAttribute("aria-expanded")).toBe("true");
    act(() => { fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" }); });
    await waitFor(() => expect(s.handle()).toBeNull());
  });
});

describe("the keyboard", { timeout: 30_000 }, () => {
  const chord = () => effectiveShortcuts().find((x) => x.id === "paragraph-menu")!.chord;

  it("has a shortcut in the list that the editor does not already use", () => {
    expect(chord()).toBe("alt+p");
  });

  it("Alt+P with the caret in a paragraph opens that paragraph's menu", async () => {
    desktop();
    const s = setup("one\n\ntwo words");
    s.caret(7);
    await act(async () => { fireEvent.keyDown(s.view.contentDOM, { key: "p", code: "KeyP", altKey: true }); });
    expect(itemsOf()).toContain("Add tag");
    expect(s.handle()).toBeTruthy();
    act(() => { fireEvent.click(screen.getByText("Add tag")); });
    act(() => { fireEvent.click(within(screen.getByRole("dialog", { name: "Tag this paragraph" })).getByText("review")); });
    expect(s.text()).toBe("one\n\ntwo words {review}");
  });

  it("opens nothing where there is no paragraph", async () => {
    desktop();
    const s = setup("```\ncode\n```");
    s.caret(6);
    await act(async () => { fireEvent.keyDown(s.view.contentDOM, { key: "p", code: "KeyP", altKey: true }); });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
