// The export, start to finish: for each page, have the stage draw it (SlideView at
// 1920×1080, off screen), read where everything is, make its pictures; then
// turn that into the file. The stage is the dialog's hidden SlideView: this
// file only asks it for the canvas of page `i`, so it is the same drawing the
// view and the player show — the one source of positions, colours and sizes.

import { plainWords } from "../analyze";
import type { Page } from "../pages";
import { buildDeckSpec, notesText, type MasterLook } from "./deckSpec";
import type { FontChoice } from "./fonts";
import type { MeasuredSlide } from "./measured";
import { rasterizePictures } from "./rasterize";
import { readSlideCanvas } from "./readCanvas";
import { ExportCancelled, writePptx } from "./writePptx";

export type Stage = {
  /** Draws page `index` and resolves with its `.sv-canvas` once it has settled (layout fitted, fonts and pictures loaded). */
  show: (index: number) => Promise<HTMLElement>;
};

export type ExportResult = {
  blob: Blob;
  /** Pages (1-based) that have a picture that could not be read, with how many. */
  missingPictures: { slide: number; count: number }[];
  /** Pages (1-based) with a formula inside a line of text, which the file holds as TeX. */
  inlineFormulaSlides: number[];
  /** Pages (1-based) with a formula this browser could not draw as a picture: it is TeX text in the file. */
  texFormulaSlides: number[];
};

export type ExportRequest = {
  pages: readonly Page[];
  stage: Stage;
  look: MasterLook;
  font: FontChoice;
  /** The file's title (the note's). */
  title: string;
  signal: AbortSignal;
  /** Slides done of how many; said while reading and again while writing. */
  onProgress: (done: number, total: number) => void;
};

export async function exportDeck({ pages, stage, look, font, title, signal, onProgress }: ExportRequest): Promise<ExportResult> {
  const total = pages.length;
  const inlineFormulaSlides: number[] = [];
  const texFormulaSlides: number[] = [];
  const slides: { measured: MeasuredSlide; notes: string }[] = [];
  for (const [index, page] of pages.entries()) {
    if (signal.aborted) throw new ExportCancelled();
    const canvas = await stage.show(index);
    if (signal.aborted) throw new ExportCancelled();
    const measured = readSlideCanvas(canvas);
    const { formulasAsText } = await rasterizePictures(measured.items);
    if (measured.inlineFormulas > 0) inlineFormulaSlides.push(index + 1);
    if (formulasAsText > 0) texFormulaSlides.push(index + 1);
    slides.push({ measured, notes: notesText(page.notes, (paragraph) => plainWords(paragraph, { joiner: " " })) });
    onProgress(index + 1, total);
  }
  const spec = buildDeckSpec({ look, slides, font });
  const blob = await writePptx(spec, { title, signal });
  return { blob, missingPictures: spec.missingPictures.map(({ slide, count }) => ({ slide: slide + 1, count })), inlineFormulaSlides, texFormulaSlides };
}
