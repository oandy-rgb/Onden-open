import { useEffect, useRef, useState } from "react";
import { addToast, getAppState, subscribeApp, getNode } from "../lib/appStore";
import { WriteActionError, drafts, writeErrors } from "../lib/data";
import { downloadNoteText, markdownNoteExport, noteExportFilename, renderNoteExport, snapshotNoteForExport, withExcerptsExpanded, type NoteExportFormat, type NoteExportOptions } from "../lib/noteExport";
import { t } from "../lib/i18n";
import { downloadBlob } from "../lib/download";
import { ClipboardRefused, writeClipboardLater } from "../lib/clipboard";

/** Export failures surface as themselves; only the clipboard's own refusal
 * reads as "could not copy". */
async function copyExport(text: Promise<string>): Promise<void> {
  try {
    await writeClipboardLater(text);
  } catch (cause) {
    if (!(cause instanceof ClipboardRefused)) throw cause;
    throw new WriteActionError(t("Could not copy. Download Markdown from the note menu instead."), { cause });
  }
}

/** Shared by note menu and palette. False keeps their input/menu available.
 * Waiting work is cancelled by selection/workspace/readability changes. */
export function useNoteExport(editorVisible: boolean) {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function run(format: NoteExportFormat | "copy", options: NoteExportOptions = {}): Promise<boolean> {
    if (running.current) return false;
    const start = getAppState();
    const node = getNode(start.selectedId);
    if (!node || start.membershipGated) return false;
    let cancelled = false;
    const unsubscribe = subscribeApp(() => {
      const now = getAppState();
      const live = getNode(node.id);
      if (now.selectedId !== start.selectedId || now.data.workspace.id !== start.data.workspace.id
        || now.membershipGated || !live || !!live.deleted_at) cancelled = true;
    });
    const current = () => mounted.current && !cancelled;
    let popup: Window | null = null;
    running.current = true;
    setBusy(true);
    try {
      if (format === "pdf") {
        popup = window.open("", "_blank");
        if (!popup) throw new WriteActionError(t("Allow pop-ups to print this note to PDF"));
        popup.opener = null;
        popup.document.title = t("Preparing export…");
      }
      const captured = snapshotNoteForExport(node, editorVisible ? drafts.read(node.id) : null);
      // Quotes embedded from other notes are written out; with none, nothing waits.
      const prepared = captured instanceof Promise ? captured.then(withExcerptsExpanded) : withExcerptsExpanded(captured);
      if (format === "copy" || format === "markdown") {
        // Copy and download write the same file: the zip's, by the server (D52).
        const live = <T>(value: T): T => { if (!current()) throw new Error("export cancelled"); return value; };
        const snapshot = Promise.resolve(prepared);
        const file = snapshot.then(live).then((shot) => markdownNoteExport(shot, options.partLinks)).then(live);
        if (format === "copy") {
          await copyExport(file);
          if (current()) addToast(t("Copied"), "success");
        } else {
          const text = await file;
          downloadNoteText(text, noteExportFilename((await snapshot).title, "md"), "text/markdown;charset=utf-8");
        }
        return true;
      }
      const snapshot = prepared instanceof Promise ? await prepared : prepared;
      if (!current()) return false;
      if (format === "docx") {
        const { noteExportDocx } = await import("../lib/noteExportDocx"); // Word's writer loads only when asked for
        const file = await noteExportDocx(snapshot, { font: options.font });
        if (!current()) return false;
        downloadBlob(file, noteExportFilename(snapshot.title, "docx"));
        return true;
      }
      const html = await renderNoteExport(snapshot);
      // The print window gets the print page style; the downloaded HTML does not.
      const printable = popup ? (await import("../lib/noteExportPrint")).withPrintStyle(html) : html;
      if (!current() || popup?.closed) return false;
      if (popup) {
        const printWindow = popup;
        printWindow.document.open();
        printWindow.document.write(printable);
        printWindow.addEventListener("load", () => {
          if (!printWindow.closed) { printWindow.focus(); printWindow.print(); }
        }, { once: true });
        printWindow.document.close();
      } else downloadNoteText(html, noteExportFilename(snapshot.title, "html"), "text/html;charset=utf-8");
      return true;
    } catch (error) {
      popup?.close();
      if (current()) writeErrors.report(error, addToast);
      return false;
    } finally {
      if (!current()) popup?.close();
      unsubscribe();
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return { exportNote: (format: NoteExportFormat, options?: NoteExportOptions) => run(format, options), copyMarkdown: () => run("copy"), busy };
}
