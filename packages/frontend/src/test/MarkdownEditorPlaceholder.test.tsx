import { describe, it, expect, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import MarkdownEditor from "../components/MarkdownEditor";
import { EMPTY_HINT_CLASS } from "../lib/editorEmptyHint";

// The empty-note hint must live OUTSIDE the editable content. As a widget in
// the first .cm-line (CodeMirror's placeholder()), Android's native caret and
// touch selection treated it as text: the caret sat after it (#400), then the
// selection handles spanned it. jsdom cannot draw a native caret, so this pins
// the DOM shape that leaves nothing selectable in contentDOM.

const HINT = "Start writing… (/ for commands, [[ to link notes)";

function setup(value: string) {
  const utils = render(
    <MarkdownEditor nodeKey="n1" value={value} onChange={vi.fn()} nodes={[]} placeholder={HINT}
      onMediaInsert={vi.fn(async () => null)} />,
  );
  const view = EditorView.findFromDOM(utils.container.querySelector(".cm-editor") as HTMLElement)!;
  const hint = () => utils.container.querySelector<HTMLElement>(`.${EMPTY_HINT_CLASS}`)!;
  const shown = () => hint().style.display !== "none";
  return { ...utils, view, hint, shown };
}

describe("empty-note placeholder", { timeout: 30_000 }, () => {
  it("draws the hint outside contentDOM, over the empty line", () => {
    const s = setup("");
    const hint = s.hint();
    expect(hint.textContent).toBe(HINT);
    expect(s.shown()).toBe(true);
    expect(s.view.contentDOM.contains(hint)).toBe(false);
    expect(hint.parentElement).toBe(s.view.scrollDOM);
    expect(hint.getAttribute("aria-hidden")).toBe("true");
    // Nothing but the empty line is editable content, and no widget remains.
    expect(s.view.contentDOM.textContent).toBe("");
    expect(s.container.querySelector(".cm-placeholder")).toBeNull();
    expect(s.view.contentDOM.getAttribute("aria-placeholder")).toBe(HINT);
    expect(s.view.state.selection.main.head).toBe(0);
    s.unmount();
  });

  it("hides on insert and comes back after delete", () => {
    const s = setup("");
    act(() => { s.view.dispatch({ changes: { from: 0, insert: "a" } }); });
    expect(s.shown()).toBe(false);
    act(() => { s.view.dispatch({ changes: { from: 0, to: 1 } }); });
    expect(s.shown()).toBe(true);
    s.unmount();
  });

  it("hides as soon as an IME composition starts, before any text lands", () => {
    const s = setup("");
    act(() => { s.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })); });
    expect(s.view.state.doc.length).toBe(0);
    expect(s.shown()).toBe(false);
    // A cancelled composition leaves the note empty: the hint returns.
    act(() => { s.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); });
    expect(s.shown()).toBe(true);
    s.unmount();
  });

  it("starts hidden for a note that already has text", () => {
    const s = setup("hello");
    expect(s.shown()).toBe(false);
    s.unmount();
  });
});
