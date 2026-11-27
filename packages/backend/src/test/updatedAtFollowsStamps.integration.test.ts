// `updated_at` of the stamped tables other than notes is a function of the row's counting stamps (migration 232; README of spine/stampedMerge, 「列層的新規則」), on the
// node that writes and on the node that takes the write back into a row it holds. What is proved here, on two nodes (B writes, A takes a bundle), each ends with the
// whole digest (rows, stamps, heads) the same on both:
//   T1  whether a unit counts is decided per unit for the whole transaction: it counts when ANY statement of the transaction wrote it while moving `updated_at`,
//       whatever the order — (a) a row touched first without a unit change, then changed with the column moved; (b) a unit changed with the column moved, then
//       written again by a statement that leaves it alone, and the other order; (c) two keys of a JSON column, one written each way: only the key a statement that
//       left the column alone wrote is quiet;
//   T2  a statement that moves `updated_at` without changing any unit moves it as on main (a paragraph row's text worked out again, an attribute saved as it was;
//       on one server a derived attribute's change and a card put down where it was too); such a write is not carried, and the node that takes the bundle keeps
//       its own value: `updated_at` of these tables is derived on each node (decision 甲, issue #2020), left out of every check of "the same" (negative controls);
//       a paragraph row's hidden_at, set to each node's own now() when the body loses the paragraph, is compared only for whether it is set (negative
//       controls: shown on one node and hidden on the other is red, and would pass were it left out whole);
//       a note touched the same way is a gap of its own, pinned (a note's updated_at replicates and people see it);
//   T3  every table of the rule: a paragraph row (its task), a function reference (its config keys), a person's module settings (its key "<actor>/<tag>").
// SAFETY: node databases (a PGlite each, or a database of the test server on a real Postgres), dropped after each test.

import { afterEach, describe, expect, it } from "vitest";
import { q } from "../db.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { stampTransaction } from "../spine/stamps.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { seedQ } from "./helpers/seedQ.js";
import { setNodeAttribute } from "../services/attributeWrites.js";
import { buildSourceWorld, capture, fillFrom, openNode } from "./helpers/stampedWorld.js";
import { admit, exchange, expectSame, peerOf, type Peer } from "./helpers/stampedBundleWorld.js";
import { DERIVED_PER_NODE_COLUMNS } from "../spine/snapshotTables.js";

const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

/** A and B, B joined from A, each a sender of the other. */
async function twoNodes(): Promise<{ a: Peer; b: Peer }> {
  const [na, nb] = [await openNode("a"), await openNode("b")];
  open.push(na, nb);
  const world = await buildSourceWorld(na);
  await fillFrom(nb, world, await capture(na, world, 1_000_000));
  const a = peerOf("A", na, world), b = peerOf("B", nb, world);
  await admit(a, b); await admit(b, a);
  return { a, b };
}
/** One local transaction on `p`, by its owner, of these statements in order. */
const inOneTransaction = (p: Peer, statements: readonly [string, unknown[]][]) => onNode(p.node, () => withEventTransaction(p.ws, async () => {
  await stampTransaction(p.ws, p.owner.id);
  for (const [sql, params] of statements) await q(sql, params);
}));
const valueOf = <T,>(p: Peer, sql: string, params: unknown[]) => onNode(p.node, async () => (await q<{ v: T }>(sql, params)).rows[0]?.v);
/** Whether each named unit's stamp says quiet, on `p`: `{ field: true | false }` (a field with no stamp row of its own is left out). */
const quietOf = (p: Peer, label: string, row: string) => onNode(p.node, async () => Object.fromEntries((await q<{ f: string; quiet: boolean }>(
  `SELECT field AS f, COALESCE(meta->>'quiet', '') = 'true' AS quiet FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field <> '*'`, [p.ws, label, row])).rows.map((r) => [r.f, r.quiet])));
const pause = () => new Promise((r) => setTimeout(r, 25)); // a later write has a later clock reading

