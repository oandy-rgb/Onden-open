import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, cleanup } from "@testing-library/react";
const capture = vi.hoisted(() => ({ props: {} as Record<string, unknown>, ref: { current: null as unknown } }));
vi.mock("react-force-graph-2d", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    default: forwardRef((props: Record<string, unknown>, ref) => {
      capture.props = props;
      // The real component hands out its engine here; tests plug one into capture.ref.
      useImperativeHandle(ref, () => ({
        d3Force: (...args: unknown[]) => (capture.ref.current as { d3Force?: (...a: unknown[]) => unknown } | null)?.d3Force?.(...args),
        d3ReheatSimulation: () => (capture.ref.current as { d3ReheatSimulation?: () => void } | null)?.d3ReheatSimulation?.(),
      }));
      return <canvas />;
    }),
  };
});
vi.mock("../../lib/api", async (original) => ({ ...await original<typeof import("../../lib/api")>(), apiFetch: vi.fn(async () => ({ ok: true, json: async () => [] })) }));
import AllCardsGraph from "./AllCardsGraph";
import type { ContentNode, Tag } from "../../lib/api";
import { linkTuning } from "./graphRoleForce";
import { registerNoteSwitchModule } from "../../lib/nodeTags";
let resize: ResizeObserverCallback;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe() {}
    disconnect() {}
  });
});
afterEach(() => { capture.ref.current = null; cleanup(); vi.unstubAllGlobals(); });
const nodes = [{ id: "one", title: "One" }, { id: "two", title: "Two" }] as ContentNode[];
const edges: [] = [];
const tags: [] = [];
function setSize(width: number, height: number) {
  act(() => resize([{ contentRect: { width, height } }] as ResizeObserverEntry[], {} as ResizeObserver));
}
it("uses the available pane size after mount and resize, not the whole browser", () => {
  render(<AllCardsGraph nodes={nodes} edges={edges} tags={tags} selectedNodeId={null} onNodeClick={() => {}} />);
  setSize(580, 450);
  expect(capture.props.width).toBe(580);
  expect(capture.props.height).toBe(450);
  setSize(320, 360);
  expect(capture.props.width).toBe(320);
  expect(capture.props.height).toBe(360);
});
describe("selection preserves the force layout", () => {
  it("keeps the same engine objects when selecting an already visible node", () => {
    const linked = [{ source_node_id: "one", target_node_id: "two", edge_type: "knowledge_link", status: "active" }] as never[];
    const props = { nodes, edges: linked, tags, onNodeClick: vi.fn() };
    const { rerender } = render(<AllCardsGraph {...props} selectedNodeId="one" />);
    setSize(580, 450);
    const graph = capture.props.graphData;
    rerender(<AllCardsGraph {...props} selectedNodeId="two" />);
    expect(capture.props.graphData).toBe(graph);
  });
});
it("frames the graph again once the layout settles", () => {
  render(<AllCardsGraph nodes={nodes} edges={edges} tags={tags} selectedNodeId={null} onNodeClick={() => {}} />);
  setSize(580, 450);
  // The early fit catches the layout mid-spread; the settled fit re-frames it.
  expect(typeof capture.props.onEngineStop).toBe("function");
});
it("draws link arrows only when asked (the info panel's graph)", () => {
  const props = { nodes, edges, tags, selectedNodeId: null, onNodeClick: () => {} };
  const { rerender } = render(<AllCardsGraph {...props} />);
  setSize(580, 450);
  expect(capture.props.linkDirectionalArrowLength).toBe(0);
  rerender(<AllCardsGraph {...props} arrows />);
  expect(capture.props.linkDirectionalArrowLength).toBe(4);
  expect(capture.props.linkDirectionalArrowRelPos).toBe(1);
});

