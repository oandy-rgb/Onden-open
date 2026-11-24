// What one transaction of taking a bundle costs, in one piece and in segments (spine/stampedImport.ts receiveChangeBundle; proposal own-node-transport-2026-11-22.md §2.10,
// batch 6, and items 5, 6 and 21 of its §4). The receiver is a database of the owner's size (1,000 notes with an attribute and a tag each, 3,500 versions) and takes:
//   5   a bundle of new notes (each with an attribute and a tag): the received rows' checks and the writes, per row;
//   21  a bundle that moves a subtree of 1,000 notes to another space: one group (every note names its parent), so one segment, and its slugs;
//   6   a bundle that deletes for good the notes of the first: its tombstones;
// at 1,000 and at 5,000 notes. What is asserted is counted, not timed: the statements of the largest transaction while a bundle is taken in segments do not grow with the
// bundle (the bound: a segment is at most SEGMENT_LIMITS rows, or one group; the finishing step is O(origins)), while in one piece they do; and the result is the same
// as in one piece. Times are printed for the PR (`[segments]` lines), not asserted.
// SAFETY: databases made from the migrated template (PGlite, or new databases on a `_test` server); nothing shared is touched.
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { pool, q, withTransaction } from "../db.js";
import { withRequestDevice } from "../requestContext.js";
import { readChangeBundle } from "../services/stampedBundle.js";
import { putBlob } from "../services/blobs.js";
import { recordVersion } from "../spine/noteVersions.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { bundleOf, readHave } from "../spine/stampedBundle.js";
import { applyChangeBundle, receiveChangeBundle } from "../spine/stampedImport.js";
import { stampTransaction } from "../spine/stamps.js";
import type { ChangeBundlePage } from "../spine/snapshotSql.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, fillFrom, openNode } from "./helpers/stampedWorld.js";
import { admit, expectSame, peerOf, UPDATED_AT_OF_ATTRIBUTES, type Peer } from "./helpers/stampedBundleWorld.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

type Tx = { statements: number; ms: number };
/** Every transaction `fn` opens (BEGIN … COMMIT/ROLLBACK on one client): how many statements it ran and how long it was open. */
async function transactionsOf<T>(fn: () => Promise<T>): Promise<{ result: T; txs: Tx[] }> {
  const txs: Tx[] = [];
  const real = pool.connect.bind(pool) as () => Promise<{ query: (...a: unknown[]) => unknown; release: (e?: Error) => void }>;
  (pool as unknown as { connect: () => Promise<unknown> }).connect = async () => {
    const client = await real();
    const query = client.query, release = client.release;
    let at: { statements: number; start: number } | null = null;
    client.query = (...args: unknown[]) => {
      const text = typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text;
      if (/^BEGIN/.test(text)) at = { statements: 0, start: performance.now() };
      else if (at && (text === "COMMIT" || text === "ROLLBACK")) { txs.push({ statements: at.statements, ms: performance.now() - at.start }); at = null; }
      else if (at) at.statements++;
      return query.apply(client, args);
    };
    client.release = (e?: Error) => { client.query = query; client.release = release; release.call(client, e); };
    return client;
  };
  try { return { result: await fn(), txs }; } finally { (pool as unknown as { connect: unknown }).connect = real; }
}

const stamped = (p: Peer, fn: () => Promise<void>) => onNode(p.node, () => withRequestDevice(randomUUID(), () => withTransaction(() => withEventTransaction(p.ws, async () => { await stampTransaction(p.ws, p.owner.id); await fn(); }))));