async function noteOf(b: Peer, title: string, markdown = ""): Promise<string> {
  return onNode(b.node, async () => (await b.call("POST", "/api/nodes", { title, markdown, space_id: b.space })).id as string);
}
/** A note of B's whose body has one tagged paragraph, so the body's own write made its paragraph row (every node works the row out from the body the same way). */
async function paragraphOf(b: Peer): Promise<{ note: string; block: string }> {
  const note = await noteOf(b, "Its paragraph");
  await onNode(b.node, () => b.call("PATCH", `/api/nodes/${note}`, { markdown: "A paragraph here {plan}\n" }));
  const block = await valueOf<string>(b, `SELECT id::text AS v FROM block_nodes WHERE note_id = $1 AND hidden_at IS NULL ORDER BY id LIMIT 1`, [note]);
  if (!block) throw new Error("the body's write made no paragraph row");
  return { note, block };
}
/** An attribute on a new note of B's, taken by A: the row A holds when B's next writes reach it. */
async function attribute(a: Peer, b: Peer) {
  const note = await noteOf(b, "Its attribute");
  await onNode(b.node, () => b.call("PUT", `/api/nodes/${note}/attributes/status`, { value: "first" }));
  await exchange(b, a);
  const row = `${note}/status`;
  const at = (p: Peer) => valueOf<string>(p, `SELECT updated_at::text AS v FROM node_attributes WHERE node_id = $1 AND key = 'status'`, [note]);
  return { note, row, at };
}

