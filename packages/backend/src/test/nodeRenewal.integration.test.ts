// A database restored from a backup takes a new node id (migration 213 sync_renew_node_id, run by scripts/restore.sh through
// scripts/lib/renewNodeId.sh; docs/architecture/proposals/node-rebase-2026-11-16.md §6). The "backup" here is a copy of a node's database at one
// moment (RealNode.open(name, node): a PGlite data-dir dump), the "restore" is a fresh database loaded from that copy after the original went on
// writing: the same two facts pg_dump / psql give the server (the dump carries sync_node and sync_clock; the original numbered more writes after it).
// What is proved: the renewed database is a new origin whose numbers start at 1; nothing it holds is rewritten (stamps, other heads, the structure
// log, sync_join, other origins); its clock reads no earlier than any stamp it holds; the old id becomes an origin it holds up to the last number it
// gave; no (origin, seq) pair is handed out twice across the two lives (property over write counts); a change bundle it reads names both origins;
// what its peers see; and a database that was not restored keeps its id through boots.
// SAFETY: node databases made from the migrated template (PGlite) or databases of the test server (real Postgres), dropped after each test. The same function on this process's own database, a real
// Postgres included, is nodeRenewalOwnDatabase.integration.test.ts (its own file: on PGlite, onNode(null, …) runs on whatever handle the last node left, it does not point back to the process's own PGlite;
// on a real Postgres it does, since #1780).
import fc from "fast-check";
import type { QueryResultRow } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { migrate, q } from "../db.js";
import { readChangeBundle } from "../services/stampedBundle.js";
import { bundleOf, haveOfAll } from "../spine/stampedBundle.js";
import { localNodeId, serverIdentityField } from "../spine/stamps.js";
import { ensureOwnNodeId, forgetNodeId } from "../browser/nodeIdentity.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, exportAs, fillFrom, openNode, snapshotApp, type SourceWorld } from "./helpers/stampedWorld.js";
import { abandonJoin, applyJoinPage, startJoin } from "../services/stampedJoin.js";
import type { StampedPage } from "../spine/snapshotSql.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { admit, bundleFor, exchange, expectSame, makeRng, markWorld, peerOf, take, writeFor, type Peer } from "./helpers/stampedBundleWorld.js";
import { checkAsync } from "./helpers/propsConfig.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? ""); // both engines: a node is a PGlite, or a database of the real server (helpers/distSim/postgresNodes.ts)

type Renewal = { old_node_id: string | null; new_node_id: string; workspaces: string; origins_added: string };
type Clock = { ws: string; next_seq: string; hlc_wall: string; hlc_counter: number; writes_without_mutate: string; merge_batches: string };

const rows = <T extends QueryResultRow,>(node: RealNode, text: string, params: unknown[] = []) => onNode(node, async () => (await q<T>(text, params)).rows);
const renew = (node: RealNode) => rows<Renewal>(node, `SELECT * FROM sync_renew_node_id()`).then((r) => r[0]!);
const nodeIdOf = (node: RealNode) => onNode(node, () => localNodeId());

/** Everything a renewal must leave byte for byte as it was, and what it is allowed to change, of one database. */
async function stateOf(node: RealNode) {
  return {
    stamps: (await rows<{ r: string }>(node, `SELECT to_jsonb(s)::text AS r FROM sync_stamps s ORDER BY workspace_id, table_name, row_key, field`)).map((r) => r.r),
    heads: (await rows<{ r: string }>(node, `SELECT to_jsonb(h)::text AS r FROM sync_stamp_heads h ORDER BY workspace_id, table_name, row_key, field, origin, seq, content_hash`)).map((r) => r.r),
    structure: (await rows<{ r: string }>(node, `SELECT to_jsonb(l)::text AS r FROM structure_log l ORDER BY id`)).map((r) => r.r),
    joins: (await rows<{ r: string }>(node, `SELECT to_jsonb(j)::text AS r FROM sync_join j ORDER BY workspace_id`)).map((r) => r.r),
    origins: await rows<{ ws: string; origin: string; vouched_by: string; have: Record<string, number> }>(node, `SELECT workspace_id::text AS ws, origin, vouched_by, have FROM sync_origins ORDER BY workspace_id, origin`),
    clocks: await rows<Clock>(node, `SELECT workspace_id::text AS ws, next_seq::text, hlc_wall::text, hlc_counter, writes_without_mutate::text, merge_batches::text FROM sync_clock ORDER BY workspace_id`),
    /** per workspace, the largest clock reading of any stamp or other head */
    top: new Map((await rows<{ ws: string; w: string; k: number }>(node, `SELECT DISTINCT ON (ws) ws, w::text, k FROM (
        SELECT workspace_id::text AS ws, hlc_wall AS w, hlc_counter AS k FROM sync_stamps UNION ALL SELECT workspace_id::text, hlc_wall, hlc_counter FROM sync_stamp_heads) x
        ORDER BY ws, w DESC, k DESC`)).map((r) => [r.ws, [Number(r.w), r.k] as const])),
    events: Number((await rows<{ n: string }>(node, `SELECT COALESCE(max(id), 0)::text AS n FROM domain_events`))[0]!.n),
  };
}
const notBefore = (a: readonly [number, number], b: readonly [number, number]) => a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1]);

