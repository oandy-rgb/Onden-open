// realPostgresAlso: one test reads a snapshot on a second connection while a bundle is being taken on the first (PGlite has one connection, so there it reads after the merge)
//
// A node that holds other nodes' writes is the source of a snapshot (the own-node-transport proposal, PR #1936, §3.4, §6 batch 2): the snapshot names the
// other origins its source holds, per label, as far as it holds them (`brought`; services/stampedSnapshot.ts), and the joiner holds exactly that afterwards
// (spine/stampedImport.ts checkPage / markJoinDone). `have` is per label end to end (spine/stampedBundle.ts Have). What is proved, each as its own test:
//   P1  a node that joined from a source in a two-head (conflict) state holds exactly the source's stamps and other heads (saw, meta, kept values) and knows exactly
//       what the source knew (sync_origins: the source up to its cut, every other origin per label as the source held it);
//   P2  after joining, one more bundle from the source, or from a third node (admitted then), stores exactly the new writes; a full re-send stores 0;
//   P3  A→B snapshot, B→C snapshot, then C↔A bundles (C admits A, which it knew only as brought): C and A end the same, a full re-send stores 0 both ways;
//   P4  a snapshot of a source with an unfinished join, of one whose stamps of an origin go past what it says it holds of it (a merge whose progress was not
//       written: the old per-origin progress row, a lowered row), or that holds stamps of an origin it has no row for, is refused with a code; a snapshot read
//       while a bundle is being taken sees all of it or none of it;
//   P5  every malformed or over-cap origin list, a page that names other origins than the first line, a stamp past the number given for its origin, and a stamp of
//       an origin nobody vouched for are refused with a code, and the database is as before (an empty shell that then joins);
//   P6  the progress a node stored before the shape change is read as it is (sync_origins.have is per label since migration 206); the old one-number-per-origin
//       form of `have` and of a bundle's header is refused with its own code, never read as labels.
// SAFETY: node databases (a PGlite each, or a database of the test server on a real Postgres), dropped after each test.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { q, withTransaction } from "../db.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { stampTransaction } from "../spine/stamps.js";
import { readChangeBundle } from "../services/stampedBundle.js";
import { snapshotSourceNode } from "../services/stampedSnapshot.js";
import { withActorReadSnapshot } from "../services/actorReadSnapshot.js";
import { abandonJoin, applyJoinPage, finishJoin, startJoin } from "../services/stampedJoin.js";
import { bundleOf, haveOfAll, readHave } from "../spine/stampedBundle.js";
import { admitSyncNode, applyChangeBundle } from "../spine/stampedImport.js";
import { CARRIED_LABELS } from "../spine/stampedMerge/index.js";
import type { StampedPage } from "../spine/snapshotSql.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { needsSecondConnection } from "./helpers/pgliteSkips.js";
import { seedQ } from "./helpers/seedQ.js";
import { buildSourceWorld, capture, fillFrom, openNode, outOfScopeIds, type Capture, type SourceWorld } from "./helpers/stampedWorld.js";
import { admit, bundleFor, exchange, expectSame, makeRng, markWorld, nodeIdOf, peerOf, resendAll, resetRowTurns, take, withOriginAt, writeFor, type Peer } from "./helpers/stampedBundleWorld.js";
import { PROPS_SEED } from "./helpers/propsConfig.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
/** Every seed of this file is offset by this: a new one each run (review round 1, A3), or PROPS_SEED when it is set (helpers/propsConfig.ts, the variable every property
 *  run replays with). Printed, so a red is replayed with `PROPS_SEED=<n>`; a red from a new seed is a finding. Each test also forgets the generator's row-kind turns first
 *  (resetRowTurns), so a seed draws the same writes whatever order the file ran in. */
const SEED_BASE = process.env.PROPS_SEED ? PROPS_SEED : 1 + Math.floor(Math.random() * 1_000_000);
const SEED = SEED_BASE * 1000;
console.log(`[snapshotBrought] seed ${SEED_BASE} (replay: PROPS_SEED=${SEED_BASE})`);
beforeEach(() => resetRowTurns());

const open: RealNode[] = [];
const track = (n: RealNode) => { open.push(n); return n; };
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

const codeOf = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e.code ?? String(e));
const rows = <T,>(p: Peer | RealNode, text: string, params: unknown[] = []) => onNode("node" in p ? p.node : p, async () => (await q(text, params)).rows as T[]);
/** Writes that leave tombstones (trash, purge) and the writes of the other tables, besides notes: what a third node's bundle brings. */
/** `recreate` (the same id made again after it was deleted for good) is off: with it, a seed can hit the merge core's open defect (README「接上傳輸前必須完成」, "重建的列在收件那台多一個
 *  欄位標記") and P2/P3 go red for a reason that is not this batch's; there is no deterministic reproduction yet to pin it with it.fails (review round 1, A3). Turn it back
 *  on when that is fixed. */
const MIXED = { create: 18, title: 16, body: 12, move: 10, trash: 8, purge: 6, attr: 8, unattr: 3, tagMake: 2, tag: 6, point: 4, row: 6, recreate: 0 };

