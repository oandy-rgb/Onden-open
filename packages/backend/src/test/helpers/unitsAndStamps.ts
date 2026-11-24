// What P1 of a received change compares (batch 4a: a derivation writes no unit): every unit of a workspace, every stamp and head, and the clock's next sequence
// number. Shared by test/receivedDerivation.integration.test.ts (one piece) and test/stampedInbox.integration.test.ts (in segments). Inside onNode of the node.
import { q } from "../../db.js";
import { UNIT_SOURCES, rowMatchOf, unitTextsSql, quote } from "../../spine/stampedMerge/dbUnits.js";

/** Every unit of the workspace (row keys and the text of every watched field, by UNIT_SOURCES and its `where`), every stamp and head, and the clock's next
 *  sequence number: what P1 compares just before and just after the derivation. */
export async function unitsAndStamps(workspaceId: string): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const src of UNIT_SOURCES) {
    const m = rowMatchOf(src, []);
    const params: unknown[] = [workspaceId];
    const r = await q<{ d: string | null }>(
      `SELECT md5(string_agg(${m.idSql("t")} || '=' || (${unitTextsSql(src, "t")})::text, ',' ORDER BY ${m.idSql("t")})) AS d
         FROM ${quote(src.table)} t WHERE ${m.workspace("t", "$1")}${src.where ? ` AND ${src.where}` : ""}`, params);
    out[src.label] = r.rows[0]?.d ?? null;
  }
  for (const t of ["sync_stamps", "sync_stamp_heads"]) {
    out[t] = (await q<{ d: string | null }>(`SELECT md5(string_agg(row(s.*)::text, ',' ORDER BY row(s.*)::text)) AS d FROM ${t} s WHERE s.workspace_id = $1`, [workspaceId])).rows[0]?.d ?? null;
  }
  out.next_seq = (await q<{ n: string }>(`SELECT next_seq::text AS n FROM sync_clock WHERE workspace_id = $1`, [workspaceId])).rows[0]?.n ?? null;
  return out;
}