/** (origin, seq) of every stamp and other head that is not a genesis one, with the rest of the row, as text. */
async function pairsOf(node: RealNode): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const r of await rows<{ origin: string; seq: string; r: string }>(node, `
      SELECT origin, seq::text, to_jsonb(s)::text AS r FROM sync_stamps s WHERE origin <> 'genesis'
      UNION ALL SELECT origin, seq::text, (to_jsonb(h) - 'content_hash')::text FROM sync_stamp_heads h WHERE origin <> 'genesis'`)) {
    const key = `${r.origin}:${r.seq}`;
    out.set(key, (out.get(key) ?? new Set()).add(r.r));
  }
  return out;
}

const open: RealNode[] = [];
const track = (n: RealNode) => { open.push(n); return n; };
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); }); // a PGlite is tens of MB

/** A server A with the world and its writes; B joined A by snapshot, A admitted B, and B took A's later writes (the star: A is B's source). */
async function server(seed: number, writes: { beforeJoin: number }) {
  const na = track(await openNode("a")), nb = track(await openNode("b"));
  const world = await buildSourceWorld(na);
  const a = peerOf("A", na, world);
  await markWorld(a);
  await writeFor(a, makeRng(seed), writes.beforeJoin, { weights: { title: 0, body: 0, move: 0, reorder: 0, trash: 0, undelete: 0, purge: 0, recreate: 0 } });
  await fillFrom(nb, world, await capture(na, world, 12_000));
  const b = peerOf("B", nb, world);
  await admit(a, b);
  return { world, a, b, na, nb };
}
/** `node`'s database as it is now, in a fresh database: the backup, and later its restore. */
const copyOf = async (name: string, node: RealNode) => track(await RealNode.open(name, node));
const peerAt = (p: Peer, node: RealNode, name: string): Peer => ({ ...p, node, name });

