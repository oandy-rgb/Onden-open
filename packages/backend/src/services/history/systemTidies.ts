// 「系統整理」: what the system did to notes' text that no person edited — today the block-id migration
// (services/blockIdMigration.ts) moving old `^id` marks out of the text, and its way back. Each pass writes one ordinary
// NODE_UPDATED per note, which is right for the note's own version list (the text did change) but would fill a day of
// History with a "note edited" row per note. History shows one row per pass instead —
// 「系統整理了 N 篇筆記的段落標記」 — and the day's own edit lists leave these saves out (bodyEvents.ts editEventSql).
// The rows carry titles, never ids; the notes are the ones the reader may read.

import { isCalendarDay } from "@onden/markdown";
import { sql } from "kysely";
import { db } from "../../dbKysely.js";
import { localDayId, sqlDayStart } from "../../localDay.js";
import type { ActorCtx } from "../../types.js";
import { readableAmong } from "../readPolicy.js";
import type { DayTidy } from "@onden/contract";

import { SYSTEM_TIDY_CONTEXTS, bodyEventSql } from "./bodyEvents.js";

import { liveNodeSql } from "../../spine/nodeSql.js";

/** The tidy passes between two instants, newest first, each with the notes `actor` may read (a pass with none is not
 *  listed). Which day a pass belongs to is the caller's: it cuts days on the workspace clock. */
export async function systemTidiesBetween(
  actor: ActorCtx, workspaceId: string, bounds: { from: Date; to: Date }, spaceId?: string,
): Promise<Array<DayTidy & { atDate: Date }>> {
  const rows = (await sql<{ batch: string | null; context: string; at: Date; node_id: string; title: string; space_id: string | null }>`
    SELECT e.tx_meta->>'conversion_batch' AS batch, e.tx_meta->>'ui_context' AS context, e.created_at AS at,
           n.id::text AS node_id, n.title, n.space_id::text AS space_id
      FROM domain_events e JOIN content_nodes n ON n.id::text = e.target_id AND n.workspace_id = e.workspace_id
     WHERE e.workspace_id = ${workspaceId} AND ${sql.raw(bodyEventSql("e"))}
       AND e.tx_meta->>'ui_context' IN (${sql.join(SYSTEM_TIDY_CONTEXTS.map((c) => sql.lit(c)))})
       AND e.created_at >= ${bounds.from} AND e.created_at < ${bounds.to}
       AND ${sql.raw(liveNodeSql("n"))} ${spaceId ? sql`AND n.space_id = ${spaceId}` : sql``}
     ORDER BY e.created_at DESC, e.id DESC`.execute(db)).rows;
  if (rows.length === 0) return [];
  const readable = await readableAmong(actor, workspaceId, [...new Set(rows.map((r) => r.node_id))]);
  const passes = new Map<string, DayTidy & { atDate: Date }>();
  for (const r of rows) {
    if (!readable.has(r.node_id)) continue;
    const key = `${r.context}:${r.batch ?? r.at.toISOString()}`;
    let pass = passes.get(key);
    if (!pass) {
      pass = { batch: r.batch ?? "", at: r.at.toISOString(), atDate: r.at, kind: r.context === "system.block_id_revert" ? "marks_written_back" : "marks_moved_out", notes: [] };
      passes.set(key, pass);
    }
    if (!pass.notes.some((n) => n.id === r.node_id)) pass.notes.push({ id: r.node_id, title: r.title, space_id: r.space_id });
  }
  return [...passes.values()];
}

/** The tidy passes on each local day of [from, to] (day ids), by day, newest first. */
export async function systemTidiesByDay(actor: ActorCtx, workspaceId: string, from: string, to: string, spaceId?: string): Promise<Map<string, DayTidy[]>> {
  if (!isCalendarDay(from) || !isCalendarDay(to)) throw new Error("not a day");
  const bounds = (await sql<{ from: Date; to: Date }>`SELECT ${sql.raw(sqlDayStart(`'${from}'::date`))} AS "from", ${sql.raw(sqlDayStart(`'${to}'::date + 1`))} AS "to"`.execute(db)).rows[0]!;
  const out = new Map<string, DayTidy[]>();
  for (const { atDate, ...pass } of await systemTidiesBetween(actor, workspaceId, bounds, spaceId)) {
    const day = localDayId(atDate);
    (out.get(day) ?? out.set(day, []).get(day)!).push(pass);
  }
  return out;
}