describe("focus (the graph page's 「完整關係」)", () => {
  const kids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `k${i}`, title: `Kid ${i}`, parent_id: "me" })) as ContentNode[];
  const family = (n: number) => [{ id: "me", title: "Me" }, { id: "up", title: "Up" }, { id: "to", title: "To" }, { id: "from", title: "From" }, ...kids(n)] as ContentNode[];
  const rolesFor = (n: number) => ({
    up: "parent", to: "out", from: "in", ...Object.fromEntries(kids(n).map((k) => [k.id, "child"])),
  } as Record<string, "parent" | "in" | "out" | "child">);
  const graphNodes = () => (capture.props.graphData as { nodes: Record<string, unknown>[]; links: Record<string, unknown>[] }).nodes;
  const props = (n: number) => ({ nodes: family(n), edges, tags, selectedNodeId: "me", onNodeClick: vi.fn(), arrows: true, focus: { centerId: "me", roles: rolesFor(n) } });

  it("pins the centre at the origin and the parent straight above it", () => {
    render(<AllCardsGraph {...props(2)} />);
    setSize(580, 450);
    const byId = Object.fromEntries(graphNodes().map((n) => [n.id, n]));
    expect(byId.me).toMatchObject({ fx: 0, fy: 0 });
    expect(byId.up).toMatchObject({ fx: 0 });
    expect(byId.up!.fy).toBeLessThan(0);
    expect(byId.to!.fx).toBeUndefined();
  });

  it("installs a role force that pulls in left, out right and sub-notes down", () => {
    const d3Force = vi.fn();
    const { rerender } = render(<AllCardsGraph {...props(2)} />);
    setSize(580, 450);
    // The mock graph has no engine; give the ref one and re-run the effect with a new data set.
    capture.ref.current = { d3Force, d3ReheatSimulation: vi.fn() };
    rerender(<AllCardsGraph {...props(3)} />);
    const [name, force] = d3Force.mock.calls.find(([n, f]) => n === "role" && f)!;
    expect(name).toBe("role");
    const sim = Object.fromEntries(["from", "to", "k0"].map((id) => [id, { id, x: 0, y: 0, vx: 0, vy: 0 }]));
    force.initialize(Object.values(sim));
    force(1);
    expect(sim.from!.vx).toBeLessThan(0);
    expect(sim.to!.vx).toBeGreaterThan(0);
    expect(sim.k0!.vy).toBeGreaterThan(0);
    expect(sim.k0!.vx).toBe(0);
  });

  it("draws up to eight sub-notes as they are", () => {
    render(<AllCardsGraph {...props(8)} />);
    setSize(580, 450);
    expect(graphNodes().filter((n) => String(n.id).startsWith("k"))).toHaveLength(8);
    expect(graphNodes().some((n) => n.group)).toBe(false);
  });

  it("folds more than eight into one 「子筆記 N」 point that a click unfolds", () => {
    const onNodeClick = vi.fn();
    render(<AllCardsGraph {...props(9)} onNodeClick={onNodeClick} />);
    setSize(580, 450);
    expect(graphNodes().filter((n) => String(n.id).startsWith("k"))).toHaveLength(0);
    const group = graphNodes().find((n) => n.group)!;
    expect(group.label).toBe("Sub-notes 9");
    expect((capture.props.graphData as { links: Record<string, unknown>[] }).links).toContainEqual({ source: "me", target: group.id, type: "parent" });
    act(() => (capture.props.onNodeClick as (n: unknown) => void)(group));
    expect(onNodeClick).not.toHaveBeenCalled();
    expect(graphNodes().filter((n) => String(n.id).startsWith("k"))).toHaveLength(9);
    expect(graphNodes().some((n) => n.group)).toBe(false);
  });

  it("opens an ordinary node through onNodeClick", () => {
    const onNodeClick = vi.fn();
    render(<AllCardsGraph {...props(2)} onNodeClick={onNodeClick} />);
    setSize(580, 450);
    act(() => (capture.props.onNodeClick as (n: unknown) => void)({ id: "to" }));
    expect(onNodeClick).toHaveBeenCalledWith("to");
  });

  it("leaves the plain graph alone without focus", () => {
    render(<AllCardsGraph nodes={family(9)} edges={edges} tags={tags} selectedNodeId={null} onNodeClick={() => {}} />);
    setSize(580, 450);
    expect(graphNodes().some((n) => "fx" in n || n.group)).toBe(false);
  });
});

