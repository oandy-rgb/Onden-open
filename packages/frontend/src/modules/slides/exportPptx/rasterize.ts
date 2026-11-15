// Makes the pictures of a measured slide: the page's own images (already loaded
// and signed in by the page, so no second request and no second login path),
// and the formulas and diagrams that a PPTX cannot hold as text, drawn to PNG.
// Every picture is made at twice its size on the slide, no more, so a deck of
// photos does not become a huge file. One that cannot be read (another site
// without permission, a failed load) stays `data: null` and the writer draws a
// grey box in its place. Browser-side (canvas).

import { MEDIA_TYPES, mediaTypeOf } from "@onden/markdown";
import type { Box, MeasuredItem, PictureItem, TextItem } from "./measured";
import { elementTextStyle } from "./readCanvas";

/** Pixels made per logical px of the slide: "the size it is shown at, times two". */
const docOf = (item: PictureItem): Document => item.source!.ownerDocument;

const OVERSAMPLE = 2;
const MAX_SIDE = 3840;
/** A PNG longer than this (as a data URL) is tried as JPEG too. */
const BIG_PNG = 600_000;
const PNG = MEDIA_TYPES[".png"]!.mime;
const JPEG = MEDIA_TYPES[".jpg"]!.mime;
const LOAD_TIMEOUT_MS = 8000;

function canvasFor(doc: Document, box: Box): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const k = Math.min(OVERSAMPLE, MAX_SIDE / Math.max(box.w, box.h));
  const w = Math.max(1, Math.round(box.w * k));
  const h = Math.max(1, Math.round(box.h * k));
  const canvas = Object.assign(doc.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d");
  return ctx ? { canvas, ctx, w, h } : null;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = setTimeout(() => reject(new Error("timeout")), LOAD_TIMEOUT_MS);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error("load")); };
    img.src = src;
  });
}

async function imageData(item: PictureItem, img: HTMLImageElement): Promise<string | null> {
  if (!img.complete || img.naturalWidth === 0) {
    try { await img.decode(); } catch { return null; }
    if (img.naturalWidth === 0) return null;
  }
  const target = canvasFor(docOf(item), item.box);
  if (!target) return null;
  const { canvas, ctx, w, h } = target;
  const fit = getComputedStyle(img).objectFit;
  if (fit === "cover") {
    // Crop the picture to the box's shape, from the middle.
    const boxRatio = w / h;
    const imgRatio = img.naturalWidth / img.naturalHeight;
    const sw = imgRatio > boxRatio ? img.naturalHeight * boxRatio : img.naturalWidth;
    const sh = imgRatio > boxRatio ? img.naturalHeight : img.naturalWidth / boxRatio;
    ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, w, h);
  } else {
    ctx.drawImage(img, 0, 0, w, h);
  }
  // A photograph goes straight to JPEG: made as PNG first it would be a huge picture in memory (a phone's too).
  if (isJpeg(img)) return canvas.toDataURL(JPEG, 0.9);
  const png = canvas.toDataURL(PNG); // throws when another site's picture taints the canvas
  if (png.length < BIG_PNG || !isOpaque(ctx, w, h)) return png;
  // A big PNG with nothing see-through (a screenshot) is smaller as JPEG; one with transparency stays PNG, or it would get a white box.
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  const jpeg = canvas.toDataURL(JPEG, 0.9);
  return jpeg.length < png.length ? jpeg : png;
}

const isJpeg = (img: HTMLImageElement) => img.currentSrc.toLowerCase().startsWith(`data:${JPEG}`) || mediaTypeOf(img.currentSrc)?.mime === JPEG;

/** True when every pixel is solid. */
function isOpaque(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const { data } = ctx.getImageData(0, 0, w, h);
  for (let i = 3; i < data.length; i += 4) if (data[i]! < 255) return false;
  return true;
}

/** An SVG document drawn to PNG at the item's size. */
async function svgToPng(svg: string, item: PictureItem): Promise<string | null> {
  const target = canvasFor(docOf(item), item.box);
  if (!target) return null;
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  target.ctx.drawImage(img, 0, 0, target.w, target.h);
  return target.canvas.toDataURL(PNG);
}

