// GAP-177: on a card that was not selected, the first click on a task
// checkbox (or a [[link]]) did nothing. React Flow re-renders the card
// between pointerdown and pointerup, and the preview's inline toggle handler
// made MarkdownRenderer rebuild — remount — every checkbox and link on each
// render, so the press ended on a replaced element and no click fired.

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
vi.mock("@xyflow/react", () => ({
  useUpdateNodeInternals: () => () => {},
  useStore: (sel: (s: { transform: [number, number, number] }) => unknown) => sel({ transform: [0, 0, 1] }),
  Handle: () => null,
  NodeResizer: () => null,
  Position: { Top: "top", Right: "right", Bottom: "bottom", Left: "left" },
}));
import { CardNode } from "../components/CardNode";
import { GraphCallbacksContext } from "../components/graphCallbacks";

const content = "- [ ] first\n- [ ] second\n\nSee [[Other]]";
function Card({ hovered }: { hovered: number }) {
  const props = { id: "n1", type: "card", selected: false, data: { label: "Card", content, hovered } } as unknown as Parameters<typeof CardNode>[0];
  return <CardNode {...props} />;
}

describe("card preview clicks", () => {
  it("keeps its checkboxes and links across a card re-render, so the first click lands", async () => {
    const onNodeUpdate = vi.fn(async () => {});
    const onClickWikilink = vi.fn();
    const callbacks = { ...{ onNodeEditStart: () => {}, onNodeResized: () => {}, onSectionResized: () => {}, onSectionRemove: () => {}, onSectionTitleChange: () => {},
      onNodeTitleChange: () => {}, onSetFolded: () => {}, onFocusCard: () => {}, onOpenCard: () => {}, onOpenSubCanvas: () => {}, onToggleBranch: () => {}, onShowMoreChildren: () => {} }, onNodeUpdate, onClickWikilink };
    const tree = (hovered: number) => <GraphCallbacksContext.Provider value={callbacks}><Card hovered={hovered} /></GraphCallbacksContext.Provider>;
    const { container, rerender } = render(tree(0));
    const box = container.querySelector(".md-checkbox--interactive")!;
    const link = container.querySelector(".wikilink-token")!;
    // What React Flow does mid-press: render the card again.
    rerender(tree(1));
    expect(container.querySelector(".md-checkbox--interactive")).toBe(box);
    expect(container.querySelector(".wikilink-token")).toBe(link);
    // A press on the checkbox does not start dragging the card.
    expect(box.classList.contains("nodrag")).toBe(true);
    await act(async () => { fireEvent.click(box); });
    expect(onNodeUpdate).toHaveBeenCalledWith("n1", "- [x] first\n- [ ] second\n\nSee [[Other]]", expect.anything());
    fireEvent.click(container.querySelector(".wikilink-token")!);
    expect(onClickWikilink).toHaveBeenCalledWith("Other", "n1");
  });
});
