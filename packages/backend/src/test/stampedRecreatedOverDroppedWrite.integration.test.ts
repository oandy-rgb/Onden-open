// A note deleted for good on B and made again there under the same id, while A, which had not seen the delete, changed its title (pinned before the transport:
// README of spine/stampedMerge 「接上傳輸前必須完成」, 「重建的列在收件那台多一個欄位標記」). Found by stampedSawThreeNodes, seed 977753 (base 977753), shrunk to this:
//   1. A makes N; B takes it.            2. B deletes N for good.        3. A, not knowing, changes N's title.
//   4. A's title reaches B: B holds no row N, so it keeps no field unit of it (dbRows.ts dropFieldUnits, 「沒有那一列的欄位跟著 `*`」): the write is dropped.
//   5. B makes N again under its id (the creation's saw covers what B held of N: not A's title write).
//   6. The creation reaches A: A's title write is not covered by it, so A keeps it as another head (and a stamp row for the field, as every unit with a head).
// No exchange sends A's title write to B again (it is below B's `have`), so the two hold different heads for ever. The values are the same.
// SAFETY: node databases (a PGlite each, or a database of the test server on a real Postgres), dropped after each test.

import { afterEach, describe, expect, it } from "vitest";
import { q } from "../db.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { buildSourceWorld, capture, fillFrom, openNode } from "./helpers/stampedWorld.js";
import { admit, exchange, peerOf, type Peer } from "./helpers/stampedBundleWorld.js";

const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

const NOTE = "f9a7f9a7-f9a7-4f9a-8f9a-f9a7f9a7f977";

async function recreatedOverADroppedTitle(): Promise<{ a: Peer; b: Peer }> {
  const [na, nb] = [await openNode("a"), await openNode("b")];
  open.push(na, nb);
  const world = await buildSourceWorld(na);
  await fillFrom(nb, world, await capture(na, world, 1_000_000));
  const a = peerOf("A", na, world), b = peerOf("B", nb, world);
  await admit(a, b); await admit(b, a);
  await onNode(a.node, () => a.call("POST", "/api/nodes", { id: NOTE, title: "Made on A", markdown: "", space_id: a.space }));
  await exchange(a, b);
  await onNode(b.node, async () => {
    await b.call("DELETE", `/api/nodes/${NOTE}`);
    const plan = (await b.call("GET", `/api/nodes/${NOTE}/purge-preview`)) as { ids: string[] };
    await b.call("POST", `/api/nodes/${NOTE}/purge`, { expected_ids: plan.ids });
  });
  await onNode(a.node, () => a.call("PATCH", `/api/nodes/${NOTE}`, { title: "Changed on A" }));
  await exchange(a, b); // B holds no N: A's title write is dropped there
  await onNode(b.node, () => b.call("POST", "/api/nodes", { id: NOTE, title: "Made again on B", markdown: "", space_id: b.space }));
  for (let r = 0; r < 3; r++) { await exchange(b, a); await exchange(a, b); }
  return { a, b };
}
/** N's stamps and other heads on `p`, as text that compares byte for byte. */
const unitsOf = (p: Peer) => onNode(p.node, async () => (await q<{ r: string }>(
  `SELECT 's ' || field || ' ' || origin || ':' || seq || ' ' || saw::text AS r FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2
   UNION ALL SELECT 'h ' || field || ' ' || origin || ':' || seq || ' ' || saw::text || ' ' || COALESCE(value, '-') FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2
   ORDER BY 1`, [p.ws, NOTE])).rows.map((x) => x.r));
const titleOf = (p: Peer) => onNode(p.node, async () => (await q<{ t: string }>(`SELECT title AS t FROM content_nodes WHERE id = $1`, [NOTE])).rows[0]?.t);

describe.skipIf(!isTestDatabase())("a note made again under its id over a field write the maker dropped", () => {
  it("what differs today: the same title on both; A keeps A's title write as another head, B holds no such head", async () => {
    const { a, b } = await recreatedOverADroppedTitle();
    expect(await titleOf(a)).toBe(await titleOf(b));
    const [onA, onB] = [await unitsOf(a), await unitsOf(b)];
    expect(onA.some((u) => u.startsWith("h title") && u.includes("Changed on A")), "A keeps its title write as a head").toBe(true);
    expect(onB.some((u) => u.startsWith("h title")), "B holds no head of the title").toBe(false);
  }, 300_000);
  it.fails("A and B hold the same stamps and heads of N", async () => {
    const { a, b } = await recreatedOverADroppedTitle();
    expect(await unitsOf(b)).toEqual(await unitsOf(a));
  }, 300_000);
});
