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

  // Seed 416864270 (the CI of #1937) found a difference that is pinned by hand at the end of this file ("a note purged and made again"), not by its seed: a seed of
  // writeAndExchange draws from ROW_TURNS, which is global, so what it writes depends on the tests before it, and an it.fails of it passed on ANY failure (review of
  // PR #1940, round 2, point 1).
  it("PLANTED fresh road (PR #1853 round 7, item 1): the write-back skips clearing the heads this node already holds; an exchange fails or the nodes differ", async () => {
    plant.freshRoad = true;
    const what = await writeAndExchange(BASE + 1);
    console.info(`[stampedBundlePlanted] fresh road caught after 1 seed: ${what}`);
    expect(what, "the planted fresh road went unnoticed").not.toBeNull();
  }, 300_000);
});

describe.skipIf(!isTestDb)("trust line layer 1 on the receive side (docs/decisions/sync-trust-line.md: what arrives is checked, refused whole if wrong, nothing written)", () => {
  // FINDING (#1903), kept pinned on purpose: a title longer than NODE_TITLE_MAX rides in as a conflict and is kept and sent on. The database does not hold that cap, and a
  // node may hold such a title from before the cap reached every write path (2026-10-17); a received check stricter than what an honest node holds would refuse its
  // bundles for ever (review of PR #1940, round 1, point 2). Refusing it needs the cap in the database first (clamping existing titles: the owner's decision; the
  // read-only count is in migration 221's header).
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

// Review of PR #1940, round 2, point 1: the finding of seed 416864270, by hand (the steps the seed took on that note, traced with every route call logged). A and B hold X,
// trashed; each takes it out of the trash without having seen the other's (two heads of `deleted`, on both after an exchange both ways); A trashes it again (a person's
// write: it settles both heads), purges it and makes it again under the same id; they exchange both ways, twice. Every write goes through the routes, nothing is random.
// Inference, not traced into the code: A's trash saw B's undo and settled it, the purge took X's stamps with it, and the creation's `meta.seen` names A's writes only, so
// on B nothing drops B's head; B does not send it again, A's `have` already covers it. Main and this branch, both engines.
describe.skipIf(!isTestDb)("a note purged and made again under its id on A, after A and B each undid its trash", () => {
  type Scene = { a: Peer; b: Peer; x: string; refused: string[]; conflictBefore: number; deletedHeads: { a: string[]; b: string[] } };
  /** The scene, and what each node holds of X's `deleted` unit beside its winner (origin:seq/value of each other head). Throws if a route or an exchange throws. */
  async function scene(): Promise<Scene> {
    const [na, nb] = [await openNode("a"), await openNode("b")];
    open.push(na, nb);
    const world = await buildSourceWorld(na);
    const a = peerOf("A", na, world);
    await markWorld(a);
    await fillFrom(nb, world, await capture(na, world, 12_000));
    const b = peerOf("B", nb, world);
    await admit(a, b);
    const x = randomUUID();
    const refused: string[] = [];
    const swap = async (from: Peer, to: Peer, step: string) => { const r = await exchange(from, to); if (r.rejected.length) refused.push(`${step}: ${r.rejected.length}`); };
    await onNode(a.node, () => a.call("POST", "/api/nodes", { id: x, title: "X", markdown: "first", space_id: a.space }));
    await swap(a, b, "X made");
    await onNode(a.node, () => a.call("DELETE", `/api/nodes/${x}`));
    await swap(a, b, "X trashed");
    await onNode(a.node, () => a.call("POST", `/api/nodes/${x}/undelete`));
    await onNode(b.node, () => b.call("POST", `/api/nodes/${x}/undelete`));
    await swap(a, b, "both undid"); await swap(b, a, "both undid, back");
    conflictBefore = (await deletedHeadsOf(a, x)).length;
    await onNode(a.node, async () => {
      await a.call("DELETE", `/api/nodes/${x}`);
      const preview = await a.call("GET", `/api/nodes/${x}/purge-preview`);
      await a.call("POST", `/api/nodes/${x}/purge`, { expected_ids: (preview.ids ?? preview.notes?.map((n: { id: string }) => n.id) ?? [x]) as string[] });
      await a.call("POST", "/api/nodes", { id: x, title: "X again", markdown: "again", space_id: a.space });
    });
    for (let round = 0; round < 2; round++) { await swap(a, b, `round ${round} A to B`); await swap(b, a, `round ${round} B to A`); }
    return { a, b, x, refused, conflictBefore, deletedHeads: { a: await deletedHeadsOf(a, x), b: await deletedHeadsOf(b, x) } };
  }
  let conflictBefore = 0;
  /** The other heads of X's `deleted` unit this peer holds, as origin:seq/value. */
  const deletedHeadsOf = (p: Peer, x: string) => onNode(p.node, async () => (await q<{ h: string }>(
    `SELECT origin || ':' || seq || '/' || coalesce(value, 'null') AS h FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2 AND field = 'deleted' ORDER BY 1`,
    [p.ws, x])).rows.map((r) => r.h));

  it("what the two nodes hold now (the finding, named): every exchange taken, none refused, and B keeps its undo as a head of X's `deleted` that A does not hold", async () => {
    const s = await scene();
    expect(s.refused, "an exchange was refused").toEqual([]);
    expect(s.conflictBefore, "before A trashes X again, A holds the two undos as two heads of X's deleted").toBeGreaterThan(0);
    const onlyB = s.deletedHeads.b.filter((h) => !s.deletedHeads.a.includes(h));
    console.info(`[purged and made again] deleted heads: A ${JSON.stringify(s.deletedHeads.a)}, B ${JSON.stringify(s.deletedHeads.b)}`);
    expect(onlyB.length, "B holds a head of X's deleted unit that A does not (when this is 0, the finding is fixed: turn the it.fails below into an it)").toBeGreaterThan(0);
  }, 300_000);

  it.fails("PINNED (README 接上傳輸前必須完成): after the exchanges both nodes hold the same rows, stamps and heads", async () => {
    // only the difference may make this fail: a throw of the scene or a refused exchange returns, and an it.fails that returns is red ("expected to fail")
    let s: Scene;
    try { s = await scene(); } catch { return; }
    if (s.refused.length || s.conflictBefore === 0) return;
    await expectSame(s.a, s.b, "after two rounds");
  }, 300_000);
});
