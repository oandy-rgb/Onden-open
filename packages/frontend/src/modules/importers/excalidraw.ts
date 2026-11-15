// Obsidian Excalidraw drawings (obsidian-excalidraw-plugin `*.excalidraw.md`)
// → a handwriting page (InkDocument). One decoder: folder import calls it, and
// the page it returns is stored through the one ink_data codec (store.ts
// encodeInk). Nothing is dropped without a reason in `skipped`. The drawing is
// converted at import only: the original file and the plugin's frontmatter
// (its `excalidraw-*` keys and `excalidraw` tag) are not kept (user, 2026-10-18,
// 「Excalidraw標籤刪了 只在匯入時轉換」).
//
// The file is Markdown: frontmatter with `excalidraw-plugin`, the note's own
// text, then `# Excalidraw Data` with the text elements and the drawing in a
// ```compressed-json block (LZString.compressToBase64, wrapped with blank
// lines) or, in older/decompressed files, a plain ```json block.

import { decompressFromBase64 } from "lz-string";
import type { InkDocument, InkPoint, InkStroke } from "../../lib/ink";
import { isHexColor, normalizeHexColor, readFrontmatter, writeFrontmatter, type FrontmatterEntry } from "@onden/markdown";

export type ExcalidrawSkip = { type: string; count: number; reason: string };
export type ExcalidrawImport = {
  /** The note's title: the file name without `.excalidraw.md`. */
  title: string;
  /** Text the drawing note carries (and the drawing's text labels), as its body. */
  body: string;
  doc: InkDocument;
  skipped: ExcalidrawSkip[];
};

/** Page width the drawing is fitted into (document units; handwriting notes use 1000). */
const PAGE_WIDTH = 1000;
const MARGIN = 24;

type Element = {
  id?: string; type?: string; x?: number; y?: number; width?: number; height?: number; angle?: number;
  strokeColor?: string; strokeWidth?: number; opacity?: number; isDeleted?: boolean;
  points?: Array<[number, number]>; pressures?: number[]; simulatePressure?: boolean;
  text?: string; originalText?: string;
};

/** Is this file an Excalidraw drawing note? By name, or by the plugin's frontmatter key. */
export function isExcalidrawFile(path: string, content: string): boolean {
  if (/\.excalidraw\.md$/i.test(path)) return true;
  return /\.md$/i.test(path) && (readFrontmatter(content)?.entries.some((entry: FrontmatterEntry) => entry.key === "excalidraw-plugin") ?? false);
}

/** The drawing's JSON text, or null when the file has none it can read. */
function drawingJson(content: string): { json: string } | null {
  const compressed = /```compressed-json\r?\n([\s\S]*?)```/.exec(content);
  if (compressed) {
    const json = decompressFromBase64(compressed[1].replace(/\s+/g, ""));
    return json ? { json } : null;
  }
  const plain = /```json\r?\n([\s\S]*?)```/.exec(content);
  return plain ? { json: plain[1] } : null;
}

/** The note's own text: its frontmatter without the plugin's own entries
 *  (withoutPluginFrontmatter) and the body above `# Excalidraw Data`, minus the
 *  plugin's "switch to Excalidraw view" banner; then the drawing's text labels. */
function noteBody(content: string, labels: string[], alias: string): string {
  // The block as written (Obsidian puts blank lines inside it): readFrontmatter keeps them as entries.
  const parsed = readFrontmatter(content);
  const fmLength = parsed ? content.length - parsed.body.length : 0;
  const inner = parsed ? parsed.entries.flatMap((e) => e.lines).join("\n") : "";
  // Obsidian links the drawing as [[name.excalidraw]]; the title drops
  // ".excalidraw", so the old name stays an alias (added to the note's own aliases).
  const front = writeFrontmatter([{ key: null, lines: withAlias(withoutPluginFrontmatter(inner.replace(/\s+$/, "")), alias).split("\n") }]);
  let text = content.slice(fmLength);
  const data = text.search(/^#+\s*Excalidraw Data\s*$/m);
  if (data >= 0) text = text.slice(0, data);
  text = text.split(/\r?\n/).filter((line) => !/Switch to EXCALIDRAW VIEW/i.test(line)).join("\n").trim();
  const rest = [text, labels.join("\n\n")].filter(Boolean).join("\n\n");
  return front + (rest ? `${rest}\n` : "");
}

const isPluginTag = (item: string) => item.trim().replace(/^["'#]+|["']$/g, "").toLowerCase() === "excalidraw";

/** The frontmatter without what the Excalidraw plugin writes for itself: its
 *  `excalidraw-*` keys (with any indented continuation lines) and the
 *  `excalidraw` tag, in whichever YAML form `tags` uses. The person's own keys
 *  and tags stay. */
export function withoutPluginFrontmatter(front: string): string {
  const lines = front ? front.split(/\r?\n/) : [];
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^excalidraw-[\w-]*\s*:/i.test(line)) {
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) i++;
      continue;
    }
    const tags = /^tags\s*:\s*(.*)$/.exec(line);
    if (!tags) { out.push(line); continue; }
    const value = tags[1]!.trim();
    if (value.startsWith("[")) {
      const kept = value.replace(/^\[|\]$/g, "").split(",").map((item) => item.trim()).filter((item) => item && !isPluginTag(item));
      if (kept.length) out.push(`tags: [${kept.join(", ")}]`);
    } else if (value) {
      if (!isPluginTag(value)) out.push(line);
    } else {
      // Block list: the indented "- item" lines that follow.
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1]!)) items.push(lines[++i]!);
      const kept = items.filter((item) => !isPluginTag(item.replace(/^\s+-\s*/, "")));
      if (kept.length) out.push("tags:", ...kept);
    }
  }
  return out.join("\n");
}

