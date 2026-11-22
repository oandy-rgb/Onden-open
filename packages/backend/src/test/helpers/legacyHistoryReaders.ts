// THE ORACLE for the proof of history-replication batch 2: the readers of a note's text, drawings and "the workspace at T" as they were
// BEFORE they read the version tables, copied here from the code of origin/main at 4c66a2eae+ (services/history/noteVersions.ts, pointInTime.ts,
// inkChanges.ts, nodeReads.ts, nodeUpdate.ts restoreNodeVersion). They read domain_events. Test code only: the product no longer has them
// (a tag's description and a system note keep reading events: services/history/noteVersions.ts, its last section). historyReadersMatchEvents.integration.test.ts
// runs these and the product's readers on one database and compares them row for row.
import { shownAuthorKind, shownAuthorName, versionAuthor } from "../../services/authorName.js";
import { q } from "../../db.js";
import { sqlDayStart } from "../../localDay.js";
import type { ActorCtx } from "../../types.js";
import { bodiesByHash, bodyEventSql, inkEventSql, versionActorTypeSql, startsNewEditSql } from "../../services/history/bodyEvents.js";
import { readableNotesSql } from "../../services/history/readableNotes.js";
import { absorbSameText, actorKindOf, describeVersions, type VersionRow } from "../../services/history/noteVersions.js";
import type { NoteAtState, NoteStatesOptions, SpaceScope } from "../../services/history/pointInTime.js";
import { readInkValues } from "../../services/inkChunks.js";
import { INK_KIND_ATTR, inkChangeSummary, type InkKind } from "@onden/markdown/ink";
import type { DayInkChange, InkEdit } from "@onden/contract";

const EVENT_ID = /^\d{1,18}$/;

/** The id (text) of `node`'s last save of one drawing before an instant (NULL: it has none): the fragment bodyEvents.ts had before the readers moved. */
const lastInkEventBeforeSql = (kind: InkKind, workspace: string, node: string, cut: { time: string }): string =>
  `(SELECT p.id::text FROM domain_events p WHERE p.workspace_id = ${workspace} AND p.target_id = ${node} AND ${inkEventSql("p", kind)} AND p.created_at < ${cut.time}
     ORDER BY p.created_at DESC, p.id DESC LIMIT 1)`;

/** 清單最多幾列；多抓一列只為了算最後一列的摘要。 */
const VERSION_LIMIT = 50;

type RawVersion = {
  id: string;
  title: string | null;
  markdown: string;
  changed_at: Date;
  actor_name: string | null;
  actor_type: string;
};

/**
 * 這篇筆記的版本。`raw` = 未合併的儲存事件（最新 50 筆，只多一個 actor_kind）；
 * 否則是合併後的清單，附 summary／markers／restored_from。筆記對 actor 不可讀 → null。
 */
