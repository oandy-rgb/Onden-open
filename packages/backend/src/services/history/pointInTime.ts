// The workspace as it was at an instant T (History → 「那天的樣子」, and the
// plan behind 「還原到這時」).
//
// What the event log can rebuild reliably (docs/architecture/history-api.md):
//   * title and body — the last NODE_CREATED / NODE_UPDATED / NODE_RESTORED
//     with a body_hash at or before T (the text is in `blobs`);
//   * whether the note existed — a body event at or before T, and the last
//     NODE_CREATED / NODE_DELETED / NODE_UNDELETED at or before T is not a delete.
// Not rebuilt: position (parent_id) and tags. A NODE_CREATED does not always
// record its parent, and notes move through several paths (space moves, tag
// merges, promotion) whose events do not all carry the old place, so a
// reconstruction could be wrong. A rewind leaves both as they are now.
//
// Statuses, comparing T with now, over the notes `actor` can read (live ones
// live ones and deleted-but-retained ones, readableNotes.ts):
//   same           there at T, same title and text now
//   changed        there at T, title or text differ now
//   deleted_since  there at T, in 最近刪除 now
//   created_since  born after T: its NODE_CREATED is after T and no body event is at or before T.
//                  Only this positive evidence counts, so a note whose creation
//                  event is missing or of another kind is never "created since".
//                  One already in 最近刪除 is not listed (nothing to do for it),
//                  except for a rewind, which asks for it (`includeTrashedNewborn`).
// A note that was in the trash at T and is live now has none of these and is
// left alone.

import { q } from "../../db.js";
import type { ActorCtx } from "../../types.js";
import { bodiesByHash, bodyEventSql } from "./bodyEvents.js";
import { readableNotesSql } from "./readableNotes.js";
import { summarizeChange, type ChangeSummary } from "@onden/markdown";
import type { AtNote, NoteAt, NoteStatus, WorkspaceAt } from "@onden/contract";

export type NoteAtState = {
  id: string;
  /** Title at T (the current title for a note born after T). */
  title_then: string;
  title_now: string;
  space_id: string | null;
  status: NoteStatus;
  /** Body hash at T; null for a note born after T. */
  body_hash_then: string | null;
  /** In 最近刪除 now. Only a `created_since` note listed through `includeTrashedNewborn` has it true. */
  trashed_now?: true;
  /** Already in 最近刪除 at T (its last life event at or before T is a delete). Only listed through `includeTrashedThen`,
   *  with status `same` (nothing to rewind in it), and `trashed_now` when it is still there. */
  trashed_then?: true;
};

export type SpaceScope = { spaceId?: string };

export type NoteStatesOptions = {
  /** Also list notes born after T that are in 最近刪除 now (status `created_since`, `trashed_now`). Only a rewind
   *  wants them: undeleting an older note brings its deleted subtree back, and the ones born after T must go again. */
  includeTrashedNewborn?: boolean;
  /** Also list notes that were in 最近刪除 at T. Only a rewind wants them: undeleting a parent brings back the subtree
   *  deleted with it, and the ones that were already deleted at T must go again. */
  includeTrashedThen?: boolean;
};

/** Largest `changed` list that also gets its paragraph numbers (bodies are read for each). */
export const CHANGE_SUMMARY_LIMIT = 300;

/** The state of every readable note at `at`, one query. */
export async function noteStatesAt(actor: ActorCtx, workspaceId: string, at: Date, { spaceId }: SpaceScope = {}, onlyId?: string, { includeTrashedNewborn = false, includeTrashedThen = false }: NoteStatesOptions = {}): Promise<NoteAtState[]> {
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

export async function workspaceAt(actor: ActorCtx, workspaceId: string, at: Date, space: SpaceScope = {}): Promise<WorkspaceAt> {
  const states = await noteStatesAt(actor, workspaceId, at, space);
  const counts = { same: 0, changed: 0, deleted_since: 0, created_since: 0, total: states.length };
  for (const s of states) counts[s.status]++;
  const differing = states.filter((s) => s.status !== "same");

  const summarized = differing.filter((s) => s.status === "changed").slice(0, CHANGE_SUMMARY_LIMIT);
  const now = summarized.length === 0 ? [] : (await q<{ id: string; markdown: string }>(
    `SELECT id::text, markdown FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
    [workspaceId, summarized.map((s) => s.id)],
  )).rows;
  const nowOf = new Map(now.map((r) => [r.id, r.markdown]));
  const thenOf = await bodiesByHash(summarized.flatMap((s) => (s.body_hash_then ? [s.body_hash_then] : [])));
  const notes: AtNote[] = differing.map(({ body_hash_then, status, ...rest }) => {
    const then = body_hash_then ? thenOf.get(body_hash_then) : undefined;
    const current = nowOf.get(rest.id);
    return {
      ...rest,
      status: status as AtNote["status"],
      change: status === "changed" && then !== undefined && current !== undefined ? summarizeChange(then, current) : null,
    };
  });
  const order: Record<AtNote["status"], number> = { changed: 0, deleted_since: 1, created_since: 2 };
  notes.sort((a, b) => order[a.status] - order[b.status] || a.title_now.localeCompare(b.title_now) || a.id.localeCompare(b.id));
  return { at: at.toISOString(), counts, notes };
}

/** One note then and now, for the then-vs-now diff. null: unreadable, or not a note this view lists. */
export async function noteAt(actor: ActorCtx, workspaceId: string, nodeId: string, at: Date, space: SpaceScope = {}): Promise<NoteAt | null> {
  const state = (await noteStatesAt(actor, workspaceId, at, space, nodeId)).find((s) => s.id === nodeId);
  if (!state) return null;
  const now = (await q<{ markdown: string; deleted: boolean }>(
    `SELECT markdown, (deleted_at IS NOT NULL) AS deleted FROM content_nodes WHERE workspace_id = $1 AND id = $2`, [workspaceId, nodeId],
  )).rows[0];
  if (!now) return null;
  const then = state.body_hash_then ? (await bodiesByHash([state.body_hash_then])).get(state.body_hash_then) ?? null : null;
  return {
    id: state.id, status: state.status, title_then: state.title_then, markdown_then: then,
    title_now: state.title_now, markdown_now: now.markdown, deleted: now.deleted,
  };
}