/**
 * EVERY stamp and other head of the workspace, every column (saw, meta, kept_value, the value of a head and whether it has none), of every label (a snapshot also carries
 * `content_nodes.collection_views`, which no bundle does), as text: what a joiner must hold byte for byte. Rows the owner cannot read (their stamps are not in the owner's
 * snapshot) are left out on both sides.
 */
async function everyStamp(p: Peer): Promise<{ stamps: string[]; heads: string[] }> {
  const without = await outOfScopeIds(p.node, p);
  const keep = (key: string) => !key.split("/").some((part) => without.includes(part));
  const stamps = await rows<{ k: string; r: string }>(p, `SELECT row_key AS k, (to_jsonb(s) - 'workspace_id')::text AS r FROM sync_stamps s WHERE workspace_id = $1
      ORDER BY table_name COLLATE "C", row_key COLLATE "C", field COLLATE "C"`, [p.ws]);
  const heads = await rows<{ k: string; r: string }>(p, `SELECT row_key AS k, (to_jsonb(h) - 'workspace_id')::text AS r FROM sync_stamp_heads h WHERE workspace_id = $1
      ORDER BY table_name COLLATE "C", row_key COLLATE "C", field COLLATE "C", origin COLLATE "C", seq, content_hash`, [p.ws]);
  return { stamps: stamps.filter((s) => keep(s.k)).map((s) => s.r), heads: heads.filter((h) => keep(h.k)).map((h) => h.r) };
}
const originsOfNode = (p: Peer) => rows<{ origin: string; vouched_by: string; have: Record<string, number> }>(p, `SELECT origin, vouched_by, have FROM sync_origins WHERE workspace_id = $1 ORDER BY origin`, [p.ws]);
/** What `p` holds, per label and origin, without its own origin (another node's readHave names its own origin; this one's is not something its source held). */
async function haveWithout(p: Peer, origin: string): Promise<Record<string, Record<string, number>>> {
  const have = await onNode(p.node, () => readHave(p.ws));
  return Object.fromEntries(Object.entries(have).map(([label, of]) => [label, Object.fromEntries(Object.entries(of).filter(([o]) => o !== origin))]));
}
/** The units (label, row, field) whose stamp or heads differ between two dumps. */
function changedUnits(before: { stamps: string[]; heads: string[] }, after: { stamps: string[]; heads: string[] }): Set<string> {
  const unit = (r: string) => { const x = JSON.parse(r) as { table_name: string; row_key: string; field: string }; return `${x.table_name}|${x.row_key}|${x.field}`; };
  const diff = (x: string[], y: string[]) => { const ys = new Set(y); return x.filter((v) => !ys.has(v)).map(unit); };
  return new Set([...diff(after.stamps, before.stamps), ...diff(before.stamps, after.stamps), ...diff(after.heads, before.heads), ...diff(before.heads, after.heads)]);
}

/**
 * A hub A with the world; B joined from A by snapshot, A admitted B; B wrote (with tombstones and the other tables) and A took it; A wrote and B took that. A now holds B's
 * writes: before this batch it could not be the source of a snapshot (snapshot_foreign_origin).
 */
async function hub(seed: number): Promise<{ world: SourceWorld; a: Peer; b: Peer }> {
  const na = track(await openNode("a")), nb = track(await openNode("b"));
  const world = await buildSourceWorld(na);
  const a = peerOf("A", na, world);
  await markWorld(a);
  await writeFor(a, makeRng(seed), 6, { weights: { title: 0, body: 0, move: 0, reorder: 0, trash: 0, undelete: 0, purge: 0, recreate: 0 } });
  await fillFrom(nb, world, await capture(na, world, 12_000));
  const b = peerOf("B", nb, world);
  await admit(a, b);
  await writeFor(b, makeRng(seed + 1), 24, { weights: MIXED });
  await exchange(b, a);
  await writeFor(a, makeRng(seed + 2), 10, { weights: { recreate: 0 } });
  await exchange(a, b);
  return { world, a, b };
}

/** A fresh node that joins from `source`'s snapshot (the pages through JSON, as on the wire). */
async function joinFrom(name: string, source: Peer, world: SourceWorld, cap?: Capture): Promise<{ peer: Peer; cap: Capture }> {
  const node = track(await openNode(name));
  const c = cap ?? await capture(source.node, world, 12_000);
  await fillFrom(node, world, c);
  return { peer: peerOf(name.toUpperCase(), node, world), cap: c };
}

/** On A, a note whose title A and B each wrote without seeing the other's, taken by A only: a unit with two heads on A (the conflict state). */
async function twoHeads(a: Peer, b: Peer): Promise<string> {
  const note = (await on(a, "POST", "/api/nodes", { id: crypto.randomUUID(), title: "Shared", markdown: "both", space_id: a.space })).id as string;
  await exchange(a, b);
  await on(a, "PATCH", `/api/nodes/${note}`, { title: "A's title" });
  await on(b, "PATCH", `/api/nodes/${note}`, { title: "B's title" });
  await exchange(b, a);
  return note;
}
/** A request through the routes, as the owner, on `p`'s database. */
const on = (p: Peer, method: string, path: string, body?: unknown) => onNode(p.node, () => p.call(method, path, body));

