// What a copy of a write says it wrote is stored and sent as it is (review of PR #1853, round 8, P1): a stamp kept without its row keeps its value (`sync_stamps.kept_value`,
// sent as the stamp's `kept`), and a head that came without its value is stored with that mark (`sync_stamp_heads.valueless`, sent as the head's `valueless`), never as a
// NULL value. storeUnit writes them; readStampsOf (what a bundle and a snapshot send) and readUnit read them back. Both engines.
import { afterEach, describe, expect, it } from "vitest";
import { q, withTransaction } from "../db.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, makeCaller, openNode } from "./helpers/stampedWorld.js";
import { abandonJoin, applyJoinPage, startJoin } from "../services/stampedJoin.js";
import type { StampedPage, WireStamp } from "../spine/snapshotSql.js";
import { readStampsOf } from "../spine/snapshotSql.js";
import { readUnit, storeUnit, addressOfUnit, sourceOf } from "../spine/stampedMerge/dbUnits.js";
import type { Cell, Stamp } from "../spine/stampedMerge/unit.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

const st = (origin: string, seq: number, wall: number): Stamp => ({ origin, seq, wall, counter: 0, author: null, device: null });
const codeOf = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e.code ?? String(e));

describe.skipIf(!isTestDb)("a write's value, or the mark that a copy has none, is stored and sent as it is", () => {
  it("a paragraph row this node does not hold: the winner's value kept on its stamp, a head without a value marked; read back and sent the same", async () => {
    const node = await openNode("kept");
    open.push(node);
    const world = await buildSourceWorld(node);
    const row = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e01"; // no such row in block_nodes: what a row that went with its note is on this node
    const note = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e02", other = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e03";
    const win: Cell = { stamp: st("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 5, 2_000), saw: { "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": 4 }, deleted: false, value: note };
    const bare: Cell = { stamp: st("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 3, 1_000), saw: {}, deleted: false, value: null, valueless: true };
    const valued: Cell = { stamp: st("cccccccc-cccc-4ccc-8ccc-cccccccccccc", 2, 900), saw: {}, deleted: false, value: other };
    const src = sourceOf("block_nodes");
    await onNode(node, () => withTransaction(async () => {
      await storeUnit(world.ws, addressOfUnit(src, row, "*"), [{ stamp: st("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 1, 100), saw: {}, deleted: false, value: {} }], undefined, false, true);
      await storeUnit(world.ws, addressOfUnit(src, row, "note"), [win, bare, valued], new Set(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:1"]), false, true);
    }));
    const stored = await onNode(node, async () => ({
      stamp: (await q<{ kept: unknown }>(`SELECT kept_value AS kept FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'block_nodes' AND row_key = $2 AND field = 'note'`, [world.ws, row])).rows,
      heads: (await q<{ origin: string; value: string | null; valueless: boolean }>(
        `SELECT origin, value, valueless FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = 'block_nodes' AND row_key = $2 AND field = 'note' ORDER BY origin`, [world.ws, row])).rows,
    }));
    expect(stored).toEqual({
      stamp: [{ kept: { text: note } }],
      heads: [{ origin: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", value: null, valueless: true }, { origin: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", value: other, valueless: false }],
    });
    // what a bundle sends of it (a tombstone item carries these stamps as they are)
    const wire = await onNode(node, () => readStampsOf(world.ws, [{ label: "block_nodes", rowKey: row }]));
    const sent = wire.find((w) => w.field === "note")!;
    expect({ kept: sent.kept, heads: sent.heads.map((h) => ({ origin: h.origin, value: h.value, valueless: h.valueless })) }).toEqual({
      kept: { text: note },
      heads: [{ origin: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", value: null, valueless: true }, { origin: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", value: other, valueless: false }],
    });
    // the unit-level reader reads the mark back on the head (the winner's value is a row's column there: no row, no winner cell)
    const unit = await onNode(node, () => readUnit(world.ws, addressOfUnit(src, row, "note")));
    expect(unit?.map((c) => ({ origin: c.stamp.origin, value: c.value, valueless: c.valueless ?? false }))).toEqual([
      { origin: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", value: null, valueless: true }, { origin: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", value: other, valueless: false }]);
  }, 300_000);

  // round 9, point 4: a winner without a value over a row this node holds keeps the mark on its stamp row (`kept_value` {"none": true}); read back, the column's value
  // is NOT taken for it, and it is sent as no value
  it("a winner without a value over a row that is here: the mark is stored, read back over the column, and sent", async () => {
    const node = await openNode("mark");
    open.push(node);
    const world = await buildSourceWorld(node);
    const note = (await onNode(node, () => q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND node_type = 'content' ORDER BY id LIMIT 1`, [world.ws]))).rows[0]!.id;
    const src = sourceOf("content_nodes");
    const bare: Cell = { stamp: st("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 9, 9_000_000_000_000), saw: { "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": 8 }, deleted: false, value: null, valueless: true };
    await onNode(node, () => withTransaction(() => storeUnit(world.ws, addressOfUnit(src, note, "title"), [bare])));
    const title = (await onNode(node, () => q<{ t: string }>(`SELECT title AS t FROM content_nodes WHERE id = $1`, [note]))).rows[0]!.t;
    expect(title).not.toBeNull(); // the column is not written from it
    const unit = await onNode(node, () => readUnit(world.ws, addressOfUnit(src, note, "title")));
    expect(unit?.map((c) => ({ origin: c.stamp.origin, value: c.value, valueless: c.valueless ?? false }))).toEqual([{ origin: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", value: null, valueless: true }]);
    const sent = (await onNode(node, () => readStampsOf(world.ws, [{ label: "content_nodes", rowKey: note }]))).find((w) => w.field === "title")!;
    expect(sent.kept).toEqual({ none: true });
  }, 300_000);

  // round 9, point 3: a snapshot's stamps are held to the same form as a change bundle's (stampedImport.ts isWireStamp), and a value a stamp kept to its unit's check
  it("a snapshot whose stamp keeps a value in another form, or one its unit does not hold: refused (join_stamp_shape), nothing taken", async () => {
    const node = await openNode("snap-source");
    open.push(node);
    const world = await buildSourceWorld(node);
    const call = makeCaller(world.owner);
    await onNode(node, () => call("POST", "/api/nodes", { title: "Anchored", markdown: "A paragraph to anchor {plan}\n\nAnother one {plan}\n", space_id: world.spaceA }));
    const cap = await capture(node, world);
    const find = (label: string) => {
      for (const [n, page] of cap.pages.entries()) for (const item of page.items) if (item.kind === "row") { const s1 = item.stamps.find((x) => x.label === label && (x.field !== "*" || label === "block_nodes")); if (s1) return { n, rowKey: s1.rowKey, field: s1.field }; }
      throw new Error(`no stamp of ${label}`);
    };
    const spoil = (label: string, change: (w: WireStamp) => void): StampedPage => {
      const at = find(label);
      const page = JSON.parse(JSON.stringify(cap.pages[at.n])) as StampedPage;
      for (const item of page.items) if (item.kind === "row") for (const w of item.stamps) if (w.label === label && w.rowKey === at.rowKey && w.field === at.field) change(w);
      return page;
    };
    const cases: Array<[string, StampedPage]> = [
      ["a kept value that is a number", spoil("content_nodes", (w) => { (w as unknown as Record<string, unknown>).kept = { text: 5 }; })],
      ["a kept value that is an empty object", spoil("content_nodes", (w) => { (w as unknown as Record<string, unknown>).kept = {}; })],
      ["a kept value and a mark at once", spoil("content_nodes", (w) => { (w as unknown as Record<string, unknown>).kept = { text: "x", none: true }; })],
      ["a head marked without a value that has one", spoil("content_nodes", (w) => { w.heads = [{ ...(w as unknown as Record<string, unknown>), heads: undefined, contentHash: "", seq: w.seq + 100, value: "x", valueless: true } as never]; })],
      ["a paragraph row's kept note that is not a note id", spoil("block_nodes", (w) => { w.field = "note"; (w as unknown as Record<string, unknown>).kept = { text: "not a note" }; })],
      // round 10, point 2: an emptied id is an id of the key it names, for every unit a foreign key empties (a note's parent has no check of its own); and a value
      // kept where none may be kept is refused with the code, not by the database's CHECK
      ["a note's kept parent that is not an id", spoil("content_nodes", (w) => { w.field = "parent"; (w as unknown as Record<string, unknown>).kept = { text: "x" }; })],
      ["a value kept on a table that keeps none", spoil("content_nodes", (w) => { w.field = "title"; (w as unknown as Record<string, unknown>).kept = { text: "a title" }; })],
    ];
    for (const [what, page] of cases) {
      const shell = await openNode(`shell-${cases.findIndex((c) => c[0] === what)}`);
      open.push(shell);
      await onNode(shell, () => startJoin({ workspaceId: world.ws, sourceNode: cap.summary.source, cutSeq: cap.summary.cut, personActorId: world.owner.id, former: cap.summary.former }));
      expect(await codeOf(onNode(shell, () => applyJoinPage(page))), what).toBe("join_stamp_shape");
      expect((await onNode(shell, () => q<{ n: string }>(`SELECT count(*)::text AS n FROM sync_stamps WHERE workspace_id = $1`, [world.ws]))).rows[0]!.n, what).toBe("0");
      await onNode(shell, () => abandonJoin(world.ws));
    }
  }, 600_000);
});
