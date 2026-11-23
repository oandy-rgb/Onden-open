// The red of stampedSawThreeNodes with ONDEN_SAW_SEED=924487 ("B against A: expected [...] to deeply equal [...]"), written out with no randomness and nothing drawn
// from other tests (README "接上傳輸前必須完成"). A card's place on a board (`node_positions`, key: note + surface) is a row two nodes can make on their own under the
// same key. B and C each place note N's card while A has already deleted N for good. A never holds the row, so it keeps the two creations' field writes without their
// values (dbRows.ts `withoutValues`: this table's rows do not go with their note), and storeUnit cannot see that the two creation values of `look` and `sub_canvas`
// are equal: it stores a stamp and a head for every field. B and C hold the row: they store only `position` (the values differ), and drop it when A's purge takes
// the row away. After every pair has exchanged both ways no node holds the card, and A holds three field units B and C do not; no exchange sends them again.
import { afterEach, describe, expect, it } from "vitest";
import { q } from "../db.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { exchange, nodeIdOf, peerStateOf, threePeers, writeAsOwner, type Peer } from "./helpers/stampedBundleWorld.js";

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

/** The scenario, step by step. Returns the peers and N. */
async function placeTwiceOnPurged(): Promise<{ a: Peer; b: Peer; c: Peer; note: string; names: Map<string, string> }> {
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
  await onNode(c!.node, () => writeAsOwner(c!, `INSERT INTO node_positions (node_id, surface, x, y, workspace_id) VALUES ($1, $2, 10, 20, $3)`, [note, BOARD, c!.ws]));
  return { a: a!, b: b!, c: c!, note, names };
}
/** The exchanges of seed 924487 for this unit, then every pair both ways until nothing moves. */
async function exchangeToTheEnd(a: Peer, b: Peer, c: Peer): Promise<void> {
  // 4. the two cards meet on C; A gets B's, then C's (both stamps only: A has no N); B gets C's
  await exchange(b, c); await exchange(b, a); await exchange(c, a); await exchange(c, b);
  // 5. A's purge reaches B and C (the card's row goes with N there)
  await exchange(a, b); await exchange(a, c);
  // 6. settle: every pair, both ways, three times
  for (let r = 0; r < 3; r++) for (const x of [a, b, c]) for (const y of [a, b, c]) if (x !== y) await exchange(x, y);
}

describe.skipIf(!isTestDb)("a card two nodes placed on their own, on a note a third deleted for good", () => {
  it("after every pair has exchanged both ways: no node holds the card; A keeps a stamp and a head for each of its three fields, B and C keep none (what diverges today)", async () => {
    const { a, b, c, note, names } = await placeTwiceOnPurged();
    await exchangeToTheEnd(a, b, c);
    for (const p of [a, b, c]) expect(await cardRow(p, note), `${p.name} holds no card of N`).toEqual([]);
    const units = { A: await cardUnits(a, note, names), B: await cardUnits(b, note, names), C: await cardUnits(c, note, names) };
    console.log(`[card] ${JSON.stringify(units, null, 1)}`);
    expect(units.B, "B and C hold the same").toEqual(units.C);
    expect(units.A.filter((u) => !u.startsWith("*")), "A: a stamp and a head, without values, for each field of the card").toEqual([
      "look: head B saw {} value null", "look: stamp C saw {}", "position: head B saw {} value null", "position: stamp C saw {}", "sub_canvas: head B saw {} value null", "sub_canvas: stamp C saw {}"]);
    expect(units.B.filter((u) => !u.startsWith("*")), "B: nothing but the row's own unit").toEqual([]);
  }, 600_000);

  it.fails("after every pair has exchanged both ways: A, B and C hold the same stamps and heads of the card (A keeps three field units B and C dropped)", async () => {
    const { a, b, c, note, names } = await placeTwiceOnPurged();
    await exchangeToTheEnd(a, b, c);
    const [ua, ub, uc] = [await cardUnits(a, note, names), await cardUnits(b, note, names), await cardUnits(c, note, names)];
    expect(ub, "B against A").toEqual(ua);
    expect(uc, "C against A").toEqual(ua);
  }, 600_000);
});
