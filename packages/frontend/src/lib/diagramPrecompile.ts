// Lays flowcharts and state diagrams out for publishing
// (docs/architecture/precompiled-diagrams.md): mermaid draws the block in this
// browser, and we read back only the geometry and the words, as the data the
// server checks and redraws (@onden/markdown diagramLayout.ts). The SVG mermaid
// drew is discarded here and never sent.
//
// Faithful or nothing: a block whose drawing holds anything this reader does
// not understand (an unknown shape, a path command outside M/L/C, a label that
// does not check out against the block) gives null, and that block stays code
// drawn by the reader's browser, exactly as before.
import {
  DIAGRAM_LAYOUT_VERSION, diagramKindOf, validateDiagramLayout,
  type DiagramArrow, type DiagramEdge, type DiagramGroup, type DiagramLayout, type DiagramLine, type DiagramNode, type DiagramShape, type PrecompiledDiagram,
} from "@onden/markdown";

/** How long the whole batch may take before the rest is left to the reader's browser. */
export const PRECOMPILE_BUDGET_MS = 8000;

type Point = readonly [number, number];
const round = (v: number) => Math.round(v * 10) / 10;

/** An element's matrix into the diagram's own units: its screen matrix, undoing the svg's scaling. */
function toDiagram(el: SVGGraphicsElement, svg: SVGSVGElement): DOMMatrix {
  const root = svg.getScreenCTM();
  const own = el.getScreenCTM();
  return root && own ? root.inverse().multiply(own) : new DOMMatrix();
}

/** A shape or text element's centre and size in the diagram's own units. */
function boxOf(el: SVGGraphicsElement, svg: SVGSVGElement): { x: number; y: number; w: number; h: number } {
  const b = el.getBBox();
  const m = toDiagram(el, svg);
  const a = new DOMPoint(b.x, b.y).matrixTransform(m);
  const c = new DOMPoint(b.x + b.width, b.y + b.height).matrixTransform(m);
  return { x: round((a.x + c.x) / 2), y: round((a.y + c.y) / 2), w: round(Math.abs(c.x - a.x)), h: round(Math.abs(c.y - a.y)) };
}

/** A state diagram's start and end markers, named by mermaid `state-root_start-0`, `state-Moving_end-3`. */
const pseudoState = (node: Element): "start" | "end" | null => (/_(start|end)-\d+$/.exec(node.id)?.[1] as "start" | "end" | undefined) ?? null;

function shapeOf(node: Element, box: { w: number; h: number }): DiagramShape | null {
  const pseudo = pseudoState(node);
  if (pseudo) return pseudo;
  if (/\bstate-(fork|join)\b/.test(node.getAttribute("class") ?? "")) return null;
  const shape = node.querySelector(":scope > :is(rect, circle, ellipse, polygon)");
  if (!shape) return null; // a path-drawn shape (stadium, cylinder, …) is not read
  const tag = shape.tagName.toLowerCase();
  if (tag === "circle" || tag === "ellipse") return "circle";
  if (tag === "rect") {
    const rx = Number(shape.getAttribute("rx") ?? 0);
    if (rx <= 0) return "rect";
    return rx >= box.h / 2 - 1 ? "stadium" : "round";
  }
  const points = (shape.getAttribute("points") ?? "").trim().split(/\s+/).map((p) => p.split(",").map(Number) as [number, number]);
  if (points.length === 6) return "hexagon";
  if (points.length === 4) {
    const xs = points.map((p) => p[0]); const ys = points.map((p) => p[1]);
    const mx = (Math.min(...xs) + Math.max(...xs)) / 2; const my = (Math.min(...ys) + Math.max(...ys)) / 2;
    const onMid = points.every(([x, y]) => (Math.abs(x - mx) < 0.5 || Math.abs(y - my) < 0.5));
    return onMid ? "diamond" : null; // a parallelogram or trapezoid is not a diamond
  }
  return null;
}

