// A folder import (POST /api/import/obsidian, depth audit D13, moved verbatim
// from modules/importers/routes.ts): images first, then CSV/Notion databases, folders,
// and the loose Markdown notes, each committing on its own. Answers the
// counts the import dialog shows; every skipped note is listed with why.

import { extname } from "node:path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { getWorkspaceId, withBulkWrites } from "../../../db.js";
import { requireActor } from "../../../spine/mutate.js";
import { assertAuthority } from "../../../spine/authority.js";
import type { ActorCtx } from "../../../types.js";
import { importMarkdownNote, type ImportConflictReason } from "../markdown/note.js";
import { importPath } from "../shared/imageLinks.js";
import { importObsidianFolders } from "./folders.js";
import { findImportedNotes } from "../shared/identity.js";
import { folderNoteFile, parentFolderOf } from "../../../services/vaultPath.js";
import { prepareImportedImages, isImportedMediaPath } from "../shared/images.js";
import { resolveImportedRelations } from "../shared/relations.js";
import { importNotionDatabases } from "../notion/database.js";
import { isImportRefusal } from "../../../services/importRefusal.js";
import { importTaskLists } from "../markdown/taskLists.js";
import { NODE_TITLE_MAX, checklistLine, fenceScanner } from "@onden/markdown";