/** On A, a note moved by B under a parent A deleted for good without seeing the move: the emptied parent id is kept on the stamp (kept_value). */
async function keptParent(a: Peer, b: Peer): Promise<string> {
  const [p, x] = [crypto.randomUUID(), crypto.randomUUID()];
  await on(a, "POST", "/api/nodes", { id: p, title: "Parent to purge", markdown: "", space_id: a.space });
  await on(a, "POST", "/api/nodes", { id: x, title: "Moved under it", markdown: "", space_id: a.space });
  await exchange(a, b);
  await on(a, "DELETE", `/api/nodes/${p}`);
  await on(a, "POST", `/api/nodes/${p}/purge`, { expected_ids: [p] });
  await on(b, "PATCH", `/api/nodes/${x}`, { parent_id: p });
  await exchange(b, a);
  return x;
}

/** On A, an attribute B set on a note A had deleted for good (B had not seen the delete): its stamps stay on A, without a row (rule 4.9, dbRows.ts). Returns the note. */
async function hangingAttribute(a: Peer, b: Peer): Promise<string> {
  const n = crypto.randomUUID();
  await on(a, "POST", "/api/nodes", { id: n, title: "Deleted for good on A", markdown: "", space_id: a.space });
  await exchange(a, b);
  await on(a, "DELETE", `/api/nodes/${n}`);
  await on(a, "POST", `/api/nodes/${n}/purge`, { expected_ids: [n] });
  await on(b, "PUT", `/api/nodes/${n}/attributes/status`, { value: "set by B" });
  await exchange(b, a);
  return n;
}

