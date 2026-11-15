// What History calls a "save": a NODE_CREATED / NODE_UPDATED / NODE_RESTORED
// event that carries a body_hash (the text itself is in `blobs`). The version
// list, the day's edits, agent runs, "the workspace at T" and rewind all read
// the same events, so the rule for "which events change a note's text" and the
// two lookups built on it (the last body before a cut, the text behind a hash)
// live here and nowhere else. A new kind of body-changing event is added in
// BODY_EVENT_TYPES and every History page sees it.
//
// A drawing's saves are another kind of event (`ink_data` or `board_ink` attribute
// set, inkEventSql): not a body save, but an edit all the same, so the day's
// edits count all of them (editEventSql, startsNewEditSql) and inkChanges.ts compares them.

import { INK_KIND_ATTR, INK_PAGE_ATTRS, type InkKind } from "@onden/markdown/ink";
import { q } from "../../db.js";
import { sqlDayStart } from "../../localDay.js";

/** The ui_context of the saves that are a system tidy (systemTidies.ts): History lists them once per pass, not as edits. */
export const SYSTEM_TIDY_CONTEXTS = ["system.block_id_migration", "system.block_id_revert"] as const;

const BODY_EVENT_TYPES = ["NODE_CREATED", "NODE_UPDATED", "NODE_RESTORED"] as const;

/** `alias` is a domain_events row that is a save (changes its note's text). */
export function bodyEventSql(alias: string): string {
  return `${alias}.event_type IN (${BODY_EVENT_TYPES.map((t) => `'${t}'`).join(",")}) AND ${alias}.payload ? 'body_hash'`;
}

/** Who wrote a save, as the version list and a backup say it. A version carried in from another workspace is stored with
 *  actor_type 'user' (spine/importedHistory.ts): every reader that looks for AI work by actor_type (the review inbox,
 *  agent runs, the day lens) then leaves it out without a condition of its own; the source's kind rides in
 *  tx_meta.history_import and only the readers that show authorship come here. */
export const versionActorTypeSql = (alias: string): string =>
  `coalesce(${alias}.tx_meta->'history_import'->>'actor_type', ${alias}.actor_type)`;

/** `alias` is a save made on the workspace-clock day `dateExpr` (a SQL `date` expression, localDay.ts
 *  sqlDayStart): "a note was edited on a day" means this and nothing else — the day lens (services/dayLens.ts)
 *  asks it directly; History's per-day lists cut the same days from their collapsed edits' last save. */
export function saveOnDaySql(alias: string, dateExpr: string): string {
  return `${bodyEventSql(alias)} AND ${alias}.created_at >= ${sqlDayStart(dateExpr)} AND ${alias}.created_at < ${sqlDayStart(`${dateExpr} + 1`)}`;
}

/** `alias` is a save made before migration 172 moved this note's whiteboard pen layer from `ink_data` to
 *  `board_ink` (board_ink_moves, action 'moved'): its event still says `ink_data`, but the drawing was the
 *  board's. A 'copied' note is ambiguous, so its old saves stay with the handwriting page. An undone move
 *  (restored_at) put the layer back in `ink_data`, so those saves are plain `ink_data` again. */
const movedFromInkDataSql = (alias: string): string =>
  `EXISTS (SELECT 1 FROM board_ink_moves m WHERE m.node_id::text = ${alias}.target_id AND m.action = 'moved' AND m.restored_at IS NULL AND ${alias}.created_at < m.moved_at)`;

/** `alias` is a domain_events row that is a drawing save: an ink attribute set (the drawing, content-addressed in
 *  `blobs` by `value_ref`) or removed. Not a "body" event: the text of the note did not change.
 *  `kind` picks one drawing — "handwriting" (`ink_data`, minus the saves that were really the board's before
 *  migration 172), "board" (`board_ink`, plus those) or "note" (`note_ink`, a note's 手寫 tab) — and none means any. */
