// Draws a checked DiagramLayout as SVG, from this file's own template
// (docs/architecture/precompiled-diagrams.md). The output is a small element
// tree, not a string: React renders it as elements and the static export turns
// it into hast, so every author-supplied value reaches the page as an attribute
// value or a text node that the renderer escapes. Only the tags and attributes
// below are ever produced: no foreignObject, script, event handler, href,
// style attribute or url(); colours come from CSS classes (DIAGRAM_CSS).

import type { Element as HastElement, ElementContent } from "hast";
import type { DiagramArrow, DiagramLayout, DiagramNode } from "./diagramLayout.js";

export type SvgNode = {
  tag: string;
  attrs?: Record<string, string | number>;
  children?: SvgNode[];
  /** Text content (a `text` or `tspan`); the renderer escapes it. */
  text?: string;
};

export const SVG_TAGS: readonly string[] = ["svg", "g", "rect", "ellipse", "circle", "polygon", "path", "text", "tspan"];
export const SVG_ATTRS: readonly string[] = [
  "viewBox", "width", "height", "role", "className", "x", "y", "rx", "ry", "cx", "cy", "r", "points", "d", "textAnchor", "dominantBaseline", "dy",
];

const n = (v: number) => Math.round(v * 100) / 100;
const el = (tag: string, attrs: SvgNode["attrs"], children?: SvgNode[]): SvgNode => ({ tag, attrs, children });
const pts = (list: Array<[number, number]>) => list.map(([x, y]) => `${n(x)},${n(y)}`).join(" ");