/** Frontmatter with `alias` among its aliases, in whichever YAML form the
 *  note uses — inline list, single value or block list — or a new line. */
function withAlias(front: string, alias: string): string {
  const quoted = JSON.stringify(alias);
  const lines = front ? front.split(/\r?\n/) : [];
  const at = lines.findIndex((line) => /^aliases\s*:/.test(line));
  if (at < 0) return [...lines, `aliases: [${quoted}]`].join("\n");
  const value = lines[at].replace(/^aliases\s*:\s*/, "");
  const unquote = (v: string) => v.trim().replace(/^["']|["']$/g, "");
  if (value.startsWith("[")) {
    const items = value.replace(/^\[|\]\s*$/g, "").split(",").map(unquote).filter(Boolean);
    if (!items.includes(alias)) lines[at] = value.replace(/\]\s*$/, `${items.length ? ", " : ""}${quoted}]`).replace(/^/, "aliases: ");
  } else if (value.trim()) {
    if (unquote(value) !== alias) lines[at] = `aliases: [${value.trim()}, ${quoted}]`;
  } else {
    // Block list: the indented "- item" lines that follow.
    let end = at + 1;
    while (end < lines.length && /^\s+-\s/.test(lines[end])) end++;
    const items = lines.slice(at + 1, end).map((line) => unquote(line.replace(/^\s+-\s*/, "")));
    if (!items.includes(alias)) lines.splice(end, 0, `  - ${quoted}`);
  }
  return lines.join("\n");
}

function rotate(x: number, y: number, cx: number, cy: number, angle: number): [number, number] {
  if (!angle) return [x, y];
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos];
}

/** An element's points in scene coordinates: relative to x/y, rotated about
 *  the centre of their bounding box (points may be negative, so x + width/2 is
 *  not the centre — Excalidraw rotates about the points' bounds). */
function scenePoints(el: Element): Array<[number, number]> {
  const x = el.x ?? 0, y = el.y ?? 0;
  const pts = (el.points ?? []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!pts.length) return [];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const cx = x + (Math.min(...xs) + Math.max(...xs)) / 2, cy = y + (Math.min(...ys) + Math.max(...ys)) / 2;
  return pts.map(([px, py]) => rotate(x + px, y + py, cx, cy, el.angle ?? 0));
}

/** The stroke colour; a translucent element (opacity < 100) is blended toward
 *  the white page, since strokes carry no alpha (dark mode inverts a plain hex). */
function colorOf(el: Element): string {
  const color = el.strokeColor && el.strokeColor !== "transparent" ? el.strokeColor : "#1e1e1e";
  const alpha = typeof el.opacity === "number" && el.opacity >= 0 && el.opacity < 100 ? el.opacity / 100 : 1;
  const full = normalizeHexColor(color); // #rgb reads as #rrggbb; alpha forms stay as they are
  const hex = full !== null && isHexColor(full) ? full.slice(1) : undefined;
  if (alpha === 1 || !hex) return color;
  const mix = (i: number) => Math.round(parseInt(hex.slice(i, i + 2), 16) * alpha + 255 * (1 - alpha)).toString(16).padStart(2, "0");
  return `#${mix(0)}${mix(2)}${mix(4)}`;
}

/** Two short strokes for an arrow's head at the last point. */
function arrowHead(points: Array<[number, number]>, width: number): Array<Array<[number, number]>> {
  if (points.length < 2) return [];
  const [x2, y2] = points[points.length - 1], [x1, y1] = points[points.length - 2];
  const angle = Math.atan2(y2 - y1, x2 - x1), len = 12 + width * 3;
  return [-1, 1].map((side) => [[x2 - len * Math.cos(angle + side * 0.45), y2 - len * Math.sin(angle + side * 0.45)], [x2, y2]]);
}

