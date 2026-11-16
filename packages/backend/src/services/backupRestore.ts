// Restoring a backup a person made themselves (services/backupArchive.ts)
// into one space: first a preview, then the restore. Settings › 你的資料 ›
// 從備份還原; routes/backup.ts.
//
// Three modes (the third, "workspace", is a whole-workspace move: see below), one target space (whoever manages it restores: the workspace owner
// for a shared space, the person for their personal space; a delegated token
// never):
//   * "empty" — the space has no notes: every note in the backup comes back
//     with its hierarchy, tags, attributes, drawings and media, keeping its
//     id where the id is free (an id in use elsewhere, or by a note the
//     restorer cannot read, gets a new one, links and relations following);
//   * "merge" — into a space as it is. Per note, by id:
//       free id                        → added with that id
//       same id, same content          → left alone ("unchanged")
//       same id, different content     → the current note stays; the backup's
//                                        version is added as a copy titled
//                                        「…（備份 YYYY-MM-DD）」 next to it
//       same id, deleted here          → left in History ("in_history"), from
//                                        where the person can bring it back
//       id of a note they cannot read  → added with a new id (the preview never
//                                        tells that such a note exists)
//     A note with the same title under the same parent as a current note is
//     added beside it and listed as a title clash. Nothing is overwritten.
//   * "workspace" — a move of the whole workspace into a NEW one (only its
//     owner; services/backupWorkspaceMove.ts says what new means and what is
//     carried): like "empty", but the spaces of the backup are made again and
//     each note goes back into its own, the target's sample notes are cleared,
//     tags that already exist take the backup's colour, fields and text, and
//     the extras (review progress, subscriptions, settings, the site) come too.
//     Members are not rebuilt.
//   "Content" is the title, the stored body and the attributes a person set
//   (restoreAttribute); derived attributes come back from the body.
//   A merge may ask for a PARENT NOTE (RestoreParentNote): one new note, made first, under which every note the restore
//   adds lands (the backup's own parent/child shape kept below it, a note whose parent is not restored goes straight under
//   it, a copy too). This is how a session written on a borrowed computer arrives. With a parent id the same note is
//   found again on the next import of that session, and one more rule applies there (a "supersede"): a note of the
//   session whose text was written further since the last import REPLACES its earlier version in place — title and body,
//   through the ordinary update, so History keeps the old text — but only when nobody edited that note here since it
//   was imported (no save or drawing but the restore's own). If they did, it is the ordinary copy beside it, so a
//   phone-side edit is never overwritten. Without a parent note none of this applies and nothing changes.
//
// Where notes land: a note under a note of the backup stays under it; one
// whose parent is not restored, not writable for the restorer, or in another
// space goes to the root of the target space — a merge's copy too: nothing
// lands outside the space the person chose. Deleted notes in the backup are restored and
// then deleted again through nodeTrash, so they sit in History as before.
//
// Tags: a tag of the backup is the live tag with its id, else the system tag
// with its role, else the tag at its path; otherwise it is created (its id
// kept when free). Colour, fields, `extends`, views and the functions of a NEW
// tag come back only for the workspace owner (a tag definition is the owner's);
// existing tags are never changed. Every id a tag or a view names (`extends`, a
// filter's value, a board tab's branches) goes through the restore's id map;
// what cannot come back is counted in the report (skipped.tag_settings, .views, .functions).
//
// Every write goes through the domain writers (createNote, createTaskNode,
// applyTagToNode, setNodeAttribute, createEdge, applyBoardChanges,
// trashNode), caused by one BACKUP_RESTORED event: one event group — undoing
// BACKUP_RESTORED with its caused changes deletes what the restore added
// (services/backupRestoreUndo.ts). The event commits first with the tags,
// then the rest commits in batches (applyRestore), so other writers are not
// held off for the whole restore; a batch that fails undoes the committed
// part. Attachments are written before the first commit under their own
// media ids (a file already there is kept, and a missing one is filled in
// only where the restorer may read that id; the disk must have room first);
// if that first commit fails, the files it wrote are removed again. A big
// restore runs as a job (services/backupRestoreJobs.ts).
//
// A restored note keeps its created_at, except that it is never dated
// before a note that already references a file with no upload record (an
// import's): such a file belongs to its oldest referencing note, and a
// backdated restore would take it over (newestOwnerlessReference).
//
// Slugs. A note keeps the slug it had when that is free in its space; a note in
// the trash is made with a throwaway slug and given its own back once deleted
// (it holds no slug among live notes), so it never takes a live note's.
// Links. `[[links]]` are set once everything is in place (backupLinks.ts).
// System attributes. Those that belong to a note come back with it, `_published` as
// backupSystemAttrs.ts says (a 「備份」 copy, and a note that took a new id because its own is a live note here, always comes
// back kept off the site: it is a second copy of a live note here; an id taken in another workspace does not make it one).
//
// Not restored by "empty" and "merge": spaces and memberships (spaces.json is a
// record; everything lands in the target space), a page design (presentation),
// version history. A workspace move restores the first two as described above.
// A note deleted for good since the backup comes back only because the backup
// has it; nothing else is touched.

import { noteAnchorRanges, restoreBackupAnchors, type AdoptAnchor } from "./blockAnchors/index.js";
import { restoreBackupBindings } from "./blockLinks.js";
import { randomUUID } from "node:crypto";
import { sha256Hex } from "../utils.js";
import { attributeValues, encodeValues, isCalendarDay, TASK_STATUSES, isListValue, isMediaId, mediaUrl, isUuid, isSystemAttr, UUID_SOURCE, HANDWRITING_LAYOUT, hasLegacyIds, stripLegacyIds, legacyIdShift } from "@onden/markdown";
import { isValidOrderKey } from "@onden/markdown/contract";
import { db } from "../dbKysely.js";
import { q, withSavepoint } from "../db.js";
import { sql } from "kysely";
import type { ActorCtx } from "../types.js";
import { mutate, runCascade, withIdempotencyKey } from "../spine/mutate.js";
import { assertAuthority, AuthorityError, isWorkspaceOwner, requirePerson } from "../spine/authority.js";
import { localDayId } from "../localDay.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { spaceScopeSql } from "../spine/spaceScope.js";
import { createNote } from "./noteCreate.js";
import { canPlaceUnder } from "./nodePlacement.js";
import { trashNode } from "./nodeTrash.js";
import { applyTagToNode, TagMembershipError } from "./tagMembershipWrites.js";
import { setNodeAttribute, AttributeWriteError } from "./attributeWrites.js";
import { createTag, liveTagIdByName, TagCreateRefusal, TagNameShapeError, isTagNameConflict } from "./tagHierarchy.js";
import { changeTagSchema, countAutomation } from "./tagWrites.js";
import { updateTagIdentity } from "./tagIdentity.js";
import { reservedTagId } from "./reservedTags.js";
import type { ReservedTagKey } from "../spine/reservedTagKeys.js";
import { createTaskNode, K, taskFieldsOfAttributes } from "./tasksStore.js";
import { recordAttributeChange } from "./attributeChange.js";
import { TASKS_MODULE_ID } from "../spine/taskIdentity.js";
import { TaskUpdateRefusal } from "./taskSeam.js";
import { reviewSeam } from "./reviewSeam.js";
import { createStandaloneTask } from "./standaloneTasks.js";
import { createEdge } from "./edgeWrites.js";
import { applyBoardChanges } from "./boardWrites.js";
import { addWhiteboardTab, hasWhiteboardTab, type BoardCard, type BoardSection } from "./boardStore.js";
import { backedUpView, restoreNoteViews, withRestoredIds } from "./noteViews.js";
import { appendTagView } from "./tagViews.js";
import { CodedStatusError } from "../statusError.js";
import { ModuleNotImportedError } from "./workspaceModules.js";
import { restoreMediaFile, type MediaRefusal } from "./media.js";
import { canReadMedia } from "./mediaAccess.js";
import { MediaStorageFull, mediaFiles } from "./mediaFiles.js";
import { ScopeError } from "../spine/toolScope.js";
import { BackupFileError, BackupRestoreRefusal, type BackupReader } from "./backupFile.js";
import { HistoryLineError, ImportedHistoryError, importNoteHistory } from "./backupHistory.js";
import { log } from "../logger.js";
import { restoreEvent } from "./eventRestore/index.js";
import { eventChain } from "./eventChain.js";
import { discardAbandonedRestore, restoreFinished, restoreStarted, tagDefinitionStays } from "./backupRestoreUndo.js";
import type { BackupNote } from "./backupArchive.js";
import { reconcileTaskFields, restoreSystemAttrs } from "./backupSystemAttrs.js";
import { settleWikilinkEdges, type RestoredLinks } from "./backupLinks.js";
import { importExtras, importFunctionRefs, type ExtrasImport } from "./backupExtras.js";
import { NodeUpdateError, updateNode } from "./nodeUpdate.js";
import { assertNewWorkspace, inspectTargetWorkspace, movePreview, notMovedFor, rebuildSpaces, type MovedSpaces, type TargetFacts } from "./backupWorkspaceMove.js";

import { editEventSql } from "./history/index.js";

import type { RestoreMode, RestoreMovePreview, RestoreParentNote, RestorePreview, RestoreReport } from "@onden/contract";
import { liveNodeSql, liveTagNodeSql, notTagNodeSql } from "../spine/nodeSql.js";
import { isCanvas, isTag } from "@onden/markdown/contract";

/** The `_task_*` values an ordinary note may keep on itself (it was a task by its tag until 2026-11-12; the values
 *  stay as inert data, see migration 191), with what the Tasks page could write: only these come back from a backup,
 *  so a crafted one cannot plant other system state. */
const NOTE_TASK_VALUES: Record<string, (value: string) => boolean> = {
  [K.status]: (value) => (TASK_STATUSES as readonly string[]).includes(value) && value !== "later",
  [K.when]: isCalendarDay,
  [K.deadline]: isCalendarDay,
  [K.evening]: (value) => value === "true",
  [K.someday]: (value) => value === "true",
};

/** Attributes a restore writes itself: ones a person (or a module) set.
 *  Inline `key:: value`, frontmatter and derived values come back with the
 *  body; `_` keys are system state (a task's status is restored as a task). */
export function restoredAttribute(a: { key: string; value: string; source: string }): boolean {
  return !isSystemAttr(a.key) && a.value !== "" && ["ui", "explicit", "dispatcher"].includes(a.source);
}

