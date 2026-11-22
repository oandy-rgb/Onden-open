// The receive side (spine/stampedImport.ts applyChangeBundle → spine/stampedMerge/dbRows.ts, dbUnits.ts): does what guards it catch bugs?
// The three bugs review found in PR #1853 round 7 live in code that PR adds (block tables, `goWithTheirNote`, `checkReceived`); on main the same three CLASSES are
// tried here, on two nodes (helpers/stampedBundleWorld.ts, the routes write, bundles go through JSON):
//   fresh road      PLANTED: the write-back takes the "fresh" road (`storeUnit(..., fresh = true)`: nothing to clear) on a node that already holds the unit's heads.
//                   Planted through vitest's module mock of dbUnits.ts; no production code is changed. The guard that must catch it: after both nodes wrote and
//                   exchanged both ways, every exchange is taken and the two databases hold the same rows, stamps and heads (`expectSame`).
//   a head's value  PROBED on the real code (main has no check of a received value to break): a bundle whose head carries a value no write could have made.
//   a missing text  PROBED on the real code: a row item that does not carry the text of a unit whose write wins (the receiver would write NULL).
// Seeds are fresh every run and printed (STAMPED_PLANT_SEED replays). SAFETY: databases made from the migrated template; nothing shared is touched.
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const plant = vi.hoisted(() => ({ freshRoad: false }));
vi.mock("../spine/stampedMerge/dbUnits.js", async (original) => {
  const real = await original<typeof import("../spine/stampedMerge/dbUnits.js")>();
  // every argument passed on as it came (storeUnit gained `kept` with #1853; a wrapper that names them would drop the next one too); only `fresh` is replaced, and only while planted
  return { ...real, storeUnit: (...args: Parameters<typeof real.storeUnit>) => { if (plant.freshRoad) args[4] = true; return real.storeUnit(...args); } };
});

import { NODE_TITLE_MAX } from "../utils.js";
import { onNode, type RealNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, fillFrom, openNode } from "./helpers/stampedWorld.js";
import { admit, bundleFor, expectSame, exchange, makeRng, markWorld, nodeIdOf, peerOf, peerStateOf, take, writeFor, type Peer } from "./helpers/stampedBundleWorld.js";
import type { ChangeBundle } from "../spine/snapshotSql.js";
import { q } from "../db.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const BASE = Number(process.env.STAMPED_PLANT_SEED ?? randomInt(1, 2 ** 30));
console.info(`[stampedBundlePlanted] first seed ${BASE} (STAMPED_PLANT_SEED=${BASE} replays this run)`);

const open: RealNode[] = [];
afterEach(async () => { plant.freshRoad = false; for (const n of open.splice(0)) await n.close().catch(() => undefined); });
afterAll(() => console.info(`[stampedBundlePlanted] first seed ${BASE}`));

/** A holds the world and some shared notes; B joins by snapshot and A admits it (stampedBundle.integration.test.ts `cluster`, two nodes). */
async function pair(seed: number): Promise<{ a: Peer; b: Peer }> {
  const [na, nb] = [await openNode("a"), await openNode("b")];
  open.push(na, nb);
  const world = await buildSourceWorld(na);
  const a = peerOf("A", na, world);
  await markWorld(a);
  await writeFor(a, makeRng(seed), 14, { weights: { title: 0, body: 0, move: 0, reorder: 0, trash: 0, undelete: 0, purge: 0, recreate: 0 } });
  await fillFrom(nb, world, await capture(na, world, 12_000));
  const b = peerOf("B", nb, world);
  await admit(a, b);
  return { a, b };
}

/** Both write, then exchange both ways twice; what went wrong, or null. */
async function writeAndExchange(seed: number): Promise<string | null> {
  const { a, b } = await pair(seed);
  const rng = makeRng(seed + 1);
  try {
    for (let round = 0; round < 2; round++) {
      await writeFor(a, rng, 25); await writeFor(b, rng, 25);
      const ab = await exchange(a, b), ba = await exchange(b, a);
      if (ab.rejected.length || ba.rejected.length) return `round ${round}: a write was rejected`;
      await expectSame(a, b, `round ${round}`);
    }
    return null;
  } catch (e) { return String((e as { code?: string }).code ?? (e as Error).message).slice(0, 300); }
}

const refusal = async (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => ({ code: e.code ?? "no code (an uncoded error)" }));

