// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, render, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { Text } from "@codemirror/state";
import MarkdownEditor from "../components/MarkdownEditor";
import { activeFormats } from "../lib/editorFormat";

// A touch screen gets one formatting surface: no floating selection toolbar
// next to the OS selection handles and copy/paste menu; the bottom bar
// switches to the selection toolbar's actions while text is selected. A
// mouse keeps the floating toolbar.

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

const original = window.matchMedia;
afterEach(() => { window.matchMedia = original; });

/** Touch: a phone (coarse pointer, ≤900px). Desktop: a mouse at full width. */
function device(touch: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: touch && (query === "(pointer: coarse)" || query === "(max-width: 900px)"),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

function setup(value: string, readOnly = false) {
  const utils = render(
    <MarkdownEditor nodeKey="n1" value={value} onChange={vi.fn()} nodes={[]} readOnly={readOnly}
      onMediaInsert={vi.fn(async () => null)} />,
  );
  const view = EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const focus = () => act(() => { fireEvent.focus(view.contentDOM); });
  const select = (from: number, to: number) => act(() => { view.dispatch({ selection: { anchor: from, head: to } }); });
  const bar = () => utils.container.querySelector<HTMLElement>(".md-mobile-toolbar");
  // The bubble is a popover: drawn in the top layer, not inside the editor.
  const bubble = () => document.querySelector(".tiptap-bubble-menu");
  const tap = (el: HTMLElement) => { fireEvent.pointerDown(el); fireEvent.click(el); };
  return { ...utils, view, focus, select, bar, bubble, tap };
}

describe("selection formatting on a touch screen", { timeout: 30_000 }, () => {
  it("shows no floating toolbar and switches the bottom bar into selection mode", () => {
    device(true);
    const s = setup("hello world");
    s.focus();
    expect(s.bar()).toBeTruthy();
    expect(within(s.bar()!).getByLabelText("Bullet list")).toBeTruthy();

    s.select(0, 5);
    expect(s.bubble()).toBeNull();
    const bar = s.bar()!;
    expect(bar.classList.contains("md-mobile-toolbar--selection")).toBe(true);
    for (const label of ["Bold", "Italic", "Strikethrough", "Underline", "Highlight", "Inline code", "Link", "Quote", "Heading 1", "Heading 2", "Heading 3"]) {
      expect(within(bar).getByLabelText(label)).toBeTruthy();
    }
    expect(within(bar).queryByLabelText("Bullet list")).toBeNull();

    // Collapsing the selection brings the everyday buttons back.
    s.select(3, 3);
    expect(s.bar()!.classList.contains("md-mobile-toolbar--selection")).toBe(false);
    expect(within(s.bar()!).getByLabelText("Bullet list")).toBeTruthy();
  });

  it("applies formats to the selection and marks the active ones", () => {
    device(true);
    const s = setup("hello world");
    s.focus();
    s.select(0, 5);
    const bold = () => within(s.bar()!).getByLabelText("Bold");
    expect(bold().getAttribute("aria-pressed")).toBe("false");

    s.tap(bold());
    expect(s.view.state.doc.toString()).toBe("**hello** world");
    // The text stays selected, so the bar stays in selection mode, Bold on.
    expect(bold().getAttribute("aria-pressed")).toBe("true");
    expect(within(s.bar()!).getByLabelText("Italic").getAttribute("aria-pressed")).toBe("false");

    s.tap(bold());
    expect(s.view.state.doc.toString()).toBe("hello world");

    s.tap(within(s.bar()!).getByLabelText("Heading 2"));
    expect(s.view.state.doc.toString()).toBe("## hello world");
    expect(within(s.bar()!).getByLabelText("Heading 2").getAttribute("aria-pressed")).toBe("true");
    expect(s.bubble()).toBeNull();
    // A pressed heading button undoes the heading (D103).
    s.tap(within(s.bar()!).getByLabelText("Heading 2"));
    expect(s.view.state.doc.toString()).toBe("hello world");
  });

  it("a pressed Quote unquotes instead of nesting (D103)", () => {
    device(true);
    const s = setup("> said");
    s.focus();
    s.select(2, 6);
    const quote = () => within(s.bar()!).getByLabelText("Quote");
    expect(quote().getAttribute("aria-pressed")).toBe("true");
    s.tap(quote());
    expect(s.view.state.doc.toString()).toBe("said");
  });

  it("links the selection through the bar's own link form", () => {
    device(true);
    const s = setup("hello world");
    s.focus();
    s.select(6, 11);
    s.tap(within(s.bar()!).getByLabelText("Link"));
    const input = within(s.bar()!).getByPlaceholderText("https://...");
    fireEvent.change(input, { target: { value: "https://x.dev" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(s.view.state.doc.toString()).toBe("hello [world](https://x.dev)");
  });

  it("shows nothing while the editor is not focused or is read-only", () => {
    device(true);
    const s = setup("hello world");
    s.select(0, 5);
    expect(s.bar()).toBeNull();
    expect(s.bubble()).toBeNull();

    const r = setup("read only", true);
    r.focus();
    r.select(0, 4);
    expect(r.bar()).toBeNull();
    expect(r.bubble()).toBeNull();
  });
});

describe("selection formatting with a mouse", { timeout: 30_000 }, () => {
  it("keeps the floating toolbar and no bottom bar", () => {
    device(false);
    const s = setup("hello world");
    s.focus();
    s.select(0, 5);
    expect(s.bar()).toBeNull();
    const bubble = s.bubble() as HTMLElement;
    expect(bubble).toBeTruthy();
    fireEvent.mouseDown(within(bubble).getByTitle("Bold"));
    expect(s.view.state.doc.toString()).toBe("**hello** world");
  });
});

describe("activeFormats", () => {
  const at = (doc: string, from: number, to: number) => [...activeFormats(Text.of(doc.split("\n")), from, to, to)].sort();

  it("reads the marks around or inside the selection", () => {
    expect(at("**bold** x", 2, 6)).toEqual(["Bold"]);
    expect(at("**bold** x", 0, 8)).toEqual(["Bold"]);
    expect(at("*it* x", 1, 3)).toEqual(["Italic"]);
    expect(at("***both***", 3, 7)).toEqual(["Bold", "Italic"]);
    expect(at("a <mark>hi</mark>", 8, 10)).toEqual(["Highlight"]);
    expect(at("plain", 0, 5)).toEqual([]);
  });

  it("reads the heading and quote of the line the selection ends on", () => {
    expect(at("### title", 4, 9)).toEqual(["Heading 3"]);
    expect(at("> said", 2, 6)).toEqual(["Quote"]);
    expect(at("#### deep", 5, 9)).toEqual([]);
  });
});
