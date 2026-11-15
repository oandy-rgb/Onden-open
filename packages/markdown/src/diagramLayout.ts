// A mermaid diagram laid out ahead of time (docs/architecture/precompiled-diagrams.md).
// The author's browser lays a flowchart or state diagram out at publish time
// and sends THIS data; the server checks it with `validateDiagramLayout` and
// draws the SVG itself (diagramSvg.ts). Nothing the author's browser drew is
// ever kept. The checker is strict by design: it is the only gate between an
// upload anyone could forge and a public page.

import { fenceInfoWord, fenceScanner, openingFenceInfo } from "./fences.js";

export const DIAGRAM_LAYOUT_VERSION = 1;

export const DIAGRAM_SHAPES = ["rect", "round", "stadium", "diamond", "circle", "hexagon", "start", "end"] as const;
export type DiagramShape = (typeof DIAGRAM_SHAPES)[number];
export const DIAGRAM_ARROWS = ["none", "arrow", "open", "circle", "cross"] as const;
export type DiagramArrow = (typeof DIAGRAM_ARROWS)[number];
export const DIAGRAM_LINES = ["solid", "dashed", "thick"] as const;
export type DiagramLine = (typeof DIAGRAM_LINES)[number];
export type DiagramKind = "flowchart" | "state";

/** Centre and size, in the diagram's own units (px of the layout). */
export type DiagramBox = { x: number; y: number; w: number; h: number };
export type DiagramNode = DiagramBox & { id: string; shape: DiagramShape; label: string };
export type DiagramGroup = DiagramBox & { id: string; label: string };
export type DiagramEdge = {
  id: string; from: string; to: string;
  /** Absolute SVG path: M, L, C, Q and Z with numbers only. */
  path: string;
  line: DiagramLine; arrow_start: DiagramArrow; arrow_end: DiagramArrow;
  label: string; label_x: number; label_y: number;
};
export type DiagramLayout = {
  version: typeof DIAGRAM_LAYOUT_VERSION;
  kind: DiagramKind;
  width: number; height: number;
  groups: DiagramGroup[];
  nodes: DiagramNode[];
  edges: DiagramEdge[];
};
/** What a snapshot keeps per diagram: the block's text (the key a page looks
 *  its block up by) and its layout. */
export type PrecompiledDiagram = { source: string; layout: DiagramLayout };

export const DIAGRAM_LIMITS = {
  nodes: 100, edges: 200, groups: 30,
  labelChars: 200, labelLines: 6, idChars: 64, pathChars: 4000,
  sourceChars: 20_000, coordinate: 50_000, boxSize: 5_000, canvas: 20_000,
  /** Diagrams in one publish, and per diagram the bytes of its JSON. */
  perPublish: 50, layoutBytes: 200_000,
} as const;

/** Which kind of diagram a mermaid block is, or null when this version does not
 *  precompile it (sequence, gantt, pie…), which stays drawn by the reader's browser. */
export function diagramKindOf(source: string): DiagramKind | null {
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("%%")) continue;
    if (/^(flowchart|graph)(\s|$)/.test(line)) return "flowchart";
    if (/^stateDiagram(-v2)?\s*$/.test(line)) return "state";
    return null;
  }
  return null;
}

/** The text of every ```mermaid block of a note, as the renderers read a block
 *  (the opening fence's indent taken off, no final newline): the key a block is
 *  looked up by. Only top-level fences; a block inside a list or quote is not
 *  found and simply stays code for the reader's browser. */
export function mermaidSources(markdown: string): string[] {
  const found: string[] = [];
  const scan = fenceScanner();
  let block: { indent: number; lines: string[] } | null = null;
  for (const raw of markdown.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const state = scan(line);
    if (state === "open") {
      block = fenceInfoWord(openingFenceInfo(line) ?? "") === "mermaid" ? { indent: /^ */.exec(line)![0].length, lines: [] } : null;
    } else if (state === "inside") {
      block?.lines.push(line.replace(new RegExp(`^ {0,${block.indent}}`), ""));
    } else {
      if (state === "close" && block) found.push(block.lines.join("\n"));
      block = null;
    }
  }
  if (block) found.push(block.lines.join("\n")); // an unclosed fence runs to the end of the note
  return found;
}

