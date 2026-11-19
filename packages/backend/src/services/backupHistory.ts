// A note's version history inside a backup (format 3): what is written, how big it is, and how it is read back.
//
//   .onden/history/<note id>.jsonl   one JSON line per version (a body-bearing save: bodyEventSql), oldest first:
//     { id, kind, at, title, hash, markdown, actor: { type, name }, restored_from }
//
// Scope: the text history of notes — what the History page of a note lists and can restore. The operation log (undo
// ledger), AI run records and anything sealed with the source server's secrets stay out (docs/architecture/backup-move.md).
// A backup without history is still format 2, byte for byte as before; one with it is format 3, so a server that does not
// know the section refuses the file whole at the manifest (backupFile.ts `newer_version`), never half-restores it.
//
// Memory: the export reads a note's versions HISTORY_PAGE at a time and appends them to a scratch file; the import reads
// a line at a time and hands IMPORT_BATCH versions to spine/importedHistory.ts. No note's whole history is held.
import { appendFile, writeFile } from "node:fs/promises";
import { sql } from "kysely";
import { db } from "../dbKysely.js";
import { StatusError } from "../statusError.js";
import { sha256Hex } from "../utils.js";
import { appendImportedVersions, ImportedHistoryError, isImportedAt, type ImportedVersion } from "../spine/importedHistory.js";
import type { ActorCtx } from "../types.js";
import { shownAuthorName, versionAuthor } from "./authorName.js";
import { NO_INVERSE_PATCH } from "./eventLog/index.js";
import { bodyEventSql, versionActorTypeSql } from "./history/index.js";
import type { BackupHistoryInfo } from "@onden/contract";

export const HISTORY_DIR = ".onden/history";
/** The archive layout version of a backup that holds history (a backup without it stays at 2). */
export const BACKUP_VERSION_WITH_HISTORY = 3;
export const historyEntryPath = (noteId: string): string => `${HISTORY_DIR}/${noteId}.jsonl`;

const HISTORY_PAGE = 200;
const IMPORT_BATCH = 200;
const ID_CHUNK = 5000;

/** One line of a history file. */
export type HistoryLine = {
  id: string;
  kind: "created" | "updated" | "restored";
  /** UTC ISO time with microseconds, as the source stored it. */
  at: string;
  title: string | null;
  hash: string;
  markdown: string;
  actor: { type: "user" | "ai_agent" | "system"; name: string | null };
  restored_from: string | null;
};

const KIND: Record<string, HistoryLine["kind"]> = { NODE_CREATED: "created", NODE_UPDATED: "updated", NODE_RESTORED: "restored" };

/** How many versions `noteIds` hold and how many bytes of text (before the zip compresses it): what the person is shown
 *  before they choose to include history. */
export async function measureHistory(workspaceId: string, noteIds: readonly string[]): Promise<BackupHistoryInfo> {
  let notes = 0, versions = 0, bytes = 0;
  for (let at = 0; at < noteIds.length; at += ID_CHUNK) {
    const r = await sql<{ notes: string; versions: string; bytes: string }>`
      SELECT count(DISTINCT e.target_id)::text AS notes, count(*)::text AS versions, coalesce(sum(b.size_bytes), 0)::text AS bytes
        FROM domain_events e JOIN blobs b ON b.hash = e.payload->>'body_hash'
       WHERE e.workspace_id = ${workspaceId} AND e.target_id = ANY(${noteIds.slice(at, at + ID_CHUNK)}::text[]) AND ${sql.raw(bodyEventSql("e"))}`.execute(db);
    notes += Number(r.rows[0]!.notes); versions += Number(r.rows[0]!.versions); bytes += Number(r.rows[0]!.bytes);
  }
  return { notes, versions, bytes };
}

type PageRow = { id: string; event_type: string; at: string; at_cursor: string; title: string | null; hash: string; version_id: string | null; actor_type: HistoryLine["actor"]["type"]; imported: boolean; import_name: string | null; row_name: string | null; row_type: string | null; markdown: string };

