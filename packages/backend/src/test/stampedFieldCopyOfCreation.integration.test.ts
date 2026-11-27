// A finding of the ending every bundle test has (helpers/stampedEnding.ts; issue #1976), pinned: the node that writes a task line holds, for the line's paragraph row
// (block_nodes), a stamp of its `task` field that is a copy of the row's creation stamp (the same origin and number: the row was made and linked to its task note in one
// transaction); the node that takes the bundle folds it into the creation and holds `*` only. The values are the same; the stamps are not, and a full resend does not change
// that (it stores nothing). README 「接上傳輸前必須完成」 (the mirror of 「重建的列在收件那台多一個欄位標記」). The ending sets exactly this shape aside
// (`withoutCopiesOfCreation`) because which test of a file shows it depends on the order its tests run in; here it is shown on purpose. Both engines.
import { afterEach, describe, expect, it } from "vitest";
import { q } from "../db.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, fillFrom, openNode } from "./helpers/stampedWorld.js";
import { admit, exchange, peerOf, resendAll, type Peer } from "./helpers/stampedBundleWorld.js";
import { setModulesOn } from "./helpers/setModulesOn.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

const NOTE = "0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d";

/** A writes a note with one task line; B, joined from A's snapshot, takes A's bundles; then a full resend both ways. */
async function taskLineOnTwoNodes(): Promise<{ a: Peer; b: Peer; resent: number }> {
  const [na, nb] = [await openNode("a"), await openNode("b")];
  open.push(na, nb);
  const world = await buildSourceWorld(na);
  const a = peerOf("A", na, world);
  await fillFrom(nb, world, await capture(na, world, 1_000_000));
  const b = peerOf("B", nb, world);
  await admit(a, b); await admit(b, a);
  for (const p of [a, b]) await onNode(p.node, () => setModulesOn(p.ws, null));
  await onNode(a.node, () => a.call("POST", "/api/nodes", { id: NOTE, title: "Task line", markdown: "", space_id: a.space }));
  await exchange(a, b);
  await onNode(a.node, () => a.call("PATCH", `/api/nodes/${NOTE}`, { markdown: "# Task line\n\n- [ ] do a thing {task}\n" }));
  await exchange(a, b); await exchange(b, a);
  const resent = (await resendAll(a, b)).stored + (await resendAll(b, a)).stored;
  return { a, b, resent };
}

/** The stamps of the note's paragraph rows on `p`: field and (origin, number), without the row's id. */
const paragraphStamps = (p: Peer) => onNode(p.node, async () => (await q<{ s: string }>(
  `SELECT s.field || ' ' || s.origin || ':' || s.seq AS s FROM sync_stamps s JOIN block_nodes b ON b.id::text = s.row_key
    WHERE s.workspace_id = $1 AND s.table_name = 'block_nodes' AND b.note_id = $2 AND b.task_id IS NOT NULL ORDER BY 1`, [p.ws, NOTE])).rows.map((r) => r.s));

describe.skipIf(!isTestDb)("a paragraph row made with its task in one transaction: the writer keeps a copy of the creation stamp for `task`, the receiver does not", () => {
  it("what differs today: A holds `*` and `task` under one (origin, number), B only `*`; the full resend stores nothing", async () => {
    const { a, b, resent } = await taskLineOnTwoNodes();
    const [atA, atB] = [await paragraphStamps(a), await paragraphStamps(b)];
    expect(atA.map((s) => s.split(" ")[0])).toEqual(["*", "task"]);
    expect(atA[0]!.split(" ")[1]).toBe(atA[1]!.split(" ")[1]);
    expect(atB).toEqual([atA[0]]);
    expect(resent).toBe(0);
  }, 300_000);

  it.fails("the same stamps of that row on both nodes", async () => {
    const { a, b } = await taskLineOnTwoNodes();
    expect(await paragraphStamps(b)).toEqual(await paragraphStamps(a));
  }, 300_000);
});