export function inkEventSql(alias: string, kind?: InkKind): string {
  const action = `${alias}.event_type IN ('ATTRIBUTE_SET','ATTRIBUTE_DELETED')`;
  const key = `${alias}.payload->>'key'`;
  if (!kind) return `${action} AND ${key} IN (${INK_PAGE_ATTRS.map((k) => `'${k}'`).join(",")})`;
  if (kind === "note") return `${action} AND ${key} = '${INK_KIND_ATTR.note}'`;
  if (kind === "board") return `${action} AND (${key} = '${INK_KIND_ATTR.board}' OR (${key} = '${INK_KIND_ATTR.handwriting}' AND ${movedFromInkDataSql(alias)}))`;
  return `${action} AND ${key} = '${INK_KIND_ATTR.handwriting}' AND NOT ${movedFromInkDataSql(alias)}`;
}

/** `alias` is an edit of the note's content, written or drawn: what the day's edits and the "earlier" paging count. A system
 *  tidy (systemTidies.ts) is not an edit of the person's: History lists it once per pass, not once per note. */
export const editEventSql = (alias: string): string =>
  `((${bodyEventSql(alias)} AND coalesce(${alias}.tx_meta->>'ui_context', '') NOT IN (${SYSTEM_TIDY_CONTEXTS.map((c) => `'${c}'`).join(",")})) OR (${inkEventSql(alias)}))`;

/** A boolean over window `w` (the note's saves, oldest first): this save starts a new edit. A run of saves
 *  to one note by one actor, none more than 5 minutes after the one before, is one edit; creating, restoring
 *  and removing a drawing are edits of their own. Typing and drawing both continue an edit. */
export function startsNewEditSql(w: string): string {
  return `(lag(created_at) OVER ${w} IS NULL
          OR created_at - lag(created_at) OVER ${w} > interval '5 minutes'
          OR actor_id IS DISTINCT FROM lag(actor_id) OVER ${w}
          OR event_type NOT IN ('NODE_UPDATED','ATTRIBUTE_SET') OR lag(event_type) OVER ${w} NOT IN ('NODE_UPDATED','ATTRIBUTE_SET'))`;
}

/** A scalar subquery: what `pick` (an expression over the event `p`) is for `node`'s last event of a kind
 *  before a cut, or NULL when there is none. `workspace` and `node` are SQL expressions (`$1`, `x.node_id`);
 *  the cut is an instant (`time`: events strictly before it) or an event id (`eventId`: a smaller id). */
function lastBeforeSql(pick: string, kind: (alias: string) => string, workspace: string, node: string, cut: { time: string } | { eventId: string }): string {
  const [where, order] = "time" in cut
    ? [`p.created_at < ${cut.time}`, "p.created_at DESC, p.id DESC"]
    : [`p.id < ${cut.eventId}`, "p.id DESC"];
  return `(SELECT ${pick} FROM domain_events p
            WHERE p.workspace_id = ${workspace} AND p.target_id = ${node} AND ${kind("p")} AND ${where}
            ORDER BY ${order} LIMIT 1)`;
}

/** The body_hash of `node`'s last save before a cut (NULL: it has none). */
export const lastBodyHashBeforeSql = (workspace: string, node: string, cut: { time: string } | { eventId: string }): string =>
  lastBeforeSql("p.payload->>'body_hash'", bodyEventSql, workspace, node, cut);

/** The id (text) of `node`'s last save of one drawing before a cut (NULL: it has none). */
export const lastInkEventBeforeSql = (kind: InkKind, workspace: string, node: string, cut: { time: string } | { eventId: string }): string =>
  lastBeforeSql("p.id::text", (alias) => inkEventSql(alias, kind), workspace, node, cut);

/** Body text by hash; a hash whose blob is gone is missing from the map. */
export async function bodiesByHash(hashes: string[]): Promise<Map<string, string>> {
  if (hashes.length === 0) return new Map();
  const r = await q<{ hash: string; content: string }>(`SELECT hash, content FROM blobs WHERE hash = ANY($1::text[])`, [[...new Set(hashes)]]);
  return new Map(r.rows.map((b) => [b.hash, b.content]));
}

