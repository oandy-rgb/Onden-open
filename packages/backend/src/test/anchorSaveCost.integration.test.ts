// What migration 215 adds to one save (review of PR #1853, point 3): a note with N anchors and a body of S KB, one character typed at its start (every anchor moves), on a
// node with the triggers of 215 and on a node where they are dropped (the write path of main before 215: same code, no anchor or paragraph stamps, no hash guard).
// Rows the database read and wrote (pg_stat_user_tables) are asserted; time is printed, never asserted (a shared machine stretches it).
// All the anchors' places of a note are one unit (note_anchor_places, round 2 of the review, point 2): a save writes that one row and its one stamp, so the rows written
// above main's do not grow with the number of anchors; the bound below is the same constant for 50 and 200 anchors. Measured 2026-11-17 (PR description).
import { afterEach, describe, expect, it } from "vitest";
import { q } from "../db.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { awaitCountsOfEveryConnection } from "./helpers/statisticsOfEveryConnection.js";
import { buildSourceWorld, openNode } from "./helpers/stampedWorld.js";
import { admit, exchange, peerOf } from "./helpers/stampedBundleWorld.js";
import { capture, fillFrom } from "./helpers/stampedWorld.js";
import { seedQ } from "./helpers/seedQ.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { stampTransaction } from "../spine/stamps.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

const WORDS = "the of and to in is was for on with as by at from that this which be are have it an or not but".split(" ");
const para = (i: number) => `Paragraph ${i}: ` + Array.from({ length: 14 }, (_, k) => WORDS[(i * 7 + k * 3) % WORDS.length]).join(" ") + ` number ${i} {sized}`;
const TRIGGERS_215 = ["block_anchors_sync_stamp_insert", "block_anchors_sync_stamp_update", "block_anchors_sync_stamp_rekey_gone", "block_anchors_sync_stamp_rekey_made",
  "block_anchors_go_with_note", "block_anchors_made_afresh", "block_anchors_in_notes_workspace_insert", "block_anchors_in_notes_workspace_update",
  "block_anchors_hash_is_body_insert", "block_anchors_hash_is_body_update", "block_anchors_unit_follows_insert", "block_anchors_unit_follows_update", "block_anchors_unit_follows_delete"];
const NODE_TRIGGERS_215 = ["block_nodes_sync_stamp_insert", "block_nodes_sync_stamp_update", "block_nodes_go_with_note", "block_nodes_made_afresh",
  "block_nodes_in_notes_workspace_insert", "block_nodes_in_notes_workspace_update"];

/** Rows read and written so far in this database, once every connection's counts are in (helpers/statisticsOfEveryConnection.ts: the work a save leaves after its
 *  commit is awaited, then every connection sends its counts). Review of PR #1853, round 3 point 5 (a save counted short by a whole save under a parallel batch) and
 *  round 4 point 5 (no waiting on the clock). */