/** The words of a mermaid label, one line per row. */
function labelOf(el: Element | null): string {
  if (!el) return "";
  return [...el.querySelectorAll(".text-outer-tspan")].map((row) => (row.textContent ?? "").trim()).filter((l) => l !== "").join("\n");
}

const firstClass = (cls: string, family: RegExp): string | null => family.exec(cls)?.[0] ?? null;

function lineOf(cls: string): DiagramLine | null {
  if (/edge-thickness-invisible/.test(cls)) return null;
  const pattern = firstClass(cls, /edge-pattern-(solid|dashed|dotted)/);
  if (pattern !== "edge-pattern-solid") return "dashed";
  return firstClass(cls, /edge-thickness-(normal|thick)/) === "edge-thickness-thick" ? "thick" : "solid";
}

function arrowOf(marker: string | null): DiagramArrow {
  if (!marker) return "none";
  if (/point(End|Start)/.test(marker)) return "arrow";
  if (/barb(End|Start)/.test(marker)) return "open";
  if (/circle(End|Start)/.test(marker)) return "circle";
  if (/cross(End|Start)/.test(marker)) return "cross";
  return "none";
}

/** mermaid's path (absolute M/L/C with commas) moved into diagram units, or null for anything else. */
function pathOf(d: string, matrix: DOMMatrix): { path: string; first: Point; last: Point } | null {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+(?:e-?\d+)?/g);
  if (!tokens) return null;
  const arity: Record<string, number> = { M: 2, L: 2, C: 6 };
  let out = ""; let i = 0; let first: Point | null = null; let last: Point | null = null;
  while (i < tokens.length) {
    const cmd = tokens[i++]!;
    const n = arity[cmd];
    if (n === undefined) return null;
    out += cmd;
    for (let k = 0; k < n; k += 2) {
      const x = Number(tokens[i++]); const y = Number(tokens[i++]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const p = new DOMPoint(x, y).matrixTransform(matrix);
      const point: Point = [round(p.x), round(p.y)];
      first ??= point; last = point;
      out += `${k > 0 ? " " : ""}${point[0]},${point[1]}`;
    }
  }
  return first && last ? { path: out, first, last } : null;
}

const dist = (b: { x: number; y: number; w: number; h: number }, p: Point): number => {
  const dx = Math.max(Math.abs(p[0] - b.x) - b.w / 2, 0);
  const dy = Math.max(Math.abs(p[1] - b.y) - b.h / 2, 0);
  return Math.hypot(dx, dy);
};

/** The id a node keeps: mermaid's own name for it, without the render id in front. */
const localId = (el: Element, svgId: string): string => (el.getAttribute("data-id") ?? el.getAttribute("id") ?? "").replace(`${svgId}-`, "");