/** The drawing as a handwriting page, or null when it can't be read — no
 *  drawing block, bad compression or JSON, or a scene that parses but is
 *  malformed (the import then lists the file instead of failing the upload). */
export function decodeExcalidraw(path: string, content: string): ExcalidrawImport | null {
  try { return decode(path, content); } catch { return null; }
}

function decode(path: string, content: string): ExcalidrawImport | null {
  const found = drawingJson(content);
  if (!found) return null;
  let scene: { elements?: unknown };
  try { scene = JSON.parse(found.json); } catch { return null; }
  if (!scene || typeof scene !== "object" || !Array.isArray(scene.elements)) return null;
  const elements = (scene.elements as Element[]).filter((el) => el && typeof el === "object" && !el.isDeleted);

  // Strokes in scene coordinates first; fitted onto the page below.
  const raw: Array<{ id: string; points: InkPoint[]; color: string; width: number; pressure: boolean }> = [];
  const skipped = new Map<string, { count: number; reason: string }>();
  const skip = (type: string, reason: string) => {
    const entry = skipped.get(type) ?? { count: 0, reason };
    entry.count += 1; skipped.set(type, entry);
  };
  const labels: string[] = [];
  for (const el of elements) {
    const id = el.id ?? `el-${raw.length}`;
    const width = el.strokeWidth ?? 2;
    if (el.type === "freedraw") {
      const pts = scenePoints(el);
      if (pts.length === 0) { skip("freedraw", "no points"); continue; }
      const pressures = !el.simulatePressure && el.pressures?.length === pts.length ? el.pressures : null;
      raw.push({ id, color: colorOf(el), width, pressure: !!pressures,
        points: pts.map(([x, y], i) => (pressures ? [x, y, pressures[i]] : [x, y]) as InkPoint) });
    } else if (el.type === "line" || el.type === "arrow") {
      const pts = scenePoints(el);
      if (pts.length < 2) { skip(el.type, "fewer than two points"); continue; }
      raw.push({ id, color: colorOf(el), width, pressure: false, points: pts });
      if (el.type === "arrow") {
        arrowHead(pts, width).forEach((head, i) => raw.push({ id: `${id}-head${i}`, color: colorOf(el), width, pressure: false, points: head }));
      }
    } else if (el.type === "text") {
      const text = (el.originalText ?? el.text ?? "").trim();
      if (text) labels.push(text);
      skip("text", "kept as text in the note body, not drawn");
    } else if (el.type === "image") {
      skip("image", "handwriting notes can't hold images (kept in the original drawing)");
    } else if (el.type === "frame") {
      skip("frame", "frames only group elements; nothing to draw");
    } else {
      skip(el.type ?? "unknown", "this shape isn't converted to handwriting (kept in the original drawing)");
    }
  }

  // Fit onto the page: move the drawing to the top-left margin and shrink it
  // (never enlarge) to the page width; stroke sizes scale with it.
  let minX = Infinity, minY = Infinity, maxX = -Infinity;
  for (const s of raw) for (const [x, y] of s.points) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); }
  const scale = raw.length && maxX - minX > PAGE_WIDTH - 2 * MARGIN ? (PAGE_WIDTH - 2 * MARGIN) / (maxX - minX) : 1;
  const round = (n: number) => Math.round(n * 100) / 100;
  const strokes: InkStroke[] = raw.map((s) => ({
    id: s.id,
    color: s.color,
    // Excalidraw draws freehand at strokeWidth × 4.25 (perfect-freehand); the
    // pen's outline is 1 + size × 1.2 with real pressure, `size` without.
    size: round(Math.max(0.5, (s.pressure ? (s.width * 4.25 - 1) / 1.2 : s.width * (s.points.length > 2 ? 4.25 : 1.5)) * scale)),
    toolId: "pen",
    points: s.points.map((p) => {
      const x = round((p[0] - minX) * scale + MARGIN), y = round((p[1] - minY) * scale + MARGIN);
      return (p.length === 3 ? [x, y, round(p[2])] : [x, y]) as InkPoint;
    }),
  }));

  const fileName = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
  return {
    title: fileName.replace(/\.excalidraw$/i, ""),
    body: noteBody(content, labels, fileName),
    doc: { version: 1, strokes, erased: {}, page: { width: PAGE_WIDTH } },
    skipped: [...skipped].map(([type, { count, reason }]) => ({ type, count, reason })),
  };
}
