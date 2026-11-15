import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import MarkdownEditor from "../components/MarkdownEditor";
import { detectPopupTrigger } from "../lib/editorCompletion";

// Enter in a quote keeps the quote going; Enter on an empty quote line leaves it — the way an
// empty list item does. `/` opens the menu after a quote's `> ` too.

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

function setup(value: string, at?: number) {
  const { container } = render(<MarkdownEditor value={value} onChange={vi.fn()} nodes={[]} onMediaInsert={vi.fn(async () => null)} />);
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
  view.focus();
  view.dispatch({ selection: { anchor: at ?? view.state.doc.length } });
  return view;
}
const enter = (view: EditorView) => fireEvent.keyDown(view.contentDOM, { key: "Enter" });
const type = (view: EditorView, text: string) => {
  const at = view.state.selection.main.head;
  view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: "input.type" });
};

describe("Enter in a quote", () => {
  it("continues the quote, and a second Enter on the empty quote line leaves it", () => {
    const view = setup("> 引用一段話");
    enter(view);
    expect(view.state.doc.toString()).toBe("> 引用一段話\n> ");
    enter(view);
    expect(view.state.doc.toString()).toBe("> 引用一段話\n");
  });

  it("keeps nested quote marks and a callout's body in the quote", () => {
    const nested = setup("> > 內層");
    enter(nested);
    expect(nested.state.doc.toString()).toBe("> > 內層\n> > ");
    const callout = setup("> [!note] 提醒");
    enter(callout);
    expect(callout.state.doc.toString()).toBe("> [!note] 提醒\n> ");
    enter(callout);
    expect(callout.state.doc.toString()).toBe("> [!note] 提醒\n");
  });

  it("leaves Enter to the IME while a candidate is being composed", () => {
    const view = setup("> 引用");
    // jsdom cannot start a real composition; view.composing is what the handlers read.
    Object.defineProperty(view, "composing", { get: () => true });
    // The browser's Enter mid-composition arrives as an insertParagraph input event.
    view.contentDOM.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertParagraph", bubbles: true, cancelable: true }));
    expect(view.state.doc.toString()).toBe("> 引用");
  });

  it("a list item still ends on the second Enter", () => {
    const view = setup("- [ ] 寫作業");
    enter(view);
    expect(view.state.doc.toString()).toBe("- [ ] 寫作業\n- [ ] ");
    enter(view);
    expect(view.state.doc.toString()).toBe("- [ ] 寫作業\n");
  });
});

describe("Enter keeps the marks it should", () => {
  it("with the caret right after the marks, splits the line and keeps them", () => {
    const quote = setup("> hello", 2);
    enter(quote);
    expect(quote.state.doc.toString()).toBe("> \n> hello");
    const task = setup("- [ ] 寫作業", 6);
    enter(task);
    expect(task.state.doc.toString()).toBe("- [ ] \n- [ ] 寫作業");
  });

  it("treats a caret just after a checkbox's `]` as after it", () => {
    const task = setup("- [ ] 寫作業", 5);
    enter(task);
    expect(task.state.doc.toString()).toBe("- [ ] \n- [ ] 寫作業");
  });

  it("keeps the list mark inside a quote, with the next number", () => {
    const bullet = setup("> - item");
    enter(bullet);
    expect(bullet.state.doc.toString()).toBe("> - item\n> - ");
    const numbered = setup("> 1. a");
    enter(numbered);
    expect(numbered.state.doc.toString()).toBe("> 1. a\n> 2. ");
  });

  it("leaves one level at a time", () => {
    const list = setup("> - a\n> - ");
    enter(list);
    expect(list.state.doc.toString()).toBe("> - a\n> ");
    enter(list);
    expect(list.state.doc.toString()).toBe("> - a\n");
    const nested = setup("> > ");
    enter(nested);
    expect(nested.state.doc.toString()).toBe("> ");
  });

  it("does not continue a quote inside a code block", () => {
    const view = setup("```\n> in code");
    enter(view);
    expect(view.state.doc.toString()).not.toBe("```\n> in code\n> ");
  });
});

describe("slash after a quote's marks", () => {
  it("is a slash trigger whose marker is the `/`", () => {
    expect(detectPopupTrigger("/ta")).toMatchObject({ type: "slash", query: "ta", markerIndex: 0 });
    expect(detectPopupTrigger("> /")).toMatchObject({ type: "slash", query: "", markerIndex: 2 });
    expect(detectPopupTrigger(">> /ta")).toMatchObject({ type: "slash", query: "ta", markerIndex: 3 });
    expect(detectPopupTrigger("> a /")).toBeNull();
  });

  it("opens the menu in a quote line", async () => {
    const view = setup("> ");
    type(view, "/");
    await screen.findByRole("group", { name: /Suggestions|候選項目/ });
    await waitFor(() => expect(view.state.doc.toString()).toBe("> /"));
  });
});

// Scan 01 #5: a touch keyboard's Enter (beforeinput) continues a list the way the desktop's does.
describe("touch Enter in a list (beforeinput)", () => {
  const touchEnter = (view: EditorView) =>
    view.contentDOM.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertParagraph", bubbles: true, cancelable: true }));

  it("a caret right after the marker, before the text, adds an item above instead of deleting the marker", () => {
    const view = setup("- 買牛奶", 2);
    touchEnter(view);
    expect(view.state.doc.toString()).toBe("-\n- 買牛奶");
  });

  it("selected text is replaced by the line break, not kept", () => {
    // Not focused: a selection change on a focused view re-enters CodeMirror through happy-dom's selectionchange.
    const { container } = render(<MarkdownEditor value="- 買牛奶和雞蛋" onChange={vi.fn()} nodes={[]} onMediaInsert={vi.fn(async () => null)} />);
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
    view.dispatch({ selection: { anchor: 3, head: 6 } });
    touchEnter(view);
    expect(view.state.doc.toString()).not.toContain("牛奶和");
  });

  it("renumbers the numbered items that follow", () => {
    const view = setup("1. a\n2. b", 4);
    touchEnter(view);
    expect(view.state.doc.toString()).toBe("1. a\n2. \n3. b");
  });

  it("does not continue a dash line inside a code block", () => {
    const view = setup("```yaml\n- key\n```", 13);
    touchEnter(view);
    expect(view.state.doc.toString()).toBe("```yaml\n- key\n\n```");
  });
});
