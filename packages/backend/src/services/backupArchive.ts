// The full backup a person downloads themselves (Settings › 你的資料): one zip
// that is both a Markdown vault anyone can open and an archive Onden can
// restore exactly (services/backupRestore.ts).
//
//   <slug>.md, attachments/…   the Markdown export (services/exportZip.ts
//                              writeVault): opens as an Obsidian vault; a
//                              child note is in its parent's folder,
//                              <parent>/<slug>.md (services/vaultPath.ts)
//   .trash/<slug>.md           deleted notes still in History (Obsidian's
//                              own trash folder name)
//   .onden/notes/<id>.json     one per row: the stored body, every attribute
//                              (drawings — ink_data — included), tag ids,
//                              parent, space, timestamps, deleted_at; a tag
//                              definition also carries its colour, schema and
//                              views; a task its line; links and board
//                              positions the Markdown cannot hold
//   .onden/spaces.json         the spaces the person belongs to, with members
//   .onden/extras.json         (format 2) the person's own state and the
//                              workspace's settings, for a workspace move
//                              (services/backupExtras.ts)
//   .onden/manifest.json       format, version, counts (written last)
//   README.txt                 what is in it and what is not, in zh-TW
//
// Vault apps skip dot folders, so the vault looks like a plain export. The
// sidecar keeps the stored body, not the rewritten Markdown file, so a
// restore needs no reverse rewriting: media keep their file names, links
// keep `onden://node/<id>`.
//
// Scope is exactly what the person may read (vaultIndex): every space they
// belong to — the workspace owner gets no more than that — and none of
// another member's personal notes. A delegated token cannot download one.
// Streaming is archiveStream.ts's: a batch of notes in memory at a time.

import { anchorBackupRowsByNote, type AnchorBackupRow } from "./blockAnchors/index.js";
import { bindingBackupRowsByNote, type BindingBackupRow } from "./blockLinks.js";
import { INK_PAGE_ATTRS, TASK_ATTR, isInkPageAttr } from "@onden/markdown";
import type archiver from "archiver";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { q } from "../db.js";
import { STORE } from "../git.js";
import type { ActorCtx } from "../types.js";
import { pacedArchive, type ArchiveSink } from "./archiveStream.js";
import { mediaFiles } from "./mediaFiles.js";
import { withActorReadSnapshot } from "./actorReadSnapshot.js";
import { produceArchive, vaultIndex, writeVault, type VaultNoteData } from "./exportZip.js";
import { localDayId } from "../localDay.js";
import { hasWhiteboardTab } from "./boardStore.js";
import { db } from "../dbKysely.js";
import { sql } from "kysely";
import { PLACEHOLDER_TITLES } from "./history/index.js";
import { isWorkspaceOwner } from "../spine/authority.js";
import { collectExtras } from "./backupExtras.js";
import { BACKUP_VERSION_WITH_HISTORY, historyEntryPath, measureHistory, writeHistoryFile } from "./backupHistory.js";
import type { BackupHistoryInfo, BackupManifest } from "@onden/contract";
import { tagNodeSql } from "../spine/nodeSql.js";
import { isCanvas, isTag } from "@onden/markdown/contract";

/** The archive layout version a restore checks. Bump on an incompatible
 *  change; a restore refuses a newer one. A backup is at this version unless it holds version history, which makes it
 *  BACKUP_VERSION_WITH_HISTORY (backupHistory.ts); this server reads both. */
export const BACKUP_FORMAT = "onden-backup";
export const BACKUP_VERSION = 2;

/** Where the machine-readable half lives. */
export const SIDECAR_DIR = ".onden";
export const NOTE_SIDECAR_DIR = `${SIDECAR_DIR}/notes`;
export const MANIFEST_PATH = `${SIDECAR_DIR}/manifest.json`;
export const SPACES_PATH = `${SIDECAR_DIR}/spaces.json`;
export const EXTRAS_PATH = `${SIDECAR_DIR}/extras.json`;

