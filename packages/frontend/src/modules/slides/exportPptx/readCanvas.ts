// Reads one slide, drawn by SlideView at 1920×1080, into MeasuredSlide: where
// each piece of text, picture, code block and coloured box actually is. The
// positions come from the page's own layout (getBoundingClientRect), so the
// PPTX matches the screen without a second table of layout numbers; the words
// and their marks come from the rendered HTML (a list is a real list, a link a
// real link). Browser-side: it needs a laid-out DOM. The tests give it a DOM
// whose rectangles they set.
//
// Known limits (also in the export panel's PR notes): a gradient (the shade
// under the title on a full-picture slide) becomes a flat see-through box; a
// formula inside a line of text is written as its TeX source; hand-drawn
// strokes are not read.

import { isHexColor } from "@onden/markdown";
import { bytesToHex } from "../../../lib/hex";
import type { Box, CodeItem, FontKind, MeasuredItem, MeasuredSlide, Paragraph, PictureItem, Run, ShapeItem, TextItem } from "./measured";

export const CANVAS_WIDTH = 1920;
/** An undrawn diagram has no height of its own; its grey box is this tall (px). */
const MIN_UNDRAWN_PX = 300;

type Rgba = { hex: string; alpha: number };

/** `#rrggbb`, `rgb()`, `rgba()` and `color(srgb …)` (what getComputedStyle gives) → hex and alpha; null for none. */
export function parseColor(css: string): Rgba | null {
  const text = css.trim().toLowerCase();
  if (!text || text === "transparent") return null;
  const to2 = (n: number) => bytesToHex([Math.round(Math.min(255, Math.max(0, n)))]);
  const short = /^#([0-9a-f]{3})$/.exec(text);
  if (short) return { hex: `#${short[1]!.split("").map((c) => c + c).join("")}`, alpha: 1 };
  if (isHexColor(text)) return { hex: text, alpha: 1 };
  const rgb = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(text);
  if (rgb) {
    const a = rgb[4] === undefined ? 1 : rgb[4].endsWith("%") ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
    return a === 0 ? null : { hex: `#${to2(+rgb[1]!)}${to2(+rgb[2]!)}${to2(+rgb[3]!)}`, alpha: a };
  }
  const srgb = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(text);
  if (srgb) {
    const a = srgb[4] === undefined ? 1 : srgb[4].endsWith("%") ? parseFloat(srgb[4]) / 100 : parseFloat(srgb[4]);
    return a === 0 ? null : { hex: `#${to2(+srgb[1]! * 255)}${to2(+srgb[2]! * 255)}${to2(+srgb[3]! * 255)}`, alpha: a };
  }
  return null;
}

const px = (value: string, fallback = 0) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
};