describe("tag lines (a note and each tag it carries)", () => {
  const tagNode = (id: string, extra: Partial<ContentNode> = {}) => ({ id, title: id, node_type: "class_tag", ...extra }) as ContentNode;
  const tag = (id: string, extra: Partial<Tag> = {}) => ({ id, name: id, color: null, schema_id: null, ...extra }) as Tag;
  const note = (id: string, extra: Partial<ContentNode> = {}) => ({ id, title: id, node_type: "content", ...extra }) as ContentNode;
  const draw = (ns: ContentNode[], ts: Tag[]) => {
    render(<AllCardsGraph nodes={ns} edges={[]} tags={ts} selectedNodeId={null} onNodeClick={() => {}} />);
    setSize(580, 450);
    return (capture.props.graphData as { links: { source: string; target: string; type: string }[] }).links.filter((l) => l.type === "tag");
  };

  it("draws one line for a note with one tag", () => {
    expect(draw([note("n", { class_tag_ids: ["windows"] }), tagNode("windows")], [tag("windows")]))
      .toEqual([{ source: "n", target: "windows", type: "tag" }]);
  });

  it("draws one line per tag when a note has several, class and label tags alike", () => {
    const links = draw(
      [note("n", { class_tag_ids: ["a"], label_tag_ids: ["b", "c"] }), tagNode("a"), tagNode("b"), tagNode("c")],
      [tag("a"), tag("b"), tag("c")],
    );
    expect(links.map((l) => l.target).sort()).toEqual(["a", "b", "c"]);
  });

  it("leaves out hidden, system and note-switch tags, and tags that are not drawn", () => {
    registerNoteSwitchModule("switchy");
    const links = draw(
      [note("n", { class_tag_ids: ["hid", "sys", "sw", "gone", "ok"] }), tagNode("hid"), tagNode("sys"), tagNode("sw"), tagNode("ok")],
      [tag("hid", { hidden: true }), tag("sys", { reserved_key: "workspace-config" }), tag("sw", { schema_module: "switchy" }), tag("gone"), tag("ok")],
    );
    expect(links.map((l) => l.target)).toEqual(["ok"]);
  });

  it("draws no line to a tag that is the note's parent (the tree line is there)", () => {
    expect(draw([note("n", { class_tag_ids: ["t"], parent_id: "t" }), tagNode("t")], [tag("t")])).toEqual([]);
  });

  it("keeps a line only while both ends are drawn (a hidden note takes its lines with it)", () => {
    expect(draw([note("n", { class_tag_ids: ["t"], hidden: true }), tagNode("t")], [tag("t")])).toEqual([]);
  });

  it("styles them apart: dashed, thinner, listed in the legend as 「tag」, and counted for the screen-reader list", () => {
    const { container } = render(<AllCardsGraph nodes={[note("n", { class_tag_ids: ["t"] }), tagNode("t")]} edges={[]} tags={[tag("t")]} selectedNodeId={null} onNodeClick={() => {}} />);
    setSize(580, 450);
    const link = { type: "tag" } as never;
    expect((capture.props.linkLineDash as (l: never) => unknown)(link)).toEqual([3, 3]);
    expect((capture.props.linkLineDash as (l: never) => unknown)({ type: "parent" } as never)).toBeNull();
    expect((capture.props.linkWidth as (l: never) => number)(link)).toBeLessThan(1.2);
    expect(container.querySelector(".all-cards-graph-legend")?.textContent).toContain("tag");
    expect(container.querySelector(".u-sr-only")?.textContent).toContain("n, 1 links");
  });

  it("gives tag lines a longer, weaker pull than ordinary lines", () => {
    const links = [
      { source: "a", target: "t", type: "tag" }, { source: "b", target: "t", type: "tag" },
      { source: "a", target: "b", type: "knowledge_link" },
    ];
    const tuning = linkTuning(links);
    expect(tuning.distance(links[0]!)).toBeGreaterThan(tuning.distance(links[2]!));
    expect(tuning.strength(links[0]!)).toBeLessThan(tuning.strength(links[2]!));
  });
});

it("leaves out the machinery tags (#task, #page) and hidden tags but keeps the person's tags", () => {
  const classTags = [
    { id: "mine", title: "作業", node_type: "class_tag" },
    { id: "task", title: "task", node_type: "class_tag" },
    { id: "mod", title: "task", node_type: "class_tag" },
    { id: "gone", title: "book", node_type: "class_tag", hidden: true },
    // The note carries every tag, so only the kind of tag decides (an empty tag or a lone note is left out anyway).
    { id: "note", title: "筆記", node_type: "content", class_tag_ids: ["mine", "task", "mod", "gone"] },
  ] as ContentNode[];
  const tagRows = [
    { id: "mine", name: "作業" },
    { id: "task", name: "task", reserved_key: "task" },
    { id: "mod", name: "task", schema_module: "tasks" },
    { id: "gone", name: "book", hidden: true },
  ] as Tag[];
  render(<AllCardsGraph nodes={classTags} edges={[]} tags={tagRows} selectedNodeId={null} onNodeClick={() => {}} />);
  setSize(580, 450);
  const ids = (capture.props.graphData as { nodes: Array<{ id: string }> }).nodes.map((n) => n.id).sort();
  expect(ids).toEqual(["mine", "note"]);
});

