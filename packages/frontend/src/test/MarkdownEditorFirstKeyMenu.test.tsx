import { describe, it, expect } from "vitest";
import { useState } from "react";
import { act, render, screen } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import MarkdownEditor from "../components/MarkdownEditor";

// The first key typed into a NEW note (an empty body) is the person typing, not "the body arriving". The editor waits
// to put the last caret back until the note has text; it used to take the first key for that text, move the caret
// with a second transaction, and so close the list the key had just opened: `/` in a new note showed no menu, the
// second `/` did (owner, 2026-11-17). The editor here is used the way the app uses it: with a note id, and with the
// typed text fed back as `value` (MarkdownEditorSlashKeys.test.tsx has neither, so it could not see this).

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

function Host({ nodeKey, initial }: { nodeKey: string; initial: string }) {
  const [value, setValue] = useState(initial);
  return <MarkdownEditor value={value} onChange={setValue} nodeKey={nodeKey} nodes={[]} onMediaInsert={async () => null} />;
}

const typeSlash = async (container: HTMLElement, at: number): Promise<EditorView> => {
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
  view.focus();
  await act(async () => { view.dispatch({ changes: { from: at, insert: "/" }, selection: { anchor: at + 1 }, userEvent: "input.type" }); });
  // What follows the key: the parent's new `value`, the effects it starts, and anything they dispatch.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return view;
};

describe("the first key in a new note", () => {
  it("`/` as the first key of an empty note opens the menu and it stays open", async () => {
    const { container } = render(<Host nodeKey="new-note" initial="" />);
    const view = await typeSlash(container, 0);
    expect(screen.queryByRole("group", { name: /Suggestions|候選項目/ })).not.toBeNull();
    expect(view.state.selection.main.head).toBe(1);
  });

  it("the same in a note that already has text (the control)", async () => {
    const { container } = render(<Host nodeKey="old-note" initial={"hello\n"} />);
    await typeSlash(container, 6);
    expect(screen.queryByRole("group", { name: /Suggestions|候選項目/ })).not.toBeNull();
  });
});