/** The family a CSS font-family list starts with → which of the site's three faces it is. */
export function fontKindOf(family: string): FontKind {
  const first = (family.split(",")[0] ?? "").replace(/["']/g, "").trim().toLowerCase();
  if (first.includes("serif") && !first.includes("sans")) return "serif";
  if (/kaiti|biaukai|dfkai/.test(first)) return "kai";
  return "sans";
}

/** Where a picture's content really sits inside its box. `contain` shrinks the box to the picture's shape; the rest fill it. */
export function fittedBox(box: Box, natural: { w: number; h: number }, fit: string): Box {
  if (!(natural.w > 0 && natural.h > 0) || (fit !== "contain" && fit !== "scale-down")) return box;
  const scale = Math.min(box.w / natural.w, box.h / natural.h, fit === "scale-down" ? 1 : Infinity);
  const w = natural.w * scale;
  const h = natural.h * scale;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

const INLINE_TAGS = new Set(["a", "abbr", "b", "strong", "i", "em", "u", "s", "del", "ins", "mark", "small", "sub", "sup", "span", "code", "kbd", "br", "input", "label", "time", "cite", "q"]);
/** An element drawn within a line of text: an inline tag, a wikilink's button or a read-only task box (those two are
 *  inline-blocks). A box such as a card's number (`sv-card-n`) is not: it has a place of its own. */
function isInlineEl(el: Element): boolean {
  if (el.classList.contains("wikilink-token") || el.classList.contains("md-checkbox")) return true;
  return INLINE_TAGS.has(el.localName) && ["inline", ""].includes(css(el).display); // "" is a DOM that has no styles (a test)
}

/** Controls that are on the page but not on the slide: a copy button (invisible until hovered), anything hidden from readers. */
const isControl = (el: Element) => el.getAttribute("aria-hidden") === "true" || css(el).opacity === "0" || el.classList.contains("md-codeblock-copy");

const LIST_TAGS = new Set(["ul", "ol"]);

type Ctx = { canvas: HTMLElement; origin: DOMRect; scale: number; items: MeasuredItem[]; inlineFormulas: number; contentBottom: number };

const css = (el: Element) => getComputedStyle(el);

function boxOf(ctx: Ctx, el: Element | Range): Box {
  const r = el.getBoundingClientRect();
  return { x: (r.left - ctx.origin.left) / ctx.scale, y: (r.top - ctx.origin.top) / ctx.scale, w: r.width / ctx.scale, h: r.height / ctx.scale };
}

const isBlank = (box: Box) => box.w < 1 || box.h < 1;

function isTexTag(el: Element): boolean {
  return el.localName === "annotation" && el.getAttribute("encoding") === "application/x-tex";
}

const isDisplayMath = (el: Element) => el.classList.contains("katex-display");
const isInlineMath = (el: Element) => el.classList.contains("katex") && !el.closest(".katex-display");

/** Is every child text or an inline element? Then the element is one run of text, not a container. */
function holdsOnlyInline(el: Element): boolean {
  return [...el.childNodes].every((node) => {
    if (node.nodeType === 3) return true;
    if (node.nodeType !== 1) return true;
    const child = node as Element;
    if (isInlineMath(child)) return true;
    if (isDisplayMath(child)) return false;
    if (isControl(child)) return true;
    return isInlineEl(child) && !child.querySelector("img, svg, pre, ul, ol, table, .katex-display");
  });
}

function runFlags(el: Element): Pick<Run, "bold" | "italic" | "strike" | "link" | "mono"> & { color: string | null } {
  const style = css(el);
  const weight = style.fontWeight === "bold" ? 700 : px(style.fontWeight, 400);
  const href = el.closest("a")?.getAttribute("href") ?? undefined;
  const link = href && !href.startsWith("#") ? href : undefined; // a footnote jump is no link in a file
  return {
    bold: weight >= 600 || el.closest("b, strong") !== null,
    italic: style.fontStyle === "italic" || style.fontStyle === "oblique" || el.closest("i, em") !== null,
    strike: style.textDecorationLine.includes("line-through"),
    link: link || undefined,
    mono: el.closest("code, kbd") !== null || /mono/i.test(style.fontFamily),
    color: parseColor(style.color)?.hex ?? null,
  };
}

/** Lines of runs for the inline content of `el` (a `<br>` starts a new line). Whitespace collapses as the browser draws it. */
function inlineLines(ctx: Ctx, el: Element, base: { color: string; bold: boolean }, stop?: (child: Element) => boolean, only?: Iterable<Node>): Run[][] {
  const lines: Run[][] = [[]];
  const push = (run: Run) => {
    const line = lines[lines.length - 1]!;
    const last = line[line.length - 1];
    if (last && last.bold === run.bold && last.italic === run.italic && last.strike === run.strike && last.link === run.link && last.color === run.color && last.mono === run.mono) last.text += run.text;
    else line.push(run);
  };
  const visit = (node: Node, owner: Element) => {
    if (node.nodeType === 3) {
      const text = (node.textContent ?? "").replace(/\s+/g, " ");
      if (!text) return;
      const f = runFlags(owner);
      push({ text, bold: f.bold, italic: f.italic || undefined, strike: f.strike || undefined, link: f.link, mono: f.mono || undefined, color: f.color && f.color !== base.color ? f.color : undefined });
      return;
    }
    if (node.nodeType !== 1) return;
    const child = node as Element;
    if (stop?.(child) || isControl(child)) return;
    if (child.localName === "br") { lines.push([]); return; }
    if (child.localName === "input" || child.classList.contains("md-checkbox")) {
      const checked = child.classList.contains("md-checkbox") ? child.classList.contains("checked") : (child as HTMLInputElement).checked;
      push({ text: checked ? "☑ " : "☐ ", bold: false });
      return;
    }
    if (isInlineMath(child)) {
      ctx.inlineFormulas += 1;
      const tex = [...child.querySelectorAll("annotation")].find(isTexTag)?.textContent ?? child.textContent ?? "";
      push({ text: tex, bold: false, mono: true });
      return;
    }
    for (const inner of child.childNodes) visit(inner, child);
  };
  for (const node of only ?? el.childNodes) visit(node, el);
  // Spaces at a line's ends are not drawn.
  return lines.map((line) => {
    const out = line.map((run) => ({ ...run }));
    if (out[0]) out[0].text = out[0].text.replace(/^\s+/, "");
    const last = out[out.length - 1];
    if (last) last.text = last.text.replace(/\s+$/, "");
    return out.filter((run) => run.text !== "");
  });
}

const lineHeightOf = (style: CSSStyleDeclaration, size: number) => (style.lineHeight === "normal" ? size * 1.3 : px(style.lineHeight, size * 1.3));

/** How an element's words are set: face, size, line height, colour, weight, alignment (everything but where it is). */
export function elementTextStyle(el: Element): Omit<TextItem, "kind" | "role" | "box" | "paragraphs" | "indentPx"> {
  const style = css(el);
  const size = px(style.fontSize, 32);
  const weight = style.fontWeight === "bold" ? 700 : px(style.fontWeight, 400);
  const align = style.textAlign === "center" ? "center" : style.textAlign === "right" || style.textAlign === "end" ? "right" : "left";
  return {
    font: fontKindOf(style.fontFamily),
    sizePx: size,
    lineHeightPx: lineHeightOf(style, size),
    color: parseColor(style.color)?.hex ?? "#000000",
    bold: weight >= 600,
    align: align as TextItem["align"],
  };
}

const textStyleOf = (ctx: Ctx, el: Element) => ({ ...elementTextStyle(el), box: boxOf(ctx, el) });

function roleOf(el: Element): TextItem["role"] {
  if (el.closest(".sv-title")) return "title";
  // A table's cells are boxes of their own: the first one is not the page's body placeholder (its box would run down over the whole table).
  if (el.closest(".sv-body") && !el.closest("table")) return "body";
  return "other";
}

function paragraphsOf(ctx: Ctx, el: Element, base: { color: string; bold: boolean }, style: CSSStyleDeclaration): Paragraph[] {
  return inlineLines(ctx, el, base)
    .filter((line, i, all) => line.length > 0 || (i > 0 && i < all.length - 1))
    .map((runs, i) => ({ runs, spaceBeforePx: i === 0 ? 0 : px(style.marginTop), spaceAfterPx: 0 }));
}

function pushText(ctx: Ctx, el: Element): void {
  const style = textStyleOf(ctx, el);
  const paragraphs = paragraphsOf(ctx, el, style, css(el));
  if (paragraphs.length === 0 || isBlank(style.box)) return;
  ctx.items.push({ kind: "text", role: roleOf(el), paragraphs, indentPx: 0, ...style });
}

/** A bulleted or numbered list: one paragraph per item, nested lists as deeper levels. */
function pushList(ctx: Ctx, list: Element): void {
  const style = textStyleOf(ctx, list);
  const first = list.querySelector("li");
  if (!first) return;
  const itemStyle = textStyleOf(ctx, first);
  const paragraphs: Paragraph[] = [];
  const walkList = (ul: Element, level: number) => {
    const numbered = ul.localName === "ol";
    for (const li of ul.children) {
      if (li.localName !== "li") continue;
      const liStyle = css(li);
      const lines = inlineLines(ctx, li, itemStyle, (child) => LIST_TAGS.has(child.localName));
      // A loose item holds its words in a <p>.
      const runs = (lines.flat().length > 0 ? lines : [...li.children].filter((c) => c.localName === "p").flatMap((p) => inlineLines(ctx, p, itemStyle))).flat();
      paragraphs.push({
        runs,
        list: { level, numbered },
        spaceBeforePx: paragraphs.length === 0 ? 0 : px(liStyle.marginTop),
        spaceAfterPx: px(liStyle.marginBottom),
      });
      for (const nested of li.children) if (LIST_TAGS.has(nested.localName)) walkList(nested, level + 1);
    }
  };
  walkList(list, 0);
  if (isBlank(style.box)) return;
  ctx.items.push({
    kind: "text", role: roleOf(list), paragraphs,
    indentPx: px(css(list).paddingLeft, itemStyle.sizePx * 1.3),
    ...itemStyle, box: style.box,
  });
}

function pushCode(ctx: Ctx, pre: Element): void {
  const style = css(pre);
  const box = boxOf(ctx, pre);
  if (isBlank(box)) return;
  const size = px(style.fontSize, 24);
  const base = parseColor(style.color)?.hex ?? "#000000";
  const lines: Run[][] = [[]];
  const visit = (node: Node, owner: Element) => {
    if (node.nodeType === 3) {
      const colour = parseColor(css(owner).color)?.hex;
      (node.textContent ?? "").split("\n").forEach((part, i) => {
        if (i > 0) lines.push([]);
        if (part) lines[lines.length - 1]!.push({ text: part.replace(/\t/g, "  "), color: colour && colour !== base ? colour : undefined });
      });
      return;
    }
    if (node.nodeType === 1 && !isControl(node as Element)) for (const inner of node.childNodes) visit(inner, node as Element);
  };
  for (const node of pre.childNodes) visit(node, pre);
  if (lines.length > 1 && lines[lines.length - 1]!.length === 0) lines.pop(); // the newline that ends the block
  const borderWidth = px(style.borderTopWidth);
  const item: CodeItem = {
    kind: "code", box, lines, sizePx: size, lineHeightPx: lineHeightOf(style, size), color: base,
    fill: parseColor(style.backgroundColor)?.hex ?? null,
    line: borderWidth > 0 ? parseColor(style.borderTopColor)?.hex ?? null : null,
    paddingPx: px(style.paddingLeft),
  };
  ctx.items.push(item);
}

function pushPicture(ctx: Ctx, el: Element, why: PictureItem["why"]): void {
  let box = boxOf(ctx, el);
  if (isBlank(box)) return;
  let alt = "";
  if (el.localName === "img") {
    const img = el as HTMLImageElement;
    alt = img.alt;
    box = fittedBox(box, { w: img.naturalWidth, h: img.naturalHeight }, css(el).objectFit);
  } else if (why === "math") {
    alt = [...el.querySelectorAll("annotation")].find(isTexTag)?.textContent ?? "";
  }
  ctx.items.push({ kind: "picture", why, box, alt, data: null, source: el });
}

/** A picture that could not be had at all: its place, no data. */
function pushUndrawn(ctx: Ctx, el: Element): void {
  const box = boxOf(ctx, el);
  if (box.w < 1) return;
  // Tall enough to be seen, but no lower than the page's content area (nothing under it is covered).
  const h = Math.min(Math.max(box.h, MIN_UNDRAWN_PX), Math.max(ctx.contentBottom - box.y, box.h));
  ctx.items.push({ kind: "picture", why: "diagram", box: { ...box, h }, alt: "", data: null });
}

/** A coloured box or a ruled edge on an element: a card, a column, a quote's bar, a number's disc. */
function pushDecoration(ctx: Ctx, el: Element): void {
  if (el === ctx.canvas) return;
  const style = css(el);
  const box = boxOf(ctx, el);
  if (isBlank(box)) return;
  const gradient = style.backgroundImage.includes("gradient");
  let fill = parseColor(style.backgroundColor);
  if (!fill && gradient) {
    // The shade under a full-picture slide's title: the cover colour, mostly opaque (a PPTX box has no gradient here).
    const cover = parseColor(css(ctx.canvas).getPropertyValue("--s-cover"));
    if (cover) fill = { hex: cover.hex, alpha: 0.85 };
  }
  const widths = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].map((w) => px(w));
  const styled = (s: string) => s !== "none" && s !== "hidden";
  const framed = widths.every((w) => w > 0) && styled(style.borderTopStyle);
  const bar = !framed && widths[3]! > 0 && styled(style.borderLeftStyle) ? parseColor(style.borderLeftColor) : null;
  if (fill || framed) {
    const radius = style.borderTopLeftRadius.endsWith("%") ? (Math.min(box.w, box.h) * px(style.borderTopLeftRadius)) / 100 : px(style.borderTopLeftRadius);
    const shape: ShapeItem = {
      kind: "shape", box, fill: fill?.hex ?? null, fillAlpha: fill?.alpha ?? 1,
      line: framed ? parseColor(style.borderTopColor)?.hex ?? null : null, lineWidthPx: widths[0]!, radiusPx: radius,
    };
    ctx.items.push(shape);
    // A ruled bottom edge unlike the rest (a table header's accent line): the frame has one colour, so the edge is a line of its own.
    const bottomColor = parseColor(style.borderBottomColor)?.hex;
    if (framed && bottomColor && (widths[2] !== widths[0] || bottomColor !== shape.line) && styled(style.borderBottomStyle)) {
      ctx.items.push({ kind: "shape", box: { x: box.x, y: box.y + box.h - widths[2]!, w: box.w, h: widths[2]! }, fill: bottomColor, fillAlpha: 1, line: null, lineWidthPx: 0, radiusPx: 0 });
    }
  }
  if (bar) ctx.items.push({ kind: "shape", box: { x: box.x, y: box.y, w: widths[3]!, h: box.h }, fill: bar.hex, fillAlpha: 1, line: null, lineWidthPx: 0, radiusPx: 0 });
}

/** Text that sits straight in a container, between its block children (an anonymous paragraph). */
function pushLooseText(ctx: Ctx, owner: Element, nodes: Node[]): void {
  const runs = inlineLines(ctx, owner, textStyleOf(ctx, owner), undefined, nodes).flat();
  if (runs.length === 0) return;
  const range = owner.ownerDocument.createRange();
  range.setStartBefore(nodes[0]!);
  range.setEndAfter(nodes[nodes.length - 1]!);
  const box = boxOf(ctx, range);
  if (isBlank(box)) return;
  const style = textStyleOf(ctx, owner);
  ctx.items.push({ kind: "text", role: roleOf(owner), paragraphs: [{ runs, spaceBeforePx: 0, spaceAfterPx: 0 }], indentPx: 0, ...style, box });
}

function walk(ctx: Ctx, el: Element): void {
  const style = css(el);
  if (style.display === "none" || style.visibility === "hidden" || isControl(el)) return;
  const tag = el.localName;
  if (tag === "img") return pushPicture(ctx, el, "image");
  if (tag === "svg") return pushPicture(ctx, el, "diagram");
  // A diagram that is not drawn (still being made when the wait ran out, or it has an error) has nothing to read: a grey box, counted.
  if (el.classList.contains("md-mermaid-error") || (el.classList.contains("md-mermaid") && !el.querySelector("svg"))) return pushUndrawn(ctx, el);
  if (isDisplayMath(el) || isInlineMath(el)) return pushPicture(ctx, el, "math");
  // A diagram is drawn inside a <pre> (its box stays, the diagram is read below it).
  if (tag === "pre" && !el.querySelector(".md-mermaid, .md-mermaid-error")) return pushCode(ctx, el);
  if (tag === "input" || tag === "script" || tag === "style") return;
  pushDecoration(ctx, el);
  if (LIST_TAGS.has(tag) && style.listStyleType !== "none") return pushList(ctx, el);
  if (el.children.length === 0 && !el.textContent?.trim()) return;
  if (holdsOnlyInline(el) && !LIST_TAGS.has(tag)) {
    // A line that is only a formula ($$ … $$ on its own) is a picture of it, not TeX text.
    const only = el.children.length === 1 && isInlineMath(el.children[0]!) && el.textContent?.trim() === el.children[0]!.textContent?.trim() ? el.children[0]! : null;
    return only ? pushPicture(ctx, only, "math") : pushText(ctx, el);
  }
  // A container: its block children each, and the bare text between them.
  let loose: Node[] = [];
  const flush = () => { if (loose.length) pushLooseText(ctx, el, loose); loose = []; };
  for (const node of el.childNodes) {
    if (node.nodeType === 3) { loose.push(node); continue; }
    if (node.nodeType !== 1) continue;
    const child = node as Element;
    if (isInlineEl(child) && !child.querySelector("img, svg, pre")) { loose.push(child); continue; }
    flush();
    walk(ctx, child);
  }
  flush();
}

/** Reads the canvas (the `.sv-canvas` element, drawn at full size or scaled): every piece with its place, in drawing order. */
export function readSlideCanvas(canvas: HTMLElement): MeasuredSlide {
  const origin = canvas.getBoundingClientRect();
  // The canvas is laid out 1920 wide and may be scaled by a transform: measure against what it really takes.
  const scale = origin.width > 0 ? origin.width / CANVAS_WIDTH : 1;
  const canvasStyle = css(canvas);
  const contentBottom = origin.height / scale - px(canvasStyle.paddingBottom);
  const ctx: Ctx = { canvas, origin, scale, items: [], inlineFormulas: 0, contentBottom };
  for (const child of canvas.children) walk(ctx, child);
  return {
    background: parseColor(canvasStyle.backgroundColor)?.hex ?? "#ffffff",
    contentBottom,
    inlineFormulas: ctx.inlineFormulas,
    items: ctx.items,
  };
}