/** Write `noteId`'s versions to the scratch file `path`, a page at a time. Returns how many (0: no file is wanted). */
export async function writeHistoryFile(workspaceId: string, noteId: string, path: string): Promise<{ versions: number; bytes: number }> {
  let versions = 0, bytes = 0, cursor: { at: string; id: string } | null = null;
  await writeFile(path, "");
  for (;;) {
    const page: { rows: PageRow[] } = await sql<PageRow>`
      SELECT e.id::text AS id, e.event_type, e.created_at::text AS at_cursor,
             to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
             e.payload->>'title' AS title, e.payload->>'body_hash' AS hash, e.payload->>'version_id' AS version_id,
             ${sql.raw(versionActorTypeSql("e"))} AS actor_type, (e.tx_meta ? 'history_import') AS imported, e.tx_meta->'history_import'->>'actor_name' AS import_name, a.name AS row_name, a.type AS row_type, b.content AS markdown
        FROM domain_events e
        JOIN blobs b ON b.hash = e.payload->>'body_hash'
   LEFT JOIN actors a ON a.id::text = e.actor_id
       WHERE e.workspace_id = ${workspaceId} AND e.target_id = ${noteId} AND ${sql.raw(bodyEventSql("e"))}
         AND (${cursor?.at ?? null}::timestamptz IS NULL OR (e.created_at, e.id) > (${cursor?.at ?? null}::timestamptz, ${cursor?.id ?? "0"}::bigint))
       ORDER BY e.created_at, e.id LIMIT ${sql.raw(String(HISTORY_PAGE))}`.execute(db);
    if (page.rows.length === 0) break;
    const lines = page.rows.map((r) => ({ r, author: versionAuthor(r) })).map(({ r, author }): HistoryLine => ({
      id: r.id, kind: KIND[r.event_type] ?? "updated", at: r.at, title: r.title, hash: r.hash, markdown: r.markdown,
      // a session's save goes with no name (services/authorName.ts): a label is not a person's name, and the file outlives this node
      actor: { type: r.actor_type, name: shownAuthorName(author.rowType, author.name) }, restored_from: r.event_type === "NODE_RESTORED" ? r.version_id : null,
    })).map((l) => JSON.stringify(l)).join("\n") + "\n";
    await appendFile(path, lines);
    versions += page.rows.length; bytes += page.rows.reduce((n, r) => n + Buffer.byteLength(r.markdown, "utf8"), 0);
    const last = page.rows[page.rows.length - 1]!;
    cursor = { at: last.at_cursor, id: last.id };
    if (page.rows.length < HISTORY_PAGE) break;
  }
  return { versions, bytes };
}

/** A history line that is not what this version of Onden writes. */
export class HistoryLineError extends StatusError {
  constructor() { super(422, "bad history line"); this.name = "HistoryLineError"; }
}

// A NUL cannot be stored in a text column: the insert would throw something the restore does not catch, after the notes
// were committed. Refused here, so only that note's history fails.
const isStr = (v: unknown): v is string => typeof v === "string" && !v.includes("\u0000");
const isNullStr = (v: unknown): v is string | null => v === null || isStr(v);
const EVENT_ID = /^\d{1,18}$/;
/** A source event id: a string of digits (a number would not match the string keys the dedupe compares). */
const isEventId = (v: unknown): v is string => typeof v === "string" && EVENT_ID.test(v);

/** One line of a history file, checked. */
export function parseHistoryLine(text: string): HistoryLine {
  let raw: Partial<HistoryLine> | null;
  try { raw = JSON.parse(text) as Partial<HistoryLine>; } catch { throw new HistoryLineError(); }
  const actor = raw?.actor as Partial<HistoryLine["actor"]> | undefined;
  const ok = !!raw && isEventId(raw.id) && isStr(raw.kind) && ["created", "updated", "restored"].includes(raw.kind)
    && isStr(raw.at) && isImportedAt(raw.at) && isNullStr(raw.title) && isStr(raw.hash) && /^[0-9a-f]{64}$/.test(raw.hash)
    && isStr(raw.markdown) && !!actor && ["user", "ai_agent", "system"].includes(String(actor.type)) && isNullStr(actor.name)
    && (raw.restored_from === null || isEventId(raw.restored_from));
  if (!ok) throw new HistoryLineError();
  return raw as HistoryLine;
}

export type HistoryImport = { versions: number; alreadyThere: number };

/** Carry `lines` (one note's history file, oldest first) into `noteId` of this workspace. All of the note or none: a bad
 *  line, or text that does not match its hash, throws before that note gets any version (the caller counts it as failed).
 *  Run inside the restore's transaction, as the workspace owner (spine/importedHistory.ts checks). */
export async function importNoteHistory(actor: ActorCtx, workspaceId: string, noteId: string, readLines: () => AsyncIterable<string>): Promise<HistoryImport> {
  const toVersion = (l: HistoryLine): ImportedVersion => ({
    sourceEventId: l.id, kind: l.kind, at: l.at, title: l.title, bodyHash: l.hash, markdown: l.markdown,
    actorType: l.actor.type, actorName: l.actor.name, restoredFrom: l.restored_from,
  });
  // Pass 1 holds one line: shape and hash of every version are known good before the note gets its first.
  for await (const text of readLines()) {
    if (text === "") continue;
    const l = parseHistoryLine(text);
    if (sha256Hex(l.markdown) !== l.hash) throw new ImportedHistoryError("hashMismatch", "a version's text does not match its hash");
  }
  // Pass 2 writes IMPORT_BATCH versions at a time.
  let versions = 0, alreadyThere = 0, batch: ImportedVersion[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const r = await appendImportedVersions(actor, workspaceId, noteId, batch, NO_INVERSE_PATCH);
    versions += r.appended; alreadyThere += r.alreadyThere; batch = [];
  };
  for await (const text of readLines()) {
    if (text === "") continue;
    batch.push(toVersion(parseHistoryLine(text)));
    if (batch.length >= IMPORT_BATCH) await flush();
  }
  await flush();
  return { versions, alreadyThere };
}

export { ImportedHistoryError };
