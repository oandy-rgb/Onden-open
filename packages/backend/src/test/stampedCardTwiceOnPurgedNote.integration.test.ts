// The red of stampedSawThreeNodes with ONDEN_SAW_SEED=924487 ("B against A: expected [...] to deeply equal [...]"), written out with no randomness and nothing drawn
// from other tests. A card's place on a board (`node_positions`, key: note + surface) is a row two nodes can make on their own under the same key. B and C each place
// note N's card while A has already deleted N for good. A never holds the row; B and C lose it when A's purge reaches them (the cascade, and the delete trigger clears the
// row's field units). Before the fix A stored a stamp and a head, without values, for every field of the two creations (it could not see that two of the three creation
// values are equal), and B and C stored none: three units no exchange sent again. The rule now (README 「沒有那一列的欄位跟著 `*`」, dbRows.ts `dropFieldUnits`): a row
// that is not on a node keeps only its `*` of its own table there, whichever way it came to be missing.
import { afterEach, describe, expect, it } from "vitest";
import { q } from "../db.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { admit, exchange, nodeIdOf, peerOf, peerStateOf, resendAll, threePeers, writeAsOwner, type Peer } from "./helpers/stampedBundleWorld.js";
import { capture, fillFrom, openNode } from "./helpers/stampedWorld.js";
import { setModulesOn } from "./helpers/setModulesOn.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

const BOARD = "scale-board";
/** The stamps and other heads of N's card, unit by unit (`field: origin-name seq saw [value]`), with the node ids replaced by the peers' names. */
async function cardUnits(p: Peer, note: string, names: Map<string, string>): Promise<string[]> {
  const st = await peerStateOf(p);
  const row = `${note}/${BOARD}`;
  const name = (o: unknown) => names.get(String(o)) ?? String(o);
  const saw = (s: unknown) => JSON.stringify(Object.fromEntries(Object.entries((s ?? {}) as Record<string, number>).map(([o, n]) => [name(o), n])));
  const mine = (r: Record<string, unknown>) => r.table_name === "node_positions" && r.row_key === row;
  return [
    ...(st.stamps as Record<string, unknown>[]).filter(mine).map((s) => `${String(s.field)}: stamp ${name(s.origin)} saw ${saw(s.saw)}`),
    ...(st.heads as Record<string, unknown>[]).filter(mine).map((h) => `${String(h.field)}: head ${name(h.origin)} saw ${saw(h.saw)} value ${String(h.value)}`),
  ].sort();
}
const cardRow = (p: Peer, note: string) => onNode(p.node, async () => (await q<{ x: number; y: number }>(`SELECT x, y FROM node_positions WHERE node_id = $1 AND surface = $2`, [note, BOARD])).rows);

/** The scenario, step by step: the purge reaching B and C after the cards are placed but before they meet (`purgeFirst`, control 2) or not, and C placing its card or not (`onlyB`, control 1). */
async function placeTwiceOnPurged(o: { purgeFirst?: boolean; onlyB?: boolean } = {}): Promise<{ a: Peer; b: Peer; c: Peer; note: string; names: Map<string, string> }> {
  const [a, b, c] = await threePeers(open);
  const names = new Map<string, string>();
  for (const p of [a!, b!, c!]) names.set(await nodeIdOf(p), p.name);
  // 1. A makes note N; B and C get it
  const note = String((await onNode(a!.node, () => a!.call("POST", "/api/nodes", { title: "N", markdown: "a note", space_id: a!.space }))).id);
  await exchange(a!, b!); await exchange(a!, c!);
  // 2. A deletes N for good (trash, then purge), and has not sent it yet
  await onNode(a!.node, async () => {
    await a!.call("DELETE", `/api/nodes/${note}`);
    const plan = (await a!.call("GET", `/api/nodes/${note}/purge-preview`)) as { ids: string[] };
    await a!.call("POST", `/api/nodes/${note}/purge`, { expected_ids: plan.ids });
  });
  // 3. B and C, apart, each place N's card on the board (the same row key, different places)
  await onNode(b!.node, () => writeAsOwner(b!, `INSERT INTO node_positions (node_id, surface, x, y, workspace_id) VALUES ($1, $2, 408, 86, $3)`, [note, BOARD, b!.ws]));
  if (!o.onlyB) await onNode(c!.node, () => writeAsOwner(c!, `INSERT INTO node_positions (node_id, surface, x, y, workspace_id) VALUES ($1, $2, 10, 20, $3)`, [note, BOARD, c!.ws]));
  // (control 2: A's purge reaches B and C, taking their cards, before the cards meet anywhere)
  if (o.purgeFirst) { await exchange(a!, b!); await exchange(a!, c!); }
  return { a: a!, b: b!, c: c!, note, names };
}
/** The exchanges of seed 924487 for this unit, then every pair both ways until nothing moves. */
async function exchangeToTheEnd(a: Peer, b: Peer, c: Peer): Promise<void> {
  // 4. the two cards meet on C; A gets B's, then C's (both stamps only: A has no N); B gets C's
  await exchange(b, c); await exchange(b, a); await exchange(c, a); await exchange(c, b);
  // 5. A's purge reaches B and C (the card's row goes with N there)
  await exchange(a, b); await exchange(a, c);
  // 6. settle
  await settle(a, b, c);
}