describe.skipIf(!isTestDb)("a database restored from a backup takes a new node id", () => {
  it("a new origin numbered from 1; nothing it holds is rewritten; the clock is not behind any stamp; the old id becomes an origin it holds", async () => {
    const { a, b, na, nb } = await server(1, { beforeJoin: 10 });
    const rng = makeRng(2);
    await writeFor(a, rng, 12);
    await exchange(a, b);
    const backup = await copyOf("a-backup", na);
    await writeFor(a, rng, 15); // the server goes on after the backup: these numbers of the old id are lost by the restore
    await exchange(a, b); // and B holds them
    const lost = await stateOf(na);
    const restored = await copyOf("a-restored", backup);

    const oldId = await nodeIdOf(restored);
    expect(oldId).toBe(await nodeIdOf(na));
    const before = await stateOf(restored);
    expect(before.events).toBeLessThan(lost.events); // event ids went back with the restore: only another identity tells a client so
    const renewal = await renew(restored);
    const after = await stateOf(restored);

    expect(renewal.old_node_id).toBe(oldId);
    expect(renewal.new_node_id).not.toBe(oldId);
    expect(renewal.new_node_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await nodeIdOf(restored)).toBe(renewal.new_node_id);
    // nothing stored is rewritten: the old id's stamps stay under it, byte for byte
    expect(after.stamps).toEqual(before.stamps);
    expect(after.heads).toEqual(before.heads);
    expect(after.structure).toEqual(before.structure);
    expect(after.joins).toEqual(before.joins);
    expect(after.stamps.some((s) => JSON.parse(s).origin === oldId)).toBe(true);
    expect(after.events).toBe(before.events);
    // every clock: the new origin's numbers start at 1; the reading is not behind any stamp the database holds; the exception counters stay
    expect(Number(renewal.workspaces)).toBe(before.clocks.length);
    for (const c of after.clocks) {
      const was = before.clocks.find((x) => x.ws === c.ws)!;
      expect(c.next_seq).toBe("1");
      expect([c.writes_without_mutate, c.merge_batches]).toEqual([was.writes_without_mutate, was.merge_batches]);
      const top = after.top.get(c.ws);
      if (top) expect(notBefore([Number(c.hlc_wall), c.hlc_counter], top)).toBe(true);
      expect(notBefore([Number(c.hlc_wall), c.hlc_counter], [Number(was.hlc_wall), was.hlc_counter])).toBe(true);
    }
    // the old id is an origin this node holds, up to the last number it gave in each workspace; the other origins are as they were
    const added = before.clocks.filter((c) => Number(c.next_seq) > 1).map((c) => ({ ws: c.ws, origin: oldId, vouched_by: "self-restore", have: haveOfAll(Number(c.next_seq) - 1) }));
    expect(Number(renewal.origins_added)).toBe(added.length);
    expect(added.length).toBeGreaterThan(0);
    const key = (o: { ws: string; origin: string }) => `${o.ws} ${o.origin}`;
    expect([...after.origins].sort((x, y) => key(x).localeCompare(key(y)))).toEqual([...before.origins, ...added].sort((x, y) => key(x).localeCompare(key(y))));

    // the next write: the new origin's number 1, after every reading the database holds
    await writeFor(peerAt(a, restored, "A restored"), makeRng(3), 1, { weights: { title: 0, body: 0, move: 0, reorder: 0, trash: 0, undelete: 0, purge: 0, recreate: 0 } });
    const fresh = (await rows<{ seq: string; hlc_wall: string; hlc_counter: number; ws: string }>(restored, `SELECT seq::text, hlc_wall::text, hlc_counter, workspace_id::text AS ws FROM sync_stamps WHERE origin = $1`, [renewal.new_node_id]));
    expect(fresh.length).toBeGreaterThan(0);
    expect(new Set(fresh.map((s) => s.seq))).toEqual(new Set(["1"]));
    for (const s of fresh) expect(notBefore([Number(s.hlc_wall), s.hlc_counter], after.top.get(s.ws)!) && !(Number(s.hlc_wall) === after.top.get(s.ws)![0] && s.hlc_counter === after.top.get(s.ws)![1])).toBe(true);
    void nb;
  }, 300_000);

  it("a clock that reads earlier than a stamp it holds is moved up to that stamp's reading (from the data, not from now)", async () => {
    const { a, na } = await server(15, { beforeJoin: 3 });
    const restored = await copyOf("a-restored", await copyOf("a-backup", na));
    const top = (await stateOf(restored)).top.get(a.ws)!;
    await onNode(restored, () => q(`UPDATE sync_clock SET hlc_wall = 1, hlc_counter = 0 WHERE workspace_id = $1`, [a.ws]));
    await renew(restored);
    const c = (await stateOf(restored)).clocks.find((x) => x.ws === a.ws)!;
    expect([Number(c.hlc_wall), c.hlc_counter]).toEqual([top[0], top[1]]);
  }, 300_000);

  it("a joined node restored from its backup: its join record and its source stay as they were; its own old id becomes held", async () => {
    const { b, nb } = await server(4, { beforeJoin: 6 });
    await writeFor(b, makeRng(5), 8);
    const restored = await copyOf("b-restored", await copyOf("b-backup", nb));
    const before = await stateOf(restored);
    expect(before.joins.length).toBe(1);
    const renewal = await renew(restored);
    const after = await stateOf(restored);
    expect(after.joins).toEqual(before.joins); // sync_join names the node B was joined FROM; it is not B's id
    expect(JSON.parse(after.joins[0]!).source_node).not.toBe(renewal.old_node_id);
    expect(after.origins.filter((o) => o.vouched_by !== "self-restore")).toEqual(before.origins);
    expect(after.origins.filter((o) => o.vouched_by === "self-restore").map((o) => o.origin)).toEqual(Array(Number(renewal.origins_added)).fill(renewal.old_node_id));
  }, 300_000);

  it("no (origin, seq) pair is handed out twice across the two lives, whatever was written before the backup, after it, and after the restore (property)", async () => {
    await checkAsync(fc.asyncProperty(fc.integer({ min: 0, max: 8 }), fc.integer({ min: 1, max: 8 }), fc.integer({ min: 1, max: 8 }), fc.integer({ min: 1, max: 1000 }),
      async (beforeBackup, lostAfterBackup, afterRestore, seed) => {
        try {
          const na = track(await openNode("a"));
          const world: SourceWorld = await buildSourceWorld(na);
          const a = peerOf("A", na, world);
          await markWorld(a);
          const rng = makeRng(seed);
          await writeFor(a, rng, beforeBackup);
          const backup = await copyOf("backup", na);
          await writeFor(a, rng, lostAfterBackup);
          const restored = await copyOf("restored", backup);
          const dumped = await pairsOf(restored);
          const renewal = await renew(restored);
          // the renewal itself issues nothing and rewrites nothing
          expect(await pairsOf(restored)).toEqual(dumped);
          await writeFor(peerAt(a, restored, "A restored"), rng, afterRestore);

          // life 1 handed out the old id's numbers 1 .. next_seq - 1 of each of its workspaces (by the clock, which counts even the overwritten ones)
          const life1 = new Map((await rows<{ ws: string; n: string }>(na, `SELECT workspace_id::text AS ws, next_seq::text AS n FROM sync_clock`)).map((r) => [r.ws, Number(r.n)]));
          const issuedInLife1 = (origin: string, seq: number) => origin === renewal.old_node_id && [...life1.values()].some((n) => seq < n);
          // life 2: what the restored database holds that the backup did not
          const now = await pairsOf(restored);
          const life2 = [...now].filter(([pair, versions]) => [...versions].some((v) => !dumped.get(pair)?.has(v))).map(([pair]) => pair);
          expect(life2.length).toBeGreaterThan(0);
          const nextOfNew = Math.max(...(await rows<{ n: string }>(restored, `SELECT next_seq::text AS n FROM sync_clock`)).map((r) => Number(r.n)));
          for (const pair of life2) {
            const [origin, seqText] = [pair.slice(0, pair.lastIndexOf(":")), pair.slice(pair.lastIndexOf(":") + 1)];
            expect(origin).toBe(renewal.new_node_id);
            expect(issuedInLife1(origin, Number(seqText))).toBe(false);
            expect(Number(seqText)).toBeGreaterThanOrEqual(1);
            expect(Number(seqText)).toBeLessThan(nextOfNew);
          }
          expect(life1.size).toBeGreaterThan(0);
          expect([...(await pairsOf(na)).keys()].some((p) => p.startsWith(`${renewal.new_node_id}:`))).toBe(false);
        } finally {
          for (const n of open.splice(0)) await n.close().catch(() => undefined);
        }
      }), 4);
  }, 900_000);
});

