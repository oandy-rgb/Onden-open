// The export half of copying a workspace to an empty database with every row's write stamp kept (docs/architecture/proposals/
// add-device-snapshot-2026-11-15.md §3): the rows this operator may read, and the stamps they carry, as pages.
//
// TWO DESIGNS WERE COMPARED (the PR description has the table):
//   (1) one read function per table that returns that table's rows with their stamps;
//   (2) one function, readStampedPages, that walks a list of tables (spine/snapshotTables.ts) and returns pages of items.
// (2) is used: a table is described once (columns, scope, stamp keys) and the later "changes since a cut" read only changes a
// condition of the one walk. The cost is that a page holds items of several kinds (row, tombstone, refs) and the reader has to
// tell them apart; the import takes the same items back.
//
//   await readStampedPages(actor, workspaceId, { since: null, layer: "rows" }, async (page) => send(page))
//     → { source, cut, pages, digest }   // the digest of what was read, taken in the same snapshot (spine/snapshotSql.ts)
//
// What a page holds, in this order: the rows of each table in write order (spine/snapshotTables.ts), each with ALL its stamps;
// then the stamps of rows that are not in the table (a deleted row's tombstone, the stamps of a row that hangs on a note deleted for good);
// last the `refs` that set the columns a table points back with.
// Everything is read in ONE read snapshot, so the digest is of exactly what the pages hold. `cut` is this node's own sequence number
// at that moment: a later change has a larger one (second stage: "changes since the cut").
//
// A row nothing has stamped yet (a boot seed wrote it) is given the genesis stamp first (spine/stamps.ts), so the receiver's own pass
// finds nothing to add.
//
// FOR THE OWNER ONLY, for now: before an export for a limited reader is offered (guards/snapshotLimitedScope.guard.test.ts), the tombstones
// must be cut by the reader's scope (they name ids of rows the reader cannot read) and a row whose foreign key names a row the reader
// cannot read must be left out or its key emptied (today the receiver cannot apply it and the whole join rolls back).
//
// THE HISTORY PART (history-replication proposal §3.1, batch 3): readHistoryPages, after the rows, in a read snapshot of its own at the rows' cut (spine/historyLayer.ts says
// why that set does not move): the content of the versions by hash (layer `blobs`), then the versions (layer `history`), with a digest of its own.
//
// What it refuses: a non-null `since`, and the `history` / `blobs` layers here (they are readHistoryPages'); an operator that is a delegated token; a source that cannot
// vouch for every stamp it holds (`snapshotSourceNode`). A node that holds other nodes' writes (it was filled from another, or took bundles) IS a source
// (own-node-transport proposal §3.4, batch 2): the snapshot names those origins and how far it holds each, per label (`brought`), and the joining node holds
// exactly that afterwards. It never reads structure_log or domain_events.

import { CodedStatusError } from "../statusError.js";
import { db } from "../dbKysely.js";
import { requirePerson } from "../spine/authority.js";
import { stampUnstampedRowsAsGenesis } from "../spine/stamps.js";
import { SYNC_DATA_SHAPE_VERSION } from "../spine/syncDataShape.js";
import { MAX_BROUGHT_ORIGINS, broughtBound, heldOfFormer, originsOf, type Have } from "../spine/stampedBundle.js";
import { CARRIED_LABELS } from "../spine/stampedMerge/index.js";
import { withActorReadSnapshot } from "./actorReadSnapshot.js";
import { snapshotScopeFor } from "./readPolicy.js";
import { SNAPSHOT_SPECS } from "../spine/snapshotTables.js";
import { computeSnapshotDigest, snapshotRows, readRefsChunk, readRowChunk, readStampsOf, readTombstoneChunk, type SnapshotItem, type StampedPage, type TableDigest, type WireStamp } from "../spine/snapshotSql.js";
import { planHistory, readHistoryItems, sentHistoryDigests, type HistoryDigests, type HistoryItem, type HistoryPage } from "../spine/historyLayer.js";
import type { ActorCtx } from "../types.js";

