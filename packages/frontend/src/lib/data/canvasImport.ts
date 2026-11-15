// Importing a JSON Canvas (.canvas, jsoncanvas.org) file as a new board: read
// and parse the file, hand it to the board importer, and say what went wrong
// in the words a person can act on. The import itself is several accepted
// writes, not one transaction, so a failure after the first write must never
// read as "nothing happened" or invite a blind retry.

import { JsonCanvasFormatError } from "../jsonCanvas";
import { t } from "../i18n";
import { reportWriteFailure, WriteActionError } from "./writeErrors";
import type { ToastFn } from "./types";

/** The board title a file gives: its name without the .canvas extension. */
export function canvasFileTitle(name: string): string {
  return name.replace(/\.canvas$/i, "") || "Imported board";
}

/** Parse and import one file; report failures as toasts. Resolves to the new
 *  board's id, or null when nothing was imported or the import stopped. */
export async function importCanvasFile(
  file: File,
  importBoard: (title: string, raw: unknown) => Promise<string | null> | void,
  addToast: ToastFn,
): Promise<string | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch (error) {
    reportWriteFailure(new WriteActionError(t(error instanceof SyntaxError
      ? "This .canvas file isn't in the right format. Check the file and choose it again."
      : "Could not read this file. Choose it again."), { cause: error }), addToast);
    return null;
  }
  try {
    return (await importBoard(canvasFileTitle(file.name), raw)) ?? null;
  } catch (error) {
    if (error instanceof JsonCanvasFormatError) {
      // Validation runs before the first write: nothing was created.
      reportWriteFailure(new WriteActionError(error.userMessage, { cause: error }), addToast);
    } else {
      reportWriteFailure(error, (message, kind) => addToast(t("Import stopped. Some content may already have been created; check your notes before importing again. {message}", { message }), kind));
    }
    return null;
  }
}
