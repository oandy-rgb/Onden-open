// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { INSERT_MEDIA_ACCEPT } from "../lib/mediaInsert";
import MarkdownEditor from "../components/MarkdownEditor";
import { getAppState, setAppState } from "../lib/appStore";
import type { Tag } from "../lib/api";
import type { TagItem } from "../lib/editorCompletion";
import { blockFunctions } from "../lib/tagFunctions";
import { DEFAULT_TOOLBAR_LAYOUT, setToolShown } from "../lib/toolbarLayout";
import { toolbarLayoutStore } from "../lib/toolbarLayoutStore";

// The paragraph tools on the phone bar and the selection bar: 「加標籤」 decides what the paragraph
// becomes (a function or a tag); 交給 AI, 複製段落連結, 這段的歷史, 變成子筆記 are buttons of their own.
// There is no 「這段」 button or menu. A panel frames the paragraph it was opened on and acts on it.

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

const original = window.matchMedia;
afterEach(() => {
  window.matchMedia = original;
  setAppState({ toasts: [] });
  toolbarLayoutStore.forget();
});

function phone() {
  window.matchMedia = vi.fn((query: string) => ({
    matches: query === "(pointer: coarse)" || query === "(max-width: 900px)",
    media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

// The `#` list as hashtagSuggestionTags builds it: the person's own tags, a function's tag, a system's.
const TAGS: TagItem[] = [
  { id: "t1", name: "idea", kind: "own" },
  { id: "t2", name: "skill", kind: "function", module: { id: "skills", title: "Skills", state: "imported" } },
  { id: "t3", name: "inbox", kind: "system" },
  { id: "t4", name: "review", kind: "function", module: { id: "review", title: "Review", state: "imported" } },
];
const tag = (extra: Partial<Tag>): Tag => ({ id: extra.name ?? "x", name: "x", color: "", schema_id: "x", ...extra });
const moduleTags = [tag({ id: "m-review", name: "review", schema_module: "review" })];
/** The catalog's functions for a paragraph, with review on and tasks off (what a workspace that has not turned tasks on shows). */
const functions = (canImport = true) => blockFunctions(moduleTags, (id) => (id === "review" ? "on" : "off"), { canImport });

/** A stand-in for hooks/useHandToAi: one ready-made action, no roles. */
const handToAi = () => ({
  entry: { shown: true, blocked: null }, actions: [{ id: "rewrite", label: "Rewrite" }], noteSkills: [], roles: [], target: null,
  load: vi.fn(async () => {}), start: vi.fn(), setPick: vi.fn(),
}) as never;

function setup(value: string, extra: Partial<React.ComponentProps<typeof MarkdownEditor>> = {}) {
  const utils = render(
    <MarkdownEditor nodeKey="n1" noteTitle="My note" value={value} onChange={vi.fn()} nodes={[{ id: "x", title: "Other note" }] as never}
      workspaceTags={TAGS} blockFunctions={functions()} onMediaInsert={vi.fn(async () => null)} {...extra} />,
  );
  const view = EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const bar = () => utils.container.querySelector<HTMLElement>(".md-mobile-toolbar")!;
  const tap = (el: HTMLElement) => act(() => { fireEvent.pointerDown(el); fireEvent.click(el); });
  const caret = (from: number, to = from) => act(() => { view.dispatch({ selection: { anchor: from, head: to } }); });
  act(() => { view.contentDOM.focus(); });
  return { ...utils, view, bar, tap, caret, text: () => view.state.doc.toString(),
    /** The text of every framed line, in order: which paragraph(s) the frame is on. */
    framed: () => Array.from(utils.container.querySelectorAll(".cm-paragraph-frame")).map((el) => el.textContent) };
}

describe("the phone bar, no selection", { timeout: 30_000 }, () => {
  it("「插入檔案」 opens an image/audio/video picker and sends the file to the shared upload", async () => {
    phone();
    const file = new File(["x"], "clip.mp4", { type: "video/mp4" });
    const accepts: string[] = [];
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      accepts.push(this.accept);
      Object.defineProperty(this, "files", { value: [file] });
      this.dispatchEvent(new Event("change"));
    });
    const onMediaInsert = vi.fn(async () => "\n![clip](/api/media/c.mp4)\n");
    try {
      const s = setup("hello", { onMediaInsert });
      s.tap(within(s.bar()).getByLabelText("Insert file"));
      await waitFor(() => expect(onMediaInsert).toHaveBeenCalledWith(file));
      expect(accepts).toEqual([INSERT_MEDIA_ACCEPT]);
      await waitFor(() => expect(s.text()).toContain("![clip](/api/media/c.mp4)"));
      expect(within(s.bar()).getByLabelText("Insert file").className).toContain("md-mobile-tool");
    } finally { click.mockRestore(); }
  });

  it("starts with 加標籤 and 複製段落連結 in words, then the other tools; there is no 「這段」 button", () => {
    phone();
    const s = setup("hello", { handToAi: handToAi() });
    const buttons = Array.from(s.bar().querySelectorAll<HTMLElement>(".md-mobile-toolbar-scroll > button"));
    const labels = buttons.map((b) => b.getAttribute("aria-label"));
    expect(labels.slice(0, 3)).toEqual(["Add tag", "Copy block link", "AI"]);
    expect(labels).not.toContain("This paragraph");
    // Only two Onden actions carry words on a touch bar; the rest (and 「變成子筆記」) wait in 更多.
    expect(buttons[0]!.textContent).toBe("Add tag");
    expect(buttons[1]!.textContent).toBe("Copy block link");
    expect(buttons[2]!.textContent).toBe("");
    expect(s.bar().querySelector("svg.lucide-grip-vertical")).toBeNull();
    // 「複製段落連結」 and 「連結到筆記」 are not the same icon.
    expect(buttons[1]!.querySelector("svg")!.getAttribute("class")).not.toBe(within(s.bar()).getByLabelText("Link to a note").querySelector("svg")!.getAttribute("class"));
    expect(s.bar().textContent).not.toContain("¶");
  });

  it("a swipe that starts on a button scrolls the bar and presses nothing", () => {
    phone();
    const s = setup("hello");
    s.caret(0);
    // The browser takes the touch for scrolling: pointerdown, then pointercancel, no click.
    for (const label of ["Bold", "Heading 1", "Bullet list", "Link to a note"]) {
      const button = within(s.bar()).getByLabelText(label);
      act(() => { fireEvent.pointerDown(button); fireEvent.pointerCancel(button); });
    }
    expect(s.text()).toBe("hello");
    s.tap(within(s.bar()).getByLabelText("Bullet list"));
    expect(s.text()).toBe("- hello");
  });

  it("Link types [[ at the caret and opens the note popup, as typing it does", () => {
    phone();
    const s = setup("see ");
    s.caret(4);
    s.tap(within(s.bar()).getByLabelText("Link to a note"));
    expect(s.text()).toBe("see [[");
    expect(document.querySelector(".slash-menu-popup")).toBeTruthy();
    expect(screen.getByText("Other note")).toBeTruthy();
  });

  it("the buttons are disabled where there is no paragraph, with the reason as title and aria-disabled", () => {
    phone();
    const s = setup("```\ncode\n```", { handToAi: handToAi() });
    s.caret(6);
    for (const label of ["Add tag", "Copy block link", "AI"]) {
      const button = within(s.bar()).getByLabelText(label) as HTMLButtonElement;
      expect(button.disabled, label).toBe(true);
      expect(button.getAttribute("aria-disabled"), label).toBe("true");
      expect(button.title, label).toBe("Put the cursor in a paragraph first");
    }
    s.tap(within(s.bar()).getByLabelText("Add tag"));
    expect(screen.queryByRole("dialog", { name: "Tag this paragraph" })).toBeNull();
  });
});

describe("加標籤", { timeout: 30_000 }, () => {
  const open = (s: ReturnType<typeof setup>) => { s.tap(within(s.bar()).getByLabelText("Add tag")); return screen.getByRole("dialog", { name: "Tag this paragraph" }); };

  it("opens a picker for THIS paragraph; picking writes {name} in one undo step, never #word", () => {
    phone();
    const s = setup("one\n\ntwo words");
    s.caret(7);
    const picker = open(s);
    // Focus left the editor for the picker, but the bar stays up.
    expect(s.bar()).toBeTruthy();
    fireEvent.change(within(picker).getByPlaceholderText("Search tags or functions…"), { target: { value: "ide" } });
    act(() => { fireEvent.click(within(picker).getByText("idea")); });
    expect(s.text()).toBe("one\n\ntwo words {idea}");
    expect(screen.queryByRole("dialog", { name: "Tag this paragraph" })).toBeNull();
    act(() => { undo(s.view); });
    expect(s.text()).toBe("one\n\ntwo words");
  });

  it("still tags the paragraph it was opened on after the caret moved somewhere else", () => {
    phone();
    const s = setup("one\n\ntwo words\n\nthree");
    s.caret(7);
    const picker = open(s);
    s.caret(0); // the caret leaves while the picker is open
    act(() => { fireEvent.click(within(picker).getByText("idea")); });
    expect(s.text()).toBe("one\n\ntwo words {idea}\n\nthree");
  });

  it("creates a new name, and Enter takes the exact match", () => {
    phone();
    const s = setup("para");
    s.caret(2);
    open(s);
    const input = screen.getByPlaceholderText("Search tags or functions…");
    fireEvent.change(input, { target: { value: "fresh" } });
    expect(screen.getByText("Create tag “fresh”")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(s.text()).toBe("para {fresh}");
  });

  it("an input method's composition neither sends nor filters, and Enter in it picks nothing", () => {
    phone();
    const s = setup("para");
    s.caret(2);
    open(s);
    const input = screen.getByPlaceholderText("Search tags or functions…") as HTMLInputElement;
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "ㄧ" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(s.text()).toBe("para");
    // The list is not filtered mid-composition: every own tag is still there.
    expect(screen.getByText("idea")).toBeTruthy();
    fireEvent.compositionEnd(input, { target: { value: "ide" } });
    fireEvent.change(input, { target: { value: "ide" } });
    expect(screen.getByText("idea")).toBeTruthy();
    expect(screen.queryByText("Review")).toBeNull();
  });

  it("「你的標籤」 lists only the person's own tags: a function's raw tag (skill, review) and a system's (inbox) are not named", () => {
    phone();
    const s = setup("para");
    s.caret(2);
    const picker = open(s);
    const own = within(picker).getByText("Your tags").parentElement!;
    const rows = Array.from(own.querySelectorAll(".paragraph-tag-row")).map((row) => row.textContent);
    expect(rows).toEqual(["idea"]);
    for (const raw of ["skill", "inbox", "task", "review"]) expect(within(picker).queryByText(raw)).toBeNull();
  });

  it("「試試功能」 comes from the function catalog: an on function applies at once and shows its result", () => {
    phone();
    const s = setup("one\n\ntwo words");
    s.caret(7);
    const picker = open(s);
    expect(within(picker).getByText("Try a function")).toBeTruthy();
    // The catalog's name and the block action's one line, never the raw tag.
    expect(within(picker).getByText("Make this block a review card")).toBeTruthy();
    act(() => { fireEvent.click(within(picker).getByText("Make this block a review card")); });
    expect(s.text()).toBe("one\n\ntwo words {review}");
    expect(screen.queryByRole("dialog", { name: "Tag this paragraph" })).toBeNull();
  });

  it("a function that is not on shows the catalog's example; 開啟並套用 turns it on and applies it", async () => {
    phone();
    const onImportModuleTag = vi.fn(async () => "task");
    const s = setup("one\n\ntwo words", { onImportModuleTag });
    s.caret(7);
    const picker = open(s);
    const row = within(picker).getByText("Make this block a task").closest("button")!;
    expect(row.textContent).toContain("Not on yet");
    act(() => { fireEvent.click(row); });
    // Nothing is written, nothing is turned on yet: the example card first.
    expect(s.text()).toBe("one\n\ntwo words");
    expect(onImportModuleTag).not.toHaveBeenCalled();
    const card = screen.getByRole("dialog", { name: "Tasks" });
    expect(within(card).getByText("This note gets a checkbox you can tick off when it is done.")).toBeTruthy();
    expect(within(card).getByText("Book the dentist")).toBeTruthy();
    await act(async () => { fireEvent.click(within(card).getByText("Turn on and apply")); });
    expect(onImportModuleTag).toHaveBeenCalledWith("tasks", "task");
    expect(s.text()).toBe("one\n\ntwo words {task}");
  });

  it("a person who can't decide sees the example but no 開啟並套用", () => {
    phone();
    const s = setup("para", { blockFunctions: functions(false), onImportModuleTag: undefined });
    s.caret(2);
    const picker = open(s);
    act(() => { fireEvent.click(within(picker).getByText("Make this block a task").closest("button")!); });
    const card = screen.getByRole("dialog", { name: "Tasks" });
    expect(within(card).queryByText("Turn on and apply")).toBeNull();
    act(() => { fireEvent.click(within(card).getByText("Not now")); });
    expect(screen.getByRole("dialog", { name: "Tag this paragraph" })).toBeTruthy();
  });

  it("typing filters functions and tags together; a used function moves after the ones not tried; the group can be hidden", () => {
    phone();
    const s = setup("para");
    s.caret(2);
    const picker = open(s);
    fireEvent.change(within(picker).getByPlaceholderText("Search tags or functions…"), { target: { value: "idea" } });
    expect(within(picker).queryByText("Try a function")).toBeNull();
    fireEvent.change(within(picker).getByPlaceholderText("Search tags or functions…"), { target: { value: "" } });
    act(() => { fireEvent.click(within(picker).getByText("Don't suggest functions")); });
    expect(within(picker).queryByText("Try a function")).toBeNull();
    expect(within(picker).getByText("Show functions again")).toBeTruthy();
    // Typing still finds them while the group is hidden.
    fireEvent.change(within(picker).getByPlaceholderText("Search tags or functions…"), { target: { value: "review" } });
    expect(within(picker).getByText("Make this block a review card")).toBeTruthy();
  });

  it("where there is no paragraph it says so and opens nothing", () => {
    phone();
    const s = setup("```\ncode\n```");
    s.caret(6);
    // The button is disabled; a keyboard route (the handle's menu) says it in a notice.
    expect((within(s.bar()).getByLabelText("Add tag") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("dialog", { name: "Tag this paragraph" })).toBeNull();
  });
});

describe("the frame around the paragraph a panel works on", { timeout: 30_000 }, () => {
  it("加標籤 and 交給 AI frame the same paragraph while open, and the frame is gone when they close", async () => {
    phone();
    const s = setup("one\n\ntwo words\n\nthree", { handToAi: handToAi() });
    s.caret(7);
    expect(s.framed()).toEqual([]);
    s.tap(within(s.bar()).getByLabelText("Add tag"));
    expect(s.framed()).toEqual(["two words"]);
    act(() => { fireEvent.keyDown(screen.getByRole("dialog", { name: "Tag this paragraph" }), { key: "Escape" }); });
    expect(s.framed()).toEqual([]);
    s.tap(within(s.bar()).getByLabelText("AI"));
    expect(s.framed()).toEqual(["two words"]);
    const menu = await screen.findByRole("menu");
    act(() => { fireEvent.keyDown(menu, { key: "Escape" }); });
    expect(s.framed()).toEqual([]);
  });

  it("the frame is not part of the note and not an undo step", () => {
    phone();
    const s = setup("one\n\ntwo words");
    s.caret(7);
    s.tap(within(s.bar()).getByLabelText("Add tag"));
    expect(s.framed()).toEqual(["two words"]);
    expect(s.text()).toBe("one\n\ntwo words");
    act(() => { fireEvent.click(within(screen.getByRole("dialog", { name: "Tag this paragraph" })).getByText("idea")); });
    act(() => { undo(s.view); });
    expect(s.text()).toBe("one\n\ntwo words");
  });

  it("a paragraph's hidden ^id is inside its frame, and a quote's id line after it", () => {
    phone();
    const s = setup("one\n\ntwo words ^abc123\n\n> quoted\n^q1234");
    s.caret(7);
    s.tap(within(s.bar()).getByLabelText("Add tag"));
    expect(s.view.state.doc.lineAt(7).text).toBe("two words ^abc123");
    expect(s.view.dom.querySelectorAll(".cm-paragraph-frame").length).toBe(1);
    act(() => { fireEvent.keyDown(screen.getByRole("dialog", { name: "Tag this paragraph" }), { key: "Escape" }); });
    s.caret(s.text().indexOf("quoted"));
    s.tap(within(s.bar()).getByLabelText("Add tag"));
    // Both lines of the quote block, the id line included.
    expect(s.view.dom.querySelectorAll(".cm-paragraph-frame").length).toBe(2);
  });
});

describe("交給 AI", { timeout: 30_000 }, () => {
  it("is the existing 「交給 AI」 menu on the remembered paragraph: the ready-made actions, and what is handed over is the paragraph's words", async () => {
    phone();
    const hand = handToAi() as unknown as { load: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn> };
    const s = setup("one\n\ntwo words {idea}\n\nthree", { handToAi: hand as never });
    s.caret(7);
    s.tap(within(s.bar()).getByLabelText("AI"));
    expect(hand.load).toHaveBeenCalledOnce(); // the roles are looked up when the menu opens
    const menu = await screen.findByRole("menu", { name: "This paragraph" });
    s.caret(0); // the caret moves away; the AI still works on the remembered paragraph
    act(() => { fireEvent.click(within(menu).getByText("Rewrite")); });
    expect(hand.start).toHaveBeenCalledWith(expect.objectContaining({ skill: "rewrite", text: "two words" }));
    // Nothing of the old `@ai` line: the note itself is untouched.
    expect(s.text()).toBe("one\n\ntwo words {idea}\n\nthree");
  });

  it("is not offered when the note can't hand text over, or can't be edited", () => {
    phone();
    const without = setup("hello");
    expect(within(without.bar()).queryByLabelText("AI")).toBeNull();
    without.unmount();
    const blocked = { ...(handToAi() as object), entry: { shown: false, blocked: null } } as never;
    const s = setup("hello", { handToAi: blocked });
    expect(within(s.bar()).queryByLabelText("AI")).toBeNull();
  });
});

describe("複製段落連結", { timeout: 30_000 }, () => {
  const press = async (s: ReturnType<typeof setup>) => {
    s.tap(within(s.bar()).getByLabelText("Copy block link"));
    await act(async () => { await Promise.resolve(); });
  };

  it("copies [[title/first words]] without writing anything, flashes the paragraph and says to paste it into a note", async () => {
    phone();
    const writeText = vi.fn(async (_t: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const s = setup("one\n\ntwo words");
    s.caret(7);
    await press(s);
    expect(s.text()).toBe("one\n\ntwo words");
    expect(writeText.mock.calls[0]![0]).toBe("[[My note/two words]]");
    expect(getAppState().toasts.map((t) => t.message)).toContain("Link copied · paste it into any note");
    // The paragraph flashes, then the frame goes by itself.
    expect(s.view.dom.querySelectorAll(".cm-paragraph-frame--flash").length).toBe(1);
    expect(s.framed()).toEqual(["two words"]);
    await waitFor(() => expect(s.framed()).toEqual([]), { timeout: 3000 });
  });

  it("shows the link when the clipboard refuses", async () => {
    phone();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => { throw new Error("denied"); }) }, configurable: true });
    const s = setup("two words");
    s.caret(2);
    await press(s);
    const toast = getAppState().toasts.map((t) => t.message).find((m) => m.startsWith("Couldn't copy"));
    expect(toast).toBe("Couldn't copy — copy the link yourself: [[My note/two words]]");
    expect(s.text()).toBe("two words");
  });
});

describe("the selection bar", { timeout: 30_000 }, () => {
  const moreItems = () => within(screen.getByRole("menu", { name: "More" })).getAllByRole("menuitem").map((i) => i.textContent);

  it("has formatting, then 變成子筆記 and 加標籤 in words; the rest waits in 更多", () => {
    phone();
    const s = setup("- [ ] call Sam", { onCreateTask: vi.fn(async () => true), handToAi: handToAi() });
    s.caret(6, 10);
    const bar = within(s.bar());
    for (const label of ["Bold", "Link", "Quote", "Heading 1", "AI"]) expect(bar.getByLabelText(label).textContent).toBe("");
    expect(bar.getByLabelText("Turn into a child note").textContent).toBe("Turn into a child note");
    expect(bar.getByLabelText("Add tag").textContent).toBe("Add tag");
    // No 「這段」 button, and no module action group: a function is chosen in the tag panel.
    for (const label of ["This paragraph", "Convert this checkbox into an agenda task", "Make this block a review card", "Extract selection to a new entity (typed)"]) {
      expect(bar.queryByLabelText(label)).toBeNull();
    }
    s.tap(bar.getByLabelText("More"));
    expect(moreItems()).toEqual(["Copy block link", "History of this part…", "Convert this checkbox into an agenda task", "Edit the toolbar…"]);
  });

  it("加標籤 tags every paragraph the selection touches, in one undo step", () => {
    phone();
    const s = setup("one\n\ntwo words\n\nthree\n\nfour");
    s.caret(1, 18);
    s.tap(within(s.bar()).getByLabelText("Add tag"));
    const picker = screen.getByRole("dialog", { name: "Tag this paragraph" });
    // The bar stays up while focus is in the picker, and the touched paragraphs are framed.
    expect(s.bar()).toBeTruthy();
    expect(s.framed()).toEqual(["one", "", "two words", "", "three"]); // one box over the three paragraphs and the blank lines between
    act(() => { fireEvent.click(within(picker).getByText("idea")); });
    expect(s.text()).toBe("one {idea}\n\ntwo words {idea}\n\nthree {idea}\n\nfour");
    act(() => { undo(s.view); });
    expect(s.text()).toBe("one\n\ntwo words\n\nthree\n\nfour");
  });

  it("加標籤 on a selection inside one paragraph tags that paragraph, and a new name is made", () => {
    phone();
    const s = setup("one\n\ntwo words");
    s.caret(7, 10);
    s.tap(within(s.bar()).getByLabelText("Add tag"));
    const input = screen.getByPlaceholderText("Search tags or functions…");
    fireEvent.change(input, { target: { value: "fresh" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(s.text()).toBe("one\n\ntwo words {fresh}");
  });

  it("加標籤 where the selection touches no paragraph is disabled", () => {
    phone();
    const s = setup("```\ncode\n```");
    s.caret(4, 8);
    const button = within(s.bar()).getByLabelText("Add tag") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Put the cursor in a paragraph first");
  });

  it("交給 AI on a selection hands over the selected words", async () => {
    phone();
    const hand = handToAi() as unknown as { start: ReturnType<typeof vi.fn> };
    const s = setup("some words here", { handToAi: hand as never });
    s.caret(5, 10);
    s.tap(within(s.bar()).getByLabelText("AI"));
    const menu = await screen.findByRole("menu", { name: "Selected text" });
    act(() => { fireEvent.click(within(menu).getByText("Rewrite")); });
    expect(hand.start).toHaveBeenCalledWith(expect.objectContaining({ text: "words" }));
  });

  it("a hidden button is still there: 更多 has it, and it runs", () => {
    phone();
    toolbarLayoutStore.stage(setToolShown(DEFAULT_TOOLBAR_LAYOUT, "selection", "bold", false));
    const s = setup("hello world");
    s.caret(0, 5);
    expect(within(s.bar()).queryByLabelText("Bold")).toBeNull();
    s.tap(within(s.bar()).getByLabelText("More"));
    act(() => { fireEvent.click(within(screen.getByRole("menu", { name: "More" })).getByText("Bold")); });
    expect(s.text()).toBe("**hello** world");
  });
});

describe("the phone bar follows the layout", { timeout: 30_000 }, () => {
  it("the four actions can be turned off: they leave the bar and wait in 更多, where they still run", async () => {
    phone();
    const writeText = vi.fn(async (_t: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    let layout = setToolShown(DEFAULT_TOOLBAR_LAYOUT, "bar", "bold", false);
    for (const id of ["copyLink", "ai", "history", "toChild"]) layout = setToolShown(layout, "bar", id, false);
    toolbarLayoutStore.stage(layout);
    const s = setup("one\n\ntwo words", { handToAi: handToAi() });
    s.caret(7);
    const bar = within(s.bar());
    for (const label of ["Bold", "Copy block link", "AI", "History of this part…", "Turn into a child note"]) expect(bar.queryByLabelText(label), label).toBeNull();
    s.tap(bar.getByLabelText("More"));
    const items = within(screen.getByRole("menu", { name: "More" })).getAllByRole("menuitem").map((i) => i.textContent);
    expect(items).toEqual(expect.arrayContaining(["Bold", "Copy block link", "AI", "Turn into a child note"].map((name) => expect.stringContaining(name))));
    await act(async () => { fireEvent.click(within(screen.getByRole("menu", { name: "More" })).getByText("Copy block link")); });
    expect(writeText).toHaveBeenCalledWith("[[My note/two words]]");
  });

  it("a panel opened from 更多 acts on the paragraph the caret was in", () => {
    phone();
    toolbarLayoutStore.stage(setToolShown(DEFAULT_TOOLBAR_LAYOUT, "bar", "tag", false));
    const s = setup("one\n\ntwo words");
    s.caret(7);
    s.tap(within(s.bar()).getByLabelText("More"));
    act(() => { fireEvent.click(within(screen.getByRole("menu", { name: "More" })).getByText("Add tag")); });
    expect(s.framed()).toEqual(["two words"]);
    act(() => { fireEvent.click(within(screen.getByRole("dialog", { name: "Tag this paragraph" })).getByText("idea")); });
    expect(s.text()).toBe("one\n\ntwo words {idea}");
  });

  it("offers Convert checkbox only on a checkbox line, and 展開 only on a child's embed line", () => {
    phone();
    const s = setup("- [ ] call Sam\n\nplain", { onCreateTask: vi.fn(async () => true) });
    const moreItems = () => {
      s.tap(within(s.bar()).getByLabelText("More"));
      const items = within(screen.getByRole("menu", { name: "More" })).getAllByRole("menuitem").map((i) => i.textContent);
      act(() => { fireEvent.keyDown(screen.getByRole("menu", { name: "More" }), { key: "Escape" }); });
      return items;
    };
    s.caret(4);
    expect(moreItems()).toContain("Convert this checkbox into an agenda task");
    s.caret(18);
    expect(moreItems()).not.toContain("Convert this checkbox into an agenda task");
    expect(moreItems()).not.toContain("Expand back into the text");
  });

  it("on a touch bar only the first two Onden buttons carry words; 變成子筆記 and 這段的歷史 wait in 更多", () => {
    phone();
    const s = setup("hello");
    s.caret(1);
    s.tap(within(s.bar()).getByLabelText("More"));
    const items = within(screen.getByRole("menu", { name: "More" })).getAllByRole("menuitem").map((i) => i.textContent);
    expect(items.join("|")).toContain("Turn into a child note");
    expect(items.join("|")).toContain("History of this part…");
    expect(within(s.bar()).queryByLabelText("This paragraph")).toBeNull();
  });
});

describe("the desktop selection bubble", { timeout: 30_000 }, () => {
  it("has Copy block link, in 更多", async () => {
    window.matchMedia = vi.fn((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
    const writeText = vi.fn(async (_t: string) => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const s = setup("some words here");
    s.caret(0, 4);
    expect(document.querySelector(".tiptap-bubble-menu [aria-label='Copy block link']")).toBeNull();
    act(() => { fireEvent.click(document.querySelector<HTMLElement>(".tiptap-bubble-menu [aria-label='More']")!); });
    await act(async () => { fireEvent.click(within(screen.getByRole("menu", { name: "More" })).getByText("Copy block link")); });
    expect(writeText).toHaveBeenCalledWith("[[My note/some words here]]");
    expect(s.text()).toBe("some words here"); // nothing is written into the note
  });

  it("加標籤 in the bubble opens the same panel, below the bubble, and the bubble stays while it is open", () => {
    window.matchMedia = vi.fn((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })) as unknown as typeof window.matchMedia;
    const s = setup("one\n\ntwo words");
    s.caret(5, 9);
    act(() => { fireEvent.click(document.querySelector<HTMLElement>(".tiptap-bubble-menu [aria-label='Add tag']")!); });
    const picker = screen.getByRole("dialog", { name: "Tag this paragraph" });
    expect(s.framed()).toEqual(["two words"]);
    act(() => { fireEvent.click(within(picker).getByText("idea")); });
    expect(s.text()).toBe("one\n\ntwo words {idea}");
  });
});
