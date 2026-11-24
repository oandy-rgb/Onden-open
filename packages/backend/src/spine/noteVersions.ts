// A note's versions, with an identity every node will share (docs/architecture/proposals/history-replication-2026-11-22.md §2, §4.1, §4.4;
// migration 220). Batch 1: minted and stored here, read by nobody yet, sent nowhere.
//
// The contract of a write that changes a note's title or text, or one of its drawings (unit = the attribute key):
//   1. store the content first, as today (services/blobs.ts putBlob, or encodeSnapshot for a drawing: putBlob / putInkChunks);
//   2. in the write's own transaction, inside the root write (mutate: the transaction's stamp), call recordVersion with that hash.
// At COMMIT the database checks two things (migration 220): every version minted here names content that is stored, or the transaction
// fails (note_versions_content_stored); and a root write that changed a note's title or text, or a drawing, without minting its version is
// counted in sync_clock.version_misses (not refused in this batch: existing tests write notes with raw SQL inside root writes; the version tests
// assert the count stays 0 on every production path). Both stand aside where nothing is minted on purpose (note_version_exempt): a snapshot
// join and a merge (what is written there was minted elsewhere), the shell and data migrations (onden.no_versions), a write outside the roots.
//
//   const hash = await putBlob(markdown);                          // before the transaction, its own connection
//   … mutate({ …, apply: async () => { await write(); await recordVersion({ workspaceId, noteId, unit: "body", contentHash: hash, kind: "updated", title }); } })
//
// Why the program mints and the database only checks (review of PR #1935, round 2, point 1): a trigger cannot store the content (the blob
// upsert must commit on its own connection, services/blobs.ts) and would hash a drawing of up to 30 MB in SQL on every stroke; the writer has
// already stored the content and computed its hash, so minting here adds rows, not hashing.
import { sql } from "kysely";
import { analyzeTablesOfLargeWrite, planThisTransactionForTablesAsTheyAre } from "../db.js";
import { db } from "../dbKysely.js";
import { atDoubling, sha256Hex } from "../utils.js";
import { countSyncClockExceptions } from "./stamps.js";

/** What a version is of: the note's body (title and text) or one of its drawings, by attribute key. */
export type VersionUnit = "body" | "ink_data" | "board_ink" | "note_ink";
/** How a version came to be (migration 220 note_versions.kind; 'merged' and 'baseline' are minted elsewhere). */
type VersionKind = "created" | "updated" | "restored" | "set_aside" | "removed";
const INK_UNITS: readonly VersionUnit[] = ["ink_data", "board_ink", "note_ink"];
/** The attribute keys whose values are versioned drawings (the units besides 'body'). */
export const isVersionedInkKey = (key: string): key is VersionUnit => (INK_UNITS as readonly string[]).includes(key);

type NewVersion = {
  workspaceId: string;
  noteId: string;
  unit: VersionUnit;
  /** The content as stored: blobs.hash for a body, the value_ref for a drawing; null only for a removed drawing. */
  contentHash: string | null;
  kind: VersionKind;
  /** The note's title with this body (a drawing: none). */
  title?: string | null;
  /** The version_key of the version this one puts back (same note, same unit). */
  restoredFrom?: string | null;
};

/** Whether this note has a version list: a note, a board or a tag's description, not a system note (migration 220 note_version_in_scope, widened to tags by 231: the one rule).
 *  What the writer mints and what History reads from the version tables (services/history/storedVersions.ts) is exactly these notes. */
export async function hasVersionList(workspaceId: string, noteId: string): Promise<boolean> {
  const row = (await sql<{ scoped: boolean }>`
    SELECT note_version_in_scope(node_type, source_type) AS scoped FROM content_nodes WHERE id = ${noteId}::uuid AND workspace_id = ${workspaceId}::uuid`.execute(db)).rows[0];
  return row?.scoped === true;
}

/** Which of `noteIds` have a version list (the same rule for many notes at once: a backup measures a whole workspace). */
export async function notesWithVersionLists(workspaceId: string, noteIds: readonly string[]): Promise<Set<string>> {
  if (noteIds.length === 0) return new Set();
  const rows = (await sql<{ id: string }>`
    SELECT id::text AS id FROM content_nodes WHERE workspace_id = ${workspaceId}::uuid AND id = ANY(${noteIds}::uuid[]) AND note_version_in_scope(node_type, source_type)`.execute(db)).rows;
  return new Set(rows.map((r) => r.id));
}

/** The versions one transaction mints before it counts as a large write (db.ts planThisTransactionForTablesAsTheyAre; its statistics are brought up to
 *  date at 100, 200, 400 …, analyzeTablesOfLargeWrite): an ordinary save mints one or two; at 100, a plan cached while the version tables were small
 *  has cost at most 100 reads of a small table. */