/** The section frames in a backed-up board's `_canvas_sections` attribute; entries that are not frames are dropped. */
function backedUpSections(attributes: ReadonlyArray<{ key: string; value: string }>): BoardSection[] {
  const raw = attributes.find((a) => a.key === "_canvas_sections")?.value;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is BoardSection => !!s && typeof s.id === "string" && [s.x, s.y, s.width, s.height].every((n) => Number.isFinite(n)));
  } catch { return []; }
}

/** What "same content" compares: title, stored body, restored attributes. */
export function contentFingerprint(title: string, markdown: string, attributes: Array<{ key: string; value: string; source: string }>): string {
  const attrs = attributes.filter(restoredAttribute).map((a) => [a.key, a.value]).sort((x, y) => (x[0]! < y[0]! ? -1 : x[0]! > y[0]! ? 1 : 0));
  return sha256Hex(JSON.stringify([title, markdown, attrs]));
}

/** One row of the backup, as the plan needs it (no body). */
type Item = {
  id: string;
  node_type: string;
  title: string;
  parent_id: string | null;
  hidden: boolean;
  deleted: boolean;
  task: null | { lineRef: string | null };
  tag: BackupNote["tag"] | null;
  fingerprint: string;
  /** Only for a note of a version 2 archive (no key): its integer order and creation time. */
  legacyOrder: { sort_order: number; created_at: string } | null;
  media: string[];
  /** The files on disk its title, body or restored attributes reference by
   *  the rule ownership uses (ownershipRefs); empty in a preview. */
  refs: string[];
};

type NoteAction =
  | { kind: "create"; id: string; remapped: boolean; /** The note whose id it could not keep is live and readable here: this one is a second copy next to it. */ alongside?: boolean }
  | { kind: "copy"; id: string; currentId: string; currentParentId: string | null }
  | { kind: "unchanged"; currentId: string }
  /** Same id, newer text, in the session's parent note and not edited here since its import: updated in place. */
  | { kind: "supersede"; currentId: string }
  | { kind: "in_history"; currentId: string }
  /** A task made from a line of its note: it comes back with the line. */
  | { kind: "line_task" };

/** `tasks_tag`: the tasks tag of a backup made before tasks became function references. It is not restored as a
 *  tag; the tasks it was on come back as tasks (createTaskNode / createStandaloneTask give them the reference). */
type TagAction = { kind: "existing"; id: string } | { kind: "create"; id: string | null } | { kind: "deleted" } | { kind: "tasks_tag" } | { kind: "review_tag" };
// `review_tag`: the review module's tag of a backup made before review cards held their own reference (migration 195). It is not
// restored as a tag; the notes it was on (and those of the tags that extended it, `Plan.cardTags`) come back as review cards.

type Plan = {
  items: Item[];
  notes: Map<string, NoteAction>;
  tags: Map<string, TagAction>;
  /** Backup tag ids that made their notes review cards before migration 195: the review module's tag and every tag extending it. */
  cardTags: Set<string>;
  titleClashes: Array<{ id: string; title: string }>;
};


const LIST_MAX = 100;
const BATCH = 500;

/** The media files on disk by lower-cased name. */
async function mediaOnDisk(): Promise<Map<string, string>> {
  const names = await mediaFiles().names();
  return new Map(names.filter(isMediaId).map((name) => [name.toLowerCase(), name]));
}
const LAX_MEDIA_REF = /\/api\/media\/([a-z0-9._-]+)/g;
/** Every file in `onDisk` that `text` references as ownership counts it
 *  (mediaOwners.ts mediaReferences): `/api/media/<file>` anywhere, any case,
 *  whatever stands before it — wider than mediaRefs, the link grammar. A
 *  run of name characters after the prefix references each file whose name
 *  is a prefix of it, as a substring match would. */
function ownershipRefs(text: string, onDisk: Map<string, string>): string[] {
  const out = new Set<string>();
  for (const match of text.toLowerCase().matchAll(LAX_MEDIA_REF)) {
    const run = match[1]!;
    for (let end = 1; end <= run.length; end++) {
      const file = onDisk.get(run.slice(0, end));
      if (file) out.add(file);
    }
  }
  return [...out];
}

async function readItems(reader: BackupReader, onDisk?: Map<string, string>): Promise<Item[]> {
  const items: Item[] = [];
  for (const id of reader.noteIds) {
    const n = await reader.readNote(id);
    const isTask = n.hidden && n.attributes.some((a) => a.key === K.status);
    items.push({
      id: n.id, node_type: n.node_type, title: n.title, parent_id: n.parent_id, hidden: n.hidden,
      deleted: n.deleted_at !== null, task: isTask ? { lineRef: n.task?.line_ref ?? null } : null,
      tag: isTag(n) ? n.tag ?? { path: n.title, color: null, schema: null, views: null, reserved_key: null } : null,
      fingerprint: contentFingerprint(n.title, n.markdown, n.attributes),
      legacyOrder: isValidOrderKey(n.order_key) ? null : { sort_order: n.sort_order ?? 0, created_at: n.created_at },
      media: n.media.filter((m) => reader.attachments.has(m)),
      refs: onDisk ? ownershipRefs([n.title, n.markdown, ...n.attributes.filter(restoredAttribute).map((a) => a.value)].join("\n"), onDisk) : [],
    });
  }
  return items;
}

/** Version 2 archives carry an integer `sort_order` and no key: sort those notes by it (then creation time, then id, the
 *  order the app showed) so that making them one after another, each last among its siblings, keeps that order. Notes
 *  that carry a key are left where they are: their key says it. */