describe.skipIf(!isTestDb)("a restored and renewed node seen by others (the change-bundle code as it is)", () => {
  it("a bundle read from the restored node names both of its origins: the old one up to the backup, the new one from 1", async () => {
    const { a, b, na } = await server(6, { beforeJoin: 8 });
    const rng = makeRng(7);
    await writeFor(a, rng, 10);
    await exchange(a, b);
    const restored = await copyOf("a-restored", await copyOf("a-backup", na));
    const oldId = await nodeIdOf(restored);
    const backupClock = new Map((await rows<{ n: string }>(restored, `SELECT next_seq::text AS n FROM sync_clock WHERE workspace_id = $1`, [a.ws])).map((r) => ["n", Number(r.n)]));
    const dumpedOld = new Set((await rows<{ r: string }>(restored, `SELECT to_jsonb(s)::text AS r FROM sync_stamps s WHERE workspace_id = $1 AND origin = $2`, [a.ws, oldId])).map((r) => r.r));
    const { new_node_id: newId } = await renew(restored);
    const ar = peerAt(a, restored, "A restored");
    await writeFor(ar, makeRng(8), 6);

    const pages = await onNode(restored, () => readChangeBundle(a.owner, a.ws, {}));
    const bundle = bundleOf(JSON.parse(JSON.stringify(pages)));
    expect(bundle.sender).toBe(newId);
    expect(bundle.upTo[oldId]).toBe(backupClock.get("n")! - 1);
    expect(bundle.upTo[newId]).toBe(Number((await rows<{ n: string }>(restored, `SELECT next_seq::text AS n FROM sync_clock WHERE workspace_id = $1`, [a.ws]))[0]!.n) - 1);
    expect(bundle.upTo[newId]).toBeGreaterThan(0);
    const stamps = bundle.items.flatMap((item) => (item.kind === "row" ? item.stamps : [item.stamp]));
    const origins = new Set(stamps.map((s) => s.origin));
    expect(origins.has(oldId) && origins.has(newId)).toBe(true);
    for (const s of stamps) {
      if (s.origin === oldId) expect(s.seq).toBeLessThanOrEqual(bundle.upTo[oldId]!);
      if (s.origin === newId) expect(s.seq).toBeGreaterThanOrEqual(1);
    }
    // the old id's stamps the bundle carries are the backup's (same number, same clock reading)
    const backupOld = [...dumpedOld].map((r) => JSON.parse(r) as { row_key: string; field: string; seq: string | number; hlc_wall: string | number; hlc_counter: number });
    for (const s of stamps.filter((x) => x.origin === oldId)) {
      const match = backupOld.find((x) => Number(x.seq) === s.seq && Number(x.hlc_wall) === s.wall && x.hlc_counter === s.counter);
      expect(match, `a stamp of the old id the backup did not hold: ${s.origin}:${s.seq}`).toBeTruthy();
    }
    void b;
  }, 300_000);

  it("before the renewal the restored node refuses to send (bundle_sender_restored); after it, the peer that joined it refuses the new id (bundle_unknown_sender: it was never admitted)", async () => {
    const { a, b, na } = await server(9, { beforeJoin: 8 });
    const rng = makeRng(10);
    await writeFor(a, rng, 6);
    await exchange(a, b);
    const backup = await copyOf("a-backup", na);
    await writeFor(a, rng, 8);
    await exchange(a, b); // B now holds numbers of A's id that the backup does not
    const restored = await copyOf("a-restored", backup);
    const ar = peerAt(a, restored, "A restored");
    const refusal = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e.code ?? String(e));
    expect(await refusal(bundleFor(ar, b))).toBe("bundle_sender_restored"); // today's detection, unchanged
    await renew(restored);
    await writeFor(ar, makeRng(11), 3);
    // the restored server is B's source; B admits by snapshot the id it was joined from, and the new id is nobody it knows.
    // The way in for it (`replaces: <old id>`, node-rebase §2 step 4) is a later batch.
    expect(await refusal(bundleFor(ar, b).then((bundle) => take(b, bundle)))).toBe("bundle_unknown_sender");
  }, 300_000);

  it("the peer's copies of the old id's writes the restore lost come back: the restored node takes them as another origin's (no bundle_own_origin_ahead)", async () => {
    const { a, b, na } = await server(12, { beforeJoin: 8 });
    const rng = makeRng(13);
    await writeFor(a, rng, 6);
    await exchange(a, b);
    const backup = await copyOf("a-backup", na);
    await writeFor(a, rng, 8);
    await exchange(a, b);
    const lastOfOld = Number((await rows<{ n: string }>(na, `SELECT next_seq::text AS n FROM sync_clock WHERE workspace_id = $1`, [a.ws]))[0]!.n) - 1;
    const restored = await copyOf("a-restored", backup);
    const oldId = await nodeIdOf(restored);
    await renew(restored);
    const ar = peerAt(a, restored, "A restored");
    const report = await take(ar, await bundleFor(b, ar));
    expect(report.rejected).toEqual([]);
    const held = (await rows<{ vouched_by: string; have: Record<string, number> }>(restored, `SELECT vouched_by, have FROM sync_origins WHERE workspace_id = $1 AND origin = $2`, [a.ws, oldId]))[0]!;
    expect(held.vouched_by).toBe("self-restore");
    expect(held.have.content_nodes).toBe(lastOfOld);
  }, 300_000);

  it("a restored and renewed server gives a new device its snapshot; the device holds both ids of the server; bundles go both ways", async () => {
    const { world, a, b, na } = await server(14, { beforeJoin: 6 });
    const rng = makeRng(15);
    await writeFor(a, rng, 6);
    await exchange(a, b);
    const backup = await copyOf("a-backup", na);
    await writeFor(a, rng, 6); // lost by the restore
    const restored = await copyOf("a-restored", backup);
    const { old_node_id: oldId, new_node_id: newId } = await renew(restored);
    const ar = peerAt(a, restored, "A restored");
    await writeFor(ar, makeRng(16), 4); // the new id's own numbers, before the device joins

    // the snapshot names the server's former id with what it holds of it (the number migration 213 wrote), and the device takes it
    const cap = await capture(restored, world);
    const heldOfOld = Number((await rows<{ n: string }>(backup, `SELECT next_seq::text AS n FROM sync_clock WHERE workspace_id = $1`, [a.ws]))[0]!.n) - 1;
    expect(cap.summary.source).toBe(newId);
    expect(cap.summary.former).toEqual({ [oldId!]: heldOfOld });
    expect(new Set(cap.pages.map((p) => JSON.stringify(p.former)))).toEqual(new Set([JSON.stringify({ [oldId!]: heldOfOld })]));
    const nc = track(await openNode("c"));
    await fillFrom(nc, world, cap);
    const c = peerOf("C", nc, world);
    // the device's origins: the server's new id it was joined from (a sender), and the old one the server brought (not a sender), each held as far as the server held it
    const origins = await rows<{ origin: string; vouched_by: string; have: Record<string, number> }>(nc, `SELECT origin, vouched_by, have FROM sync_origins WHERE workspace_id = $1 ORDER BY origin`, [a.ws]);
    expect(origins.sort((x, y) => x.origin.localeCompare(y.origin))).toEqual([
      { origin: newId, vouched_by: "snapshot", have: haveOfAll(cap.summary.cut) },
      { origin: oldId!, vouched_by: newId, have: haveOfAll(heldOfOld) },
    ].sort((x, y) => x.origin.localeCompare(y.origin)));
    expect(cap.summary.cut).toBeGreaterThan(0);
    // the old id's stamps arrived as they were on the server (each one the device holds; the snapshot carries only the rows the owner may read, so not every one)
    const oldStamps = (n: RealNode) => rows<{ r: string }>(n, `SELECT to_jsonb(s) - 'at' AS r FROM sync_stamps s WHERE workspace_id = $1 AND origin = $2 ORDER BY table_name, row_key, field`, [a.ws, oldId]).then((x) => x.map((y) => JSON.stringify(y.r)));
    const onDevice = await oldStamps(nc), onServer = new Set(await oldStamps(restored));
    expect(onDevice.length).toBeGreaterThan(0);
    for (const stamp of onDevice) expect(onServer.has(stamp), stamp).toBe(true);

    // after the join: both write, bundles go both ways, and the two end the same
    await admit(ar, c);
    await writeFor(ar, makeRng(17), 8);
    await writeFor(c, makeRng(18), 8);
    expect((await exchange(ar, c)).rejected).toEqual([]);
    expect((await exchange(c, ar)).rejected).toEqual([]);
    await expectSame(ar, c, "after the join");
    void b;
  }, 300_000);
});

