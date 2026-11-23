// Body versions carried in from another workspace (a backup or a workspace move that includes history).
//
// What a version is: a NODE_CREATED / NODE_UPDATED / NODE_RESTORED event with a body_hash, the text in `blobs`
// (services/history/bodyEvents.ts). This is the one place that writes such events with their ORIGINAL time.
//
// Contract (docs/architecture/backup-move.md):
//   * only the workspace owner (a delegated token never is), the caller has just resolved the current actor;
//   * only into a note this restore made — the caller passes versions of one note, never merges into older history;
//   * the text is checked against the hash it claims (SHA-256): a mismatch throws, nothing of that note is written;
//   * actors: the actor id is the owner's (an id from another server means nothing here) and actor_type is always 'user';
//     the source's kind and display name ride in tx_meta.history_import, which the version list shows in place of them
//     (services/history/bodyEvents.ts versionActorTypeSql). Keeping 'ai_agent' in actor_type would put every carried
//     AI version in the review inbox, the agent-run list and the day lens as the owner's unreviewed AI work;
//   * time: the source's microseconds go to the database as text (a JS Date holds milliseconds); a version later than the
//     note's own first save here is refused (it would sort after the restore's own save: clock skew or a crafted file);
//   * idempotent: a version already carried (same source event id on this note) is skipped, so a replay adds nothing;
//   * the events are marked no-inverse: undoing one as an event is refused (the person restores the version instead);
//   * not an operation-log entry: it has no cause and is not a sync format (tx_meta.history_import only).
import { sql } from "kysely";
import { q } from "../db.js";
import { db } from "../dbKysely.js";
import type { ActorCtx } from "../types.js";
import { sha256Hex } from "../utils.js";
import { isWorkspaceOwner } from "./authority.js";
import { AuthorityError } from "./authorityError.js";
import { StatusError } from "../statusError.js";
import { acquireEventAppendLock } from "./eventLock.js";
import { isImportedAt, legacyVersionKey } from "./versionIdentity.js";

export type ImportedVersion = {
  /** The version's name in the source: its `version_key`, or the number of its event (a file from before the version tables; text of a bigint). The idempotency key and what a restore points at. */
  sourceEventId: string;
  kind: "created" | "updated" | "restored";
  /** UTC time the source recorded, `YYYY-MM-DDTHH:MM:SS.ffffffZ` (spine/versionIdentity.ts IMPORTED_AT). */
  at: string;
  title: string | null;
  /** SHA-256 hex the source stored; the text must hash to it. */
  bodyHash: string;
  markdown: string;
  actorType: "user" | "ai_agent" | "system";
  actorName: string | null;
  /** For kind "restored": the source event id of the version put back (must be an earlier version of the same note). */
  restoredFrom: string | null;
  /** The source kept this as its baseline (the content the note held when its history began, migration 220): it is stored as one, not as an edit. Sent as `created`. */
  baseline?: true;
};


/** Never shown as such: the restore catches it and lists the note's title (a note's history fails alone). */
export class ImportedHistoryError extends StatusError {
  constructor(readonly reason: "hashMismatch" | "noteMissing" | "futureVersion" | "badTime", message: string) {
    super(422, message);
    this.name = "ImportedHistoryError";
  }
}

const EVENT_TYPE = { created: "NODE_CREATED", updated: "NODE_UPDATED", restored: "NODE_RESTORED" } as const;
/** A carried version's author by kind only: its id is another server's and means nothing here (its name rides in source_name). */
const AUTHOR_KIND = { user: "person", ai_agent: "ai", system: "automatic" } as const;

/** Append `versions` (oldest first) to `noteId`'s history. Must run in the restore's transaction. Returns how many were
 *  written and how many were already there. */
