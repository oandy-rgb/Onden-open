import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import MarkdownEditor from "../components/MarkdownEditor";
import type { ContentNode } from "../lib/api";
import { resetAppState } from "../lib/appStore";

// `[[Note#` in the real editor: the popup lists the chosen note's headings and
// paragraphs; picking one writes the link (and, in this note, the id).

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

const alpha = { id: "a", title: "Alpha", markdown: "# Plan\n\nStep one ^s1\n\nStep two" } as ContentNode;
const nodes = [{ id: "cur", title: "Current", markdown: "" } as ContentNode, alpha];
afterEach(() => resetAppState());

function typeInto(container: HTMLElement, text: string) {
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
  view.dispatch({ changes: { from: view.state.doc.length, insert: text }, selection: { anchor: view.state.doc.length + text.length }, userEvent: "input.type" });
  return view;
}

describe("[[Note# in the editor", () => {
  it("lists headings then paragraphs, filters, and inserts the chosen link", async () => {
    const onChange = vi.fn();
    const { container } = render(<MarkdownEditor nodeKey="cur" value="" onChange={onChange} nodes={nodes} onMediaInsert={vi.fn(async () => null)} />);
    typeInto(container, "[[Alpha#");
    expect(await screen.findByText("Headings")).toBeInTheDocument();
    expect(screen.getByText("Paragraphs")).toBeInTheDocument();
    typeInto(container, "two");
    await waitFor(() => expect(screen.queryByText("Plan")).toBeNull());
    fireEvent.mouseDown(screen.getByRole("button", { name: /Step two/ }));
    // The link reads by the paragraph's words: no id is made, and nothing is written into Alpha.
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toBe("[[Alpha/Step two]]"));
  });

  it("[[#^ in this note writes [[/words]] and leaves the paragraph as it was", async () => {
    const onChange = vi.fn();
    const { container } = render(<MarkdownEditor nodeKey="cur" value={"First thing\n\n"} onChange={onChange} nodes={nodes} onMediaInsert={vi.fn(async () => null)} />);
    typeInto(container, "[[#^");
    fireEvent.mouseDown(await screen.findByRole("button", { name: /First thing/ }));
    await waitFor(() => expect(onChange.mock.calls.at(-1)?.[0]).toBe("First thing\n\n[[/First thing]]"));
  });

  it("says when a note has nothing matching", async () => {
    const { container } = render(<MarkdownEditor nodeKey="cur" value="" onChange={vi.fn()} nodes={nodes} onMediaInsert={vi.fn(async () => null)} />);
    typeInto(container, "[[Alpha#zzzz");
    expect(await screen.findByText("No matching headings or paragraphs")).toBeInTheDocument();
  });
});