describe.skipIf(!isTestDb)("the server's identity as another node or a client sees it", () => {
  it("after the renewal this node's id (spine/stamps.ts localNodeId, the one reader of sync_node a bundle's sender and #1794's server_id come from) is the new one", async () => {
    const node = track(await openNode("solo"));
    const before = await onNode(node, () => localNodeId());
    const { new_node_id } = await renew(node);
    expect(await onNode(node, () => localNodeId())).toBe(new_node_id);
    expect(new_node_id).not.toBe(before);
  }, 120_000);

  it("after the renewal (a restore, a rebase) the answers' server_id is another one, so the app starts its positions over (#1794)", async () => {
    const node = track(await openNode("identity"));
    const before = await onNode(node, () => serverIdentityField());
    await renew(node);
    const after = await onNode(node, () => serverIdentityField());
    expect(before.server_id).toBeTruthy();
    expect(after.server_id).toBeTruthy();
    expect(after.server_id).not.toBe(before.server_id);
    // The same id always gives the same value.
    expect(await onNode(node, () => serverIdentityField())).toEqual(after);
  }, 120_000);

  it("a browser copy made before migration 213: its boot's migrate() brings sync_take_node_id() first, and only then does the copy take its own id", async () => {
    const node = track(await openNode("pre-213-copy"));
    // what an older packaged database is: no migration 213, no node id
    for (const statement of [`DROP FUNCTION sync_renew_node_id()`, `DROP FUNCTION sync_take_node_id()`, `DELETE FROM schema_migrations WHERE version = '213_renew_node_id'`]) await rows(node, statement);
    await onNode(node, () => forgetNodeId());
    // the order matters: before the migration the step has nothing to call (src/browser/worker.ts calls migrate() first; guard in restoreRenewsNodeId.guard.test.ts)
    await expect(onNode(node, () => ensureOwnNodeId())).rejects.toThrow(/sync_take_node_id/);
    await onNode(node, () => migrate({ seedNativeActor: false }));
    expect((await rows<{ n: string }>(node, `SELECT count(*)::text AS n FROM schema_migrations WHERE version = '213_renew_node_id'`))[0]!.n).toBe("1");
    expect(await onNode(node, () => ensureOwnNodeId())).toBe(true);
    expect(await onNode(node, () => localNodeId())).toMatch(/^[0-9a-f-]{36}$/);
  }, 120_000);

  it("a database that was not restored keeps its id: boots (migrate) and the browser copy's first-boot step change nothing", async () => {
    const node = track(await openNode("never-restored"));
    const id = await onNode(node, () => localNodeId());
    const clocks = await rows(node, `SELECT * FROM sync_clock ORDER BY workspace_id`);
    for (let i = 0; i < 2; i++) await onNode(node, () => migrate({ seedNativeActor: false }));
    expect(await onNode(node, () => ensureOwnNodeId())).toBe(false);
    expect(await onNode(node, () => localNodeId())).toBe(id);
    expect(await rows(node, `SELECT * FROM sync_clock ORDER BY workspace_id`)).toEqual(clocks);
    expect(await rows(node, `SELECT * FROM sync_origins WHERE vouched_by = 'self-restore'`)).toEqual([]);
  }, 120_000);
});

