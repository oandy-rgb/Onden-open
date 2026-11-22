// Reading a CHANGE BUNDLE: everything of a workspace's stamped units (every table of stampedMerge/dbUnits.ts UNIT_SOURCES and its JSON keys) that another node does not have yet (docs/research/sync-design-vs-literature-2026-11-16.md, the
// list "before change bundles"; the taking half is `applyChangeBundle` in spine/stampedImport.ts).
//
//   const pages = await readChangeBundle(actor, workspaceId, { [originA]: 12, [originB]: 3 });   // services/stampedBundle.ts. `have`: per origin, the highest sequence number the receiver holds
//   const bundle = bundleOf(pages);                                                          // one bundle (all its pages), what applyChangeBundle takes
//
// WHAT A BUNDLE SAYS. `base` is the `have` it was read against; `holds` is what the sender holds at the cut, per origin. The bundle has every write of the scope above
// `base` up to `holds` (an overwritten write is not there; the write that overwrote it had seen it) that the reader may read. `upTo` is what the receiver that held
// `base` holds once it took the bundle: `holds`, except below the first write of an origin the bundle WITHHELD because its row is outside the reader's scope (a row of a
// space the reader is not a member of): the receiver's `have` never passes a write it did not get, and the next bundle sends that write again, as soon as the reader
// may read it (I5; stampedBundleWithheld test in mergeSpaceParent.integration.test.ts). The cost: until then, every bundle sends again what that origin wrote after the
// withheld write (taking it again stores nothing). A row that
// has at least one stamp above `base` is sent whole (all its stamps of the scope, saw, meta and the other heads, and every unit's value as text), so the receiver
// can merge it without asking for more. A row that is gone is a tombstone.
//
// THE CUT (why a bundle never skips a write; proved in stampedBundleCut.integration.test.ts on a real Postgres with two connections). A stamp's sequence number is taken
// under the workspace's event-append lock and its clock row (spine/stamps.ts lockClock: sync_lock_clock), both held until the writing transaction ends, and the next
// writer's number is taken only after that lock is free. So in one workspace numbers are taken, and the writes that carry them commit, in number order: a larger number
// never commits before a smaller one, and the stamps a reader sees are exactly those up to the clock's `next_seq - 1`, as long as the cut and the stamps are read in ONE snapshot
// (the caller's withActorReadSnapshot, services/stampedBundle.ts). Reading the cut in another statement than the stamps would break this, in the dangerous order: stamps first, then a cut that a later commit moved.
// The read takes no lock of its own (a read must not make writers wait); the guard is the single snapshot, and the test fails when it is taken away.
//
// WHO MAY ASK. services/stampedBundle.ts: a person who owns the workspace, and the rows are those the owner's snapshot carries. That the asker is a node this workspace admitted
// (sync_origins) is for the transport, a later batch. stampedMergeCallers.guard.test.ts lists the callers: none in the product yet.
// The structure log never leaves a device and is not read here (stampedBundle.guard.test.ts).

import { inTransaction } from "../db.js";
import { FOREIGN_CLOCK_BOUND_MS } from "./stamps.js";
import { SYNC_DATA_SHAPE_VERSION } from "./syncDataShape.js";
import { carriedKeys, readCarriedRows, readStampsOf, snapshotRows, type BundleItem, type ChangeBundle, type ChangeBundlePage, type ScopeFactory } from "./snapshotSql.js";
import { wholeWorkspace } from "./snapshotTables.js";
import { CARRIED_LABELS, GENESIS_STAMP_ORIGIN, UNIT_SOURCES, labelsOf, rowMatchOf, unitTextsSql } from "./stampedMerge/index.js";

/** What a bundle speaks about: every label in CARRIED_LABELS, read at one cut. */
export const BUNDLE_SCOPE = "stamped" as const;
const PAGE_BYTES = 4 * 1024 * 1024;
/** How many rows of a table one statement reads. A chunk costs about one pass over the table (with current statistics the planner reads it whole rather than look up thousands of
 *  keys one by one), so the number of chunks must not grow with a bundle: 200 made reading quadratic (stampedBundleScale.integration.test.ts counts the rows read). */
const CHUNK_ROWS = 10_000;

import { bundleRefused } from "./bundleRefusal.js";
export { bundleRefused };