async function stats(): Promise<{ read: number; written: number }> {
  await awaitCountsOfEveryConnection();
  const r = (await q<{ r: string; w: string }>(`SELECT (sum(seq_tup_read) + sum(COALESCE(idx_tup_fetch, 0)))::text AS r, (sum(n_tup_ins) + sum(n_tup_upd) + sum(n_tup_del))::text AS w FROM pg_stat_user_tables`)).rows[0]!;
  return { read: Number(r.r), written: Number(r.w) };
}
/** Rows written above main's by one save, for any number of anchors: the unit row and its stamp row, with room for the statistics' own noise. */
const WRITTEN_MORE = 6;
type Cost = { anchors: number; ms: number; read: number; written: number };
async function saveCost(n: number, kb: number, without215: boolean): Promise<Cost> {
  const node = await openNode(without215 ? "main" : "branch");
  open.push(node);
  const world = await buildSourceWorld(node);
  const a = peerOf("A", node, world);
  return onNode(node, async () => {
    if (without215) for (const [t, table] of [...TRIGGERS_215.map((x) => [x, "block_anchors"]), ...NODE_TRIGGERS_215.map((x) => [x, "block_nodes"])]) await q(`DROP TRIGGER IF EXISTS ${t} ON ${table}`);
    const head = Array.from({ length: n }, (_, i) => para(i)).join("\n\n");
    const note = (await a.call("POST", "/api/nodes", { title: `S ${n} ${kb}`, markdown: head, space_id: a.space })).id as string;
    let body = head + "\n\n" + Array.from({ length: Math.max(0, Math.ceil((kb * 1024 - head.length) / 80)) }, (_, i) => `Filler line ${i} with some words to make the body long enough here.`).join("\n\n");
    await a.call("PATCH", `/api/nodes/${note}`, { markdown: body });
    const anchors = Number((await q<{ c: string }>(`SELECT count(*)::text AS c FROM block_anchors WHERE note_id = $1`, [note])).rows[0]!.c);
    // current statistics, as autovacuum keeps them on a server: in a database just made, a plan is chance (an autovacuum in the middle of the run flipped one, in a
    // run of the whole batch on real Postgres: 11,757 rows read instead of 766 for the same save; alone, five runs of 766)
    await q(`ANALYZE`);
    const ms: number[] = []; let read = 0, written = 0;
    for (let k = 0; k < 7; k++) {
      body = (k % 2 ? "X" : "Y") + body.slice(1);
      const s0 = await stats(); const t = performance.now();
      await a.call("PATCH", `/api/nodes/${note}`, { markdown: body });
      const dt = performance.now() - t; const s1 = await stats();
      if (k >= 2) { ms.push(dt); read += s1.read - s0.read; written += s1.written - s0.written; }
    }
    ms.sort((x, y) => x - y);
    return { anchors, ms: Math.round(ms[2]!), read: Math.round(read / 5), written: Math.round(written / 5) };
  });
}

describe.skipIf(!isTestDb)("what migration 215 adds to a save of a note with anchors", () => {
  for (const [n, kb] of [[200, 20], [50, 200]] as const) {
    it(`${n} anchors, ${kb} KB, one character typed: rows read at most 1.5 times, rows written a constant more whatever the anchor count (time printed)`, async () => {
      const before = await saveCost(n, kb, true), after = await saveCost(n, kb, false);
      console.log(`[anchor save cost] ${n} anchors, ${kb} KB: without 215 ${JSON.stringify(before)}; with 215 ${JSON.stringify(after)}`);
      expect(after.anchors).toBe(n);
      // the measurement counted the save at all: before 215 a save already writes every anchor's row (a count of nothing passes every bound below)
      expect(before.written).toBeGreaterThanOrEqual(n);
      expect(after.read / before.read).toBeLessThanOrEqual(1.5);
      // the note's one anchors unit and its stamp, the body's paragraph rows' stamps that changed (none here: typing does not move a paragraph's id), nothing per anchor
      expect(after.written - before.written).toBeLessThanOrEqual(WRITTEN_MORE);
    }, 600_000);
  }
});

// Round 10, point 1: what keeps an emptied id on its stamp (migration 215 sync_keep_emptied_id, dbUnits.ts namesMissingRow / clearMissingRefs) costs a look-up on a
// key, never a read of a whole table. A person's emptying of 50 tasks and 50 parents (「取消任務」, a move to the top level) reads about what it reads without those
// triggers; a bundle that brings notes with a parent reads a few rows per note it brings. Both on a node that holds BULK more notes, so a read of the whole notes table
// (what a comparison as text costs: no index on id::text) shows as BULK rows per look-up; on the small test world a table fits in one page and a scan costs no more.
const BULK = 3000;
const bulkNotes = (ws: string, space: string) => seedQ(`INSERT INTO content_nodes (id, workspace_id, source_type, node_type, title, slug, markdown, space_id)
  SELECT gen_random_uuid(), $1, 'manual', 'content', 'bulk ' || g, 'keep-bulk-' || g, '', $2 FROM generate_series(1, $3::int) g`, [ws, space, BULK]);
