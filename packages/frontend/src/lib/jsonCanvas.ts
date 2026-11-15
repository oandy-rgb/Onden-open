// JSON Canvas 1.0 (jsoncanvas.org) — Obsidian's open canvas interchange
// format (spec is openly licensed; no Obsidian code involved). Onden maps
// its supported content and geometry to .canvas files; this is not a lossless
// round-trip for every JSON Canvas property. Handwriting is not a node type of
// the format: it leaves as one SVG picture (a "file" node, canvasArchive.ts) and
// is not read back as strokes. Mapping:
//   card (note on board)  ↔ "text" node (title as a leading heading)
//   section               ↔ "group" node
//   knowledge edge        ↔ edge
//   "link"/"file" nodes import as notes carrying the url/path in the body.

import { isHexColor, normalizeHexColor } from "@onden/markdown";
import { CARD_COLORS } from "./cardColors";
import { t } from "./i18n";

import { cutToUnits, NODE_TITLE_MAX } from "@onden/markdown";
export type JsonCanvasNode = {
  id: string;
  type: "text" | "file" | "link" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  text?: string;
  file?: string;
  url?: string;
  label?: string;
};
export type JsonCanvasEdge = {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: string;
  toSide?: string;
  label?: string;
};
export type JsonCanvas = { nodes: JsonCanvasNode[]; edges: JsonCanvasEdge[] };

export type ExportCard = {
  id: string; x: number; y: number; width?: number; height?: number;
  title: string; markdown: string; color?: string;
};
export type ExportSection = {
  id: string; x: number; y: number; width: number; height: number; title: string; color?: string;
};
export type ExportEdge = { id: string; source: string; target: string };

/** The board's handwriting as one picture file placed at the strokes' frame
 *  (board units): `file` is its path in the archive the .canvas travels in. */
export type ExportInk = { file: string; x: number; y: number; width: number; height: number };

/** `ink` becomes the LAST node: JSON Canvas stacks nodes in array order (later
 *  is on top), and strokes are drawn above the cards on an Onden board. */
export function toJsonCanvas(cards: ExportCard[], sections: ExportSection[], edges: ExportEdge[], ink?: ExportInk): JsonCanvas {
  const nodes: JsonCanvasNode[] = [
    ...sections.map((s): JsonCanvasNode => ({
      id: `group-${s.id}`, type: "group",
      x: Math.round(s.x), y: Math.round(s.y), width: Math.round(s.width), height: Math.round(s.height),
      label: s.title, ...(s.color?.startsWith("#") ? { color: s.color } : {}),
    })),
    ...cards.map((c): JsonCanvasNode => ({
      id: c.id, type: "text",
      x: Math.round(c.x), y: Math.round(c.y),
      width: Math.round(c.width ?? 240), height: Math.round(c.height ?? 120),
      text: c.title ? `# ${c.title}\n\n${c.markdown}` : c.markdown,
      ...(c.color?.startsWith("#") ? { color: c.color } : {}),
    })),
    ...(ink ? [{ id: "ink-layer", type: "file" as const, file: ink.file, x: ink.x, y: ink.y, width: ink.width, height: ink.height }] : []),
  ];
  const ids = new Set(cards.map((c) => c.id));
  const jcEdges: JsonCanvasEdge[] = edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({ id: e.id, fromNode: e.source, toNode: e.target }));
  return { nodes, edges: jcEdges };
}

export type ImportedCard = { key: string; x: number; y: number; width?: number; height?: number; title: string; markdown: string; color?: string };
export type ImportedSection = { x: number; y: number; width: number; height: number; title: string; color?: string };

// JSON Canvas colors are EITHER a hex string ("#rrggbb") OR a preset index
// "1".."6" (jsoncanvas.org leaves the exact hex to the app). Onden stores hex,
// so map the six standard presets onto Onden's own card swatches (CARD_COLORS)
// — an imported preset then renders AND stays re-editable from the colour menu,
// which highlights the matching swatch. Unknown/empty values drop to no colour.
// CARD_COLORS lists them in the same order after "Default" (1 red … 6 purple, 5 = cyan → blue).
export function normalizeJsonCanvasColor(color?: string): string | undefined {
  if (!color) return undefined;
  // Only what the server stores for a card/group colour; anything else is dropped.
  // #rgb is read as #rrggbb; alpha forms are dropped (the server stores #rrggbb only).
  if (color.startsWith("#")) { const hex = normalizeHexColor(color); return hex !== null && isHexColor(hex) ? hex : undefined; }
  return /^[1-6]$/.test(color) ? CARD_COLORS[Number(color)]!.value ?? undefined : undefined;
}
export type ImportedLink = { fromKey: string; toKey: string };
/** `skippedGroupLinks` is present only when the file had connections that end on a
 *  group (valid JSON Canvas, but a board connects cards): they are left out. */
export type ImportedCanvas = { cards: ImportedCard[]; sections: ImportedSection[]; links: ImportedLink[]; skippedGroupLinks?: number };

/** Invalid input is refused before the caller creates a board or a note.
 * The path identifies the offending entry without echoing its text/content. */