/** A page holds about this many bytes before it is closed (before compression; a single row is never split). */
const SNAPSHOT_PAGE_BYTES = 4 * 1024 * 1024;
/** A page of the history part is smaller: it is taken in while the device is already in use, and each page holds the workspace's event lock while it is
 *  written, so ordinary saves wait that long (measured for PR #1988: about a second per 4 MB page of drawings' history; a single item is never split). */
const HISTORY_PAGE_BYTES = 1024 * 1024;
const CHUNK_ROWS = 200; // rows read per query: each query has a fixed cost (the reader's scope is worked out in it), so more rows per query is much faster; a chunk is in memory once

type SnapshotSummary = { source: string; former: Record<string, number>; brought: Have; cut: number; pages: number; digest: TableDigest[] };

type ReadStampedPagesOptions = {
  /** Null: the whole snapshot. Anything else is refused until changes-since is done. */
  since: null;
  layer: "rows" | "history" | "blobs";
  pageBytes?: number;
};

class SnapshotNotDone extends CodedStatusError {}
class SnapshotSourceRefused extends CodedStatusError {}

const sizeOf = (item: SnapshotItem | HistoryItem) => new TextEncoder().encode(JSON.stringify(item)).length;

type OriginRow = { origin: string; vouched_by: string; have: Record<string, number> };

/**
 * This node's id, when a snapshot of `workspaceId` can be made here: when this node can vouch for every stamp it holds, so that the joining node can take every
 * one of them and afterwards hold exactly what this node holds (spine/stampedImport.ts checkPage refuses a stamp of an origin nobody vouched for, or past the
 * number given for it). Refused, 409, nothing read:
 *   snapshot_source_joining     the workspace is being filled from a snapshot itself (sync_join 'joining'): half a copy is no source
 *   snapshot_source_history_incomplete   it was filled from a snapshot whose earlier versions are not all in yet (sync_join.history_state 'arriving', migration 229): a third
 *                               device joining from it would never get them (history-replication proposal §10 question 5)
 *   snapshot_source_history_missing      it was filled from a snapshot and has none of their earlier versions (history_state 'missing': joined before migration 229;
 *                               'given_up': the person stopped waiting): no source of an incomplete history (the owner's decision of 2026-11-23 on PR #1988), until a file
 *                               of its source brings them in (spine/stampedImport.ts beginHistoryRefill)
 *   snapshot_foreign_origin     a stamp (or another head of a unit) of an origin this node has no sync_origins row for: it cannot say how far it holds it
 *   snapshot_source_unsettled   a stamp of an origin beyond what this node says it holds of it (per label; a former id: the least over the labels its row names): a merge whose
 *                               progress was not written with it. A joiner would refuse it (join_stamp_beyond_brought / _former); refused here, before the read
 *   snapshot_too_many_origins   more other origins than a snapshot may name (spine/stampedImport.ts MAX_BROUGHT_ORIGINS)
 * The ids this node had before it was restored and renewed (migration 213: sync_origins rows vouched 'self-restore') travel as `former`; every other origin it
 * holds (a snapshot's source, a node it admitted, an origin a sender brought) as `brought`. A merge in flight is no state of this read: a bundle is taken in ONE
 * transaction, and the snapshot is read in one REPEATABLE READ snapshot, so it sees all of a merge or none of it; the genesis pass that runs before the read (a write)
 * may WAIT for an open merge's transaction when the two touch the same stamp keys, so an export started mid-merge can wait for the merge, up to the statement timeout
 * (snapshotBrought.integration.test.ts on a real Postgres). The one definition: the read opens with it, and the route asks it before it spends a fresh-proof ticket.
 * COST (review round 1, B5): one pass over the workspace's stamps and other heads (no index by origin), twice per export (the route's, so a refusal does not use up the
 * password just typed; and the read's, inside the snapshot, which is the one that counts). Measured 2026-11-22 on this batch's machine, per call: real Postgres 16 ≈ 8 ms at
 * 10,000 stamps, ≈ 28 ms at 100,000, 100–140 ms at 1,000,000; PGlite ≈ 8 / 50 / 250 ms at 10,000 / 100,000 / 500,000 (the owner's server holds about 2,100 today). Not
 * merged into one: the ticket is spent by a write, which the read-only snapshot cannot do. Threshold: when one call passes 1 s (about 5 million stamps on Postgres,
 * 2 million on PGlite) keep the per-origin, per-label maximum in a table the stamp triggers maintain, or check once and spend the ticket after the read's first page.
 */