/** One note as `.onden/notes/<id>.json` holds it. */
export type BackupNote = {
  id: string;
  node_type: string;
  title: string;
  slug: string | null;
  parent_id: string | null;
  space_id: string | null;
  hidden: boolean;
  /** Where it sits among its siblings (a fractional-index key). Backups made before order keys (migration 200) have only `sort_order`. */
  order_key?: string;
  /** The same place as a rank among its siblings in the backup (0, 1, 2…). Still written, so an older server that restores this
   *  archive keeps the order: it does not know `order_key`. A restore here uses the key, and this only when there is none. */
  sort_order?: number;
  source_type: string;
  created_at: string;
  updated_at: string;
  /** Set: deleted (in History) when the backup was made. */
  deleted_at: string | null;
  /** The stored body, frontmatter included, links and media as stored. */
  markdown: string;
  presentation: unknown;
  attributes: Array<{ key: string; value: string; value_type: string; is_inheritable: boolean; source: string }>;
  /** Live tags on it (ids of tag rows in this backup or a workspace's
   *  system tags). */
  tags: string[];
  /** Its file in the vault half, or null (hidden rows, canvases). */
  file: string | null;
  /** Media files it references that are in attachments/. */
  media: string[];
  /** A tag definition (node_type class_tag). */
  tag?: { path: string; color: string | null; schema: unknown; views: unknown; reserved_key: string | null };
  /** A note's saved views of its children (services/noteViews.ts); a tag's
   *  are in `tag.views`. Left out when it has none. */
  views?: unknown[];
  /** A task (hidden, `_task_status`): the `^ref` of the line it was made
   *  from in its host note, or null for one made in Tasks. */
  task?: { line_ref: string | null };
  /** Typed links made by hand from this note (derived ones — wikilinks —
   *  come back from the body). */
  edges?: Array<{ id: string; target_node_id: string; edge_type: string; status: string }>;
  /** Where it sits on boards and canvases. */
  positions?: Array<Record<string, unknown>>;
  /** The note is a review card itself (it holds its own review function reference, migration 195). Left out when it is not, and in
   *  backups made before this field: those carry the review module's tag instead (a restore turns its notes into cards). The
   *  archive version stays 2: a reader that does not know the field ignores it, like `wikilinks`. A paragraph's card is not here —
   *  it comes back from the review word in the note's text. */
  review_card?: true;
  /** Paragraph anchors that were sure of their place (services/blockAnchors). */
  anchors?: Array<{ id: string; from: number; to: number }>;
  /** Which anchor each `[[筆記/段落]]` link written in this note means (services/blockLinks.ts). */
  link_bindings?: BindingBackupRow[];
  /** Where its `[[links]]` pointed (ids of notes in this backup), as the source
   *  kept them (format 2; services/backupLinks.ts). Absent in older backups. */
  wikilinks?: string[];
};

export type BackupSpace = {
  id: string;
  name: string;
  kind: string;
  is_default: boolean;
  capabilities: Record<string, boolean>;
  /** The backer-up's permission there (view | edit). */
  permission: string;
  members: Array<{ id: string; name: string; permission: string }>;
};

/** A backup of part of what the caller may read: the notes that pass every given test, with their ancestors (so the
 *  hierarchy comes back), the tags applied to them, and their attachments. The same format as a full backup; a restore
 *  does not tell them apart (services/backupRestore.ts). */
export type BackupSelection = {
  /** Notes someone wrote: a title of their own, text or a drawing (an attachment is in a note's text); not the blank note a new
   *  workspace starts with, whose title is the placeholder (history/activity.ts PLACEHOLDER_TITLES). */
  written?: boolean;
  /** Notes saved at or after this instant (an ISO time). Ask with the clock's reading from just BEFORE the previous backup
   *  was requested: a note saved while that backup was being made is then in the next one too (a note twice is harmless,
   *  a restore skips what it already has; a note missed would be lost). */
  changedSince?: string;
  /** Only these notes (by id). */
  noteIds?: string[];
};

/** How a backup is made beyond which notes: `history` adds every note's version history (format 3, backupHistory.ts). */
export type BackupOptions = { history?: boolean };

/** `onden-backup-YYYYMMDD.zip`, the day in the server's time zone. */
export function backupFileName(at: Date = new Date()): string {
  return `onden-backup-${localDayId(at).replaceAll("-", "")}.zip`;
}