function isMarkdownPath(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

/** A drawing file's handwriting page and original (modules/importers/markdown/note.ts). */
function importedDrawing(file: object) {
  if (!("kind" in file) || file.kind !== "drawing") return undefined;
  const d = file as unknown as { title: string; ink_data: string };
  return { title: d.title, inkData: d.ink_data };
}

/** Checkbox lines (`- [ ] …`, outside code) of a note that are not Onden tasks, which carry a
 *  `{task}` mark: they import as plain checkboxes. Of those, how many hold an Obsidian Tasks date
 *  (📅 ⏳ 🛫 ✅), which stays in the text. The import report says so instead of leaving it unsaid. */
export function plainCheckboxLines(markdown: string): { plain: number; dated: number } {
  let plain = 0, dated = 0;
  const fence = fenceScanner({ container: true });
  for (const line of markdown.split("\n")) {
    if (fence(line) !== "outside" || !checklistLine(line) || line.includes("{task}")) continue;
    plain++;
    if (/[📅⏳🛫✅]\s*\d{4}-\d{2}-\d{2}/u.test(line)) dated++;
  }
  return { plain, dated };
}

function isCsvPath(path: string): boolean {
  return path.toLowerCase().endsWith(".csv");
}

/** One import request (the body modules/importers/routes.ts parses). */
const sourceSchema = z.object({ id:z.union([z.uuid(),z.literal("legacy")]),name:z.string().trim().min(1).max(200) });
export const obsidianImportSchema = z.object({
  files:z.array(z.union([
    // An Excalidraw drawing converted in the browser (settings/drawingImport.ts):
    // its body, title and handwriting page. The original file is not kept; an
    // older client may still send it as drawing_source, which is ignored.
    z.object({ path:z.string(),content:z.string(),kind:z.literal("drawing"),title:z.string().min(1).max(NODE_TITLE_MAX),
      ink_data:z.string().min(1),drawing_source:z.string().optional() }),
    z.object({ path:z.string(),content:z.string(),kind:z.literal("markdown").optional() }),
    // A media file (any kind on the media table): its bytes. `kind` is a
    // hint only — the extension decides (importedImageLinks.isImportedMediaPath).
    z.object({ path:z.string(),base64:z.string(),kind:z.enum(["image","pdf","media"]).optional() }),
  ])).min(1),
  source:sourceSchema.optional(),upsert:z.boolean().default(false),
  // Earlier batches' `image_urls` (modules/importers/shared/images.ts), when one folder
  // import is sent as several requests.
  uploaded_images:z.record(z.string(),z.string().nullable()).refine(map => Object.keys(map).length <= 10_000).optional(),
}).superRefine((input,ctx) => {
  if (input.upsert && !input.source) ctx.addIssue({code:"custom",path:["source"],message:"Choose an import source before updating notes"});
  const paths = new Set<string>();
  input.files.forEach((file,index) => {
    const path = importPath(file.path);
    if (!path || paths.has(path)) ctx.addIssue({code:"custom",path:["files",index,"path"],message:"Invalid or duplicate import path"});
    if (path) paths.add(path);
  });
});

export type ObsidianImportRequest = z.infer<typeof obsidianImportSchema>;

/** Import a batch of vault files for `authenticated`. `readInput` reads and
 *  validates the request body; it runs only after the write check, so a
 *  viewer is refused before anything is parsed or written to disk. */
export function importObsidian(authenticated: ActorCtx | null, readInput: () => Promise<ObsidianImportRequest>) {
  // An import makes every file a note, one transaction after another (db.ts withBulkWrites).
  return withBulkWrites(() => importFiles(authenticated, readInput));
}

async function importFiles(authenticated: ActorCtx | null, readInput: () => Promise<ObsidianImportRequest>) {
  // Authority FIRST — before any DB work, body parse, or the Phase-1 image loop
  // that writes attacker-controlled bytes to MEDIA_DIR. A read-only viewer (who
  // can't create nodes) must be rejected before ANYTHING lands on disk. Throws
  // UnauthorizedError → 401 / AuthorityError → 403 (httpError.ts).
  const actor = requireActor(authenticated);
  await assertAuthority(actor, { kind: "any_space_write" });
  const workspaceId = await getWorkspaceId();
  const input = await readInput();
  const { upsert } = input;
  const source = input.source ?? { id:randomUUID(),name:"Imported files" };
  const files = input.files.map(file => ({...file,path:importPath(file.path)!}));

  const media = await prepareImportedImages({ actor, workspaceId,
    files: files.filter(file => "base64" in file || isImportedMediaPath(file.path)),
    uploaded: input.uploaded_images,
  });

  // ── Unsupported files: count + remember extensions ────────────────────────
  // Markdown, media (images, PDFs, audio, video, documents) and CSV are
  // handled below; everything else (.enex, …) has no import story yet.
  // Rather than drop it silently, surface a count + the distinct extensions
  // so the user knows what wasn't ingested.
  let unsupportedFiles = 0;
  const unsupportedExts = new Set<string>();
  for (const file of files) {
    const isMedia = "base64" in file || isImportedMediaPath(file.path);
    if (isMedia || isMarkdownPath(file.path) || isCsvPath(file.path)) continue;
    unsupportedFiles++;
    const ext = extname(file.path).toLowerCase();
    if (ext) unsupportedExts.add(ext);
  }

  // ── Phase 2: markdown notes ───────────────────────────────────────────────
  const mdFiles = files.filter((f) => "content" in f && isMarkdownPath(f.path)) as Array<{ path: string; content: string }>;

  // Each Markdown note commits independently. Known conflicts are reported;
  // unknown storage errors stop this request without undoing earlier commits.

  // ── Phase 2.5: deep CSV/Notion database import ────────────────────────────
  // A CSV is a *database*, not a pile of notes. A CSV table becomes a real Onden collection: a typed schema (column→field
  // type inferred), a table + kanban + calendar view, and one collection item
  // per row — landing in the already-mounted CollectionView. Each row's Notion
  // page body (`<Title> <hash>.md`) is attached to its item, and those md files
  // are then EXCLUDED from the loose-note import below so a page doesn't land
  // twice. Runs before the md loop precisely so we know which md files were
  // consumed as page bodies. (The old one-node-per-row CSV path, which wrote
  // attributes around setNodeAttribute, is gone: nothing asked for it.)
  const csvFilesAll = files.filter((f) => "content" in f && isCsvPath(f.path)) as Array<{ path: string; content: string }>;
  const mdFilesAll = files.filter((f) => "content" in f && isMarkdownPath(f.path)) as Array<{ path: string; content: string }>;
  let databasesSkipped: string[] = [], deepCollections = 0, deepRows = 0, deepRowsSkipped = 0, deepBodies = 0;
  let deepBodiesSkipped: Array<{ path: string; reason: "too_large" }> = [];
  // Titles cut to the note cap (services/noteSize.ts): a note's file name or
  // frontmatter title (path), a database row's title cell (path + row).
  const titlesTruncated: Array<{ path: string; row?: number }> = [];
  let consumedMdPaths = new Set<string>();
  let ambiguousDateColumns: Array<{ path: string; column: string }> = [];
  if (csvFilesAll.length > 0) {
    try {
      const deep = await importNotionDatabases(
        workspaceId, csvFilesAll, mdFilesAll, actor,
        (body, path) => media.rewrite(body, path),
      );
      deepCollections = deep.collections;
      deepRows = deep.rows;
      deepRowsSkipped = deep.rowsSkipped;
      databasesSkipped = deep.databasesSkipped;
      deepBodies = deep.bodiesAttached;
      deepBodiesSkipped = deep.bodiesSkipped;
      titlesTruncated.push(...deep.titlesTruncated);
      ambiguousDateColumns = deep.ambiguousDateColumns;
      consumedMdPaths = deep.consumedMdPaths;
    } catch (error) {
      // A refused deep import (permission, scope, name collision) leaves its
      // page bodies to the loose-note import below. Anything else is a real
      // failure and stops the request instead of hiding behind a fallback.
      if (!isImportRefusal(error)) throw error;
    }
  }

  // An Onden export's standalone task list (and the note files it links to)
  // becomes tasks, not notes (modules/importers/markdown/taskLists.ts).
  const taskLists = await importTaskLists({ actor, workspaceId, source, reuse: upsert,
    files: mdFiles.filter(file => !consumedMdPaths.has(file.path)), rewrite: (content, path) => media.rewrite(content, path) });
  for (const path of taskLists.consumed) consumedMdPaths.add(path);
  const looseMarkdown = mdFiles.filter(file => !consumedMdPaths.has(file.path));
  const folderPaths = looseMarkdown.flatMap(file => parentFolderOf(file.path) ?? []);

  // Every skipped note is listed in `conflicts` with its reason, so
  // skipped === conflicts.length; nothing is dropped without saying why.
  let imported = 0, skipped = 0, updated = 0, unchanged = 0;
  const conflicts: Array<{ path: string; reason: ImportConflictReason | "folder_unavailable" | "database_unavailable" }> = [];
  // A database row's page body over the cap: the row is in, its body is not.
  for (const body of deepBodiesSkipped) { skipped++; conflicts.push(body); }
  // A database that was not made (its name is taken, or it is not allowed): its CSV is listed, not dropped quietly.
  for (const path of databasesSkipped) { skipped++; conflicts.push({ path, reason: "database_unavailable" }); }
  for (const conflict of taskLists.conflicts) { skipped++; conflicts.push(conflict); }
  titlesTruncated.push(...taskLists.titlesTruncated);
  const written: Array<{ path: string; nodeId: string; content: string }> = [];
  const importFile = async (file: (typeof looseMarkdown)[number], parentId: string | null) => {
    const content = media.rewrite(file.content,file.path);
    const result = await importMarkdownNote({ actor,workspaceId,source,reuse:upsert,parentId,
      file: { path:file.path,content,drawing:importedDrawing(file) } });
    if (result.status === "refused") { skipped++; conflicts.push({ path:file.path,reason:result.reason }); }
    else if (result.status === "unchanged") unchanged++;
    else {
      if (result.status === "imported") imported++; else updated++;
      written.push({ path:file.path,nodeId:result.nodeId,content });
    }
    if (result.status !== "refused" && result.titleTruncated) titlesTruncated.push({ path:file.path });
    return result;
  };

  // A folder with a same-name note beside it (`課程/` + `課程.md`, how the
  // zip export writes a parent note: services/vaultPath.ts) is that note.
  const byPath = new Map(looseMarkdown.map(file => [file.path, file]));
  const asFolders = new Set<string>();
  const folders = await importObsidianFolders({ actor, workspaceId, paths: folderPaths, reuse: upsert, source,
    folderNote: async (folder, parentId) => {
      const file = byPath.get(folderNoteFile(folder));
      if (!file) return null;
      asFolders.add(file.path);
      const result = await importFile(file, parentId);
      if (result.status !== "refused") return result.nodeId;
      // Refused (local changes, too large…): the note an earlier import of
      // this file made is still the folder; with none, a plain folder holds
      // the children (the refusal is listed).
      if (!upsert) return null;
      const earlier = await findImportedNotes(workspaceId, source, file.path);
      return earlier.length === 1 && !earlier[0]!.deleted_at ? earlier[0]!.id : null;
    },
  });

  for (const file of looseMarkdown) {
    if (asFolders.has(file.path)) continue;
    const folderPath = parentFolderOf(file.path);
    const parentId = folderPath ? folders.ids.get(folderPath) : null;
    // The folder (or one above it) could not be created or reused; the note is
    // never moved to the root instead (modules/importers/obsidian/folders.ts).
    if (folderPath && !parentId) { skipped++; conflicts.push({ path:file.path,reason:"folder_unavailable" }); continue; }
    await importFile(file, parentId ?? null);
  }
  // Relation links ([[Title]] in an Onden export) resolve once every note of
  // this request exists, so a link to a note later in the folder is found.
  const checkboxes = { plain: 0, dated: 0 };
  for (const { content } of written) {
    const found = plainCheckboxLines(content);
    checkboxes.plain += found.plain;
    checkboxes.dated += found.dated;
  }
  const relations = await resolveImportedRelations({ actor,workspaceId,notes:written });

  return {
    source,
    conflicts,
    imported,
    updated,
    unchanged: unchanged + taskLists.unchanged,
    // Standalone tasks an Onden task list (任務/任務.md) came back as.
    tasks_imported: taskLists.imported,
    skipped,
    titles_truncated: titlesTruncated,
    // Tasks that came in without a field that failed the task rules (path + field names).
    task_fields_dropped: taskLists.fieldsDropped,
    ambiguous_date_columns: ambiguousDateColumns,
    folders: folders.created,
    folders_reused: folders.reused,
    folders_skipped: folders.skipped,
    images_imported: media.imported,
    // Of the files above, how many were PDFs (linked from ![[x.pdf]]).
    pdfs_imported: media.pdfs,
    images_reused: media.reused,
    image_refs_unresolved: media.unresolvedReferences,
    images_skipped: media.skippedFiles.length,
    // Relation fields of an Onden export, resolved back to notes (or kept
    // as their [[Title]] text: listed with their file and key).
    relations_resolved: relations.resolved,
    relations_unresolved: relations.unresolved.length,
    unresolved_relations: relations.unresolved,
    skipped_images: media.skippedFiles,
    // Pass back as `uploaded_images` in the next batch of the same import.
    image_urls: media.urls,
    // Deep CSV/Notion database import (Phase 2.5).
    collections_imported: deepCollections,
    collection_rows_imported: deepRows,
    collection_rows_skipped: deepRowsSkipped,
    collection_bodies_attached: deepBodies,
    unsupported_files: unsupportedFiles,
    // Checkbox lines that came in as plain checkboxes, not Onden tasks (and how many of them hold a 📅-style date).
    checkboxes_not_tasks: checkboxes.plain,
    checkboxes_with_dates: checkboxes.dated,
    unsupported_exts: [...unsupportedExts].sort(),
  };
}
