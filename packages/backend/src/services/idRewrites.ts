// History written before migration 201 names rows by the id they had then (events are append-only and are not rewritten).
// id_rewrites holds old -> new for every row that migration changed; an event read for restore follows it, so undo of an
// earlier tag change, space move or settings change lands on the row as it is now instead of on an id nothing has.

import { sql } from "kysely";
import { db } from "../dbKysely.js";

type EventLike = { workspace_id: string; target_id: string; payload: unknown; tx_meta: unknown };

/** `row` with every old id in its target, payload and tx_meta replaced by the new one. The row itself when none occurs. */
export async function followIdRewrites<T extends EventLike>(row: T): Promise<T> {
  const text = JSON.stringify([row.target_id, row.payload, row.tx_meta]);
  const found = await db.selectFrom("id_rewrites")
    .select([sql<string>`old_id::text`.as("old_id"), sql<string>`new_id::text`.as("new_id")])
    .where("workspace_id", "=", row.workspace_id)
    .where(sql<boolean>`strpos(${text}, old_id::text) > 0`)
    .execute();
  if (found.length === 0) return row;
  let next = text;
  for (const { old_id, new_id } of found) next = next.split(old_id).join(new_id);
  const [target_id, payload, tx_meta] = JSON.parse(next) as [string, unknown, unknown];
  return { ...row, target_id, payload, tx_meta };
}

/** `ids` plus what the rewrites map each of them to: from the column `from` to the other one (both are uuid). */
async function withMapped(workspaceId: string, ids: ReadonlySet<string>, from: "old_id" | "new_id"): Promise<Set<string>> {
  if (ids.size === 0) return new Set(ids);
  const to = from === "old_id" ? "new_id" : "old_id";
  const mapped = await db.selectFrom("id_rewrites").select(to).where("workspace_id", "=", workspaceId)
    .where(from, "=", sql<string>`ANY(${[...ids]}::uuid[])`).execute(); // (one array parameter: a site can hold tens of thousands of notes)
  return new Set([...ids, ...mapped.map((r) => r[to])]);
}

/** `ids` plus the id each of them had before migration 201 changed it. A site published before it names its notes by the old
 *  id; the site stays as it was until the next publish, so a note that is on it now is on it under either id. */
export const withFormerIds = (workspaceId: string, ids: ReadonlySet<string>): Promise<Set<string>> => withMapped(workspaceId, ids, "new_id");

/** `ids` plus the id each old one in it has now. A list written before migration 201 (a snapshot's `taken_down`) names a note by
 *  the old id; the note it means is the one under the new id. */
export const withCurrentIds = (workspaceId: string, ids: ReadonlySet<string>): Promise<Set<string>> => withMapped(workspaceId, ids, "old_id");