export async function legacyListNoteVersions(workspaceId: string, nodeId: string, opts: { raw: boolean }): Promise<Array<Record<string, unknown>>> {
  if (opts.raw) {
    const raw = await q<Omit<RawVersion, "actor_name"> & { imported: boolean; import_name: string | null; row_name: string | null; row_type: string | null }>(
      `SELECT e.id, (e.payload->>'title') AS title, b.content AS markdown,
              e.created_at AS changed_at, (e.tx_meta ? 'history_import') AS imported, e.tx_meta->'history_import'->>'actor_name' AS import_name, a.name AS row_name, a.type AS row_type, ${versionActorTypeSql("e")} AS actor_type
         FROM domain_events e
         JOIN blobs b ON b.hash = e.payload->>'body_hash'
    LEFT JOIN actors a ON a.id::text = e.actor_id
        WHERE e.target_id = $1 AND e.workspace_id = $2
          AND ${bodyEventSql("e")}
        ORDER BY e.created_at DESC, e.id DESC LIMIT ${VERSION_LIMIT}`,
      [nodeId, workspaceId],
    );
    return raw.rows.map(({ imported, import_name, row_name, row_type, ...r }) => {
      const author = versionAuthor({ imported, import_name, row_name, row_type });
      return { ...r, actor_name: shownAuthorName(author.rowType, author.name), actor_kind: shownAuthorKind(author.rowType, actorKindOf(r.actor_type)) };
    });
  }

  const result = await q<Omit<VersionRow, "restored_from" | "actor_name" | "author_row_type"> & { restored_at: Date | null; imported: boolean; import_name: string | null; row_name: string | null; row_type: string | null }>(
    `WITH saves AS (
       SELECT e.id, e.actor_id, ${versionActorTypeSql("e")} AS actor_type, e.created_at,
              (e.payload->>'title') AS title, e.payload->>'body_hash' AS body_hash,
              e.event_type, e.tx_meta->'history_import'->>'actor_name' AS import_actor, (e.tx_meta ? 'history_import') AS imported,
              -- 還原：NODE_RESTORED（版本還原）或 eventRestore 寫的 NODE_UPDATED（tx_meta.restored_from）
              (e.event_type = 'NODE_RESTORED' OR e.tx_meta ? 'restored_from') AS is_restore,
              CASE WHEN e.event_type = 'NODE_RESTORED' THEN e.payload->>'version_id'
                   ELSE e.tx_meta->>'restored_from' END AS restored_id,
              -- 內文與標題都和前一筆相同的儲存（舊版沒變也會記）不是新的時間點
              (e.payload->>'body_hash' IS DISTINCT FROM lag(e.payload->>'body_hash') OVER w
               OR e.payload->>'title' IS DISTINCT FROM lag(e.payload->>'title') OVER w) AS keep
         FROM domain_events e
        WHERE e.target_id = $1 AND e.workspace_id = $2
          AND ${bodyEventSql("e")}
       WINDOW w AS (ORDER BY e.created_at ASC, e.id ASC)
     ),
     -- 被併掉的事件算在它前面留下的那一筆（還原指向它時，仍找得到那一列）
     anchored AS (
       SELECT *, max(CASE WHEN keep THEN id END) OVER (ORDER BY created_at ASC, id ASC) AS anchor_id FROM saves
     ),
     bodies AS (
       SELECT * FROM anchored WHERE keep
     ),
     marked AS (
       SELECT *,
              CASE WHEN lag(created_at) OVER w IS NULL
                     OR created_at - lag(created_at) OVER w > interval '5 minutes'
                     OR actor_id IS DISTINCT FROM lag(actor_id) OVER w
                     -- history carried in from another workspace is all attributed to the importer's id; its saves by different
                     -- people (the name it kept) are still different authors
                     OR import_actor IS DISTINCT FROM lag(import_actor) OVER w
                     -- restores and creates are single-event sessions: they
                     -- start one AND the next save starts fresh, so the
                     -- created/restored baseline never coalesces away
                     OR event_type <> 'NODE_UPDATED'
                     OR lag(event_type) OVER w <> 'NODE_UPDATED'
                     OR is_restore OR lag(is_restore) OVER w
                     -- a save that won a body conflict starts a session: the
                     -- body it overrode (the previous row, even by the same
                     -- actor in another tab) stays its own restore point
                     OR id IN (SELECT triggered_by_event_id FROM domain_events
                                WHERE target_id = $1 AND workspace_id = $2
                                  AND event_type = 'BODY_CONFLICT'
                                  AND triggered_by_event_id IS NOT NULL)
                   THEN 1 ELSE 0 END AS boundary
         FROM bodies
       WINDOW w AS (ORDER BY created_at ASC, id ASC)
     ),
     sessions AS (
       SELECT *, sum(boundary) OVER (ORDER BY created_at ASC, id ASC) AS session_no
         FROM marked
     ),
     collapsed AS (
       SELECT DISTINCT ON (session_no)
              session_no, id, actor_id, actor_type, import_actor, imported, created_at, title, body_hash,
              is_restore, restored_id,
              count(*) OVER (PARTITION BY session_no) AS saves
         FROM sessions
        ORDER BY session_no, created_at DESC, id DESC
     )
     SELECT c.id::text AS id, c.title, b.content AS markdown,
            c.created_at AS changed_at, c.imported, c.import_actor AS import_name, a.name AS row_name, a.type AS row_type, c.actor_type,
            c.saves::int AS saves, c.is_restore,
            -- 被還原的那個事件落在哪一列（用該列的 changed_at 指它）
            (SELECT c2.created_at FROM anchored v
               JOIN sessions s2 ON s2.id = v.anchor_id
               JOIN collapsed c2 ON c2.session_no = s2.session_no
              WHERE c.is_restore AND v.id::text = c.restored_id) AS restored_at
       FROM collapsed c
       JOIN blobs b ON b.hash = c.body_hash
  LEFT JOIN actors a ON a.id::text = c.actor_id
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ${VERSION_LIMIT + 1}`,
    [nodeId, workspaceId],
  );
  // The query reads one row beyond the list only to describe the list's last
  // row; that row is never merged away (absorbSameText keeps the oldest), and a
  // merge above it only makes the list shorter.
  // A session's write is sent as the kind 'session' with no name (services/authorName.ts; describeVersions sets the kind).
  const listed: VersionRow[] = result.rows.map(({ imported, import_name, row_name, row_type, restored_at, ...row }) => {
    const author = versionAuthor({ imported, import_name, row_name, row_type });
    return { ...row, actor_name: shownAuthorName(author.rowType, author.name), author_row_type: author.rowType, restored_from: restored_at ? new Date(restored_at).toISOString() : null };
  });
  const merged = absorbSameText(listed);
  const hasOlder = listed.length > VERSION_LIMIT;
  const rows = hasOlder ? merged.slice(0, -1) : merged;

  // 發布快照序號 = 這個工作區的快照依建立時間排的第幾個（最舊 = #1）
  const snaps = await q<{ n: number; at: Date }>(
    `SELECT n::int AS n, at FROM (
       SELECT row_number() OVER (ORDER BY created_at, id) AS n, created_at AS at,
              payload->'nodes' @> jsonb_build_array(jsonb_build_object('id', $2::text)) AS has_note
         FROM publish_snapshots WHERE workspace_id = $1
     ) s WHERE has_note ORDER BY n DESC LIMIT 50`,
    [workspaceId, nodeId],
  );
  return describeVersions(rows, hasOlder ? merged[merged.length - 1]!.markdown : null, snaps.rows);
}

