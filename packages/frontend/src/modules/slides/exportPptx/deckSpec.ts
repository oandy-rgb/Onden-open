// Turns what the browser measured on each slide into the plain description
// the PPTX writer draws (writePptx.ts). Pure: no DOM, no PptxGenJS — so the
// mapping (which text becomes a bullet, what goes in the title placeholder,
// what an unreadable picture becomes) is tested without opening a file.
// Coordinates: logical px → inches, 144 px to the inch (1920 px = 13.333 in).

import { CODE_FONT, fontFile, type FontChoice } from "./fonts";
import type { Box, CodeItem, FontKind, MeasuredSlide, PictureItem, Run, ShapeItem, TextItem } from "./measured";

export const SLIDE_INCHES = { w: 13.333, h: 7.5 } as const;
const PX_PER_INCH = 144;
const PT_PER_PX = 0.5;
export const BASE_LAYOUT = "ONDEN";
const sameFrame = (a: Frame | null, b: Frame | null) => (a === null || b === null ? a === b : a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
/** The grey that stands in for a picture that could not be read. */
export const MISSING_PICTURE_FILL = "D9D9D9";

export const inch = (px: number) => Math.round((px / PX_PER_INCH) * 1000) / 1000;
const pt = (px: number) => Math.round(px * PT_PER_PX * 10) / 10;
const hex = (color: string) => (color.startsWith("#") ? color.slice(1) : color).toUpperCase();

export type Frame = { x: number; y: number; w: number; h: number };
const frameOf = (box: Box): Frame => ({ x: inch(box.x), y: inch(box.y), w: inch(box.w), h: inch(box.h) });

/** One run as PptxGenJS takes it: `options` of a paragraph's first run also carry the paragraph's. */
export type RunSpec = { text: string; options: Record<string, unknown> };

export type ElementSpec =
  | { type: "text"; frame: Frame; placeholder?: "title" | "body"; runs: RunSpec[]; options: Record<string, unknown> }
  | { type: "shape"; shape: "rect" | "roundRect"; frame: Frame; options: Record<string, unknown> }
  | { type: "image"; frame: Frame; data: string; altText: string };

/** `layout` names the master layout the slide uses (see LayoutSpec). */
export type SlideSpec = { layout: string; background: string | null; elements: ElementSpec[]; notes: string };

/** A slide layout of the file. PptxGenJS takes a placeholder's place from its layout, not from the slide, so a title
 *  or body that sits somewhere else (a cover's title, a list starting lower) needs a layout with that place. Slides
 *  that put their title and body in the same places share one; `title`/`body` are null when the slide has none. */
export type LayoutSpec = { name: string; title: Frame | null; body: Frame | null };

export type MasterLook = {
  background: string;
  text: string;
  headingFont: FontKind;
  bodyFont: FontKind;
  titleSizePx: number;
  bodySizePx: number;
  titleBold: boolean;
};

export type MasterSpec = {
  background: string;
  title: { fontFace: string; fontSize: number; color: string; bold: boolean };
  body: { fontFace: string; fontSize: number; color: string };
};

export type DeckSpec = {
  master: MasterSpec;
  layouts: LayoutSpec[];
  slides: SlideSpec[];
  /** Pictures that could not be read, by slide (0-based). */
  missingPictures: { slide: number; count: number }[];
};

export type DeckInput = {
  look: MasterLook;
  slides: { measured: MeasuredSlide; notes: string }[];
  font: FontChoice;
};

/** The notes Markdown as plain text; paragraphs stay apart. `plain` cuts one paragraph's marks. */
export const notesText = (markdown: string, plain: (paragraph: string) => string): string =>
  markdown.split(/\n{2,}/).map((paragraph) => plain(paragraph)).filter(Boolean).join("\n\n");

type RunStyle = { font: FontKind; sizePx: number; color: string; bold: boolean };

function runSpec(run: Run, style: RunStyle, choice: FontChoice, extra: Record<string, unknown> = {}): RunSpec {
  const options: Record<string, unknown> = {
    fontFace: run.mono ? CODE_FONT : fontFile(style.font, choice),
    fontSize: pt(style.sizePx),
    color: hex(run.color ?? style.color),
    bold: run.bold ?? style.bold,
    ...extra,
  };
  if (run.italic) options.italic = true;
  if (run.strike) options.strike = "sngStrike";
  if (run.link) options.hyperlink = { url: run.link };
  return { text: run.text, options };
}

function textElement(item: TextItem, choice: FontChoice, placeholder: "title" | "body" | undefined): ElementSpec {
  const runs: RunSpec[] = [];
  item.paragraphs.forEach((paragraph, i) => {
    const last = i === item.paragraphs.length - 1;
    // Paragraph settings sit on the paragraph's first run only: PptxGenJS writes them again, mid-paragraph, for any run that has them.
    const own: Record<string, unknown> = {
      align: item.align,
      lineSpacing: pt(item.lineHeightPx),
      paraSpaceBefore: pt(paragraph.spaceBeforePx),
      paraSpaceAfter: pt(paragraph.spaceAfterPx),
    };
    if (paragraph.list) {
      own.bullet = paragraph.list.numbered ? { type: "number", indent: pt(item.indentPx) } : { indent: pt(item.indentPx) };
      own.indentLevel = paragraph.list.level;
    }
    const source: Run[] = paragraph.runs.length > 0 ? paragraph.runs : [{ text: "" }];
    source.forEach((run, j) => {
      const extra: Record<string, unknown> = j === 0 ? { ...own } : {};
      if (j === source.length - 1 && !last) extra.breakLine = true;
      runs.push(runSpec(run, item, choice, extra));
    });
  });
  return {
    type: "text",
    frame: frameOf(item.box),
    placeholder,
    runs,
    options: { margin: 0, valign: "top", wrap: true, fit: "shrink" },
  };
}

function codeElement(item: CodeItem, choice: FontChoice): ElementSpec {
  const runs: RunSpec[] = [];
  const base: RunStyle = { font: "sans", sizePx: item.sizePx, color: item.color, bold: false };
  item.lines.forEach((line, i) => {
    const source: Run[] = line.length > 0 ? line : [{ text: "" }];
    source.forEach((run, j) => {
      const extra: Record<string, unknown> = j === 0 ? { align: "left", lineSpacing: pt(item.lineHeightPx) } : {};
      if (j === source.length - 1 && i < item.lines.length - 1) extra.breakLine = true;
      runs.push(runSpec({ ...run, mono: true }, base, choice, extra));
    });
  });
  const options: Record<string, unknown> = { margin: pt(item.paddingPx), valign: "top", wrap: true };
  if (item.fill) options.fill = { color: hex(item.fill) };
  if (item.line) options.line = { color: hex(item.line), width: 1 };
  return { type: "text", frame: frameOf(item.box), runs, options };
}

function shapeElement(item: ShapeItem): ElementSpec {
  const options: Record<string, unknown> = {};
  if (item.fill) options.fill = { color: hex(item.fill), transparency: Math.round((1 - item.fillAlpha) * 100) };
  if (item.line) options.line = { color: hex(item.line), width: Math.max(0.5, pt(item.lineWidthPx)) };
  const rounded = item.radiusPx > 0.5;
  if (rounded) options.rectRadius = inch(Math.min(item.radiusPx, item.box.w / 2, item.box.h / 2));
  return { type: "shape", shape: rounded ? "roundRect" : "rect", frame: frameOf(item.box), options };
}

function pictureElements(item: PictureItem): ElementSpec[] {
  if (item.data) return [{ type: "image", frame: frameOf(item.box), data: item.data.startsWith("data:") ? item.data.slice("data:".length) : item.data, altText: item.alt }];
  return [{ type: "shape", shape: "rect", frame: frameOf(item.box), options: { fill: { color: MISSING_PICTURE_FILL } } }];
}

export function buildDeckSpec({ look, slides, font }: DeckInput): DeckSpec {
  const master: MasterSpec = {
    background: hex(look.background),
    title: { fontFace: fontFile(look.headingFont, font), fontSize: pt(look.titleSizePx), color: hex(look.text), bold: look.titleBold },
    body: { fontFace: fontFile(look.bodyFont, font), fontSize: pt(look.bodySizePx), color: hex(look.text) },
  };
  const missingPictures: DeckSpec["missingPictures"] = [];
  const layouts: LayoutSpec[] = [{ name: BASE_LAYOUT, title: null, body: null }];
  const layoutFor = (title: Frame | null, body: Frame | null): string => {
    if (!title && !body) return BASE_LAYOUT;
    const same = layouts.find((l) => sameFrame(l.title, title) && sameFrame(l.body, body));
    if (same) return same.name;
    const name = `${BASE_LAYOUT}-${layouts.length}`;
    layouts.push({ name, title, body });
    return name;
  };
  const specs = slides.map(({ measured, notes }, index): SlideSpec => {
    const firstOf = (role: TextItem["role"]) => measured.items.find((i): i is TextItem => i.kind === "text" && i.role === role);
    const titleItem = firstOf("title");
    const bodyItem = firstOf("body");
    // The body's box runs to the bottom of the page's content area (its text starts at the top): one place for every list or text of a layout, whatever its length.
    const titleFrame = titleItem ? frameOf(titleItem.box) : null;
    const bodyFrame = bodyItem ? frameOf({ ...bodyItem.box, h: Math.max(bodyItem.box.h, measured.contentBottom - bodyItem.box.y) }) : null;
    const layout = layoutFor(titleFrame, bodyFrame);
    let titleTaken = false;
    let bodyTaken = false;
    const elements: ElementSpec[] = [];
    let missing = 0;
    for (const item of measured.items) {
      switch (item.kind) {
        case "text": {
          // The first title and the first main body sit in the layout's placeholders (change the master, the deck follows).
          const placeholder = item === titleItem && !titleTaken ? "title" : item === bodyItem && !bodyTaken ? "body" : undefined;
          if (placeholder === "title") titleTaken = true;
          if (placeholder === "body") bodyTaken = true;
          const element = textElement(item, font, placeholder);
          if (element.type === "text" && placeholder) element.frame = (placeholder === "title" ? titleFrame : bodyFrame)!;
          elements.push(element);
          break;
        }
        case "code": elements.push(codeElement(item, font)); break;
        case "shape": elements.push(shapeElement(item)); break;
        case "picture":
          if (!item.data) missing += 1;
          elements.push(...pictureElements(item));
          break;
      }
    }
    if (missing > 0) missingPictures.push({ slide: index, count: missing });
    const background = hex(measured.background);
    return { layout, background: background === master.background ? null : background, elements, notes };
  });
  return { master, layouts, slides: specs, missingPictures };
}
