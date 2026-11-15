// GAP-174: board arrows could not be selected — the edges are controlled and
// had no onEdgesChange, so a click selected nothing, Delete never had an
// arrow to delete, and touch (no right-click) had no way to delete one.

import type { ComponentProps } from "react";
import type { Edge, ReactFlowProps } from "@xyflow/react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const flow = vi.hoisted(() => ({ props: {} as ReactFlowProps }));
vi.mock("@xyflow/react", async importOriginal => ({
  ...await importOriginal<typeof import("@xyflow/react")>(),
  ReactFlow: function MockFlow(props: ReactFlowProps) {
    flow.props = props;
    return <div />;
  },
}));
vi.mock("../components/CardNode", () => ({ CardNode: () => null }));
vi.mock("../components/SectionNode", () => ({ SectionNode: () => null }));
import KnowledgeWorkspace from "../components/KnowledgeWorkspace";
import { resetAppState, setAppState } from "../lib/appStore";
import { setLocalePref } from "../lib/i18n";

const board = { id: "board", title: "Board", created_at: "", updated_at: "", data: { nodes: [{ nodeId: "a", x: 0, y: 0 }, { nodeId: "b", x: 400, y: 0 }] } };
const cards = board.data.nodes.map(({ nodeId, x, y }) => ({ id: nodeId, type: "card", position: { x, y }, data: {} }));
// Edge data as useGraphLayout builds it: the facts lib/edgeRoles reads.
const link: Edge = { id: "e1", source: "a", target: "b", style: { strokeWidth: 1.6 }, data: { edgeType: "supports", status: "active", origin: "manual" } };
const parent: Edge = { id: "parent-b", source: "a", target: "b", type: "parentEdge" };
const fromText: Edge = { id: "e2", source: "b", target: "a", data: { edgeType: "knowledge_link", status: "active", origin: "wikilink" } };
const cited: Edge = { id: "e3", source: "a", target: "b", data: { edgeType: "cites", status: "active", origin: "citation" } };

function mount(edges: Edge[] = [link, parent, fromText]) {
  const unused = vi.fn();
  const actions = { onEdgeDeleted: vi.fn(), onEdgeContextMenu: vi.fn(), onRemoveCards: vi.fn(async () => null) };
  const props = {
    board: {
      displayGraphNodes: cards, displayGraphEdges: edges, canvasSearch: "",
      graphLocalMode: false, showTagEdges: false, parentMode: false, display: { settings: {}, set: () => {} },
      setGraphLocalMode: unused, setCanvasSearch: unused, setParentMode: unused,
    },
    actions: new Proxy(actions, { get: (target, key) => (target as Record<string | symbol, unknown>)[key] ?? unused }),
    mobileView: "graph", createOpen: false, draftTitle: "",
    setCreateOpen: unused, setDraftTitle: unused,
    onCreateNode: unused, onClickWikilink: unused,
  } as unknown as ComponentProps<typeof KnowledgeWorkspace>;
  render(<KnowledgeWorkspace {...props} />);
  return actions;
}
const selectEdge = (id: string, selected = true) => act(() => flow.props.onEdgesChange?.([{ type: "select", id, selected }]));
const edge = (id: string) => flow.props.edges?.find(e => e.id === id);

beforeEach(() => {
  setLocalePref("en");
  resetAppState({ activeCanvas: board });
});
afterEach(() => cleanup());

it("a clicked arrow is selected, drawn thicker, and deselects", () => {
  mount();
  expect(flow.props.onEdgesChange).toBeTypeOf("function");
  selectEdge("e1");
  expect(edge("e1")?.selected).toBe(true);
  expect(edge("e1")?.style?.strokeWidth).toBe(3);
  expect(edge("parent-b")?.selected).toBeFalsy();
  selectEdge("e1", false);
  expect(edge("e1")?.selected).toBeFalsy();
});

it("Delete deletes the selected arrow, even while its card stays highlighted", async () => {
  const actions = mount();
  act(() => setAppState({ selectedId: "a" }));
  selectEdge("e1");
  await act(async () => { fireEvent.keyDown(window, { key: "Delete" }); });
  expect(actions.onEdgeDeleted).toHaveBeenCalledExactlyOnceWith("e1");
  expect(actions.onRemoveCards).not.toHaveBeenCalled();
});

it("selected cards win: a box selection's arrows are not deleted with them", async () => {
  const actions = mount();
  act(() => flow.props.onNodesChange?.([{ type: "select", id: "a", selected: true }, { type: "select", id: "b", selected: true }]));
  selectEdge("e1");
  await act(async () => { fireEvent.keyDown(window, { key: "Backspace" }); });
  expect(actions.onRemoveCards).toHaveBeenCalledExactlyOnceWith(["a", "b"]);
  expect(actions.onEdgeDeleted).not.toHaveBeenCalled();
});

it("touch: a selected arrow gets Arrow type and Delete arrow buttons", () => {
  const actions = mount();
  selectEdge("e1");
  fireEvent.click(screen.getByRole("button", { name: "Arrow type" }));
  expect(actions.onEdgeContextMenu).toHaveBeenCalledWith("e1", "supports", expect.any(Number), expect.any(Number));
  fireEvent.click(screen.getByRole("button", { name: "Delete arrow" }));
  expect(actions.onEdgeDeleted).toHaveBeenCalledExactlyOnceWith("e1");
  expect(screen.queryByRole("button", { name: "Delete arrow" })).toBeNull();
});

it("a parent arrow offers Remove from parent, not a type", () => {
  const actions = mount();
  selectEdge("parent-b");
  expect(screen.queryByRole("button", { name: "Arrow type" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Remove from parent" }));
  expect(actions.onEdgeDeleted).toHaveBeenCalledExactlyOnceWith("parent-b");
});

it("an arrow from a [[link]] can be selected but not deleted or retyped, and says why", async () => {
  const actions = mount();
  selectEdge("e2");
  expect(edge("e2")?.selected).toBe(true);
  expect(screen.getByRole("status").textContent).toContain("[[link]]");
  expect((screen.getByRole("button", { name: "Delete arrow" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Arrow type" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { fireEvent.keyDown(window, { key: "Delete" }); });
  expect(actions.onEdgeDeleted).not.toHaveBeenCalled();
});

it("a citation's arrow is derived too; Delete with a mixed selection deletes only the drawn one", async () => {
  const actions = mount([link, cited]);
  selectEdge("e3");
  expect(screen.getByRole("status").textContent).toContain("Edit the note");
  selectEdge("e1");
  const button = screen.getByRole("button", { name: "Delete arrow" }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  await act(async () => { fireEvent.keyDown(window, { key: "Delete" }); });
  expect(actions.onEdgeDeleted).toHaveBeenCalledExactlyOnceWith("e1");
});
