// What a permanent delete erases beyond the note rows themselves — the part of
// services/nodeTrash.ts purgeDeleted that finds a note's content wherever else
// the server kept it. Each function runs inside purgeDeleted's NODES_PURGED
// transaction, under the workspace's event lock; none checks authority (the
// purge did) and none is called from anywhere else
// (test/nodeLifecycleOwner.test.ts).
//
// Where a note's content lives besides content_nodes and the rows that
// cascade from it (attributes, tags, edges, block nodes, positions, review
// state, embeddings, pointers):
//   - the event log: its events' payloads (title, field values, body hashes)
//     and tx_meta (inverse patches, earlier values). They are erased in place
//     to {"purged": true} (migration 118), not deleted: event ids, cause
//     links and the sync cursor stay as they were, and nothing else in the
//     log points at a hole;
//   - blobs: its saved versions and large field values, content-addressed
//     and shared by hash. A blob goes when no remaining event references it;
//   - uploaded files (media/<file>): a file goes when no remaining note —
//     live or deleted — nor a remaining saved version references it;
//   - the outbox and the dispatcher queue: pending backup copies of its body
//     (git_commit / github_backup) and queued work about it;
//   - AI suggestions about it.
//   - stored publish snapshots (forgetNodesInSnapshots, at the end): the frozen
//     copy of a note that was published before it was deleted. Here rather
//     than in modules/website/publishing/: the publishing domain reaches nodeTrash.ts
//     (servedSite → publishedSet → nodeTrash), so the purge calling into its
//     entry would close an import cycle. It removes by id; the website module then
//     makes the text that named the note inert again (excerpts, field values, table
//     cells) through the snapshotPurged hook; the payload's layout stays the
//     publishing domain's.

import { mediaRefs, mediaUrl } from "@onden/markdown";
import { q } from "../db.js";
import { sql } from "kysely";
import { db } from "../dbKysely.js";
import { NODE_TARGET_TYPES } from "./eventTargets.js";
import { removeMediaFiles } from "./media.js";
import { presentationText } from "./mediaOwners.js";
import { recordSnapshotMedia } from "./snapshotMedia.js";
import { modulesSnapshotPurged } from "../spine/nodeHooks.js";

/** The payload and tx_meta an erased event keeps (migration 118 allows no other). */
export const PURGED_MARKER = { purged: true } as const;

/** Every place an event can name a blob (keep in step with
 *  maintenance/prune.ts collectOrphanBlobs; both also keep what a version names, note_versions.content_hash). */
const BLOB_REFS_SQL = (e: string) => `ARRAY[
  ${e}.payload->>'body_hash',
  ${e}.payload->>'value_ref',
  ${e}.tx_meta->'prev_field_values'->>'value_ref',
  ${e}.payload->>'incoming_value_ref',
  ${e}.payload->>'overridden_value_ref',
  ${e}.payload->>'submitted_value_ref']`;

/** Events (aliased `e`) about the notes `ids` ($2): those that target one
 *  (a target type of $3), and edge events that name one as an end. The
 *  caller filters the workspace ($1). */
const aboutNotesSql = (e: string) => `(
    (${e}.target_type = ANY($3::text[]) AND ${e}.target_id = ANY($2::text[]))
    OR (${e}.target_type = 'edge' AND (${e}.payload->>'source_node_id' = ANY($2::text[])
                                     OR ${e}.payload->>'target_node_id' = ANY($2::text[]))))`;

export type PurgedContent = {
  /** Blob hashes the notes' events reference (versions, large values). */
  hashes: string[];
  /** Saved versions of the notes' bodies (events carrying a body). */
  versions: number;
  /** Uploaded files the notes reference now or in a saved version. */
  mediaFiles: string[];
};

/** What the notes `ids` hold outside their rows — read before anything is
 *  erased. Also what the confirmation counts. */