/** `n` new notes on `p` in `space`, each with an attribute and the tag `tag`, under `parent` (null: at the top). Returns their ids. */
async function makeNotes(p: Peer, n: number, space: string, tag: string, parent: string | null, label: string): Promise<string[]> {
  const ids: string[] = [];
  for (let done = 0; done < n; done += 500) {
    await stamped(p, async () => {
      const made = (await q<{ id: string }>(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, space_id, parent_id)
               SELECT gen_random_uuid(), $1, 'manual', 'content', $5 || ' ' || g, $5 || '-' || $3::int || '-' || g, 'body ' || g, $2, $6 FROM generate_series(1, $4::int) g RETURNING id::text`,
      [p.ws, space, done, Math.min(500, n - done), label, parent])).rows.map((r) => r.id);
      await q(`INSERT INTO node_attributes (workspace_id, node_id, key, value, source) SELECT $1, x::uuid, 'scale', 'v', 'ui' FROM unnest($2::text[]) x`, [p.ws, made]);
      await q(`INSERT INTO node_tags (node_id, tag_id) SELECT x::uuid, $2 FROM unnest($1::text[]) x`, [made, tag]);
      ids.push(...made);
    });
  }
  return ids;
}

type Measure = { items: number; whole: Tx; segments: number; largest: Tx; slowest: Tx; plan: Tx[]; finish: Tx };

/** `to` takes what `from` has: a copy of it in one piece, itself in segments; both measured, then compared. */
async function takeBoth(from: Peer, to: Peer, label: string): Promise<Measure> {
  const have = await onNode(to.node, () => readHave(to.ws));
  const pages = JSON.parse(JSON.stringify(await onNode(from.node, () => readChangeBundle(from.owner, from.ws, have)))) as ChangeBundlePage[];
  const items = pages.reduce((n, p) => n + p.items.length, 0);
  const copy = await RealNode.open(`${to.name}-whole`, to.node!);
  open.push(copy);
  const whole = { ...to, name: `${to.name}-whole`, node: copy };
  const now = Date.now(), real = Date.now;
  Date.now = () => now; // the clock a node takes from a bundle reads "now": the same for both
  try {
    const one = await onNode(copy, () => transactionsOf(() => applyChangeBundle(whole.ws, bundleOf(pages))));
    const seg = await onNode(to.node, () => transactionsOf(() => receiveChangeBundle(to.ws, pages)));
    const txs = seg.txs, segmentTxs = txs.filter((t) => t.statements > 20);
    const by = (k: keyof Tx) => (a: Tx, b: Tx) => b[k] - a[k];
    const m: Measure = { items, whole: [...one.txs].sort(by("statements"))[0]!, segments: seg.result.segments, largest: [...txs].sort(by("statements"))[0]!, slowest: [...txs].sort(by("ms"))[0]!,
      plan: txs.slice(0, txs.length - seg.result.segments - 1), finish: txs.at(-1)! };
    console.log(`[segments] ${label}: ${items} items. one piece: ${Math.round(m.whole.ms)} ms, ${m.whole.statements} statements in one transaction. ` +
      `in ${m.segments} segments: largest transaction ${m.largest.statements} statements (${Math.round(m.largest.ms)} ms), longest ${Math.round(m.slowest.ms)} ms; ` +
      `${txs.length} transactions, ${Math.round(txs.reduce((s, t) => s + t.ms, 0))} ms in all; finishing step ${m.finish.statements} statements, ${Math.round(m.finish.ms)} ms; ` +
      `segments with more than 20 statements: ${segmentTxs.length}`);
    await expectSame(to, whole, label, [UPDATED_AT_OF_ATTRIBUTES]);
    return m;
  } finally { Date.now = real; await copy.close(); open.splice(open.indexOf(copy), 1); }
}

/** A receiver of the owner's size: `base` notes from the source (an attribute and a tag each), joined by snapshot, and 3,500 versions of its own. */
async function ownerSized(base: number): Promise<{ a: Peer; b: Peer; tag: string; spaceA: string; spaceB: string }> {
  const na = await openNode("a"), nb = await openNode("b");
  open.push(na, nb);
  const world = await buildSourceWorld(na);
  const a = peerOf("A", na, world);
  const tag = randomUUID();
  await stamped(a, async () => { await q(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown) VALUES ($1, $2, 'manual', 'class_tag', 'scale tag', 'scale-tag', '')`, [tag, a.ws]); });
  const notes = await makeNotes(a, base, world.spaceA, tag, null, "base");
  await onNode(na, () => q(`ANALYZE`));
  await fillFrom(nb, world, await capture(na, world, 1_000_000));
  const b = peerOf("B", nb, world);
  await admit(b, a);
  // 3,500 versions on the receiver (three or four per note): what a year of saves leaves; they are not carried, they make the database the size it is
  for (let at = 0; at < notes.length; at += 250) {
    await stamped(b, async () => {
      for (const [k, id] of notes.slice(at, at + 250).entries()) {
        for (let v = 0; v < (k % 2 ? 4 : 3); v++) await recordVersion({ workspaceId: b.ws, noteId: id, unit: "body", contentHash: await putBlob(`body of ${id}, version ${v}`), kind: v ? "updated" : "created", title: "base" });
      }
    });
  }
  const versions = Number((await onNode(nb, () => q<{ n: string }>(`SELECT count(*)::text AS n FROM note_versions WHERE workspace_id = $1`, [b.ws]))).rows[0]!.n);
  expect(versions).toBeGreaterThanOrEqual(3_400);
  await onNode(nb, () => q(`ANALYZE`));
  return { a, b, tag, spaceA: world.spaceA, spaceB: world.spaceB };
}

/** The three bundles of the header at `n` notes, taken by the owner-sized receiver. */
async function threeBundles(n: number): Promise<Record<"new" | "subtree" | "deleted", Measure>> {
  const { a, b, tag, spaceA, spaceB } = await ownerSized(1_000);
  // 5: n new notes at the top of a space
  const made = await makeNotes(a, n, spaceA, tag, null, "new");
  const created = await takeBoth(a, b, `${n} new notes with an attribute and a tag each`);
  // 21: a folder with 1,000 notes under it moves to another space (the notes follow their tree)
  const folder = randomUUID();
  await stamped(a, async () => { await q(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, space_id) VALUES ($1, $2, 'manual', 'content', 'folder', 'folder', '', $3)`, [folder, a.ws, spaceA]); });
  await makeNotes(a, 1_000, spaceA, tag, folder, "under");
  await takeBoth(a, b, "a folder of 1,000 notes, made");
  await stamped(a, async () => {
    await q(`SET CONSTRAINTS ALL DEFERRED`);
    await q(`UPDATE content_nodes SET space_id = $3 WHERE workspace_id = $1 AND (id = $2 OR parent_id = $2)`, [a.ws, folder, spaceB]);
  });
  const subtree = await takeBoth(a, b, "a folder of 1,000 notes moved to another space");
  // 6: the n new notes deleted for good
  for (let at = 0; at < made.length; at += 1_000) await stamped(a, async () => { await q(`DELETE FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[])`, [a.ws, made.slice(at, at + 1_000)]); });
  const deleted = await takeBoth(a, b, `${n} notes deleted for good`);
  return { new: created, subtree, deleted };
}

describe.runIf(isTestDb)("taking a bundle in segments: no transaction grows with the bundle", () => {
  it("1,000 and 5,000 new notes, a moved subtree of 1,000, and the deletes, on a receiver of the owner's size: the largest transaction in segments stays the same size, in one piece it grows", async () => {
    const small = await threeBundles(1_000);
    const large = await threeBundles(5_000);
    for (const kind of ["new", "deleted"] as const) {
      // one piece: five times the notes, about five times the statements in its one transaction
      expect(large[kind].whole.statements, kind).toBeGreaterThan(3 * small[kind].whole.statements);
      // in segments: the largest transaction is the same size (a segment holds SEGMENT_LIMITS rows at most; none of these bundles has a larger group)
      expect(large[kind].largest.statements, kind).toBeLessThanOrEqual(1.25 * small[kind].largest.statements);
      expect(large[kind].segments, kind).toBeGreaterThan(small[kind].segments);
      // the finishing step is O(origins): the same at both sizes
      expect(large[kind].finish.statements, kind).toBeLessThanOrEqual(small[kind].finish.statements + 2);
      // and every transaction of the plan reads at most one page, or the slugs of SLUG_READ_IDS notes, or checks one segment
      expect(Math.max(...large[kind].plan.map((t) => t.statements)), kind).toBeLessThanOrEqual(1.25 * Math.max(...small[kind].plan.map((t) => t.statements)) + 5);
    }
    // the subtree is one row (its folder moved): it cannot be split, and what it costs follows the notes under it here, not the bundle: at most 11 statements a note
    // under it (measured: 10.2 with the derivation of batch 4a; settleSlugs and the links of a moved note, item 21), the same at both sizes of the other bundles
    for (const m of [small.subtree, large.subtree]) expect(m.largest.statements, "the moved subtree of 1,000 notes").toBeLessThanOrEqual(11 * 1_000 + 300);
    expect(large.subtree.largest.statements).toBeLessThanOrEqual(1.1 * small.subtree.largest.statements);
  }, 3_600_000);
});