function inLegacyOrder(items: Item[]): Item[] {
  if (items.every((i) => i.legacyOrder === null)) return items;
  const rank = (i: Item) => i.legacyOrder?.sort_order ?? Number.NEGATIVE_INFINITY;
  const made = (i: Item) => i.legacyOrder?.created_at ?? "";
  return [...items].sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0)
    || (made(a) < made(b) ? -1 : made(a) > made(b) ? 1 : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Parents before children; a row whose parent chain loops is a root. */
function parentsFirst(items: Item[]): Item[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const done = new Set<string>();
  const out: Item[] = [];
  const visit = (item: Item, path: Set<string>) => {
    if (done.has(item.id)) return;
    const parent = item.parent_id ? byId.get(item.parent_id) : undefined;
    if (parent && !path.has(parent.id)) visit(parent, new Set([...path, item.id]));
    if (!done.has(item.id)) { done.add(item.id); out.push(item); }
  };
  for (const item of items) visit(item, new Set([item.id]));
  return out;
}

async function targetSpace(actor: ActorCtx, workspaceId: string, spaceId: string) {
  // Managing the space is the gate: the owner for a shared space, the person for their own.
  await assertAuthority(actor, { kind: "space", spaceId, need: "manage" });
  const space = (await q<{ id: string; name: string; kind: string; notes: number }>(
    `SELECT s.id::text, s.name, s.kind,
            (SELECT count(*)::int FROM content_nodes n WHERE n.space_id = s.id AND ${liveNodeSql("n")} AND ${notTagNodeSql("n")}) AS notes
       FROM spaces s WHERE s.id = $1 AND s.workspace_id = $2 AND s.deleted_at IS NULL`, [spaceId, workspaceId],
  )).rows[0];
  if (!space) throw new BackupRestoreRefusal("space_not_found", 404);
  return space;
}

/** A note of the retired kind 'canvas' had its board without a record: it gets the tab it opens on. Every saved view a
 *  backup holds (the whiteboard and handwriting tabs included) comes back through restoreNoteViews. */
const needsLegacyBoardTab = (full: BackupNote): boolean => isCanvas(full) && !hasWhiteboardTab(full.views);

/** Before a restore job starts: the caller is a person who manages
 *  `spaceId`, and "empty" mode meets an empty space. Throws as the restore
 *  would (AuthorityError, BackupRestoreRefusal); the restore checks again
 *  under the lock. */
export async function checkRestoreTarget(authenticated: ActorCtx, workspaceId: string, mode: RestoreMode, spaceId: string): Promise<void> {
  requirePerson(authenticated, "backup");
  const actor = await resolveCurrentActor(authenticated, workspaceId);
  const space = await targetSpace(actor, workspaceId, spaceId);
  if (mode === "empty" && space.notes > 0) throw new BackupRestoreRefusal("target_not_empty", 409);
  if (mode === "workspace") await assertNewWorkspace(actor, workspaceId, spaceId);
}

async function tagByPath(workspaceId: string, path: string): Promise<string | null> {
  let parent: string | null = null;
  for (const segment of path.split("/").map((s) => s.trim()).filter(Boolean)) {
    parent = await liveTagIdByName(workspaceId, parent, segment);
    if (!parent) return null;
  }
  return parent;
}

/** Whether note `id` sits under the session's parent note `wrapId` and has not been edited (saved or drawn on) by anyone
 *  since a restore wrote it: the only case in which a newer version of the same note replaces it. */
async function sessionNoteUntouched(workspaceId: string, id: string, wrapId: string): Promise<boolean> {
  if (!await isUnder(workspaceId, id, wrapId)) return false;
  const edited = await db.selectFrom("domain_events as e").select("e.id").where("e.workspace_id", "=", workspaceId).where("e.target_id", "=", id)
    .where(sql<boolean>`${sql.raw(editEventSql("e"))} AND coalesce(e.tx_meta->>'ui_context', '') <> 'backup.restore'`).limit(1).executeTakeFirst();
  return !edited;
}

/** Whether live note `id` has `ancestorId` somewhere above it. */
async function isUnder(workspaceId: string, id: string, ancestorId: string): Promise<boolean> {
  const seen = new Set<string>();
  for (let at: string | null = id; at && !seen.has(at); ) {
    seen.add(at);
    const row = await db.selectFrom("content_nodes").select("parent_id").where("id", "=", at).where("workspace_id", "=", workspaceId).where("deleted_at", "is", null).executeTakeFirst();
    at = row?.parent_id ?? null;
    if (at === ancestorId) return true;
  }
  return false;
}

/** The session's parent note from an earlier import: a live note in the target space. */
async function parentNoteExists(workspaceId: string, spaceId: string, id: string): Promise<boolean> {
  return !!await db.selectFrom("content_nodes").select("id").where("id", "=", id).where("workspace_id", "=", workspaceId).where("space_id", "=", spaceId)
    .where("node_type", "=", "content").where("deleted_at", "is", null).executeTakeFirst();
}

/** Decide what happens to each row (see the module comment). Reads only;
 *  the restore runs it again under the event lock. */
async function planRestore(actor: ActorCtx, workspaceId: string, items: Item[], mode: RestoreMode, spaceId: string, wrap: RestoreParentNote | null): Promise<Plan> {
  const notes = new Map<string, NoteAction>();
  const tags = new Map<string, TagAction>();

  // Which ids are taken, and which of those the restorer may read.
  const taken = new Map<string, { readable: boolean; deleted: boolean; parent_id: string | null; space_id: string | null; title: string; markdown: string; node_type: string }>();
  for (let at = 0; at < items.length; at += BATCH) {
    const params: unknown[] = [items.slice(at, at + BATCH).map((i) => i.id), workspaceId];
    const scope = spaceScopeSql(actor, "cn", params);
    for (const row of (await q<{ id: string; readable: boolean; deleted: boolean; parent_id: string | null; space_id: string | null; title: string; markdown: string; node_type: string }>(
      `SELECT cn.id::text, (cn.workspace_id = $2 AND ${scope}) AS readable, cn.deleted_at IS NOT NULL AS deleted,
              cn.parent_id::text, cn.space_id::text, cn.title, cn.markdown, cn.node_type
         FROM content_nodes cn WHERE cn.id = ANY($1::uuid[])`, params)).rows) {
      taken.set(row.id, row);
    }
  }
  const attributesOf = new Map<string, Array<{ key: string; value: string; source: string }>>();
  const liveReadable = [...taken].filter(([, t]) => t.readable && !t.deleted).map(([id]) => id);
  for (let at = 0; at < liveReadable.length; at += BATCH) {
    for (const row of (await q<{ node_id: string; key: string; value: string; source: string }>(
      `SELECT node_id::text, key, value, source FROM node_attributes WHERE node_id = ANY($1::uuid[])`, [liveReadable.slice(at, at + BATCH)])).rows) {
      attributesOf.set(row.node_id, [...(attributesOf.get(row.node_id) ?? []), row]);
    }
  }

  // Tags, parents first.
  for (const item of items.filter((i) => isTag(i)).sort((a, b) => a.tag!.path.split("/").length - b.tag!.path.split("/").length)) {
    if (item.deleted) { tags.set(item.id, { kind: "deleted" }); continue; }
    const held = taken.get(item.id);
    if (held?.readable && isTag(held) && !held.deleted) { tags.set(item.id, { kind: "existing", id: item.id }); continue; }
    // The tasks tag was the reserved `task` tag in backups before migration 135 and the tasks module's tag
    // before migration 191: either way, tasks are not marked by a tag any more, so it is not restored.
    if ((item.tag?.schema as { module?: unknown } | null)?.module === "review") { tags.set(item.id, { kind: "review_tag" }); continue; }
    const isTasksTag = item.tag?.reserved_key === "task" || (item.tag?.schema as { module?: unknown } | null)?.module === TASKS_MODULE_ID;
    if (isTasksTag) { tags.set(item.id, { kind: "tasks_tag" }); continue; }
    const reserved = item.tag?.reserved_key ? await reservedTagId(workspaceId, item.tag.reserved_key as ReservedTagKey) : null;
    const atPath = reserved ?? await tagByPath(workspaceId, item.tag!.path);
    tags.set(item.id, atPath ? { kind: "existing", id: atPath } : { kind: "create", id: held ? null : item.id });
  }

  const byId = new Map(items.map((i) => [i.id, i]));
  for (const item of items) {
    if (isTag(item)) continue;
    const host = item.parent_id ? byId.get(item.parent_id) : undefined;
    if (item.task?.lineRef && host) { notes.set(item.id, { kind: "line_task" }); continue; }
    const held = taken.get(item.id);
    const fresh = () => ({ kind: "create" as const, id: randomUUID(), remapped: true, alongside: !!held?.readable && !held.deleted });
    if (!held) { notes.set(item.id, { kind: "create", id: item.id, remapped: false }); continue; }
    if (mode !== "merge" || !held.readable || held.node_type !== item.node_type) { notes.set(item.id, fresh()); continue; }
    if (held.deleted) { notes.set(item.id, { kind: "in_history", currentId: item.id }); continue; }
    const same = contentFingerprint(held.title, held.markdown, attributesOf.get(item.id) ?? []) === item.fingerprint;
    if (!same && !item.deleted && !item.task && wrap?.id && await sessionNoteUntouched(workspaceId, item.id, wrap.id)) {
      notes.set(item.id, { kind: "supersede", currentId: item.id });
      continue;
    }
    // A note deleted in the backup but live here was brought back since:
    // the current state stands.
    // A task is not copied: two of the same task would both come due.
    if (same || item.deleted || item.task) { notes.set(item.id, { kind: "unchanged", currentId: item.id }); continue; }
    notes.set(item.id, { kind: "copy", id: randomUUID(), currentId: item.id, currentParentId: held.parent_id });
  }

  // A line task whose host is not created comes back with nothing: its host
  // is unchanged or in History, and so is the task.
  for (const item of items) {
    if (notes.get(item.id)?.kind !== "line_task") continue;
    const hostAction = notes.get(item.parent_id!);
    if (hostAction?.kind !== "create" && hostAction?.kind !== "copy") notes.set(item.id, { kind: "unchanged", currentId: item.id });
  }

  // Title clashes: a note added (with a parent that already exists here, or
  // at the root of the target) beside a current note with its title.
  const clashCandidates = items.filter((i) => notes.get(i.id)?.kind === "create" && !i.hidden && !i.deleted);
  const parentKey = (i: Item): string | null => {
    // Under a parent note this restore makes (or finds), nothing of the target's own is beside it.
    if (wrap) return null;
    if (!i.parent_id) return "root";
    const parent = notes.get(i.parent_id);
    if (!parent && !byId.has(i.parent_id)) return i.parent_id;
    // A current parent in another space is not where the note lands: the
    // root of the target is (restoreNote's placeable).
    if (parent?.kind === "unchanged" || parent?.kind === "copy") return taken.get(parent.currentId)?.space_id === spaceId ? parent.currentId : "root";
    return null; // under a note this restore adds: nothing to clash with
  };
  const titleClashes: Array<{ id: string; title: string }> = [];
  const keyed = clashCandidates.map((i) => [i, parentKey(i)] as const).filter(([, key]) => key !== null);
  if (keyed.length) {
    const params: unknown[] = [workspaceId, keyed.map(([i]) => i.title), spaceId, keyed.flatMap(([, key]) => (key === "root" ? [] : [key]))];
    const scope = spaceScopeSql(actor, "cn", params);
    const existing = new Set((await q<{ key: string; title: string }>(
      `SELECT COALESCE(cn.parent_id::text, 'root') AS key, cn.title FROM content_nodes cn
        WHERE cn.workspace_id = $1 AND ${liveNodeSql("cn")} AND ${notTagNodeSql("cn")} AND cn.title = ANY($2::text[])
          AND ((cn.parent_id IS NULL AND cn.space_id = $3::uuid) OR cn.parent_id = ANY($4::uuid[])) AND ${scope}`, params,
    )).rows.map((r) => `${r.key}\n${r.title}`));
    for (const [i, key] of keyed) if (existing.has(`${key}\n${i.title}`)) titleClashes.push({ id: i.id, title: i.title });
  }
  // Tags that extended the review tag (at any depth) made their notes cards too.
  const cardTags = new Set([...tags].filter(([, action]) => action.kind === "review_tag").map(([id]) => id));
  const extendsOf = (item: Item): string[] => {
    const list = (item.tag?.schema as { extends?: unknown } | null)?.extends;
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];
  };
  for (let grown = cardTags.size > 0; grown;) {
    grown = false;
    for (const item of items) {
      if (isTag(item) && !cardTags.has(item.id) && extendsOf(item).some((id) => cardTags.has(id))) { cardTags.add(item.id); grown = true; }
    }
  }
  return { items, notes, tags, cardTags, titleClashes };
}

/** What restoring `reader` into `spaceId` in `mode` would do. Writes nothing. */
export async function previewBackupRestore(
  authenticated: ActorCtx, workspaceId: string, reader: BackupReader, mode: RestoreMode, spaceId: string, parentNote: RestoreParentNote | null = null,
): Promise<RestorePreview> {
  const actor = await resolveCurrentActor(authenticated, workspaceId);
  requirePerson(actor, "backup");
  const space = await targetSpace(actor, workspaceId, spaceId);
  if (parentNote && mode !== "merge") throw new BackupRestoreRefusal("bad_request", 400);
  const items = await readItems(reader);
  const plan = await planRestore(actor, workspaceId, items, mode, spaceId, parentNote);
  const counts: RestorePreview["counts"] = {
    notes_new: 0, notes_new_deleted: 0, notes_unchanged: 0, notes_conflict: 0, notes_updated: 0, notes_in_history: 0, notes_new_id: 0, notes_second_copy: 0,
    tasks: 0, tags_existing: 0, tags_new: 0, attachments_new: 0, attachments_existing: 0,
  };
  const conflicts: RestorePreview["conflicts"] = [];
  const newNotes: RestorePreview["new_notes"] = [];
  const media = new Set<string>();
  for (const item of items) {
    if (isTag(item)) {
      const tag = plan.tags.get(item.id);
      if (tag?.kind === "existing") counts.tags_existing++;
      else if (tag?.kind === "create") counts.tags_new++;
      continue;
    }
    const action = plan.notes.get(item.id)!;
    if (action.kind === "create" && action.remapped) { if (action.alongside) counts.notes_second_copy++; else counts.notes_new_id++; }
    if (item.task && (action.kind === "create" || action.kind === "line_task")) { counts.tasks++; continue; }
    switch (action.kind) {
      case "create":
        if (item.deleted) counts.notes_new_deleted++; else counts.notes_new++;
        if (newNotes.length < LIST_MAX && !item.hidden) newNotes.push({ id: item.id, title: item.title, deleted: item.deleted });
        item.media.forEach((m) => media.add(m));
        break;
      case "copy":
        counts.notes_conflict++;
        if (conflicts.length < LIST_MAX) conflicts.push({ id: item.id, title: item.title });
        item.media.forEach((m) => media.add(m));
        break;
      case "supersede":
        counts.notes_updated++;
        item.media.forEach((m) => media.add(m));
        break;
      case "unchanged": counts.notes_unchanged++; break;
      case "in_history": counts.notes_in_history++; break;
      case "line_task": break;
    }
  }
  for (const m of media) {
    if (await mediaFiles().info(m)) counts.attachments_existing++;
    else counts.attachments_new++;
  }
  let refusal: RestorePreview["refusal"] = mode === "empty" && space.notes > 0 ? "target_not_empty" : null;
  let move: RestoreMovePreview | null = null;
  if (mode === "workspace") {
    const found = await inspectTargetWorkspace(actor, workspaceId, spaceId);
    refusal = found.refusal;
    const perSpace = new Map<string, number>();
    for (const item of items) {
      if (isTag(item) || item.hidden || item.deleted) continue;
      const spaceOf = (await reader.readNote(item.id)).space_id;
      if (spaceOf) perSpace.set(spaceOf, (perSpace.get(spaceOf) ?? 0) + 1);
    }
    move = movePreview(reader, perSpace, found.facts, reader.historyNoteIds.size > 0 ? await reader.countHistory() : null);
  }
  return {
    mode, target: space, manifest: reader.manifest, holds_history: reader.historyNoteIds.size > 0, refusal,
    new_parent: parentNote ? { title: parentNote.title, exists: !!parentNote.id && await parentNoteExists(workspaceId, spaceId, parentNote.id) } : null,
    counts, conflicts, title_clashes: plan.titleClashes.slice(0, LIST_MAX), new_notes: newNotes, move,
  };
}

