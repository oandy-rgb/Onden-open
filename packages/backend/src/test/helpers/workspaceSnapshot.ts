// Whole-workspace row snapshots for the cross-workspace sweeps: "did this request change anything of workspace A",
// and "does anything of workspace C now point at A's objects".

import { q } from "../../db.js";

/** All of a workspace's rows, one string per table, to compare before and after a write. */
export async function snapshot(ws: string): Promise<Map<string, string>> {
  const tables = (await q<{ table_name: string }>(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = current_schema() AND c.column_name = 'workspace_id' ORDER BY 1`)).rows.map((r) => r.table_name);
  const out = new Map<string, string>();
  for (const table of tables) {
    const rows = (await q<{ j: string }>(`SELECT row_to_json(t)::text AS j FROM "${table}" t WHERE t.workspace_id = $1 ORDER BY 1`, [ws])).rows;
    out.set(table, rows.map((r) => r.j).join("\n"));
  }
  out.set("workspaces", (await q<{ j: string }>(`SELECT row_to_json(t)::text AS j FROM workspaces t WHERE id = $1`, [ws])).rows.map((r) => r.j).join("\n"));
  const members = (await q<{ j: string }>(
    `SELECT row_to_json(m)::text AS j FROM space_members m JOIN spaces s ON s.id = m.space_id WHERE s.workspace_id = $1 ORDER BY 1`, [ws])).rows;
  out.set("space_members", members.map((r) => r.j).join("\n"));
  return out;
}

export function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [table, rows] of after) if (before.get(table) !== rows) changed.push(table);
  for (const table of before.keys()) if (!after.has(table)) changed.push(table);
  return changed;
}

/** Rows of workspace `ws` (by table) that mention one of `ids` (`except`: a SQL condition per table, on alias `t`, for rows that are not a reference): after a write aimed at another workspace's objects,
 *  nothing of `ws` should point at them. */
export async function tablesMentioning(ws: string, ids: string[], except: Record<string, string> = {}): Promise<string[]> {
  const tables = (await q<{ table_name: string }>(
    `SELECT c.table_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema = current_schema() AND c.column_name = 'workspace_id' ORDER BY 1`)).rows.map((r) => r.table_name);
  const patterns = ids.map((id) => `%${id}%`);
  const out: string[] = [];
  for (const table of tables) {
    const hit = await q(`SELECT 1 FROM "${table}" t WHERE t.workspace_id = $1 AND row_to_json(t)::text LIKE ANY($2::text[])${except[table] ? ` AND NOT (${except[table]})` : ""} LIMIT 1`, [ws, patterns]);
    if (hit.rows.length) out.push(table);
  }
  // The workspace row itself has no workspace_id column (home_node_id lives there).
  const own = await q(`SELECT 1 FROM workspaces t WHERE t.id = $1 AND row_to_json(t)::text LIKE ANY($2::text[]) LIMIT 1`, [ws, patterns]);
  if (own.rows.length) out.push("workspaces");
  return out;
}

