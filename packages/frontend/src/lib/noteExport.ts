import { stripTrailing } from "./textScan";
import { ApiError, getApiBase, nodeNeedsBody, type ContentNode, pageHref, pageOrigin } from "./api";
import { reads, WriteActionError } from "./data";
import { t } from "./i18n";
import { mediaUrl, rewriteMediaRefs, cutToBytes, embedMatches, hasLinkPath, type PartLinkExportMode } from "@onden/markdown";
import { downloadBlob } from "./download";

export type NoteExportSnapshot = { id: string; title: string; markdown: string };
export type NoteExportFormat = "markdown" | "html" | "pdf" | "docx";
/** Word only: 黑體 (sans) or 明體 (serif); the default is 黑體. */
export type NoteExportOptions = {
  font?: "sans" | "serif";
  /** Markdown only: how `[[筆記/段落開頭]]` is written (the server's part-link export; absent = 筆記連結＋段落文字). */
  partLinks?: PartLinkExportMode;
};

/** Capture what the user is exporting, without saving or modifying the note.
 * Loaded text (including an empty draft) is captured synchronously, at the gesture.
 * A slim row must hydrate successfully; it can never become an empty export.
 * Media remain references: this is a text export, not a complete backup. */
export function snapshotNoteForExport(node: ContentNode, draft: { title: string; markdown: string } | null): NoteExportSnapshot | Promise<NoteExportSnapshot> {
  if (node.deleted_at) throw new WriteActionError(t("This note is unavailable. Reopen it before exporting."));
  if (draft) return { id: node.id, ...draft };
  if (!nodeNeedsBody(node)) return { id: node.id, title: node.title, markdown: node.markdown };
  const { id, title } = node;
  return reads.notes.full(id).then(full => {
    if (full.id !== id || typeof full.markdown !== "string" || nodeNeedsBody(full) || full.deleted_at) {
      throw new WriteActionError(t("This note is unavailable. Reopen it before exporting."));
    }
    return { id, title, markdown: full.markdown };
  });
}

/** The snapshot with each `![[Note/words]]` (or old `![[Note#^id]]`) line that embeds an EXCERPT replaced by the quote
 *  and its link (lib/noteExportExcerpts.ts, which loads only when a note has such an embed:
 *  the markdown parser it needs is not in the boot JS). With none, the snapshot comes back
 *  at once, so the export starts at the gesture. */
export function withExcerptsExpanded(snapshot: NoteExportSnapshot): NoteExportSnapshot | Promise<NoteExportSnapshot> {
  const wanted = embedMatches(snapshot.markdown).filter((m) => m.blockId || hasLinkPath(m.target));
  if (wanted.length === 0) return snapshot;
  return import("./noteExportExcerpts").then((m) => m.expandExcerpts(snapshot, wanted));
}

// A file name is at most 255 bytes on most disks and a Chinese character takes
// 3 of them, so the cap is in bytes (leaving room for the extension).
const MAX_NAME_BYTES = 240;

export function noteExportFilename(title: string, extension: "md" | "html" | "docx" | "pptx"): string {
  const cleaned = title.replace(/[\\/:*?"<>|\p{Cc}]/gu, "-").replace(/[\s\S]*/u, (s) => stripTrailing(s, ". ")).trim();
  const name = stripTrailing(cutToBytes(cleaned, MAX_NAME_BYTES), ". ").trim();
  return `${name || "note"}.${extension}`;
}

export function downloadNoteText(text: string, filename: string, type: string): void {
  downloadBlob(new Blob([text], { type }), filename);
}

/** The note's Markdown file: the server writes it by the zip's rule (title,
 * tags and current attributes in the frontmatter). The zip's media links point
 * into its attachments folder; one file has none, so they become absolute
 * URLs at the original server, like the HTML export's. */
export async function markdownNoteExport(snapshot: NoteExportSnapshot, partLinks?: PartLinkExportMode): Promise<string> {
  const { markdown } = await reads.notes.exportMarkdown(snapshot.id, {
    title: snapshot.title, markdown: snapshot.markdown, ...(partLinks && partLinks !== "text" ? { part_links: partLinks } : {}),
  });
  if (typeof markdown !== "string") throw new WriteActionError(t("Could not prepare this export. Try again."));
  return rewriteMediaRefs(markdown, (id: string) => new URL(`${getApiBase()}${mediaUrl(id)}`, pageHref()).href);
}

/** The existing server renderer owns sanitizing/theme/math. POST is a read-only
 * conversion of this snapshot, not a note write, publish, or queued operation. */
export async function renderNoteExport(snapshot: NoteExportSnapshot): Promise<string> {
  let html: string;
  try {
    ({ html } = await reads.notes.exportHtml(snapshot.id,
      { title: snapshot.title, markdown: snapshot.markdown }));
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) {
      throw new WriteActionError(t("HTML conversion is unavailable. Download Markdown for now."), { cause });
    }
    throw cause;
  }
  if (typeof html !== "string" || !html.startsWith("<!doctype html>")) {
    throw new WriteActionError(t("Could not prepare this export. Try again."));
  }
  // A downloaded document has no app-relative base. Keep references usable at
  // their original server; do not embed or fetch private media into the file.
  const doc = new DOMParser().parseFromString(html, "text/html");
  const base = new URL(`${getApiBase() || pageOrigin()}/`, pageHref());
  for (const element of doc.querySelectorAll("[src], a[href]")) {
    const key = element.hasAttribute("src") ? "src" : "href";
    const value = element.getAttribute(key);
    if (value && !value.startsWith("#")) element.setAttribute(key, new URL(value, base).href);
  }
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}