/** Which counter a refused attachment goes to: over its size, or a type or bytes the storage does not take. */
const refusalKind = (reason: MediaRefusal): "too_large" | "unreadable" => (reason === "too_large" ? "too_large" : "unreadable");

/** A storage that ran out of room is the restore's own refusal (507), whichever step noticed. */
function refuseWhenFull(error: unknown): never {
  if (error instanceof MediaStorageFull) throw new BackupRestoreRefusal("insufficient_storage", 507);
  throw error;
}

const UUID_IN_TEXT = new RegExp(`onden://node/(${UUID_SOURCE})`, "gi");

/** Ids a value or body names, mapped to the restored notes' ids. */
/** The body a restored note is created with, and the anchors that go on its blocks as it is created (so a task line
 *  or a card finds its block by the id the backup knew it by). A body that carries `^id` marks (a backup made before
 *  block ids left the text, or a mark a person typed since) loses them: each becomes an anchor of the same id, as the
 *  migration does. The backup's own anchor list describes the text with the marks, so its places are moved to the
 *  text without them. `known`: backup anchors on a block that a mark already names; they are not made, only looked
 *  up afterwards (anchorRemap), so what the backup held under that id finds the block. */
function restoredBody(markdown: string, anchors: ReadonlyArray<{ id: string; from: number; to: number }> | undefined): { markdown: string; adopt: AdoptAnchor[]; known: AdoptAnchor[] } {
  const converted = hasLegacyIds(markdown) ? stripLegacyIds(markdown) : null;
  const body = converted && !("refused" in converted) ? converted.markdown : markdown;
  const at = body === markdown ? (offset: number) => offset : legacyIdShift(markdown);
  const fromMarks: AdoptAnchor[] = converted && !("refused" in converted)
    ? converted.anchors.filter((a) => !a.repeat).map((a) => ({ anchorId: a.id, text: body.slice(a.from, a.to), at: a.from, kind: "new" as const }))
    : [];
  const marked = new Set(fromMarks.map((a) => a.at));
  const listed: AdoptAnchor[] = (anchors ?? []).map((a) => ({ id: a.id, from: at(a.from), to: at(a.to) }))
    .filter((a) => a.from >= 0 && a.from < a.to && a.to <= body.length && !fromMarks.some((m) => m.anchorId === a.id))
    .map((a) => ({ anchorId: a.id, text: body.slice(a.from, a.to), at: a.from, kind: "new" as const }));
  return { markdown: body, adopt: [...fromMarks, ...listed.filter((a) => !marked.has(a.at!))], known: listed.filter((a) => marked.has(a.at!)) };
}

function remapText(text: string, ids: Map<string, string>): string {
  return text.replace(UUID_IN_TEXT, (match, id: string) => (ids.has(id) ? `onden://node/${ids.get(id)}` : match));
}

/** A write refused on its own (authority, a field's rule, a tag's policy):
 *  counted and skipped, the restore goes on. Anything else aborts it. */
function isRefusal(error: unknown): boolean {
  return error instanceof AuthorityError || error instanceof ScopeError || error instanceof TagMembershipError
    || error instanceof AttributeWriteError || error instanceof TagCreateRefusal || error instanceof TagNameShapeError
    || error instanceof TaskUpdateRefusal || error instanceof NodeUpdateError || isTagNameConflict(error);
}
async function tryWrite(write: () => Promise<unknown>): Promise<boolean> {
  try { await withSavepoint(write); return true; }
  catch (error) { if (isRefusal(error)) return false; throw error; }
}

/** Notes (and deletions) per committed batch. A note takes about 80 ms to
 *  restore, so another writer waits a few seconds at most for the lock. */
export const RESTORE_BATCH = 50;
/** Notes whose links, or board cards, go in one batch. */
const LINK_BATCH = 200;

export type RestorePhase = "reading" | "attachments" | "tags" | "notes" | "history" | "links" | "positions" | "deleted";
/** Where a running restore is (services/backupRestoreJobs.ts shows it).
 *  `done`/`total` count the current phase's steps; `eventId` is set once the
 *  BACKUP_RESTORED event has committed. */
export type RestoreProgress = { phase: RestorePhase; done: number; total: number; eventId: string | null };

/** A batch failed after earlier ones committed. The committed part was
 *  undone through the restore's own inverse (`rolledBack`; its notes are in
 *  History), or, if that failed too, is still there to undo from History. */
export class RestoreAbandoned extends Error {
  constructor(readonly eventId: string, readonly rolledBack: boolean, readonly reason: unknown) {
    super(`restore failed after event ${eventId}: ${reason instanceof Error ? reason.message : String(reason)}`);
    this.name = "RestoreAbandoned";
  }
}

/** What the batches of one restore share. */
type RestoreRun = {
  authenticated: ActorCtx;
  workspaceId: string;
  reader: BackupReader;
  items: Item[];
  /** Ids of every row of the backup. */
  itemIds: Set<string>;
  spaceId: string;
  eventId: string;
  plan: Plan;
  report: RestoreReport;
  /** Backup id → the id links point at: the new note, or the current one. */
  ids: Map<string, string>;
  /** Backup id → the note this restore made (a create or a copy). */
  createdIds: Map<string, string>;
  /** The parent note everything lands under (RestoreParentNote); `id` is set once it is made or found. */
  wrap: null | { spec: RestoreParentNote; id: string | null };
  /** Backup tag id → tag here. */
  tagIds: Map<string, string>;
  /** Media id → the creation time of the newest note referencing it now,
   *  for files with no upload record (ownerlessReferences). */
  ownerless: Map<string, string>;
  /** `${restored note id}:${anchor id in the backup}` → the anchor id the restored block really has (an id the backup knew
   *  may be taken in this workspace already: restoring beside the originals). A task line is found through it. */
  anchorRemap: Map<string, string>;
  backupDay: string;
  /** A workspace move: backup space id → space here, and what the move cleared. */
  moved: null | { spaces: MovedSpaces; facts: TargetFacts; cleared: { notes: number; tags: number } };
  /** What the history phase carried (a move whose backup holds history); null when there was nothing to carry. */
  history: null | { notes: number; versions: number; failed: string[] };
  /** The spaces notes may land in: the target space, or all of a move's. */
  landing: Set<string>;
  owner: boolean;
};

const noProgress = async (): Promise<void> => {};

/** Restore `reader` into `spaceId` (see the module comment). Throws
 *  BackupRestoreRefusal when the mode does not fit the space, or the disk has
 *  no room for the attachments.
 *
 *  Batches. The BACKUP_RESTORED event commits first, with the tags; then
 *  notes, links, board positions and deletions commit RESTORE_BATCH at a
 *  time, each batch a cascade of that event (runCascade: its writes are
 *  triggered by it, so undoing it with its caused changes still undoes the
 *  whole restore). The event lock is held per batch, not for the whole
 *  restore — the lock orders event ids by commit (spine/mutate.ts), so it
 *  cannot be let go inside one transaction; committing in batches is the
 *  only way other writers get in. What could fail half way is checked before
 *  the first write (the backup's shape and dates: backupFile.ts; authority;
 *  the disk). If a later batch still fails, the committed part is undone at
 *  once (RestoreAbandoned). `uploadId` makes a retry a replay. */
