// Sending one chosen folder to POST /api/import/obsidian.
//
// A whole vault (notes + base64 images) is far larger than one request may be:
// nginx accepts at most MAX_REQUEST_BYTES (20 MB) per /api/ request
// (@onden/markdown mediaTypes.ts; docker/nginx/nginx.conf client_max_body_size), and a 58 MB vault was refused whole, so nothing
// imported. The folder therefore goes up in batches that compose into the
// same result as one request would give:
//   • every batch names the same `source` with upsert, so folders created by
//     one batch are reused by the next and a retry fills in what is missing;
//   • images go first; each response's `image_urls` is passed back as
//     `uploaded_images`, so a note resolves an image sent in another batch
//     (backend modules/importers/shared/images.ts);
//   • a CSV database rides in one request with its row pages: Notion exports
//     a database as `X.csv` (and maybe `X_all.csv`) plus a folder `X/` of
//     pages, and a row takes its body from a page in its own request. Each
//     database is one batch; one too large for a request is listed, not sent.
//   • a parent note `X.md` goes with the notes under `X/`, and a task list `X/X.md` with its task notes
//     (noteFamilies): the server finds those only among one request's files.

import { MAX_REQUEST_BYTES as PROXY_MAX_REQUEST_BYTES, MEDIA_TYPES } from "@onden/markdown";
import { convertDrawings, mergeDrawingReports, type DrawingImportFile, type DrawingReport } from "./drawingImport";
import type { ImportSource } from "@onden/contract";

export type ImportedMediaKind = "image" | "pdf" | "media";
export type FolderImportFile = { path: string; content: string } | { path: string; base64: string; kind: ImportedMediaKind } | DrawingImportFile;

/** How a file in the chosen folder goes up as media, or null when it is not
 *  media: any extension on the one media table (@onden/markdown
 *  mediaTypes.ts) — the server's import stores exactly those
 *  (modules/importers/shared/imageLinks.ts isImportedMediaPath). */
export function importedMediaKind(name: string): ImportedMediaKind | null {
  const dot = name.lastIndexOf(".");
  const ext = dot < 0 ? "" : name.slice(dot).toLowerCase();
  if (!Object.hasOwn(MEDIA_TYPES, ext)) return null;
  const kind = MEDIA_TYPES[ext]!.kind;
  return kind === "image" || kind === "pdf" ? kind : "media";
}
/** Whether a chosen file is hidden: a name starting with a dot anywhere under the chosen folder. The chosen folder's
 *  own name does not count (`~/.notes` is a fine folder to import); `rel` is `webkitRelativePath`, its first part the
 *  folder, or a bare file name when files were chosen one by one. */
export function isHiddenImportPath(rel: string): boolean {
  const parts = rel.split("/");
  return (parts.length > 1 ? parts.slice(1) : parts).some(part => part.startsWith("."));
}

export type SkippedNoteReason = "local_changes" | "history_incomplete" | "ambiguous" | "unavailable" | "invalid_tag_name" | "folder_unavailable" | "database_unavailable" | "too_large" | "invalid_text" | "site_mark";
export type ImportResult = Partial<DrawingReport> & {
  source?: ImportSource;
  /** Every skipped note with its reason (skipped === conflicts.length). */
  conflicts?: Array<{ path: string; reason: SkippedNoteReason }>;
  imported: number;
  updated?: number;
  unchanged?: number;
  skipped: number;
  /** Titles cut to the note title cap: a note's (path) or a database row's
   *  (its CSV path and row number). */
  titles_truncated?: Array<{ path: string; row?: number }>;
  ambiguous_date_columns?: Array<{ path: string; column: string }>;
  folders: number;
  folders_reused?: number;
  folders_skipped?: number;
  images_imported?: number;
  /** Of the stored files, how many were PDFs (![[x.pdf]] links to them). */
  pdfs_imported?: number;
  images_reused?: number;
  image_refs_unresolved?: number;
  images_skipped?: number;
  skipped_images?: Array<{ path: string; reason: "too_large" | "unreadable" }>;
  image_urls?: Record<string, string | null>;
  // Deep CSV/Notion database import: each CSV → a typed collection + items.
  collections_imported?: number;
  collection_rows_imported?: number;
  collection_rows_skipped?: number;
  collection_bodies_attached?: number;
  unsupported_files?: number;
  /** Checkbox lines that came in as plain checkboxes, not tasks; how many hold a 📅-style date. */
  checkboxes_not_tasks?: number;
  checkboxes_with_dates?: number;
  unsupported_exts?: string[];
  /** Relation fields of an Onden export resolved back to notes; the ones
   *  that kept their `[[Title]]` text are listed. */
  relations_resolved?: number;
  relations_unresolved?: number;
  unresolved_relations?: Array<{ path: string; key: string; value: string }>;
};