const MANY_VERSIONS = 100;

/** Mint one version of this transaction's write: `s:<origin>:<seq>:<n>`, n = its place among the transaction's versions of that note and
 *  unit (a cascade undo that writes one note twice gets two). Returns the key, or null for a note that has no version list (a system
 *  note: migration 220 note_version_in_scope, the one rule). A tag's version is its description's (its name is written apart and is no version). Call inside the root write, after the content is stored. */
export async function recordVersion(v: NewVersion): Promise<string | null> {
  if (v.contentHash === null && v.kind !== "removed") throw new Error("a version names its content");
  if (!(await hasVersionList(v.workspaceId, v.noteId))) return null;
  // `minted`: this transaction's versions so far, this one included (a counter of the transaction, in this same statement: a save runs no more
  // statements). At MANY_VERSIONS the transaction is a large write: the rest of it plans each statement for the tables as they are (db.ts).
  const { why, minted: mintedSoFar } = (await sql<{ why: string | null; minted: number }>`
    SELECT note_version_exempt(${v.workspaceId}::uuid) AS why,
           set_config('onden.versions_minted', (COALESCE(NULLIF(current_setting('onden.versions_minted', true), ''), '0')::int + 1)::text, true)::int AS minted`.execute(db)).rows[0]!;
  if (mintedSoFar === MANY_VERSIONS) await planThisTransactionForTablesAsTheyAre();
  if (atDoubling(mintedSoFar, MANY_VERSIONS)) await analyzeTablesOfLargeWrite();
  // A join or a merge writes what it received, the shell and a data migration are no one's write: minting there is a bug of the caller
  // (an internal error, not a refusal a person could see).
  if (why === "off" || why === "import") throw new Error(`no version is minted here (${why})`);
  // sync_stamp_current: the transaction's stamp (mutate made it), or one made now for a write outside the roots, counted as such.
  const minted = (await sql<{ key: string; origin: string; seq: string }>`
    WITH st AS (SELECT sync_stamp_current(${v.workspaceId}::uuid) AS s)
    SELECT 's:' || (st.s->>'origin') || ':' || (st.s->>'seq') || ':' || (
             SELECT count(*) + 1 FROM note_version_positions p
              WHERE p.workspace_id = ${v.workspaceId}::uuid AND p.origin = st.s->>'origin' AND p.seq = (st.s->>'seq')::bigint
                AND p.note_id = ${v.noteId}::uuid AND p.unit = ${v.unit} AND p.version_key LIKE 's:%') AS key,
           st.s->>'origin' AS origin, st.s->>'seq' AS seq
      FROM st`.execute(db)).rows[0]!;
  const ordinal = Number(minted.key.slice(minted.key.lastIndexOf(":") + 1));
  // The author is the root write's actor, as this node's `actors` row says what it is (a stamp names the actor that opened the root write;
  // a write outside the roots names none): a person by id, a session, an AI agent or the system by kind only (their ids stay on this node).
  await sql`
    INSERT INTO note_versions (workspace_id, note_id, unit, version_key, kind, title, content_hash, at, clock_wall, clock_counter, ordinal,
                               recorded_by, author_kind, author_id, restored_from)
    SELECT ${v.workspaceId}::uuid, ${v.noteId}::uuid, ${v.unit}, ${minted.key}, ${v.kind}, ${v.title ?? null}, ${v.contentHash}, note_version_at(now()),
           (st.s->>'wall')::bigint, (st.s->>'counter')::int, ${ordinal}, (SELECT node_id FROM sync_node WHERE singleton),
           CASE a.type WHEN 'human' THEN 'person' WHEN 'session' THEN 'session' WHEN 'agent' THEN 'ai' ELSE 'automatic' END,
           CASE WHEN a.type = 'human' AND a.workspace_id = ${v.workspaceId}::uuid THEN a.id END,
           ${v.restoredFrom ?? null}
      FROM (SELECT sync_stamp_current(${v.workspaceId}::uuid) AS s) st
      LEFT JOIN actors a ON a.id::text = st.s->>'author'`.execute(db);
  await sql`
    INSERT INTO note_version_positions (workspace_id, note_id, unit, version_key, origin, seq)
    VALUES (${v.workspaceId}::uuid, ${v.noteId}::uuid, ${v.unit}, ${minted.key}, ${minted.origin}, ${minted.seq}::bigint)`.execute(db);
  return minted.key;
}

/** The version a save event recorded on this node (note_version_events), or null: what a "restored from" names when the caller knows the event.
 *  `of` limits it to one note and one unit (the version list's old address: the number of an event; a number of another note names nothing). */