export async function purgedContent(workspaceId: string, ids: readonly string[]): Promise<PurgedContent> {
  if (ids.length === 0) return { hashes: [], versions: 0, mediaFiles: [] };
  const refs = await q<{ hash: string }>(
    `SELECT DISTINCT r.hash
       FROM domain_events e, unnest(${BLOB_REFS_SQL("e")}) AS r(hash)
      WHERE e.workspace_id = $1 AND ${aboutNotesSql("e")} AND r.hash IS NOT NULL`,
    [workspaceId, ids, NODE_TARGET_TYPES],
  );
  // and the content of their versions (a baseline has no event): it goes with them unless something else still needs it
  const versionRefs = await sql<{ hash: string }>`
    SELECT DISTINCT content_hash AS hash FROM note_versions WHERE workspace_id = ${workspaceId}::uuid AND note_id = ANY(${[...ids]}::uuid[]) AND content_hash IS NOT NULL`.execute(db);
  const hashes = [...new Set([...refs.rows, ...versionRefs.rows].map((r) => r.hash))];
  const versions = (await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM domain_events
      WHERE workspace_id = $1 AND target_type = ANY($3::text[]) AND target_id = ANY($2::text[])
        AND payload ? 'body_hash'`,
    [workspaceId, ids, NODE_TARGET_TYPES],
  )).rows[0]?.n ?? "0";

  const texts: string[] = [];
  const rows = await q<{ title: string; markdown: string | null; presentation: unknown }>(
    `SELECT title, markdown, presentation FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
    [workspaceId, ids],
  );
  for (const row of rows.rows) texts.push(row.title, row.markdown ?? "", presentationText(row.presentation));
  const attrs = await q<{ value: string }>(
    `SELECT value FROM node_attributes WHERE workspace_id = $1 AND node_id = ANY($2::uuid[]) AND value IS NOT NULL`,
    [workspaceId, ids],
  );
  for (const row of attrs.rows) texts.push(row.value);
  if (hashes.length > 0) {
    // Only versions that name an upload at all: drawings can be megabytes.
    const blobs = await q<{ content: string }>(
      `SELECT content FROM blobs WHERE hash = ANY($1::text[]) AND strpos(content, $2) > 0`, [hashes, mediaUrl("")]);
    for (const row of blobs.rows) texts.push(row.content);
  }
  // Files the notes own without any text naming them: a published handwriting
  // page (modules/website/publishing/handwritingPages.ts) is named by the
  // snapshot, not by a body. The delete below sets node_id to NULL, so this
  // is the last moment they can be found.
  const owned = await q<{ filename: string }>(
    `SELECT filename FROM media_uploads WHERE workspace_id = $1 AND node_id = ANY($2::uuid[])`, [workspaceId, ids]);
  const mediaFiles = [...new Set([...texts.flatMap((text) => mediaRefs(text)), ...owned.rows.map((r) => r.filename)])].sort();
  return { hashes, versions: Number(versions), mediaFiles };
}

/** Of `files`, those still referenced once `ids` and the blobs in
 *  `goingHashes` are gone: by another note (live or deleted: its body, a
 *  field value, its page design) or by a saved version that stays. */
export async function mediaStillReferenced(
  workspaceId: string, files: readonly string[], ids: readonly string[], goingHashes: readonly string[],
): Promise<Set<string>> {
  if (files.length === 0) return new Set();
  // $5 || file: the reference as notes write it (/api/media/<file>).
  const r = await q<{ file: string }>(
    `SELECT f.file FROM unnest($2::text[]) AS f(file)
      WHERE EXISTS (SELECT 1 FROM content_nodes n
                     WHERE n.workspace_id = $1 AND n.id <> ALL($3::uuid[])
                       AND (strpos(lower(coalesce(n.markdown, '')), lower($5 || f.file)) > 0
                            OR strpos(lower(n.title), lower($5 || f.file)) > 0
                            OR strpos(lower(coalesce(n.presentation::text, '')), lower($5 || f.file)) > 0))
         OR EXISTS (SELECT 1 FROM node_attributes a
                     WHERE a.workspace_id = $1 AND a.node_id <> ALL($3::uuid[])
                       AND strpos(lower(coalesce(a.value, '')), lower($5 || f.file)) > 0)
         -- a saved version that stays: the file name alone (random hex, so
         -- unambiguous) keeps this a plain scan over large drawing blobs
         OR EXISTS (SELECT 1 FROM blobs b
                     WHERE b.hash <> ALL($4::text[])
                       AND strpos(b.content, f.file) > 0)`,
    [workspaceId, files, ids, goingHashes, mediaUrl("")],
  );
  return new Set(r.rows.map((row) => row.file));
}

