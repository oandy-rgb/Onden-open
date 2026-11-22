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
import { CodedStatusError } from "../statusError.js";
import { currentDeviceId } from "../requestContext.js";
import { db } from "../dbKysely.js";
import { sha256Hex } from "../utils.js";
import { markTransactionStamped } from "../db.js";
import { receive, tick } from "../hlc.js";
import { lockEventAppend } from "./eventTransaction.js";

/** A stamp as it is kept in the transaction setting. `bypass` marks one the trigger made for a write outside the roots. */
export type StampSetting = { origin: string; seq: number; wall: number; counter: number; author: string | null; device: string | null; bypass?: true;
  /** The writer is not a person (a system job, spine/systemJobs.ts, or an AI agent): only a person's write resolves a conflict, so the database refuses its write to a unit that holds other heads (migration 206, `sync_unit_in_conflict`). */
  system?: true };
/** A stamp made on another node: its origin, sequence number and clock are kept exactly as received. */
export type ForeignStamp = Omit<StampSetting, "bypass">;

type ClockRow = { node_id: string; next_seq: string; hlc_wall: string; hlc_counter: number; stamp: string | null };

/** How far ahead of this machine's clock a stamp from another node may be before it is refused (the owner may change this:
 *  docs/architecture/proposals/add-device-snapshot-2026-11-15.md §4). Two ordinary devices differ by seconds, a mistyped date by
 *  hours or years; the clock rule (src/hlc.ts receive()) has no limit of its own, so without this one stamp from the far
 *  future would put this node's clock there for good and every later write here would "win". Stamps from the past are never refused. */
const MAX_FOREIGN_CLOCK_AHEAD_MS = 10 * 60 * 1000;

/** The batch's highest clock reading is further ahead than MAX_FOREIGN_CLOCK_AHEAD_MS: nothing of the batch is written. */
class ForeignClockAheadError extends CodedStatusError {
  /** `theirWall`: the highest clock reading of the stamps (ms); `ourWall`: this machine's clock (ms); `aheadMs`: how far apart; `side`: whose clock is out of step (the stamps' when they are ahead of this machine's). */
  constructor(readonly theirWall: number, readonly ourWall: number) {
    super(422, "stamp_clock_ahead", `a stamp's clock reading is too far ahead of this machine's clock (${theirWall - ourWall} ms ahead; the bound is ${MAX_FOREIGN_CLOCK_AHEAD_MS} ms)`);
  }
  get aheadMs(): number { return this.theirWall - this.ourWall; }
  readonly side = "sender" as const;
}

/** Refuse a batch of foreign stamps whose highest `wall` is ahead of `nowWall` by more than the bound. Pure: call it
 *  before the first write (and before any lock), so a refusal leaves the clock and the data exactly as they were. */
export function assertForeignClockWithinBound(maxWall: number, nowWall: number = Date.now()): void {
  if (!Number.isFinite(maxWall) || maxWall - nowWall > MAX_FOREIGN_CLOCK_AHEAD_MS) throw new ForeignClockAheadError(maxWall, nowWall);
}

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

let joinTableKnown = false;
/** Whether migration 204's join record exists (true stays true: tables are not dropped). */
async function joinTableThere(): Promise<boolean> {
  if (joinTableKnown) return true;
  joinTableKnown = (await sql<{ there: boolean }>`SELECT to_regclass('sync_join') IS NOT NULL AS there`.execute(db)).rows[0]!.there;
  return joinTableKnown;
}

/** Give the open transaction its stamp for this workspace (once: a second root in the same transaction keeps the first).
 *  `authorId` is the actor of the root write; the device comes from the request. Call inside the transaction. */