/** The state of every readable note at `at`, one query. */
export async function legacyNoteStatesAt(actor: ActorCtx, workspaceId: string, at: Date, { spaceId }: SpaceScope = {}, onlyId?: string, { includeTrashedNewborn = false, includeTrashedThen = false }: NoteStatesOptions = {}): Promise<NoteAtState[]> {
  const params: unknown[] = [workspaceId, at.toISOString()];
  const readable = await readableNotesSql(actor, workspaceId, "n", params, { spaceId, includeTrashed: true });
  const onlyNote = onlyId ? ` AND n.id::text = $${params.push(onlyId)}` : "";
  const rows = await q<{
    id: string; title_now: string; space_id: string | null; deleted_now: boolean; deleted_then: boolean;
    title_then: string | null; body_hash: string | null; existed: boolean; born_after: boolean; same_text: boolean;
  }>(
    `WITH cand AS (
       SELECT n.id, n.title, n.markdown, n.space_id, n.deleted_at
         FROM content_nodes n
        WHERE n.workspace_id = $1 AND n.node_type = 'content' AND n.hidden = false
          AND ${readable}${onlyNote}
     ),
     body AS (
       SELECT DISTINCT ON (e.target_id) e.target_id, e.payload->>'title' AS title, e.payload->>'body_hash' AS body_hash
         FROM domain_events e
        WHERE e.workspace_id = $1 AND e.created_at <= $2::timestamptz
          AND ${bodyEventSql("e")}
          AND e.target_id IN (SELECT id::text FROM cand)
        ORDER BY e.target_id, e.created_at DESC, e.id DESC
     ),
     life AS (
       SELECT DISTINCT ON (e.target_id) e.target_id, e.event_type
         FROM domain_events e
        WHERE e.workspace_id = $1 AND e.created_at <= $2::timestamptz
          AND e.event_type IN ('NODE_CREATED','NODE_DELETED','NODE_UNDELETED')
          AND e.target_id IN (SELECT id::text FROM cand)
        ORDER BY e.target_id, e.created_at DESC, e.id DESC
     ),
     born AS (
       SELECT DISTINCT e.target_id
         FROM domain_events e
        WHERE e.workspace_id = $1 AND e.created_at > $2::timestamptz AND e.event_type = 'NODE_CREATED'
          AND e.target_id IN (SELECT id::text FROM cand)
     )
     SELECT c.id::text AS id, c.title AS title_now, c.space_id::text AS space_id, (c.deleted_at IS NOT NULL) AS deleted_now,
            b.title AS title_then, b.body_hash,
            (b.target_id IS NOT NULL AND COALESCE(l.event_type, '') <> 'NODE_DELETED') AS existed,
            (born.target_id IS NOT NULL AND b.target_id IS NULL) AS born_after,
            (l.event_type = 'NODE_DELETED') AS deleted_then,
            COALESCE(bl.content = c.markdown, false) AS same_text
       FROM cand c
       LEFT JOIN body b ON b.target_id = c.id::text
       LEFT JOIN life l ON l.target_id = c.id::text
       LEFT JOIN born ON born.target_id = c.id::text
       LEFT JOIN blobs bl ON bl.hash = b.body_hash
      ORDER BY c.id`,
    params,
  );
  const out: NoteAtState[] = [];
  for (const r of rows.rows) {
    const titleThen = r.title_then ?? r.title_now;
    const base = { id: r.id, title_then: titleThen, title_now: r.title_now, space_id: r.space_id, body_hash_then: r.body_hash };
    if (r.existed) {
      if (r.deleted_now) out.push({ ...base, status: "deleted_since" });
      else out.push({ ...base, status: r.same_text && titleThen === r.title_now ? "same" : "changed" });
    } else if (r.born_after && !r.deleted_now) {
      out.push({ ...base, body_hash_then: null, status: "created_since" });
    } else if (r.born_after && includeTrashedNewborn) {
      out.push({ ...base, body_hash_then: null, status: "created_since", trashed_now: true });
    } else if (r.deleted_then && includeTrashedThen) {
      out.push({ ...base, status: "same", trashed_then: true, ...(r.deleted_now ? { trashed_now: true as const } : {}) });
    }
  }
  return out;
}