/** Erase the events about `ids` to PURGED_MARKER (migration 118's one
 *  allowed update), leaving id, type, target, actor, time and cause link.
 *  The opt-in is switched on for these statements only. Returns how many
 *  events were erased. */
export async function eraseEventsAbout(workspaceId: string, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  // On for this statement only (an error aborts the transaction, which ends
  // the setting with it).
  await q(`SELECT set_config('myapp.allow_event_redact', 'on', true)`);
  const r = await q(
    `UPDATE domain_events e SET payload = $4::jsonb, tx_meta = $4::jsonb
      WHERE e.workspace_id = $1 AND ${aboutNotesSql("e")} AND NOT (e.payload = $4::jsonb AND e.tx_meta = $4::jsonb)`,
    [workspaceId, ids, NODE_TARGET_TYPES, JSON.stringify(PURGED_MARKER)],
  );
  await q(`SELECT set_config('myapp.allow_event_redact', 'off', true)`);
  return r.rowCount ?? 0;
}

/** Remove queued work about `ids`: outbox effects (a pending backup copy
 *  carries the body as `node_id` + `markdown`; a semantic `embed` intent
 *  carries it as `nodeId` + `text`), whatever their status (done and dead rows
 *  keep their payload too), dispatcher intents and AI suggestions. (An RSS
 *  fetch names a subscription, not a note: nothing in it is a note's content.) */
export async function dropQueuedWorkAbout(workspaceId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await q(
    `DELETE FROM outbox WHERE workspace_id = $1
        AND (payload->>'node_id' = ANY($2::text[]) OR payload->>'nodeId' = ANY($2::text[]))`,
    [workspaceId, ids]);
  await q(`DELETE FROM dispatcher_pending WHERE workspace_id = $1 AND node_id = ANY($2::uuid[])`, [workspaceId, ids]);
  await q(`DELETE FROM ai_suggestions WHERE workspace_id = $1 AND target_type = 'node' AND target_id = ANY($2::uuid[])`,
    [workspaceId, ids]);
}

/** Delete the blobs of `hashes` that no remaining event references (any
 *  workspace: blobs are shared by content). Call after eraseEventsAbout.
 *  A blob shared with another note's history stays. Returns the hashes
 *  deleted.
 *
 *  Not covered: another write of byte-identical content that put its blob
 *  before this transaction and commits its event after it (putBlob runs
 *  outside the event lock, services/blobs.ts). That version would point at
 *  a missing blob; the other note's body itself is unaffected. */
export async function deleteUnreferencedBlobs(hashes: readonly string[]): Promise<string[]> {
  if (hashes.length === 0) return [];
  const referenced = await q<{ hash: string }>(
    `SELECT DISTINCT r.hash FROM domain_events e, unnest(${BLOB_REFS_SQL("e")}) AS r(hash)
      WHERE r.hash = ANY($1::text[])
     UNION SELECT v.content_hash FROM note_versions v WHERE v.content_hash = ANY($1::text[])`,
    [hashes],
  );
  const keep = new Set(referenced.rows.map((row) => row.hash));
  const going = hashes.filter((hash) => !keep.has(hash));
  if (going.length === 0) return [];
  const r = await q<{ hash: string }>(`DELETE FROM blobs WHERE hash = ANY($1::text[]) RETURNING hash`, [going]);
  return r.rows.map((row) => row.hash);
}

