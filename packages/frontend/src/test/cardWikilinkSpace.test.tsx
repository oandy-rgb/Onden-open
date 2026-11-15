import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook } from "@testing-library/react";

// Same @xyflow/react stub as CardNodeLazyEditor.test.tsx (React 18/19 clash).
vi.mock("@xyflow/react", () => ({
  useUpdateNodeInternals: () => () => {},
  useStore: (sel: (s: { transform: [number, number, number] }) => unknown) => sel({ transform: [0, 0, 1] }),
  Handle: () => null,
  NodeResizer: () => null,
  Position: { Top: "top", Right: "right", Bottom: "bottom", Left: "left" },
}));

import { CardNode } from "../components/CardNode";
import { GraphCallbacksContext } from "../components/graphCallbacks";
import { useOverviewMode } from "../hooks/useOverviewMode";
import { noWorkspaceData, type ContentNode } from "../lib/api";
import { getAppState, resetAppState } from "../lib/appStore";

// D43 follow-up: a [[link]] clicked on a whiteboard card resolved from the
// note open in the editor, not from the card's own note, so the space rule
// (a title resolves within the linking note's space) could open the wrong
// note. The card passes its id; the link resolves from that note. (The card's
// old `<span data-wikilink>` lost its data attributes to sanitize, so the
// click never fired at all; the card now uses the renderer's own wikilinks.)

const note = (id: string, title: string, space_id: string, markdown = ""): ContentNode =>
  ({ id, title, slug: id, markdown, space_id, node_type: "content", source_type: "manual" });
const planA = note("plan-a", "Plan", "space-a");
const planB = note("plan-b", "Plan", "space-b");
const openInA = note("open-a", "Open", "space-a");
const cardInB = note("card-b", "Card", "space-b", "see [[Plan]]");

afterEach(() => { resetAppState(); });

describe("a [[link]] on a whiteboard card", () => {
  it("opens the note in the card's space, not the open note's", async () => {
    resetAppState({ data: { ...noWorkspaceData, nodes: [planA, planB, openInA, cardInB] }, online: true, selectedId: openInA.id });
    const overview = renderHook(() => useOverviewMode({ setMode: vi.fn(), setNotesView: vi.fn() }));
    const noop = vi.fn();
    const { container } = render(
      <GraphCallbacksContext.Provider value={{
        onNodeUpdate: noop, onNodeEditStart: noop, onNodeResized: noop, onSectionResized: noop, onSectionRemove: noop,
        onSectionTitleChange: noop, onNodeTitleChange: noop, onSetFolded: noop, onFocusCard: noop, onOpenCard: noop, onOpenSubCanvas: noop, onToggleBranch: noop, onShowMoreChildren: noop,
        // As BuilderApp wires it.
        onClickWikilink: (label, fromId) => void overview.result.current.openWikilink(label, null, fromId),
      }}>
        <CardNode {...({
          id: cardInB.id, type: "card", dragging: false, zIndex: 0, isConnectable: true,
          positionAbsoluteX: 0, positionAbsoluteY: 0, width: 260, height: 200, selected: false,
          data: { label: cardInB.title, content: cardInB.markdown },
        } as unknown as Parameters<typeof CardNode>[0])} />
      </GraphCallbacksContext.Provider>,
    );

    const link = container.querySelector<HTMLElement>(".card-md-preview .wikilink-token");
    expect(link?.textContent).toBe("Plan");
    await act(async () => { fireEvent.click(link!); });

    expect(getAppState().selectedId).toBe(planB.id);
  });
});
