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

export type ImportedVersion = {
  /** The version's event id in the source (text of a bigint): the idempotency key and what a restore points at. */
  sourceEventId: string;
  kind: "created" | "updated" | "restored";
  /** UTC time the source recorded, `YYYY-MM-DDTHH:MM:SS.ffffffZ` (IMPORTED_AT). */
  at: string;
  title: string | null;
  /** SHA-256 hex the source stored; the text must hash to it. */
  bodyHash: string;
  markdown: string;
  actorType: "user" | "ai_agent" | "system";
  actorName: string | null;
  /** For kind "restored": the source event id of the version put back (must be an earlier version of the same note). */
  restoredFrom: string | null;
};

/** The only shape of a version's time: what the export writes (microseconds, UTC). Passed on as text, never through Date. */
export const IMPORTED_AT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.\d{6}Z$/;
/** Whether `at` is a real calendar time in that shape (not 2026-02-31, not hour 25). */
export function isImportedAt(at: string): boolean {
  const whole = IMPORTED_AT.exec(at)?.[1];
  if (!whole) return false;
  const parsed = new Date(`${whole}.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === `${whole}.000Z`;
}

/** Never shown as such: the restore catches it and lists the note's title (a note's history fails alone). */
export class ImportedHistoryError extends StatusError {
  constructor(readonly reason: "hashMismatch" | "noteMissing" | "futureVersion" | "badTime", message: string) {
    super(422, message);
    this.name = "ImportedHistoryError";
  }
}

const EVENT_TYPE = { created: "NODE_CREATED", updated: "NODE_UPDATED", restored: "NODE_RESTORED" } as const;

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
  let previousHash: string | null = null; // base_hash chain: carries across batches, so seed it from what is already carried
  for (const row of (await sql<{ source: string; id: string; hash: string | null }>`
    SELECT tx_meta->'history_import'->>'event' AS source, id::text AS id, body_hash AS hash FROM domain_events
     WHERE workspace_id = ${workspaceId} AND target_id = ${noteId} AND tx_meta ? 'history_import'
     ORDER BY created_at, id`.execute(db)).rows) { have.set(row.source, row.id); previousHash = row.hash; }

  let appended = 0;
  for (const v of versions) {
    const done = have.get(v.sourceEventId);
    if (done) { previousHash = v.bodyHash; continue; }
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
    previousHash = v.bodyHash;
    appended++;
  }
  return { appended, alreadyThere: versions.length - appended };
}
