// Draws a DeckSpec into a .pptx with PptxGenJS, in the browser. The library is
// loaded here, on the first export, not at start-up (the boot budget).
//
// Keeping the page responsive: the measuring and picture-making that need the
// page's DOM and canvas run on the main thread anyway, so a Web Worker would
// only move the cheap part. Instead the writer is done in steps and hands the
// thread back between slides (and checks for 取消 there); the one long step is
// the final zip, which JSZip does asynchronously in slices.

import JSZip from "jszip";
import { SLIDE_INCHES, type DeckSpec, type ElementSpec } from "./deckSpec";

export class ExportCancelled extends Error {
  constructor() { super("cancelled"); }
}

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export type WriteOptions = {
  /** The file's title property. */
  title: string;
  signal?: AbortSignal;
  /** Said after each slide: slides done, of how many. */
  onProgress?: (done: number, total: number) => void;
};

export async function writePptx(spec: DeckSpec, { title, signal, onProgress }: WriteOptions): Promise<Blob> {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "ONDEN_16x9", width: SLIDE_INCHES.w, height: SLIDE_INCHES.h });
  pptx.layout = "ONDEN_16x9";
  pptx.title = title;
  pptx.company = "Onden";
  const { master } = spec;
  // One layout per place the titles and bodies sit in (see LayoutSpec); each has the theme's page colour and faces.
  for (const layout of spec.layouts) {
    const objects: Record<string, unknown>[] = [];
    if (layout.title) objects.push({ placeholder: { options: { name: "title", type: "title", ...layout.title, margin: 0, valign: "top", fontFace: master.title.fontFace, fontSize: master.title.fontSize, color: master.title.color, bold: master.title.bold }, text: "" } });
    if (layout.body) objects.push({ placeholder: { options: { name: "body", type: "body", ...layout.body, margin: 0, valign: "top", fontFace: master.body.fontFace, fontSize: master.body.fontSize, color: master.body.color }, text: "" } });
    pptx.defineSlideMaster({ title: layout.name, background: { color: master.background }, objects: objects as never });
  }
  const total = spec.slides.length;
  for (const [index, slideSpec] of spec.slides.entries()) {
    if (signal?.aborted) throw new ExportCancelled();
    const slide = pptx.addSlide({ masterName: slideSpec.layout });
    if (slideSpec.background) slide.background = { color: slideSpec.background };
    for (const element of slideSpec.elements) addElement(pptx, slide, element);
    if (slideSpec.notes) slide.addNotes(slideSpec.notes);
    onProgress?.(index + 1, total);
    await nextTurn();
  }
  if (signal?.aborted) throw new ExportCancelled();
  const file = (await pptx.write({ outputType: "arraybuffer", compression: false })) as ArrayBuffer;
  return mendParagraphs(file);
}

/** PptxGenJS writes a paragraph's properties again before every run after the first. A paragraph's properties belong
 *  once, first (PowerPoint may call such a file damaged; LibreOffice lets the stray ones undo the bullet), so the
 *  repeats are cut from each slide. Exported for the test. */
export function withoutStrayParagraphProps(xml: string): string {
  return xml.replace(/(<\/a:r>)(?:<a:pPr\b[^>]*\/>|<a:pPr\b(?:[^>/]|\/(?!>))*>(?:(?!<\/a:pPr>)[\s\S])*<\/a:pPr>)/g, "$1");
}

async function mendParagraphs(file: ArrayBuffer): Promise<Blob> {
  const zip = await JSZip.loadAsync(file);
  for (const name of Object.keys(zip.files)) {
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue;
    zip.file(name, withoutStrayParagraphProps(await zip.file(name)!.async("string")));
  }
  return zip.generateAsync({ type: "blob", compression: "DEFLATE", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" });
}

type Pptx = InstanceType<Awaited<typeof import("pptxgenjs")>["default"]>;
type Slide = ReturnType<Pptx["addSlide"]>;

function addElement(pptx: Pptx, slide: Slide, element: ElementSpec): void {
  const { x, y, w, h } = element.frame;
  switch (element.type) {
    case "text":
      slide.addText(element.runs as never, { x, y, w, h, ...element.options, ...(element.placeholder ? { placeholder: element.placeholder } : {}) } as never);
      break;
    case "shape":
      slide.addShape(pptx.ShapeType[element.shape], { x, y, w, h, ...element.options } as never);
      break;
    case "image":
      slide.addImage({ data: element.data, x, y, w, h, altText: element.altText });
      break;
  }
}