const KEEP_TRIGGERS = [["block_nodes_keep_emptied_id", "block_nodes"], ["content_nodes_keep_emptied_id", "content_nodes"]] as const;
describe.skipIf(!isTestDb)("keeping an emptied id costs a look-up, not a table", () => {
  /** On one node, two batches of 50 children with a task each: one emptied with the triggers disabled, the other with them (the same database, so the same plans). */
  async function emptying(): Promise<{ without: number; withThem: number }> {
    const node = await openNode("keep");
    open.push(node);
    const world = await buildSourceWorld(node);
    const a = peerOf("A", node, world);
    return onNode(node, async () => {
      const batch = async (name: string) => {
        const root = (await a.call("POST", "/api/nodes", { title: name, markdown: "", space_id: a.space })).id as string;
        for (let i = 0; i < 50; i++) {
          const kid = (await a.call("POST", "/api/nodes", { title: `${name} ${i}`, markdown: "", space_id: a.space, parent_id: root })).id as string;
          await seedQ(`INSERT INTO block_nodes (workspace_id, note_id, block_ref, kind, label, text_cache, task_id) VALUES ($1, $2, $3, 'listItem', 't', 't', $4)`, [a.ws, root, `cost${i}`, kid]);
        }
        return root;
      };
      const [r1, r2] = [await batch("Off"), await batch("On")];
      await bulkNotes(a.ws, a.space);
      await q(`ANALYZE`);
      const empty = async (root: string) => {
        const s0 = await stats();
        await withEventTransaction(a.ws, async () => {
          await stampTransaction(a.ws, a.owner.id);
          await q(`UPDATE block_nodes SET task_id = NULL WHERE note_id = $1`, [root]);
          await q(`UPDATE content_nodes SET parent_id = NULL WHERE parent_id = $1`, [root]);
        });
        return (await stats()).read - s0.read;
      };
      for (const [t, table] of KEEP_TRIGGERS) await seedQ(`ALTER TABLE ${table} DISABLE TRIGGER ${t}`);
      const without = await empty(r1);
      for (const [t, table] of KEEP_TRIGGERS) await seedQ(`ALTER TABLE ${table} ENABLE TRIGGER ${t}`);
      return { without, withThem: await empty(r2) };
    });
  }
  it("a person empties 50 tasks and 50 parents: about the rows read without the triggers (a key look-up each at most)", async () => {
    const { without, withThem } = await emptying();
    console.log(`[emptied id cost] 50 tasks and 50 parents emptied: read without the triggers ${without}, with ${withThem}`);
    // one look-up of the paragraph row's note per emptied task (its stamps are written: nothing kept); nothing for a parent a person empties
    // (measured +50: before the look-up took its id into a variable, sync_column's volatile call kept it off the key index, +900 on this world)
    expect(withThem - without).toBeLessThanOrEqual(100);
  }, 600_000);

  async function bundleOfParented(n: number): Promise<number> {
    const [na, nb] = [await openNode(`pa${n}`), await openNode(`pb${n}`)];
    open.push(na, nb);
    const world = await buildSourceWorld(na);
    const a = peerOf("A", na, world);
    const cap = await capture(na, world, 12_000);
    await fillFrom(nb, world, cap);
    const b = peerOf("B", nb, world);
    await admit(a, b); await admit(b, a);
    await onNode(na, async () => {
      const root = (await a.call("POST", "/api/nodes", { title: "Root", markdown: "", space_id: a.space })).id as string;
      for (let i = 0; i < n; i++) await a.call("POST", "/api/nodes", { title: `Child ${i}`, markdown: "", space_id: a.space, parent_id: root });
    });
    await onNode(nb, async () => { await bulkNotes(b.ws, b.space); await q(`ANALYZE`); });
    const s0 = await onNode(nb, () => stats());
    await exchange(a, b);
    return (await onNode(nb, () => stats())).read - s0.read;
  }
  it("a bundle of notes with a parent reads a few rows per note it brings, not the notes table", async () => {
    const small = await bundleOfParented(50), large = await bundleOfParented(200);
    const perNote = (large - small) / 150;
    console.log(`[emptied id cost] a bundle of notes with a parent: 50 notes read ${small}, 200 notes read ${large}, ${perNote.toFixed(1)} per note more (${BULK} notes held)`);
    expect(perNote).toBeLessThanOrEqual(BULK / 10);
  }, 900_000);
});