/** Forget the uploaded files in `files` that nothing references any more
 *  (mediaStillReferenced, read after the rows and blobs went): their upload
 *  and import records go in this transaction, the files on disk once it
 *  commits. A file still referenced elsewhere stays; if a purged note owned
 *  it (media_uploads.node_id, set to NULL by the delete), the oldest note
 *  still referencing it owns it now, so its readers keep reading it.
 *  Returns how many files go. */
export async function forgetUnreferencedMedia(
  workspaceId: string, files: readonly string[], ids: readonly string[], goneHashes: readonly string[],
): Promise<number> {
  if (files.length === 0) return 0;
  const kept = await mediaStillReferenced(workspaceId, files, ids, goneHashes);
  const going = files.filter((file) => !kept.has(file));
  for (const file of kept) {
    await q(
      `UPDATE media_uploads m SET node_id = (
         SELECT n.id FROM content_nodes n
          WHERE n.workspace_id = m.workspace_id
            AND (strpos(lower(coalesce(n.markdown, '')), lower($3)) > 0
                 OR strpos(lower(coalesce(n.presentation::text, '')), lower($3)) > 0
                 OR EXISTS (SELECT 1 FROM node_attributes a WHERE a.node_id = n.id AND strpos(lower(coalesce(a.value, '')), lower($3)) > 0))
          ORDER BY n.created_at, n.id LIMIT 1)
        WHERE m.workspace_id = $1 AND m.filename = $2 AND m.node_id IS NULL`,
      [workspaceId, file, mediaUrl(file)],
    );
  }
  if (going.length === 0) return 0;
  await removeMediaFiles(workspaceId, going);
  return going.length;
}

/** Take permanently deleted notes out of every stored publish snapshot of
 *  the workspace (services/nodeTrash.ts purgeDeleted), inside the purge's
 *  transaction. The served site already leaves a deleted note out
 *  (servedSite.applyTakedown), but the snapshot rows still held its frozen
 *  title, body and fields; after this no stored snapshot names it: its page,
 *  the edges touching it, a home
 *  pointing at it, and any presentation entry (a nav item, a block binding)
 *  that refers to it by id. The served output does not change — the note was
 *  already off the site — so nothing is pushed again. Returns how many
 *  snapshots were rewritten. */
export async function forgetNodesInSnapshots(workspaceId: string, nodeIds: readonly string[]): Promise<number> {
  if (nodeIds.length === 0) return 0;
  const gone = new Set(nodeIds);
  const rows = await q<{ id: string; payload: Record<string, unknown> }>(
    `SELECT id::text, payload FROM publish_snapshots
      WHERE workspace_id = $1
        AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS gone(id) WHERE strpos(payload::text, gone.id) > 0)
      FOR UPDATE`,
    [workspaceId, [...gone]],
  );
  for (const row of rows.rows) {
    const next = withoutNodes(row.payload, gone);
    await modulesSnapshotPurged({ workspaceId, payload: next });
    await q(
      `UPDATE publish_snapshots
          SET payload = $2,
              home_node_id = CASE WHEN home_node_id = ANY($3::uuid[]) THEN NULL ELSE home_node_id END
        WHERE id = $1`,
      [row.id, next, [...gone]],
    );
    await recordSnapshotMedia(row.id, next);
  }
  return rows.rows.length;
}

/** `payload` without anything about `gone` (forgetNodesInSnapshots). Pure. */
export function withoutNodes(payload: Record<string, unknown>, gone: ReadonlySet<string>): Record<string, unknown> {
  const refersToGone = (value: unknown): boolean => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    return ["id", "node_id", "source_node_id", "target_node_id", "home_node_id"]
      .some((key) => typeof row[key] === "string" && gone.has(row[key] as string))
      || refersToGone(row.binding);
  };
  // Arrays drop entries that name a gone note; objects drop keys that are a
  // gone note's id and fields that point at one (home_node_id).
  const scrub = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.filter((item) => !refersToGone(item)).map(scrub);
    if (!value || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (gone.has(key)) continue;
      if (typeof inner === "string" && gone.has(inner)) { out[key] = null; continue; }
      out[key] = scrub(inner);
    }
    return out;
  };
  return scrub(payload) as Record<string, unknown>;
}
