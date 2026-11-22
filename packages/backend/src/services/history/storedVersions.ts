// A note's saved versions, read from the version tables (note_versions, migration 220; the history-replication proposal, PR #1935, §5). Every History
// page that lists, compares, restores or cuts "the text at a time" asks here for a note that has a version list, so the
// order, the identity (`version_key`) and the author live in one place. The event log is still read for the two things that have no version
// yet: a tag's description and a system note (`hasVersionList()` in spine/noteVersions.ts says which; migration 220 note_version_in_scope is the one rule), and for the
// local account of what happened (body conflicts, AI runs, rewinds).
//
// ORDER (§5): the version's time in milliseconds (the logical clock's wall part, else the time written down), then the clock's counter,
// then `ordinal`, then the key. For a version this node minted before the clocks existed (`g:`) that is (created_at, id), the order the event
// log gave; two saves of one transaction keep their writing order through `ordinal`.
// TIME: a cut ("the text at T") and a day use `at`, the time written down and shown, in microseconds.
//
// A save that repeated the one before it minted no version (migration 220), so a list read here has no row for it; and a version whose text
// is not stored here is left out, as the event list always did.

import { sql } from "kysely";
import { log } from "../../logger.js";
import { inTransaction } from "../../db.js";
import { db } from "../../dbKysely.js";
import { refreshSenderStatistics } from "../../spine/senderStatistics.js";
import { AUTHOR_REF_SQL, STATE_VERSION_SQL } from "./bodyEvents.js";

const STATE = sql.raw(STATE_VERSION_SQL);

const VERSION_TABLES = ["note_versions", "note_version_events", "note_version_positions"] as const;
let statisticsCheckedAt = 0;
/** The version tables' planner statistics, made current on a node without autovacuum (the browser's and the desktop's PGlite) by the same rule a bundle read
 *  uses (spine/senderStatistics.ts); on a server that rule does nothing. A History read only TRIGGERS it, and the refresh NEVER runs on anyone else's
 *  transaction or connection: not when the read is inside a transaction (a rewind reads "the notes at T" under the event lock: it does nothing then and the
 *  next plain read does it), and otherwise on a pool (never the caller's transaction), not waited for, whose failure is one log line and reaches no user's operation
 *  (review of PR #1948, rounds 2 and 3). At most once in ten minutes per process; the read that triggers it plans on the statistics there are (migration 225
 *  analyzed the tables once). */
export function keepVersionStatisticsCurrent(): void {
  if (inTransaction()) return;
  const now = Date.now();
  if (now - statisticsCheckedAt < 600_000) return;
  statisticsCheckedAt = now;
  // Not inside a transaction (checked above), so q() runs each statement on the pool, a connection of its own: the promise carries no transaction of this or any other request.
  void refreshSenderStatistics(VERSION_TABLES).catch((e) => { log.warn("history", "version statistics not refreshed", { reason: e instanceof Error ? e.name : "unknown" }); });
}

/** ORDER BY of a note's versions (`v` = note_versions), oldest first and newest first, as SQL text for the readers that are written in it. */
export const VERSION_ORDER_ASC_SQL = "coalesce(v.clock_wall, floor(extract(epoch FROM v.at::timestamptz) * 1000)::bigint), coalesce(v.clock_counter, 0), v.ordinal, v.version_key";
export const VERSION_ORDER_DESC_SQL = "coalesce(v.clock_wall, floor(extract(epoch FROM v.at::timestamptz) * 1000)::bigint) DESC, coalesce(v.clock_counter, 0) DESC, v.ordinal DESC, v.version_key DESC";
/** The three numbers of the order, apart from the key: the version's time in milliseconds, the clock's counter, its place in its transaction
 *  (a page cursor, services/backupHistory.ts, is these three and the key). */