export class JsonCanvasFormatError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`${path}: ${t(detail)}`);
    this.name = "JsonCanvasFormatError";
  }

  /** What to tell the person: which card or connection, never the path or
   *  the validation detail (those stay on `message` for developers). */
  get userMessage(): string {
    const card = /^nodes\[(\d+)\]/.exec(this.path);
    if (card) return t("Card {n} in this .canvas file has a problem. Fix it and choose the file again.", { n: Number(card[1]) + 1 });
    const link = /^edges\[(\d+)\]/.exec(this.path);
    if (link) return t("Connection {n} in this .canvas file has a problem. Fix it and choose the file again.", { n: Number(link[1]) + 1 });
    return t("This .canvas file isn't in the right format. Check the file and choose it again.");
  }
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new JsonCanvasFormatError(path, "expected an object");
  return value as Record<string, unknown>;
}
function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string") throw new JsonCanvasFormatError(path, "expected text");
  return value;
}
function integerAt(value: unknown, path: string, dimension = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || (dimension && value <= 0)) {
    throw new JsonCanvasFormatError(path, dimension ? "expected a positive integer" : "expected a finite integer");
  }
  return value;
}
function optionalArray(value: unknown, path: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new JsonCanvasFormatError(path, "expected a list");
  return value;
}

// Split a text node into title + body: a leading `# Heading` becomes the note
// title; otherwise the first non-empty line (clipped) titles it.
function splitText(text: string): { title: string; markdown: string } {
  const m = text.match(/^#\s+(.+)\n+([\s\S]*)$/);
  if (m) return { title: m[1].trim(), markdown: m[2] };
  const firstLine = (text.split("\n").find((l) => l.trim()) ?? "Imported card").trim();
  return { title: cutToUnits(firstLine, 80), markdown: text };
}

export function fromJsonCanvas(input: unknown): ImportedCanvas {
  const jc = objectAt(input, "canvas");
  const nodes = optionalArray(jc.nodes, "nodes");
  const edges = optionalArray(jc.edges, "edges");
  const cards: ImportedCard[] = [];
  const sections: ImportedSection[] = [];
  const ids = new Set<string>();
  for (const [index, value] of nodes.entries()) {
    const path = `nodes[${index}]`;
    const n = objectAt(value, path);
    const id = stringAt(n.id, `${path}.id`);
    if (!id || ids.has(id)) throw new JsonCanvasFormatError(`${path}.id`, "expected a non-empty, unique node ID");
    ids.add(id);
    const base = {
      x: integerAt(n.x, `${path}.x`), y: integerAt(n.y, `${path}.y`),
      width: integerAt(n.width, `${path}.width`, true), height: integerAt(n.height, `${path}.height`, true),
    };
    const color = n.color === undefined ? undefined : normalizeJsonCanvasColor(stringAt(n.color, `${path}.color`));
    if (n.type === "group") {
      const label = n.label === undefined ? t("New group") : stringAt(n.label, `${path}.label`);
      if (label.length > NODE_TITLE_MAX) throw new JsonCanvasFormatError(`${path}.label`, "the group label exceeds the 500-character title limit");
      sections.push({ ...base, title: label, color });
    } else if (n.type === "text") {
      const text = splitText(stringAt(n.text, `${path}.text`));
      if (text.title.length > NODE_TITLE_MAX) throw new JsonCanvasFormatError(`${path}.text`, "the heading exceeds the 500-character note title limit");
      cards.push({ key: id, ...base, ...text, color });
    } else if (n.type === "link") {
      const url = stringAt(n.url, `${path}.url`);
      cards.push({ key: id, ...base, title: cutToUnits(url, 80) || "Link", markdown: url, color });
    } else if (n.type === "file") {
      const file = stringAt(n.file, `${path}.file`);
      const subpath = n.subpath === undefined ? "" : stringAt(n.subpath, `${path}.subpath`);
      if (subpath && !subpath.startsWith("#")) throw new JsonCanvasFormatError(`${path}.subpath`, "expected a heading or block reference starting with #");
      cards.push({ key: id, ...base, title: cutToUnits(file, 80) || "File", markdown: `Imported file reference: \`${file}${subpath}\``, color });
    } else {
      throw new JsonCanvasFormatError(`${path}.type`, "expected text, file, link or group");
    }
  }
  const keys = new Set(cards.map((c) => c.key));
  const edgeIds = new Set<string>();
  let skippedGroupLinks = 0;
  const links: ImportedLink[] = [];
  edges.forEach((value, index) => {
    const path = `edges[${index}]`;
    const edge = objectAt(value, path);
    const id = stringAt(edge.id, `${path}.id`);
    if (!id || edgeIds.has(id)) throw new JsonCanvasFormatError(`${path}.id`, "expected a non-empty, unique edge ID");
    edgeIds.add(id);
    const fromKey = stringAt(edge.fromNode, `${path}.fromNode`);
    const toKey = stringAt(edge.toNode, `${path}.toNode`);
    if (!ids.has(fromKey) || !ids.has(toKey)) throw new JsonCanvasFormatError(path, "an endpoint does not exist in nodes");
    if (!keys.has(fromKey) || !keys.has(toKey)) { skippedGroupLinks++; return; }
    links.push({ fromKey, toKey });
  });
  return { cards, sections, links, ...(skippedGroupLinks ? { skippedGroupLinks } : {}) };
}