export async function snapshotSourceNode(workspaceId: string): Promise<string> {
  const node = (await snapshotRows<{ node_id: string }>(`SELECT node_id FROM sync_node WHERE singleton`)).rows[0]?.node_id;
  if (!node) throw new Error("this database has no node id yet");
  if ((await snapshotRows(`SELECT 1 FROM sync_join WHERE workspace_id = $1 AND state = 'joining'`, [workspaceId])).rows.length > 0) {
    throw new SnapshotSourceRefused(409, "snapshot_source_joining", "this workspace is being filled from a snapshot; a snapshot of it cannot be made until that is done");
  }
  if ((await snapshotRows(`SELECT 1 FROM sync_join WHERE workspace_id = $1 AND state = 'done' AND history_state = 'arriving'`, [workspaceId])).rows.length > 0) {
    throw new SnapshotSourceRefused(409, "snapshot_source_history_incomplete", "the earlier versions of this workspace are still being copied here; a snapshot of it cannot be made until that is done");
  }
  if ((await snapshotRows(`SELECT 1 FROM sync_join WHERE workspace_id = $1 AND state = 'done' AND history_state IN ('missing', 'given_up')`, [workspaceId])).rows.length > 0) {
    throw new SnapshotSourceRefused(409, "snapshot_source_history_missing", "this workspace was copied here without its earlier versions; a snapshot of it cannot be made until they are brought in");
  }
  const origins = new Map((await originRows(workspaceId)).map((r) => [r.origin, r] as const));
  // per origin and label, the highest number of it this node holds (a stamp, or another head of a unit)
  const held = (await snapshotRows<{ origin: string; label: string; top: string }>(
    `SELECT origin, table_name AS label, max(seq)::text AS top FROM (
       SELECT origin, table_name, seq FROM sync_stamps WHERE workspace_id = $1 AND origin NOT IN ($2, 'genesis')
       UNION ALL SELECT origin, table_name, seq FROM sync_stamp_heads WHERE workspace_id = $1 AND origin NOT IN ($2, 'genesis')) x
      GROUP BY origin, table_name ORDER BY origin, table_name`, [workspaceId, node])).rows;
  for (const { origin, label, top } of held) {
    const row = origins.get(origin);
    if (!row) throw new SnapshotSourceRefused(409, "snapshot_foreign_origin", "this database holds stamps of a node it has no record of, so it cannot say how far it holds them");
    const bound = row.vouched_by === "self-restore" ? heldOfFormer(row.have) : broughtBound(broughtOf([row]), label, origin);
    if (Number(top) > bound) throw new SnapshotSourceRefused(409, "snapshot_source_unsettled", "this database holds writes of another node beyond what it says it holds of that node");
  }
  if (originsOf(broughtOf([...origins.values()])).size > MAX_BROUGHT_ORIGINS) {
    throw new SnapshotSourceRefused(409, "snapshot_too_many_origins", `this database holds writes of more than ${MAX_BROUGHT_ORIGINS} other nodes; a snapshot names at most that many`);
  }
  return node;
}

const originRows = async (workspaceId: string): Promise<OriginRow[]> =>
  (await snapshotRows<OriginRow>(`SELECT origin, vouched_by, have FROM sync_origins WHERE workspace_id = $1 ORDER BY origin`, [workspaceId])).rows;

/** The ids this node had before it was restored (sync_origins vouched 'self-restore'), each held up to the number migration 213 wrote for the labels its row names
 *  (spine/stampedBundle.ts heldOfFormer: a label carried since is absent there, and is not 0). What a page names as `former`. */
async function formerIdsOf(workspaceId: string): Promise<Record<string, number>> {
  const rows = (await originRows(workspaceId)).filter((r) => r.vouched_by === "self-restore");
  return Object.fromEntries(rows.map((r) => [r.origin, heldOfFormer(r.have)]));
}

