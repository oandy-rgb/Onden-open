// Write stamps (docs/architecture/proposals/causal-stamps-2026-11-12.md, S1): every root transaction gets one stamp per
// workspace it writes — this installation's node id, the workspace's next sequence number, a logical-clock reading,
// who wrote and from which device — and the sync_stamp_trigger() on a stamped table (db/migrations/190_sync_stamps.sql)
// copies it onto every row it changes. Recording only: nothing reads a stamp to decide anything yet, and a row
// written before stamps existed has none (a reader treats that as "unknown").
//
// The stamp travels in a transaction setting (stampSetting). Three ways one gets there:
//   - stampTransaction: a root write of this node (mutate, runCascade, runRestore) makes it;
//   - adoptForeignStamp: a write that carries another node's stamp (copying between nodes, later) sets that one;
//   - neither: the trigger makes one itself with no author and counts it (countWritesWithoutStamp), the number S4
//     will bring to zero.
// Lock order, everywhere: the workspace's event-append lock first, then the workspace's sync_clock row
// (sync_lock_clock takes both in that order), so a transaction that wrote before entering mutate() cannot deadlock
// with one that did not. Sequence numbers and clocks are per workspace: stamps only compare inside one workspace.
//
// Two clocks, on purpose: here the application's Date.now(), in the trigger path the database's clock_timestamp().
// Both feed the same rule (src/hlc.ts: take the later of the clock and the last reading, else count up), so a
// difference between the two machines' clocks can never make a stamp go backwards.

import { sql } from "kysely";
import { currentDeviceId } from "../requestContext.js";
import { db } from "../dbKysely.js";
import { markTransactionStamped } from "../db.js";
import { receive, tick } from "../hlc.js";
import { lockEventAppend } from "./eventTransaction.js";

/** A stamp as it is kept in the transaction setting. `bypass` marks one the trigger made for a write outside the roots. */
export type StampSetting = { origin: string; seq: number; wall: number; counter: number; author: string | null; device: string | null; bypass?: true };
/** A stamp made on another node: its origin, sequence number and clock are kept exactly as received. */
export type ForeignStamp = Omit<StampSetting, "bypass">;

type ClockRow = { node_id: string; next_seq: string; hlc_wall: string; hlc_counter: number; stamp: string | null };

const stampSetting = (workspaceId: string) => `onden.stamp_${workspaceId.replaceAll("-", "_")}`;

/** Lock the workspace's clock (event-append lock first) and read it, with the stamp this transaction already has. */
async function lockClock(workspaceId: string): Promise<ClockRow> {
  const result = await sql<ClockRow>`
    SELECT c.node_id, c.next_seq, c.hlc_wall, c.hlc_counter, current_setting(${stampSetting(workspaceId)}, true) AS stamp
      FROM sync_lock_clock(${workspaceId}::uuid) c`.execute(db);
  return result.rows[0]!;
}

const setStamp = async (workspaceId: string, stamp: StampSetting | ForeignStamp) => {
  await sql`SELECT set_config(${stampSetting(workspaceId)}, ${JSON.stringify(stamp)}, true)`.execute(db);
  markTransactionStamped();
};

/** The logical-clock reading (epoch ms part) of this transaction's stamp in `workspaceId`: the clock a write's time is
 *  measured on, in place of any device clock. Null when the transaction has no stamp (call inside mutate/mutatePersonal). */
export async function currentStampWall(workspaceId: string): Promise<number | null> {
  const row = (await sql<{ stamp: string | null }>`SELECT current_setting(${stampSetting(workspaceId)}, true) AS stamp`.execute(db)).rows[0];
  return row?.stamp ? (JSON.parse(row.stamp) as StampSetting).wall : null;
}

/** Give the open transaction its stamp for this workspace (once: a second root in the same transaction keeps the first).
 *  `authorId` is the actor of the root write; the device comes from the request. Call inside the transaction. */
export async function stampTransaction(workspaceId: string, authorId: string, options: { system?: boolean } = {}): Promise<void> {
  const device = options.system ? null : currentDeviceId() ?? null; // background work has no device (same as domain_events.device_id)
  const node = await lockClock(workspaceId);
  if (node.stamp) {
    // A write earlier in this transaction bypassed the roots and got a stamp with no author: keep that stamp (the rows
    // already written stay as they were) and let the writes from here on name their author. A stamp from another node
    // is never changed.
    const kept = JSON.parse(node.stamp) as StampSetting;
    if (kept.bypass) await setStamp(workspaceId, { ...kept, author: authorId, device });
    return;
  }
  const clock = tick({ wall: Number(node.hlc_wall), counter: node.hlc_counter }, Date.now());
  const seq = Number(node.next_seq);
  await sql`UPDATE sync_clock SET next_seq = ${seq + 1}, hlc_wall = ${clock.wall}, hlc_counter = ${clock.counter} WHERE workspace_id = ${workspaceId}::uuid`.execute(db);
  await setStamp(workspaceId, { origin: node.node_id, seq, wall: clock.wall, counter: clock.counter, author: authorId, device });
}

/** The writes of this transaction in `workspaceId` carry a stamp made on ANOTHER node: its origin, sequence number,
 *  clock, author and device, exactly as received. This node's sequence number does not move; its clock moves up to
 *  at least the received reading (src/hlc.ts receive()), so what it writes next sorts after it.
 *  Only the entry; no reconciliation. Call inside the transaction, before its first write. */
export async function adoptForeignStamp(workspaceId: string, stamp: ForeignStamp): Promise<void> {
  await lockEventAppend(workspaceId);
  const node = await lockClock(workspaceId);
  if (stamp.origin === node.node_id) throw new Error("a stamp made on this node is made by stampTransaction, not adopted");
  if (node.stamp) throw new Error("this transaction already has a stamp");
  const clock = receive({ wall: Number(node.hlc_wall), counter: node.hlc_counter }, { wall: stamp.wall, counter: stamp.counter }, Date.now());
  await sql`UPDATE sync_clock SET hlc_wall = ${clock.wall}, hlc_counter = ${clock.counter} WHERE workspace_id = ${workspaceId}::uuid`.execute(db);
  await setStamp(workspaceId, stamp);
}

/** How many transactions wrote a stamped table without a root above (the trigger made their stamp); one workspace, or all. */
export async function countWritesWithoutStamp(workspaceId?: string): Promise<number> {
  const row = (await sql<{ n: string }>`
    SELECT COALESCE(sum(writes_without_mutate), 0)::text AS n FROM sync_clock
     WHERE ${workspaceId ?? null}::uuid IS NULL OR workspace_id = ${workspaceId ?? null}::uuid`.execute(db)).rows[0];
  return Number(row?.n ?? 0);
}