/** Every pair, both ways, three times. */
async function settle(a: Peer, b: Peer, c: Peer): Promise<void> {
  for (let r = 0; r < 3; r++) for (const x of [a, b, c]) for (const y of [a, b, c]) if (x !== y) await exchange(x, y);
}
/** The card's units on A, B and C: the same on all three, nothing but the row's `*` (no node holds the row), and no node holds the card. */
async function expectOnlyTheStar(a: Peer, b: Peer, c: Peer, note: string, names: Map<string, string>): Promise<string[]> {
  for (const p of [a, b, c]) expect(await cardRow(p, note), `${p.name} holds no card of N`).toEqual([]);
  const [ua, ub, uc] = [await cardUnits(a, note, names), await cardUnits(b, note, names), await cardUnits(c, note, names)];
  expect(ub, "B against A").toEqual(ua);
  expect(uc, "C against A").toEqual(ua);
  expect(ua.length, "the row's own unit is there").toBeGreaterThan(0);
  expect(ua.filter((u) => !u.startsWith("*")), "nothing but the row's own unit").toEqual([]);
  return ua;
}

describe.skipIf(!isTestDb)("a card two nodes placed on their own, on a note a third deleted for good", () => {
  it("after every pair has exchanged both ways: A, B and C hold the same stamps and heads of the card, only its `*`", async () => {
    const { a, b, c, note, names } = await placeTwiceOnPurged();
    await exchangeToTheEnd(a, b, c);
    await expectOnlyTheStar(a, b, c, note, names);
  }, 600_000);

  // the three controls of PR #1963 (each was the same on all three before the fix too, except the third)
  it("control 1: only B places the card: the same on all three, only its `*`", async () => {
    const { a, b, c, note, names } = await placeTwiceOnPurged({ onlyB: true });
    await settle(a, b, c);
    await expectOnlyTheStar(a, b, c, note, names);
  }, 600_000);

  it("control 2: the purge reaches B and C first (each loses its card), the cards meet after: the same on all three, only its `*`", async () => {
    const { a, b, c, note, names } = await placeTwiceOnPurged({ purgeFirst: true });
    await settle(a, b, c);
    await expectOnlyTheStar(a, b, c, note, names);
  }, 600_000);

  it("control 3: B and C exchange first, then each sends to A: A keeps no field unit at once, and all three end the same", async () => {
    const { a, b, c, note, names } = await placeTwiceOnPurged();
    await exchange(b, c); await exchange(c, b); await exchange(b, a); await exchange(c, a);
    expect((await cardUnits(a, note, names)).filter((u) => !u.startsWith("*")), "A, as soon as the cards reach it").toEqual([]);
    await settle(a, b, c);
    await expectOnlyTheStar(a, b, c, note, names);
  }, 600_000);

  // A node that stored the card the way the rule before this fix did (a stamp and a valueless head for each field) is not reached by an ordinary exchange (those
  // stamps are below everyone's `have`): one full resend to it from a node that holds the row's `*` takes them away, and nothing else changes.
  it("a node holding the old shape (three field units) is the same as the others after one full resend to it; an ordinary exchange leaves it", async () => {
    const { a, b, c, note, names } = await placeTwiceOnPurged();
    await exchangeToTheEnd(a, b, c);
    const now = await expectOnlyTheStar(a, b, c, note, names);
    const row = `${note}/${BOARD}`;
    await onNode(a.node, async () => {
      for (const f of ["position", "look", "sub_canvas"]) {
        await q(`INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted, saw, meta, kept_value)
          SELECT workspace_id, table_name, row_key, $3, origin, seq, hlc_wall, hlc_counter, author, device, false, '{}'::jsonb, NULL, '{"none": true}'::jsonb FROM sync_stamps
          WHERE workspace_id = $1 AND table_name = 'node_positions' AND row_key = $2 AND field = '*'`, [a.ws, row, f]);
        await q(`INSERT INTO sync_stamp_heads (workspace_id, table_name, row_key, field, origin, seq, content_hash, hlc_wall, hlc_counter, author, device, deleted, saw, meta, value, valueless)
          SELECT workspace_id, table_name, row_key, $3, origin, seq, '', hlc_wall, hlc_counter, author, device, false, '{}'::jsonb, NULL, NULL, true FROM sync_stamp_heads
          WHERE workspace_id = $1 AND table_name = 'node_positions' AND row_key = $2 AND field = '*'`, [a.ws, row, f]);
      }
    });
    expect((await cardUnits(a, note, names)).filter((u) => !u.startsWith("*")), "the old shape, planted on A").toHaveLength(6);
    await settle(a, b, c);
    expect((await cardUnits(a, note, names)).filter((u) => !u.startsWith("*")), "an ordinary exchange does not reach it").toHaveLength(6);
    await resendAll(b, a);
    expect(await expectOnlyTheStar(a, b, c, note, names), "after one full resend B to A").toEqual(now);
  }, 600_000);

  // Review of PR #1965, round 1, point 1: the premise of the rule ("a row not on a node is gone for good") does not hold when the note comes back under its id (a day's
  // note has an id worked out from its day). A deletes D for good; C takes the delete and opens the same day again (D under the same id); B, offline all along, places
  // D's card and moves it. B's writes reach A while A has no D (A keeps only the card's `*`); C's new D reaches B as a creation that wins over B's D, so B's D is
  // overwritten, not removed, and B keeps its card. When D reaches A, nothing makes the card there: its writes are below A's `have` and no exchange sends them again.
  // C takes the card from A, as stamps without values (A does not hold it), before B could send it whole, and is where A is. So A and C hold D without the card, B
  // with it (the VALUES differed before this fix too; now the card's field unit does as well). Pinned (README
  // 「接上傳輸前必須完成」): the direction is round 10, 4's, a row that is made later fills in what hangs on it.
  async function dayMadeAgain(): Promise<{ a: Peer; b: Peer; c: Peer; note: string; names: Map<string, string> }> {
    const [a, b, c] = await threePeers(open);
    const names = new Map<string, string>();
    for (const p of [a!, b!, c!]) names.set(await nodeIdOf(p), p.name);
    const note = "d1d1d1d1-0000-4d1d-8d1d-d1d1d1d1d1d1";
    await onNode(a!.node, () => a!.call("POST", "/api/nodes", { id: note, title: "A day", markdown: "the day", space_id: a!.space }));
    await exchange(a!, b!); await exchange(a!, c!);
    await onNode(a!.node, async () => {
      await a!.call("DELETE", `/api/nodes/${note}`);
      const plan = (await a!.call("GET", `/api/nodes/${note}/purge-preview`)) as { ids: string[] };
      await a!.call("POST", `/api/nodes/${note}/purge`, { expected_ids: plan.ids });
    });
    await exchange(a!, c!);
    await onNode(c!.node, () => c!.call("POST", "/api/nodes", { id: note, title: "The same day again", markdown: "again", space_id: c!.space }));
    await onNode(b!.node, () => writeAsOwner(b!, `INSERT INTO node_positions (node_id, surface, x, y, workspace_id) VALUES ($1, $2, 408, 86, $3)`, [note, BOARD, b!.ws]));
    await onNode(b!.node, () => writeAsOwner(b!, `UPDATE node_positions SET x = 500, y = 90 WHERE node_id = $1 AND surface = $2`, [note, BOARD]));
    await exchange(b!, a!); await exchange(c!, b!); await exchange(c!, a!);
    await settle(a!, b!, c!);
    return { a: a!, b: b!, c: c!, note, names };
  }
  const heldNote = (p: Peer, note: string) => onNode(p.node, async () => (await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [note])).rows.length);

  it("a day's note made again under its id: what differs today (A and C hold D without the card, B with it and its field unit)", async () => {
    const { a, b, c, note, names } = await dayMadeAgain();
    for (const p of [a, b, c]) expect(await heldNote(p, note), `${p.name} holds D`).toBe(1);
    for (const p of [a, c]) {
      expect(await cardRow(p, note), `${p.name}: no card`).toEqual([]);
      expect(await cardUnits(p, note, names), `${p.name}: only the card's \`*\``).toEqual(["*: stamp B saw {}"]);
    }
    expect(await cardRow(b, note), "B: the card where it moved it").toEqual([{ x: 500, y: 90 }]);
    expect(await cardUnits(b, note, names), "B: the card's `*` and its moved field").toEqual(["*: stamp B saw {}", `position: stamp B saw {"B":2}`]);
  }, 600_000);

  it.fails("a day's note made again under its id: A, B and C hold the same card, with the same units", async () => {
    const { a, b, c, note, names } = await dayMadeAgain();
    expect(await cardRow(a, note)).toEqual(await cardRow(b, note));
    expect(await cardUnits(a, note, names)).toEqual(await cardUnits(b, note, names));
    expect(await cardUnits(c, note, names)).toEqual(await cardUnits(b, note, names));
  }, 600_000);

  // Review of PR #1965, round 1, point 1 b: what A dropped is not needed when the row comes back whole. The same case, and B moves the card once more: the row has a
  // write above A's `have`, so the whole row comes (every unit and value), A makes it, and A ends with what B and C hold, value and units.
  it("a row whose field units a node dropped, sent whole again later (B moves the card once more): A ends with the same card and units as B and C", async () => {
    const { a, b, c, note, names } = await dayMadeAgain();
    await onNode(b.node, () => writeAsOwner(b, `UPDATE node_positions SET x = 600, y = 95 WHERE node_id = $1 AND surface = $2`, [note, BOARD]));
    await settle(a, b, c);
    for (const p of [a, b, c]) expect(await cardRow(p, note), `${p.name}: the card where B moved it last`).toEqual([{ x: 600, y: 95 }]);
    const ub = await cardUnits(b, note, names);
    expect(await cardUnits(a, note, names), "A against B").toEqual(ub);
    expect(await cardUnits(c, note, names), "C against B").toEqual(ub);
  }, 600_000);

  // Review of PR #1965, round 2, point 3: the same, through a snapshot first (the kind of P3 in snapshotBrought). D joins from C's snapshot while C holds only the
  // card's `*` (C dropped nothing it had a value of: it never held the card), then exchanges with all three; B moves the card once more and every pair exchanges.
  // D ends with B's card, value and units: a value a node holds and does not delete reaches every node, through a snapshot chain too.
  it("the same, with a fourth node joined from a snapshot of a node that holds only the card's `*`: after B moves the card again, all four hold the same card and units", async () => {
    const { a, b, c, note, names } = await dayMadeAgain();
    const nd = await openNode("d"); open.push(nd);
    await fillFrom(nd, c, await capture(c.node, c, 12_000));
    const d = peerOf("D", nd, { ws: c.ws, owner: c.owner, spaceA: c.space });
    names.set(await nodeIdOf(d), "D");
    for (const p of [a, b, c]) { await admit(p, d); await admit(d, p); }
    await onNode(d.node, () => setModulesOn(d.ws, null));
    expect(await cardUnits(d, note, names), "D, from C's snapshot: only the card's `*`").toEqual(["*: stamp B saw {}"]);
    await onNode(b.node, () => writeAsOwner(b, `UPDATE node_positions SET x = 600, y = 95 WHERE node_id = $1 AND surface = $2`, [note, BOARD]));
    for (let r = 0; r < 3; r++) for (const x of [a, b, c, d]) for (const y of [a, b, c, d]) if (x !== y) await exchange(x, y);
    const ub = await cardUnits(b, note, names);
    for (const p of [a, c, d]) {
      expect(await cardRow(p, note), `${p.name}: the card where B moved it last`).toEqual([{ x: 600, y: 95 }]);
      expect(await cardUnits(p, note, names), `${p.name} against B`).toEqual(ub);
    }
  }, 600_000);
});