export async function stampTransaction(workspaceId: string, authorId: string, options: { system?: boolean; notAPerson?: boolean } = {}): Promise<void> {
  const device = options.system ? null : currentDeviceId() ?? null; // background work has no device (same as domain_events.device_id)
  const node = await lockClock(workspaceId);
  // A workspace that is being filled from a snapshot is not written by anyone else meanwhile: a write here would carry this node's own
  // stamp into rows that are meant to be the source's (and the digest at the end would not match).
  // (a database that has not yet applied migration 204 — an older copy the browser app is about to upgrade — has no join record to look at)
  if (await joinTableThere() && (await sql`SELECT 1 FROM sync_join WHERE workspace_id = ${workspaceId}::uuid AND state = 'joining'`.execute(db)).rows.length > 0) {
    throw new CodedStatusError(409, "workspace_joining", "this workspace is being filled from a snapshot; it takes no other writes until that is done");
  }
  if (node.stamp) {
    // A write earlier in this transaction bypassed the roots and got a stamp with no author: keep that stamp (the rows
    // already written stay as they were) and let the writes from here on name their author. A stamp from another node
    // is never changed.
    // The stamp a write outside the roots got says `system` (migration 221: nobody who looked at the heads wrote it); from here on it is this root's, which says itself.
    const { system: _bypassSystem, ...kept } = JSON.parse(node.stamp) as StampSetting;
    if (kept.bypass) await setStamp(workspaceId, { ...kept, author: authorId, device, ...(options.system || options.notAPerson ? { system: true as const } : {}) });
    return;
  }
  const clock = tick({ wall: Number(node.hlc_wall), counter: node.hlc_counter }, Date.now());
  const seq = Number(node.next_seq);
  await sql`UPDATE sync_clock SET next_seq = ${seq + 1}, hlc_wall = ${clock.wall}, hlc_counter = ${clock.counter} WHERE workspace_id = ${workspaceId}::uuid`.execute(db);
  await setStamp(workspaceId, { origin: node.node_id, seq, wall: clock.wall, counter: clock.counter, author: authorId, device, ...(options.system || options.notAPerson ? { system: true as const } : {}) });
}

/**
 * The writes `fn` makes are housekeeping, not an edit: the stamps they write carry `meta.quiet`, which `updated_at` (migration 206 sync_touch_updated_at) does not count. Only the writer knows
 * that, so it is said in the stamp, where every node reads it. The one place that sets the switch (`onden.stamp_quiet`, local to the transaction); call inside the transaction.
 * A failed write rolls the setting back with its transaction or savepoint.
 *
 *   await withQuietStamps(() => applyTheRewrite());   // e.g. services/nodeUpdate.ts when a save must not move "recently changed"
 */
export async function withQuietStamps<T>(fn: () => Promise<T>): Promise<T> {
  await sql`SELECT set_config('onden.stamp_quiet', 'on', true)`.execute(db);
  const result = await fn();
  await sql`SELECT set_config('onden.stamp_quiet', '', true)`.execute(db);
  return result;
}

/** The writes of this transaction in `workspaceId` carry a stamp made on ANOTHER node: its origin, sequence number,
 *  clock, author and device, exactly as received. This node's sequence number does not move; its clock moves up to
 *  at least the received reading (src/hlc.ts receive()), so what it writes next sorts after it.
 *  Only the entry; no reconciliation. Call inside the transaction, before its first write. */
export async function adoptForeignStamp(workspaceId: string, stamp: ForeignStamp): Promise<void> {
  assertForeignClockWithinBound(stamp.wall);
  await lockEventAppend(workspaceId);
  const node = await lockClock(workspaceId);
  if (stamp.origin === node.node_id) throw new Error("a stamp made on this node is made by stampTransaction, not adopted");
  if (node.stamp) throw new Error("this transaction already has a stamp");
  const clock = receive({ wall: Number(node.hlc_wall), counter: node.hlc_counter }, { wall: stamp.wall, counter: stamp.counter }, Date.now());
  await sql`UPDATE sync_clock SET hlc_wall = ${clock.wall}, hlc_counter = ${clock.counter} WHERE workspace_id = ${workspaceId}::uuid`.execute(db);
  await setStamp(workspaceId, stamp);
}

/** A reading of the logical clock: the pair a stamp carries as `wall` and `counter`. */
export type ClockReading = { wall: number; counter: number };

/** The two reasons the stamp triggers of a workspace stand aside for the rest of a transaction (migration 204 / 205 `sync_import_active` is the one place that decides):
 *  `join` = a stamped snapshot is being imported (spine/stampedImport.ts; the workspace's sync_join row must be 'joining'),
 *  `merge` = changes of another node are being written back as received (spine/stampedMerge/dbUnits.ts; the workspace must have a clock and not be joining,
 *  and the transaction counts it in sync_clock.merge_batches, the visible exception like writes_without_mutate). */
type StandAsideReason = "join" | "merge";

/** Inside a stamped-snapshot import or a merge write-back (the two callers named in stampedImport.guard.test.ts), the stamp triggers of `workspaceId` stand aside for the rest
 *  of this transaction, because what is written carries the stamps it had and they are stored as received. Two things make that so: the
 *  transaction setting `onden.stamp_import_<workspace>` (local to the transaction: when it ends every trigger is as before) and
 *  `sync_import_active` agreeing with its value (migrations 204 / 205: without the matching state of the workspace the setting does nothing). The transaction also gets a
 *  placeholder stamp so that nothing makes one of its own, and counts as stamped for the guard in db.ts. Call after the event lock. */