/** restoreNodeVersion's lookup of a version by the number of its event. */
export async function legacyLoadVersion(workspaceId: string, nodeId: string, versionId: string): Promise<{ title: string; markdown: string } | null> {
  if (!/^\d{1,18}$/.test(versionId)) return null;
  return (await q<{ title: string; markdown: string }>(
    `SELECT (e.payload->>'title') AS title, b.content AS markdown
       FROM domain_events e
       JOIN blobs b ON b.hash = e.payload->>'body_hash'
      WHERE e.id = $1::bigint AND e.target_id = $2 AND e.workspace_id = $3
        AND e.payload ? 'body_hash'`,
    [versionId, nodeId, workspaceId],
  )).rows[0] ?? null;
}

/** The drawing each save left, by event id: "" for a save that removed the drawing. A save whose drawing
 *  is no longer stored is missing from the map. */
async function drawingsOf(workspaceId: string, eventIds: string[]): Promise<Map<string, string>> {
  if (eventIds.length === 0) return new Map();
  const rows = await q<{ id: string; node_id: string; deleted: boolean; ref: string | null; inline: string | null }>(
    `SELECT e.id::text AS id, e.target_id AS node_id, e.event_type = 'ATTRIBUTE_DELETED' AS deleted,
            e.payload->>'value_ref' AS ref, e.payload->>'value' AS inline
       FROM domain_events e
      WHERE e.workspace_id = $1 AND e.id = ANY($2::bigint[]) AND ${inkEventSql("e")}`,
    [workspaceId, [...new Set(eventIds)]],
  );
  // The text of a ref: a `blobs` row or the note's chunks (inkChunks.ts); one read per note.
  const refsOf = new Map<string, string[]>();
  for (const r of rows.rows) if (!r.deleted && r.ref) refsOf.set(r.node_id, [...(refsOf.get(r.node_id) ?? []), r.ref]);
  const texts = new Map<string, string>();
  for (const [nodeId, refs] of refsOf) for (const [ref, text] of await readInkValues(workspaceId, nodeId, refs)) texts.set(`${nodeId}:${ref}`, text);
  return new Map(rows.rows.flatMap((r) => {
    if (r.deleted) return [[r.id, ""] as const];
    const value = (r.ref ? texts.get(`${r.node_id}:${r.ref}`) : undefined) ?? r.inline;
    return value ? [[r.id, value] as const] : [];
  }));
}


/** Edits listed for one note, newest first. */
const INK_EDIT_LIMIT = 20;

/** One note's edits of one drawing, newest first: a run of saves by one actor within 5 minutes of each other is one
 *  edit (startsNewEditSql), with what it drew and erased against the drawing before it. An edit that changed
 *  nothing countable (the same strokes, or a drawing no longer stored) is left out. null when `actor`
 *  cannot read the note (indistinguishable from a missing one). */
