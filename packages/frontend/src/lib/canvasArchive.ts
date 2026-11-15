// A board with handwriting leaves as a zip: the .canvas file plus the SVG its
// last node points at (JSON Canvas has no stroke node). Loaded only when a board
// with ink is exported, so the zip writer never reaches the boot bundle.

import type { JsonCanvas } from "./jsonCanvas";

export async function canvasArchive(
  prepared: { filename: string; canvas: JsonCanvas; ink: { file: string; svg: string } },
): Promise<Blob> {
  const { zipSync, strToU8 } = await import("fflate");
  const bytes = zipSync({
    [prepared.filename]: strToU8(JSON.stringify(prepared.canvas, null, 2)),
    [prepared.ink.file]: strToU8(prepared.ink.svg),
  });
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/zip" });
}
