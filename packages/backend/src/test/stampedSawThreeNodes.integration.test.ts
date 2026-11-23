// `saw` worked out from a column a foreign key emptied (proposal own-node-transport-2026-11-22 §4.2 item 14; README "接上傳輸前必須完成"): a review's worry, with no
// counterexample found in PR #1853. Here three nodes write at random (notes made under others, moved, trashed, deleted for good while another node writes under them,
// made again, and the other tables), exchange in random pairs, and settle. The property on every node: the same stamps with the same `saw` (a local write on an emptied
// column computes its `saw` from what the node holds: the kept id on the stamp, not the empty column), the same heads with theirs, one more round stores nothing, a full
// resend stores nothing and nothing is refused. A fresh seed each run (ONDEN_SAW_SEED replays one); a red from a new seed is a finding, not a flake.
// Excluded on purpose: the content of a column a re-made row's id names (item 11, pinned in anchorsReplicated "round 10, 4"): the stamps compared here agree there.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { q } from "../db.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { ALL_TABLES, bundleFor, nodeIdOf, take, exchange, makeRng, peerStateOf, resendAll, resetRowTurns, threePeers, writeAsOwner, writeFor, type Peer } from "./helpers/stampedBundleWorld.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

const BASE = Number(process.env.ONDEN_SAW_SEED ?? Date.now() % 1_000_000);
// the generator's row kinds take turns per peer NAME across tests (helpers/stampedBundleWorld.ts ROW_TURNS): forgotten before each test, so a seed draws the
// same writes whatever ran before it in this file and a red replays alone (seeds 548460 and 617287 went red after other tests and green alone before this)
beforeEach(() => resetRowTurns());
/** Every carried stamp and head of the workspace the owner's scope holds, with its saw and meta, byte for byte (stampedBundleWorld peerStateOf: the rows of spaces the
 *  owner is not a member of never travel). Kept values and the columns are not compared (item 11). */
const sawsOf = async (p: Peer) => { const st = await peerStateOf(p); return [JSON.stringify(st.stamps), JSON.stringify(st.heads)]; };

/** A note the generator made that both `x` and `y` hold alive: `y` makes a child under it and `x` deletes it for good (the product's way), before they exchange. When the
 *  delete reaches `y`, the foreign key empties the child's parent (its id kept on the stamp); later moves of the child write over that emptied column. */
async function orphanOne(x: Peer, y: Peer, rng: ReturnType<typeof makeRng>): Promise<boolean> {
  const liveOn = (p: Peer) => onNode(p.node, async () => (await q<{ id: string }>(
    `SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND deleted_at IS NULL AND node_type = 'content' AND title ~ '^[ABC] (title )?[0-9]+$' ORDER BY id`, [p.ws])).rows.map((r) => r.id));
  const onY = new Set(await liveOn(y));
  // only a note `x` can delete for good once it is in the trash: trashing takes the note's LIVE subtree and stops at a note already in the trash, and a live
  // note under one (what an exchange can leave: 4.9, a delete and a move made apart) is still live afterwards, so the purge rightly refuses (live_descendant)
  // and the step would not be the one this helper says it takes (seed 980034 of base 980033 picked such a note: B 3 > A 1 in the trash > A title 10 live)
  const purgeable = (id: string) => onNode(x.node, async () => (await q(
    `WITH RECURSIVE t AS (SELECT id, deleted_at IS NOT NULL AS under_trash FROM content_nodes WHERE parent_id = $1
       UNION ALL SELECT c.id, t.under_trash OR c.deleted_at IS NOT NULL FROM content_nodes c JOIN t ON c.parent_id = t.id)
     SELECT 1 FROM t JOIN content_nodes n ON n.id = t.id WHERE t.under_trash AND n.deleted_at IS NULL LIMIT 1`, [id])).rows.length === 0);
  const both: string[] = [];
  for (const id of await liveOn(x)) if (onY.has(id) && await purgeable(id)) both.push(id);
  if (!both.length) return false;
  const p = rng.pick(both);
  await onNode(y.node, () => y.call("POST", "/api/nodes", { title: `${y.name} orphan ${rng.int(1_000_000)}`, markdown: "made under a note the other node deletes", space_id: y.space, parent_id: p }));
  await onNode(x.node, async () => {
    await x.call("DELETE", `/api/nodes/${p}`);
    const plan = (await x.call("GET", `/api/nodes/${p}/purge-preview`)) as { ids: string[] };
    await x.call("POST", `/api/nodes/${p}/purge`, { expected_ids: plan.ids });
  });
  return true;
}

