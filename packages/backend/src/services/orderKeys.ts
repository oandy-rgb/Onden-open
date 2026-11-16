// Same-level order, the database side (migration 200). The key itself — keyBetween, keysBetween, the validity check,
// the comparison — lives in @onden/markdown (orderKey.ts) and is the same code in the browser build.
//
// Where a writer gets a key:
//   - a note or pointer made without one            → appendOrderKey (last among its live siblings)
//   - a move or insert that names the key           → assertOrderKey (the client chose it between its neighbours)
//   - an older client's integer (`sort_order`)      → translateLegacySortOrder (documented below)
//   - a restore of an earlier key that is now taken → keyForRestore
//   - a key that grew past ORDER_KEY_RESPACE_LENGTH → respaceSiblings, one explicit operation for the whole group
// Every writer of order_key goes through this file or @onden/markdown; guards/orderKeyWriters.guard.test.ts fails when a
// new one appears. All of these read through q(), so they run inside the caller's transaction and under its event lock.

import { evenOrderKeys, isValidOrderKey, keyBetween, orderKeyNeedsRespace } from "@onden/markdown/contract";
import { sql } from "kysely";
import { db } from "../dbKysely.js";
import { sqlIdentifier } from "../sqlText.js";
import { mutate } from "../spine/mutate.js";
import { StatusError } from "../statusError.js";
import type { ActorCtx } from "../types.js";

type OrderTable = "content_nodes" | "note_pointers";

class OrderKeyError extends StatusError {
  constructor(message: string) {
    super(422, message);
    this.name = "OrderKeyError";
  }
}

/** The order of siblings in SQL, byte order and never a locale: key, then the stamp of the write that set it, then id.
 *  Equal to @onden/markdown compareOrdered (orderKeyAgreement.integration.test.ts checks the two on random keys). */
const siblingOrderSql = (alias: string): string =>
  `${alias}.order_key COLLATE "C", ${alias}.order_stamp COLLATE "C", ${alias}.id`;

export function assertOrderKey(key: unknown): asserts key is string {
  if (!isValidOrderKey(key)) throw new OrderKeyError("invalid_order_key");
}

type SiblingKey = { id: string; order_key: string; sort_order: number | null };

// content_nodes and note_pointers have the same columns this file uses (pointers have no deleted_at: a pointer is
// removed, not trashed), so the typed builder is written once against content_nodes and given either table's name.
const siblingsOf = (table: OrderTable, workspaceId: string, parentId: string | null) =>
  db.selectFrom(table as "content_nodes").where("workspace_id", "=", workspaceId)
    .where("parent_id", parentId === null ? "is" : "=", parentId)
    .$if(table === "content_nodes", (qb) => qb.where("deleted_at", "is", null));

async function liveSiblings(table: OrderTable, workspaceId: string, parentId: string | null, exceptId?: string): Promise<SiblingKey[]> {
  return (await siblingsOf(table, workspaceId, parentId)
    .select(["id", "order_key", "sort_order"])
    .$if(exceptId !== undefined, (qb) => qb.where("id", "<>", exceptId!))
    .orderBy(sql`order_key COLLATE "C"`).orderBy(sql`order_stamp COLLATE "C"`).orderBy("id")
    .execute()) as SiblingKey[];
}

/** A key after every live sibling: where a new note or pointer goes when the caller says nothing.
 *  Only live rows count, on purpose: a trashed row may hold a later key, so after a restore two rows can share one key. That is
 *  allowed: the stamp of the write that set each key, then the id, order them the same way everywhere. */
export async function appendOrderKey(table: OrderTable, workspaceId: string, parentId: string | null): Promise<string> {
  const last = await siblingsOf(table, workspaceId, parentId).select("order_key")
    .orderBy(sql`order_key COLLATE "C"`, "desc").limit(1).executeTakeFirst();
  return keyBetween(last?.order_key ?? null, null);
}

/** The key for an integer an older app (or a queued offline write made before migration 200) sent as `sort_order`.
 *
 *  Rule: among the other live siblings in their current order, those that still carry the number they had when
 *  migration 200 ran (rows made later have none) are compared with `value`. The note goes just after the last of them
 *  whose number is at most `value` (an equal number counts as "before": the old order put the one made later after its twin),
 *  or first when none is. Rows with tied keys are skipped past. A client that renumbered several
 *  neighbours sends one write per row; each is placed by this rule against the others as they are then, which keeps what
 *  that client saw as long as its numbers came from the pre-migration list. It is a best effort for the transition, not
 *  an order the new app will ever produce. */
export async function translateLegacySortOrder(table: OrderTable, workspaceId: string, parentId: string | null, id: string, value: number): Promise<string> {
  const siblings = await liveSiblings(table, workspaceId, parentId, id);
  let at = -1;
  siblings.forEach((s, i) => { if (s.sort_order !== null && s.sort_order <= value) at = i; });
  const before = siblings[at]?.order_key ?? null;
  const after = siblings.slice(at + 1).find((s) => before === null || s.order_key > before)?.order_key ?? null;
  return keyBetween(before, after);
}