function diagramSvg(el: Element, box: Box): string {
  const clone = el.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(box.w));
  clone.setAttribute("height", String(box.h));
  if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${el.getBoundingClientRect().width} ${el.getBoundingClientRect().height}`);
  return new XMLSerializer().serializeToString(clone);
}

let katexStyle: Promise<string> | null = null;

/** KaTeX's own CSS and fonts, as one stylesheet text that stands alone inside an SVG picture (the fonts as data URLs). */
function katexStyleText(doc: Document): Promise<string> {
  katexStyle ??= (async () => {
    const parts: string[] = [];
    for (const sheet of [...doc.styleSheets]) {
      let rules: CSSRuleList;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) {
        if (rule instanceof CSSFontFaceRule && /KaTeX/.test(rule.style.getPropertyValue("font-family"))) {
          const src = /url\(["']?([^"')]+\.woff2)["']?\)/.exec(rule.style.getPropertyValue("src"))?.[1];
          if (!src) continue;
          try {
            const bytes = new Uint8Array(await (await fetch(new URL(src, sheet.href ?? doc.baseURI))).arrayBuffer());
            let binary = "";
            for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            parts.push(`@font-face{font-family:${rule.style.getPropertyValue("font-family")};font-style:${rule.style.getPropertyValue("font-style") || "normal"};font-weight:${rule.style.getPropertyValue("font-weight") || "normal"};src:url(data:font/woff2;base64,${btoa(binary)}) format("woff2")}`);
          } catch { /* that face falls back to a serif */ }
        } else if (rule instanceof CSSStyleRule && rule.selectorText.includes(".katex")) {
          parts.push(rule.cssText);
        }
      }
    }
    return parts.join("\n");
  })();
  return katexStyle;
}

async function mathSvg(el: Element, item: PictureItem): Promise<string> {
  const { w, h } = item.box;
  // KaTeX sizes itself in em of the line it sits in (its own 1.21em is in the .katex rule): take the line's size and colour.
  const style = getComputedStyle(el.parentElement ?? el);
  const css = await katexStyleText(el.ownerDocument);
  const html = new XMLSerializer().serializeToString(el);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="font-size:${style.fontSize};color:${style.color};width:${w}px;height:${h}px;display:flex;align-items:center;justify-content:${style.textAlign === "center" ? "center" : "flex-start"}"><style>${css.replace(/</g, "&lt;")}</style>${html}</div></foreignObject></svg>`;
}

async function makeData(item: PictureItem): Promise<string | null> {
  const el = item.source;
  if (!el) return item.data;
  try {
    if (item.why === "image") {
      const img = el as HTMLImageElement;
      return await imageData(item, img);
    }
    if (item.why === "diagram") return el.localName !== "svg" ? null : await svgToPng(diagramSvg(el, item.box), item);
    return await svgToPng(await mathSvg(el, item), item);
  } catch {
    return null;
  }
}

/** A formula that could not be drawn (Safari's canvas will not take an SVG with HTML in it) is its TeX, as text, in the
 *  formula's own colour and size: a place with words in it, not a grey box. */
function texAsText(item: PictureItem): TextItem {
  const host = item.source!.parentElement ?? item.source!;
  return {
    ...elementTextStyle(host), kind: "text", role: "other", box: item.box, indentPx: 0,
    paragraphs: [{ runs: [{ text: item.alt, mono: true }], spaceBeforePx: 0, spaceAfterPx: 0 }],
  };
}

/** Fills in `data` for every picture of the slide, then lets go of the live elements. A formula that cannot be drawn
 *  becomes text; the result says how many did. */
export async function rasterizePictures(items: MeasuredItem[]): Promise<{ formulasAsText: number }> {
  let formulasAsText = 0;
  for (const [i, item] of items.entries()) {
    if (item.kind !== "picture") continue;
    item.data = await makeData(item);
    if (item.data === null && item.why === "math" && item.alt && item.source) {
      items[i] = texAsText(item);
      formulasAsText += 1;
    }
    delete item.source;
  }
  return { formulasAsText };
}