export const VERSION_SORT_PARTS_SQL = "coalesce(v.clock_wall, floor(extract(epoch FROM v.at::timestamptz) * 1000)::bigint)::text AS s_ms, coalesce(v.clock_counter, 0)::text AS s_counter, v.ordinal::text AS s_ordinal";
export const VERSION_ORDER_ASC = sql.raw(VERSION_ORDER_ASC_SQL);
export const VERSION_ORDER_DESC = sql.raw(VERSION_ORDER_DESC_SQL);

/** What the author columns say, in the kinds the screen knows (spine/noteVersions.ts: a person by id, the rest by kind). */
type VersionAuthorColumns = {
  author_kind: "person" | "ai" | "automatic" | "session" | "merge";
  /** The event log's word for the kind (`domain_events.actor_type`), which the old rows carried. */
  actor_type: "user" | "ai_agent" | "system";
  /** `actors.type` where the screen needs it: a session says 'session'. */
  author_row_type: string | null;
};
export const authorColumns = (authorKind: string): VersionAuthorColumns => ({
  author_kind: authorKind as VersionAuthorColumns["author_kind"],
  actor_type: authorKind === "ai" ? "ai_agent" : authorKind === "automatic" || authorKind === "merge" ? "system" : "user",
  author_row_type: authorKind === "session" ? "session" : null,
});

type StoredBodyRow = {
  /** The version's key (`s:…`, `g:…`, `b:…`): the version's address on the wire. */
  id: string;
  title: string | null;
  markdown: string;
  changed_at: Date;
  author_kind: string;
  author_name: string | null;
  /** `actors.type` of the person's row (a session has none: the kind says it). */
  row_type: string | null;
  /** Made on another device than this one (recorded_by is not this node). */
  elsewhere: boolean;
};

/** The note's versions of its text, newest first, `limit` of them, one row per time point (what `?raw=1` lists): a version with the title and text of
 *  the one before it is no time point (a note carried in by a backup has its creation here and the same text again as the last carried save). */
export async function listBodyVersions(workspaceId: string, nodeId: string, limit: number): Promise<StoredBodyRow[]> {
  return (await sql<StoredBodyRow>`
    WITH vs AS (
      SELECT v.version_key AS id, v.title, v.at::timestamptz AS changed_at, v.author_kind, v.author_id, v.source_name, ${AUTHOR_REF} AS author_ref,
             ${ELSEWHERE} AS elsewhere, v.content_hash,
             row_number() OVER (ORDER BY ${VERSION_ORDER_ASC}) AS rk
        FROM note_versions v
        JOIN blobs b ON b.hash = v.content_hash
       WHERE v.note_id = ${nodeId}::uuid AND v.workspace_id = ${workspaceId}::uuid AND v.unit = 'body' AND ${STATE}
    ),
    flagged AS (
      SELECT vs.*, (content_hash IS DISTINCT FROM lag(content_hash) OVER w OR title IS DISTINCT FROM lag(title) OVER w) AS keep
        FROM vs WINDOW w AS (ORDER BY rk)
    )
    SELECT f.id, f.title, bl.content AS markdown, f.changed_at, f.author_kind, coalesce(f.source_name, a.name) AS author_name, a.type AS row_type, f.elsewhere
      FROM flagged f JOIN blobs bl ON bl.hash = f.content_hash LEFT JOIN actors a ON a.id::text = f.author_ref
     WHERE f.keep ORDER BY f.rk DESC LIMIT ${limit}`.execute(db)).rows;
}