const README = `這是 Onden 的完整備份。

可以直接當成 Markdown 資料夾打開（例如 Obsidian）：每則筆記是一個 .md 檔，
附件在 attachments/，已刪除但還能從「歷史」找回的筆記在 .trash/。

.onden/ 資料夾是給 Onden 還原用的完整資料：每則筆記的原始內文、所有屬性
（包括手寫與繪圖）、標籤與標籤的欄位設定、上下層關係、建立與修改時間、
看板位置與手動連結，以及你所在的空間和成員。.onden/manifest.json 記錄版本與數量。
在 Onden 的「設定 › 你的資料 › 從備份還原」上傳這個檔案即可還原。

包含：你能讀取的所有筆記（你所在的每個空間）、它們的附件與繪圖、標籤定義、
已刪除但未永久刪除的筆記。
不包含：其他成員的私人筆記與你不在的空間、
版本歷史與操作紀錄、帳號、權杖、AI 金鑰與裝置設定。
.onden/extras.json 另外記著你的複習進度、專注紀錄、RSS 訂閱、個人設定與網站發布；
只有「搬到新的工作區」會用到它，一般還原不讀。
`;

/** The README of a backup that holds version history: the same text, with the history line corrected (a backup without
 *  it keeps README byte for byte). */
const README_WITH_HISTORY = README.replace("版本歷史與操作紀錄、帳號", "操作紀錄、帳號") + `.onden/history/ 是每則筆記每個版本的內文與時間；
只有「搬到新的工作區」會把它帶回去，一般還原不讀。
`;

/** One entry of the archive, decided while reading the database and written after it. A text entry waits in a file of
 *  the backup's scratch folder, not in memory. */
type ArchiveFile = { kind: "text"; name: string; path: string } | { kind: "history"; name: string; path: string } | { kind: "media"; mediaName: string; name: string };

/** Where a backup in progress keeps its entries until they are written to the zip: a folder per backup under the same
 *  store as uploaded backups (backupFile.ts), so every host has it (the server's disk, the desktop app's, the browser
 *  app's file system). Not `os.tmpdir()`: the browser app has no `node:os`. */
const SCRATCH_DIR = join(STORE, "backup-scratch");
/** A backup that is older than this left its folder behind (a crash); a running one is never this old. */
const SCRATCH_TTL_MS = 6 * 60 * 60 * 1000;

/** Drop the scratch folders a crash left: every one at boot (`everything`: no backup is running), those older than the
 *  TTL before a new backup. */
async function sweepScratch(everything: boolean): Promise<void> {
  let names: string[];
  try { names = await readdir(SCRATCH_DIR); } catch { return; }
  for (const name of names) {
    const info = await stat(join(SCRATCH_DIR, name)).catch(() => null);
    if (info && (everything || Date.now() - info.mtimeMs > SCRATCH_TTL_MS)) await rm(join(SCRATCH_DIR, name), { recursive: true, force: true });
  }
}

/** Boot: no backup is running, so every scratch folder is a leftover (backupRestoreJobs.ts). */
export function sweepBackupScratchAtBoot(): Promise<void> {
  return sweepScratch(true);
}

/** Ids per `= ANY(...)` read: a workspace of ten thousands of notes stays a handful of statements, not one parameter list
 *  of every id. */
const ID_CHUNK = 5000;
/** An id no note has: `in ()` of no ids is not valid SQL, and "only these notes" with none named is no note. */
const NO_NOTE_ID = "00000000-0000-0000-0000-000000000000";

/** `read` for each chunk of `ids`, its rows grouped by the note id they name (in the order `read` returns them). */
async function groupedByNote<T extends { node_id: string }>(ids: string[], read: (chunk: string[]) => Promise<T[]>): Promise<Map<string, Array<Omit<T, "node_id">>>> {
  const byNote = new Map<string, Array<Omit<T, "node_id">>>();
  for (let at = 0; at < ids.length; at += ID_CHUNK) {
    for (const { node_id, ...row } of await read(ids.slice(at, at + ID_CHUNK))) {
      const list = byNote.get(node_id);
      if (list) list.push(row); else byNote.set(node_id, [row]);
    }
  }
  return byNote;
}

type BackupEdge = { id: string; target_node_id: string; edge_type: string; status: string };

