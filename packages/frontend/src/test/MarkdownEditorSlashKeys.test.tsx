import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import MarkdownEditor from "../components/MarkdownEditor";

// The slash menu is a popover (components/ui) beside the caret, but the keys stay the
// editor's: ↑/↓ move, Enter picks, Esc closes, and focus never leaves the text.

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

function setup() {
  const onChange = vi.fn();
  const { container } = render(<MarkdownEditor value="" onChange={onChange} nodes={[]} onMediaInsert={vi.fn(async () => null)} />);
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
  view.focus();
  view.dispatch({ changes: { from: 0, insert: "/" }, selection: { anchor: 1 }, userEvent: "input.type" });
  return { onChange, view };
}

const key = (view: EditorView, k: string) => fireEvent.keyDown(view.contentDOM, { key: k });
const active = () => document.querySelector(".slash-menu-item.active")?.textContent;

describe("slash menu keys", () => {
  it("↓ and ↑ move the highlight, and focus stays in the editor", async () => {
    const { view } = setup();
    await screen.findByRole("group", { name: /Suggestions|候選項目/ });
    const first = active();
    key(view, "ArrowDown");
    await waitFor(() => expect(active()).not.toBe(first));
    key(view, "ArrowUp");
    await waitFor(() => expect(active()).toBe(first));
    expect(view.dom.contains(document.activeElement)).toBe(true);
  });

  it("Enter picks the highlighted item and closes the menu", async () => {
    const { view, onChange } = setup();
    await screen.findByRole("group", { name: /Suggestions|候選項目/ });
    key(view, "Enter");
    await waitFor(() => expect(screen.queryByRole("group", { name: /Suggestions|候選項目/ })).toBeNull());
    expect(onChange).toHaveBeenCalled();
  });

  it("Esc closes the menu and keeps the typed slash", async () => {
    const { view } = setup();
    await screen.findByRole("group", { name: /Suggestions|候選項目/ });
    key(view, "Escape");
    await waitFor(() => expect(screen.queryByRole("group", { name: /Suggestions|候選項目/ })).toBeNull());
    expect(view.state.doc.toString()).toBe("/");
  });
});