/** What a receiver says it holds: origin → highest sequence number (a whole number ≥ 0). The genesis origin is nobody's and is dropped. */
export type Have = Readonly<Record<string, number>>;
export function normalizeHave(have: unknown): Record<string, number> {
  if (have === null || typeof have !== "object" || Array.isArray(have)) throw bundleRefused("bundle_bad_have", "what the receiver holds is an object of whole numbers", 400);
  const out: Record<string, number> = {};
  for (const [origin, n] of Object.entries(have)) {
    if (!origin || !Number.isSafeInteger(n) || (n as number) < 0) throw bundleRefused("bundle_bad_have", "what the receiver holds is an object of whole numbers", 400);
    if (origin !== GENESIS_STAMP_ORIGIN) out[origin] = n as number;
  }
  return out;
}

/**
 * What this node holds of the scope, per origin, as the `have` of a request for a bundle: its own origin up to the clock's last number (it holds everything it wrote), and each
 * origin it accepts up to what it took (sync_origins). Read in the caller's transaction.
 */
export async function readHave(workspaceId: string): Promise<Record<string, number>> {
  const own = (await snapshotRows<{ node_id: string; next_seq: string | null }>(
    `SELECT n.node_id, c.next_seq::text FROM sync_node n LEFT JOIN sync_clock c ON c.workspace_id = $1 WHERE n.singleton`, [workspaceId])).rows[0];
  if (!own) throw new Error("this database has no node id yet");
  const have: Record<string, number> = {};
  for (const o of (await snapshotRows<{ origin: string; have: Record<string, number> }>(`SELECT origin, have FROM sync_origins WHERE workspace_id = $1`, [workspaceId])).rows) have[o.origin] = heldOfAll(o.have);
  have[own.node_id] = Number(own.next_seq ?? 1) - 1;
  return have;
}

/**
 * How far a node holds an origin's writes to EVERY label a bundle carries: the least of `sync_origins.have` over CARRIED_LABELS (a label it never took counts 0). A bundle carries all
 * labels at one cut, so after taking one they are equal; a node that took only `content_nodes` before this batch holds the other labels from 0 and is sent them whole (its notes again too:
 * taking them twice changes nothing).
 */
export function heldOfAll(have: Readonly<Record<string, number>>): number {
  return Math.min(...CARRIED_LABELS.map((l) => have[l] ?? 0));
}
/** The `sync_origins.have` of an origin held up to `n` for every label a bundle carries. */
export const haveOfAll = (n: number): Record<string, number> => Object.fromEntries(CARRIED_LABELS.map((l) => [l, n]));

/** Which of `keys` are rows of the table at all (in or out of the reader's scope). */
async function rowsPresent(src: (typeof UNIT_SOURCES)[number], workspaceId: string, keys: string[]): Promise<Set<string>> {
  const m = rowMatchOf(src, keys);
  const params: unknown[] = [workspaceId];
  return new Set((await snapshotRows<{ id: string }>(`SELECT ${m.idSql("t")} AS id FROM "${src.table}" t WHERE ${m.match("t", params)} AND ${m.workspace("t", "$1")}`, params)).rows.map((r) => r.id));
}

const sizeOf = (item: BundleItem) => new TextEncoder().encode(JSON.stringify(item)).length;

/**
 * Every stamp of `workspaceId`'s content_nodes units that the receiver (holding `have`) does not have, as pages of one bundle. At least one page, even when nothing is new: it says what
 * the sender holds. MUST run inside the read snapshot of the caller (services/stampedBundle.ts `readChangeBundle` opens it, as the actor's, and gives `scopeOf`: the rows the bundle may carry
 * are the rows the actor's snapshot carries, so a node joined by snapshot is never sent a row its snapshot left out).
 */