export async function legacyListInkEdits(workspaceId: string, nodeId: string, kind: InkKind): Promise<InkEdit[]> {
  const sessions = await q<{ first_id: string; last_id: string; last_at: Date; actor_name: string | null; author_row_type: string | null; actor_type: string; saves: number }>(
    `WITH saves AS (
       SELECT e.id, e.actor_id, e.actor_type, e.event_type, e.created_at
         FROM domain_events e WHERE e.workspace_id = $1 AND e.target_id = $2 AND ${inkEventSql("e", kind)}
     ),
     marked AS (SELECT *, CASE WHEN ${startsNewEditSql("w")} THEN 1 ELSE 0 END AS boundary FROM saves WINDOW w AS (ORDER BY created_at, id)),
     numbered AS (SELECT *, sum(boundary) OVER (ORDER BY created_at, id) AS edit_no FROM marked)
     SELECT (array_agg(n.id ORDER BY n.created_at, n.id))[1]::text AS first_id,
            (array_agg(n.id ORDER BY n.created_at DESC, n.id DESC))[1]::text AS last_id,
            max(n.created_at) AS last_at, max(a.name) AS actor_name, max(a.type) AS author_row_type, max(n.actor_type) AS actor_type, count(*)::int AS saves
       FROM numbered n LEFT JOIN actors a ON a.id::text = n.actor_id
      GROUP BY n.edit_no ORDER BY n.edit_no`,
    [workspaceId, nodeId],
  );
  // Each edit starts from where the one before it ended; the oldest from nothing.
  const edits = sessions.rows.map((s, i) => ({ ...s, before_event: i > 0 ? sessions.rows[i - 1]!.last_id : null })).slice(-INK_EDIT_LIMIT).reverse();
  const drawings = await drawingsOf(workspaceId, edits.flatMap((e) => (e.before_event ? [e.before_event, e.last_id] : [e.last_id])));
  const out: InkEdit[] = [];
  for (const e of edits) {
    const after = drawings.get(e.last_id);
    const before = e.before_event ? drawings.get(e.before_event) : null;
    if (after === undefined || before === undefined) continue;
    const summary = inkChangeSummary(before, after);
    if (summary.added + summary.erased === 0) continue;
    out.push({
      ...summary, id: e.last_id, before_event: e.before_event, after_event: e.last_id, changed_at: e.last_at.toISOString(),
      actor_name: shownAuthorName(e.author_row_type, e.actor_name), actor_kind: shownAuthorKind(e.author_row_type, actorKindOf(e.actor_type)), saves: e.saves,
    });
  }
  return out;
}


/** Saved versions of one of a note's drawings (newest 50). Older saves stored the value inline, hence the COALESCE. */
export async function legacyInkVersionRows(workspaceId: string, nodeId: string, kind: InkKind) {
  const result = await q<{ id: string; ink_data: string | null; value_ref: string | null; changed_at: string; actor_name: string | null; author_row_type: string | null; actor_type: string }>(
    `SELECT e.id, e.payload->>'value' AS ink_data, e.payload->>'value_ref' AS value_ref,
            e.created_at AS changed_at, a.name AS actor_name, a.type AS author_row_type, e.actor_type
       FROM domain_events e
  LEFT JOIN actors a ON a.id::text = e.actor_id
      WHERE e.target_id = $1 AND e.workspace_id = $2
        AND e.event_type = 'ATTRIBUTE_SET'
        AND ${inkEventSql("e", kind)}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 50`,
    [nodeId, workspaceId],
  );
  // The drawing of each save: a `blobs` row or the note's chunks (inkChunks.ts).
  const texts = await readInkValues(workspaceId, nodeId, result.rows.flatMap((r) => (r.value_ref ? [r.value_ref] : [])));
  return result.rows.map(({ value_ref, author_row_type, ...row }) => ({ ...row, actor_name: shownAuthorName(author_row_type, row.actor_name), actor_kind: shownAuthorKind(author_row_type, actorKindOf(row.actor_type)), ink_data: (value_ref ? texts.get(value_ref) : undefined) ?? row.ink_data }));
}



/** dayInkChanges as it was (the day lens of a drawing): from the last save before the day to the last save of the day. */
export async function legacyDayInkChanges(workspaceId: string, pairs: Array<{ nodeId: string; day: string }>, kind: InkKind): Promise<Map<string, DayInkChange>> {
  if (pairs.length === 0) return new Map();
  const ends = await q<{ node_id: string; day: string; pre: string | null; post: string | null }>(
    `SELECT x.node_id, x.day,
            ${lastInkEventBeforeSql(kind, "$1", "x.node_id", { time: sqlDayStart("x.day::date") })} AS pre,
            ${lastInkEventBeforeSql(kind, "$1", "x.node_id", { time: sqlDayStart("x.day::date + 1") })} AS post
       FROM unnest($2::text[], $3::text[]) AS x(node_id, day)`,
    [workspaceId, pairs.map((p) => p.nodeId), pairs.map((p) => p.day)],
  );
  const changed = ends.rows.filter((r): r is typeof r & { post: string } => r.post !== null && r.post !== r.pre);
  const drawings = await drawingsOf(workspaceId, changed.flatMap((r) => (r.pre ? [r.pre, r.post] : [r.post])));
  const out = new Map<string, DayInkChange>();
  for (const r of changed) {
    const after = drawings.get(r.post);
    const before = r.pre ? drawings.get(r.pre) : null;
    if (after === undefined || before === undefined) continue;
    const summary = inkChangeSummary(before, after);
    if (summary.added + summary.erased > 0) out.set(`${r.day}:${r.node_id}`, { ...summary, before_event: r.pre, after_event: r.post });
  }
  return out;
}