describe.skipIf(!isTestDatabase())("updated_at follows the stamps (migration 232): the writer and the node that takes the write hold the same", () => {
  it("T1 (a): a row touched first without a unit change, then changed with the column moved, in one transaction: the change counts on both", async () => {
    const { a, b } = await twoNodes();
    const { note, row, at } = await attribute(a, b);
    const before = await at(b);
    await pause();
    await inOneTransaction(b, [
      [`UPDATE node_attributes SET updated_at = now() WHERE node_id = $1 AND key = 'status'`, [note]],
      [`UPDATE node_attributes SET value = 'second', updated_at = now() WHERE node_id = $1 AND key = 'status'`, [note]],
    ]);
    expect(await quietOf(b, "node_attributes", row), "the stamps of the row's units on B, and whether each is quiet").toEqual({ value: false });
    expect(await at(b), "the change moved it on B").not.toBe(before);
    expect((await exchange(b, a)).rejected).toEqual([]);
    expect(await at(a)).toBe(await at(b));
    await expectSame(a, b, "A and B");
  }, 300_000);

  for (const order of ["moved first", "moved second"] as const) {
    it(`T1 (b): one unit written twice in one transaction, once moving the column and once not (${order}): it counts on both`, async () => {
      const { a, b } = await twoNodes();
      const { note, row, at } = await attribute(a, b);
      const before = await at(b);
      await pause();
      const moving: [string, unknown[]] = [`UPDATE node_attributes SET value = 'second', updated_at = now() WHERE node_id = $1 AND key = 'status'`, [note]];
      const leaving: [string, unknown[]] = [`UPDATE node_attributes SET value = 'third' WHERE node_id = $1 AND key = 'status'`, [note]];
      await inOneTransaction(b, order === "moved first" ? [moving, leaving] : [leaving, moving]);
      expect(await quietOf(b, "node_attributes", row), "the stamps of the row's units on B, and whether each is quiet").toEqual({ value: false });
      expect(await at(b), "it moved on B").not.toBe(before);
      expect((await exchange(b, a)).rejected).toEqual([]);
      expect(await at(a)).toBe(await at(b));
      await expectSame(a, b, "A and B");
    }, 300_000);
  }

  it("T1 (b'): a unit written only by statements that leave the column alone is quiet, and the column stays on both", async () => {
    const { a, b } = await twoNodes();
    const { note, row, at } = await attribute(a, b);
    const before = await at(b);
    await pause();
    await inOneTransaction(b, [
      [`UPDATE node_attributes SET value = 'second' WHERE node_id = $1 AND key = 'status'`, [note]],
      [`UPDATE node_attributes SET value = 'third' WHERE node_id = $1 AND key = 'status'`, [note]],
    ]);
    expect(await quietOf(b, "node_attributes", row), "the stamps of the row's units on B, and whether each is quiet").toEqual({ value: true });
    expect(await at(b)).toBe(before);
    expect((await exchange(b, a)).rejected).toEqual([]);
    expect(await at(a)).toBe(before);
    await expectSame(a, b, "A and B");
  }, 300_000);

  it("T1 (c) and T3: two keys of a function reference's config, one written moving the column and one not: only the second key is quiet, on both", async () => {
    const { a, b } = await twoNodes();
    const note = await noteOf(b, "Its reference");
    const ref = await onNode(b.node, async () => {
      let id = "";
      await withEventTransaction(b.ws, async () => {
        await stampTransaction(b.ws, b.owner.id);
        id = (await q<{ id: string }>(`INSERT INTO function_refs (workspace_id, function_id, holder_node_id, config) VALUES ($1, 'review', $2, '{}'::jsonb) RETURNING id::text`, [b.ws, note])).rows[0]!.id;
      });
      return id;
    });
    await exchange(b, a);
    const at = (p: Peer) => valueOf<string>(p, `SELECT updated_at::text AS v FROM function_refs WHERE id = $1`, [ref]);
    const before = await at(b);
    await pause();
    await inOneTransaction(b, [
      [`UPDATE function_refs SET config = config || '{"moved": 1}'::jsonb, updated_at = now() WHERE id = $1`, [ref]],
      [`UPDATE function_refs SET config = config || '{"left": 2}'::jsonb WHERE id = $1`, [ref]],
    ]);
    expect(await quietOf(b, "function_refs.config", ref)).toEqual({ "key:moved": false, "key:left": true });
    expect(await at(b), "the first key moved it").not.toBe(before);
    expect((await exchange(b, a)).rejected).toEqual([]);
    expect(await quietOf(a, "function_refs.config", ref)).toEqual({ "key:moved": false, "key:left": true });
    expect(await at(a)).toBe(await at(b));
    await expectSame(a, b, "A and B");
  }, 300_000);

  // A statement that moves the column and changes no unit (a value no stamp covers) leaves what it wrote, as on main: the single server's readers need it
  // (services/attributeWrites.ts, services/boardWrites.ts, migration 231). Such a write is not carried: for these tables `updated_at` is derived on each node
  // (owner's decision 甲, issue #2020; spine/snapshotTables.ts DERIVED_PER_NODE_COLUMNS), so the node that takes the bundle keeps its own value, and every
  // check of "the same on both" leaves exactly these columns out.
  async function movedWithoutAUnit() {
    const { a, b } = await twoNodes();
    const { note, at } = await attribute(a, b);
    const { block } = await paragraphOf(b);
    await exchange(b, a);
    const blockAt = (p: Peer) => valueOf<string>(p, `SELECT updated_at::text AS v FROM block_nodes WHERE id = $1`, [block]);
    const before = { attr: await at(b), block: await blockAt(b) };
    const beforeOnA = { attr: await at(a), block: await blockAt(a) };
    await pause();
    await inOneTransaction(b, [
      [`UPDATE node_attributes SET value = value, updated_at = now() WHERE node_id = $1 AND key = 'status'`, [note]],
      // the text worked out again from the same body is the same text (services/blockNodes.ts syncBlockNodes rewrites the row with what it holds)
      [`UPDATE block_nodes SET text_cache = text_cache, updated_at = now() WHERE id = $1`, [block]],
    ]);
    const onB = { attr: await at(b), block: await blockAt(b) };
    expect((await exchange(b, a)).rejected).toEqual([]);
    return { a, b, before, beforeOnA, onB, onA: { attr: await at(a), block: await blockAt(a) } };
  }
  it("T2: a statement that moves the column without changing a unit moves it, as on main (an attribute saved as it was, a paragraph row's text worked out again)", async () => {
    const { before, onB } = await movedWithoutAUnit();
    expect(onB.attr, "the attribute saved as it was").not.toBe(before.attr);
    expect(onB.block, "the paragraph row's text worked out again").not.toBe(before.block);
  }, 300_000);
  it("T2: the node that takes the bundle keeps its own updated_at (derived on each node), and nothing that replicates differs", async () => {
    const { a, b, beforeOnA, onB, onA } = await movedWithoutAUnit();
    expect(onA, "A keeps what it held: the write carried nothing").toEqual(beforeOnA);
    expect(onA.attr, "so the two nodes hold different values in a derived column").not.toBe(onB.attr);
    await expectSame(a, b, "after T2"); // DERIVED_PER_NODE_COLUMNS left out, everything else compared
  }, 300_000);
  // A replicated column put on the list (or a table whose rows do not travel) is refused when the backend loads: test/derivedColumnsRefused.test.ts.
  it("T2, negative control: with nothing declared derived the same two nodes differ", async () => {
    const { a, b } = await movedWithoutAUnit();
    await expect(expectSame(a, b, "nothing derived", {}), "the list is what lets the check pass").rejects.toThrow(/differ/);
  }, 300_000);

  // A paragraph row's hidden_at is the same class (review of PR #2022, round 1, point 1): when the body no longer has the paragraph, the writer's save and the
  // node that takes the body (services/receivedDerivation.ts -> bodyDerivation.ts -> blockNodes.ts deriveBlockRows) each set it to their own now(). Whether it
  // is set is worked out from replicated state and must be the same; its time is each node's own: "set or not" on the one list. The save also moves the
  // remaining anchor (moved_how / moved_at, the writer's own record, "left out").
  async function paragraphDeleted() {
    const { a, b } = await twoNodes();
    const note = await noteOf(a, "Two paragraphs");
    await onNode(a.node, () => a.call("PATCH", `/api/nodes/${note}`, { markdown: "First {plan}\n\nSecond {plan}\n" }));
    expect((await exchange(a, b)).rejected).toEqual([]);
    await pause();
    await onNode(a.node, () => a.call("PATCH", `/api/nodes/${note}`, { markdown: "First {plan}\n" }));
    expect((await exchange(a, b)).rejected).toEqual([]);
    const rows = (p: Peer) => onNode(p.node, async () => (await q<{ ref: string; label: string; hidden_at: string | null }>(
      `SELECT block_ref AS ref, label, hidden_at::text FROM block_nodes WHERE note_id = $1 ORDER BY block_ref`, [note])).rows);
    return { a, b, note, onA: await rows(a), onB: await rows(b) };
  }
  it("T2, hidden_at: A deletes the second of two paragraphs and B takes it: hidden on both, each at its own time, and nothing that replicates differs", async () => {
    const { a, b, onA, onB } = await paragraphDeleted();
    const shown = (rows: typeof onA) => rows.map((r) => [r.label, r.hidden_at === null]);
    expect(shown(onA).sort()).toEqual([["First", true], ["Second", false]]);
    expect(shown(onB)).toEqual(shown(onA));
    const hiddenAt = (rows: typeof onA) => rows.find((r) => r.label === "Second")!.hidden_at;
    expect(hiddenAt(onB), "each node hid it at its own time: the two values differ").not.toBe(hiddenAt(onA));
    await expectSame(a, b, "a paragraph deleted");
  }, 300_000);
  it("T2, hidden_at, negative controls: without the list the same two nodes differ; one node hidden and the other shown is red, and would pass were hidden_at left out whole", async () => {
    const { a, b, note } = await paragraphDeleted();
    await expect(expectSame(a, b, "nothing derived", {}), "the list is what lets the check pass").rejects.toThrow(/differ/);
    // B shows the paragraph again, A keeps it hidden: a real difference
    await onNode(b.node, () => seedQ(`UPDATE block_nodes SET hidden_at = NULL WHERE note_id = $1 AND label = 'Second'`, [note]));
    await expect(expectSame(a, b, "shown on B, hidden on A"), "whether it is set is compared").rejects.toThrow(/block_nodes/);
    const leftOutWhole = { ...DERIVED_PER_NODE_COLUMNS, block_nodes: { updated_at: "left out", hidden_at: "left out" } } as const;
    await expectSame(a, b, "hidden_at left out whole", leftOutWhole); // why it is "set or not": left out, the difference would pass in silence
  }, 300_000);

  // A NOTE's updated_at is replicated (a function of its stamps, migration 206) and people see it (the canvas list, "recently changed", exports). Three writes
  // touch a note's updated_at without a unit, the same gap as T2 (issue #2020, found while answering it; services/canvasNodes.ts updateCanvas without a title,
  // services/boardWrites.ts when cards move, services/functionRefs.ts touchTag). The decision 甲 does not cover notes (nothing else gives a note's time), so it is
  // pinned until the owner decides (README of stampedMerge 「接上傳輸前必須完成」).
  async function noteTouchedOnly() {
    const { a, b } = await twoNodes();
    const canvas = await onNode(b.node, async () => (await b.call("POST", "/api/canvases", { title: "Its board", space_id: b.space })).id as string);
    await exchange(b, a);
    const at = (p: Peer) => valueOf<string>(p, `SELECT updated_at::text AS v FROM content_nodes WHERE id = $1`, [canvas]);
    const before = await at(b);
    await pause();
    await onNode(b.node, () => b.call("PATCH", `/api/canvases/${canvas}`, {})); // "just its updated_at so the canvas list re-sorts"
    expect((await exchange(b, a)).rejected).toEqual([]);
    return { a, b, before, onB: await at(b), onA: await at(a) };
  }
  it("a note touched without a unit (a canvas PATCH with no title): it moves on the writer, as on main, and the note carries no new stamp", async () => {
    const { before, onB, onA } = await noteTouchedOnly();
    expect(onB, "moved on B").not.toBe(before);
    expect(onA, "today A keeps the time it had").toBe(before);
  }, 300_000);
  it.fails("a note touched without a unit, pinned: both nodes hold the same updated_at of the note (a column that replicates and people see)", async () => {
    const { a, b, onB, onA } = await noteTouchedOnly();
    expect(onA).toBe(onB);
    await expectSame(a, b, "a touched note");
  }, 300_000);

  it("a derived attribute whose value changes, on one server: updated_at moves, and a person's later write that had not seen it is recorded as a conflict", async () => {
    const { b } = await twoNodes();
    const note = await noteOf(b, "Its derived value");
    const key = "derivedprobe";
    // a value the body produced two hours ago (no stamp: a derived attribute does not travel)
    await onNode(b.node, () => seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source, updated_at) VALUES ($1, $2, $3, 'first', 'text', 'derived', now() - interval '2 hours')`, [b.ws, note, key]));
    const at = () => valueOf<string>(b, `SELECT updated_at::text AS v FROM node_attributes WHERE node_id = $1 AND key = $2`, [note, key]);
    const before = await at();
    await inOneTransaction(b, [[`UPDATE node_attributes SET value = 'second', updated_at = now() WHERE node_id = $1 AND key = $2`, [note, key]]]);
    expect(await at(), "the derived value's change moved it").not.toBe(before);
    // a person's write made an hour ago, by a client that had not seen the second value: recorded as a conflict (services/attributeWrites.ts reads updated_at for it)
    await onNode(b.node, () => setNodeAttribute({ workspaceId: b.ws, actor: b.owner, nodeId: note, attribute: { key, value: "typed", value_type: "text", client_updated_at: new Date(Date.now() - 3_600_000).toISOString(), client_edit_age_ms: 3_600_000 } }));
    const conflicts = await valueOf<string>(b, `SELECT count(*)::text AS v FROM domain_events WHERE workspace_id = $1 AND target_id = $2 AND event_type = 'ATTRIBUTE_CONFLICT'`, [b.ws, note]);
    expect(conflicts).toBe("1");
  }, 300_000);

  it("a card put down where it was, on one server: updated_at moves, as on main (services/boardStore.ts; the 5-second window of services/boardWrites.ts reads it)", async () => {
    const { b } = await twoNodes();
    const note = await noteOf(b, "Its card");
    const at = () => valueOf<string>(b, `SELECT updated_at::text AS v FROM node_positions WHERE node_id = $1 AND surface = 'graph'`, [note]);
    await onNode(b.node, () => b.call("PUT", `/api/nodes/${note}/position`, { surface: "graph", x: 3, y: 4 }));
    const first = await at();
    await pause();
    await onNode(b.node, () => b.call("PUT", `/api/nodes/${note}/position`, { surface: "graph", x: 3, y: 4 }));
    expect(await at(), "the same place saved again").not.toBe(first);
    // the history as on main: the second drop is inside the first one's 5 seconds, one event; aged past the window, the next move is a new one
    const events = () => valueOf<string>(b, `SELECT count(*)::text AS v FROM domain_events WHERE target_id = $1 AND event_type = 'GRAPH_POSITION_UPDATED'`, [note]);
    expect(await events(), "one burst").toBe("1");
    await onNode(b.node, () => seedQ(`UPDATE node_positions SET updated_at = now() - interval '10 seconds' WHERE node_id = $1 AND surface = 'graph'`, [note]));
    await onNode(b.node, () => b.call("PUT", `/api/nodes/${note}/position`, { surface: "graph", x: 5, y: 6 }));
    expect(await events(), "a move after the window is a new event").toBe("2");
  }, 300_000);

  it("T3: a paragraph row's task and a person's module settings: a write that moves the column moves it to the stamp's time, the same on both", async () => {
    const { a, b } = await twoNodes();
    const { block } = await paragraphOf(b);
    const task = await noteOf(b, "Its task");
    const tag = await noteOf(b, "Its settings");
    await inOneTransaction(b, [[`INSERT INTO actor_module_settings (actor_id, tag_id, settings) VALUES ($1, $2, '{"view": "list"}'::jsonb)`, [b.owner.id, tag]]]);
    await exchange(b, a);
    const blockAt = (p: Peer) => valueOf<string>(p, `SELECT updated_at::text AS v FROM block_nodes WHERE id = $1`, [block]);
    const settingsAt = (p: Peer) => valueOf<string>(p, `SELECT updated_at::text AS v FROM actor_module_settings WHERE actor_id = $1 AND tag_id = $2`, [b.owner.id, tag]);
    const [blockBefore, settingsBefore] = [await blockAt(b), await settingsAt(b)];
    await pause();
    await inOneTransaction(b, [
      [`UPDATE block_nodes SET task_id = $2, updated_at = now() WHERE id = $1`, [block, task]],
      [`UPDATE actor_module_settings SET settings = '{"view": "board"}'::jsonb, updated_at = now() WHERE actor_id = $1 AND tag_id = $2`, [b.owner.id, tag]],
    ]);
    // the stamp's clock, read back the same way for both tables (the key "<actor>/<tag>" found its row)
    const wall = (p: Peer, label: string, row: string, field: string) => valueOf<string>(p,
      `SELECT to_timestamp(hlc_wall / 1000.0)::text AS v FROM sync_stamps WHERE workspace_id = $1 AND table_name = $2 AND row_key = $3 AND field = $4`, [p.ws, label, row, field]);
    expect(await blockAt(b)).not.toBe(blockBefore);
    expect(await blockAt(b)).toBe(await wall(b, "block_nodes", block, "task"));
    expect(await settingsAt(b)).not.toBe(settingsBefore);
    expect(await settingsAt(b)).toBe(await wall(b, "actor_module_settings", `${b.owner.id}/${tag}`, "settings"));
    expect((await exchange(b, a)).rejected).toEqual([]);
    expect([await blockAt(a), await settingsAt(a)]).toEqual([await blockAt(b), await settingsAt(b)]);
    await expectSame(a, b, "A and B");
  }, 300_000);
});