export async function readBundlePages(workspaceId: string, have: Have, scopeOf: ScopeFactory, options: { pageBytes?: number; /** test seam: runs between the read of the cut and the read of the stamps (stampedBundleCut.integration.test.ts commits a write there) */ afterCut?: () => Promise<void> } = {}): Promise<ChangeBundlePage[]> {
  const base = normalizeHave(have);
  const budget = options.pageBytes ?? PAGE_BYTES;
  if (!inTransaction()) throw new Error("a bundle is read inside one read snapshot that the caller opened (services/stampedBundle.ts)");
  {
    await snapshotRows(`SELECT set_config('TimeZone', 'UTC', true)`);
    const node = (await snapshotRows<{ node_id: string }>(`SELECT node_id FROM sync_node WHERE singleton`)).rows[0]?.node_id;
    if (!node) throw new Error("this database has no node id yet");
    if ((await snapshotRows(`SELECT 1 FROM sync_join WHERE workspace_id = $1 AND state = 'joining'`, [workspaceId])).rows.length > 0) {
      throw bundleRefused("bundle_sender_joining", "this workspace is being filled from a snapshot; it has nothing to send yet");
    }
    // one snapshot: the cut and the stamps are read at the same moment (see the header)
    const cut = Number((await snapshotRows<{ next_seq: string }>(`SELECT next_seq FROM sync_clock WHERE workspace_id = $1`, [workspaceId])).rows[0]?.next_seq ?? 1) - 1;
    const upTo: Record<string, number> = {};
    for (const o of (await snapshotRows<{ origin: string; have: Record<string, number> }>(`SELECT origin, have FROM sync_origins WHERE workspace_id = $1`, [workspaceId])).rows) upTo[o.origin] = heldOfAll(o.have);
    // the receiver holds more of THIS node than it ever made: this node was restored from an older copy and has written the same numbers again with other content. Nothing it sends can be told from news; it must not send (the way out is a new node id, a later batch)
    if ((base[node] ?? 0) > cut) throw bundleRefused("bundle_sender_restored", "the receiver holds writes of this node that this node never made: it was restored from an older copy");
    upTo[node] = cut;
    const holds = { ...upTo };
    /** per origin, the first write of it this bundle withholds (its row is outside the reader's scope) */
    const withheld: Record<string, number> = {};
    await options.afterCut?.();

    const pages: ChangeBundlePage[] = [];
    let items: BundleItem[] = [];
    let bytes = 0;
    const header = { layer: "changes" as const, dataShape: SYNC_DATA_SHAPE_VERSION, workspaceId, scope: BUNDLE_SCOPE, sender: node, cut, base, upTo: holds, holds };
    const flush = () => { if (items.length) { pages.push({ ...header, pages: 0, page: pages.length + 1, items }); items = []; bytes = 0; } };
    const add = (item: BundleItem) => { items.push(item); bytes += sizeOf(item); if (bytes >= budget) flush(); };

    for (const src of UNIT_SOURCES) {
      const labels = labelsOf(src);
      // the rows of this table that have at least one stamp (of the row or of a key of its JSON columns) the receiver does not hold: found in ONE pass over the
      // table's stamps, then read CHUNK_ROWS rows at a time (a query per chunk that looked for "the next 200 after the last" rescanned every stamp each time: quadratic)
      const changed = (await snapshotRows<{ row_key: string }>(
        `SELECT s.row_key FROM (
           SELECT row_key, origin, seq FROM sync_stamps WHERE workspace_id = $1 AND table_name = ANY($2::text[])
           UNION ALL SELECT row_key, origin, seq FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = ANY($2::text[])) s
          WHERE s.origin <> 'genesis' AND s.seq > COALESCE(($3::jsonb ->> s.origin)::bigint, 0)
          GROUP BY s.row_key ORDER BY s.row_key COLLATE "C"`, [workspaceId, labels, JSON.stringify(base)])).rows.map((r) => r.row_key);
      for (let at = 0; at < changed.length; at += CHUNK_ROWS) {
        const keys = changed.slice(at, at + CHUNK_ROWS);
        const rows = await readCarriedRows(src.table, workspaceId, rowMatchOf(src, keys), unitTextsSql(src), scopeOf);
        const present = await rowsPresent(src, workspaceId, keys);
        // the rows a reader of the whole workspace would be sent: one of them this reader is not sent is WITHHELD (a row that never travels is in neither)
        const carriable = await carriedKeys(src.table, workspaceId, rowMatchOf(src, keys), () => wholeWorkspace());
        const stamps = await readStampsOf(workspaceId, keys.flatMap((rowKey) => labels.map((label) => ({ label, rowKey }))));
        const byRow = new Map<string, typeof stamps>();
        for (const st of stamps) (byRow.get(st.rowKey) ?? byRow.set(st.rowKey, []).get(st.rowKey)!).push(st);
        for (const key of keys) {
          const own = byRow.get(key) ?? [];
          const row = rows.get(key);
          if (row) add({ kind: "row", table: src.label, values: row.v, stamps: own, texts: row.texts });
          else if (present.has(key)) {
            if (!carriable.has(key)) continue;
            for (const w of own.flatMap((st) => [st, ...st.heads])) {
              if (w.origin === GENESIS_STAMP_ORIGIN || w.seq <= (base[w.origin] ?? 0)) continue;
              withheld[w.origin] = Math.min(withheld[w.origin] ?? Infinity, w.seq);
            }
          } else {
            // a row that is not in the table: gone for good (its tombstone, and the keys of its JSON columns: the delete trigger leaves theirs), or never made here because it hangs
            // on a note this node does not hold (rule 4.9, dbRows.ts): its stamps travel all the same, so every node holds the same writes. A row that IS in the table and
            // out of the reader's scope sends nothing (as before). This is right for a reader that holds the whole workspace; a per-space bundle (#1769) must NOT send the
            // stamps of a row outside the reader's scope that is gone: they would tell the reader that the row existed. That batch decides its own rule. A row in the table
            // and outside the reader's scope is withheld (above): its stamps are not sent, and `upTo` stops below them.
            for (const st of own) add({ kind: "tombstone", table: st.label, stamp: st });
          }
        }
      }
    }
    flush();
    if (pages.length === 0) pages.push({ ...header, pages: 0, page: 1, items: [] });
    // what the receiver holds after the bundle: never past a write it withheld (I5)
    const receiverHolds = Object.fromEntries(Object.entries(holds).map(([o, n]) => [o, withheld[o] === undefined ? n : Math.min(n, withheld[o]! - 1)]));
    return pages.map((p) => ({ ...p, upTo: receiverHolds, pages: pages.length }));
  }
}

