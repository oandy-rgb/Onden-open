// The parts of the board's sub-note tree that a person touches: the levels
// control and the follow switch above the board, the note when there is
// nothing to show yet, a card's fold control and the 「+N 篇」 card.
import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@xyflow/react", async (original) => ({
  ...await original<typeof import("@xyflow/react")>(),
  ReactFlow: () => <div />,
  useUpdateNodeInternals: () => () => {},
  useStore: (sel: (s: { transform: [number, number, number] }) => unknown) => sel({ transform: [0, 0, 1] }),
  Handle: () => null,
  NodeResizer: () => null,
}));
import KnowledgeWorkspace from "../components/KnowledgeWorkspace";
import { CardNode } from "../components/CardNode";
import { TreeMoreNode } from "../components/TreeMoreNode";
import { GraphCallbacksContext } from "../components/graphCallbacks";
import { resetAppState } from "../lib/appStore";
import { setLocalePref } from "../lib/i18n";

const board = { id: "r", title: "r", created_at: "", updated_at: "", data: { nodes: [] } };

function mount(tree: NonNullable<ComponentProps<typeof KnowledgeWorkspace>["board"]["tree"]> | undefined) {
  const unused = vi.fn();
  const props = {
    board: {
      displayGraphNodes: [], displayGraphEdges: [], canvasSearch: "", graphLocalMode: false, showTagEdges: false, parentMode: false,
      setGraphLocalMode: unused, setCanvasSearch: unused, setParentMode: unused, tree,
      display: { settings: {}, set: unused },
    },
    actions: new Proxy({}, { get: () => unused }),
    mobileView: "graph", createOpen: false, draftTitle: "", setCreateOpen: unused, setDraftTitle: unused, onCreateNode: unused, onClickWikilink: unused,
  } as unknown as ComponentProps<typeof KnowledgeWorkspace>;
  render(<KnowledgeWorkspace {...props} />);
}

beforeEach(() => { setLocalePref("en"); resetAppState({ activeCanvas: board }); });
afterEach(cleanup);

describe("the board's tree controls", () => {
  it("offers 1, 2, 3 and All in auto mode, marks the current one, and a press chooses it", () => {
    const setDepth = vi.fn();
    mount({ mode: "auto", depth: 2, childless: false, crumbs: [], backTo: vi.fn(), setMode: vi.fn(), setDepth });
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    const levels = screen.getByRole("group", { name: "Levels" });
    expect(within(levels).getAllByRole("button").map((b) => b.textContent)).toEqual(["1", "2", "3", "All"]);
    expect(within(levels).getByRole("button", { name: "2" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(levels).getByRole("button", { name: "All" }));
    expect(setDepth).toHaveBeenCalledWith("all");
  });

  it("the follow switch changes the mode; a manual board shows no levels", () => {
    const setMode = vi.fn();
    mount({ mode: "manual", depth: 2, childless: false, crumbs: [], backTo: vi.fn(), setMode, setDepth: vi.fn() });
    expect(screen.queryByRole("group", { name: "Levels" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    const follow = screen.getByRole("switch", { name: "Follow sub-notes" });
    expect(follow).toHaveAttribute("aria-checked", "false");
    fireEvent.click(follow);
    expect(setMode).toHaveBeenCalledWith("auto");
  });

  it("says what to do when the note has no sub-notes yet", () => {
    mount({ mode: "auto", depth: 2, childless: true, crumbs: [], backTo: vi.fn(), setMode: vi.fn(), setDepth: vi.fn() });
    expect(screen.getByRole("status")).toHaveTextContent("This note has no sub-notes yet. Add one inside the note and it appears here.");
  });

  it("centred on another note, shows the way back; the last step is where it is, an earlier one goes back to it", () => {
    const backTo = vi.fn();
    mount({ mode: "auto", depth: 2, childless: false, crumbs: [{ id: "r", title: "Root" }, { id: "a", title: "A" }, { id: "b", title: "B" }], backTo, setMode: vi.fn(), setDepth: vi.fn() });
    const path = screen.getByRole("navigation", { name: "Board centre" });
    expect(within(path).getAllByRole("button").map((b) => b.textContent)).toEqual(["Root", "A", "B"]);
    expect(within(path).getByRole("button", { name: "B" })).toBeDisabled();
    fireEvent.click(within(path).getByRole("button", { name: "A" }));
    expect(backTo).toHaveBeenCalledWith(1);
  });

  it("not centred elsewhere: no way back is shown", () => {
    mount({ mode: "auto", depth: 2, childless: false, crumbs: [], backTo: vi.fn(), setMode: vi.fn(), setDepth: vi.fn() });
    expect(screen.queryByRole("navigation", { name: "Board centre" })).toBeNull();
  });

  it("a tag's board (no tree) has neither", () => {
    mount(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    expect(screen.queryByRole("switch", { name: "Follow sub-notes" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Levels" })).toBeNull();
  });
});

describe("a card on the tree", () => {
  const callbacks = (over: Partial<React.ContextType<typeof GraphCallbacksContext>>) => ({
    onNodeUpdate: vi.fn(async () => {}), onNodeEditStart: () => {}, onNodeResized: () => {}, onSectionResized: () => {}, onSectionRemove: () => {}, onSectionTitleChange: () => {},
    onNodeTitleChange: () => {}, onClickWikilink: () => {}, onSetFolded: () => {}, onFocusCard: () => {}, onOpenCard: () => {}, onOpenSubCanvas: () => {},
    onToggleBranch: () => {}, onShowMoreChildren: () => {}, ...over,
  });
  const card = (branch?: { expanded: boolean; below: number }) =>
    ({ id: "n1", type: "card", selected: false, data: { label: "Card", content: "", branch } }) as unknown as Parameters<typeof CardNode>[0];

  it("a branch that is shown folds on a press; a collapsed one says how many notes are below and opens", () => {
    const onToggleBranch = vi.fn();
    const { rerender } = render(<GraphCallbacksContext.Provider value={callbacks({ onToggleBranch })}><CardNode {...card({ expanded: true, below: 0 })} /></GraphCallbacksContext.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Hide sub-notes" }));
    expect(onToggleBranch).toHaveBeenCalledWith("n1");
    rerender(<GraphCallbacksContext.Provider value={callbacks({ onToggleBranch })}><CardNode {...card({ expanded: false, below: 12 })} /></GraphCallbacksContext.Provider>);
    const open = screen.getByRole("button", { name: "Show sub-notes" });
    expect(open).toHaveTextContent("12");
    expect(open).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(open);
    expect(onToggleBranch).toHaveBeenCalledTimes(2);
  });

  it("a card with no sub-notes has no fold control", () => {
    render(<GraphCallbacksContext.Provider value={callbacks({})}><CardNode {...card()} /></GraphCallbacksContext.Provider>);
    expect(screen.queryByRole("button", { name: /sub-notes/ })).toBeNull();
  });

  it("the +N card says how many are left and draws the next page of its parent", () => {
    const onShowMoreChildren = vi.fn();
    const props = { id: "more:p", data: { parentId: "p", remaining: 12 } } as unknown as Parameters<typeof TreeMoreNode>[0];
    render(<GraphCallbacksContext.Provider value={callbacks({ onShowMoreChildren })}><TreeMoreNode {...props} /></GraphCallbacksContext.Provider>);
    const more = screen.getByRole("button", { name: "+12 notes" });
    act(() => { fireEvent.click(more); });
    expect(onShowMoreChildren).toHaveBeenCalledWith("p");
  });
});