describe("tap to light, tap again to open (the whole-workspace graph)", () => {
  const ns = [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }] as ContentNode[];
  const es = [{ source_node_id: "a", target_node_id: "b", edge_type: "knowledge_link", status: "active" }] as never[];
  const tap = (id: string) => act(() => (capture.props.onNodeClick as (n: unknown) => void)({ id }));

  it("draws only linked notes, and the first tap opens nothing", () => {
    const onNodeClick = vi.fn();
    render(<AllCardsGraph nodes={ns} edges={es} tags={tags} selectedNodeId={null} onNodeClick={onNodeClick} />);
    setSize(580, 450);
    expect((capture.props.graphData as { nodes: { id: string }[] }).nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    tap("a");
    expect(onNodeClick).not.toHaveBeenCalled();
    tap("a");
    expect(onNodeClick).toHaveBeenCalledWith("a");
  });

  it("a tap on another point only moves the light; a tap on the background puts it out", () => {
    const onNodeClick = vi.fn();
    render(<AllCardsGraph nodes={ns} edges={es} tags={tags} selectedNodeId={null} onNodeClick={onNodeClick} />);
    setSize(580, 450);
    tap("a"); tap("b");
    expect(onNodeClick).not.toHaveBeenCalled();
    act(() => (capture.props.onBackgroundClick as () => void)());
    tap("b");
    expect(onNodeClick).not.toHaveBeenCalled();
  });

  it("the 「顯示」 menu appears only when something was left out", () => {
    const { container, rerender } = render(<AllCardsGraph nodes={ns} edges={es} tags={tags} selectedNodeId={null} onNodeClick={() => {}} />);
    setSize(580, 450);
    expect(container.querySelector(".all-cards-graph-display")).not.toBeNull();
    rerender(<AllCardsGraph nodes={ns.slice(0, 2)} edges={es} tags={tags} selectedNodeId={null} onNodeClick={() => {}} />);
    expect(container.querySelector(".all-cards-graph-display")).toBeNull();
  });
});

describe("the open note and the tap area", () => {
  const ns = [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "open", title: "Open" }] as ContentNode[];
  const es = [{ source_node_id: "a", target_node_id: "b", edge_type: "knowledge_link", status: "active" }] as never[];

  it("still draws the open note when it has no link", () => {
    render(<AllCardsGraph nodes={ns} edges={es} tags={tags} selectedNodeId="open" onNodeClick={() => {}} />);
    setSize(580, 450);
    expect((capture.props.graphData as { nodes: { id: string }[] }).nodes.map((n) => n.id).sort()).toEqual(["a", "b", "open"]);
  });

  it("makes the tap area as large as the drawn point (a big tag is not a background tap at its edge)", () => {
    const tagNode = { id: "t", title: "T", node_type: "class_tag" } as ContentNode;
    render(<AllCardsGraph nodes={[tagNode, ...ns]} edges={es} tags={tags} selectedNodeId={null} onNodeClick={() => {}} />);
    setSize(580, 450);
    const ctx = { fillStyle: "", beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), arc: vi.fn(), fill: vi.fn() };
    (capture.props.nodePointerAreaPaint as (...a: unknown[]) => void)({ id: "a", x: 0, y: 0, lines: 40 }, "#123", ctx, 1);
    const radius = ctx.arc.mock.calls[0]![2] as number;
    expect(radius).toBeGreaterThanOrEqual(12);
    (capture.props.nodePointerAreaPaint as (...a: unknown[]) => void)({ id: "t", x: 0, y: 0, tag: true, lines: 40 }, "#123", ctx, 1);
    expect(ctx.moveTo.mock.calls[0]![1]).toBeLessThanOrEqual(-16);
    expect(ctx.fill).toHaveBeenCalledTimes(2);
  });
});