export async function applyRestore(
  authenticated: ActorCtx, workspaceId: string, reader: BackupReader, mode: RestoreMode, spaceId: string, uploadId: string,
  onProgress: (progress: RestoreProgress) => Promise<void> = noProgress,
  parentNote: RestoreParentNote | null = null,
): Promise<RestoreReport> {
  requirePerson(authenticated, "backup");
  const current = await resolveCurrentActor(authenticated, workspaceId);
  await targetSpace(current, workspaceId, spaceId);
  if (parentNote && mode !== "merge") throw new BackupRestoreRefusal("bad_request", 400);
  await onProgress({ phase: "reading", done: 0, total: reader.noteIds.length, eventId: null });
  // Files this restore writes get an upload record, so only those already
  // on disk can be ownerless.
  const items = await readItems(reader, await mediaOnDisk());

  // Attachments first, outside the transaction: a file is on disk before a
  // note names it. Only files of notes the plan adds (decided again under the
  // lock; a note added there too with a missing file shows a broken link),
  // only missing ones.
  const outline = await planRestore(current, workspaceId, items, mode, spaceId, parentNote);
  const adds = (i: Item) => ["create", "copy", "supersede"].includes(outline.notes.get(i.id)?.kind ?? "");
  const missing: string[] = [];
  const attachmentsLeftOut = { too_large: 0, unreadable: 0, not_yours: 0 };
  for (const mediaId of new Set(items.filter(adds).flatMap((i) => i.media))) {
    if (await mediaFiles().info(mediaId)) continue;
    // A missing file is filled in only where the restorer may read that
    // media id now (canReadMedia: their own upload, one a note they read
    // owns, or an id nothing here knows). Someone else's upload whose file
    // is gone from disk is not theirs to refill with other bytes.
    if (!await canReadMedia(current, mediaId, workspaceId)) { attachmentsLeftOut.not_yours++; continue; }
    missing.push(mediaId);
  }
  // Fail before the first file, not with the disk full half way.
  await mediaFiles().assertRoom(missing.reduce((sum, mediaId) => sum + reader.attachmentSize(mediaId), 0)).catch(refuseWhenFull);
  const written: string[] = [];
  let run: RestoreRun;
  try {
    for (const [at, mediaId] of missing.entries()) {
      await onProgress({ phase: "attachments", done: at, total: missing.length, eventId: null });
      const result = await restoreMediaFile(mediaId, await reader.openAttachment(mediaId));
      if (result === "written") written.push(mediaId);
      else if (result !== "exists") attachmentsLeftOut[refusalKind(result)]++;
    }
    await onProgress({ phase: "tags", done: 0, total: 0, eventId: null });
    run = await beginRestore(authenticated, workspaceId, reader, items, mode, spaceId, uploadId, written, attachmentsLeftOut, parentNote);
  } catch (error) {
    // Nothing committed: the files this restore wrote go too.
    for (const mediaId of written) await mediaFiles().remove(mediaId);
    return refuseWhenFull(error);
  }

  // While the batches run, History refuses to undo the restore: an undo
  // now would report success while later batches kept adding notes.
  restoreStarted(run.eventId);
  try {
    await continueRestore(run, onProgress);
  } catch (error) {
    restoreFinished(run.eventId);
    throw new RestoreAbandoned(run.eventId, await undoInSteps(authenticated, workspaceId, run.eventId), error);
  } finally {
    restoreFinished(run.eventId);
  }
  return run.report;
}

/** Undo a restore that failed part way: each change it caused, newest
 *  first, in its own short transaction, then the event itself — not one
 *  cascade transaction holding the event lock for as long as the restore
 *  took to write — and then what the undo leaves behind
 *  (discardAbandonedRestore), so that a new attempt starts clean. True when
 *  all of it was undone; otherwise what is left is for History. Also the
 *  boot's way to finish a restore a restart cut off
 *  (backupRestoreJobs.ts failInterruptedRestoreJobs). */
export async function undoInSteps(authenticated: ActorCtx, workspaceId: string, eventId: string): Promise<boolean> {
  try {
    const chain = await eventChain(workspaceId, eventId);
    const newestFirst = chain.map((e) => e.id).sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : BigInt(b) < BigInt(a) ? -1 : 0));
    // Each with its own claim: never the request's key, which the restore used.
    const undo = (id: string) => withIdempotencyKey(randomUUID(), () => restoreEvent(id, { actor: authenticated, workspaceId, cascade: false }));
    for (const id of newestFirst) {
      const result = await undo(id);
      if ("code" in result && result.code !== "already_in_state" && result.code !== "unsupported" && !await tagDefinitionStays(id, result.code)) return false;
    }
    if (!("restored" in await undo(eventId))) return false;
    await discardAbandonedRestore(authenticated, workspaceId, eventId);
    return true;
  } catch {
    return false;
  }
}

/** The first commit: the BACKUP_RESTORED event (the idempotency claim, the
 *  plan under the lock, the upload records of the files written) and the
 *  tags. Every later batch is caused by this event. */
async function beginRestore(
  authenticated: ActorCtx, workspaceId: string, reader: BackupReader, items: Item[], mode: RestoreMode,
  spaceId: string, uploadId: string, written: string[], attachmentsLeftOut: { too_large: number; unreadable: number; not_yours: number }, parentNote: RestoreParentNote | null,
): Promise<RestoreRun> {
  const backupDay = localDayId(new Date(reader.manifest.created_at || Date.now()));
  return mutate<RestoreRun>({
    actor: authenticated, workspaceId,
    authority: { kind: "space", spaceId, need: "manage" },
    // The upload id (a random UUID) is the key: a retry of the same restore
    // answers as a replay instead of restoring twice.
    idempotencyKey: uploadId,
    event: {
      type: "BACKUP_RESTORED", targetType: "space", targetId: spaceId,
      payload: { mode, backup_created_at: reader.manifest.created_at, backup_counts: reader.manifest.counts },
      txMeta: { inverse_op: "backup.restore.undone", ui_context: "backup.restore" },
    },
    apply: async ({ eventId }) => {
      // The job names its event in the transaction that commits it, so a crash
      // right after cannot leave a failed job with no event to undo (a retry
      // would only answer already_restored). No job row: a direct caller.
      await q(`UPDATE backup_restore_jobs SET event_id = $1::bigint, updated_at = now()
                WHERE upload_id = $2 AND status = 'running' AND event_id IS NULL`, [eventId, uploadId]);
      const actor = await resolveCurrentActor(authenticated, workspaceId);
      const space = await targetSpace(actor, workspaceId, spaceId);
      if (mode === "empty" && space.notes > 0) throw new BackupRestoreRefusal("target_not_empty", 409);
      const owner = await isWorkspaceOwner(actor);
      // A move clears the target's samples and makes the spaces first, in this transaction: a failure leaves the workspace as it was.
      let moved: RestoreRun["moved"] = null;
      if (mode === "workspace") {
        const facts = await assertNewWorkspace(actor, workspaceId, spaceId);
        let cleared = 0;
        for (const id of facts.builtinNoteIds) if (await tryWrite(() => trashNode(actor, workspaceId, id, { uiContext: "backup.restore" }))) cleared++;
        let clearedTags = 0;
        for (const id of facts.builtinTagIds) if (await tryWrite(() => trashNode(actor, workspaceId, id, { uiContext: "backup.restore" }))) clearedTags++;
        moved = { spaces: await rebuildSpaces(authenticated, workspaceId, reader, spaceId, facts), facts, cleared: { notes: cleared, tags: clearedTags } };
      }
      const plan = await planRestore(actor, workspaceId, items, mode, spaceId, parentNote);
      const report: RestoreReport = {
        event_id: eventId, created: 0, superseded: 0, parent_note_id: null, copies: 0, unchanged: 0, in_history: 0, deleted_again: 0, tags_created: 0,
        attachments_written: written.length, tasks: 0, views: 0,
        skipped: {
          tags: 0, attributes: 0, links: 0, positions: 0, tag_settings: 0, tag_automation: 0, tasks: 0, views: 0, functions: 0,
          attachments_too_large: attachmentsLeftOut.too_large, attachments_unreadable: attachmentsLeftOut.unreadable, attachments_not_yours: attachmentsLeftOut.not_yours,
        },
        moved: null,
      };
      // Files this restore put on disk are the restorer's uploads until the
      // notes that name them are saved (they claim them: mediaOwners.ts).
      for (const filename of written) {
        await q(`INSERT INTO media_uploads (filename, workspace_id, uploader_actor_id) VALUES ($1, $2, $3) ON CONFLICT (filename) DO NOTHING`,
          [filename, workspaceId, actor.id]);
      }
      const ownerless = await ownerlessReferences(workspaceId, items.filter((i) => {
        const kind = plan.notes.get(i.id)?.kind;
        return kind === "create" || kind === "copy";
      }).flatMap((i) => i.refs));

      // ── Tags ──
      const tagIds = new Map<string, string>();
      // Tag definitions (colour, fields, `extends`, views, functions) are written after every tag exists: a tag may extend or
      // filter on one that is made later in this loop.
      const definitions: Array<{ backupId: string; tagId: string; made: boolean }> = [];
      for (const item of items.filter((i) => plan.tags.has(i.id)).sort((a, b) => a.tag!.path.split("/").length - b.tag!.path.split("/").length)) {
        const action = plan.tags.get(item.id)!;
        if (action.kind === "existing") {
          tagIds.set(item.id, action.id);
          // A move: a tag the new workspace already has (a built-in one) takes the backup's definition.
          if (mode === "workspace" && owner) definitions.push({ backupId: item.id, tagId: action.id, made: false });
          continue;
        }
        if (action.kind === "deleted" || action.kind === "tasks_tag" || action.kind === "review_tag") continue;
        const parentId = item.parent_id ? tagIds.get(item.parent_id) ?? null : null;
        if (item.parent_id && !parentId) { report.skipped.tags++; continue; }
        let created: string | null = null;
        const ok = await tryWrite(async () => {
          created = (await createTag({ actor, workspaceId, name: item.title, parentId, ...(action.id ? { id: action.id } : {}) })).id;
        });
        if (!ok || !created) { report.skipped.tags++; continue; }
        tagIds.set(item.id, created);
        report.tags_created++;
        // A tag definition is the owner's: colour, fields and text come back for them.
        if (owner) definitions.push({ backupId: item.id, tagId: created, made: true });
        else {
          if (item.tag?.schema || item.tag?.color) report.skipped.tag_settings++;
          if (mode !== "workspace") report.skipped.functions += reader.extras?.functionRefs.filter((r) => r.holder_node_id === item.id).length ?? 0;
        }
      }

      const ids = new Map<string, string>();
      for (const [backupId, action] of plan.notes) {
        if (action.kind === "create") ids.set(backupId, action.id);
        else if (action.kind !== "line_task") ids.set(backupId, action.currentId);
      }
      for (const [backupId, action] of plan.tags) if (action.kind === "existing") ids.set(backupId, action.id);
      for (const [backupId, tagId] of tagIds) ids.set(backupId, tagId);
      for (const d of definitions) await restoreTagDefinition(actor, workspaceId, reader, d.backupId, d.tagId, ids, report);
      if (mode !== "workspace" && reader.extras) {
        // An ordinary restore brings back the functions of the tags it made; a move writes every one with the rest of the extras.
        const made = new Set(definitions.filter((d) => d.made).map((d) => d.backupId));
        report.skipped.functions += (await importFunctionRefs(workspaceId, actor.id, reader.extras.functionRefs, ids, new Map(), made)).left_out;
      }
      return {
        authenticated, workspaceId, reader, items, itemIds: new Set(items.map((i) => i.id)), spaceId, eventId, plan, report,
        wrap: parentNote ? { spec: parentNote, id: null } : null,
        ids, createdIds: new Map(), history: null, tagIds, ownerless, anchorRemap: new Map(), backupDay,
        moved, landing: moved ? new Set([...moved.spaces.map.values()]) : new Set([spaceId]), owner,
      };
    },
  });
}