export async function appendImportedVersions(
  actor: ActorCtx, workspaceId: string, noteId: string, versions: readonly ImportedVersion[],
  /** The marker eventRestore reads as "this event has no inverse" (services/eventLog/bodyPatch.ts NO_INVERSE_PATCH; spine cannot import it). */
  noInversePatch: string,
): Promise<{ appended: number; alreadyThere: number }> {
  if (!(await isWorkspaceOwner(actor))) throw new AuthorityError("not_workspace_owner", "only the workspace owner carries history in");
  // Checked first and wholly: a note's history is all or nothing.
  for (const v of versions) {
    if (sha256Hex(v.markdown) !== v.bodyHash) throw new ImportedHistoryError("hashMismatch", "a version's text does not match its hash");
  }
  await acquireEventAppendLock(q, workspaceId);
  const note = await db.selectFrom("content_nodes").select("id").where("id", "=", noteId).where("workspace_id", "=", workspaceId).executeTakeFirst();
  if (!note) throw new ImportedHistoryError("noteMissing", "the note is not in this workspace");

  // A version later than the note's own first save here would sort after it (the restore's save is the note's present body).
  const latest = versions.reduce((m, v) => (v.at > m ? v.at : m), "");
  if (latest && !versions.every((v) => isImportedAt(v.at))) throw new ImportedHistoryError("badTime", "a version's time is not a time");
  if (latest) {
    const late = await sql<{ late: boolean }>`
      SELECT ${latest}::timestamptz > coalesce(
        (SELECT min(created_at) FROM domain_events WHERE workspace_id = ${workspaceId} AND target_id = ${noteId} AND NOT (tx_meta ? 'history_import')),
        clock_timestamp()) AS late`.execute(db);
    if (late.rows[0]!.late) throw new ImportedHistoryError("futureVersion", "a version is dated after the note was restored here");
  }

  const have = new Map<string, string>(); // source event id → event id here
  const versionOf = new Map<string, string>(); // event id here → its version_key
  let previousHash: string | null = null; // base_hash chain: carries across batches, so seed it from what is already carried
  let previousTitle: string | null = null;
  for (const row of (await sql<{ source: string; id: string; hash: string | null; title: string | null; version_key: string | null }>`
    SELECT e.tx_meta->'history_import'->>'event' AS source, e.id::text AS id, e.body_hash AS hash, e.payload->>'title' AS title, ve.version_key
      FROM domain_events e LEFT JOIN note_version_events ve ON ve.event_id = e.id
     WHERE e.workspace_id = ${workspaceId} AND e.target_id = ${noteId} AND e.tx_meta ? 'history_import'
     ORDER BY e.created_at, e.id`.execute(db)).rows) {
    have.set(row.source, row.id); previousHash = row.hash; previousTitle = row.title;
    if (row.version_key) versionOf.set(row.id, row.version_key);
  }
  let lastVersion = [...versionOf.values()].at(-1) ?? null;

  // The versions these saves are, written once for the batch after the loop (one statement per table, not three per save: a note with
  // thousands of saves is carried in one restore transaction, services/backupRestore.ts).
  const minted: { version_key: string; kind: ImportedVersion["kind"] | "baseline"; title: string | null; content_hash: string; at: string; ordinal: number;
                  author_kind: string; restored_from: string | null; source_name: string | null }[] = [];
  const mapped: { event_id: string; version_key: string }[] = [];
  let appended = 0;
  for (const v of versions) {
    const done = have.get(v.sourceEventId);
    if (done) { previousHash = v.bodyHash; previousTitle = v.title; lastVersion = versionOf.get(done) ?? lastVersion; continue; }
    await db.insertInto("blobs").values({ hash: v.bodyHash, content: v.markdown, size_bytes: Buffer.byteLength(v.markdown, "utf8") }).onConflict((c) => c.column("hash").doNothing()).execute();
    const restoredHere = v.restoredFrom ? have.get(v.restoredFrom) : undefined;
    const payload: Record<string, unknown> = { title: v.title, body_hash: v.bodyHash, ...(restoredHere ? { version_id: restoredHere } : {}) };
    const row = await db.insertInto("domain_events").values({
      workspace_id: workspaceId, actor_type: "user", actor_id: actor.id, event_type: EVENT_TYPE[v.kind],
      target_type: "node", target_id: noteId, payload: JSON.stringify(payload),
      tx_meta: JSON.stringify({ ui_context: "history.import", inverse_patch: noInversePatch, history_import: { event: v.sourceEventId, actor_type: v.actorType, actor_name: v.actorName } }),
      body_hash: v.bodyHash, base_hash: previousHash, created_at: sql<Date>`${v.at}::timestamptz`, device_id: null,
    }).returning(sql<string>`id::text`.as("id")).executeTakeFirstOrThrow();
    have.set(v.sourceEventId, row.id);
    // The version this save is (spine/noteVersions.ts `g:`): minted here, where the history comes in; a save that repeats the one before it
    // (same text, same title) is that version again, as the version list has always shown it. It travels from this restore's transaction.
    // Its ordinal is the save's rank among the note's carried saves (have.size, this one included): migration 220's rule, the rank of the event.
    const repeats = lastVersion !== null && previousHash === v.bodyHash && previousTitle === v.title;
    const key = repeats ? lastVersion! : legacyVersionKey(noteId, "body", v.kind, v.bodyHash, v.title, v.at);
    if (!repeats) {
      minted.push({ version_key: key, kind: v.baseline ? "baseline" : v.kind, title: v.title, content_hash: v.bodyHash, at: v.at, ordinal: have.size, author_kind: AUTHOR_KIND[v.actorType],
        restored_from: restoredHere ? versionOf.get(restoredHere) ?? null : null, source_name: v.actorName });
    }
    mapped.push({ event_id: row.id, version_key: key });
    versionOf.set(row.id, key);
    lastVersion = key;
    previousTitle = v.title;
    previousHash = v.bodyHash;
    appended++;
  }
  if (minted.length > 0) {
    const where = (await sql<{ node: string; origin: string; seq: string }>`
      SELECT (SELECT node_id FROM sync_node WHERE singleton) AS node, s->>'origin' AS origin, s->>'seq' AS seq
        FROM (SELECT sync_stamp_current(${workspaceId}::uuid) AS s) st`.execute(db)).rows[0]!;
    await db.insertInto("note_versions").values(minted.map((m) => ({ ...m, workspace_id: workspaceId, note_id: noteId, unit: "body", recorded_by: where.node })))
      .onConflict((c) => c.doNothing()).execute();
    await db.insertInto("note_version_positions").values(minted.map((m) => ({ workspace_id: workspaceId, note_id: noteId, unit: "body", version_key: m.version_key,
      origin: where.origin, seq: where.seq }))).onConflict((c) => c.doNothing()).execute();
  }
  if (mapped.length > 0) {
    await db.insertInto("note_version_events").values(mapped.map((m) => ({ ...m, note_id: noteId, unit: "body" }))).execute();
  }
  return { appended, alreadyThere: versions.length - appended };
}