export type DiagramCheck = { ok: true; layout: DiagramLayout } | { ok: false; reason: string };

const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
// Control characters, and anything that reads as an HTML tag. A bare "<" or ">" ("x > 5") is fine:
// the drawn text is escaped either way.
// eslint-disable-next-line no-control-regex -- the point is to refuse them
const BAD_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f]|<\s*\/?\s*[a-zA-Z!?]/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

const num = (v: unknown, limit: number, min = -limit): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= limit;

/** An absolute path of M, L, C, Q, Z with their numbers: the only SVG path a
 *  layout may carry (no relative commands, arcs, exponents or anything else). */
export function isSafePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > DIAGRAM_LIMITS.pathChars) return false;
  if (!/^[MLCQZ0-9 .,-]+$/.test(path)) return false;
  const arity: Record<string, number> = { M: 2, L: 2, C: 6, Q: 4, Z: 0 };
  const parts = path.match(/[MLCQZ]|-?\d+(?:\.\d+)?/g);
  // Every character must have been consumed by a token (no stray "-" or "1.2.3").
  if (!parts || parts.join("").length !== path.replace(/[ ,]/g, "").length) return false;
  let i = 0; let first = true;
  while (i < parts.length) {
    const cmd = parts[i++]!;
    const n = arity[cmd];
    if (n === undefined || (first && cmd !== "M")) return false;
    first = false;
    for (let k = 0; k < n; k++) {
      const v = parts[i++];
      if (v === undefined || !/^-?\d/.test(v) || !num(Number(v), DIAGRAM_LIMITS.coordinate)) return false;
    }
    // A command letter repeats its arity in groups; extra numbers must come in whole groups.
    while (n > 0 && i < parts.length && /^-?\d/.test(parts[i]!)) {
      for (let k = 0; k < n; k++) {
        const v = parts[i++];
        if (v === undefined || !/^-?\d/.test(v) || !num(Number(v), DIAGRAM_LIMITS.coordinate)) return false;
      }
    }
  }
  return true;
}

function labelProblem(label: unknown, source: string): string | null {
  if (typeof label !== "string") return "label is not text";
  if (label.length > DIAGRAM_LIMITS.labelChars) return "label too long";
  if (BAD_TEXT.test(label)) return "label has markup or control characters";
  const lines = label.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length > DIAGRAM_LIMITS.labelLines) return "label has too many lines";
  // The answer key: a label can only be words the author wrote in the block.
  return lines.every((l) => source.includes(l)) ? null : "label is not in the diagram's text";
}

function boxProblem(b: Record<string, unknown>): string | null {
  const c = DIAGRAM_LIMITS.coordinate;
  if (!num(b.x, c) || !num(b.y, c)) return "position out of range";
  if (!num(b.w, DIAGRAM_LIMITS.boxSize, 0) || !num(b.h, DIAGRAM_LIMITS.boxSize, 0)) return "size out of range";
  return null;
}

/** Whether `raw` (parsed JSON of unknown origin) is a layout this version draws
 *  for the block `source`. All or nothing: the first problem rejects the whole
 *  diagram. Returns a rebuilt value that carries only the known fields. */