/** A bundle from A to B in which A changed the title of one shared note and later wrote another note: the row item of the first, and the bundle. */
async function titleBundle(seed: number): Promise<{ a: Peer; b: Peer; bundle: ChangeBundle; item: Extract<ChangeBundle["items"][number], { kind: "row" }>; sender: string; note: string }> {
  const { a, b } = await pair(seed);
  const sender = await nodeIdOf(a);
  const notes = await onNode(a.node, async () => (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND node_type = 'content' AND source_type = 'manual' AND deleted_at IS NULL AND space_id = $2 ORDER BY id LIMIT 2`, [a.ws, a.space])).rows.map((r) => r.id));
  expect(notes.length).toBe(2);
  await onNode(a.node, async () => {
    await a.call("PATCH", `/api/nodes/${notes[0]}`, { title: `title by A ${seed}` });
    await a.call("PATCH", `/api/nodes/${notes[1]}`, { title: `second by A ${seed}` });
  });
  const bundle = await bundleFor(a, b);
  const item = bundle.items.find((i): i is Extract<typeof i, { kind: "row" }> => i.kind === "row" && i.table === "content_nodes" && i.stamps.some((s) => s.rowKey === notes[0] && s.field === "title" && s.origin === sender))!;
  expect(item, "the bundle carries the note A retitled").toBeTruthy();
  return { a, b, bundle, item, sender, note: notes[0]! };
}
/** A makes notes Q, P and N under Q, B takes them; then A moves N under P: the bundle from A to B, its row item of N, and the three ids. */
async function moveBundle(seed: number) {
  const { a, b } = await pair(seed);
  const [q1, p1, n1] = [randomUUID(), randomUUID(), randomUUID()];
  await onNode(a.node, async () => { for (const [id, parent] of [[q1, null], [p1, null], [n1, q1]] as const) await a.call("POST", "/api/nodes", { id, title: `probe ${seed} ${id.slice(0, 4)}`, markdown: "first", space_id: a.space, ...(parent ? { parent_id: parent } : {}) }); });
  await exchange(a, b);
  await onNode(a.node, () => a.call("PATCH", `/api/nodes/${n1}`, { parent_id: p1 }));
  const bundle = await bundleFor(a, b);
  const item = bundle.items.find((i): i is Extract<typeof i, { kind: "row" }> => i.kind === "row" && i.table === "content_nodes" && i.stamps.some((s) => s.rowKey === n1 && s.field === "parent"))!;
  expect(item, "the bundle carries the note A moved").toBeTruthy();
  return { a, b, bundle, item, ids: { q: q1, p: p1, n: n1 } };
}
const parentOn = (p: Peer, note: string) => onNode(p.node, async () => (await q<{ parent: string | null }>(`SELECT parent_id::text AS parent FROM content_nodes WHERE workspace_id = $1 AND id = $2`, [p.ws, note])).rows[0]?.parent ?? null);

/** What B holds of the note's title: the column and the other heads' values (lengths only: never a note's text in a message). */
const titleOnB = (b: Peer, note: string) => onNode(b.node, async () => ({
  column: (await q<{ t: string | null }>(`SELECT title AS t FROM content_nodes WHERE workspace_id = $1 AND id = $2`, [b.ws, note])).rows[0]?.t ?? null,
  heads: (await q<{ n: number | null }>(`SELECT length(value) AS n FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2 AND field = 'title'`, [b.ws, note])).rows.map((r) => r.n),
}));

describe.skipIf(!isTestDb)("the receive side catches a planted bug", () => {
  it("control, the real code: both nodes write, exchange both ways, and hold the same rows, stamps and heads", async () => {
    expect(await writeAndExchange(BASE)).toBeNull();
  }, 300_000);

  it("PLANTED fresh road (PR #1853 round 7, item 1): the write-back skips clearing the heads this node already holds; an exchange fails or the nodes differ", async () => {
    plant.freshRoad = true;
    const what = await writeAndExchange(BASE + 1);
    console.info(`[stampedBundlePlanted] fresh road caught after 1 seed: ${what}`);
    expect(what, "the planted fresh road went unnoticed").not.toBeNull();
  }, 300_000);
});

describe.skipIf(!isTestDb)("trust line layer 1 on the receive side (docs/decisions/sync-trust-line.md: what arrives is checked, refused whole if wrong, nothing written)", () => {
  // FINDING (real code): a head is accepted and stored whatever its value says. README "一個包說什麼": a row is sent with "every unit's value as text"; the trust line:
  // "進資料庫之前檢查格式、範圍、數量上限……不合就整份拒收". A title no write can make (longer than NODE_TITLE_MAX) rides in as a conflict and is kept and sent on.
  it.fails("FINDING: a head whose value no write could have made (a title longer than the limit) is refused whole, and nothing is written", async () => {
    const { b, bundle, item, sender, note } = await titleBundle(BASE + 2);
    const s = item.stamps.find((x) => x.field === "title" && x.origin === sender)!;
    // a write of A that this unit's winner had not seen (A wrote another note after it), that had seen what the winner had seen (an empty `saw` would read as a lost
    // creation value, rows.ts `staleCreation`), with an earlier clock: it loses and is kept as a conflict
    s.heads.push({ origin: sender, seq: bundle.upTo[s.label]![sender]!, contentHash: "", wall: s.wall - 1, counter: 0, author: s.author, device: s.device, deleted: false, saw: { ...s.saw }, meta: null, value: "x".repeat(NODE_TITLE_MAX + 1) });
    const r = await refusal(take(b, bundle));
    const held = await titleOnB(b, note);
    console.info(`[stampedBundlePlanted] a head longer than the title limit: ${r ? `refused (${r.code})` : `taken; B now holds heads of length ${JSON.stringify(held.heads)} for that title`}`);
    expect(r?.code ?? "taken, not refused").toMatch(/^bundle_/);
    expect(held.heads.some((n) => (n ?? 0) > NODE_TITLE_MAX)).toBe(false);
  }, 300_000);

  // FINDING (real code): a row item that does not carry the text of a unit whose write wins is not refused by a check of the bundle: the column is written from nothing.
  // For a column that may be empty (a note's parent) it is written as NULL and the bundle is taken: A moved the note under P, B shows it at the top, and the stamps
  // on both say A's move won, so nothing ever corrects it. (For a column that may not be empty, a title, the database refuses it with its own error, 23502, not a bundle code.)
  it.fails("FINDING: a row item missing the text of a unit it carries a winning write for is refused whole, and nothing is written", async () => {
    const { b, bundle, item, ids } = await moveBundle(BASE + 3);
    delete item.texts.parent;
    const r = await refusal(take(b, bundle));
    const parent = await parentOn(b, ids.n);
    console.info(`[stampedBundlePlanted] a row item without the text of its winning parent: ${r ? `refused (${r.code})` : `taken; on B the note is now ${parent === ids.p ? "under the new parent" : parent === ids.q ? "still under the old parent" : parent === null ? "at the top (parent NULL)" : "somewhere else"}`}`);
    expect(r?.code ?? "taken, not refused").toMatch(/^bundle_/);
    expect(parent).toBe(ids.q);
  }, 300_000);
});