/** Reads the geometry of a rendered mermaid SVG. `svg` must be attached to the document (layout needs it). */
export function extractLayout(svg: SVGSVGElement, source: string): DiagramLayout | null {
  const kind = diagramKindOf(source);
  const view = svg.viewBox.baseVal;
  if (!kind || !view || view.width <= 0 || view.height <= 0) return null;
  const svgId = svg.getAttribute("id") ?? "";
  // Labels drawn as HTML (an `%%{init}%%` directive in the block can switch htmlLabels back on) have no
  // text rows to read: the block would be published as empty boxes, so it stays code instead.
  if (svg.querySelector("foreignObject")) return null;

  const groups: DiagramGroup[] = [];
  for (const g of svg.querySelectorAll<SVGGElement>("g.cluster, g.statediagram-cluster")) {
    const rect = g.querySelector<SVGGraphicsElement>(":scope > rect, :scope > g > rect.outer, :scope > rect.outer");
    if (!rect) return null;
    groups.push({ id: localId(g, svgId), ...boxOf(rect, svg), label: labelOf(g.querySelector(".cluster-label")) });
  }

  const nodes: DiagramNode[] = [];
  for (const g of svg.querySelectorAll<SVGGElement>("g.node")) {
    const shapeEl = pseudoState(g) ? g : g.querySelector<SVGGraphicsElement>(":scope > :is(rect, circle, ellipse, polygon)");
    if (!shapeEl) return null;
    const box = boxOf(shapeEl, svg);
    const shape = shapeOf(g, box);
    if (!shape) return null;
    const label = labelOf(g.querySelector(".label"));
    if (label === "" && shape !== "start" && shape !== "end") return null; // text we could not read is not an empty label
    nodes.push({ id: localId(g, svgId), shape, ...box, label });
  }
  if (nodes.length === 0) return null;

  const labels = new Map<string, { label: string; x: number; y: number }>();
  for (const l of svg.querySelectorAll<SVGGElement>(".edgeLabels g.label[data-id]")) {
    const text = l.querySelector<SVGGraphicsElement>("text");
    labels.set(l.getAttribute("data-id")!, { label: labelOf(l), ...(text ? boxOf(text, svg) : { x: 0, y: 0 }) });
  }

  const edges: DiagramEdge[] = [];
  const ends = [...groups, ...nodes];
  for (const p of svg.querySelectorAll<SVGPathElement>("path[data-edge='true']")) {
    const line = lineOf(p.getAttribute("class") ?? "");
    if (!line) continue; // an invisible link (~~~) only shapes the layout
    const drawn = pathOf(p.getAttribute("d") ?? "", toDiagram(p, svg));
    if (!drawn) return null;
    const near = (pt: Point) => ends.reduce((best, e) => (dist(e, pt) < dist(best, pt) ? e : best), ends[0]!);
    const id = p.getAttribute("data-id") ?? p.id.replace(`${svgId}-`, "");
    const text = labels.get(id);
    edges.push({
      id, from: near(drawn.first).id, to: near(drawn.last).id, path: drawn.path, line,
      arrow_start: arrowOf(p.getAttribute("marker-start")), arrow_end: arrowOf(p.getAttribute("marker-end")),
      label: text?.label ?? "", label_x: text?.label ? text.x : 0, label_y: text?.label ? text.y : 0,
    });
  }

  const checked = validateDiagramLayout({
    version: DIAGRAM_LAYOUT_VERSION, kind, width: round(view.width), height: round(view.height), groups, nodes, edges,
  }, source);
  return checked.ok ? checked.layout : null;
}

/** Lays out each block mermaid can, one after another, until `budgetMs` is
 *  spent: the blocks not reached are left out (the reader's browser draws
 *  them). Never throws: a block that fails to draw is just left out. */
export async function precompileDiagrams(sources: readonly string[], budgetMs = PRECOMPILE_BUDGET_MS): Promise<PrecompiledDiagram[]> {
  const wanted = sources.filter((s) => diagramKindOf(s) !== null);
  if (wanted.length === 0) return [];
  const deadline = Date.now() + budgetMs;
  const done: PrecompiledDiagram[] = [];
  let mermaid: typeof import("mermaid").default;
  try { mermaid = (await import("mermaid")).default; } catch { return []; }
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default", htmlLabels: false, flowchart: { htmlLabels: false } });
  const stage = document.createElement("div");
  stage.setAttribute("aria-hidden", "true");
  stage.style.cssText = "position:fixed;left:-10000px;top:0;width:1200px;visibility:hidden;pointer-events:none";
  document.body.append(stage);
  try {
    let n = 0;
    for (const source of wanted) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      try {
        const drawn = await Promise.race([
          // A render that loses the race to the clock may still fail later: nobody is waiting for it, so that is not an error.
          mermaid.render(`precompile-${Date.now().toString(36)}-${n++}`, source, stage).catch(() => null),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), left)),
        ]);
        if (!drawn) break;
        const holder = stage.querySelector<SVGSVGElement>("svg");
        const layout = holder ? extractLayout(holder, source) : null;
        if (layout) done.push({ source, layout });
      } catch {
        // a block mermaid cannot draw stays code
      } finally {
        stage.replaceChildren();
      }
    }
  } finally { stage.remove(); }
  return done;
}