/** What every note's sidecar holds beyond the note row, one statement per kind (per chunk of ids), not per note. */
async function readSidecarRows(workspaceId: string, ids: string[]) {
  const edges = await groupedByNote(ids, async (chunk) => (await q<{ node_id: string } & BackupEdge>(
    `SELECT source_node_id::text AS node_id, id::text, target_node_id::text, edge_type, status FROM node_edges
      WHERE workspace_id = $1 AND source_node_id = ANY($2::uuid[]) AND origin = 'manual' ORDER BY source_node_id, created_at, id`, [workspaceId, chunk],
  )).rows);
  const positions = await groupedByNote(ids, async (chunk) => (await q<{ node_id: string } & Record<string, unknown>>(
    `SELECT node_id::text, surface, x, y, width, height, color, folded, sub_canvas_id::text FROM node_positions
      WHERE workspace_id = $1 AND node_id = ANY($2::uuid[]) ORDER BY node_id, surface`, [workspaceId, chunk],
  )).rows);
  const wikilinks = new Map<string, string[]>();
  for (let at = 0; at < ids.length; at += ID_CHUNK) {
    for (const e of await db.selectFrom("node_edges").select(["source_node_id", "target_node_id"])
      .where("workspace_id", "=", workspaceId).where("source_node_id", "in", ids.slice(at, at + ID_CHUNK)).where("origin", "=", "wikilink")
      .orderBy("source_node_id").orderBy("created_at").orderBy("id").execute()) {
      const list = wikilinks.get(e.source_node_id);
      if (list) list.push(e.target_node_id); else wikilinks.set(e.source_node_id, [e.target_node_id]);
    }
  }
  const anchors = new Map<string, AnchorBackupRow[]>();
  const bindings = new Map<string, BindingBackupRow[]>();
  for (let at = 0; at < ids.length; at += ID_CHUNK) {
    const chunk = ids.slice(at, at + ID_CHUNK);
    for (const [id, rows] of await anchorBackupRowsByNote(workspaceId, chunk)) anchors.set(id, rows);
    for (const [id, rows] of await bindingBackupRowsByNote(workspaceId, chunk)) bindings.set(id, rows);
  }
  const reviewCards = new Set<string>();
  for (let at = 0; at < ids.length; at += ID_CHUNK) {
    for (const r of await db.selectFrom("function_refs").select("holder_node_id").where("workspace_id", "=", workspaceId)
      .where("function_id", "=", "review").where("instance", "=", "").where("holder_node_id", "in", ids.slice(at, at + ID_CHUNK)).execute()) {
      if (r.holder_node_id) reviewCards.add(r.holder_node_id);
    }
  }
  return { edges, positions, wikilinks, anchors, bindings, reviewCards };
}

/** The full backup of what `actor` may read. Returns the archive, still
 *  being written — the caller streams it. A delegated token is refused by
 *  the route, not here.
 *
 *  Every database read happens in ONE read-only REPEATABLE READ snapshot
 *  (withActorReadSnapshot, which also reads the actor's authority again): the
 *  notes, tags, links, anchors, board positions, spaces and extras are all
 *  the state of one moment, so an edit made while the backup runs cannot give a
 *  tag, an anchor or a link that the note rows do not agree with. The snapshot
 *  yields the archive's entries (file names and contents, media by name); only
 *  then is the connection released and the zip written. Streaming a response
 *  to a slow download must not hold a transaction (and a pooled connection) open
 *  for minutes, and compression and media reads are not database work.
 *
 *  The price: the entries wait on disk, in a scratch folder under the store (SCRATCH_DIR) of about
 *  twice the notes' text (the Markdown file and the sidecar each hold the
 *  body), removed when the download ends or fails. They are not kept in memory:
 *  the backup stays streamed with bounded memory (one note at a time while
 *  reading, one entry at a time while writing), which a VPS with little RAM
 *  needs (backupDownload.integration.test.ts). Media bytes are never copied:
 *  only their names are kept. */