export async function versionOfEvent(eventId: string, of?: { noteId: string; unit: string }): Promise<string | null> {
  if (!/^\d{1,18}$/.test(eventId)) return null;
  const row = (await sql<{ version_key: string }>`
    SELECT version_key FROM note_version_events WHERE event_id = ${eventId}::bigint
       ${of ? sql`AND note_id = ${of.noteId}::uuid AND unit = ${of.unit}` : sql``}`.execute(db)).rows[0];
  return row?.version_key ?? null;
}

/** A version that says what the note WAS like: every kind but `set_aside` (a text a conflict put aside is content the note never had; migration 220). Every reader
 *  that lists, cuts, restores or exports versions as the note's states ANDs this on `v` = note_versions (historyReadersSetAside.integration.test.ts feeds every
 *  reader one set-aside text). */
export const STATE_VERSION_SQL = "v.kind <> 'set_aside'";

/** A version's address from either spelling: its key (checked to be this note's, this unit's), or the number of an event of this node (the old address,
 *  kept for one release: docs/architecture/history-api.md). Null when this note has no such version. */
export async function resolveVersionKey(noteId: string, unit: string, id: string): Promise<string | null> {
  if (/^[sgbm]:.+$/.test(id)) {
    const row = (await sql<{ version_key: string }>`
      SELECT v.version_key FROM note_versions v WHERE v.note_id = ${noteId}::uuid AND v.unit = ${unit} AND v.version_key = ${id} AND ${sql.raw(STATE_VERSION_SQL)}`.execute(db)).rows[0];
    return row?.version_key ?? null;
  }
  return versionOfEvent(id, { noteId, unit });
}

/** The lowest event of this node that recorded the version (what an old event payload names), or null for a version made elsewhere. */
export async function eventOfVersion(noteId: string, unit: string, versionKey: string): Promise<string | null> {
  const row = (await sql<{ id: string }>`
    SELECT min(event_id)::text AS id FROM note_version_events WHERE note_id = ${noteId}::uuid AND unit = ${unit} AND version_key = ${versionKey}`.execute(db)).rows[0];
  return row?.id ?? null;
}

/** The title and text of one version of a note's text (by key or by an event number of this node), and the key it has; null when this note has no
 *  such version or its text is not stored here. The restore of a version reads it (services/nodeUpdate.ts) after the note's write check. */
export async function loadBodyVersion(workspaceId: string, nodeId: string, id: string): Promise<{ key: string; title: string | null; markdown: string } | null> {
  const key = await resolveVersionKey(nodeId, "body", id);
  if (key === null) return null;
  const row = (await sql<{ title: string | null; markdown: string }>`
    SELECT v.title, b.content AS markdown FROM note_versions v JOIN blobs b ON b.hash = v.content_hash
     WHERE v.note_id = ${nodeId}::uuid AND v.workspace_id = ${workspaceId}::uuid AND v.unit = 'body' AND v.version_key = ${key}`.execute(db)).rows[0];
  return row ? { key, ...row } : null;
}

/** The version an event undo puts back: the last version of the unit recorded before `undoneEventId` on this node, when it holds `contentHash`
 *  (the same rule migration 220 applies to the undos it finds). Null when there is none or the content differs. */
export async function versionBeforeEvent(noteId: string, unit: VersionUnit, undoneEventId: string, contentHash: string | null): Promise<string | null> {
  if (!/^\d{1,18}$/.test(undoneEventId)) return null;
  return (await sql<{ key: string | null }>`SELECT note_version_before_event(${noteId}::uuid, ${unit}, ${undoneEventId}::bigint, ${contentHash}) AS key`.execute(db)).rows[0]?.key ?? null;
}

// The key encoding of migration 220 (note_version_field): every field `<UTF-8 bytes>:<text>`, a missing one `-`, in this order.
const field = (value: string | null): string => (value === null ? "-" : `${Buffer.byteLength(value, "utf8")}:${value}`);

/** `g:` — a version recorded as an event (here, or carried in from a backup), from what it is. `at`: UTC microseconds (IMPORTED_AT).
 *  The same function as SQL note_version_legacy_key (versionKeys.integration.test.ts). A `b:` baseline is minted only by migration 220
 *  (SQL note_version_baseline_key), so it has no JS twin. */
export function legacyVersionKey(noteId: string, unit: VersionUnit, kind: string, contentHash: string | null, title: string | null, at: string): string {
  return `g:${sha256Hex(`onden version 1${[noteId, unit, kind, contentHash, title, at].map(field).join("")}`)}`;
}

/** Root writes that changed a note's title or text, or a drawing, without minting its version (migration 220's deferred checks count them in
 *  sync_clock.version_misses; the server logs the total at boot). Zero on every production path; a non-zero count names a writer to fix. */
export const countVersionMisses = (workspaceId?: string): Promise<number> => countSyncClockExceptions("version_misses", workspaceId);