export function validateDiagramLayout(raw: unknown, source: string): DiagramCheck {
  const no = (reason: string): DiagramCheck => ({ ok: false, reason });
  if (typeof source !== "string" || source.length === 0 || source.length > DIAGRAM_LIMITS.sourceChars) return no("source size");
  const kind = diagramKindOf(source);
  if (!kind) return no("diagram type not supported");
  if (!isRecord(raw)) return no("not an object");
  if (raw.version !== DIAGRAM_LAYOUT_VERSION) return no("version");
  if (raw.kind !== kind) return no("kind does not match the block");
  if (!num(raw.width, DIAGRAM_LIMITS.canvas, 1) || !num(raw.height, DIAGRAM_LIMITS.canvas, 1)) return no("canvas size");
  const { nodes, edges, groups } = raw;
  if (!Array.isArray(nodes) || !Array.isArray(edges) || !Array.isArray(groups)) return no("lists");
  if (nodes.length === 0 || nodes.length > DIAGRAM_LIMITS.nodes) return no("node count");
  if (edges.length > DIAGRAM_LIMITS.edges) return no("edge count");
  if (groups.length > DIAGRAM_LIMITS.groups) return no("group count");

  const ids = new Set<string>();
  const outGroups: DiagramGroup[] = [];
  const outNodes: DiagramNode[] = [];
  for (const g of groups) {
    if (!isRecord(g) || typeof g.id !== "string" || !ID.test(g.id) || ids.has(g.id)) return no("group id");
    ids.add(g.id);
    const bad = boxProblem(g) ?? labelProblem(g.label, source);
    if (bad) return no(`group: ${bad}`);
    outGroups.push({ id: g.id, x: g.x as number, y: g.y as number, w: g.w as number, h: g.h as number, label: g.label as string });
  }
  for (const n of nodes) {
    if (!isRecord(n) || typeof n.id !== "string" || !ID.test(n.id) || ids.has(n.id)) return no("node id");
    ids.add(n.id);
    if (!oneOf(DIAGRAM_SHAPES, n.shape)) return no("node shape");
    const bad = boxProblem(n) ?? labelProblem(n.label, source);
    if (bad) return no(`node: ${bad}`);
    outNodes.push({ id: n.id, shape: n.shape, x: n.x as number, y: n.y as number, w: n.w as number, h: n.h as number, label: n.label as string });
  }
  const edgeIds = new Set<string>();
  const outEdges: DiagramEdge[] = [];
  for (const e of edges) {
    if (!isRecord(e) || typeof e.id !== "string" || !ID.test(e.id) || edgeIds.has(e.id)) return no("edge id");
    edgeIds.add(e.id);
    if (typeof e.from !== "string" || typeof e.to !== "string" || !ids.has(e.from) || !ids.has(e.to)) return no("edge ends");
    if (!isSafePath(e.path)) return no("edge path");
    if (!oneOf(DIAGRAM_LINES, e.line) || !oneOf(DIAGRAM_ARROWS, e.arrow_start) || !oneOf(DIAGRAM_ARROWS, e.arrow_end)) return no("edge style");
    const label = e.label === undefined ? "" : e.label;
    const bad = labelProblem(label, source);
    if (bad) return no(`edge: ${bad}`);
    if (!num(e.label_x, DIAGRAM_LIMITS.coordinate) || !num(e.label_y, DIAGRAM_LIMITS.coordinate)) return no("edge label position");
    outEdges.push({
      id: e.id, from: e.from, to: e.to, path: e.path, line: e.line, arrow_start: e.arrow_start, arrow_end: e.arrow_end,
      label: label as string, label_x: e.label_x, label_y: e.label_y,
    });
  }
  const layout: DiagramLayout = { version: DIAGRAM_LAYOUT_VERSION, kind, width: raw.width, height: raw.height, groups: outGroups, nodes: outNodes, edges: outEdges };
  if (JSON.stringify(layout).length > DIAGRAM_LIMITS.layoutBytes) return no("too large");
  return { ok: true, layout };
}

/** The diagrams of a snapshot as a lookup by block text. Anything that does
 *  not check out against its own source is left out, so a page built from a
 *  tampered snapshot still draws only what passed the gate. */
export function diagramsBySource(list: unknown): Map<string, DiagramLayout> {
  const map = new Map<string, DiagramLayout>();
  if (!Array.isArray(list)) return map;
  for (const item of list.slice(0, DIAGRAM_LIMITS.perPublish * 20)) {
    if (!isRecord(item) || typeof item.source !== "string") continue;
    const check = validateDiagramLayout(item.layout, item.source);
    if (check.ok) map.set(item.source, check.layout);
  }
  return map;
}