/** The same list without the text: the key, title and time of each (the paragraph history's light feed). */
export async function listBodyVersionHeads(workspaceId: string, nodeId: string, limit: number): Promise<Array<{ id: string; title: string | null; changed_at: Date }>> {
  return (await sql<{ id: string; title: string | null; changed_at: Date }>`
    WITH vs AS (
      SELECT v.version_key AS id, v.title, v.content_hash, v.at::timestamptz AS changed_at, row_number() OVER (ORDER BY ${VERSION_ORDER_ASC}) AS rk
        FROM note_versions v WHERE v.note_id = ${nodeId}::uuid AND v.workspace_id = ${workspaceId}::uuid AND v.unit = 'body' AND ${STATE}
    ),
    flagged AS (SELECT vs.*, (content_hash IS DISTINCT FROM lag(content_hash) OVER w OR title IS DISTINCT FROM lag(title) OVER w) AS keep FROM vs WINDOW w AS (ORDER BY rk))
    SELECT id, title, changed_at FROM flagged WHERE keep ORDER BY rk DESC LIMIT ${limit}`.execute(db)).rows;
}

export const AUTHOR_REF = sql.raw(AUTHOR_REF_SQL);

/** True when the version was recorded by another node than this one (`recorded_by` is only that: it never names a device). */
export const ELSEWHERE = sql.raw("v.recorded_by IS DISTINCT FROM (SELECT node_id FROM sync_node WHERE singleton)");

type BodySessionRow = {
  id: string;
  title: string | null;
  markdown: string;
  changed_at: Date;
  author_kind: string;
  author_name: string | null;
  row_type: string | null;
  elsewhere: boolean;
  saves: number;
  is_restore: boolean;
  /** The note's earliest remembered state (migration 220's baseline): it says so, it is not an edit someone made. A baseline that is NOT the first state (migration 220 mints one for
   *  the content a note holds that no version names, which can come after older saves) is an ordinary row: "earliest" would be wrong. */
  is_baseline: boolean;
  /** The key of the list row that holds the version this one put back; null when it put back none, or one the list does not hold. */
  restored_from: string | null;
};

/** The note's versions merged into sessions, newest first, `limit` rows (the version list). One run of saves by one author, none more than
 *  5 minutes after the one before, is one row, shown by its last save; creating, restoring and a save that won a body conflict start a row
 *  of their own, and the save after a restore starts the next. A version with the title and text of the one before it is no time point and is
 *  folded into that one (a note carried in by a backup has its creation here and the same text again as its last carried save); a restore
 *  that named it finds the row that holds the one before. */