/** The key a restore gives a row: the one it had when that is free among the live siblings, else a fresh key just before
 *  whoever holds it (never equal, never moving anyone else). */
export async function keyForRestore(table: OrderTable, workspaceId: string, parentId: string | null, id: string, wanted: string): Promise<string> {
  assertOrderKey(wanted);
  const siblings = await liveSiblings(table, workspaceId, parentId, id);
  if (!siblings.some((s) => s.order_key === wanted)) return wanted;
  const before = siblings.filter((s) => s.order_key < wanted).at(-1)?.order_key ?? null;
  return keyBetween(before, wanted);
}

/** Give one sibling group fresh, evenly spaced keys in its current order — live and trashed rows together, so a
 *  restore later finds its place. One explicit operation: the rows change in one statement, inside the transaction
 *  and so under one write stamp. Returns how many rows it wrote. Callers call it when `needsRespace(key)`; a read never does. */
async function respaceSiblings(table: OrderTable, workspaceId: string, parentId: string | null): Promise<number> {
  const rows = await db.selectFrom(table as "content_nodes").select("id").where("workspace_id", "=", workspaceId)
    .where("parent_id", parentId === null ? "is" : "=", parentId)
    .orderBy(sql`order_key COLLATE "C"`).orderBy(sql`order_stamp COLLATE "C"`).orderBy("id").execute();
  const ids = rows.map((r) => r.id);
  const keys = evenOrderKeys(ids.length);
  if (ids.length === 0) return 0;
  await sql`UPDATE ${sql.table(table)} AS t SET order_key = v.key
    FROM unnest(${ids}::uuid[], ${keys}::text[]) AS v(id, key)
    WHERE t.workspace_id = ${workspaceId} AND t.id = v.id`.execute(db);
  return ids.length;
}

/** Who made a respace, and which row's event carries it to the other devices. The respace's cause is the write that
 *  set the long key; `nodeId` is the note the sync delta re-ships because of it (for pointers: the
 *  note the new pointer points at). */
type RespaceContext = { actor: ActorCtx; nodeId: string };

/** After a write set `key` on a row of this group: respace the group if the key got too long.
 *
 *  The sync delta ships only the rows that events name, and a respace changes the keys of rows the write never named. So a
 *  respace records one NODE_UPDATED event (payload `order_respaced`: which group) as a cascade child of the write, in the same transaction; the delta reads
 *  it and re-ships the whole live group (sync/delta.ts), which is how the other devices, and the one that sent the write,
 *  end with the keys the server holds. */
export async function respaceIfTooLong(table: OrderTable, workspaceId: string, parentId: string | null, key: string, context: RespaceContext): Promise<boolean> {
  if (!orderKeyNeedsRespace(key)) return false;
  // A cascade child of the write that set the long key (spine/mutate.ts): its event and the rewritten keys commit or roll back together.
  await mutate({
    actor: context.actor,
    workspaceId,
    authority: { kind: "cascade" },
    event: {
      type: "NODE_UPDATED", targetType: "node", targetId: context.nodeId,
      payload: { order_respaced: { table, parent_id: parentId } satisfies RespacedGroup },
    },
    apply: () => respaceSiblings(table, workspaceId, parentId),
  });
  return true;
}

/** The payload of the event a respace records: the sibling group whose keys all changed. */
export type RespacedGroup = { table: OrderTable; parent_id: string | null };

/** The order of a table or query that sets no sort: by title, then id so it is fixed. Not the manual order: that is a sort a
 *  person picks (MANUAL_ORDER_*). Used by saved views and by /api/query alike. */
const unsortedListOrderSql = (alias: string): string => `${alias}.title ASC, ${alias}.id ASC`;

/** The manual order ("Manual order", `sort_order`, the name saved views keep): key, stamp, id, in the given direction. */
const manualOrderSql = (alias: string, dir: "ASC" | "DESC"): string =>
  `${alias}.order_key COLLATE "C" ${dir}, ${alias}.order_stamp COLLATE "C" ${dir}, ${alias}.id ${dir}`;

// Fixed text for the two aliases the two list queries use (collectionViewQuery `n`, nodeQuery `cn`): constants, so the SQL-text
// guard (be-sql-interpolation) can see that nothing in them comes from a request.
export const UNSORTED_ORDER_N = unsortedListOrderSql("n");
export const UNSORTED_ORDER_CN = unsortedListOrderSql("cn");
export const MANUAL_ORDER_N_ASC = manualOrderSql("n", "ASC");
export const MANUAL_ORDER_N_DESC = manualOrderSql("n", "DESC");
export const MANUAL_ORDER_CN_ASC = manualOrderSql("cn", "ASC");
export const MANUAL_ORDER_CN_DESC = manualOrderSql("cn", "DESC");
// Sibling order for the two wire queries: the notes' `n` and the pointers' `p`.
export const SIBLING_ORDER_N = siblingOrderSql("n");
export const SIBLING_ORDER_P = siblingOrderSql("p");
