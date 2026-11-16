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
// then the tombstones (a deleted row's stamp outlives the row); last the `refs` that set the columns a table points back with.
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
// What it refuses: a non-null `since` and the `history` / `blobs` layers (not done); an operator that is a delegated token; a
// workspace whose stamps name an origin other than this node and genesis (a node that was itself filled from another has stamps
// it does not own: the first stage does not export those). It never reads structure_log or domain_events.

import { CodedStatusError } from "../statusError.js";
import { requirePerson } from "../spine/authority.js";
import { stampUnstampedRowsAsGenesis } from "../spine/stamps.js";
import { SYNC_DATA_SHAPE_VERSION } from "../spine/syncDataShape.js";
import { withActorReadSnapshot } from "./actorReadSnapshot.js";
import { snapshotScopeFor } from "./readPolicy.js";
import { SNAPSHOT_SPECS } from "../spine/snapshotTables.js";
import { computeSnapshotDigest, snapshotRows, readRefsChunk, readRowChunk, readStampsOf, readTombstoneChunk, type SnapshotItem, type StampedPage, type TableDigest, type WireStamp } from "../spine/snapshotSql.js";
import type { ActorCtx } from "../types.js";

/** A page holds about this many bytes before it is closed (before compression; a single row is never split). */
const SNAPSHOT_PAGE_BYTES = 4 * 1024 * 1024;
const CHUNK_ROWS = 200; // rows read per query: each query has a fixed cost (the reader's scope is worked out in it), so more rows per query is much faster; a chunk is in memory once

type SnapshotSummary = { source: string; cut: number; pages: number; digest: TableDigest[] };

type ReadStampedPagesOptions = {
  /** Null: the whole snapshot. Anything else is refused until changes-since is done. */
  since: null;
  layer: "rows" | "history" | "blobs";
  pageBytes?: number;
};

class SnapshotNotDone extends CodedStatusError {}
class SnapshotForeignOrigin extends CodedStatusError {
  constructor() { super(409, "snapshot_foreign_origin", "this database holds stamps made on another node; a snapshot of it cannot be made yet"); }
}

const sizeOf = (item: SnapshotItem) => new TextEncoder().encode(JSON.stringify(item)).length;

export async function readStampedPages(
  authenticated: ActorCtx, workspaceId: string, options: ReadStampedPagesOptions, emit: (page: StampedPage) => Promise<void>,
): Promise<SnapshotSummary> {
  if (options.since !== null) throw new SnapshotNotDone(422, "snapshot_since_not_done", "reading only what changed since a cut is not done yet");
  if (options.layer !== "rows") throw new SnapshotNotDone(422, "snapshot_layer_not_done", `the ${options.layer} layer of a snapshot is not done yet`);
  requirePerson(authenticated, "export a snapshot");
  const budget = options.pageBytes ?? SNAPSHOT_PAGE_BYTES;
  // Before the read snapshot opens (it is read-only): a row nothing has stamped yet gets the genesis stamp, so the copy carries one for every row.
  await stampUnstampedRowsAsGenesis();

  return withActorReadSnapshot(authenticated, workspaceId, async (actor) => {
    await snapshotRows(`SELECT set_config('TimeZone', 'UTC', true)`);
    const node = (await snapshotRows<{ node_id: string }>(`SELECT node_id FROM sync_node WHERE singleton`)).rows[0]?.node_id;
    if (!node) throw new Error("this database has no node id yet");
    const foreign = await snapshotRows(`SELECT 1 FROM sync_stamps WHERE workspace_id = $1 AND origin NOT IN ($2, 'genesis') LIMIT 1`, [workspaceId, node]);
    if (foreign.rows.length > 0) throw new SnapshotForeignOrigin();
    const cut = Number((await snapshotRows<{ next_seq: string }>(`SELECT next_seq FROM sync_clock WHERE workspace_id = $1`, [workspaceId])).rows[0]?.next_seq ?? 1) - 1;
    const scopeOf = await snapshotScopeFor(actor);

    let items: SnapshotItem[] = [];
    let bytes = 0;
    let pages = 0;
    const flush = async () => {
      if (items.length === 0) return;
      pages += 1;
      const page: StampedPage = { layer: "rows", dataShape: SYNC_DATA_SHAPE_VERSION, page: pages, cut, source: node, workspaceId, items };
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
    return { source: node, cut, pages, digest };
  });
}