// Review of PR #1940, round 1, point 6: the relay the random test found (seed 902), written out. A's fifth write is to a row outside the owner's scope (a note of a space
// only the friend is in), so A's bundle to B WITHHOLDS it (I5) and B's `have` of A stops at A's fourth; A's sixth write still reaches B. B then sends to C: its bundle
// carries A's sixth, above what B holds of A without a gap. Before, `holds` was that `have`, and C refused the bundle (bundle_stamp_beyond_cut), every time.
describe.skipIf(!isTestDb)("a write relayed past a withheld one", () => {
  it("A withholds its fifth write from B, B relays A's sixth to C: C takes it; B's have of A stays before the withheld write; one more round stores nothing", async () => {
    const peers = await threePeers(open);
    const [a, b, c] = peers;
    const notes = await onNode(a!.node, async () => (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND space_id = $2 AND deleted_at IS NULL AND node_type = 'content' ORDER BY id LIMIT 2`, [a!.ws, a!.space])).rows.map((r) => r.id));
    const stamped = (sql: string, params: unknown[]) => onNode(a!.node, () => writeAsOwner(a!, sql, params));
    const seqOf = () => onNode(a!.node, async () => Number((await q<{ n: string }>(`SELECT (next_seq - 1)::text AS n FROM sync_clock WHERE workspace_id = $1`, [a!.ws])).rows[0]!.n));
    for (let k = 1; k <= 4; k++) await stamped(`UPDATE content_nodes SET title = $2 WHERE id = $1`, [notes[k % 2], `A write ${k}`]);
    const fourth = await seqOf();
    await stamped(`UPDATE content_nodes SET title = 'A write 5, out of the owner''s scope' WHERE id = $1`, [peers.secretNote]);
    await stamped(`UPDATE content_nodes SET title = 'A write 6' WHERE id = $1`, [notes[0]]);
    const sixth = await seqOf();
    const toB = await bundleFor(a!, b!);
    expect(toB.upTo.content_nodes?.[await nodeIdOf(a!)], "B's have of A stops before the withheld write").toBe(fourth);
    await take(b!, toB);
    const toC = await bundleFor(b!, c!);
    expect(toC.holds.content_nodes?.[await nodeIdOf(a!)], "B holds A's sixth, and says so").toBe(sixth);
    await take(c!, toC); // before: bundle_stamp_beyond_cut
    const titleOn = (p: Peer) => onNode(p.node, async () => (await q<{ t: string }>(`SELECT title AS t FROM content_nodes WHERE id = $1`, [notes[0]])).rows[0]!.t);
    expect(await titleOn(c!)).toBe("A write 6");
    const again = await exchange(b!, c!);
    expect({ stored: again.stored, created: again.created, removed: again.removed }).toEqual({ stored: 0, created: 0, removed: 0 });
  }, 600_000);
});

describe.skipIf(!isTestDb)("saw on three nodes that write at random, emptied columns included", () => {
  // three fresh seeds, and 902 of base 900: the first that found a relayed write past a withheld one refused for ever (bundle_stamp_beyond_cut, fixed in this batch)
  for (const seed of [BASE, BASE + 1, BASE + 2, 902]) {
    it(`seed ${seed} (replay: ONDEN_SAW_SEED=${BASE}): the same stamps and heads with the same saw on all three; one more round and a full resend store nothing`, async () => {
      const peers = await threePeers(open);
      const rng = makeRng(seed);
      // purges and children made under notes another node deletes for good are what empty a column; moves after that write on the emptied column
      const weights = { ...ALL_TABLES, create: 18, move: 16, purge: 10, recreate: 4, trash: 6, undelete: 3 };
      for (let round = 0; round < 5; round++) {
        for (const p of peers) await writeFor(p, rng, 6, { weights });
        { const x = rng.pick(peers); await orphanOne(x, rng.pick(peers.filter((p) => p !== x)), rng); }
        for (let e = 0; e < 3; e++) {
          const x = rng.pick(peers), y = rng.pick(peers.filter((p) => p !== x));
          await exchange(x, y);
        }
      }
      // settle: every pair, both ways, until nothing moves
      for (let r = 0; r < 3; r++) for (const x of peers) for (const y of peers) if (x !== y) await exchange(x, y);
      // how many units hold an id a foreign key emptied (kept on the stamp), and how many local writes were made over such a unit: printed, so a run shows it tried
      const kept = await Promise.all(peers.map((p) => onNode(p.node, async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM sync_stamps WHERE workspace_id = $1 AND kept_value ? 'text'`, [p.ws])).rows[0]!.n))));
      console.log(`[saw] seed ${seed}: units keeping an emptied id on A, B, C: ${kept.join(", ")}`);
      const saws = await Promise.all(peers.map(sawsOf));
      expect(saws[1], `seed ${seed}: B against A`).toEqual(saws[0]);
      expect(saws[2], `seed ${seed}: C against A`).toEqual(saws[0]);
      for (const x of peers) for (const y of peers) if (x !== y) {
        const again = await exchange(x, y);
        expect({ stored: again.stored, created: again.created, removed: again.removed }, `seed ${seed}: ${x.name} to ${y.name}, one more round`).toEqual({ stored: 0, created: 0, removed: 0 });
        const before = await sawsOf(y);
        const all = await resendAll(x, y);
        expect({ created: all.created, removed: all.removed }, `seed ${seed}: ${x.name} to ${y.name}, everything again`).toEqual({ created: 0, removed: 0 });
        expect(await sawsOf(y), `seed ${seed}: ${x.name} to ${y.name}, everything again`).toEqual(before);
      }
    }, 900_000);
  }
});