/** The tags a restored tag extends, as ids in this workspace: one this restore made or kept by its new id, one that was
 *  already here by the id it has, and none other (counted as a tag setting left out). */
async function extendedTagsHere(workspaceId: string, backedUp: unknown[], ids: Map<string, string>, report: RestoreReport): Promise<string[]> {
  const wanted = backedUp.filter((id): id is string => typeof id === "string");
  const unmapped = wanted.filter((id) => !ids.has(id));
  const here = new Set(unmapped.length ? (await db.selectFrom("content_nodes").select("id").where("workspace_id", "=", workspaceId).where("id", "in", unmapped).execute()).map((r) => r.id) : []);
  const kept = wanted.flatMap((id) => (ids.has(id) ? [ids.get(id)!] : here.has(id) ? [id] : []));
  if (kept.length < backedUp.length) report.skipped.tag_settings++;
  return kept;
}

/** Give tag `tagId` the colour, fields and text the backup's tag `backupId` has.
 *  Each is its own write: a refusal is counted and the rest goes on. */
async function restoreTagDefinition(actor: ActorCtx, workspaceId: string, reader: BackupReader, backupId: string, tagId: string, ids: Map<string, string>, report: RestoreReport): Promise<void> {
  const full = await reader.readNote(backupId);
  // An unset colour (null: the app picks one) is a colour too; createTag gave the new tag a grey of its own.
  if (full.tag && full.tag.color !== undefined) {
    if (!await tryWrite(() => updateTagIdentity(actor, workspaceId, tagId, async () => ({ color: full.tag!.color })))) report.skipped.tag_settings++;
  }
  if (full.tag?.schema && typeof full.tag.schema === "object") {
    const ok = await tryWrite(async () => {
      const locked = (await q<{ id: string; title: string; tag_schema: Record<string, unknown> | null }>(
        `SELECT id::text, title, tag_schema FROM content_nodes WHERE id = $1 FOR UPDATE`, [tagId])).rows[0]!;
      // The backed-up schema comes back as it was, field names included
      // (tagWrites FieldNameRule "import").
      const schema = full.tag!.schema as Record<string, unknown>;
      // `extends` names tags by id: the ones this restore made have new ids.
      const patch = Array.isArray(schema.extends) ? { ...schema, extends: await extendedTagsHere(workspaceId, schema.extends, ids, report) } : schema;
      await changeTagSchema({ actor, workspaceId, tag: locked, patch, whenNew: "private", uiContext: "backup.restore", fieldNames: "import" });
    });
    if (!ok) report.skipped.tag_settings++;
    // The retired automation keys are dropped on the way in (tagWrites.withoutAutomation); say how many.
    else report.skipped.tag_automation += countAutomation((full.tag.schema as { behaviour?: unknown }).behaviour);
  }
  // Its saved views (table, kanban, calendar, gallery…): each is added through the tag's own writer; a name the tag
  // already has is left as it is, a kind a tag cannot hold or a module that is off here is counted.
  for (const stored of Array.isArray(full.tag?.views) ? full.tag!.views : []) {
    const view = backedUpView(stored, ids);
    let made: { id: string } | null = null;
    let refused = !view;
    if (view) {
      try {
        await withSavepoint(async () => {
          made = await appendTagView(actor, workspaceId, tagId, view, { authority: { kind: "principal_admin" }, uiContext: "backup.restore", skipNameClash: true });
        });
      } catch (error) {
        if (!(error instanceof ModuleNotImportedError || error instanceof CodedStatusError || isRefusal(error))) throw error;
        refused = true;
      }
    }
    if (refused) report.skipped.views++;
    else if (made) report.views++;
  }
  // What was set on the tag's page itself: its whiteboard's pen layer (`board_ink`).
  await restoreBackedUpAttributes(actor, workspaceId, tagId, full.attributes, new Map(), report);
  // The text of the tag's page (「記錄書籍的資訊」): only when it differs.
  const current = (await db.selectFrom("content_nodes").select("markdown").where("id", "=", tagId).executeTakeFirst())?.markdown ?? "";
  if (full.markdown && full.markdown !== current) {
    if (!await tryWrite(() => updateNode(workspaceId, tagId, { markdown: full.markdown }, { actor }))) report.skipped.tag_settings++;
  }
}

/** For each of `mediaIds` that has no upload record (an imported file, or
 *  one from before migration 090), the newest creation time among the notes
 *  that reference it now. Such a file belongs to its OLDEST referencing note
 *  (mediaAccess.ts), so a restored note is dated after all of them
 *  (newestOwnerlessReference): a restore never takes over a file it did not upload,
 *  whatever created_at the backup claims. One query per restore. */
async function ownerlessReferences(workspaceId: string, mediaIds: string[]): Promise<Map<string, string>> {
  const names = [...new Set(mediaIds)];
  if (!names.length) return new Map();
  const r = await q<{ name: string; latest: string }>(
    `WITH files AS (
       SELECT f.name, lower(f.url) AS url FROM unnest($2::text[], $3::text[]) AS f(name, url)
        WHERE NOT EXISTS (SELECT 1 FROM media_uploads u WHERE u.workspace_id = $1 AND u.filename = f.name)
     ), refs AS (
       SELECT f.name, n.created_at FROM files f
         JOIN content_nodes n ON n.workspace_id = $1 AND n.markdown IS NOT NULL AND strpos(lower(n.markdown), f.url) > 0
       UNION ALL
       SELECT f.name, n.created_at FROM files f
         JOIN node_attributes na ON na.workspace_id = $1 AND strpos(lower(na.value), f.url) > 0
         JOIN content_nodes n ON n.id = na.node_id
       UNION ALL
       SELECT f.name, n.created_at FROM files f
         JOIN content_nodes n ON n.workspace_id = $1 AND n.presentation IS NOT NULL AND strpos(lower(n.presentation::text), f.url) > 0
     )
     SELECT name, max(created_at)::text AS latest FROM refs GROUP BY name`,
    [workspaceId, names, names.map(mediaUrl)],
  );
  return new Map(r.rows.map((row) => [row.name, row.latest]));
}

/** Run `body` as one committed batch of `run`: its own transaction under the
 *  event lock, its writes caused by the restore's event. The actor is read
 *  again under the lock, so someone who lost the right to manage stops the restore. */
function batch(run: RestoreRun, body: (actor: ActorCtx) => Promise<void>): Promise<void> {
  return runCascade(
    { actor: run.authenticated, workspaceId: run.workspaceId, authority: { kind: "space", spaceId: run.spaceId, need: "manage" }, causeEventId: run.eventId },
    async () => body(await resolveCurrentActor(run.authenticated, run.workspaceId)),
  );
}

