// The red of stampedSawThreeNodes with ONDEN_SAW_SEED=330638 (seed 330640, issue #2012: "C to A, everything again: expected { created: 2, removed: 0 } to deeply equal
// { created: 0, removed: 0 }"), written out with no randomness, on two nodes. It is the pinned class of README 「筆記以同一個 id 重建時，掛在它上面的列在沒握有它的節點永遠
// 回不來」 (PR #1965, issue #1974 item 3: which node sends the row again, and when, is the owner's decision), here with a pointer (`note_pointers`) instead of a card:
// A points at note N while B has deleted N for good. The pointer reaches B as stamps only (B has no N to hang it on); B then makes N again under the same id. B's
// re-creation reaches A as a creation over the old one, so A's N is written over, not removed, and A keeps the pointer. The pointer's write is under B's `have` of A,
// so no exchange sent it again: A held the pointer, B never did, and a full resend from A made it on B. Issue #1974 item 3 (the owner chose 甲; issue #2019): A, which
// holds the pointer and had not seen the delete, sends it again when B's new creation of N reaches it (README 「筆記以同一個 id 重建時，握有掛在它上面的列的節點把它們再送出」).
import { afterEach, describe, expect, it } from "vitest";
import { q } from "../db.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { exchange, resendAll, threePeers, type Peer } from "./helpers/stampedBundleWorld.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

const pointersAt = (p: Peer, note: string) => onNode(p.node, async () => (await q<{ id: string }>(`SELECT id::text FROM note_pointers WHERE target_id = $1 ORDER BY id`, [note])).rows.map((r) => r.id));

/** The steps of seed 330640 for this row, on A and B only; then both ways until nothing moves. */
async function pointerOnRemadeNote(): Promise<{ a: Peer; b: Peer; note: string; pointer: string }> {
  const [a, b] = await threePeers(open);
  const made = async (title: string) => String((await onNode(a!.node, () => a!.call("POST", "/api/nodes", { title, markdown: "a note", space_id: a!.space }))).id);
  // 1. A makes N and M; B gets them
  const note = await made("N"), under = await made("M");
  await exchange(a!, b!);
  // 2. B deletes N for good (trash, then purge)
  await onNode(b!.node, async () => {
    await b!.call("DELETE", `/api/nodes/${note}`);
    const plan = (await b!.call("GET", `/api/nodes/${note}/purge-preview`)) as { ids: string[] };
    await b!.call("POST", `/api/nodes/${note}/purge`, { expected_ids: plan.ids });
  });
  // 3. A, not knowing, points at N from under M; B gets the pointer as stamps only (it has no N)
  const pointer = String((await onNode(a!.node, () => a!.call("POST", "/api/pointers", { target_id: note, parent_id: under }))).id);
  await exchange(a!, b!);
  // 4. B makes N again under the same id (the generator's `recreate`; in the product, a day's note opened again); A gets it
  await onNode(b!.node, () => b!.call("POST", "/api/nodes", { id: note, title: "N again", markdown: "again", space_id: b!.space }));
  await exchange(b!, a!);
  // 5. settle
  for (let r = 0; r < 3; r++) { await exchange(a!, b!); await exchange(b!, a!); }
  return { a: a!, b: b!, note, pointer };
}

describe.skipIf(!isTestDb)("a pointer at a note one node deleted for good and made again under its id", () => {
  it("A sends the pointer again when B's new N reaches it: B makes it; one more round stores nothing", async () => {
    const { a, b, note, pointer } = await pointerOnRemadeNote();
    for (const p of [a, b]) expect(await onNode(p.node, async () => (await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [note])).rows.length), `${p.name} holds N`).toBe(1);
    expect(await pointersAt(a, note), "A: the pointer").toEqual([pointer]);
    expect(await pointersAt(b, note), "B: the pointer").toEqual([pointer]);
    const again = await exchange(a, b);
    expect({ stored: again.stored, created: again.created }, "one more round sends nothing").toEqual({ stored: 0, created: 0 });
  }, 600_000);

  it("the property of issue #2012: after the nodes settle, a full resend changes no row (A and B hold the same pointer)", async () => {
    const { a, b, note } = await pointerOnRemadeNote();
    expect(await pointersAt(b, note)).toEqual(await pointersAt(a, note));
    const all = await resendAll(a, b);
    expect({ created: all.created, removed: all.removed }).toEqual({ created: 0, removed: 0 });
  }, 600_000);
});