export async function standAsideForImport(workspaceId: string, reason: StandAsideReason = "join"): Promise<void> {
  await sql`SELECT set_config(${`onden.stamp_import_${workspaceId.replaceAll("-", "_")}`}, ${reason === "join" ? "on" : "merge"}, true)`.execute(db);
  await setStamp(workspaceId, { origin: reason === "join" ? "import" : "merge", seq: 0, wall: 0, counter: 0, author: null, device: null });
  if (reason === "merge") await sql`UPDATE sync_clock SET merge_batches = merge_batches + 1 WHERE workspace_id = ${workspaceId}::uuid`.execute(db);
}

/** The local clock after seeing a whole batch of foreign readings, once: the batch's highest reading goes through the clock rule
 *  (src/hlc.ts receive()), so what this node writes next sorts after everything in it. This node's sequence number does not move.
 *  The bound is checked first: nothing is written when the batch is ahead of this machine's clock by more than the bound. */
export async function advanceClockFor(workspaceId: string, readings: ClockReading[]): Promise<void> {
  if (readings.length === 0) return;
  const highest = readings.reduce((a, b) => (b.wall > a.wall || (b.wall === a.wall && b.counter > a.counter) ? b : a));
  assertForeignClockWithinBound(highest.wall);
  await lockEventAppend(workspaceId);
  const node = await lockClock(workspaceId);
  const clock = receive({ wall: Number(node.hlc_wall), counter: node.hlc_counter }, highest, Date.now());
  await sql`UPDATE sync_clock SET hlc_wall = ${clock.wall}, hlc_counter = ${clock.counter} WHERE workspace_id = ${workspaceId}::uuid`.execute(db);
}

/** The bound itself, for the state below. */
export const FOREIGN_CLOCK_BOUND_MS = MAX_FOREIGN_CLOCK_AHEAD_MS;

/** This node's id (the origin of every stamp it makes). */
export async function localNodeId(): Promise<string> {
  const row = await nodeIdRow();
  if (!row) throw new Error("this database has no node id yet");
  return row.node_id;
}

function nodeIdRow(): Promise<{ node_id: string } | undefined> {
  return sql<{ node_id: string }>`SELECT node_id FROM sync_node WHERE singleton`.execute(db).then((r) => r.rows[0]);
}

/** `server_id` for a sync answer or bootstrap (contract SyncDelta.server_id): names the event log `head_event_id` and every
 *  write's position count in. DERIVED from this node's id, never the id itself — node ids and stamps appear in no answer
 *  (syncStamps.integration). A restore or a rebase gives the node a new id, so the identity changes with it and the app
 *  starts its positions over; the same id always gives the same value. Empty (a database not yet given its id) sends no
 *  field rather than failing the answer: the client then keeps what it recorded, as with an older server. */
export async function serverIdentityField(): Promise<{ server_id?: string }> {
  const row = await nodeIdRow();
  // The one derivation: a fixed purpose string, so the value is useless as a node id anywhere else.
  return row ? { server_id: sha256Hex(`onden answer log identity\u0000${row.node_id}`) } : {};
}

/** Give every row that holds no stamp the genesis stamp (migration 202's sync_genesis_pass; every node computes the same one, so
 *  it is the stamp "nobody has written this since the start"). A row a boot seed wrote (the first workspace of a database) or any
 *  other write outside the write path has none until this runs, and a copy of the database must carry a stamp for every row, or the
 *  receiver's own pass would add what the source never held. Adds nothing when every row has one. Returns how many it added. */
export async function stampUnstampedRowsAsGenesis(): Promise<number> {
  const row = (await sql<{ stamps_added: string }>`SELECT stamps_added::text FROM sync_genesis_pass()`.execute(db)).rows[0];
  return Number(row?.stamps_added ?? 0);
}

/** How many transactions wrote a stamped table without a root above (the trigger made their stamp); one workspace, or all. */
export const countWritesWithoutStamp = (workspaceId?: string): Promise<number> => countSyncClockExceptions("writes_without_mutate", workspaceId);

/** One of sync_clock's counted exceptions, summed over one workspace or all: writes_without_mutate (above) and version_misses (migration 220,
 *  spine/noteVersions.ts countVersionMisses). */
export async function countSyncClockExceptions(column: "writes_without_mutate" | "version_misses", workspaceId?: string): Promise<number> {
  const row = (await sql<{ n: string }>`
    SELECT COALESCE(sum(${sql.ref(column)}), 0)::text AS n FROM sync_clock
     WHERE ${workspaceId ?? null}::uuid IS NULL OR workspace_id = ${workspaceId ?? null}::uuid`.execute(db)).rows[0];
  return Number(row?.n ?? 0);
}