/** The proxy's request cap less 1 MB of room for headers and the
 *  uploaded_images map. */
export const MAX_REQUEST_BYTES = PROXY_MAX_REQUEST_BYTES - 1024 * 1024;
/** Batches aim for this size: short requests stay well inside the proxy's
 *  120 s timeout and a failed batch costs little to resend. */
export const BATCH_TARGET_BYTES = 8 * 1024 * 1024;

const encoder = new TextEncoder();
const fileBytes = (file: FolderImportFile) =>
  "base64" in file ? file.base64.length + encoder.encode(file.path).length + 48 : encoder.encode(JSON.stringify(file)).length;

/** A file or database that cannot be sent: alone it exceeds the request limit. */
export type TooLarge = { path: string; kind: "file" | "collection" };

/** The database a CSV belongs to: its path without `.csv` / `_all.csv`,
 *  lowercased — the key the server dedups `X.csv` and `X_all.csv` on. */
const collectionKey = (csvPath: string) => csvPath.toLowerCase().replace(/(?:_all)?\.csv$/, "");

/** `files` grouped so notes that belong together stay together: a parent note `X.md` with every file under `X/`,
 *  and a task list `X/X.md` with the files in its folder (its task notes). Case-insensitive, like the server's
 *  path matching; a file in no such family is a group of one. Order of first appearance is kept. */
function noteFamilies(files: FolderImportFile[]): FolderImportFile[][] {
  const root = new Map<string, string>(); // lowercase path -> the family's root path
  const lower = files.map(file => file.path.toLowerCase());
  const owners = new Set<string>(); // folders that have a parent note or a task list
  for (const path of lower) {
    if (!path.endsWith(".md")) continue;
    const stem = path.slice(0, -3);
    owners.add(stem); // `X.md` owns `X/`
    const slash = stem.lastIndexOf("/");
    if (slash >= 0 && stem.slice(slash + 1) === stem.slice(stem.lastIndexOf("/", slash - 1) + 1, slash)) owners.add(stem.slice(0, slash)); // `X/X.md` owns `X/`
  }
  const find = (key: string): string => { let at = key; while (root.has(at) && root.get(at) !== at) at = root.get(at)!; return at; };
  const join = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) root.set(rb, ra); };
  for (const path of lower) root.set(path, path);
  for (const path of lower) {
    for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1)) {
      const folder = path.slice(0, slash);
      if (owners.has(folder)) join(`${folder}.md`, path);
    }
  }
  const groups = new Map<string, FolderImportFile[]>();
  files.forEach((file, index) => {
    const key = find(lower[index]!);
    groups.set(key, [...groups.get(key) ?? [], file]);
  });
  return [...groups.values()];
}

/** Split files into request-sized batches: images first, then each CSV
 *  database with the pages in its folder (the innermost database owns a
 *  nested folder), then the remaining text. A file, or a database, that alone
 *  exceeds `maxRequestBytes` cannot be sent and is returned in `tooLarge`. */