/** A server that was restored from its backup and renewed, with a snapshot of it taken: what a new device would join from. */
async function renewedServerWithSnapshot(seed: number, options: { foreign?: boolean } = {}) {
  const { world, a, b, na } = await server(seed, { beforeJoin: 6 });
  const rng = makeRng(seed + 1);
  await writeFor(a, rng, 5);
  await exchange(a, b);
  if (options.foreign) { await writeFor(b, makeRng(seed + 2), 4); await exchange(b, a); } // A takes B's writes: a real foreign origin on A
  const backup = await copyOf("a-backup", na);
  const restored = await copyOf("a-restored", backup);
  const renewal = await renew(restored);
  const ar = peerAt(a, restored, "A restored");
  await writeFor(ar, makeRng(seed + 3), 3);
  return { world, a, b, restored, ar, oldId: renewal.old_node_id!, newId: renewal.new_node_id };
}
const codeOf = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e.code ?? String(e));
const otherId = () => crypto.randomUUID();

describe.skipIf(!isTestDb)("what a snapshot names as the former ids of its source, and what a join takes from it", () => {
  it("a former value that is not node ids with whole numbers is refused whole (join_bad_former), the source must be a node id (join_bad_source); the shell can still join after", async () => {
    const { world, restored } = await renewedServerWithSnapshot(30);
    const cap = await capture(restored, world);
    const shell = track(await openNode("shell"));
    const own = await nodeIdOf(shell);
    const good = { workspaceId: world.ws, sourceNode: cap.summary.source, cutSeq: cap.summary.cut, personActorId: world.owner.id };
    const tooMany = Object.fromEntries(Array.from({ length: 33 }, () => [otherId(), 1]));
    const bad: [string, unknown][] = [
      ["this node's own id", { [own]: 1 }], ["the source's id", { [cap.summary.source]: 1 }], ["genesis", { genesis: 1 }], ["an empty key", { "": 1 }],
      ["a word that is a vouched_by value", { admitted: 1 }], ["a negative number", { [otherId()]: -1 }], ["a fraction", { [otherId()]: 1.5 }],
      ["a string number", { [otherId()]: "1" }], ["an array", [1]], ["null", null], ["33 ids", tooMany],
    ];
    for (const [what, former] of bad) {
      expect(await codeOf(onNode(shell, () => startJoin({ ...good, former: former as Record<string, number> }))), what).toBe("join_bad_former");
      expect((await rows<{ n: string }>(shell, `SELECT count(*)::text AS n FROM sync_join`))[0]!.n, what).toBe("0");
    }
    for (const word of ["admitted", "snapshot", "self-restore", "genesis", ""]) {
      expect(await codeOf(onNode(shell, () => startJoin({ ...good, sourceNode: word, former: cap.summary.former }))), word).toBe("join_bad_source");
    }
    await fillFrom(shell, world, cap); // the same empty database joins after every refusal
    expect((await rows<{ state: string }>(shell, `SELECT state FROM sync_join`))[0]!.state).toBe("done");
  }, 300_000);

  it("a page whose former differs from the first line's is refused (join_wrong_former) and nothing of it is written", async () => {
    const { world, restored, oldId } = await renewedServerWithSnapshot(31);
    const cap = await capture(restored, world);
    const page = cap.pages[0]!;
    const variants: [string, Record<string, number>][] = [
      ["one id more", { ...page.former, [otherId()]: 1 }], ["another number", { [oldId]: page.former[oldId]! + 1 }], ["the id missing", {}],
    ];
    for (const [what, former] of variants) {
      const shell = track(await openNode(`shell-${what}`));
      await onNode(shell, () => startJoin({ workspaceId: world.ws, sourceNode: cap.summary.source, cutSeq: cap.summary.cut, personActorId: world.owner.id, former: cap.summary.former }));
      expect(await codeOf(onNode(shell, () => applyJoinPage({ ...page, former }))), what).toBe("join_wrong_former");
      expect((await rows<{ h: Record<string, string>; n: string }>(shell, `SELECT page_hashes AS h, (SELECT count(*)::text FROM content_nodes WHERE workspace_id = $1) AS n FROM sync_join`, [world.ws]))[0], what).toEqual({ h: {}, n: "0" });
      await onNode(shell, () => abandonJoin(world.ws));
    }
  }, 300_000);

  it("a stamp or head of an origin the snapshot does not name is refused (join_stamp_origin); one of a former id past what the source holds of it too (join_stamp_beyond_former)", async () => {
    const { world, restored, oldId } = await renewedServerWithSnapshot(32);
    const cap = await capture(restored, world);
    const held = cap.summary.former[oldId]!;
    const at = cap.pages.findIndex((p) => p.items.some((i) => i.kind === "row" && i.stamps.some((s) => s.origin === oldId)));
    expect(at).toBeGreaterThanOrEqual(0);
    /** The page with the first stamp of the old id changed by `change` (a copy). */
    const withOldStamp = (change: (s: Extract<StampedPage["items"][number], { kind: "row" }>["stamps"][number]) => void): StampedPage => {
      const page = JSON.parse(JSON.stringify(cap.pages[at])) as StampedPage;
      const item = page.items.find((i) => i.kind === "row" && i.stamps.some((s) => s.origin === oldId)) as Extract<StampedPage["items"][number], { kind: "row" }>;
      change(item.stamps.find((s) => s.origin === oldId)!);
      return page;
    };
    const cases: [string, StampedPage, string][] = [
      ["a stamp of an id the snapshot does not name", withOldStamp((s) => { s.origin = otherId(); }), "join_stamp_origin"],
      ["a head of an id the snapshot does not name", withOldStamp((s) => { s.heads = [...s.heads, { ...s, origin: otherId(), contentHash: "x".repeat(64), heads: undefined } as never]; }), "join_stamp_origin"],
      ["a stamp of the former id past what the source holds", withOldStamp((s) => { s.seq = held + 1; }), "join_stamp_beyond_former"],
      ["a head of the former id past what the source holds", withOldStamp((s) => { s.heads = [...s.heads, { ...s, seq: held + 5, contentHash: "y".repeat(64), heads: undefined } as never]; }), "join_stamp_beyond_former"],
    ];
    for (const [what, page, code] of cases) {
      const shell = track(await openNode(`shell-${code}`));
      await onNode(shell, () => startJoin({ workspaceId: world.ws, sourceNode: cap.summary.source, cutSeq: cap.summary.cut, personActorId: world.owner.id, former: cap.summary.former }));
      for (const before of cap.pages.slice(0, at)) await onNode(shell, () => applyJoinPage(before));
      expect(await codeOf(onNode(shell, () => applyJoinPage(page))), what).toBe(code);
      await onNode(shell, () => abandonJoin(world.ws));
    }
    // and the stamps as they are (every former stamp at or below what the source holds) are taken: the join of the previous tests
    expect(cap.pages.flatMap((p) => p.items).flatMap((i) => (i.kind === "row" ? i.stamps : i.kind === "tombstone" ? [i.stamp] : [])).filter((s) => s.origin === oldId).every((s) => s.seq <= held)).toBe(true);
  }, 300_000);

  it("through the snapshot routes (the stream: hello and pages carry former), a restored and renewed server fills an empty database that then holds both of its ids", async () => {
    const { world, restored, oldId, newId } = await renewedServerWithSnapshot(33);
    const text = await onNode(restored, async () => { const response = await exportAs(world.owner); expect(response.status).toBe(200); return response.text(); });
    const lines = text.trim().split("\n").map((l) => JSON.parse(l) as { kind: string; former?: Record<string, number>; source?: string; page?: StampedPage });
    expect(lines[0]).toMatchObject({ kind: "hello", source: newId });
    expect(Object.keys(lines[0]!.former!)).toEqual([oldId]);
    expect(lines.filter((l) => l.kind === "page").every((l) => JSON.stringify(l.page!.former) === JSON.stringify(lines[0]!.former))).toBe(true);
    const dst = track(await openNode("stream-receiver"));
    const local = await onNode(dst, async () => {
      const ws = (await q<{ id: string }>(`SELECT id::text FROM workspaces WHERE slug = 'default'`)).rows[0]!.id;
      const actor = await persistActor(ws, { id: "", name: "Local", role: "admin", type: "human" });
      await seedQ(`UPDATE actors SET external_id = 'login-of-local' WHERE id = $1`, [actor.id]);
      return actor;
    });
    const ok = await onNode(dst, async () => snapshotApp(local).request("/api/snapshot", { method: "POST", body: text }));
    expect(ok.status).toBe(200);
    const origins = await rows<{ origin: string; vouched_by: string; have: Record<string, number> }>(dst, `SELECT origin, vouched_by, have FROM sync_origins WHERE workspace_id = $1 ORDER BY vouched_by = 'snapshot' DESC`, [world.ws]);
    expect(origins.map((o) => [o.origin, o.vouched_by])).toEqual([[newId, "snapshot"], [oldId, newId]]);
    expect(origins[1]!.have).toEqual(haveOfAll(lines[0]!.former![oldId]!));
  }, 300_000);

  it("a renewed server that also holds a real foreign origin still cannot give a snapshot (snapshot_foreign_origin); a device that joined from a renewed server cannot either", async () => {
    const withForeign = await renewedServerWithSnapshot(34, { foreign: true });
    expect(await codeOf(capture(withForeign.restored, withForeign.world))).toBe("snapshot_foreign_origin");
    const { world, restored } = await renewedServerWithSnapshot(35);
    const device = track(await openNode("joined-device"));
    await fillFrom(device, world, await capture(restored, world));
    // its rows of the server's ids are vouched by the server ('snapshot', the server's new id), never 'self-restore': they are not this device's own
    expect((await rows<{ n: string }>(device, `SELECT count(*)::text AS n FROM sync_origins WHERE vouched_by = 'self-restore'`))[0]!.n).toBe("0");
    expect(await codeOf(capture(device, world))).toBe("snapshot_foreign_origin");
  }, 300_000);

  it("a server restored twice names both former ids; a new device joins from it, and after bundles both ways the two are the same", async () => {
    const { world, a, na } = await server(36, { beforeJoin: 6 });
    await writeFor(a, makeRng(37), 4);
    const first = await copyOf("a-restored-1", await copyOf("a-backup-1", na));
    const r1 = await renew(first);
    await writeFor(peerAt(a, first, "A once"), makeRng(38), 4);
    const backup2 = await copyOf("a-backup-2", first);
    await writeFor(peerAt(a, first, "A once"), makeRng(39), 3); // lost by the second restore
    const second = await copyOf("a-restored-2", backup2);
    const r2 = await renew(second);
    expect(r2.old_node_id).toBe(r1.new_node_id);
    const ar = peerAt(a, second, "A twice");
    await writeFor(ar, makeRng(40), 3);
    const cap = await capture(second, world);
    expect(Object.keys(cap.summary.former).sort()).toEqual([r1.old_node_id!, r1.new_node_id].sort());
    const nc = track(await openNode("c"));
    await fillFrom(nc, world, cap);
    const c = peerOf("C", nc, world);
    expect((await rows<{ origin: string; vouched_by: string }>(nc, `SELECT origin, vouched_by FROM sync_origins WHERE workspace_id = $1 ORDER BY origin`, [a.ws])).map((o) => o.vouched_by).sort())
      .toEqual(["snapshot", r2.new_node_id, r2.new_node_id].sort());
    await admit(ar, c);
    await writeFor(ar, makeRng(41), 6);
    await writeFor(c, makeRng(42), 6);
    expect((await exchange(ar, c)).rejected).toEqual([]);
    expect((await exchange(c, ar)).rejected).toEqual([]);
    await expectSame(ar, c, "after the join");
  }, 300_000);

  it("a change bundle names its sender and every origin by a node id: a word (what sync_origins.vouched_by holds) is bundle_malformed, before anything is looked up", async () => {
    const { a, b } = await server(44, { beforeJoin: 4 });
    await writeFor(a, makeRng(45), 4);
    const bundle = await bundleFor(a, b);
    for (const word of ["admitted", "snapshot", "self-restore"]) {
      expect(await codeOf(take(b, { ...bundle, sender: word, upTo: { ...bundle.upTo, [word]: 0 } })), `sender ${word}`).toBe("bundle_malformed");
      expect(await codeOf(take(b, { ...bundle, upTo: { ...bundle.upTo, [word]: 1 } })), `origin ${word} in upTo`).toBe("bundle_malformed");
      expect(await codeOf(take(b, { ...bundle, base: { ...bundle.base, [word]: 0 } })), `origin ${word} in base`).toBe("bundle_malformed");
    }
    expect((await take(b, bundle)).rejected).toEqual([]); // the bundle as it is is taken
  }, 300_000);

  it("the empty database's own sync_origins rows (a shell that was restored and renewed, or that admitted a node) go with its workspace when the join begins", async () => {
    const { world, restored, oldId, newId } = await renewedServerWithSnapshot(43);
    const cap = await capture(restored, world);
    const shell = track(await openNode("shell-with-origins"));
    const shellWs = (await rows<{ id: string }>(shell, `SELECT id::text FROM workspaces WHERE slug = 'default'`))[0]!.id;
    // copies of one packaged database (and these test nodes) share the workspace id: the shell's rows are keyed by the snapshot's workspace
    expect(shellWs).toBe(world.ws);
    const admitted = otherId();
    // the worst case of ON CONFLICT DO NOTHING: the shell already says the source's former id is ITS OWN former id
    await onNode(shell, () => seedQ(`INSERT INTO sync_origins (workspace_id, origin, vouched_by, have) VALUES ($1, $2, 'self-restore', '{}'::jsonb), ($1, $3, 'admitted', '{}'::jsonb)`, [shellWs, oldId, admitted]));
    await fillFrom(shell, world, cap);
    const after = await rows<{ origin: string; vouched_by: string }>(shell, `SELECT origin, vouched_by FROM sync_origins WHERE workspace_id = $1 ORDER BY origin`, [world.ws]);
    expect(after.sort((x, y) => x.origin.localeCompare(y.origin))).toEqual([{ origin: newId, vouched_by: "snapshot" }, { origin: oldId, vouched_by: newId }].sort((x, y) => x.origin.localeCompare(y.origin)));
  }, 300_000);
});