export async function buildFullBackup(actor: ActorCtx, workspaceId: string, selection?: BackupSelection, options: BackupOptions = {}): Promise<archiver.Archiver> {
  await mkdir(SCRATCH_DIR, { recursive: true });
  await sweepScratch(false);
  const scratch = join(SCRATCH_DIR, randomUUID());
  await mkdir(scratch);
  let files: ArchiveFile[];
  try {
    files = await withActorReadSnapshot(actor, workspaceId, (current) => readBackupFiles(current, workspaceId, scratch, selection, options));
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
  const out = pacedArchive();
  // A history file is streamed from the scratch folder as the zip takes it, which can be after the last entry was queued:
  // the folder goes when the archive is done being read (or failed), not when the last entry is queued.
  // `on`, not `once`: the browser app's archiver (browser-shims/archiver.mjs) has only `on`.
  let dropped = false;
  const dropScratch = () => { if (!dropped) { dropped = true; void rm(scratch, { recursive: true, force: true }); } };
  out.archive.on("close", dropScratch);
  out.archive.on("error", dropScratch);
  produceArchive(out, "full backup", async () => {
    try {
      for (const file of files) {
        if (file.kind === "history") await out.addFile(file.name, file.path);
        else if (file.kind === "text") await out.addText(file.name, await readFile(file.path, "utf8"));
        else await out.addMedia(file.mediaName, file.name);
      }
    } catch (error) {
      dropScratch();
      throw error;
    }
  });
  return out.archive;
}

/** How many bytes a full backup of `actor`'s readable notes would be, before the zip compresses text (attachments are
 *  stored nearly as they are): what the page compares with the restore limit before it is downloaded. Version
 *  history is not counted (backupHistorySize says how much it adds). Reads inside a snapshot like the backup itself
 *  and leaves nothing behind. */
export async function measureFullBackup(actor: ActorCtx, workspaceId: string): Promise<{ bytes: number }> {
  await mkdir(SCRATCH_DIR, { recursive: true });
  const scratch = join(SCRATCH_DIR, randomUUID());
  await mkdir(scratch);
  try {
    const files = await withActorReadSnapshot(actor, workspaceId, (current) => readBackupFiles(current, workspaceId, scratch));
    let bytes = 0;
    for (const file of files) {
      bytes += file.kind === "media" ? (await mediaFiles().info(file.mediaName))?.size ?? 0 : (await stat(file.path)).size;
    }
    return { bytes };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** How much version history a backup of everything `actor` may read would add (shown before they choose it). */
export async function backupHistorySize(actor: ActorCtx, workspaceId: string): Promise<BackupHistoryInfo> {
  return withActorReadSnapshot(actor, workspaceId, async (current) => measureHistory(workspaceId, (await vaultIndex(current, workspaceId, "backup")).map((n) => n.id)));
}

/** Every entry of the backup of `actor`, in archive order. Reads the database only, and only inside a read snapshot
 *  (buildFullBackup): `q()` is the snapshot's connection. */
async function readBackupFiles(actor: ActorCtx, workspaceId: string, scratch: string, selection?: BackupSelection, options: BackupOptions = {}): Promise<ArchiveFile[]> {
  const files: ArchiveFile[] = [];
  const out: ArchiveSink = {
    addText: async (name, text) => {
      const path = join(scratch, String(files.length));
      await writeFile(path, text);
      files.push({ kind: "text", name, path });
    },
    addMedia: async (mediaName, name) => { files.push({ kind: "media", mediaName, name }); },
  };
  const everything = await vaultIndex(actor, workspaceId, "backup");
  const index = selection ? await selectedIndex(everything, workspaceId, selection) : everything;
  const ids = index.map((n) => n.id);
  const inBackup = new Set(ids);
  const lineRefs = new Map((await q<{ task_id: string; block_ref: string }>(
    `SELECT task_id::text, block_ref FROM block_nodes WHERE workspace_id = $1 AND task_id IS NOT NULL`, [workspaceId],
  )).rows.map((r) => [r.task_id, r.block_ref]));
  const side = await readSidecarRows(workspaceId, ids);
  // Each note's rank among its siblings in this backup, in the order the app shows them (the key, then its stamp, then id).
  const siblingRank = new Map((await sql<{ id: string; rank: number }>`
    SELECT id::text, (row_number() OVER (PARTITION BY parent_id ORDER BY order_key COLLATE "C", order_stamp COLLATE "C", id) - 1)::int AS rank
      FROM content_nodes WHERE workspace_id = ${workspaceId} AND id = ANY(${ids}::uuid[])`.execute(db)).rows.map((r) => [r.id, r.rank]));
  const indexById = new Map(index.map((n) => [n.id, n]));
  const counts: BackupManifest["counts"] = { notes: 0, deleted_notes: 0, tags: 0, tasks: 0, canvases: 0, drawings: 0, attachments: 0, spaces: 0 };
  const tagPaths = new Map<string, string>();

  const note = async ({ note: n, attributes, tagIds, file, media }: VaultNoteData) => {
    const isTask = n.hidden && attributes.some((a) => a.key === TASK_ATTR.status);
    const sidecar: BackupNote = {
      id: n.id, node_type: n.node_type, title: n.title, slug: n.slug, parent_id: n.parent_id,
      space_id: n.space_id, hidden: n.hidden, order_key: n.order_key, sort_order: siblingRank.get(n.id) ?? 0, source_type: n.source_type,
      created_at: n.created_at, updated_at: n.updated_at, deleted_at: n.deleted_at,
      markdown: n.markdown, presentation: n.presentation ?? null,
      attributes: attributes.map((a) => ({ key: a.key, value: a.value, value_type: a.value_type, is_inheritable: a.is_inheritable, source: a.source })),
      tags: tagIds, file, media,
    };
    if (isTag(n)) {
      const path = await tagPath(n.id, n.title, n.parent_id);
      sidecar.tag = { path, color: n.tag_color, schema: n.tag_schema ?? null, views: n.collection_views ?? null, reserved_key: n.reserved_key };
    } else if (Array.isArray(n.collection_views) && n.collection_views.length > 0) sidecar.views = n.collection_views;
    if (isTask) sidecar.task = { line_ref: lineRefs.get(n.id) ?? null };
    const edges = (side.edges.get(n.id) ?? []).filter((e) => inBackup.has(e.target_node_id));
    if (edges.length) sidecar.edges = edges;
    // Only on boards and canvases in the backup (and the global graph): a
    // card on a canvas of a space the person is not in would name that canvas.
    const positions = (side.positions.get(n.id) ?? []).filter((p) => p.surface === "graph" || inBackup.has(String(p.surface)))
      .map((p) => (typeof p.sub_canvas_id === "string" && !inBackup.has(p.sub_canvas_id) ? { ...p, sub_canvas_id: null } : p));
    if (positions.length) sidecar.positions = positions;
    sidecar.wikilinks = (side.wikilinks.get(n.id) ?? []).filter((id) => inBackup.has(id));
    const anchors = side.anchors.get(n.id) ?? [];
    if (anchors.length) sidecar.anchors = anchors;
    const bindings = side.bindings.get(n.id) ?? [];
    if (bindings.length) sidecar.link_bindings = bindings;
    if (side.reviewCards.has(n.id)) sidecar.review_card = true;
    await out.addText(`${NOTE_SIDECAR_DIR}/${n.id}.json`, JSON.stringify(sidecar));

    if (isTag(n)) counts.tags++;
    else if (isCanvas(n) || hasWhiteboardTab(n.collection_views)) counts.canvases++;
    else if (isTask) counts.tasks++;
    else if (n.deleted_at) counts.deleted_notes++;
    else counts.notes++;
    // A page with only text boxes or pictures on it is a drawing for the count too.
    if (attributes.some((a) => (isInkPageAttr(a.key) || a.key === "page_text" || a.key === "page_images") && a.value)) counts.drawings++;
  };
  // A tag's full path from its own row up. The tags of the backup are in the
  // index; only a parent outside the read set (in theory: tag definitions are
  // readable by every member) is looked up.
  async function tagPath(id: string, title: string, parentId: string | null): Promise<string> {
    const cached = tagPaths.get(id);
    if (cached !== undefined) return cached;
    let path = title;
    if (parentId) {
      const known = indexById.get(parentId);
      const parent = isTag(known) ? { title: known.title, parent_id: known.parent_id }
        : known ? undefined
        : (await q<{ title: string; parent_id: string | null }>(
          `SELECT title, parent_id::text FROM content_nodes WHERE id = $1 AND ${tagNodeSql()}`, [parentId])).rows[0];
      if (parent) path = `${await tagPath(parentId, parent.title, parent.parent_id)}/${title}`;
    }
    tagPaths.set(id, path);
    return path;
  }

  const stats = await writeVault(out, actor, workspaceId, index, { note });
  counts.attachments = stats.attachments;

  // Version history: one file per note that has versions, written to the scratch folder a page at a time.
  const history: BackupHistoryInfo = { notes: 0, versions: 0, bytes: 0 };
  if (options.history) {
    for (const id of ids) {
      const path = join(scratch, `history-${id}`);
      const written = await writeHistoryFile(workspaceId, id, path);
      if (written.versions === 0) { await rm(path, { force: true }); continue; }
      files.push({ kind: "history", name: historyEntryPath(id), path });
      history.notes++; history.versions += written.versions; history.bytes += written.bytes;
    }
  }

  const spaces = await backupSpaces(actor, workspaceId);
  counts.spaces = spaces.length;
  await out.addText(SPACES_PATH, JSON.stringify(spaces, null, 2));
  await out.addText(EXTRAS_PATH, JSON.stringify(await collectExtras(workspaceId, actor.id, await isWorkspaceOwner(actor), inBackup, spaces.map((sp) => sp.id))));
  await out.addText("README.txt", history.versions > 0 ? README_WITH_HISTORY : README);
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT, version: history.versions > 0 ? BACKUP_VERSION_WITH_HISTORY : BACKUP_VERSION, created_at: new Date().toISOString(),
    workspace_id: workspaceId, created_by: { id: actor.id, name: actor.name }, counts,
    ...(history.versions > 0 ? { history } : {}),
  };
  await out.addText(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  return files;
}

/** The part of `index` a partial backup holds (BackupSelection). `index` is what the caller may read, so a selection never
 *  reaches past it. Ancestors of a chosen note come along even when blank; tags only when applied to a chosen note
 *  (and the tags above them). */
async function selectedIndex(index: Awaited<ReturnType<typeof vaultIndex>>, workspaceId: string, selection: BackupSelection): Promise<typeof index> {
  const readable = index.filter((n) => !isTag(n) && !n.deleted).map((n) => n.id);
  const chosen = new Set<string>();
  const drawingKeys = [...INK_PAGE_ATTRS, "page_text", "page_images"];
  for (let at = 0; at < readable.length; at += ID_CHUNK) {
    const rows = await db.selectFrom("content_nodes as cn").select("cn.id")
      .where("cn.workspace_id", "=", workspaceId).where("cn.id", "in", readable.slice(at, at + ID_CHUNK))
      .$if(!!selection.written, (qb) => qb.where((eb) => eb.or([
        eb.and([sql<boolean>`btrim(${eb.ref("cn.title")}) <> ''`, eb("cn.title", "not in", PLACEHOLDER_TITLES)]),
        sql<boolean>`btrim(coalesce(${eb.ref("cn.markdown")}, '')) <> ''`,
        eb.exists(eb.selectFrom("node_attributes as a").select("a.node_id").whereRef("a.node_id", "=", "cn.id").where("a.key", "in", drawingKeys).where("a.value", "<>", "")),
      ])))
      .$if(!!selection.changedSince, (qb) => qb.where("cn.updated_at", ">=", new Date(selection.changedSince!)))
      .$if(!!selection.noteIds, (qb) => qb.where("cn.id", "in", selection.noteIds!.length ? selection.noteIds! : [NO_NOTE_ID]))
      .execute();
    for (const row of rows) chosen.add(row.id);
  }
  const byId = new Map(index.map((n) => [n.id, n]));
  const kept = new Set<string>();
  const keepWithAncestors = (id: string | null) => {
    for (let at = id; at && !kept.has(at); at = byId.get(at)?.parent_id ?? null) { if (byId.has(at)) kept.add(at); }
  };
  for (const id of chosen) keepWithAncestors(id);
  const tagged: string[] = [];
  const chosenIds = [...chosen];
  for (let at = 0; at < chosenIds.length; at += ID_CHUNK) {
    for (const row of await db.selectFrom("node_tags").select("tag_id").distinct().where("node_id", "in", chosenIds.slice(at, at + ID_CHUNK)).execute()) tagged.push(row.tag_id);
  }
  for (const id of tagged) keepWithAncestors(id);
  return index.filter((n) => kept.has(n.id));
}

/** The spaces `actor` belongs to (as the Spaces page lists them), each with
 *  the members any member may see. */
async function backupSpaces(actor: ActorCtx, workspaceId: string): Promise<BackupSpace[]> {
  const spaces = (await q<Omit<BackupSpace, "members">>(
    `SELECT s.id::text, s.name, s.kind, s.is_default, s.capabilities, m.permission
       FROM spaces s JOIN space_members m ON m.space_id = s.id AND m.actor_id::text = $2
      WHERE s.workspace_id = $1 AND s.deleted_at IS NULL
      ORDER BY (s.kind = 'personal') DESC, s.is_default DESC, s.name, s.id`, [workspaceId, actor.id],
  )).rows;
  const result: BackupSpace[] = [];
  for (const space of spaces) {
    const members = (await q<{ id: string; name: string; permission: string }>(
      `SELECT a.id::text, a.name, m.permission FROM space_members m JOIN actors a ON a.id = m.actor_id
        WHERE m.space_id = $1 AND a.type <> 'session' ORDER BY a.name, a.id`, [space.id],
    )).rows;
    result.push({ ...space, members });
  }
  return result;
}