/** The pages of one bundle, put together. Refused when they are not the pages of one bundle (another header, a page missing or twice). */
export function bundleOf(pages: readonly ChangeBundlePage[]): ChangeBundle {
  const first = pages[0];
  if (!first) throw bundleRefused("bundle_no_pages", "a bundle has at least one page", 422);
  const { page: _page, items: _items, ...header } = first;
  const seen = new Set<number>();
  const text = JSON.stringify(header);
  for (const p of pages) {
    const { page, items: _i, ...h } = p;
    if (JSON.stringify(h) !== text) throw bundleRefused("bundle_pages_differ", "the pages are not of one bundle", 422);
    if (!Number.isInteger(page) || page < 1 || page > header.pages || seen.has(page)) throw bundleRefused("bundle_pages_differ", "a page number is missing or twice", 422);
    seen.add(page);
  }
  if (seen.size !== header.pages) throw bundleRefused("bundle_page_missing", "a page of the bundle did not arrive", 409);
  return { ...header, items: [...pages].sort((a, b) => a.page - b.page).flatMap((p) => p.items) };
}

/**
 * Why writes of this node cannot be sent, found out from this node's own data (the structure is the same for every reason: one entry per reason, with how many writes and the numbers a screen needs).
 * Three reasons make a node's local history not fit as it is (docs: stampedMerge/README.md "收不進去"); all three have ONE way out, a new node id and the unsent writes stamped again with the time now,
 * which is not part of this batch. Today only `clock_ahead` can be worked out here: the node's own stamps whose clock reading is past the bound a receiver accepts. `restored` (a receiver holds more of this
 * node than it made: `bundle_sender_restored`) and `gap` (the receiver's `have` is behind what this node keeps: `bundle_gap`) are known only when a peer refuses, and nothing keeps that answer yet.
 */
export type Unsendable = { reason: "clock_ahead" | "restored" | "gap"; writes: number; aheadMs?: number };
export async function readUnsendable(workspaceId: string, nowWall: number = Date.now()): Promise<Unsendable[]> {
  const node = (await snapshotRows<{ node_id: string }>(`SELECT node_id FROM sync_node WHERE singleton`)).rows[0]?.node_id;
  if (!node) return [];
  const r = (await snapshotRows<{ n: string; top: string | null }>(
    `SELECT count(DISTINCT seq)::text AS n, max(hlc_wall)::text AS top FROM (
       SELECT seq, hlc_wall FROM sync_stamps WHERE workspace_id = $1 AND origin = $2 AND hlc_wall > $3
       UNION ALL SELECT seq, hlc_wall FROM sync_stamp_heads WHERE workspace_id = $1 AND origin = $2 AND hlc_wall > $3) x`, [workspaceId, node, nowWall + FOREIGN_CLOCK_BOUND_MS])).rows[0]!;
  return Number(r.n) > 0 ? [{ reason: "clock_ahead", writes: Number(r.n), aheadMs: Number(r.top) - nowWall }] : [];
}