export async function listBodySessions(workspaceId: string, nodeId: string, limit: number): Promise<BodySessionRow[]> {
  return (await sql<BodySessionRow>`
    WITH vs AS (
      SELECT v.version_key, v.kind, v.title, v.content_hash, v.at::timestamptz AS at, v.author_kind, v.author_id, ${AUTHOR_REF} AS author_ref, v.recorded_by, v.source_name, v.restored_from,
             -- a restore is a row of its own (main's rule: NODE_RESTORED, or an undo's NODE_UPDATED with tx_meta.restored_from). restored_from names the version put back only when
             -- there is one with the same content (migration 220, a local undo), so the save that MINTED the version says whether it was a restore (the earliest event, as 220 decides)
             (v.kind = 'restored' OR v.restored_from IS NOT NULL
              OR coalesce((SELECT e.event_type = 'NODE_RESTORED' OR e.tx_meta ? 'restored_from'
                             FROM note_version_events me JOIN domain_events e ON e.id = me.event_id
                            WHERE me.note_id = v.note_id AND me.unit = 'body' AND me.version_key = v.version_key
                            ORDER BY me.event_id LIMIT 1), false)) AS is_restore,
             -- a save that won a body conflict starts a row: the body it overrode stays its own restore point (the inbox is this node's own record)
             EXISTS (SELECT 1 FROM note_version_events ve JOIN domain_events c ON c.triggered_by_event_id = ve.event_id
                      WHERE ve.note_id = v.note_id AND ve.unit = 'body' AND ve.version_key = v.version_key
                        AND c.event_type = 'BODY_CONFLICT' AND c.target_id = ${nodeId} AND c.workspace_id = ${workspaceId}::uuid) AS won_conflict,
             ${ELSEWHERE} AS elsewhere,
             row_number() OVER (ORDER BY ${VERSION_ORDER_ASC}) AS rk
        FROM note_versions v
        JOIN blobs b ON b.hash = v.content_hash
       WHERE v.note_id = ${nodeId}::uuid AND v.workspace_id = ${workspaceId}::uuid AND v.unit = 'body' AND ${STATE}
    ),
    flagged AS (
      SELECT vs.*, (content_hash IS DISTINCT FROM lag(content_hash) OVER w OR title IS DISTINCT FROM lag(title) OVER w) AS keep
        FROM vs WINDOW w AS (ORDER BY rk)
    ),
    -- a folded version belongs to the time point before it
    anchored AS (SELECT *, max(CASE WHEN keep THEN rk END) OVER (ORDER BY rk) AS anchor_rk FROM flagged),
    bodies AS (SELECT * FROM anchored WHERE keep),
    marked AS (
      SELECT bodies.*,
             CASE WHEN lag(at) OVER w IS NULL
                    OR at - lag(at) OVER w > interval '5 minutes'
                    OR author_kind IS DISTINCT FROM lag(author_kind) OVER w
                    OR author_id IS DISTINCT FROM lag(author_id) OVER w
                    OR author_ref IS DISTINCT FROM lag(author_ref) OVER w
                    OR recorded_by IS DISTINCT FROM lag(recorded_by) OVER w
                    -- history carried in from another workspace keeps its source's author name: saves by different people are different authors
                    OR source_name IS DISTINCT FROM lag(source_name) OVER w
                    -- a creation, a restore and anything but an ordinary save is a row of its own, and so is the save after it
                    OR kind <> 'updated' OR lag(kind) OVER w <> 'updated'
                    OR is_restore OR lag(is_restore) OVER w
                    OR won_conflict
                  THEN 1 ELSE 0 END AS boundary
        FROM bodies WINDOW w AS (ORDER BY rk)
    ),
    sessions AS (SELECT *, sum(boundary) OVER (ORDER BY rk) AS session_no FROM marked),
    collapsed AS (
      SELECT DISTINCT ON (session_no) *, count(*) OVER (PARTITION BY session_no) AS saves
        FROM sessions ORDER BY session_no, rk DESC
    )
    SELECT c.version_key AS id, c.title, b.content AS markdown, c.at AS changed_at, c.author_kind,
           coalesce(c.source_name, a.name) AS author_name, a.type AS row_type, c.elsewhere, c.saves::int AS saves, c.is_restore, (c.kind = 'baseline' AND c.rk = 1) AS is_baseline,
           -- the row that holds the version this one put back
           (SELECT c2.version_key FROM anchored t JOIN sessions s2 ON s2.rk = t.anchor_rk JOIN collapsed c2 ON c2.session_no = s2.session_no
             WHERE c.is_restore AND t.version_key = c.restored_from) AS restored_from
      FROM collapsed c
      JOIN blobs b ON b.hash = c.content_hash
 LEFT JOIN actors a ON a.id::text = c.author_ref
     ORDER BY c.rk DESC LIMIT ${limit}`.execute(db)).rows;
}

/** The version before `versionKey` in the note's order (its text and title), or null when it is the first or the text is gone. */
export async function bodyBefore(workspaceId: string, nodeId: string, versionKey: string): Promise<{ title: string | null; hash: string } | null> {
  const row = (await sql<{ title: string | null; hash: string }>`
    WITH ordered AS (
      SELECT v.version_key, v.title, v.content_hash,
             row_number() OVER (ORDER BY ${VERSION_ORDER_ASC}) AS rk
        FROM note_versions v WHERE v.note_id = ${nodeId}::uuid AND v.workspace_id = ${workspaceId}::uuid AND v.unit = 'body' AND ${STATE})
    SELECT p.title, p.content_hash AS hash FROM ordered p JOIN ordered me ON me.rk = p.rk + 1 WHERE me.version_key = ${versionKey}`.execute(db)).rows[0];
  return row ?? null;
}