async function continueRestore(run: RestoreRun, onProgress: (progress: RestoreProgress) => Promise<void>): Promise<void> {
  const { eventId } = run;
  const progress = (phase: RestorePhase, done: number, total: number) => onProgress({ phase, done, total, eventId });

  // ── The parent note, before anything goes under it ──
  if (run.wrap) {
    const wrap = run.wrap;
    await batch(run, async (actor) => {
      wrap.id = await ensureParentNote(run, actor, wrap.spec);
      run.report.parent_note_id = wrap.id;
    });
  }

  // ── Notes, parents first ──
  // A version 2 archive has an integer order, not keys: its notes are made in that order, each last among its siblings.
  const notes = parentsFirst(inLegacyOrder(run.items)).filter((i) => !isTag(i));
  for (let at = 0; at < notes.length; at += RESTORE_BATCH) {
    await progress("notes", at, notes.length);
    await batch(run, async (actor) => {
      for (const item of notes.slice(at, at + RESTORE_BATCH)) await restoreNote(run, actor, item);
    });
  }
  await progress("notes", notes.length, notes.length);

  // ── Version history (a move whose backup holds it; backupHistory.ts). Only into notes this restore made, as the owner:
  // run.moved is set only for a workspace move, which inspectTargetWorkspace allows the owner into a new workspace.
  if (run.moved && run.reader.historyNoteIds.size > 0) {
    const carry = notes.filter((i) => run.createdIds.has(i.id) && run.reader.historyNoteIds.has(i.id));
    const history = { notes: 0, versions: 0, failed: [] as string[] };
    run.history = history;
    for (const [at, item] of carry.entries()) {
      await progress("history", at, carry.length);
      await batch(run, async (actor) => {
        const lines = run.reader.openHistory(item.id);
        if (!lines) return;
        try {
          const done = await withSavepoint(() => importNoteHistory(actor, run.workspaceId, run.createdIds.get(item.id)!, () => run.reader.openHistory(item.id)!));
          history.notes++; history.versions += done.versions;
        } catch (error) {
          // A damaged or altered version fails that note's history alone, and says so in the result.
          if (!(error instanceof ImportedHistoryError || error instanceof HistoryLineError || error instanceof BackupFileError)) throw error;
          log.warn("backup", "a note's version history was not carried", { reason: error.name });
          history.failed.push(item.title || "");
        }
      });
    }
    await progress("history", carry.length, carry.length);
  }

  // ── Links between restored notes ──
  const made = run.items.filter((i) => run.createdIds.has(i.id));
  for (let at = 0; at < made.length; at += LINK_BATCH) {
    await progress("links", at, made.length);
    await batch(run, async (actor) => {
      for (const item of made.slice(at, at + LINK_BATCH)) {
        const sourceId = run.createdIds.get(item.id)!;
        const full = await run.reader.readNote(item.id);
        for (const edge of full.edges ?? []) {
          const target = run.ids.get(edge.target_node_id);
          const status = (["active", "suggested", "rejected"] as const).find((s) => s === edge.status) ?? "active";
          if (!target || !await tryWrite(() => createEdge(actor, run.workspaceId, { source_node_id: sourceId, target_node_id: target, edge_type: edge.edge_type, status }))) run.report.skipped.links++;
        }
      }
    });
  }

  // ── Paragraph anchors: the restored note has the backed-up text, so the spans still fit ──
  for (let at = 0; at < made.length; at += LINK_BATCH) {
    await batch(run, async () => {
      for (const item of made.slice(at, at + LINK_BATCH)) {
        const full = await run.reader.readNote(item.id);
        if (full.link_bindings?.length) await restoreBackupBindings(run.workspaceId, run.createdIds.get(item.id)!, full.link_bindings);
        if (!full.anchors?.length) continue;
        // The text as it was restored (links to media may have been rewritten), not the backup's.
        const id = run.createdIds.get(item.id)!;
        const body = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]?.markdown;
        if (typeof body === "string") await restoreBackupAnchors(run.workspaceId, id, body, full.anchors);
      }
    });
  }

  // ── Board positions ──
  const cardsBySurface = new Map<string, BoardCard[]>();
  // A board's section frames travel in its own `_canvas_sections` attribute; they are user-drawn, so they are written back
  // through applyBoardChanges below (same permission, event and transaction as the cards).
  const sectionsBySurface = new Map<string, BoardSection[]>();
  for (const item of made) {
    const nodeId = run.createdIds.get(item.id)!;
    const full = await run.reader.readNote(item.id);
    const sections = backedUpSections(full.attributes);
    if (sections.length > 0) sectionsBySurface.set(nodeId, sections);
    for (const p of full.positions ?? []) {
      const surface = typeof p.surface === "string" ? run.ids.get(p.surface) : undefined;
      if (!surface) { run.report.skipped.positions++; continue; }
      const sub = typeof p.sub_canvas_id === "string" ? run.ids.get(p.sub_canvas_id) ?? null : null;
      cardsBySurface.set(surface, [...(cardsBySurface.get(surface) ?? []), {
        nodeId, x: Number(p.x), y: Number(p.y), width: p.width as number | null, height: p.height as number | null,
        color: p.color as string | null, folded: p.folded === true, subCanvasId: sub,
      }]);
    }
  }
  for (const surface of sectionsBySurface.keys()) if (!cardsBySurface.has(surface)) cardsBySurface.set(surface, []);
  const boards = [...cardsBySurface].flatMap(([surface, cards]) => {
    const slices: Array<[string, BoardCard[]]> = [];
    for (let at = 0; at < Math.max(cards.length, 1); at += LINK_BATCH) slices.push([surface, cards.slice(at, at + LINK_BATCH)]);
    return slices;
  });
  const sectionsLeft = new Map(sectionsBySurface);
  for (const [index, [surface, cards]] of boards.entries()) {
    // The sections go with the board's first slice only.
    const sections = sectionsLeft.get(surface) ?? [];
    sectionsLeft.delete(surface);
    await progress("positions", index, boards.length);
    await batch(run, async (actor) => {
      const kind = (await q<{ node_type: "content" | "canvas" | "class_tag" }>(`SELECT node_type FROM content_nodes WHERE id = $1 AND ${liveNodeSql()} AND node_type IN ('content', 'canvas', 'class_tag')`, [surface])).rows[0]?.node_type;
      if (!kind || !await tryWrite(() => applyBoardChanges(actor, run.workspaceId, { id: surface, node_type: kind }, { upsertCards: cards, removeCards: [], upsertSections: sections, removeSections: [] }))) {
        run.report.skipped.positions += cards.length + sections.length;
      }
    });
  }

  // ── Deleted in the backup: deleted again, so they sit in History ──
  const deleted = notes.filter((i) => i.deleted && run.createdIds.has(i.id));
  for (let at = 0; at < deleted.length; at += RESTORE_BATCH) {
    await progress("deleted", at, deleted.length);
    await batch(run, async (actor) => {
      for (const item of deleted.slice(at, at + RESTORE_BATCH)) {
        const id = run.createdIds.get(item.id)!;
        const live = await q(`SELECT 1 FROM content_nodes WHERE id = $1 AND ${liveNodeSql()}`, [id]);
        if (!live.rows.length) continue;
        await trashNode(actor, run.workspaceId, id, { uiContext: "backup.restore" });
        run.report.deleted_again++;
      }
    });
  }

  // ── Slugs of the notes now in the trash, then every note's `[[links]]` ──
  // A deleted note holds no slug among live notes, so it gets the slug it had.
  for (let at = 0; at < deleted.length; at += LINK_BATCH) {
    await batch(run, async () => {
      for (const item of deleted.slice(at, at + LINK_BATCH)) {
        const full = await run.reader.readNote(item.id);
        if (full.slug && !item.task) await db.updateTable("content_nodes").set({ slug: full.slug }).where("id", "=", run.createdIds.get(item.id)!).where("deleted_at", "is not", null).execute();
      }
    });
  }
  for (let at = 0; at < made.length; at += LINK_BATCH) {
    await progress("links", at, made.length);
    await batch(run, async () => {
      const links: RestoredLinks[] = [];
      for (const item of made.slice(at, at + LINK_BATCH)) {
        const full = await run.reader.readNote(item.id);
        const copy = run.plan.notes.get(item.id)?.kind === "copy";
        links.push({
          id: run.createdIds.get(item.id)!, deleted: item.deleted,
          targets: full.wikilinks && !copy ? full.wikilinks.map((target) => run.ids.get(target)).filter((target): target is string => !!target) : undefined,
        });
      }
      await settleWikilinkEdges(run.workspaceId, links);
    });
  }

  // ── A move: what no note holds (review progress, subscriptions, settings, the site) ──
  const moved = run.moved;
  if (moved) {
    await batch(run, async (actor) => {
      const empty: ExtrasImport = { review: 0, focus: 0, rss: 0, prefs: 0, moduleSettings: 0, modules: false, site: false, functionsLeftOut: 0 };
      const { functionsLeftOut, ...carried } = run.reader.extras ? await importExtras(run.workspaceId, actor.id, run.reader.extras, run.ids, moved.spaces.map, run.owner) : empty;
      run.report.skipped.functions += functionsLeftOut;
      run.report.moved = {
        spaces_created: moved.spaces.created, need_reinvite: moved.spaces.needReinvite, carried, cleared: moved.cleared,
        not_moved: notMovedFor(run.reader.historyNoteIds.size > 0), history: run.history,
      };
    });
  }
}

/** The session's parent note: the one an earlier import of the same session made (`spec.id`, still live in the target
 *  space and writable under), or a new one — with that id when it is free, so the next import finds it. */
async function ensureParentNote(run: RestoreRun, actor: ActorCtx, spec: RestoreParentNote): Promise<string> {
  if (spec.id) {
    if (await parentNoteExists(run.workspaceId, run.spaceId, spec.id) && await placeable(run, actor, spec.id)) return spec.id;
  }
  const taken = spec.id ? !!await db.selectFrom("content_nodes").select("id").where("id", "=", spec.id).executeTakeFirst() : true;
  const made = await createNote({
    actor, workspaceId: run.workspaceId, ...(taken ? {} : { id: spec.id! }), title: spec.title, markdown: "", parentId: null, spaceId: run.spaceId,
    event: { uiContext: "backup.restore", payload: { restored_parent_note: true } },
  });
  return String(made.node.id);
}

/** Where a note goes under the session's parent note: below `wantParent` when that is a note this restore made or one
 *  already under the parent note, otherwise straight under the parent note. */
async function placeUnderParentNote(run: RestoreRun, actor: ActorCtx, wantParent: string | null): Promise<string | null> {
  const wrapId = run.wrap!.id!;
  if (!wantParent || wantParent === wrapId) return wrapId;
  const under = [...run.createdIds.values()].includes(wantParent) || await isUnder(run.workspaceId, wantParent, wrapId);
  return (under && await placeable(run, actor, wantParent)) || wrapId;
}

/** Where a restored note may go under `parentId`: a live note (not a tag)
 *  IN THE TARGET SPACE that the restorer may write under; otherwise null,
 *  the root of the target. A current note of another space never takes a
 *  restored child or copy: everything lands in the space the person chose. */
async function placeable(run: RestoreRun, actor: ActorCtx, parentId: string | null): Promise<string | null> {
  if (!parentId) return null;
  const row = (await q<{ node_type: string; space_id: string | null }>(
    `SELECT node_type, space_id::text FROM content_nodes WHERE id = $1 AND workspace_id = $2 AND ${liveNodeSql()}`, [parentId, run.workspaceId])).rows[0];
  if (!row || isTag(row) || !run.landing.has(row.space_id ?? "")) return null;
  try {
    return (await canPlaceUnder(actor, run.workspaceId, parentId)) ? parentId : null;
  } catch (error) {
    if (isRefusal(error)) return null;
    throw error;
  }
}

/** The newest creation time among the notes that already reference an
 *  ownerless file `item` names (ownerlessReferences), or null. The restored
 *  note is stored just after it if the backup dates it earlier, so it is
 *  never that file's oldest reference. */
function newestOwnerlessReference(run: RestoreRun, item: Item): string | null {
  const latest = item.refs.map((m) => run.ownerless.get(m)).filter((t): t is string => !!t);
  return latest.length ? latest.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b)) : null;
}

