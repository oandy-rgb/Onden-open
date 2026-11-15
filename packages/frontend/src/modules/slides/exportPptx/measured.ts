// What the browser measured on one slide drawn at 1920×1080 (readSlideCanvas), as
// plain data. This is the only thing the PPTX spec (deckSpec.ts) reads about
// where things go: positions, sizes and colours come from the slide as Onden
// draws it, not from a second table of layout numbers here. Units are the
// canvas's logical px (one px = half a point = 1/144 inch).

export type Box = { x: number; y: number; w: number; h: number };

export type Run = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  link?: string;
  /** A colour of its own (a code token, a link); else the item's colour. */
  color?: string;
  mono?: boolean;
};

export type Paragraph = {
  runs: Run[];
  /** Set for a list item: its depth (0 first) and whether it is numbered. */
  list?: { level: number; numbered: boolean };
  spaceBeforePx: number;
  spaceAfterPx: number;
};

export type FontKind = "serif" | "sans" | "kai";

export type TextItem = {
  kind: "text";
  /** The title, the page's main body (list or text), or anything else. */
  role: "title" | "body" | "other";
  box: Box;
  paragraphs: Paragraph[];
  font: FontKind;
  sizePx: number;
  lineHeightPx: number;
  color: string;
  bold: boolean;
  align: "left" | "center" | "right";
  /** Room a bullet takes left of the text, in px. */
  indentPx: number;
};

export type CodeItem = {
  kind: "code";
  box: Box;
  /** One array of coloured runs per line. */
  lines: Run[][];
  sizePx: number;
  lineHeightPx: number;
  color: string;
  fill: string | null;
  line: string | null;
  paddingPx: number;
};

export type ShapeItem = {
  kind: "shape";
  box: Box;
  fill: string | null;
  /** 0–1: how see-through the fill is. */
  fillAlpha: number;
  line: string | null;
  lineWidthPx: number;
  radiusPx: number;
};

/** A picture, or a formula / diagram that becomes one. `data` is a data URL;
 *  null means it could not be read (the PPTX gets a grey box). */
export type PictureItem = {
  kind: "picture";
  why: "image" | "math" | "diagram";
  box: Box;
  alt: string;
  data: string | null;
  /** The live element to draw from; dropped once `data` is made. */
  source?: Element;
};

export type MeasuredItem = TextItem | CodeItem | ShapeItem | PictureItem;

export type MeasuredSlide = {
  /** Page colour (hex, no #). */
  background: string;
  /** Where the canvas's content area ends (px from the top): the page height less its bottom padding. */
  contentBottom: number;
  /** Formulas inside a line of text, written as TeX (they cannot be a picture there). */
  inlineFormulas: number;
  items: MeasuredItem[];
};