/** Every other origin of `rows` (not a former id), per carried label, as far as this node holds it: what a page names as `brought`. A label an origin's row does not
 *  name is left out (it is 0, and the joiner reads it so). */
function broughtOf(rows: readonly OriginRow[]): Have {
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    if (r.vouched_by === "self-restore") continue;
    for (const label of CARRIED_LABELS) if (Object.hasOwn(r.have, label)) (out[label] ??= {})[r.origin] = r.have[label]!;
  }
  return out;
}

export async function readStampedPages(
  authenticated: ActorCtx, workspaceId: string, options: ReadStampedPagesOptions, emit: (page: StampedPage) => Promise<void>,
): Promise<SnapshotSummary> {
  if (options.since !== null) throw new SnapshotNotDone(422, "snapshot_since_not_done", "reading only what changed since a cut is not done yet");
  if (options.layer !== "rows") throw new SnapshotNotDone(422, "snapshot_layer_not_done", `the ${options.layer} layer of a snapshot is read with readHistoryPages`);
  requirePerson(authenticated, "export a snapshot");
  const budget = options.pageBytes ?? SNAPSHOT_PAGE_BYTES;
  // Before the read snapshot opens (it is read-only): a row nothing has stamped yet gets the genesis stamp, so the copy carries one for every row.
  await stampUnstampedRowsAsGenesis();

  return withActorReadSnapshot(authenticated, workspaceId, async (actor) => {
    await snapshotRows(`SELECT set_config('TimeZone', 'UTC', true)`);
    const node = await snapshotSourceNode(workspaceId);
    const former = await formerIdsOf(workspaceId);
    const brought = broughtOf(await originRows(workspaceId));
    const cut = Number((await snapshotRows<{ next_seq: string }>(`SELECT next_seq FROM sync_clock WHERE workspace_id = $1`, [workspaceId])).rows[0]?.next_seq ?? 1) - 1;
    const scopeOf = await snapshotScopeFor(actor);

    let items: SnapshotItem[] = [];
    let bytes = 0;
    let pages = 0;
    const flush = async () => {
      if (items.length === 0) return;
      pages += 1;
      const page: StampedPage = { layer: "rows", dataShape: SYNC_DATA_SHAPE_VERSION, page: pages, cut, source: node, former, brought, workspaceId, items };
      items = []; bytes = 0;
      await emit(page);
    };
    const add = async (item: SnapshotItem) => {
      items.push(item);
      bytes += sizeOf(item);
      if (bytes >= budget) await flush();
    };

    for (const spec of SNAPSHOT_SPECS) {
      const defs = spec.stamps ?? [];
      let after: string[] | null = null;
      for (;;) {
        const chunk = await readRowChunk(spec, workspaceId, scopeOf, after, CHUNK_ROWS);
        const wanted = chunk.flatMap((r) => r.sk.flatMap((rowKey, i) => (rowKey === null || !defs[i] ? [] : [{ label: defs[i]!.label, rowKey }])));
        const byKey = new Map<string, WireStamp[]>();
        for (const s of await readStampsOf(workspaceId, wanted)) {
          const id = `${s.label}\u0000${s.rowKey}`;
          byKey.set(id, [...(byKey.get(id) ?? []), s]);
        }
        for (const row of chunk) {
          const own = row.sk.flatMap((rowKey, i) => (rowKey === null || !defs[i] ? [] : byKey.get(`${defs[i]!.label}\u0000${rowKey}`) ?? []));
          await add({ kind: "row", table: spec.table, values: row.v, stamps: own });
        }
        if (chunk.length < CHUNK_ROWS) break;
        after = chunk[chunk.length - 1]!.k;
      }
    }
    for (const spec of SNAPSHOT_SPECS) {
      for (const def of spec.stamps ?? []) {
        let after: string[] | null = null;
        for (;;) {
          const chunk = await readTombstoneChunk(spec, workspaceId, def.label, after, CHUNK_ROWS * 4);
          for (const stamp of chunk) await add({ kind: "tombstone", table: spec.table, stamp });
          if (chunk.length < CHUNK_ROWS * 4) break;
          const last = chunk[chunk.length - 1]!;
          after = [last.rowKey, last.field];
        }
      }
    }
    for (const spec of SNAPSHOT_SPECS) {
      if (!spec.deferred) continue;
      let after: string[] | null = null;
      for (;;) {
        const chunk = await readRefsChunk(spec, workspaceId, scopeOf, after, CHUNK_ROWS * 4);
        for (const ref of chunk) await add({ kind: "refs", table: spec.table, key: ref.key, values: ref.values });
        if (chunk.length < CHUNK_ROWS * 4) break;
        after = chunk[chunk.length - 1]!.k;
      }
    }
    await flush();
    const digest = await computeSnapshotDigest(workspaceId, scopeOf);
    return { source: node, former, brought, cut, pages, digest };
  });
}

