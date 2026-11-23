import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
type GraphProps = { nodes: ContentNode[]; focus?: { centerId: string; roles: Record<string, string> }; arrows?: boolean; selectedNodeId: string | null; onNodeClick: (id: string) => void };
const graph = vi.hoisted(() => ({ props: {} as GraphProps }));
vi.mock("./AllCardsGraph", () => ({
  default: (props: GraphProps) => { graph.props = props; return <div data-testid="graph" />; },
}));
import LocalGraphLens from "./LocalGraphLens";
import { setGraphFocus, getGraphFocus, locationToSearch, recenterGraph, useUrlSync } from "../../hooks/useUrlLocation";
import type { ContentNode, NodeEdge } from "../../lib/api";

const mk = (id: string, extra: Partial<ContentNode> = {}): ContentNode =>
  ({ id, title: id.toUpperCase(), slug: id, markdown: "", node_type: "content", source_type: "manual", ...extra }) as ContentNode;
const nodes = [mk("me", { parent_id: "up" }), mk("up"), mk("to"), mk("from"), mk("kid", { parent_id: "me" }), mk("far")];
const edges: NodeEdge[] = [
  { id: "1", source_node_id: "me", target_node_id: "to", edge_type: "knowledge_link", status: "active", origin: "manual" },
  { id: "2", source_node_id: "from", target_node_id: "me", edge_type: "knowledge_link", status: "active", origin: "manual" },
];
const lens = (onSelectNode = vi.fn()) =>
  render(<LocalGraphLens selectedNodeId={null} nodes={nodes} edges={edges} tags={[]} onSelectNode={onSelectNode} />);

beforeEach(() => { window.history.replaceState(null, "", "/?view=graph"); setGraphFocus(null); });
afterEach(cleanup);

describe("the graph page", () => {
  it("without focus the header says 'Graph', the name the menu uses", () => {
    lens();
    expect(screen.getByRole("heading", { name: "Graph" })).toBeInTheDocument();
    expect(screen.queryByText("Links")).toBeNull();
  });

  it("without focus draws the whole workspace, as before", () => {
    lens();
    expect(graph.props.nodes).toHaveLength(nodes.length);
    expect(graph.props.focus).toBeUndefined();
    expect(graph.props.arrows).toBeUndefined();
    expect(screen.queryByRole("button", { name: "Back to note" })).toBeNull();
  });

  describe("with focus", () => {
    beforeEach(() => { setGraphFocus("me"); });

    it("draws that note's neighbourhood with arrows, centred and with roles", () => {
      lens();
      expect(graph.props.nodes.map((n: ContentNode) => n.id).sort()).toEqual(["from", "kid", "me", "to", "up"]);
      expect(graph.props.arrows).toBe(true);
      expect(graph.props.selectedNodeId).toBe("me");
      expect(graph.props.focus).toEqual({ centerId: "me", roles: { up: "parent", to: "out", from: "in", kid: "child" } });
      expect(screen.getByRole("heading", { name: "Relations · ME" })).toBeInTheDocument();
    });

    it("includes the centre note's tags, placed in their own role", () => {
      setGraphFocus("me");
      const tagged = [...nodes.map((n) => n.id === "me" ? { ...n, class_tag_ids: ["t1"] } : n), mk("t1", { node_type: "class_tag" })];
      render(<LocalGraphLens selectedNodeId={null} nodes={tagged} edges={edges} tags={[{ id: "t1", name: "windows", color: null, schema_id: null } as never]} onSelectNode={vi.fn()} />);
      expect(graph.props.nodes.map((n: ContentNode) => n.id)).toContain("t1");
      expect(graph.props.focus?.roles.t1).toBe("tag");
    });

    it("goes back to the note, or opens it, from the header", () => {
      const onSelectNode = vi.fn();
      lens(onSelectNode);
      fireEvent.click(screen.getByRole("button", { name: "Back to note" }));
      fireEvent.click(screen.getByRole("button", { name: "Open this one" }));
      expect(onSelectNode.mock.calls).toEqual([["me"], ["me"]]);
    });

    it("re-centres on a clicked node with a new history entry, and Back returns", () => {
      // useUrlSync owns the one popstate listener.
      const noop = () => {};
      renderHook(() => useUrlSync("graph", null, "editor", noop, noop, noop));
      lens();
      const before = window.history.length;
      act(() => graph.props.onNodeClick("to"));
      expect(getGraphFocus()).toBe("to");
      expect(window.location.search).toBe("?view=graph&focus=to");
      expect(window.history.length).toBe(before + 1);
      expect(graph.props.focus!.centerId).toBe("to");
      act(() => { window.history.replaceState(null, "", "/?view=graph&focus=me"); window.dispatchEvent(new PopStateEvent("popstate")); });
      expect(graph.props.focus!.centerId).toBe("me");
    });

    it("falls back to the whole workspace when the note is gone", () => {
      setGraphFocus("deleted");
      lens();
      expect(graph.props.focus).toBeUndefined();
      expect(graph.props.nodes).toHaveLength(nodes.length);
    });
  });
});

describe("the focus in the URL", () => {
  it("is written for the graph view only", () => {
    expect(locationToSearch({ view: "graph", nodeId: null, lens: "editor" }, "me")).toBe("?view=graph&focus=me");
    expect(locationToSearch({ view: "graph", nodeId: null, lens: "editor" })).toBe("?view=graph");
    expect(locationToSearch({ view: "notes", nodeId: "me", lens: "editor" }, "me")).toBe("?view=notes&node=me&lens=editor");
  });
  it("recenterGraph keeps the view and swaps the focus", () => {
    recenterGraph("x");
    expect(window.location.search).toBe("?view=graph&focus=x");
  });
});

describe("useUrlSync with a focus", () => {
  it("pushes ?view=graph&focus= when the view becomes the graph, and drops it on leaving", async () => {
    window.history.replaceState(null, "", "/?view=notes&node=me&lens=editor");
    const noop = () => {};
    setGraphFocus("me");
    const { rerender } = renderHook(({ view }) => useUrlSync(view, "me", "editor", noop, noop, noop), { initialProps: { view: "notes" as const as "notes" | "graph" } });
    // Focus belongs to the graph view: the notes URL carries none.
    expect(window.location.search).toBe("?view=notes&node=me&lens=editor");
    setGraphFocus("me");
    rerender({ view: "graph" });
    expect(window.location.search).toBe("?view=graph&node=me&focus=me");
    rerender({ view: "notes" });
    expect(getGraphFocus()).toBeNull();
    expect(window.location.search).toBe("?view=notes&node=me&lens=editor");
  });
});