async function restoreNote(run: RestoreRun, actor: ActorCtx, item: Item): Promise<void> {
  const { plan, report, ids, createdIds, reader, workspaceId, spaceId } = run;
  const action = plan.notes.get(item.id)!;
  if (action.kind === "unchanged") { report.unchanged++; return; }
  if (action.kind === "in_history") { report.in_history++; return; }
  if (action.kind === "supersede") {
    const newer = await reader.readNote(item.id);
    const restored = restoredBody(remapText(newer.markdown, ids), newer.anchors);
    await updateNode(workspaceId, action.currentId, { title: newer.title, markdown: restored.markdown }, {
      actor, adoptAnchors: restored.adopt,
      event: { uiContext: "backup.restore", cascadeLabel: "backup.restore.cascade", backupPrefix: "NODE_UPDATED" },
    });
    report.superseded++;
    return;
  }
  let lineTaskFallback = false;
  if (action.kind === "line_task") {
    // The host's body made the task again; give it what Tasks held (every `_task_*`
    // field, so a status, a time or a finish the line does not carry comes back too).
    const hostId = createdIds.get(item.parent_id!);
    const full = await reader.readNote(item.id);
    const derived = hostId && full.task?.line_ref ? (await q<{ task_id: string }>(
      `SELECT task_id::text FROM block_nodes WHERE note_id = $1 AND block_ref = $2 AND task_id IS NOT NULL`, [hostId, run.anchorRemap.get(`${hostId}:${full.task.line_ref}`) ?? full.task.line_ref])).rows[0]?.task_id : undefined;
    if (derived) {
      ids.set(item.id, derived);
      report.skipped.attributes += await reconcileTaskFields(actor, workspaceId, derived, full.attributes, tryWrite);
      // The task made from the line has its title; what was written under it since (a body, tags, attributes) comes back too.
      await restoreTaskBody(run, actor, derived, full);
      await restoreOwnContent(run, actor, item, action, full, derived);
      await stampTimes(run, item, full, derived);
      createdIds.set(item.id, derived);
      report.created++;
      report.tasks++;
      return;
    }
    // Its line is gone from the host's body (a task taken out of the note sits in the trash):
    // it comes back as a task under its host, like one made in Tasks, not lost.
    if (!hostId) { report.skipped.tasks++; return; }
    lineTaskFallback = true;
  }
  const full = await reader.readNote(item.id);
  const newId = action.kind === "line_task" ? randomUUID() : action.id;
  if (action.kind === "line_task") ids.set(item.id, newId);
  const wantParent = action.kind === "copy" ? action.currentParentId : item.parent_id ? ids.get(item.parent_id) ?? item.parent_id : null;
  // With a parent note every note and copy goes under it; a task of a note keeps its host (it needs one).
  const parentId = run.wrap && !item.task && action.kind !== "line_task"
    ? await placeUnderParentNote(run, actor, action.kind === "copy" ? null : wantParent)
    : await placeable(run, actor, wantParent);
  // Where it lives: a move puts it back in its own space; the other modes in the one chosen.
  const noteSpace = run.moved?.spaces.map.get(full.space_id ?? "") ?? spaceId;

  // A task with no host note (a standalone task) comes back through
  // createNote like a note: its body, every `_task_*` field and its other
  // tags and attributes are its own; only #task and the fields are system rows.
  const standalone = !!item.task && !item.parent_id && !lineTaskFallback;
  if (item.task && !standalone) {
    // A task made in Tasks: a task again, under its host.
    if (!parentId) { report.skipped.tasks++; return; }
    // Made with its status and rule as the backup has them: not through the
    // update, which would mint the next occurrence of a finished repeating
    // task that the backup already holds.
    const fields = taskFieldsOfAttributes(full.attributes);
    await createTaskNode({ ...fields, workspaceId, actor, hostId: parentId, spaceId: noteSpace, id: newId, title: full.title, uiContext: "backup.restore" });
    // Its body, tags and the other attributes were written on the task node itself: they come back with it.
    await restoreTaskBody(run, actor, newId, full);
    await restoreOwnContent(run, actor, item, action, full, newId);
  } else {
    const sourceType = ["manual", "rss", "ai"].includes(full.source_type) ? full.source_type : "manual";
    const restored = restoredBody(remapText(full.markdown, ids), full.anchors);
    if (standalone) {
      await createStandaloneTask({
        actor, workspaceId, id: newId, title: full.title, markdown: remapText(full.markdown, ids), spaceId: noteSpace,
        fields: Object.fromEntries(full.attributes.filter((a) => a.key.startsWith("_task_")).map((a) => [a.key, a.value])),
        uiContext: "backup.restore", payload: { restored_from_backup: item.id },
      });
    } else await createNote({
      actor, workspaceId, id: newId,
      title: action.kind === "copy" ? `${full.title}（備份 ${run.backupDay}）` : full.title,
      markdown: restored.markdown, adoptAnchors: restored.adopt,
      // The whiteboard is a tab of a note (migration 138). A backup from
      // before it holds the board as a note of kind 'canvas': it comes back as
      // a plain note with the tab; a newer one carries the tab in its views.
      // Every saved view of the note comes back the same way (restoreNoteViews); the strokes of a 「手寫」 tab are the
      // note's own attribute and come back with its attributes.
      ...(needsLegacyBoardTab(full) || full.views?.length ? { within: async () => {
        if (needsLegacyBoardTab(full)) await addWhiteboardTab(newId, { opensFirst: true });
        const views = await restoreNoteViews(workspaceId, newId, full.views ?? [], run.ids);
        report.views += views.written;
        report.skipped.views += views.leftOut;
      } } : {}),
      // No parent in the target space: its root, never another space.
      // A note in the trash is made with a throwaway slug (it is deleted at the end and gets its own then);
      // a live one keeps the slug it had when that is free.
      ...(item.deleted ? { slug: `restoring-${newId}` } : action.kind === "create" && full.slug ? { preferredSlug: full.slug } : {}),
      sourceType, parentId, spaceId: parentId ? null : noteSpace,
      // A restored note keeps the place on the site the backup gave it (restoreSystemAttrs), never a new note's default.
      siteDefault: false,
      hidden: full.hidden, ...(isValidOrderKey(full.order_key) ? { orderKey: full.order_key } : {}),
      event: { uiContext: "backup.restore", payload: { restored_from_backup: item.id } },
    });
    if (restored.adopt.length + restored.known.length > 0) {
      const have = await noteAnchorRanges(workspaceId, newId);
      for (const adopt of [...restored.adopt, ...restored.known]) {
        const here = have.find((a) => a.from === adopt.at);
        if (here && here.id !== adopt.anchorId) run.anchorRemap.set(`${newId}:${adopt.anchorId}`, here.id);
      }
    }
    await restoreOwnContent(run, actor, item, action, full, newId);
  }
  await stampTimes(run, item, full, newId);
  createdIds.set(item.id, newId);
  if (item.task) report.tasks++;
  if (action.kind === "copy") report.copies++; else report.created++;
}

/** The body of a task node (a task of a note is made with an empty one): written through the ordinary update, as a
 *  superseded note's is, with the links and anchors the restore re-pointed. */
async function restoreTaskBody(run: RestoreRun, actor: ActorCtx, taskId: string, full: BackupNote): Promise<void> {
  if (!full.markdown) return;
  const body = restoredBody(remapText(full.markdown, run.ids), full.anchors);
  await updateNode(run.workspaceId, taskId, { markdown: body.markdown }, {
    actor, adoptAnchors: body.adopt,
    event: { uiContext: "backup.restore", cascadeLabel: "backup.restore.cascade", backupPrefix: "NODE_UPDATED" },
  });
}

/** The attributes a person set on a backed-up node, written by the same writer a person's edit uses (a refused one is
 *  counted, the rest go on). A note's and a tag page's alike: a tag page's whiteboard keeps its pen layer (`board_ink`) here. */
async function restoreBackedUpAttributes(actor: ActorCtx, workspaceId: string, nodeId: string, attributes: BackupNote["attributes"], ids: Map<string, string>, report: RestoreReport): Promise<void> {
  for (const a of attributes.filter(restoredAttribute)) {
    const value = a.value_type === "node_ref" ? withRestoredIds(a.value, ids) : a.value;
    const ok = await tryWrite(() => setNodeAttribute({ workspaceId, actor, nodeId, attribute: {
      key: a.key, value, value_type: a.value_type as "text", is_inheritable: a.is_inheritable,
    }, existingKey: true }));
    if (!ok) report.skipped.attributes++;
  }
}

/** What a restored note or task carries besides its title and body, written by the same writers a person's edits use
 *  (each refused write is counted, the restore goes on): its tags, the attributes a person set, the system ones that
 *  belong to it, the page design of a move, and the `_task_*` values an ordinary note keeps. */
async function restoreOwnContent(run: RestoreRun, actor: ActorCtx, item: Item, action: NoteAction, full: BackupNote, newId: string): Promise<void> {
  const { plan, report, ids, workspaceId } = run;
  const tagFor = async (backupTagId: string): Promise<string | null> => {
    const mapped = run.tagIds.get(backupTagId);
    if (mapped) return mapped;
    if (run.itemIds.has(backupTagId)) return null;
    const live = await q(`SELECT 1 FROM content_nodes WHERE id = $1 AND workspace_id = $2 AND ${liveTagNodeSql()}`, [backupTagId, workspaceId]);
    return live.rows.length ? backupTagId : null;
  };
  for (const backupTagId of full.tags) {
    const tagKind = plan.tags.get(backupTagId)?.kind;
    if (tagKind === "tasks_tag" || tagKind === "review_tag") continue;
    const tagId = await tagFor(backupTagId);
    if (!tagId || !await tryWrite(() => applyTagToNode({ workspaceId, actor, nodeId: newId, tagId }))) report.skipped.tags++;
  }
  // A note that was a review card itself (the backup says so) or through a tag of an old backup (migration 195) is a card of its own.
  if (!full.hidden && (full.review_card === true || full.tags.some((backupTagId) => plan.cardTags.has(backupTagId)))) {
    await tryWrite(() => reviewSeam()?.markCards({ workspaceId, holders: [{ kind: "node", id: newId }], actorId: actor.id, via: "restore" }) ?? Promise.resolve());
  }
  await restoreBackedUpAttributes(actor, workspaceId, newId, full.attributes, ids, report);
  report.skipped.attributes += await restoreSystemAttrs(actor, workspaceId, newId, full.attributes,
    // A task is not on the site and has no 「備份」 copy of a live note beside it: it keeps what it had.
    { withPerson: !!run.moved, published: !item.task && (action.kind !== "create" || action.alongside) ? "always_off" : item.deleted ? "off_only" : "as_backed" }, tryWrite);
  // A move brings the page design (the site's look) as well.
  if (run.moved && full.presentation && typeof full.presentation === "object") {
    await db.updateTable("content_nodes").set({ presentation: JSON.stringify(full.presentation) }).where("id", "=", newId).execute();
  }
  // A note keeps its `_task_*` values (done state and dates); setNodeAttribute refuses `_` keys, so they are
  // written as the Tasks page writes them.
  if (!full.hidden) {
    for (const a of full.attributes.filter((x) => NOTE_TASK_VALUES[x.key]?.(x.value))) {
      const ok = await tryWrite(() => recordAttributeChange({
        workspaceId, nodeId: newId, key: a.key, actor, next: { value: a.value }, rule: "always",
        authority: { kind: "node", nodeId: newId, op: "set_attribute" }, uiContext: "backup.restore",
      }));
      if (!ok) report.skipped.attributes++;
    }
  }
}

/** Keep when it was written, not when it was restored — but never older
 *  than a note that already references an ownerless file it names (D1). */
async function stampTimes(run: RestoreRun, item: Item, full: BackupNote, id: string): Promise<void> {
  await q(
    `UPDATE content_nodes SET created_at = GREATEST($2::timestamptz, $4::timestamptz + interval '1 millisecond'),
                              updated_at = GREATEST($3::timestamptz, $2::timestamptz, $4::timestamptz + interval '1 millisecond')
      WHERE id = $1`,
    [id, full.created_at, full.updated_at, newestOwnerlessReference(run, item)]);
}