/** The last two points of a checked path (its end and the one before it, for the direction). */
function pathEnd(path: string, atStart: boolean): { tip: [number, number]; from: [number, number] } | null {
  const points: Array<[number, number]> = [];
  const nums = (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  for (let i = 0; i + 1 < nums.length; i += 2) points.push([nums[i]!, nums[i + 1]!]);
  if (points.length < 2) return null;
  return atStart ? { tip: points[0]!, from: points[1]! } : { tip: points[points.length - 1]!, from: points[points.length - 2]! };
}

function arrowHead(kind: DiagramArrow, end: { tip: [number, number]; from: [number, number] } | null): SvgNode | null {
  if (kind === "none" || !end) return null;
  const [tx, ty] = end.tip;
  const dx = tx - end.from[0]; const dy = ty - end.from[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len; const uy = dy / len; // unit vector pointing at the node
  const px = -uy; const py = ux; // perpendicular
  const back = (d: number, side: number): [number, number] => [tx - ux * d + px * side, ty - uy * d + py * side];
  if (kind === "arrow") return el("polygon", { className: "dg-head", points: pts([[tx, ty], back(9, 4.5), back(9, -4.5)]) });
  if (kind === "open") return el("path", { className: "dg-head-open", d: `M${n(back(9, 4.5)[0])},${n(back(9, 4.5)[1])}L${n(tx)},${n(ty)}L${n(back(9, -4.5)[0])},${n(back(9, -4.5)[1])}` });
  if (kind === "circle") return el("circle", { className: "dg-head", cx: n(tx - ux * 4), cy: n(ty - uy * 4), r: 4 });
  const a = back(10, 4); const b = back(2, -4); const c = back(10, -4); const d = back(2, 4);
  return el("path", { className: "dg-head-open", d: `M${n(a[0])},${n(a[1])}L${n(b[0])},${n(b[1])}M${n(c[0])},${n(c[1])}L${n(d[0])},${n(d[1])}` });
}

function nodeShape(node: DiagramNode): SvgNode {
  const { x, y, w, h } = node;
  const left = x - w / 2; const top = y - h / 2;
  const cls = "dg-shape";
  switch (node.shape) {
    case "round": return el("rect", { className: cls, x: n(left), y: n(top), width: n(w), height: n(h), rx: 6, ry: 6 });
    case "stadium": return el("rect", { className: cls, x: n(left), y: n(top), width: n(w), height: n(h), rx: n(h / 2), ry: n(h / 2) });
    case "diamond": return el("polygon", { className: cls, points: pts([[x, top], [x + w / 2, y], [x, top + h], [left, y]]) });
    case "hexagon": {
      const k = Math.min(h / 2, w / 4);
      return el("polygon", { className: cls, points: pts([[left + k, top], [left + w - k, top], [left + w, y], [left + w - k, top + h], [left + k, top + h], [left, y]]) });
    }
    case "circle": return el("ellipse", { className: cls, cx: n(x), cy: n(y), rx: n(w / 2), ry: n(h / 2) });
    case "start": return el("circle", { className: "dg-start", cx: n(x), cy: n(y), r: n(Math.min(w, h) / 2) });
    case "end": return el("g", undefined, [
      el("circle", { className: cls, cx: n(x), cy: n(y), r: n(Math.min(w, h) / 2) }),
      el("circle", { className: "dg-start", cx: n(x), cy: n(y), r: n(Math.min(w, h) / 3.2) }),
    ]);
    default: return el("rect", { className: cls, x: n(left), y: n(top), width: n(w), height: n(h) });
  }
}

/** A label as centred lines of text. An empty label draws nothing. */
function textLines(label: string, x: number, y: number, className: string): SvgNode | null {
  const lines = label.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length === 0) return null;
  const first = -((lines.length - 1) * 0.6);
  return el("text", { className, x: n(x), y: n(y), textAnchor: "middle", dominantBaseline: "central" },
    lines.map((text, i) => ({ tag: "tspan", attrs: { x: n(x), dy: i === 0 ? `${n(first)}em` : "1.2em" }, text })));
}

/** The diagram as an `svg` element. `layout` must have passed validateDiagramLayout. */
export function diagramSvgTree(layout: DiagramLayout): SvgNode {
  const groups = layout.groups.map((g) => {
    const label = textLines(g.label, g.x, g.y - g.h / 2 + 14, "dg-group-label");
    return el("g", undefined, [
      el("rect", { className: "dg-group", x: n(g.x - g.w / 2), y: n(g.y - g.h / 2), width: n(g.w), height: n(g.h), rx: 6, ry: 6 }),
      ...(label ? [label] : []),
    ]);
  });
  const edges = layout.edges.map((e) => {
    const parts: SvgNode[] = [el("path", { className: e.line === "solid" ? "dg-edge" : `dg-edge dg-${e.line}`, d: e.path })];
    const start = arrowHead(e.arrow_start, pathEnd(e.path, true));
    const end = arrowHead(e.arrow_end, pathEnd(e.path, false));
    if (start) parts.push(start);
    if (end) parts.push(end);
    const label = textLines(e.label, e.label_x, e.label_y, "dg-edge-label");
    if (label) parts.push(label);
    return el("g", undefined, parts);
  });
  const nodes = layout.nodes.map((node) => {
    const label = textLines(node.label, node.x, node.y, "dg-label");
    return el("g", undefined, [nodeShape(node), ...(label ? [label] : [])]);
  });
  return el("svg", { className: "dg", viewBox: `0 0 ${n(layout.width)} ${n(layout.height)}`, width: n(layout.width), height: n(layout.height), role: "img" }, [
    el("g", undefined, groups), el("g", undefined, edges), el("g", undefined, nodes),
  ]);
}

/** The element tree as hast, for the static export. Every value is a property
 *  or a text node the stringifier escapes, and a tag or attribute outside the
 *  template's lists is dropped, so nothing else can ride along. */
export function diagramHast(node: SvgNode): HastElement {
  const properties: Record<string, string | string[]> = {};
  if (SVG_TAGS.includes(node.tag)) {
    for (const [name, value] of Object.entries(node.attrs ?? {})) {
      if (SVG_ATTRS.includes(name)) properties[name] = name === "className" ? String(value).split(" ") : String(value);
    }
  }
  const children: ElementContent[] = SVG_TAGS.includes(node.tag)
    ? [...(node.text !== undefined ? [{ type: "text" as const, value: node.text }] : []), ...(node.children ?? []).map(diagramHast)]
    : [];
  return { type: "element", tagName: SVG_TAGS.includes(node.tag) ? node.tag : "g", properties, children };
}

/** The diagram's CSS, shared by the live site and the static export. Colours
 *  follow each host's own variables (the live site's --f-*, the export's
 *  --line / --surface) so light and dark come from the page, not from the diagram. */
export const DIAGRAM_CSS = `
.md-mermaid{margin:0 0 1em;text-align:center;overflow-x:auto}
.md-mermaid svg.dg{max-inline-size:100%;block-size:auto;font-size:1em;color:inherit}
.dg-shape{fill:var(--f-surface,var(--surface,transparent));stroke:var(--f-line,var(--line,currentColor));stroke-width:1.5}
.dg-group{fill:none;stroke:var(--f-line,var(--line,currentColor));stroke-width:1.2;stroke-dasharray:5 4}
.dg-edge{fill:none;stroke:currentColor;stroke-width:1.5;opacity:.75}
.dg-dashed{stroke-dasharray:6 4}
.dg-thick{stroke-width:3}
.dg-head,.dg-start{fill:currentColor;stroke:none;opacity:.8}
.dg-head-open{fill:none;stroke:currentColor;stroke-width:1.5;opacity:.8}
.dg-label,.dg-edge-label,.dg-group-label{fill:currentColor;stroke:none}
.dg-edge-label{paint-order:stroke;stroke:var(--f-bg,var(--bg,Canvas));stroke-width:5;stroke-linejoin:round;font-size:.9em}
.dg-group-label{opacity:.75;font-size:.9em}
`.trim();
