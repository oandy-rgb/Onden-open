import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import MarkdownEditor from "../components/MarkdownEditor";
import type { ContentNode } from "../lib/api";
import { resetAppState } from "../lib/appStore";
import { blockLinkWriter } from "../lib/data";

const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => rect as DOMRect;

const target = { id: "a", title: "Alpha", space_id: "s2", markdown: "# Plan\n\nStep two" } as ContentNode;
const nodes = [{ id: "cur", title: "Current", space_id: "s1", markdown: "" } as ContentNode, target];
afterEach(() => { resetAppState(); vi.restoreAllMocks(); });

function typeInto(container: HTMLElement, text: string) {
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
  view.dispatch({ changes: { from: view.state.doc.length, insert: text }, selection: { anchor: view.state.doc.length + text.length }, userEvent: "input.type" });
  return view;
}

describe("![[Note#^ in the editor", () => {
  it("writes a part link by its words, closes the popup, and asks the server to bind it", async () => {
    const bind = vi.spyOn(blockLinkWriter, "bind").mockResolvedValue({ anchorId: "x1", link: "Alpha/Step two", linkText: "Step two" });
    const { container } = render(<MarkdownEditor nodeKey="cur" value="" onChange={vi.fn()} nodes={nodes} onMediaInsert={vi.fn(async () => null)} />);
    const view = typeInto(container, "![[Alpha#^");
    fireEvent.mouseDown(await screen.findByRole("button", { name: /Step two/ }));
    await waitFor(() => expect(bind).toHaveBeenCalled());
    expect(bind).toHaveBeenCalledWith("cur", "a", { at: "# Plan\n\n".length, seenText: "Step two", suggestedText: "Step two" });
    expect(view.state.doc.toString()).toBe("![[Alpha/Step two]]");
    expect(screen.queryByText("Paragraphs")).toBeNull();
  });

  it("follows the words the server settled on when another paragraph already used them", async () => {
    vi.spyOn(blockLinkWriter, "bind").mockResolvedValue({ anchorId: "x1", link: "Alpha/Step two 2", linkText: "Step two 2" });
    const { container } = render(<MarkdownEditor nodeKey="cur" value="" onChange={vi.fn()} nodes={nodes} onMediaInsert={vi.fn(async () => null)} />);
    const view = typeInto(container, "![[Alpha#^");
    fireEvent.mouseDown(await screen.findByRole("button", { name: /Step two/ }));
    await waitFor(() => expect(view.state.doc.toString()).toBe("![[Alpha/Step two 2]]"));
  });

  it("nothing is lost when the server cannot bind: the link stays, reading by its words", async () => {
    const bind = vi.spyOn(blockLinkWriter, "bind").mockResolvedValue(null);
    const { container } = render(<MarkdownEditor nodeKey="cur" value="" onChange={vi.fn()} nodes={nodes} onMediaInsert={vi.fn(async () => null)} />);
    const view = typeInto(container, "![[Alpha#^");
    fireEvent.mouseDown(await screen.findByRole("button", { name: /Step two/ }));
    await waitFor(() => expect(bind).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(view.state.doc.toString()).toBe("![[Alpha/Step two]]");
  });

  it("typing after the pick leaves the link alone and does not reopen the popup", async () => {
    vi.spyOn(blockLinkWriter, "bind").mockResolvedValue(null);
    const { container } = render(<MarkdownEditor nodeKey="cur" value="" onChange={vi.fn()} nodes={nodes} onMediaInsert={vi.fn(async () => null)} />);
    const view = typeInto(container, "![[Alpha#^");
    fireEvent.mouseDown(await screen.findByRole("button", { name: /Step two/ }));
    typeInto(container, "\n\nnext");
    await new Promise((r) => setTimeout(r, 50));
    expect(view.state.doc.toString()).toBe("![[Alpha/Step two]]\n\nnext");
    expect(screen.queryByText("Paragraphs")).toBeNull();
  });

  it("closes the popup when the trigger has no position to draw at, instead of leaving the old one", async () => {
    const { container } = render(<MarkdownEditor nodeKey="cur" value="" onChange={vi.fn()} nodes={nodes} onMediaInsert={vi.fn(async () => null)} />);
    const view = typeInto(container, "![[Alpha#");
    expect(await screen.findByText("Paragraphs")).toBeInTheDocument();
    view.coordsAtPos = () => null;
    typeInto(container, "S");
    await waitFor(() => expect(screen.queryByText("Paragraphs")).toBeNull());
  });
});