export function planImportBatches(files: FolderImportFile[], targetBytes = BATCH_TARGET_BYTES, maxRequestBytes = MAX_REQUEST_BYTES) {
  const tooLarge: TooLarge[] = [];
  const batches: FolderImportFile[][] = [];
  // A unit is files that must arrive in one request (see noteFamilies). One too big to keep whole is split file by file.
  const pack = (units: FolderImportFile[][]) => {
    let current: FolderImportFile[] = [], size = 0;
    const add = (file: FolderImportFile[], bytes: number) => {
      if (current.length && size + bytes > targetBytes) { batches.push(current); current = []; size = 0; }
      current.push(...file); size += bytes;
    };
    for (const unit of units) {
      const unitBytes = unit.reduce((sum, file) => sum + fileBytes(file), 0);
      if (unit.length > 1 && unitBytes <= maxRequestBytes) { add(unit, unitBytes); continue; }
      for (const file of unit) {
        const bytes = fileBytes(file);
        if (bytes > maxRequestBytes) tooLarge.push({ path: file.path, kind: "file" }); else add([file], bytes);
      }
    }
    if (current.length) batches.push(current);
  };
  const images = files.filter(file => "base64" in file);
  const text = files.filter(file => !("base64" in file));
  pack(images.map(file => [file]));

  // Databases: each CSV (with its _all twin) and the pages under its folder.
  const collections = new Map<string, FolderImportFile[]>();
  for (const file of text) {
    if (!file.path.toLowerCase().endsWith(".csv")) continue;
    const key = collectionKey(file.path);
    collections.set(key, [...collections.get(key) ?? [], file]);
  }
  const keys = [...collections.keys()].sort((a, b) => b.length - a.length); // innermost first
  const loose: FolderImportFile[] = [];
  for (const file of text) {
    if (file.path.toLowerCase().endsWith(".csv")) continue;
    const lower = file.path.toLowerCase();
    const owner = keys.find(key => lower.startsWith(`${key}/`));
    if (owner) collections.get(owner)!.push(file);
    else loose.push(file);
  }
  for (const group of collections.values()) {
    const bytes = group.reduce((sum, file) => sum + fileBytes(file), 0);
    if (bytes > maxRequestBytes) {
      // Its rows and pages must arrive together; sending part would import
      // rows without bodies and the rest as loose notes.
      for (const file of group) if (file.path.toLowerCase().endsWith(".csv")) tooLarge.push({ path: file.path, kind: "collection" });
      continue;
    }
    batches.push(group);
  }
  pack(noteFamilies(loose));
  return { batches, tooLarge };
}

const COUNTS = ["imported", "updated", "unchanged", "skipped", "folders", "folders_reused", "folders_skipped",
  "images_imported", "pdfs_imported", "images_reused", "image_refs_unresolved", "images_skipped", "collections_imported",
  "collection_rows_imported", "collection_rows_skipped", "collection_bodies_attached", "unsupported_files",
  "checkboxes_not_tasks", "checkboxes_with_dates", "relations_resolved", "relations_unresolved"] as const;

/** Add one batch's response to the running result. A folder created by one
 *  batch and reused by a later one counts in both `folders` and `folders_reused`. */
export function mergeImportResults(total: ImportResult, next: ImportResult): ImportResult {
  const merged: ImportResult = { ...total, source: next.source ?? total.source };
  for (const key of COUNTS) merged[key] = (total[key] ?? 0) + (next[key] ?? 0);
  Object.assign(merged, mergeDrawingReports(total, next));
  merged.conflicts = [...total.conflicts ?? [], ...next.conflicts ?? []];
  merged.skipped_images = [...total.skipped_images ?? [], ...next.skipped_images ?? []];
  merged.titles_truncated = [...total.titles_truncated ?? [], ...next.titles_truncated ?? []];
  merged.ambiguous_date_columns = [...total.ambiguous_date_columns ?? [], ...next.ambiguous_date_columns ?? []];
  merged.unresolved_relations = [...total.unresolved_relations ?? [], ...next.unresolved_relations ?? []];
  merged.image_urls = { ...total.image_urls, ...next.image_urls };
  merged.unsupported_exts = [...new Set([...total.unsupported_exts ?? [], ...next.unsupported_exts ?? []])].sort();
  return merged;
}

/** Send the folder batch by batch, in order, and return the combined result.
 *  `send` posts one request body and resolves with the server's response.
 *  A failed batch rejects with its error: earlier batches stay committed, and
 *  importing the same folder again into the same source upserts — imported
 *  notes come back unchanged and only the missing ones are added. */
export async function uploadFolderImport(options: {
  files: FolderImportFile[]; source: ImportSource;
  send: (body: { files: FolderImportFile[]; upsert: true; source: ImportSource; uploaded_images?: Record<string, string | null> }) => Promise<ImportResult>;
  onProgress?: (progress: { batch: number; batches: number }) => void;
  targetBytes?: number;
}): Promise<{ result: ImportResult; tooLarge: TooLarge[] }> {
  // Excalidraw drawings go up as handwriting notes (settings/drawingImport.ts).
  const drawings = convertDrawings(options.files);
  const { batches, tooLarge } = planImportBatches(drawings.files, options.targetBytes);
  let result: ImportResult = { imported: 0, skipped: 0, folders: 0, ...drawings.report };
  for (const [index, files] of batches.entries()) {
    options.onProgress?.({ batch: index + 1, batches: batches.length });
    const hasNotes = files.some(file => !("base64" in file));
    const uploaded = hasNotes && result.image_urls && Object.keys(result.image_urls).length ? { uploaded_images: result.image_urls } : {};
    result = mergeImportResults(result, await options.send({ files, upsert: true, source: options.source, ...uploaded }));
  }
  return { result, tooLarge };
}
