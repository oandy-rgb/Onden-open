// Fixtures for History tests now that History reads the version tables (note_versions, migration 220; batch 2 of the history-replication proposal).
// A test that used to write a save as an event alone (a raw INSERT, a hand-built `body_hash`) gives the save its version too, the way migration
// 220 mints one for an older server's save: a `g:` version, mapped to its event.
import { q } from "../../db.js";
import { seedQ } from "./seedQ.js";

type SeedVersion = {
  ws: string; noteId: string; title: string; markdown: string;
  /** When it was saved (ISO or Date); default: now. */
  at?: string | Date;
  kind?: "created" | "updated" | "restored";
  authorKind?: "person" | "ai" | "automatic" | "session";
  /** The person's id (an `actors` row), shown by name. */
  authorId?: string | null;
  /** The event this version records: the author of the list's rows is this event's actor. */
  eventId?: string | null;
};

/** Store a note's text and its version, as migration 220 mints one for an older server's save. Returns the version's key. */
export async function seedVersion(v: SeedVersion): Promise<string> {
  const at = v.at instanceof Date ? v.at.toISOString() : v.at ?? new Date().toISOString();
  const hash = (await q<{ h: string }>(`SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex') AS h`, [v.markdown])).rows[0]!.h;
  const key = (await seedQ<{ key: string }>(
    `WITH blob AS (INSERT INTO blobs (hash, content, size_bytes) VALUES ($1, $2, octet_length($2)) ON CONFLICT (hash) DO NOTHING),
          ins AS (INSERT INTO note_versions (workspace_id, note_id, unit, version_key, kind, title, content_hash, at, ordinal, recorded_by, author_kind, author_id)
                  SELECT $3::uuid, $4::uuid, 'body', note_version_legacy_key($4::uuid, 'body', $5, $1, $6, note_version_at($7::timestamptz)), $5, $6, $1,
                         note_version_at($7::timestamptz), coalesce((SELECT max(ordinal) FROM note_versions WHERE note_id = $4::uuid AND unit = 'body'), 0) + 1,
                         (SELECT node_id FROM sync_node WHERE singleton), $8, $9::uuid
                  ON CONFLICT DO NOTHING RETURNING version_key)
     SELECT note_version_legacy_key($4::uuid, 'body', $5, $1, $6, note_version_at($7::timestamptz)) AS key`,
    [hash, v.markdown, v.ws, v.noteId, v.kind ?? "updated", v.title, at, v.authorKind ?? "person", v.authorId ?? null],
  )).rows[0]!.key;
  if (v.eventId) await seedQ(`INSERT INTO note_version_events (event_id, note_id, unit, version_key) VALUES ($1::bigint, $2::uuid, 'body', $3) ON CONFLICT DO NOTHING`, [v.eventId, v.noteId, key]);
  return key;
}

/** The key of the version this node recorded `eventId` as (null: none). */
export const versionKeyOf = async (eventId: string): Promise<string | null> =>
  (await q<{ version_key: string }>(`SELECT version_key FROM note_version_events WHERE event_id = $1::bigint`, [eventId])).rows[0]?.version_key ?? null;

/** The lowest event number of this node that recorded the version (null: none). */
export const eventOfVersionKey = async (noteId: string, versionKey: string): Promise<string | null> =>
  (await q<{ id: string | null }>(`SELECT min(event_id)::text AS id FROM note_version_events WHERE note_id = $1::uuid AND version_key = $2`, [noteId, versionKey])).rows[0]?.id ?? null;

/** Give an event an older server wrote (a hand-made copy of a save) the version migration 220 mints for it: none for a save that repeats the
 *  title and text of the version before it (the event maps to that one), a `g:` version otherwise. Returns the key the event maps to. */
export async function migrateLegacySave(eventId: string): Promise<string> {
  const e = (await q<{ ws: string; note: string; kind: string; title: string; hash: string; at: string; markdown: string | null; actor_type: string }>(
    `SELECT e.workspace_id::text AS ws, e.target_id AS note, CASE e.event_type WHEN 'NODE_CREATED' THEN 'created' WHEN 'NODE_RESTORED' THEN 'restored' ELSE 'updated' END AS kind,
            e.payload->>'title' AS title, e.payload->>'body_hash' AS hash, e.created_at::text AS at, b.content AS markdown, e.actor_type
       FROM domain_events e LEFT JOIN blobs b ON b.hash = e.payload->>'body_hash' WHERE e.id = $1::bigint`, [eventId])).rows[0]!;
  const before = (await q<{ version_key: string; content_hash: string; title: string | null }>(
    `SELECT v.version_key, v.content_hash, v.title FROM note_versions v JOIN domain_events pe ON pe.id = (SELECT min(event_id) FROM note_version_events x WHERE x.version_key = v.version_key AND x.note_id = v.note_id)
      WHERE v.note_id = $1::uuid AND v.unit = 'body' AND pe.id <> $2::bigint AND (pe.created_at, pe.id) < (SELECT d.created_at, d.id FROM domain_events d WHERE d.id = $2::bigint)
      ORDER BY pe.created_at DESC, pe.id DESC LIMIT 1`, [e.note, eventId])).rows[0];
  if (before && before.content_hash === e.hash && before.title === e.title) {
    await seedQ(`INSERT INTO note_version_events (event_id, note_id, unit, version_key) VALUES ($1::bigint, $2::uuid, 'body', $3) ON CONFLICT DO NOTHING`, [eventId, e.note, before.version_key]);
    return before.version_key;
  }
  if (e.markdown === null) throw new Error("a save whose text is gone has no version (migration 220 leaves it out)");
  return seedVersion({ ws: e.ws, noteId: e.note, title: e.title, markdown: e.markdown, at: e.at, kind: e.kind as "created" | "updated" | "restored", eventId, authorKind: e.actor_type === "ai_agent" ? "ai" : "person" });
}
