// Folder import's drawing step: an Obsidian Excalidraw note (`*.excalidraw.md`)
// goes up as a drawing — its title, its text as the body and the handwriting
// page (one ink_data codec, lib/ink/store.ts); the original file is not kept —
// instead of a Markdown note full of compressed text. What couldn't be drawn
// is reported per file; a drawing that can't be read goes up as Markdown, as
// before, and is listed.
import { encodeInk } from "@onden/markdown/ink";
import { decodeExcalidraw, isExcalidrawFile, type ExcalidrawSkip } from "./excalidraw";

/** A drawing as the import request carries it (backend modules/importers/routes.ts). */
export type DrawingImportFile = {
  path: string; content: string; kind: "drawing";
  title: string; ink_data: string;
};

export type DrawingReport = {
  drawings_converted: number;
  /** Elements not drawn, per file, with the reason. */
  drawing_skips: Array<ExcalidrawSkip & { path: string }>;
  /** Drawings whose data couldn't be read: imported as Markdown, as before. */
  drawings_unreadable: string[];
};

const emptyDrawingReport = (): DrawingReport => ({ drawings_converted: 0, drawing_skips: [], drawings_unreadable: [] });

export function convertDrawings<F extends { path: string }>(files: F[]): { files: Array<F | DrawingImportFile>; report: DrawingReport } {
  const report = emptyDrawingReport();
  const out = files.map((file): F | DrawingImportFile => {
    if (!("content" in file) || typeof file.content !== "string" || !isExcalidrawFile(file.path, file.content)) return file;
    const drawing = decodeExcalidraw(file.path, file.content); // never throws: null when unreadable
    if (!drawing) { report.drawings_unreadable.push(file.path); return file; }
    report.drawings_converted += 1;
    report.drawing_skips.push(...drawing.skipped.map((skip) => ({ ...skip, path: file.path })));
    return {
      path: file.path, content: drawing.body, kind: "drawing",
      title: drawing.title, ink_data: encodeInk(drawing.doc),
    };
  });
  return { files: out, report };
}

export function mergeDrawingReports(a: Partial<DrawingReport>, b: Partial<DrawingReport>): DrawingReport {
  return {
    drawings_converted: (a.drawings_converted ?? 0) + (b.drawings_converted ?? 0),
    drawing_skips: [...a.drawing_skips ?? [], ...b.drawing_skips ?? []],
    drawings_unreadable: [...a.drawings_unreadable ?? [], ...b.drawings_unreadable ?? []],
  };
}