describe.skipIf(!isTestDb)("a node that holds other nodes' writes is the source of a snapshot (batch 2)", () => {
  it("P1: a node that joined from a source in a two-head state holds exactly the source's stamps and heads (saw, meta, kept values) and knows exactly what the source knew", async () => {
    const { world, a, b } = await hub(SEED + 10);
    const note = await twoHeads(a, b);
    const kept = await keptParent(a, b);
    // a note of B's deleted for good: its tombstone (B's origin) names the space it was shown in (meta.space, migration 218)
    const gone = crypto.randomUUID();
    await on(b, "POST", "/api/nodes", { id: gone, title: "B deletes it for good", markdown: "", space_id: b.space });
    await on(b, "DELETE", `/api/nodes/${gone}`);
    await on(b, "POST", `/api/nodes/${gone}/purge`, { expected_ids: [gone] });
    await exchange(b, a);
    // a row that hangs on a note A deleted for good (4.9; review round 1, A1): B set an attribute on N without having seen the delete; A keeps the stamps, makes no row.
    // Those stamps are not deleted ones, and the snapshot carries them all the same (with the tombstones: every stamp of a row that is not in the table)
    const hung = await hangingAttribute(a, b);
    expect((await rows<{ n: string }>(a, `SELECT count(*)::text AS n FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'node_attributes' AND row_key LIKE $2 AND NOT deleted`, [a.ws, `${hung}/%`]))[0]!.n).not.toBe("0");
    expect((await rows<{ n: string }>(a, `SELECT count(*)::text AS n FROM node_attributes WHERE node_id = $1`, [hung]))[0]!.n).toBe("0");
    expect((await rows<{ n: string }>(a, `SELECT count(*)::text AS n FROM sync_stamp_heads WHERE workspace_id = $1 AND row_key = $2 AND field = 'title'`, [a.ws, note]))[0]!.n).not.toBe("0");
    expect((await rows<{ n: string }>(a, `SELECT count(*)::text AS n FROM sync_stamps WHERE workspace_id = $1 AND row_key = $2 AND kept_value IS NOT NULL`, [a.ws, kept]))[0]!.n).not.toBe("0");
    const [aId, bId] = [await nodeIdOf(a), await nodeIdOf(b)];
    // the cases the review asked for are in what is copied: genesis stamps, B's tombstones with meta.space and meta.seen
    const bTombstones = await rows<{ meta: Record<string, unknown> | null }>(a, `SELECT meta FROM sync_stamps WHERE workspace_id = $1 AND origin = $2 AND deleted AND field = '*'`, [a.ws, bId]);
    expect(bTombstones.some((t) => t.meta && Object.hasOwn(t.meta, "space"))).toBe(true);
    expect((await rows<{ n: string }>(a, `SELECT count(*)::text AS n FROM sync_stamps WHERE workspace_id = $1 AND origin = $2 AND meta ? 'seen'`, [a.ws, bId]))[0]!.n).not.toBe("0");
    expect((await rows<{ n: string }>(a, `SELECT count(*)::text AS n FROM sync_stamps WHERE workspace_id = $1 AND origin = 'genesis'`, [a.ws]))[0]!.n).not.toBe("0");

    const { peer: c, cap } = await joinFrom("c", a, world);
    expect(Object.keys(cap.summary.brought).sort()).toEqual([...CARRIED_LABELS].sort());
    expect(new Set(Object.values(cap.summary.brought).flatMap((of) => Object.keys(of)))).toEqual(new Set([bId]));
    expect(await everyStamp(c)).toEqual(await everyStamp(a));
    await expectSame(a, c, "A and C after the join");
    // what C knows of every origin but itself is what A knew at the cut: A up to the cut in every label, B per label exactly as A held it (vouched by A, not a sender)
    expect(await haveWithout(c, await nodeIdOf(c))).toEqual(await haveWithout(a, "-"));
    expect((await originsOfNode(c)).map((o) => [o.origin, o.vouched_by])).toEqual([[aId, "snapshot"], [bId, aId]].sort(([x], [y]) => (x! < y! ? -1 : 1)));
    expect((await originsOfNode(c)).find((o) => o.origin === aId)!.have).toEqual(haveOfAll(cap.summary.cut));
    expect((await originsOfNode(c)).find((o) => o.origin === bId)!.have).toEqual((await originsOfNode(a)).find((o) => o.origin === bId)!.have);
    // and a bundle from A to C right after the join carries nothing: C holds everything A holds; sending it all again stores nothing either
    const bundle = await bundleFor(a, c);
    expect(bundle.items).toEqual([]);
    expect((await resendAll(a, c)).stored, "a full re-send stores nothing").toBe(0);
    expect(await everyStamp(c)).toEqual(await everyStamp(a));
    // C can be a source in turn (it holds A's and B's writes)
    const { peer: d } = await joinFrom("d", c, world);
    expect(await everyStamp(d)).toEqual(await everyStamp(a));
  }, 900_000);

  it("P2: after the join, one more bundle from the source or from a third node stores exactly the new writes; a full re-send stores 0", async () => {
    const { world, a, b } = await hub(SEED + 20);
    await twoHeads(a, b);
    const { peer: c } = await joinFrom("c", a, world);
    // from the source: A's own writes and B's writes A took after the join
    const aBefore = await everyStamp(a), cBefore = await everyStamp(c);
    await writeFor(a, makeRng(SEED + 21), 12, { weights: MIXED });
    await writeFor(b, makeRng(SEED + 22), 12, { weights: MIXED });
    await exchange(b, a);
    const fromSource = await exchange(a, c);
    expect(fromSource.rejected).toEqual([]);
    expect(changedUnits(cBefore, await everyStamp(c))).toEqual(changedUnits(aBefore, await everyStamp(a)));
    expect(fromSource.stored).toBeGreaterThan(0);
    await expectSame(a, c, "A and C after one bundle from A");
    expect((await resendAll(a, c)).stored, "a full re-send from the source stores nothing").toBe(0);

    // from a third node: B, which C knew only as an origin A brought, is admitted by C and sends what C lacks of it (and nothing C has)
    expect(await codeOf(take(c, await bundleFor(b, c)))).toBe("bundle_unknown_sender"); // not a sender yet: B was brought by A
    await admit(c, b);
    const bId = await nodeIdOf(b);
    const row = (await originsOfNode(c)).find((o) => o.origin === bId)!;
    expect(row.vouched_by).toBe("admitted");
    expect(row.have).toEqual((await originsOfNode(a)).find((o) => o.origin === bId)!.have); // admitting kept what C holds of B
    await exchange(a, b); // B holds what A holds
    const bBefore = await everyStamp(b), cBefore2 = await everyStamp(c);
    await writeFor(b, makeRng(SEED + 23), 10, { weights: MIXED });
    const fromThird = await exchange(b, c);
    expect(fromThird.rejected).toEqual([]);
    expect(changedUnits(cBefore2, await everyStamp(c))).toEqual(changedUnits(bBefore, await everyStamp(b)));
    await expectSame(b, c, "B and C after one bundle from B");
    expect((await resendAll(b, c)).stored, "a full re-send from the third node stores nothing").toBe(0);
    expect((await resendAll(a, c)).stored).toBe(0);
  }, 900_000);

  // Review of PR #1940 (CI, seed 142069), fixed by migration 232: `updated_at` of the stamped tables other than notes is a function of the row's counting stamps, as a
  // note's is (migrations 206 and 209): the node that writes and the node that takes the write back into a row it holds hold the same value. The smallest case: B sets an
  // attribute and A takes it (a new row, made from B's values), B changes it and A takes that (a row A holds, written back); then B saves it without moving `updated_at`
  // (a write that is housekeeping: its stamp says so) and A takes that too; and A, taking everything again, changes nothing.
  /** B sets an attribute, changes it, and rewrites its type without moving updated_at; A takes each: what A refused, A's value, updated_at on both after each step. */
  async function attributeThrice() {
    const [na, nb] = [await openNode("a"), await openNode("b")];
    open.push(na, nb);
    const world = await buildSourceWorld(na);
    await fillFrom(nb, world, await capture(na, world, 1_000_000));
    const a = peerOf("A", na, world), b = peerOf("B", nb, world);
    await admit(a, b); await admit(b, a);
    const note = await onNode(b.node, async () => (await b.call("POST", "/api/nodes", { title: "Its attribute", markdown: "", space_id: b.space })).id as string);
    const row = (p: Peer) => onNode(p.node, async () => (await q<{ t: string; v: string; ty: string }>(`SELECT updated_at::text AS t, value::text AS v, value_type AS ty FROM node_attributes WHERE node_id = $1 AND key = 'status'`, [note])).rows[0]);
    const both = async () => ({ a: (await row(a))?.t, b: (await row(b))?.t });
    await onNode(b.node, () => b.call("PUT", `/api/nodes/${note}/attributes/status`, { value: "set on B" }));
    let refused = (await exchange(b, a)).rejected.length;
    const made = await both();
    await onNode(b.node, () => b.call("PUT", `/api/nodes/${note}/attributes/status`, { value: "changed on B" }));
    refused += (await exchange(b, a)).rejected.length;
    const changed = await both();
    // a statement that changes a unit (the type) and leaves updated_at as it is, as a retype does (services/attributeChange.ts retypeGoverned)
    await onNode(b.node, () => withEventTransaction(b.ws, async () => { await stampTransaction(b.ws, b.owner.id); await q(`UPDATE node_attributes SET value_type = 'number' WHERE node_id = $1 AND key = 'status'`, [note]); }));
    const retypedOnB = (await row(b))?.t;
    refused += (await exchange(b, a)).rejected.length;
    const retyped = await both();
    const typeOnA = (await row(a))?.ty;
    const again = await resendAll(b, a);
    return { refused, valueOnA: (await row(a))?.v, typeOnA, made, changed, retyped, retypedOnB, storedAgain: again.stored, afterAgain: await both() };
  }
  it("updated_at of an attribute: B sets it, changes it, rewrites it without moving updated_at; A takes each, and both hold the same updated_at after each", async () => {
    const r = await attributeThrice();
    expect(r.refused).toBe(0);
    expect(r.valueOnA).toContain("changed on B");
    expect(r.typeOnA, "the retype reached A").toBe("number");
    expect(r.made.a, "a row made from B's values").toBe(r.made.b);
    expect(r.changed.a, "a row A held, written back").toBe(r.changed.b);
    expect(r.changed.b, "B's change moved updated_at").not.toBe(r.made.b);
    expect(r.retypedOnB, "the write that left updated_at as it was left it on B").toBe(r.changed.b);
    expect(r.retyped.a, "and on A").toBe(r.changed.a);
    expect(r.storedAgain, "everything sent again stores nothing").toBe(0);
    expect(r.afterAgain, "and changes no updated_at").toEqual(r.retyped);
  }, 300_000);

  it("P3: A→B snapshot, B→C snapshot, then bundles between C and A: the same on both, a full re-send stores 0 both ways", async () => {
    const na = track(await openNode("a")), nb = track(await openNode("b")), nc = track(await openNode("c"));
    const world = await buildSourceWorld(na);
    const a = peerOf("A", na, world);
    await markWorld(a);
    await writeFor(a, makeRng(SEED + 30), 8, { weights: MIXED });
    await fillFrom(nb, world, await capture(na, world, 12_000));
    const b = peerOf("B", nb, world);
    await admit(a, b);
    await writeFor(b, makeRng(SEED + 31), 14, { weights: MIXED });
    await exchange(b, a);
    await writeFor(a, makeRng(SEED + 32), 8, { weights: MIXED });
    // C joins from B, which holds A's writes (its own source) and its own; B has not taken A's last writes
    await fillFrom(nc, world, await capture(nb, world, 12_000));
    const c = peerOf("C", nc, world);
    const [aId, bId] = [await nodeIdOf(a), await nodeIdOf(b)];
    expect((await originsOfNode(c)).map((o) => [o.origin, o.vouched_by]).sort()).toEqual([[aId, bId], [bId, "snapshot"]].sort());
    await admit(a, c);
    await admit(c, a); // A was brought by B: admitting makes it a sender and keeps what C holds of it
    expect((await originsOfNode(c)).find((o) => o.origin === aId)!.vouched_by).toBe("admitted");
    await writeFor(c, makeRng(SEED + 33), 10, { weights: MIXED });
    for (let round = 0; round < 2; round++) {
      expect((await exchange(a, c)).rejected).toEqual([]);
      expect((await exchange(c, a)).rejected).toEqual([]);
    }
    // updated_at of every row is the same too (seeds 318921, 787109, 905894 went red on it before migration 232: review of PR #1965)
    await expectSame(a, c, "A and C");
    expect((await resendAll(a, c)).stored).toBe(0);
    expect((await resendAll(c, a)).stored).toBe(0);
    // and B, which neither A nor C sent to in between, catches up from A and is the same too
    await exchange(a, b);
    await expectSame(a, b, "A and B");
  }, 900_000);

  it("P4: a source with an unfinished join, with stamps past what it says it holds of an origin, or of an origin it has no row for, refuses with a code", async () => {
    const { world, a, b } = await hub(SEED + 40);
    const bId = await nodeIdOf(b);
    // B writes an attribute, so A holds a write of B's under a label other than content_nodes whatever the seed drew (seed 896523: B's random writes were all of notes,
    // and the cut below had nothing past it to refuse)
    await onNode(b.node, async () => {
      const note = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND space_id = $2 AND deleted_at IS NULL AND node_type = 'content' ORDER BY id LIMIT 1`, [b.ws, b.space])).rows[0]!.id;
      await b.call("PUT", `/api/nodes/${note}/attributes/p4_probe`, { value: "from B" });
    });
    await exchange(b, a);
    const labelsOfB = await onNode(a.node, async () => (await q<{ t: string }>(`SELECT DISTINCT table_name AS t FROM sync_stamps WHERE workspace_id = $1 AND origin = $2`, [a.ws, bId])).rows.map((r) => r.t));
    expect(labelsOfB.some((t) => t !== "content_nodes"), "A holds a write of B's under another label (the precondition of the cut below)").toBe(true);
    const refusalOfA = () => codeOf(onNode(a.node, () => snapshotSourceNode(a.ws)));
    expect(await refusalOfA()).toBeNull();
    const row = (await originsOfNode(a)).find((o) => o.origin === bId)!;
    // the progress row a node kept before data shape 6 for a join made before migration 206 filled every label (one label only): A holds B's writes of other tables
    // past what that row says. Refused, not guessed; one bundle from B moves every label and A can be a source again
    await onNode(a.node, () => seedQ(`UPDATE sync_origins SET have = jsonb_build_object('content_nodes', (have->>'content_nodes')::bigint) WHERE workspace_id = $1 AND origin = $2`, [a.ws, bId]));
    expect(await refusalOfA()).toBe("snapshot_source_unsettled");
    expect(await codeOf(capture(a.node, world))).toBe("snapshot_source_unsettled");
    await exchange(b, a);
    expect(await refusalOfA()).toBeNull();
    // a progress row lowered below what is held (a merge whose progress was not written with it)
    await onNode(a.node, () => seedQ(`UPDATE sync_origins SET have = $3::jsonb WHERE workspace_id = $1 AND origin = $2`, [a.ws, bId, JSON.stringify(haveOfAll(0))]));
    expect(await refusalOfA()).toBe("snapshot_source_unsettled");
    // no row at all for an origin it holds stamps of
    await onNode(a.node, () => seedQ(`DELETE FROM sync_origins WHERE workspace_id = $1 AND origin = $2`, [a.ws, bId]));
    expect(await refusalOfA()).toBe("snapshot_foreign_origin");
    await onNode(a.node, () => seedQ(`INSERT INTO sync_origins (workspace_id, origin, vouched_by, have) VALUES ($1, $2, 'admitted', $3::jsonb)`, [a.ws, bId, JSON.stringify(row.have)]));
    expect(await refusalOfA()).toBeNull();
    // more other origins than a snapshot may name
    await onNode(a.node, async () => { for (let i = 0; i < 32; i++) await seedQ(`INSERT INTO sync_origins (workspace_id, origin, vouched_by, have) VALUES ($1, $2, 'admitted', $3::jsonb)`, [a.ws, crypto.randomUUID(), JSON.stringify(haveOfAll(0))]); });
    expect(await refusalOfA()).toBe("snapshot_too_many_origins");
    await onNode(a.node, () => seedQ(`DELETE FROM sync_origins WHERE workspace_id = $1 AND origin <> $2`, [a.ws, bId]));
    expect(await refusalOfA()).toBeNull();

    // a node half way through its own join is no source
    const cap = await capture(a.node, world, 12_000);
    const half = track(await openNode("half"));
    await onNode(half, async () => {
      await startJoin({ workspaceId: world.ws, sourceNode: cap.summary.source, cutSeq: cap.summary.cut, personActorId: world.owner.id, former: cap.summary.former, brought: cap.summary.brought });
      await applyJoinPage(cap.pages[0]!);
    });
    expect(cap.pages.length).toBeGreaterThan(1);
    expect(await codeOf(onNode(half, () => snapshotSourceNode(world.ws)))).toBe("snapshot_source_joining");
    await onNode(half, () => abandonJoin(world.ws));
  }, 900_000);

  // What "a source that is mid-merge" means here: a bundle is taken in ONE transaction, so the half-taken state exists only inside that transaction. A read snapshot
  // opened while it is open sees the state before it (and snapshotSourceNode does not refuse); a snapshot export started then either reads before the merge or WAITS for
  // it (the genesis pass it runs first, a write, waits on the merge's transaction when they touch the same stamp keys: seen on a real Postgres with pg_locks), never a mix.
  it("P4: a snapshot read while a bundle is being taken sees all of the merge or none of it, and the joiner then takes the merge's writes from the source", async () => {
    const { world, a, b } = await hub(SEED + 45);
    await writeFor(b, makeRng(SEED + 46), 10, { weights: MIXED });
    const bundle = await bundleFor(b, a);
    const bId = await nodeIdOf(b);
    const heldBefore = (await originsOfNode(a)).find((o) => o.origin === bId)!.have;
    const concurrent = !needsSecondConnection; // a real Postgres: the reads run on other connections while the merge's transaction is open
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let inMerge!: () => void;
    const merging = new Promise<void>((resolve) => { inMerge = resolve; });
    const heldIn = (have: Record<string, Record<string, number>>) => Object.fromEntries(Object.entries(have).map(([label, of]) => [label, of[bId]]));
    const { cap, during } = await onNode(a.node, async () => {
      const merge = withTransaction(async () => { await applyChangeBundle(a.ws, bundle); inMerge(); if (concurrent) await gate; });
      if (!concurrent) { await merge; return { cap: await capture(a.node, world, 12_000), during: null }; }
      await merging;
      // a read snapshot opened now: the source check passes, and what it says A holds of B is what A held before the merge
      const seen = await withActorReadSnapshot(world.owner, a.ws, async () => {
        await snapshotSourceNode(a.ws);
        return (await q<{ have: Record<string, number> }>(`SELECT have FROM sync_origins WHERE workspace_id = $1 AND origin = $2`, [a.ws, bId])).rows[0]!.have;
      });
      // an export started now; the merge goes on a moment later whether or not the export is waiting for it
      const reading = capture(a.node, world, 12_000);
      setTimeout(() => release(), 1_000);
      const [read] = await Promise.all([reading, merge]);
      return { cap: read, during: seen };
    });
    const heldNow = (await originsOfNode(a)).find((o) => o.origin === bId)!.have;
    expect(heldNow).not.toEqual(heldBefore);
    if (during) expect(during).toEqual(heldBefore);
    // all or nothing: what the snapshot says A holds of B is what A held before the merge, or after it, never a mix of the two
    const said = heldIn(cap.summary.brought);
    expect([heldBefore, heldNow], JSON.stringify({ said, heldBefore, heldNow })).toContainEqual(said);
    const { peer: c } = await joinFrom("c", a, world, cap);
    expect((await exchange(a, c)).rejected).toEqual([]);
    // updated_at of every row is the same too (seeds 318921, 787109, 905894 went red on it before migration 232: review of PR #1965)
    await expectSame(a, c, "A and C");
    expect((await resendAll(a, c)).stored).toBe(0);
  }, 900_000);

  it("P5: every malformed or over-cap origin list, a page that names other origins, a stamp past its origin's number and a stamp nobody vouched for are refused; the shell is as before and joins after", async () => {
    const { world, a, b } = await hub(SEED + 50);
    const cap = await capture(a.node, world, 12_000);
    const bId = await nodeIdOf(b);
    const shell = track(await openNode("shell"));
    const own = await nodeIdOf(peerOf("S", shell, world));
    const stateOf = async () => onNode(shell, async () => JSON.stringify({
      joins: (await q(`SELECT 1 FROM sync_join`)).rows.length, origins: (await q(`SELECT origin FROM sync_origins ORDER BY 1`)).rows,
      stamps: (await q(`SELECT count(*)::text AS n FROM sync_stamps`)).rows, ws: (await q(`SELECT id::text FROM workspaces ORDER BY 1`)).rows.length,
      notes: (await q(`SELECT count(*)::text AS n FROM content_nodes`)).rows,
    }));
    const before = await stateOf();
    const good = { workspaceId: world.ws, sourceNode: cap.summary.source, cutSeq: cap.summary.cut, personActorId: world.owner.id, former: cap.summary.former };
    const label = "content_nodes";
    const tooMany = { [label]: Object.fromEntries(Array.from({ length: 33 }, () => [crypto.randomUUID(), 1])) };
    const bad: [string, unknown][] = [
      ["not an object", 7], ["an array", [bId]], ["null", null], ["the form before data shape 6 (one number per origin)", { [bId]: 3 }],
      ["a label a bundle does not carry", { "content_nodes.collection_views": { [bId]: 1 } }], ["a label that is not an object", { [label]: [1] }],
      ["an origin that is not a node id", { [label]: { "admitted": 1 } }], ["genesis", { [label]: { genesis: 0 } }], ["an empty origin", { [label]: { "": 1 } }],
      ["the source itself", { [label]: { [cap.summary.source]: 1 } }],
      // ids in capitals (isUuid takes both; the database writes lower case, and ids are compared as text: review round 1, B4)
      ["the source in capitals", { [label]: { [cap.summary.source.toUpperCase()]: 1 } }], ["this node in capitals", { [label]: { [own.toUpperCase()]: 1 } }],
      ["another origin in capitals", { [label]: { [bId.toUpperCase()]: 1 } }],
      ["a negative number", { [label]: { [bId]: -1 } }], ["a fraction", { [label]: { [bId]: 1.5 } }], ["a text number", { [label]: { [bId]: "4" } }],
      ["33 origins", tooMany],
    ];
    for (const [what, brought] of bad) {
      expect(await codeOf(onNode(shell, () => startJoin({ ...good, brought: brought as Record<string, Record<string, number>> }))), what).toBe("join_bad_brought");
      expect(await stateOf(), what).toBe(before);
    }
    // this node's own id: its own refusal, nothing written (review round 1, B6)
    expect(await codeOf(onNode(shell, () => startJoin({ ...good, brought: { [label]: { [own]: 1 } } })))).toBe("join_origin_is_this_node");
    expect(await stateOf()).toBe(before);
    // a former id that the source also names as brought
    expect(await codeOf(onNode(shell, () => startJoin({ ...good, former: { [bId]: 2 }, brought: cap.summary.brought })))).toBe("join_bad_brought");
    expect(await stateOf()).toBe(before);

    /** Join with pages changed by `edit` (the hello's brought is `hello`); the code of the refusal. The refused page writes nothing (the database is as it was before that
     *  page), and the join given up leaves an empty shell again (no join, no origin: cancelJoin, as for every refused join). */
    const refusedWith = async (hello: Record<string, Record<string, number>>, edit: (page: StampedPage, at: number) => StampedPage): Promise<string | null> => {
      const pages = cap.pages.map((p, at) => edit(JSON.parse(JSON.stringify(p)) as StampedPage, at));
      const code = await codeOf(onNode(shell, async () => {
        await startJoin({ ...good, brought: hello });
        try {
          for (const page of pages) {
            const beforePage = await stateOf();
            try { await applyJoinPage(page); } catch (e) { expect(await stateOf(), "the refused page wrote nothing").toBe(beforePage); throw e; }
          }
          await finishJoin({ workspaceId: world.ws, pages: pages.length, digest: cap.summary.digest, localLogin: null });
        } catch (e) { await abandonJoin(world.ws); throw e; }
      }));
      expect(JSON.parse(await stateOf())).toMatchObject({ joins: 0, origins: [], ws: 1 });
      return code;
    };
    const lowered = JSON.parse(JSON.stringify(cap.summary.brought)) as Record<string, Record<string, number>>;
    const stamped = cap.pages.flatMap((p) => p.items).flatMap((i) => (i.kind === "row" ? i.stamps : i.kind === "tombstone" ? [i.stamp] : [])).filter((s) => s.origin === bId);
    const top = stamped.reduce((m, s) => (s.seq > m.seq ? s : m));
    lowered[top.label]![bId] = top.seq - 1;
    const without = Object.fromEntries(Object.entries(cap.summary.brought).map(([l, of]) => [l, Object.fromEntries(Object.entries(of).filter(([o]) => o !== bId))]));
    expect(cap.pages.length).toBeGreaterThan(1);
    expect(await refusedWith(cap.summary.brought, (p, at) => (at === 1 ? { ...p, brought: lowered } : p)), "a page names other origins than the first line").toBe("join_wrong_brought");
    expect(await refusedWith(lowered, (p) => ({ ...p, brought: lowered })), "a stamp past the number its origin was given for its label").toBe("join_stamp_beyond_brought");
    expect(await refusedWith(without, (p) => ({ ...p, brought: without })), "a stamp of an origin nobody vouched for").toBe("join_stamp_origin");
    expect(await refusedWith(cap.summary.brought, (p) => ({ ...p, items: p.items.map((i) => (i.kind === "row" ? { ...i, stamps: i.stamps.map((s) => (s.origin === cap.summary.source ? { ...s, seq: cap.summary.cut + 1 } : s)) } : i)) })), "a stamp of the source past its cut")
      .toBe("join_stamp_beyond_cut");
    // the same snapshot as it is is taken
    await fillFrom(shell, world, cap);
    await expectSame(a, peerOf("S", shell, world), "A and the shell");
  }, 900_000);

  it("P6: stored progress is read as it is; the form before data shape 6 is refused with its own code, never read as labels; nothing changes", async () => {
    const { a, b } = await hub(SEED + 60);
    const aId = await nodeIdOf(a);
    // what B stored of A before this batch is per label (migration 206): readHave gives it back label by label, unchanged
    const stored = (await originsOfNode(b)).find((o) => o.origin === aId)!.have;
    const have = await onNode(b.node, () => readHave(b.ws));
    for (const l of CARRIED_LABELS) expect(have[l]![aId], l).toBe(stored[l] ?? 0);
    // the old form of a request's `have` and of a bundle's header
    expect(await codeOf(onNode(a.node, () => readChangeBundle(a.owner, a.ws, { [aId]: 3 } as never)))).toBe("bundle_have_per_origin");
    const bundle = await bundleFor(a, b);
    const flat = (h: Record<string, Record<string, number>>) => Object.fromEntries([...new Set(Object.values(h).flatMap((of) => Object.keys(of)))].map((o) => [o, Math.min(...Object.values(h).map((of) => of[o] ?? 0))]));
    const before = JSON.stringify(await everyStamp(b)) + JSON.stringify(await originsOfNode(b));
    for (const field of ["base", "upTo", "holds"] as const) {
      expect(await codeOf(take(b, { ...bundle, [field]: flat(bundle[field]) as never })), field).toBe("bundle_have_per_origin");
    }
    expect(await codeOf(take(b, { ...bundle, base: { nonsense: {} } }))).toBe("bundle_bad_have");
    // a node id in capitals is not a node id (review round 1, B4): the sender, and an origin of the header
    expect(await codeOf(take(b, { ...bundle, sender: bundle.sender.toUpperCase() }))).toBe("bundle_malformed");
    expect(await codeOf(take(b, { ...bundle, upTo: withOriginAt(bundle.upTo, aId.toUpperCase(), 0) }))).toBe("bundle_malformed");
    expect(await codeOf(take(b, { ...bundle, holds: withOriginAt(bundle.holds, aId, 1.5) }))).toBe("bundle_bad_have");
    expect(JSON.stringify(await everyStamp(b)) + JSON.stringify(await originsOfNode(b))).toBe(before);
    expect((await take(b, bundle)).rejected).toEqual([]);
  }, 900_000);
});