/**
 * The HISTORY PART of the snapshot whose rows were read at `cut` (spine/historyLayer.ts): the content the versions name (pages of layer `blobs`), then the versions
 * (layer `history`), each page with the rows pages' header and numbered from 1, and the digest of what the pages hold, taken in the same read snapshot. The same cut
 * gives the same pages whenever it is read (a note deleted for good in between takes its versions with it), so a receiver whose transfer was cut takes the pages again
 * and finds the ones it holds unchanged. A cut beyond this node's own is refused (`snapshot_history_cut`): there is no such snapshot. The same operator rule and the same
 * source check as the rows.
 *
 *   const rows = await readStampedPages(owner, ws, { since: null, layer: "rows" }, send);
 *   const history = await readHistoryPages(owner, ws, { cut: rows.cut }, send);   // → { pages, digests, inkBytes }
 */
export async function readHistoryPages(
  authenticated: ActorCtx, workspaceId: string, options: { cut: number; pageBytes?: number }, emit: (page: HistoryPage) => Promise<void>,
): Promise<{ pages: number; digests: HistoryDigests; inkBytes: number }> {
  requirePerson(authenticated, "export a snapshot");
  const budget = options.pageBytes ?? HISTORY_PAGE_BYTES;
  return withActorReadSnapshot(authenticated, workspaceId, async (actor) => {
    await snapshotRows(`SELECT set_config('TimeZone', 'UTC', true)`);
    const node = await snapshotSourceNode(workspaceId);
    const now = Number((await snapshotRows<{ next_seq: string }>(`SELECT next_seq FROM sync_clock WHERE workspace_id = $1`, [workspaceId])).rows[0]?.next_seq ?? 1) - 1;
    if (!Number.isSafeInteger(options.cut) || options.cut < 0 || options.cut > now) throw new SnapshotNotDone(422, "snapshot_history_cut", "there is no snapshot of this node at that cut");
    const former = await formerIdsOf(workspaceId);
    const brought = broughtOf(await originRows(workspaceId));
    const scopeOf = await snapshotScopeFor(actor);
    // the set is worked out once; every page after it is read by key (spine/historyLayer.ts, COST)
    const plan = await planHistory(workspaceId, scopeOf, { source: node, cut: options.cut });
    // a device that kept only the text history of the notes it took cannot hand on the drawings' one: the file says so (HistoryPage.textOnly)
    const textOnly = (await db.selectFrom("sync_join").select("history_scope").where("workspace_id", "=", workspaceId).executeTakeFirst())?.history_scope === "body";
    let items: HistoryItem[] = [];
    let layer: HistoryPage["layer"] = "blobs";
    let bytes = 0;
    let pages = 0;
    const flush = async () => {
      if (items.length === 0) return;
      pages += 1;
      const page: HistoryPage = { layer, dataShape: SYNC_DATA_SHAPE_VERSION, page: pages, cut: options.cut, source: node, former, brought, workspaceId, inkBytes: plan.inkBytes, textOnly, items };
      items = []; bytes = 0;
      await emit(page);
    };
    await readHistoryItems(plan, async (itemLayer, item) => {
      if (itemLayer !== layer) { await flush(); layer = itemLayer; } // a page holds one layer
      items.push(item);
      bytes += sizeOf(item);
      if (bytes >= budget) await flush();
    });
    await flush();
    return { pages, digests: await sentHistoryDigests(plan), inkBytes: plan.inkBytes };
  });
}
