// Anchors, paragraph rows and task notes are replicated (anchors proposal 2026-11-16 §3.1 design A, steps 2-3; migration 215): the node where the person wrote mints
// every id once and writes the anchors' places in the same transaction as the body; the other nodes take them as they came and never work them out again from text
// they received. Here three nodes take the same writes in different batches and orders, a task line is written, edited and ticked on three nodes, a node is offline
// while anchors are reassigned, and a body conflict is kept with each version's anchors. Both engines: a node is a PGlite, or a database of the real server.
//
// What is compared is what replicates: an anchor's id, note and place; a paragraph row's id, note, anchor, ref, task link and detached state; the task notes. A paragraph
// row's label, text and parent are worked out from the body by each write (spine/syncClasses.json block_nodes): a receiver re-derives them only after batch 2b-2b.
import { afterEach, describe, expect, it } from "vitest";
import { q, withTransaction } from "../db.js";
import { sha256Hex } from "../utils.js";
import { derivedId } from "../services/derivedIds.js";
import { derivedIdName } from "@onden/markdown";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, fillFrom, openNode } from "./helpers/stampedWorld.js";
import { admit, exchange, makeRng, markWorld, peerOf, resendAll, take, writeFor, type Peer } from "./helpers/stampedBundleWorld.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { seedQ } from "./helpers/seedQ.js";
import { readUnit } from "../spine/stampedMerge/dbUnits.js";
import { anchorsOfVersion, type AnchorFact } from "../spine/stampedMerge/body.js";
import type { Unit } from "../spine/stampedMerge/unit.js";
import { FIND_BUDGET, recoverAnchors, rehomeAnchor, renameAnchor, retireAnchor } from "../services/blockAnchors/index.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { stampTransaction } from "../spine/stamps.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

/** A holds the world; B and C join it by snapshot and every node may send to every other. */
async function threeNodes(seed: number): Promise<{ a: Peer; b: Peer; c: Peer; world: Awaited<ReturnType<typeof buildSourceWorld>> }> {
  const [na, nb, nc] = [await openNode("a"), await openNode("b"), await openNode("c")];
  open.push(na, nb, nc);
  const world = await buildSourceWorld(na);
  const a = peerOf("A", na, world);
  await markWorld(a);
  await writeFor(a, makeRng(700 + seed), 6, { weights: { title: 0, body: 0, move: 0, reorder: 0, trash: 0, undelete: 0, purge: 0, recreate: 0 } });
  const cap = await capture(na, world, 12_000);
  await fillFrom(nb, world, cap);
  await fillFrom(nc, world, cap);
  const b = peerOf("B", nb, world), c = peerOf("C", nc, world);
  for (const [x, y] of [[a, b], [a, c], [b, a], [b, c], [c, a], [c, b]] as const) await admit(x, y);
  for (const p of [a, b, c]) await onNode(p.node, () => setModulesOn(p.ws, null));
  return { a, b, c, world };
}

type Replicated = { anchors: string[]; rows: string[]; tags: string[]; tasks: string[] };
/** Everything a body write replicates of one note, as text that compares byte for byte. Not compared, because they are not replicated (spine/syncClasses.json block_nodes):
 *  a paragraph row's label, text_cache, kind, parent and hidden state are worked out from the body and its anchors by each write, and a receiver works them out only at its
 *  own next save (batch 2b-2b; "nested paragraphs" below pins the parent); an anchor's moved_how / moved_at are this node's own record. */
const replicated = (p: Peer, note: string): Promise<Replicated> => onNode(p.node, async () => ({
  anchors: (await q<{ r: string }>(
    `SELECT jsonb_build_object('id', anchor_id, 'note', note_id, 'from', from_utf16, 'to', to_utf16, 'hash', at_body_hash, 'quote', quote, 'prefix', quote_prefix, 'suffix', quote_suffix,
            'status', status, 'cf', candidate_from_utf16, 'ct', candidate_to_utf16, 'pending', recovery_pending)::text AS r
       FROM block_anchors WHERE workspace_id = $1 AND note_id = $2 ORDER BY anchor_id`, [p.ws, note])).rows.map((x) => x.r),
  rows: (await q<{ r: string }>(
    `SELECT jsonb_build_object('id', id, 'note', note_id, 'anchor', anchor_id, 'ref', block_ref, 'task', task_id, 'detached', detached_note_id)::text AS r
       FROM block_nodes WHERE workspace_id = $1 AND note_id = $2 ORDER BY id`, [p.ws, note])).rows.map((x) => x.r),
  tags: (await q<{ r: string }>(
    `SELECT t.block_node_id::text || ' ' || t.tag_id::text AS r FROM block_node_tags t JOIN block_nodes b ON b.id = t.block_node_id
      WHERE b.workspace_id = $1 AND b.note_id = $2 ORDER BY 1`, [p.ws, note])).rows.map((x) => x.r),
  tasks: (await q<{ r: string }>(
    `SELECT jsonb_build_object('id', c.id, 'title', c.title, 'deleted', c.deleted_at IS NOT NULL,
            'status', (SELECT a.value FROM node_attributes a WHERE a.node_id = c.id AND a.key = '_task_status'))::text AS r
       FROM content_nodes c WHERE c.workspace_id = $1 AND c.parent_id = $2 ORDER BY c.id`, [p.ws, note])).rows.map((x) => x.r),
}));
/** Notes of the workspace whose anchors unit is not what their rows make (migration 215 note_anchor_places_of), and notes with anchor rows and no unit. */
const unitNotRows = (p: Peer) => onNode(p.node, async () => (await q<{ differ: number; missing: number }>(
  `SELECT (SELECT count(*)::int FROM note_anchor_places x WHERE x.workspace_id = $1 AND x.places->'a' IS DISTINCT FROM note_anchor_places_of(x.workspace_id, x.note_id, x.places->>'h')) AS differ,
          (SELECT count(DISTINCT a.note_id)::int FROM block_anchors a WHERE a.workspace_id = $1 AND NOT EXISTS (SELECT 1 FROM note_anchor_places x WHERE x.note_id = a.note_id)) AS missing`,
  [p.ws])).rows[0]!);
const unitHeads = (p: Peer, note: string) => onNode(p.node, async () => Number((await q<{ n: string }>(
  `SELECT count(*)::text AS n FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = 'note_anchor_places' AND row_key = $2`, [p.ws, note])).rows[0]!.n));
/** The other heads of a note's anchors unit, every column but the workspace: what a joiner must hold as its source does. */
const headsOf = (p: Peer, note: string) => onNode(p.node, async () => (await q<{ r: string }>(
  `SELECT (to_jsonb(h) - 'workspace_id')::text AS r FROM sync_stamp_heads h WHERE workspace_id = $1 AND table_name = 'note_anchor_places' AND row_key = $2 ORDER BY origin, seq`, [p.ws, note])).rows.map((r) => r.r));
const body = (p: Peer, note: string) => onNode(p.node, async () => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [note])).rows[0]!.markdown);
const write = (p: Peer, note: string, markdown: string) => onNode(p.node, () => p.call("PATCH", `/api/nodes/${note}`, { markdown }));
const newNote = async (p: Peer, id: string, title: string) => onNode(p.node, async () => (await p.call("POST", "/api/nodes", { id, title, markdown: "", space_id: p.space })).id as string);

const P = [
  "# Plan for the week",
  "Read the chapter on consensus before Tuesday and write down three questions {plan}",
  "- [ ] send the draft to the group {task}",
  "A paragraph about something else entirely, long enough to be found again by its words.",
  "Last paragraph, the closing thoughts of this note {^closing}",
];
const doc = (ps: readonly string[]) => ps.join("\n\n") + "\n";
/** A series of body writes: paragraphs edited, moved, one rewritten so its anchor is lost, one put back. */
const SERIES: string[] = [
  doc(P),
  doc([P[0]!, P[1]!.replace("three", "four"), P[2]!, P[3]!, P[4]!]),
  doc([P[0]!, P[3]!, P[1]!.replace("three", "four"), P[2]!, P[4]!]),
  doc([P[0]!, P[3]!, "Something written over the first paragraph from the ground up {plan}", P[2]!, P[4]!]),
  doc([P[0]!, P[3]!, "Something written over the first paragraph from the ground up {plan}", P[2]!.replace("the draft", "the second draft"), P[4]!, "- [ ] and one more task line {task}"]),
];

describe.skipIf(!isTestDb)("a body write's anchors, paragraph rows and task notes on three nodes", () => {
  it("the same series of body writes, taken in different batches and orders, leaves the same anchors, paragraph rows and task notes (ids included) on all three", async () => {
    const { a, b, c } = await threeNodes(1);
    const note = await newNote(a, "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a", "Week");
    for (const p of [b, c]) await exchange(a, p);
    // B takes every write as it is made; C takes nothing until the end, and then gets B's copy first and A's after
    for (const markdown of SERIES) { await write(a, note, markdown); await exchange(a, b); }
    await exchange(b, c);
    await exchange(a, c);
    const [ra, rb, rc] = [await replicated(a, note), await replicated(b, note), await replicated(c, note)];
    expect(ra.anchors.length).toBeGreaterThan(3);
    expect(ra.rows.length).toBeGreaterThan(2);
    expect(ra.tasks.length).toBe(2);
    expect(rb).toEqual(ra);
    expect(rc).toEqual(ra);
    // and every anchor of the note carries the hash of the body all three hold
    const h = sha256Hex(await body(c, note));
    for (const r of rc.anchors) expect(JSON.parse(r).hash).toBe(h);
    // a paragraph row made by a save has the id derived from its anchor's (review point 1a): any node that makes the row for that anchor makes the same row
    for (const r of rc.rows) { const row = JSON.parse(r); expect(row.id).toBe(derivedId(derivedIdName.blockNode(c.ws, row.anchor))); }
    // and on every node, every note's anchors unit is its rows (round 2, point 2b): no note's unit says other than its rows, none has rows and no unit
    for (const p of [a, b, c]) expect(await unitNotRows(p), p.name).toEqual({ differ: 0, missing: 0 });
  }, 600_000);

  it("A writes a task line, B edits the line's text, C ticks it: one task note everywhere, with all three changes", async () => {
    const { a, b, c } = await threeNodes(2);
    const note = await newNote(a, "2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b", "Errands");
    await write(a, note, "Today\n\n- [ ] buy the train ticket {task}\n");
    for (const p of [b, c]) await exchange(a, p);
    await write(b, note, "Today\n\n- [ ] buy the train ticket to Tainan {task}\n");
    await exchange(b, c);
    await write(c, note, "Today\n\n- [x] buy the train ticket to Tainan {task}\n");
    for (const [x, y] of [[c, a], [c, b], [b, a]] as const) await exchange(x, y);
    const all = [await replicated(a, note), await replicated(b, note), await replicated(c, note)];
    for (const r of all) {
      expect(r.tasks).toHaveLength(1);
      expect(JSON.parse(r.tasks[0]!)).toMatchObject({ title: "buy the train ticket to Tainan", deleted: false, status: "done" });
      expect(r).toEqual(all[0]);
    }
    const line = JSON.parse(all[0]!.rows.find((x) => JSON.parse(x).task !== null)!);
    expect(line.task).toBe(JSON.parse(all[0]!.tasks[0]!).id);
  }, 600_000);

  it("a node that is offline while the anchors are reassigned takes them as they are when it comes back", async () => {
    const { a, b, c } = await threeNodes(3);
    const note = await newNote(a, "3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c", "Reassigned");
    for (const p of [b, c]) await exchange(a, p);
    await write(a, note, SERIES[0]!);
    for (const p of [b, c]) await exchange(a, p);
    // C is offline: A and B take turns rewriting, moving and losing paragraphs
    for (const [i, p] of [[1, a], [2, b], [3, a], [4, b]] as const) {
      await write(p, note, SERIES[i]!);
      await exchange(p, p === a ? b : a);
    }
    await exchange(b, c); // back: one bundle
    const [ra, rb, rc] = [await replicated(a, note), await replicated(b, note), await replicated(c, note)];
    expect(rb).toEqual(ra);
    expect(rc).toEqual(ra);
    expect(ra.anchors.some((r) => JSON.parse(r).status !== "valid"), "the rewrite left an anchor that is not valid").toBe(true);
  }, 600_000);

  it("a body conflict that is kept: each version's anchors stay with it, the same on both nodes", async () => {
    const { a, b } = await threeNodes(4);
    const note = await newNote(a, "4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d", "Two minds");
    await write(a, note, SERIES[0]!);
    await exchange(a, b);
    // both rewrite the same paragraph without hearing from each other
    await write(a, note, doc([P[0]!, "A's own words for the first paragraph, nothing like what was there", P[2]!, P[3]!, P[4]!]));
    await write(b, note, doc([P[0]!, P[3]!, "B's version of it, written on the other node", P[2]!, P[4]!, "B adds a closing line {^bclose}"]));
    const own = { a: await replicated(a, note), b: await replicated(b, note) };
    const texts = { a: await body(a, note), b: await body(b, note) };
    await exchange(a, b); await exchange(b, a);
    const atA = await replicated(a, note), atB = await replicated(b, note);
    expect(atB).toEqual(atA);
    // what is stored: the body that shows is one of the two; every anchor row is measured on it (the rows are the expansion of the anchors unit's head that goes with
    // the stored body: an anchor only the other version holds stands nowhere, `lost`)
    const shown = sha256Hex(await body(a, note));
    expect([sha256Hex(texts.a), sha256Hex(texts.b)]).toContain(shown);
    expect(atA.anchors.map((r) => JSON.parse(r).hash).every((h: string) => h === shown)).toBe(true);
    // the body unit has both texts, the anchors unit a head for each; for each body, the anchors measured on it are the ones its writer wrote
    const versions = async (p: Peer) => onNode(p.node, async () => {
      const places: Unit = (await readUnit(p.ws, { table: "note_anchor_places", row: note, field: "places" }))!;
      const bodyUnit = (await readUnit(p.ws, { table: "content_nodes", row: note, field: "body" }))!;
      return { places, texts: bodyUnit.filter((h) => !h.deleted).map((h) => h.value as string).sort() };
    });
    const asFacts = (r: Replicated): AnchorFact[] => r.anchors.map((x) => JSON.parse(x)).map((x) => ({
      anchorId: x.id, status: x.status, from: x.from, to: x.to, candidate: x.cf === null ? null : { from: x.cf, to: x.ct }, quote: x.quote, prefix: x.prefix, suffix: x.suffix, recoveryPending: x.pending,
    }));
    for (const p of [a, b]) {
      const v = await versions(p);
      expect(v.texts).toEqual([texts.a, texts.b].sort());
      expect(anchorsOfVersion(v.places, sha256Hex(texts.a), texts.a.length)).toEqual(asFacts(own.a));
      expect(anchorsOfVersion(v.places, sha256Hex(texts.b), texts.b.length)).toEqual(asFacts(own.b));
    }
  }, 600_000);

  // "Find again" (the background pass over anchors a save had no budget for, services/blockAnchors/recover.ts) is an ordinary stamped write (owner's answer 6):
  // any node may run it; the same body and anchors give the same rows, so two nodes doing it write the same content, which the merge core does not count as a conflict.
  it("find again on two nodes: the same rows on both, and after they exchange no unit holds two different values", async () => {
    const { a, b } = await threeNodes(5);
    const note = await newNote(a, "5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e", "Shuffled");
    const ps = Array.from({ length: FIND_BUDGET + 4 }, (_, i) => `Paragraph number ${i} talks about its own topic ${"abcdefghijklmnop"[i]} at some length {plan}`);
    await write(a, note, doc(ps));
    // a body whose anchors were not measured on it (as anchorPath.integration.test.ts makes one), then a save: every anchor is looked up, more than one save may, so some are left pending
    await onNode(a.node, () => seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [note, doc([...ps].reverse())]));
    await write(a, note, doc([...ps].reverse()) + "\n");
    await exchange(a, b);
    const pending = (p: Peer) => onNode(p.node, async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM block_anchors WHERE note_id = $1 AND recovery_pending`, [note])).rows[0]!.n));
    expect(await pending(b)).toBeGreaterThan(0);
    for (const p of [a, b]) await onNode(p.node, () => recoverAnchors(p.ws, note));
    expect([await pending(a), await pending(b)]).toEqual([0, 0]);
    expect(await replicated(b, note)).toEqual(await replicated(a, note));
    await exchange(a, b); await exchange(b, a);
    expect(await replicated(b, note)).toEqual(await replicated(a, note));
    // every other head of the note's anchors unit says what the unit says (the same content is not a conflict)
    for (const p of [a, b]) {
      const differing = await onNode(p.node, async () => (await q<{ n: string }>(
        `SELECT count(*)::text AS n FROM sync_stamp_heads h JOIN note_anchor_places x ON x.note_id::text = h.row_key
          WHERE h.workspace_id = $2 AND h.table_name = 'note_anchor_places' AND h.field = 'places' AND x.note_id = $1 AND h.value IS DISTINCT FROM x.places::text`,
        [note, p.ws])).rows[0]!.n);
      expect(Number(differing), p.name).toBe(0);
    }
  }, 600_000);

  // review of PR #1853, point 4: new anchor ids have 48 random bits (@onden/markdown newBlockId), but two nodes can still mint the same one. Then the two anchors are ONE row
  // to the merge (the row key is the id): its `*` and `note` are two heads each, the larger stamp shows, the other stays a conflict on both nodes. Pinned as it is today.
  it("two nodes mint the same anchor id in two different notes: one row on both nodes, the other anchor kept only as a conflicting head", async () => {
    const { a, b } = await threeNodes(6);
    const n1 = await newNote(a, "6f6f6f6f-6f6f-4f6f-8f6f-6f6f6f6f6f6f", "First");
    const n2 = await newNote(a, "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a", "Second");
    await write(a, n1, "A paragraph of the first note\n");
    await write(a, n2, "A paragraph of the second note\n");
    await exchange(a, b);
    const mint = (p: Peer, note: string, text: string) => onNode(p.node, () => seedQ(
      `INSERT INTO block_anchors (workspace_id, anchor_id, note_id, from_utf16, to_utf16, at_body_hash, quote) VALUES ($1, 'samesame0001', $2, 0, $3, $4, $5)`,
      [p.ws, note, text.length, sha256Hex(text + "\n"), text]));
    await mint(a, n1, "A paragraph of the first note");
    await mint(b, n2, "A paragraph of the second note");
    await exchange(a, b); await exchange(b, a);
    const of = (p: Peer) => onNode(p.node, async () => ({
      rows: (await q<{ r: string }>(`SELECT note_id::text || ' ' || quote AS r FROM block_anchors WHERE workspace_id = $1 AND anchor_id = 'samesame0001'`, [p.ws])).rows.map((x) => x.r),
      heads: (await q<{ f: string }>(`SELECT field AS f FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = 'block_anchors' AND row_key = 'samesame0001' ORDER BY field`, [p.ws])).rows.map((x) => x.f),
    }));
    const [atA, atB] = [await of(a), await of(b)];
    expect(atB).toEqual(atA);
    expect(atA.rows).toHaveLength(1); // one anchor is in the table, in one of the two notes
    expect(atA.heads).toEqual(["*", "note"]); // the other one's creation and note are heads beside the shown ones (a conflict), on both nodes
    // an anchor a unit names and the node holds no row for in that note (round 2, point 2c): left out. Both notes' units name the id on both nodes; the one row stands
    // in one note, and the other note holds no row for it and nothing else of it
    const [rowNote] = atA.rows[0]!.split(" ");
    const lacking = rowNote === n1 ? n2 : n1;
    for (const p of [a, b]) await onNode(p.node, async () => {
      const unit = (await q<{ places: { a: Record<string, unknown> } }>(`SELECT places FROM note_anchor_places WHERE note_id = $1`, [lacking])).rows[0]!.places;
      expect(Object.keys(unit.a)).toContain("samesame0001");
      expect(Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM block_anchors WHERE note_id = $1 AND anchor_id = 'samesame0001'`, [lacking])).rows[0]!.n)).toBe(0);
    });
  }, 600_000);

  // review of PR #1853, point 7: a paragraph row's parent is worked out from the body (not a unit) and a snapshot or bundle leaves it empty when it makes the row
  // (spine/snapshotTables.json `deferred: ["parent_block_id"]`): the receiver holds the nested rows without their parent until its own next save works it out, and that save
  // records a BLOCK_NODE_UPDATED for each nested row. Pinned as it is today; the receiver working out these columns after a merge is batch 2b-2b.
  it("nested paragraphs: the receiver holds them without their parent until it saves, and that save records BLOCK_NODE_UPDATED for each", async () => {
    const { a, b } = await threeNodes(7);
    const note = await newNote(a, "8b8b8b8b-8b8b-4b8b-8b8b-8b8b8b8b8b8b", "Nested");
    await write(a, note, "- outer item {plan}\n  - inner item one {plan}\n  - inner item two {plan}\n");
    await exchange(a, b);
    const parents = (p: Peer) => onNode(p.node, async () => (await q<{ ref: string; parent: string | null }>(
      `SELECT b.block_ref AS ref, p.block_ref AS parent FROM block_nodes b LEFT JOIN block_nodes p ON p.id = b.parent_block_id WHERE b.note_id = $1 ORDER BY b.label`, [note])).rows);
    const atA = await parents(a), atB = await parents(b);
    expect(atA.filter((r) => r.parent !== null)).toHaveLength(2);
    expect(atB.map((r) => r.parent)).toEqual([null, null, null]); // the rows are there, their parents are not
    const updates = (p: Peer) => onNode(p.node, async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM domain_events WHERE target_id = $1::text AND event_type = 'BLOCK_NODE_UPDATED'`, [note])).rows[0]!.n));
    const before = await updates(b);
    await write(b, note, "- outer item {plan}\n  - inner item one {plan}\n  - inner item two, edited on B {plan}\n");
    expect(await parents(b)).toEqual(atA.map((r) => ({ ...r }))); // B's own save worked the parents out
    expect((await updates(b)) - before).toBe(2);
  }, 600_000);

  // review of PR #1853, point 8a (round 2: the places of a note are one unit): the losing write minted an anchor. The unit's head that goes with the stored body is the
  // winner's, which does not name it: on both nodes its row stands nowhere, `lost`, measured on the stored body. Every anchor row is measured on the stored body.
  it("8a: an anchor minted by the write whose body lost is not a valid row on either node; every anchor row is measured on the stored body", async () => {
    const { a, b } = await threeNodes(8);
    const note = await newNote(a, "9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c9c", "Lost write");
    await write(a, note, "First paragraph stays {plan}\n\nSecond paragraph stays\n");
    await exchange(a, b);
    await write(a, note, "First paragraph stays {plan}\n\nSecond paragraph stays\n\nA new paragraph only A writes {plan}\n"); // mints an anchor
    await write(b, note, "First paragraph stays {plan}\n\nSecond paragraph stays, B edited it\n"); // later: its stamp is larger
    await exchange(a, b); await exchange(b, a);
    const [ra, rb] = [await replicated(a, note), await replicated(b, note)];
    expect(rb).toEqual(ra);
    const stored = sha256Hex(await body(a, note));
    const rows = ra.anchors.map((r) => JSON.parse(r));
    expect(rows.every((x) => x.hash === stored)).toBe(true);
    expect(rows.find((x) => x.quote === "A new paragraph only A writes {plan}")).toMatchObject({ status: "lost", from: 0, to: 0, cf: null });
  }, 600_000);

  // point 8b: a write of places only (a person retires the anchor as lost) on A AFTER B wrote the body, without hearing of it: two heads of the note's anchors unit, A's
  // the newer. The head that shows is the one measured on the stored body (B's), not the newer one; A's stays a conflict a person can see, on both nodes.
  it("8b: a write of places only, newer than another node's body write: the rows show the head measured on the stored body, the other is a conflict", async () => {
    const { a, b } = await threeNodes(9);
    const note = await newNote(a, "adadadad-adad-4dad-8dad-adadadadadad", "Place only");
    await write(a, note, "Only paragraph here {plan}\n");
    await exchange(a, b);
    await write(b, note, "Only paragraph here, B edited it {plan}\n");
    await onNode(a.node, () => withTransaction(() => seedQ(`UPDATE block_anchors SET status = 'lost', from_utf16 = 0, to_utf16 = 0 WHERE note_id = $1`, [note]))); // later than B's write
    await exchange(a, b); await exchange(b, a);
    const [ra, rb] = [await replicated(a, note), await replicated(b, note)];
    expect(rb).toEqual(ra);
    expect(JSON.parse(ra.anchors[0]!)).toMatchObject({ status: "valid", hash: sha256Hex(await body(a, note)) }); // B's body, B's places
    const heads = (p: Peer) => onNode(p.node, async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = 'note_anchor_places' AND field = 'places'`, [p.ws])).rows[0]!.n));
    expect([await heads(a), await heads(b)]).toEqual([1, 1]);
  }, 600_000);

  // round 2, point 4: "find again" is a system job's write (recover.ts). On a note whose anchors unit holds two heads it is refused (sync_unit_in_conflict) and the heads
  // stay for a person; on a note without a conflict it is taken. Neither counts as a write without `mutate` (sync_clock.writes_without_mutate).
  it("find again meets a note whose anchors unit has two heads: refused, the heads stay; elsewhere taken; never a write without mutate", async () => {
    const { a, b } = await threeNodes(12);
    const note = await newNote(a, "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1", "Conflicted");
    const calm = await newNote(a, "e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2", "Calm");
    await write(a, note, "Only paragraph here {plan}\n");
    await write(a, calm, "Only paragraph here {plan}\n");
    await exchange(a, b);
    await write(b, note, "Only paragraph here, B edited it {plan}\n");
    await onNode(a.node, () => withTransaction(() => seedQ(`UPDATE block_anchors SET status = 'lost', from_utf16 = 0, to_utf16 = 0 WHERE note_id = $1`, [note])));
    await exchange(b, a); // A now holds two heads of the note's unit
    const heads = () => onNode(a.node, async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = 'note_anchor_places' AND row_key = $2`, [a.ws, note])).rows[0]!.n));
    const without = () => onNode(a.node, async () => Number((await q<{ n: string }>(`SELECT COALESCE(sum(writes_without_mutate), 0)::text AS n FROM sync_clock WHERE workspace_id = $1`, [a.ws])).rows[0]!.n));
    expect(await heads()).toBe(1);
    // both notes' anchors left pending by a write the stamp triggers stood aside for (so neither unit changes): what a save without budget leaves
    const leavePending = (n: string) => onNode(a.node, () => withTransaction(async () => {
      await q(`SELECT set_config('onden.stamp_import_' || replace($1::text, '-', '_'), 'merge', true)`, [a.ws]);
      await q(`UPDATE block_anchors SET recovery_pending = true, status = 'lost', from_utf16 = 0, to_utf16 = 0 WHERE note_id = $1`, [n]);
    }));
    await leavePending(note); await leavePending(calm);
    const w0 = await without();
    const refused = await onNode(a.node, () => recoverAnchors(a.ws, note).then(() => null, (e: { code?: string; name?: string }) => e.code ?? e.name ?? String(e)));
    expect(refused).toBe("sync_unit_in_conflict");
    expect(await heads()).toBe(1); // the heads stay
    await onNode(a.node, () => recoverAnchors(a.ws, calm));
    expect(await onNode(a.node, async () => (await q<{ s: string }>(`SELECT status AS s FROM block_anchors WHERE note_id = $1`, [calm])).rows.map((r) => r.s))).toEqual(["valid"]);
    expect(await without()).toBe(w0);
  }, 600_000);

  // round 3, point 1: a note with no anchor writes no unit, so a bundle can bring a body and nothing of the anchors. Every note whose body, anchors unit or anchor rows a
  // bundle changes is expanded (RowSource.bearsOn), so the rows follow the stored body on every node, whatever came with the body.
  it("round 3, 1: a bundle that brings only a body still writes the anchor rows: the anchor of the losing write is lost, the same on three nodes", async () => {
    const { a, b, c } = await threeNodes(13);
    const note = await newNote(a, "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1", "Body only");
    await write(a, note, "First paragraph here\n\nSecond paragraph here\n");
    for (const p of [b, c]) await exchange(a, p);
    const bBody = "First paragraph here\n\nSecond paragraph here {plan}\n";
    await write(b, note, bBody); // B tags a paragraph: an anchor X and the note's first unit
    await write(a, note, "First paragraph here, A edited it\n\nSecond paragraph here\n"); // later, so it wins; A holds no anchor and writes no unit
    await exchange(a, b); await exchange(b, a); await exchange(b, c); await exchange(a, c);
    const [ra, rb, rc] = [await replicated(a, note), await replicated(b, note), await replicated(c, note)];
    expect(rb).toEqual(ra);
    expect(rc).toEqual(ra);
    expect(await body(b, note)).toBe("First paragraph here, A edited it\n\nSecond paragraph here\n");
    // no head is measured on the stored body: every anchor row is lost, standing nowhere, measured on the newest head's body (so the next save looks it up)
    expect(ra.anchors.map((r) => JSON.parse(r))).toEqual([expect.objectContaining({ status: "lost", from: 0, to: 0, cf: null, pending: false, hash: sha256Hex(bBody) })]);
  }, 600_000);

  // round 3, point 1: a bundle that brings only a body can make another head of the unit the one that goes with the stored body: the rows follow it.
  it("round 3, 1: a body-only bundle makes another head the one on the stored body: the receiver's rows show that head", async () => {
    const { a, b } = await threeNodes(14);
    const note = await newNote(a, "f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2", "Head switch");
    const b1 = "Only paragraph here {plan}\n";
    await write(a, note, b1);
    await exchange(a, b);
    await write(b, note, "Only paragraph here, B edited it {plan}\n");
    await onNode(a.node, () => withTransaction(() => seedQ(`UPDATE block_anchors SET status = 'lost', from_utf16 = 0, to_utf16 = 0 WHERE note_id = $1`, [note]))); // A's head on b1
    await exchange(a, b); await exchange(b, a); // the 8b state: B's body, two heads
    // a write of the body alone back to b1 on B (a fixture: no product path writes a body without its anchors on a note that has them)
    await onNode(b.node, () => withTransaction(() => seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [note, b1])));
    await exchange(b, a);
    expect(await body(a, note)).toBe(b1);
    expect(JSON.parse((await replicated(a, note)).anchors[0]!)).toMatchObject({ status: "lost", from: 0, to: 0, hash: sha256Hex(b1) }); // A's head, on b1
  }, 600_000);

  // round 3, point 2: an anchor the chosen head does not name takes its words from the newest head that names it, not from the row this node made: C made the row from
  // A's first write (quote q1), A then changed the words (q4) in a write of places only, and B's body (no head on it) wins. Before: C kept q1, A and B had q4.
  it("round 3, 2: an anchor no chosen head names has the same words on three nodes, whatever bundle each took first", async () => {
    const { a, b, c } = await threeNodes(15);
    const note = await newNote(a, "f3f3f3f3-f3f3-4f3f-8f3f-f3f3f3f3f3f3", "Words");
    await exchange(a, b); await exchange(a, c);
    await write(a, note, "Only paragraph here {plan}\n");
    await exchange(a, c); // C makes X's row from A's first write
    await onNode(a.node, () => withTransaction(() => seedQ(`UPDATE block_anchors SET quote = 'the words of the newest head' WHERE note_id = $1`, [note])));
    await write(b, note, "A body B wrote, with no anchor in it\n"); // later than A's writes, so it wins; B holds no anchor
    // C takes B's body first, so A's newer head arrives when no head goes with C's stored body (it is never chosen there); B makes X's row from A's current row (q4)
    await exchange(b, c); await exchange(a, c); await exchange(a, b); await exchange(b, a);
    const [ra, rb, rc] = [await replicated(a, note), await replicated(b, note), await replicated(c, note)];
    expect(rb).toEqual(ra);
    expect(rc).toEqual(ra);
    expect(JSON.parse(ra.anchors[0]!)).toMatchObject({ status: "lost", quote: "the words of the newest head" });
  }, 600_000);

  // round 3, point 11: a person's save on a node whose rows show a head that is not the newest (the 8b state) writes the unit from those rows as a person: the other head
  // is settled, and the nodes agree after one exchange.
  it("round 3, 11: a save on a note in the 8b state settles the unit's heads; both nodes agree", async () => {
    const { a, b } = await threeNodes(16);
    const note = await newNote(a, "f4f4f4f4-f4f4-4f4f-8f4f-f4f4f4f4f4f4", "Settle");
    await write(a, note, "Only paragraph here {plan}\n");
    await exchange(a, b);
    await write(b, note, "Only paragraph here, B edited it {plan}\n");
    await onNode(a.node, () => withTransaction(() => seedQ(`UPDATE block_anchors SET status = 'lost', from_utf16 = 0, to_utf16 = 0 WHERE note_id = $1`, [note])));
    await exchange(a, b); await exchange(b, a);
    await write(a, note, "Only paragraph here, B edited it, A saved again {plan}\n");
    await exchange(a, b); await exchange(b, a);
    expect(await replicated(b, note)).toEqual(await replicated(a, note));
    for (const p of [a, b]) expect(await unitHeads(p, note), p.name).toBe(0);
    for (const p of [a, b]) expect(await unitNotRows(p), p.name).toEqual({ differ: 0, missing: 0 });
  }, 600_000);

  // round 3, point 11: a note deleted for good on one node: its unit and anchor rows go with it, and the deletion travels.
  it("round 3, 11: a note deleted for good: the other node holds no note, no unit and no anchor row after the exchange", async () => {
    const { a, b } = await threeNodes(17);
    const note = await newNote(a, "f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5", "Purged");
    await write(a, note, "Only paragraph here {plan}\n");
    await exchange(a, b);
    await onNode(a.node, () => seedQ(`DELETE FROM content_nodes WHERE id = $1`, [note]));
    await exchange(a, b);
    const left = (p: Peer) => onNode(p.node, async () => (await q<{ n: number; u: number; r: number }>(
      `SELECT (SELECT count(*)::int FROM content_nodes WHERE id = $1) AS n, (SELECT count(*)::int FROM note_anchor_places WHERE note_id = $1) AS u,
              (SELECT count(*)::int FROM block_anchors WHERE note_id = $1) AS r`, [note])).rows[0]);
    expect(await left(b)).toEqual({ n: 0, u: 0, r: 0 });
  }, 600_000);

  // What goes with its note (rounds 5 and 6; migration 215 section 2c and dbRows.ts rowsThatGo, one rule): a row whose note is not on a node went with it. Made in
  // that note: nothing of it is left on any node. Moved into it: its stamps stay, the one record that it went, and a node that holds it where it was removes it when the
  // move reaches it. Each case runs in both orders of arrival and is exchanged until nothing changes; then both nodes hold the same rows, every unit is its rows, and
  // the stamps of the three tables are the same on both (`goneStamps`).
  const settle = async (a: Peer, b: Peer, order: "A first" | "B first") => {
    const pairs = order === "A first" ? [[a, b], [b, a]] as const : [[b, a], [a, b]] as const;
    for (let k = 0; k < 3; k++) for (const [x, y] of pairs) await exchange(x, y);
    await quiet(pairs);
  };
  /** P3 (review of PR #1853, round 8): nodes that exchanged to the end exchange one more round and nothing changes (no unit stored, no row made or removed, no event),
   *  and nothing is refused (`exchange` throws a refusal). */
  const quiet = async (pairs: ReadonlyArray<readonly [Peer, Peer]>) => {
    const none = { stored: 0, created: 0, removed: 0, events: 0 };
    const said = (r: Awaited<ReturnType<typeof exchange>>) => ({ stored: r.stored, created: r.created, removed: r.removed, events: r.events.length });
    for (const [x, y] of pairs) expect(said(await exchange(x, y)), `${x.name} to ${y.name}, one more round`).toEqual(none);
    // round 9, point 5 d: once settled, the sender's WHOLE state sent again (an empty `have`): the receiver takes it, nothing is refused, no row is made or removed,
    // no event, and the stamps and heads of the three tables (values and marks included) are what they were. That round sends what each node stored, not an empty
    // bundle, so it tests that what was stored can be sent as it is. (One unit of another table is stored again, node_attributes: pinned in "round 10, 7".)
    for (const [x, y] of pairs) {
      const before = await threeTables(y);
      const r = await resendAll(x, y);
      expect({ created: r.created, removed: r.removed, events: r.events.filter((e) => THREE.includes(e.address.table)).length }, `${x.name} to ${y.name}, everything again`).toEqual({ created: 0, removed: 0, events: 0 });
      expect(await threeTables(y), `${x.name} to ${y.name}, everything again`).toEqual(before);
    }
  };
  // the three tables, and the others that hold a unit a foreign key empties (round 10, point 7): content_nodes, spaces, rss_subscriptions
  const THREE = ["block_anchors", "block_nodes", "note_anchor_places", "content_nodes", "spaces", "rss_subscriptions"];
  /** Every stamp and head of those tables on `p`, with what each says it wrote. */
  const threeTables = (p: Peer) => onNode(p.node, async () => (await q<{ r: string }>(
    `SELECT 's ' || table_name || ' ' || row_key || ' ' || field || ' ' || deleted || ' ' || origin || ':' || seq || ' ' || saw::text || ' ' || COALESCE(meta::text, '-') || ' ' || COALESCE(kept_value::text, '-') AS r FROM sync_stamps
      WHERE workspace_id = $1 AND table_name = ANY($2)
     UNION ALL SELECT 'h ' || table_name || ' ' || row_key || ' ' || field || ' ' || deleted || ' ' || origin || ':' || seq || ' ' || COALESCE(value, '-') || ' ' || valueless FROM sync_stamp_heads
      WHERE workspace_id = $1 AND table_name = ANY($2) ORDER BY 1`, [p.ws, THREE])).rows.map((x) => x.r));
  /** The product's delete for good (round 9, point 1): the note to the trash, then 「永久刪除」 with the plan its preview gave (services/nodeTrash.ts purgeDeleted: the note
   *  and everything under it, task notes included, in ONE statement). Returns what went. */
  const purge = (p: Peer, id: string) => onNode(p.node, async () => {
    await p.call("DELETE", `/api/nodes/${id}`);
    const plan = (await p.call("GET", `/api/nodes/${id}/purge-preview`)) as { ids: string[] };
    await p.call("POST", `/api/nodes/${id}/purge`, { expected_ids: plan.ids });
    return plan.ids;
  });
  /** The product's moves of a paragraph into a new child note (blockChildNote.ts). `block`: 「獨立出去」 of one block, keeping its identity: the anchor goes to the child
   *  (rehomeAnchor) and the paragraph row stays in the note, standing for the child (markDetached). `selection`: the selected text, whose anchor and paragraph row both
   *  go to the child (adoptAnchorsInto, kind "carry": carryBlockRow moves the row). */
  type Move = "block" | "selection";
  const toChild = (p: Peer, note: string, anchor: string, how: Move = "block") => onNode(p.node, async () => {
    if (how === "block") {
      const ref = (await q<{ r: string }>(`SELECT block_ref AS r FROM block_nodes WHERE workspace_id = $1 AND anchor_id = $2`, [p.ws, anchor])).rows[0]!.r;
      return (await p.call("POST", `/api/nodes/${note}/block-to-child`, { block_ref: ref, keep_identity: true })).child_id as string;
    }
    const a = (await q<{ f: number; t: number; md: string }>(`SELECT a.from_utf16 AS f, a.to_utf16 AS t, c.markdown AS md FROM block_anchors a JOIN content_nodes c ON c.id = a.note_id WHERE a.workspace_id = $1 AND a.anchor_id = $2`, [p.ws, anchor])).rows[0]!;
    return (await p.call("POST", `/api/nodes/${note}/block-to-child`, { selection: { from: a.f, to: a.t, text: a.md.slice(a.f, a.t) } })).child_id as string;
  });
  const firstAnchor = (p: Peer, note: string) => onNode(p.node, async () => (await q<{ id: string }>(`SELECT anchor_id AS id FROM block_anchors WHERE note_id = $1 ORDER BY from_utf16 LIMIT 1`, [note])).rows[0]!.id);
  /** Where anchor `x` and its paragraph row are on `p` (their notes). */
  const whereIs = (p: Peer, x: string) => onNode(p.node, async () => ({
    anchor: (await q<{ n: string }>(`SELECT note_id::text AS n FROM block_anchors WHERE workspace_id = $1 AND anchor_id = $2`, [p.ws, x])).rows.map((r) => r.n),
    row: (await q<{ n: string }>(`SELECT note_id::text AS n FROM block_nodes WHERE workspace_id = $1 AND anchor_id = $2`, [p.ws, x])).rows.map((r) => r.n),
  }));
  /** Every stamp and head of the three tables, as text. A field's stamp that is a copy of its row's creation is left out: the merge keeps that as the `*` alone (storeUnit). */
  const goneStamps = (p: Peer) => onNode(p.node, async () => (await q<{ r: string }>(
    `SELECT 's ' || s.table_name || ' ' || s.row_key || ' ' || s.field || ' ' || s.deleted || ' ' || s.origin || ':' || s.seq AS r FROM sync_stamps s
      WHERE s.workspace_id = $1 AND s.table_name IN ('block_anchors', 'block_nodes', 'note_anchor_places')
        AND NOT (s.field <> '*' AND s.saw = '{}'::jsonb AND s.meta IS NULL AND EXISTS (SELECT 1 FROM sync_stamps t WHERE t.workspace_id = s.workspace_id AND t.table_name = s.table_name
                 AND t.row_key = s.row_key AND t.field = '*' AND t.origin = s.origin AND t.seq = s.seq))
     UNION ALL SELECT 'h ' || table_name || ' ' || row_key || ' ' || field || ' ' || deleted || ' ' || origin || ':' || seq || ' ' || COALESCE(value, '-') FROM sync_stamp_heads
      WHERE workspace_id = $1 AND table_name IN ('block_anchors', 'block_nodes', 'note_anchor_places') ORDER BY 1`, [p.ws])).rows.map((x) => x.r));
  const ORDERS = ["A first", "B first"] as const;

  // A note deleted for good: its anchors, paragraph rows and unit go with it on every node, and nothing of them is left in the stamp tables (round 6, point 3: not the
  // note's text in a head of its unit either). Three versions: the exchange happened before the delete; A wrote the note's anchors after it and deleted the note before
  // sending (round 6, point 4); the note's anchors unit was in conflict (two heads, each with the note's words) when A deleted it.
  for (const version of ["sent before", "an unsent anchor write", "a unit in conflict"] as const) for (const order of ORDERS) {
    it(`round 5, 1 / round 6, 3: a note deleted for good (${version}; ${order}): its anchors, paragraph rows and unit go with it on both nodes, nothing of them left in the stamps`, async () => {
      const { a, b } = await threeNodes(23);
      const note = await newNote(a, "f9f9f9f9-f9f9-4f9f-8f9f-f9f9f9f9f9f9", "Purged with rows");
      const body = "First paragraph here {plan}\n\nSecond paragraph here {plan}\n\n- [ ] a task line {task}\n";
      await write(a, note, body);
      await exchange(a, b);
      if (version === "an unsent anchor write") await write(a, note, "A new opening paragraph, never sent {plan}\n\n" + body.replace("Second paragraph", "Second paragraph, edited"));
      if (version === "a unit in conflict") {
        await write(a, note, body.replace("First paragraph here", "First paragraph here as A wrote it"));
        await write(b, note, body.replace("Second paragraph here", "Second paragraph here as B wrote it"));
        await exchange(a, b); await exchange(b, a);
        expect(await unitHeads(a, note)).toBeGreaterThan(0);
      }
      const keys = await onNode(a.node, async () => [
        ...(await q<{ k: string }>(`SELECT anchor_id AS k FROM block_anchors WHERE note_id = $1`, [note])).rows.map((r) => r.k),
        ...(await q<{ k: string }>(`SELECT id::text AS k FROM block_nodes WHERE note_id = $1`, [note])).rows.map((r) => r.k), note]);
      expect(keys.length).toBeGreaterThan(4);
      await purge(a, note);
      await settle(a, b, order);
      const left = (p: Peer) => onNode(p.node, async () => (await q<{ n: number; u: number; r: number; p: number; s: number; w: number }>(
        `SELECT (SELECT count(*)::int FROM content_nodes WHERE id = $1) AS n, (SELECT count(*)::int FROM note_anchor_places WHERE note_id = $1) AS u,
                (SELECT count(*)::int FROM block_anchors WHERE note_id = $1) AS r, (SELECT count(*)::int FROM block_nodes WHERE note_id = $1) AS p,
                (SELECT count(*)::int FROM sync_stamps WHERE workspace_id = $2 AND table_name IN ('block_anchors', 'block_nodes', 'note_anchor_places') AND row_key = ANY($3)) +
                (SELECT count(*)::int FROM sync_stamp_heads WHERE workspace_id = $2 AND table_name IN ('block_anchors', 'block_nodes', 'note_anchor_places') AND row_key = ANY($3)) AS s,
                (SELECT count(*)::int FROM sync_stamp_heads WHERE workspace_id = $2 AND value LIKE '%paragraph here%')
                + (SELECT count(*)::int FROM sync_stamps WHERE workspace_id = $2 AND kept_value::text LIKE '%paragraph here%') AS w`, [note, p.ws, keys])).rows[0]);
      for (const p of [a, b]) expect(await left(p), p.name).toEqual({ n: 0, u: 0, r: 0, p: 0, s: 0, w: 0 });
      expect(await goneStamps(b)).toEqual(await goneStamps(a));
      for (const p of [a, b]) expect(await unitNotRows(p), p.name).toEqual({ differ: 0, missing: 0 });
    }, 600_000);
  }

  /** A write by `p`'s owner as one stamped transaction (what a route's write is to the stamps). */
  const stampedSql = (p: Peer, sql: string, params: unknown[]) => onNode(p.node, () => withEventTransaction(p.ws, async () => { await stampTransaction(p.ws, p.owner.id); await q(sql, params); }));
  /** Every stamp and head of the given keys of the three tables, NOT filtered (round 7, point 1), with what each says it wrote (round 8, P1): a stamp's kept value (for a
   *  row the node does not hold; `-` where the row's column holds it), a head's value and its mark of having none. Byte for byte. */
  const keyStamps = (p: Peer, keys: string[]) => onNode(p.node, async () => (await q<{ r: string }>(
    `SELECT 's ' || table_name || ' ' || row_key || ' ' || field || ' ' || deleted || ' ' || origin || ':' || seq || ' ' || saw::text || ' ' || COALESCE(kept_value::text, '-') AS r FROM sync_stamps
      WHERE workspace_id = $1 AND table_name IN ('block_anchors', 'block_nodes', 'note_anchor_places') AND row_key = ANY($2)
     UNION ALL SELECT 'h ' || table_name || ' ' || row_key || ' ' || field || ' ' || deleted || ' ' || origin || ':' || seq || ' ' || COALESCE(value, '-') || ' ' || valueless FROM sync_stamp_heads
      WHERE workspace_id = $1 AND table_name IN ('block_anchors', 'block_nodes', 'note_anchor_places') AND row_key = ANY($2) ORDER BY 1`, [p.ws, keys])).rows.map((x) => x.r));
  /** What the stamp tables keep of a row that went with its note (round 7, point 5): its heads' values and its stamps' kept values (round 8) are ids (a note, an anchor
   *  or paragraph ref, a task) or the detached state (a child's id and tag names), never a note's words; and every copy says its value (none is marked without one). */
  const keptValues = (p: Peer, keys: string[]) => onNode(p.node, async () => (await q<{ f: string; v: string | null; bare: boolean }>(
    `SELECT field AS f, value AS v, valueless AS bare FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name IN ('block_anchors', 'block_nodes') AND row_key = ANY($2) AND field <> '*' AND NOT deleted
     UNION ALL SELECT field, kept_value ->> 'text', false FROM sync_stamps WHERE workspace_id = $1 AND table_name IN ('block_anchors', 'block_nodes') AND row_key = ANY($2) AND kept_value IS NOT NULL`, [p.ws, keys])).rows);
  /** A NULL is a value only where the column takes one (a paragraph row with no task, anchor or ref; no child): a note is never NULL (round 8, point 1: a copy without its
   *  value was stored and sent as a NULL note, and refused for ever). */
  const onlyIds = (rows: { f: string; v: string | null; bare: boolean }[]) => rows.every(({ f, v, bare }) => !bare && (v === null ? f !== "note"
    : f === "detached" ? /^\{"detached_tags": (null|\[[^\]]*\]), "detached_note_id": (null|"[0-9a-f-]{36}")\}$/.test(v) : /^[0-9a-f-]{36}$|^[A-Za-z0-9-]{1,64}$/.test(v)));
  const paragraphOf = async (p: Peer, id: string) => onNode(p.node, async () => (await q<{ note: string; task: string | null }>(`SELECT note_id::text AS note, task_id::text AS task FROM block_nodes WHERE workspace_id = $1 AND id = $2`, [p.ws, id])).rows);

  // Round 7, point 1: the stamps a row that went with its note keeps are written back onto what the node held of it (its heads included), never inserted a second time:
  // each case below refused every later bundle for ever before (a head inserted twice, 23505 -> bundle_unique_clash). Both orders; stamps AND heads compared unfiltered.
  for (const order of ORDERS) {
    it(`round 7, 1: a paragraph row made on both nodes with the same id (two creations), moved into a note A then deletes for good (${order}): taken, the same on both`, async () => {
      const { a, b } = await threeNodes(28);
      const note = await newNote(a, "f1a1f1a1-f1a1-4f1a-8f1a-f1a1f1a1f1a1", "Two creations");
      await write(a, note, "A paragraph here\n");
      const md = await body(a, note);
      const x = "r7twocreate1", row = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f01";
      await stampedSql(a, `INSERT INTO block_anchors (workspace_id, anchor_id, note_id, from_utf16, to_utf16, at_body_hash, quote) VALUES ($1, $2, $3, 0, 16, $4, 'A paragraph here')`, [a.ws, x, note, sha256Hex(md)]);
      await exchange(a, b);
      for (const p of [a, b]) await stampedSql(p, `INSERT INTO block_nodes (id, workspace_id, note_id, block_ref, kind, anchor_id) VALUES ($1, $2, $3, 'r7ref', 'paragraph', $4)`, [row, p.ws, note, x]);
      await exchange(a, b); await exchange(b, a);
      expect(await onNode(a.node, async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = 'block_nodes' AND row_key = $2 AND field = '*'`, [a.ws, row])).rows[0]!.n))).toBe(1);
      const target = await newNote(a, "f1a2f1a2-f1a2-4f1a-8f1a-f1a2f1a2f1a2", "Moved into");
      await stampedSql(a, `UPDATE block_nodes SET note_id = $2 WHERE id = $1`, [row, target]);
      await purge(a, target);
      await settle(a, b, order);
      for (const p of [a, b]) expect(await paragraphOf(p, row), p.name).toEqual([]);
      expect(await keyStamps(b, [row, x])).toEqual(await keyStamps(a, [row, x]));
      for (const p of [a, b]) expect(onlyIds(await keptValues(p, [row, x])), p.name).toBe(true);
    }, 600_000);

    it(`round 7, 1: a paragraph row moved on both nodes at once (its note in conflict), another field written, the winning note deleted for good on A (${order}): taken, the same on both`, async () => {
      const { a, b } = await threeNodes(29);
      const note = await newNote(a, "f2a1f2a1-f2a1-4f2a-8f2a-f2a1f2a1f2a1", "Source");
      await write(a, note, "A paragraph here\n");
      const md = await body(a, note);
      const x = "r7conflict01", row = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f02";
      await stampedSql(a, `INSERT INTO block_anchors (workspace_id, anchor_id, note_id, from_utf16, to_utf16, at_body_hash, quote) VALUES ($1, $2, $3, 0, 16, $4, 'A paragraph here')`, [a.ws, x, note, sha256Hex(md)]);
      await stampedSql(a, `INSERT INTO block_nodes (id, workspace_id, note_id, block_ref, kind, anchor_id) VALUES ($1, $2, $3, 'r7ref', 'paragraph', $4)`, [row, a.ws, note, x]);
      const n2 = await newNote(a, "f2a2f2a2-f2a2-4f2a-8f2a-f2a2f2a2f2a2", "To A's");
      const n3 = await newNote(a, "f2a3f2a3-f2a3-4f2a-8f2a-f2a3f2a3f2a3", "To B's");
      await exchange(a, b);
      await stampedSql(a, `UPDATE block_nodes SET note_id = $2 WHERE id = $1`, [row, n2]);
      await stampedSql(b, `UPDATE block_nodes SET note_id = $2 WHERE id = $1`, [row, n3]);
      await exchange(a, b); await exchange(b, a);
      const won = (await paragraphOf(a, row))[0]!.note;
      expect((await paragraphOf(b, row))[0]!.note).toBe(won);
      await stampedSql(a, `UPDATE block_nodes SET task_id = $2 WHERE id = $1`, [row, note]); // another field of the row (what blockTasks.ts writes)
      await purge(a, won);
      await settle(a, b, order);
      for (const p of [a, b]) expect(await paragraphOf(p, row), p.name).toEqual([]);
      expect(await keyStamps(b, [row, x])).toEqual(await keyStamps(a, [row, x]));
      // the note's conflict is kept as a head on both: what is kept is ids
      for (const p of [a, b]) expect((await keptValues(p, [row])).some((h) => h.f === "note"), p.name).toBe(true);
      for (const p of [a, b]) expect(onlyIds(await keptValues(p, [row, x])), p.name).toBe(true);
    }, 600_000);

    // Round 7, point 3 (round 8: the write keeps its value): X's paragraph row is in a child note C on both (moved there by the product's selection move); A sets its
    // task and deletes C for good (the row's stamps stay, each with its value: it was moved there); B at the same time moves the row back into the parent, a newer write
    // of its note. The row stays where B put it, on both, and its task is A's later one: the write travelled with its value. Round 7 lost it (and the column showed
    // whatever each holder had); round 6 wrote it as NULL.
    it(`round 7, 3: a write on a row that went with its note, against a newer move of the row elsewhere (${order}): the write keeps its value, the same on both`, async () => {
      const { a, b } = await threeNodes(30);
      const n1 = await newNote(a, "f3a1f3a1-f3a1-4f3a-8f3a-f3a1f3a1f3a1", "Parent");
      await write(a, n1, "First paragraph here {plan}\n\nSecond paragraph here {plan}\n");
      const x = await firstAnchor(a, n1);
      const child = await toChild(a, n1, x, "selection");
      const held = await newNote(a, "f3a2f3a2-f3a2-4f3a-8f3a-f3a2f3a2f3a2", "The task both hold");
      const later = await newNote(a, "f3a3f3a3-f3a3-4f3a-8f3a-f3a3f3a3f3a3", "The task A sets later");
      const row = await onNode(a.node, async () => (await q<{ id: string }>(`SELECT id::text FROM block_nodes WHERE workspace_id = $1 AND anchor_id = $2`, [a.ws, x])).rows[0]!.id);
      await stampedSql(a, `UPDATE block_nodes SET task_id = $2 WHERE id = $1`, [row, held]);
      await exchange(a, b); await exchange(b, a);
      expect((await paragraphOf(b, row))[0]).toEqual({ note: child, task: held });
      await stampedSql(a, `UPDATE block_nodes SET task_id = $2 WHERE id = $1`, [row, later]);
      await purge(a, child);
      // B moves the row back into the parent at the same time: what carryBlockRow writes (the product's expand-child mints new anchors and rows for text taken back: it
      // does not move this one)
      await stampedSql(b, `UPDATE block_nodes SET note_id = $2 WHERE id = $1`, [row, n1]);
      await settle(a, b, order);
      // A's later task, never NULL and not what each holder happened to hold
      for (const p of [a, b]) expect(await paragraphOf(p, row), p.name).toEqual([{ note: n1, task: later }]);
      for (const p of [a, b]) expect(onlyIds(await keptValues(p, [row, x])), p.name).toBe(true);
      expect(await keyStamps(b, [row, x])).toEqual(await keyStamps(a, [row, x]));
      for (const p of [a, b]) expect(await unitNotRows(p), p.name).toEqual({ differ: 0, missing: 0 });
    }, 600_000);
  }

  // Round 8 (P1-P3): a write says the same on every node that holds it (its value, kept with its stamp where no row holds it), a field shows what its heads say, and
  // nodes that exchanged to the end exchange nothing more and are never refused (`settle` ends with one more quiet round). Each with the product's moves.
  for (const order of ORDERS) {
    // 1 (a): both nodes move the same paragraph (its anchor and its row) into a child note of their own and delete that child for good. Before, the `note` of the
    // losing move was stored as a head with a NULL value, sent on, and refused ("a paragraph row has no note") by every node after: that direction stuck for ever.
    it(`round 8, 1 (a): two nodes each move a paragraph into a child note and delete it for good (${order}): never refused, nothing left, the same stamps on both`, async () => {
      const { a, b } = await threeNodes(31);
      const n1 = await newNote(a, "f4a1f4a1-f4a1-4f4a-8f4a-f4a1f4a1f4a1", "Parent");
      await write(a, n1, "First paragraph here {plan}\n\nSecond paragraph here {plan}\n");
      await exchange(a, b);
      const x = await firstAnchor(a, n1);
      const row = await onNode(a.node, async () => (await q<{ id: string }>(`SELECT id::text FROM block_nodes WHERE workspace_id = $1 AND anchor_id = $2`, [a.ws, x])).rows[0]!.id);
      const ca = await toChild(a, n1, x, "selection");
      const cb = await toChild(b, n1, x, "selection");
      await purge(a, ca); await purge(b, cb);
      await settle(a, b, order);
      for (const p of [a, b]) expect(await whereIs(p, x), p.name).toEqual({ anchor: [], row: [] });
      expect(await keyStamps(b, [row, x])).toEqual(await keyStamps(a, [row, x]));
      for (const p of [a, b]) expect(onlyIds(await keptValues(p, [row, x])), p.name).toBe(true);
      // the two moves are both kept, each with the child it named: a head of `note` on the row and on the anchor
      for (const p of [a, b]) expect((await keptValues(p, [row, x])).filter((h) => h.f === "note").map((h) => h.v).sort(), p.name).toEqual([ca, ca, cb, cb].sort());
    }, 600_000);

    // 1 (b): A moves the paragraph into a child note and deletes it for good; B moves it into a child note of its own, later, which stays. B holds the row in its child;
    // A's move is a head of `note` on B. Before, B stored that head with a NULL value and every bundle B sent after was refused.
    it(`round 8, 1 (b): A moves a paragraph into a child note and deletes it, B moves it later into one that stays (${order}): in B's child on both, never refused`, async () => {
      const { a, b } = await threeNodes(32);
      const n1 = await newNote(a, "f5a1f5a1-f5a1-4f5a-8f5a-f5a1f5a1f5a1", "Parent");
      await write(a, n1, "First paragraph here {plan}\n\nSecond paragraph here {plan}\n");
      await exchange(a, b);
      const x = await firstAnchor(a, n1);
      const row = await onNode(a.node, async () => (await q<{ id: string }>(`SELECT id::text FROM block_nodes WHERE workspace_id = $1 AND anchor_id = $2`, [a.ws, x])).rows[0]!.id);
      const ca = await toChild(a, n1, x, "selection");
      await purge(a, ca);
      const cb = await toChild(b, n1, x, "selection");
      await settle(a, b, order);
      for (const p of [a, b]) expect(await whereIs(p, x), p.name).toEqual({ anchor: [cb], row: [cb] });
      expect(await replicated(b, cb)).toEqual(await replicated(a, cb));
      expect(await keyStamps(b, [row, x])).toEqual(await keyStamps(a, [row, x]));
      for (const p of [a, b]) expect(onlyIds(await keptValues(p, [row, x])), p.name).toBe(true);
      for (const p of [a, b]) expect(await unitNotRows(p), p.name).toEqual({ differ: 0, missing: 0 });
    }, 600_000);
  }

  // Round 8, point 2: three real nodes in a star (H the centre, A and D talk to H only). All three hold paragraph row X in a child note C with task T0. At the same time:
  // H sets the task to T1 and deletes C for good; A moves X back into the parent; D moves X back into the parent and sets the task to T5. Before, H's write reached A and
  // D without its value, each showed its own column under H's stamp and sent it on as H's write: D's T5 met A's T0 under one stamp, bundle_stamp_clash both ways for
  // ever. Now H's write travels with T1, and the two task writes are a conflict like any other: the same winner, the same heads, on all three. Both orders of H's sends.
  const star = async (h: Peer, a: Peer, d: Peer, first: "A" | "D") => {
    const pairs = (first === "A" ? [[h, a], [h, d], [a, h], [d, h]] : [[h, d], [h, a], [d, h], [a, h]]) as ReadonlyArray<readonly [Peer, Peer]>;
    for (let k = 0; k < 3; k++) for (const [x, y] of pairs) await exchange(x, y);
    await quiet(pairs);
  };
  /** X's paragraph row in a child note on all three, with a task both A and D (and H) hold. */
  const heldByAll = async (seed: number, ids: string) => {
    const { a: h, b: a, c: d } = await threeNodes(seed);
    const n1 = await newNote(h, `${ids}1-f6a1-4f6a-8f6a-f6a1f6a1f6a1`, "Parent");
    await write(h, n1, "First paragraph here {plan}\n\nSecond paragraph here {plan}\n");
    const x = await firstAnchor(h, n1);
    const child = await toChild(h, n1, x, "selection");
    const t = [0, 1, 5, 7].map((n) => `${ids}${n}-f6a2-4f6a-8f6a-f6a2f6a2f6a2`);
    for (const [k, id] of t.entries()) await newNote(h, id, `Task ${k}`);
    const row = await onNode(h.node, async () => (await q<{ id: string }>(`SELECT id::text FROM block_nodes WHERE workspace_id = $1 AND anchor_id = $2`, [h.ws, x])).rows[0]!.id);
    await stampedSql(h, `UPDATE block_nodes SET task_id = $2 WHERE id = $1`, [row, t[0]]);
    for (const p of [a, d]) { await exchange(h, p); await exchange(p, h); }
    for (const p of [h, a, d]) expect(await paragraphOf(p, row), p.name).toEqual([{ note: child, task: t[0] }]);
    return { h, a, d, n1, x, row, child, t: { T0: t[0]!, T1: t[1]!, T5: t[2]!, T7: t[3]! } };
  };
  const taskStamps = (p: Peer, row: string) => onNode(p.node, async () => (await q<{ r: string }>(
    `SELECT 's ' || origin || ':' || seq || ' ' || COALESCE(kept_value::text, '-') AS r FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'block_nodes' AND row_key = $2 AND field = 'task'
     UNION ALL SELECT 'h ' || origin || ':' || seq || ' ' || COALESCE(value, '-') || ' ' || valueless FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = 'block_nodes' AND row_key = $2 AND field = 'task' ORDER BY 1`, [p.ws, row])).rows.map((x) => x.r));
  for (const first of ["A", "D"] as const) {
    it(`round 8, 2: a star of three (H, A, D): H writes the task and deletes the note, A and D move the row back, D writes the task too (H sends to ${first} first): the same on all three, never refused`, async () => {
      const { h, a, d, n1, x, row, t } = await heldByAll(first === "A" ? 33 : 34, first === "A" ? "f6a1f6a" : "f6b1f6b");
      await stampedSql(h, `UPDATE block_nodes SET task_id = $2 WHERE id = $1`, [row, t.T1]);
      const child = (await paragraphOf(h, row))[0]!.note;
      await purge(h, child);
      await stampedSql(a, `UPDATE block_nodes SET note_id = $2 WHERE id = $1`, [row, n1]);
      await stampedSql(d, `UPDATE block_nodes SET note_id = $2, task_id = $3 WHERE id = $1`, [row, n1, t.T5]);
      // point 3: what an event says was taken is what the column then shows
      const r = await exchange(h, a);
      const said = r.events.filter((e) => e.address.table === "block_nodes" && e.address.row === row && e.address.field === "task").map((e) => e.result.unit[0]!.value);
      expect(said).toEqual([(await paragraphOf(a, row))[0]!.task]);
      await star(h, a, d, first);
      const shown = await paragraphOf(h, row);
      expect(shown.length).toBe(1);
      expect([t.T1, t.T5]).toContain(shown[0]!.task); // the later of the two concurrent task writes
      for (const p of [a, d]) expect(await paragraphOf(p, row), p.name).toEqual(shown);
      for (const p of [a, d]) expect(await keyStamps(p, [row, x]), p.name).toEqual(await keyStamps(h, [row, x]));
      // both task writes are kept, each with its value: the winner in the column, the other a head (a conflict a person sees)
      expect((await taskStamps(h, row)).filter((l) => l.startsWith("h ")).map((l) => l.split(" ")[2]).concat(shown[0]!.task!).sort()).toEqual([t.T1, t.T5].sort());
      for (const p of [h, a, d]) expect(onlyIds(await keptValues(p, [row, x])), p.name).toBe(true);
    }, 900_000);

    // The holders' columns differ and no write with a value is on its way: D set the task to T7 and sent it to H only; H, having seen it, sets T1 and deletes the note.
    // A (still at T0) and D (at T7) moved the row back meanwhile. Before, each showed its own column under H's stamp (A T0, D T7) and sent it on as H's write.
    it(`round 8, 2: the holders' columns differ and no write with a value is on its way (H sends to ${first} first): H's write, with its value, on all three`, async () => {
      const { h, a, d, n1, x, row, t } = await heldByAll(first === "A" ? 35 : 36, first === "A" ? "f6c1f6c" : "f6d1f6d");
      await stampedSql(d, `UPDATE block_nodes SET task_id = $2 WHERE id = $1`, [row, t.T7]);
      await exchange(d, h);
      expect((await paragraphOf(h, row))[0]!.task).toBe(t.T7);
      await stampedSql(h, `UPDATE block_nodes SET task_id = $2 WHERE id = $1`, [row, t.T1]);
      await purge(h, (await paragraphOf(h, row))[0]!.note);
      await stampedSql(a, `UPDATE block_nodes SET note_id = $2 WHERE id = $1`, [row, n1]);
      await stampedSql(d, `UPDATE block_nodes SET note_id = $2 WHERE id = $1`, [row, n1]);
      await star(h, a, d, first);
      for (const p of [h, a, d]) expect(await paragraphOf(p, row), p.name).toEqual([{ note: n1, task: t.T1 }]);
      for (const p of [a, d]) expect(await keyStamps(p, [row, x]), p.name).toEqual(await keyStamps(h, [row, x]));
      for (const p of [h, a, d]) expect(await taskStamps(p, row), p.name).toEqual(await taskStamps(h, row));
      for (const p of [h, a, d]) expect(onlyIds(await keptValues(p, [row, x])), p.name).toBe(true);
    }, 900_000);
  }

  // Round 9, point 1: a unit whose column a foreign key empties (`ON DELETE SET NULL`: a paragraph row's task, its detached child). The product deletes a note for good
  // with everything under it in ONE statement, so whether the row that goes still names its task when it is deleted depends on the order the database deletes in; the
  // receiver deletes a note at a time in key order. The same stamp was frozen as the id on one node and NULL on another: refused for ever. Now the copy that names
  // the row is the write (rows.ts mergeRow `cleared`). X's paragraph row is moved into child note C and names a note T under C (its task, or its detached child);
  // A deletes C for good (and T with it) while B, offline, writes another field of X; B's write reaches D first and the others late. Both key orders of T and C.
  const keptOf = (p: Peer, row: string) => onNode(p.node, async () => (await q<{ r: string }>(
    `SELECT field || ' ' || origin || ':' || seq || ' ' || COALESCE(kept_value::text, '-') AS r FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'block_nodes' AND row_key = $2 ORDER BY 1`, [p.ws, row])).rows.map((x) => x.r));
  /** No stamp keeps a value outside what may keep one (round 9, point 2): the migration's CHECK says so; this reads it back. */
  const keptOutside = (p: Peer) => onNode(p.node, async () => Number((await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM sync_stamps WHERE workspace_id = $1 AND kept_value ? 'text' AND NOT sync_stamp_may_keep_value(table_name, field)`, [p.ws])).rows[0]!.n));
  for (const field of ["task", "detached"] as const) for (const lower of ["T", "C"] as const) for (const order of ORDERS) {
    it(`round 9, 1: a paragraph row moved into a child note and naming a note under it (${field}), both deleted for good by the product in one statement (${lower}'s key lower; ${order}); a third node's write arrives late: never refused, the same on all three`, async () => {
      const { a, b, c: d } = await threeNodes(41);
      const n1 = await newNote(a, "f8a1f8a1-f8a1-4f8a-8f8a-f8a1f8a1f8a1", "Parent");
      await write(a, n1, "First paragraph here {plan}\n\nSecond paragraph here {plan}\n");
      const x = await firstAnchor(a, n1);
      const row = await onNode(a.node, async () => (await q<{ id: string }>(`SELECT id::text FROM block_nodes WHERE workspace_id = $1 AND anchor_id = $2`, [a.ws, x])).rows[0]!.id);
      const [low, high] = ["10000000-0000-4000-8000-00000000000" + (field === "task" ? "1" : "2"), "f0000000-0000-4000-8000-00000000000" + (field === "task" ? "1" : "2")];
      const c = await newNote(a, lower === "C" ? low : high, "Child");
      const t = await onNode(a.node, async () => (await a.call("POST", "/api/nodes", { id: lower === "T" ? low : high, title: "Named by the row", markdown: "", space_id: a.space, parent_id: c })).id as string);
      // what carryBlockRow writes, and the field: one stamped write
      await stampedSql(a, field === "task" ? `UPDATE block_nodes SET note_id = $2, task_id = $3 WHERE id = $1` : `UPDATE block_nodes SET note_id = $2, detached_note_id = $3 WHERE id = $1`, [row, c, t]);
      const moved = (await keptOf(a, row)).find((l) => l.startsWith(`${field} `))!.split(" ")[1]!;
      for (const p of [b, d]) { await exchange(a, p); await exchange(p, a); }
      await stampedSql(b, `UPDATE block_nodes SET block_ref = 'r9late' WHERE id = $1`, [row]);
      await exchange(b, d);
      expect((await purge(a, c)).sort()).toEqual([c, t].sort());
      await settle(a, b, order);
      for (const [x1, y1] of [[b, d], [d, b], [a, d], [d, a]] as const) await exchange(x1, y1);
      await quiet([[a, b], [b, a], [b, d], [d, b], [a, d], [d, a]]);
      for (const p of [a, b, d]) expect(await paragraphOf(p, row), p.name).toEqual([]);
      for (const p of [b, d]) expect(await keyStamps(p, [row, x]), p.name).toEqual(await keyStamps(a, [row, x]));
      for (const p of [b, d]) expect(await keptOf(p, row), p.name).toEqual(await keptOf(a, row));
      // the field's stamp is the move's, kept naming T (the written copy) on every node; or, when the product's statement emptied the column before it removed the row
      // (T first), the delete's own write of it (a NULL with a stamp of its own, the same on every node)
      const line = (await keptOf(a, row)).find((l) => l.startsWith(`${field} `))!;
      if (line.split(" ")[1] === moved) expect(line).toContain(t);
      else expect(line).toMatch(field === "task" ? /\{"text": null\}$/ : /"detached_note_id\\": null/);
      for (const p of [a, b, d]) expect(await keptOutside(p), p.name).toBe(0);
    }, 900_000);
  }

  // Round 9, point 2: a value is kept with its stamp only where a row goes with its note (ids). Another table's row this node does not hold because its note was
  // deleted for good here keeps its stamps and none of the text they carried, and takes none from another node; a bundle sent again changes nothing. (A note whose
  // space row is gone: the product never removes a space row, spaces.ts deleteSpace sets deleted_at, so no note is left without its space.)
  /** Every place a stamp table could hold a text: kept values and heads' values. */
  const wordsOn = (p: Peer, words: string) => onNode(p.node, async () => Number((await q<{ n: string }>(
    `SELECT ((SELECT count(*) FROM sync_stamps WHERE workspace_id = $1 AND kept_value::text LIKE $2) + (SELECT count(*) FROM sync_stamp_heads WHERE workspace_id = $1 AND value LIKE $2))::text AS n`,
    [p.ws, `%${words}%`])).rows[0]!.n));
  for (const what of ["an attribute's value", "a key of a JSON column"] as const) for (const order of ORDERS) {
    it(`round 9, 2: ${what} written on B where A deletes for good at the same time (${order}): A keeps none of its text, and nothing changes when everything is sent again`, async () => {
      const { a, b } = await threeNodes(42);
      const words = "words that must not stay";
      {
        const note = await newNote(a, "f9a2f9a2-f9a2-4f9a-8f9a-f9a2f9a2f9a2", "Deleted for good");
        await exchange(a, b);
        // set, then changed: the value has a write of its own (not only the row's creation)
        if (what === "an attribute's value") for (const v of ["first", words]) await onNode(b.node, () => b.call("PUT", `/api/nodes/${note}/attributes/status`, { value: v }));
        else await stampedSql(b, `UPDATE content_nodes SET tag_schema = jsonb_build_object('key', $2::text) WHERE id = $1`, [note, words]);
        await purge(a, note);
      }
      await settle(a, b, order);
      expect(await wordsOn(a, words)).toBe(0);
      for (const p of [a, b]) expect(await keptOutside(p), p.name).toBe(0);
    }, 600_000);
  }

  // Round 10, point 7 (pinned, before the transport): the one unit of another table a full resend stores again in these tests (a probe of every table's stamps around
  // `resendAll`, rounds 5 to 10). B sets an attribute of N and changes it; A deletes N for good; B's writes reach A after (B first). A holds no row for them and keeps
  // their stamps without values (round 9, point 2). B, taking A's delete in a merge, loses the row by the cascade, and the delete trigger clears the row's field stamps
  // (a merge writes no tombstone of its own: sync_stamp_put_over); its creation stamp stays. So A holds B's value stamp and B does not. The exchange never sends it again
  // (below B's `have`); the whole state sent again does, and B stores it, without a value. Nothing is refused and no text stays; the two nodes hold different stamps.
  it.fails("round 10, 7: an attribute written on B, its note deleted for good on A (B first): both nodes hold the same node_attributes stamps, and a full resend stores none", async () => {
    const { a, b } = await threeNodes(48);
    const note = await newNote(a, "f9f2f9f2-f9f2-4f9f-8f9f-f9f2f9f2f9f2", "Its attribute");
    await exchange(a, b);
    for (const v of ["first", "second"]) await onNode(b.node, () => b.call("PUT", `/api/nodes/${note}/attributes/status`, { value: v }));
    await purge(a, note);
    for (let k = 0; k < 3; k++) { await exchange(b, a); await exchange(a, b); } // to the end, without the full resend that `settle` adds
    const attrs = (p: Peer) => onNode(p.node, async () => (await q<{ r: string }>(
      `SELECT row_key || ' ' || field || ' ' || deleted || ' ' || origin || ':' || seq AS r FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'node_attributes' ORDER BY 1`, [p.ws])).rows.map((x) => x.r));
    expect(await attrs(a)).toEqual(await attrs(b));
    expect((await resendAll(a, b)).stored).toBe(0);
  }, 600_000);

  // Round 10, point 3: B and C write the same key of a note's JSON column at once (B holds the other's as a conflict head, with its text); A, which never saw the key,
  // deletes the note for good. B and C remove the note, and keep none of the key's text: compared without values, the head B held was never written again.
  for (const order of ORDERS) {
    it(`round 10, 3: a key of a JSON column in conflict on B and C, the note deleted for good on A (${order}): none of the key's text stays on B or C`, async () => {
      const { a, b, c } = await threeNodes(44);
      const note = await newNote(a, "f9c1f9c1-f9c1-4f9c-8f9c-f9c1f9c1f9c1", "Its key in conflict");
      for (const p of [b, c]) await exchange(a, p);
      await stampedSql(b, `UPDATE content_nodes SET tag_schema = jsonb_build_object('key', 'the words of B') WHERE id = $1`, [note]);
      await stampedSql(c, `UPDATE content_nodes SET tag_schema = jsonb_build_object('key', 'the words of C') WHERE id = $1`, [note]);
      await exchange(b, c); await exchange(c, b);
      expect(await wordsOn(b, "the words of")).toBeGreaterThan(0); // the conflict head, with its text
      await purge(a, note);
      await settle(a, b, order); await settle(a, c, order); await settle(b, c, order);
      for (const p of [a, b, c]) expect(await wordsOn(p, "the words of"), p.name).toBe(0);
    }, 600_000);
  }

  // Round 10, point 8: a row made again says which old field writes it was made over (sync_rows_made_afresh); it merges that, origin by origin, with what its creation
  // already carried (a delete's `seen`, migration 206), never in place of it. A field write of another node left under the key, and a delete that had seen a third.
  it("round 10, 8: a row made again keeps the seen its creation carried, beside the field writes it was made over", async () => {
    const { a } = await threeNodes(47);
    const note = await newNote(a, "f9f1f9f1-f9f1-4f9f-8f9f-f9f1f9f1f9f1", "Made again");
    const row = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0ef1";
    const make = `INSERT INTO block_nodes (id, workspace_id, note_id, block_ref, kind, label, text_cache) VALUES ($1, $2, $3, 'again1', 'paragraph', 't', 't')`;
    await stampedSql(a, make, [row, a.ws, note]);
    await stampedSql(a, `DELETE FROM block_nodes WHERE id = $1`, [row]);
    await onNode(a.node, async () => {
      await seedQ(`UPDATE sync_stamps SET meta = jsonb_set(COALESCE(meta, '{}'::jsonb), '{seen}', COALESCE(meta -> 'seen', '{}'::jsonb) || '{"yyyy": 7}') WHERE workspace_id = $1 AND table_name = 'block_nodes' AND row_key = $2 AND field = '*'`, [a.ws, row]);
      await seedQ(`INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, deleted, origin, seq, hlc_wall, hlc_counter, saw, meta) SELECT workspace_id, table_name, row_key, 'label', false, 'zzzz', 3, hlc_wall, hlc_counter, '{}'::jsonb, NULL FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'block_nodes' AND row_key = $2 AND field = '*'`, [a.ws, row]);
    });
    await stampedSql(a, make, [row, a.ws, note]);
    const seen = await onNode(a.node, async () => (await q<{ s: Record<string, number> }>(`SELECT meta -> 'seen' AS s FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'block_nodes' AND row_key = $2 AND field = '*'`, [a.ws, row])).rows[0]?.s);
    expect(seen?.yyyy).toBe(7);
    expect(seen?.zzzz).toBe(3);
  }, 600_000);

  // Round 10, point 4 (pinned, before the transport: README "接上傳輸前必須完成"): a column a foreign key emptied, whose row is later made again with the same id. B,
  // offline, makes K under note P; A deletes P for good; A's delete reaches B (B's K loses its parent, its stamp keeps P); A makes P again under the same id (a day's
  // note has an id worked out from its day); B's K reaches A only now, and A makes K under P. Both nodes hold the same stamps, and K is under P on A and at the top on
  // B for ever. The direction: a column follows the heads a node holds and the rows it holds, and a row made later fills in a column its stamps kept the id of.
  it.fails("round 10, 4: a parent emptied, then made again with the same id before the child arrives elsewhere: both nodes hold the child in the same place", async () => {
    const { a, b } = await threeNodes(45);
    const p = await newNote(a, "f9d1f9d1-f9d1-4f9d-8f9d-f9d1f9d1f9d1", "A day");
    await exchange(a, b);
    const k = await onNode(b.node, async () => (await b.call("POST", "/api/nodes", { title: "Made offline", markdown: "", space_id: b.space, parent_id: p })).id as string);
    await purge(a, p);
    await exchange(a, b);
    await newNote(a, p, "The same day again");
    await exchange(b, a); await exchange(a, b);
    const parentOf = (x: Peer) => onNode(x.node, async () => (await q<{ p: string | null }>(`SELECT parent_id::text AS p FROM content_nodes WHERE id = $1`, [k])).rows[0]?.p ?? null);
    expect(await parentOf(b)).toBe(await parentOf(a));
  }, 600_000);

  // Round 10, point 5 (pinned, before the transport): a row older than the stamps (genesis: every row on the production server today) whose task follows its creation. Moved
  // into C, with its task T under C, and both deleted for good: on the node where the database empties the task before it removes the row, sync_keep_emptied_id adds the
  // task's stamp row (a copy of the genesis creation, keeping T); where the row goes first, there is none. A genesis stamp is never above a `have`, so the exchange
  // never sends it; the whole state sent again does, and the receiver stores it. Nothing is refused. (Here A deletes T, then C; B, taking it, deletes C first: key order.)
  it.fails("round 10, 5: a genesis row whose task follows its creation, its note and task deleted for good: the same stamps on both, even with everything sent again", async () => {
    const { a, b } = await threeNodes(46);
    const parent = await newNote(a, "f9e1f9e1-f9e1-4f9e-8f9e-f9e1f9e1f9e1", "Parent");
    const c = await newNote(a, "10000000-0000-4000-8000-0000000000e1", "Child");
    const t = await onNode(a.node, async () => (await a.call("POST", "/api/nodes", { id: "f0000000-0000-4000-8000-0000000000e1", title: "Its task", markdown: "", space_id: a.space, parent_id: c })).id as string);
    await exchange(a, b);
    const row = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0ee1";
    // the same row on both, from before the stamps: inserted, its stamps taken away, and the genesis pass stamps it (the same constants on every node)
    for (const p of [a, b]) await onNode(p.node, async () => {
      await seedQ(`INSERT INTO block_nodes (id, workspace_id, note_id, block_ref, kind, label, text_cache, task_id) VALUES ($1, $2, $3, 'genesis1', 'listItem', 't', 't', $4)`, [row, p.ws, parent, t]);
      await seedQ(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'block_nodes' AND row_key = $2`, [p.ws, row]);
      await seedQ(`SELECT * FROM sync_genesis_pass()`);
    });
    expect(await onNode(a.node, async () => (await q<{ o: string }>(`SELECT origin AS o FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'block_nodes' AND row_key = $2 AND field = '*'`, [a.ws, row])).rows[0]?.o)).toBe("genesis");
    await stampedSql(a, `UPDATE block_nodes SET note_id = $2 WHERE id = $1`, [row, c]);
    await exchange(a, b);
    await stampedSql(a, `DELETE FROM content_nodes WHERE id = $1`, [t]);
    await stampedSql(a, `DELETE FROM content_nodes WHERE id = $1`, [c]);
    await settle(a, b, "A first");
  }, 600_000);

  // Round 9, point 5 c: a key that kept its stamps (a row that went with its note) is made again here (an anchor id adopted into a note: sync_rows_made_afresh clears
  // its fields' old stamps on this node). The other node still holds them; after the exchange both hold the same stamps.
  for (const order of ORDERS) {
    it(`round 9, 5 c: a paragraph row that went with its note, made again with the same id on A (${order}): the same stamps on both after the exchange`, async () => {
      const { a, b } = await threeNodes(43);
      const n1 = await newNote(a, "f9b1f9b1-f9b1-4f9b-8f9b-f9b1f9b1f9b1", "Parent");
      await write(a, n1, "First paragraph here {plan}\n\nSecond paragraph here {plan}\n");
      const x = await firstAnchor(a, n1);
      const row = await onNode(a.node, async () => (await q<{ id: string }>(`SELECT id::text FROM block_nodes WHERE workspace_id = $1 AND anchor_id = $2`, [a.ws, x])).rows[0]!.id);
      const child = await toChild(a, n1, x, "selection");
      await settle(a, b, order);
      await purge(a, child);
      await settle(a, b, order);
      // the same id made again on A, in the parent (what a write that adopts the id does to the row)
      await stampedSql(a, `INSERT INTO block_nodes (id, workspace_id, note_id, block_ref, kind) VALUES ($1, $2, $3, 'r9again', 'paragraph')`, [row, a.ws, n1]);
      await settle(a, b, order);
      expect(await keyStamps(b, [row])).toEqual(await keyStamps(a, [row]));
      expect(await paragraphOf(b, row)).toEqual(await paragraphOf(a, row));
    }, 600_000);
  }

  // Round 5, point 1 (round 6, point 4: the product's move, both orders): A deletes a note for good while B moves one of its paragraphs, anchor and paragraph row, into a
  // new child note. The anchor lives on in the child on both nodes: on A it went with the note it was made in (nothing left of it), B's move brings it back whole.
  for (const order of ORDERS) {
    it(`round 5, 1: a note deleted for good while another node moves one of its paragraphs into a child note (${order}): the anchor lives on in the child, the same on both nodes`, async () => {
      const { a, b } = await threeNodes(24);
      const n1 = await newNote(a, "fafafafa-fafa-4faf-8faf-fafafafafafa", "Deleted");
      await write(a, n1, "First paragraph here {plan}\n\nSecond paragraph here {plan}\n");
      await exchange(a, b);
      const x = await firstAnchor(b, n1);
      const child = await toChild(b, n1, x);
      await purge(a, n1);
      await settle(a, b, order);
      // the paragraph row stayed in the deleted note (standing for the child): it went with it
      for (const p of [a, b]) expect(await whereIs(p, x), p.name).toEqual({ anchor: [child], row: [] });
      expect(await replicated(b, child)).toEqual(await replicated(a, child));
      expect(await goneStamps(b)).toEqual(await goneStamps(a));
      for (const p of [a, b]) expect(await unitNotRows(p), p.name).toEqual({ differ: 0, missing: 0 });
    }, 600_000);
  }

  // Round 6, point 2: the rows moved into a note that is then deleted for good. Every case ended in a bundle refused for ever before (a NOT NULL note written, or the same
  // stamp with and without a value); each now leaves both nodes the same: the moved anchor and its paragraph row are on neither, and the stamps agree.
  for (const order of ORDERS) for (const how of ["block", "selection"] as const) {
    it(`round 6, 2 (a): A moves a paragraph into a child note (${how}) and deletes the child for good before sending (${order}): what was in the child is gone on both`, async () => {
      const { a, b } = await threeNodes(25);
      const n1 = await newNote(a, "fcfcfcfc-fcfc-4fcf-8fcf-fcfcfcfcfcfc", "Source");
      await write(a, n1, "First paragraph here {plan}\n\nSecond paragraph here {plan}\n");
      await exchange(a, b);
      const x = await firstAnchor(a, n1);
      const child = await toChild(a, n1, x, how);
      expect(await whereIs(a, x)).toEqual({ anchor: [child], row: how === "block" ? [n1] : [child] });
      await purge(a, child);
      await settle(a, b, order);
      for (const p of [a, b]) expect(await whereIs(p, x), p.name).toEqual({ anchor: [], row: how === "block" ? [n1] : [] });
      expect(await replicated(b, n1)).toEqual(await replicated(a, n1));
      expect(await goneStamps(b)).toEqual(await goneStamps(a));
      for (const p of [a, b]) expect(await unitNotRows(p), p.name).toEqual({ differ: 0, missing: 0 });
    }, 600_000);

    if (how === "block") it(`round 6, 2 (b): B moves a paragraph into a note that A deletes for good at the same time (${order}): the anchor and its row are gone on both`, async () => {
      const { a, b } = await threeNodes(26);
      const n2 = await newNote(a, "fdfdfdfd-fdfd-4fdf-8fdf-fdfdfdfdfdfd", "Parent");
      await write(a, n2, "First paragraph here {plan}\n\nSecond paragraph here {plan}\n");
      const x = await firstAnchor(a, n2);
      const child = await toChild(a, n2, x);
      await exchange(a, b); await exchange(b, a);
      // B takes the child back into its parent (the product's way into a note that is there: expandChildNote); A deletes the parent for good
      await onNode(b.node, () => b.call("POST", `/api/nodes/${n2}/expand-child`, { child_id: child }));
      expect(await whereIs(b, x)).toEqual({ anchor: [n2], row: [n2] });
      await purge(a, n2);
      await settle(a, b, order);
      for (const p of [a, b]) expect(await whereIs(p, x), p.name).toEqual({ anchor: [], row: [] });
      expect(await goneStamps(b)).toEqual(await goneStamps(a));
      for (const p of [a, b]) expect(await unitNotRows(p), p.name).toEqual({ differ: 0, missing: 0 });
    }, 600_000);

    it(`round 6, 2 (c): a paragraph moved into a child note (${how}), sent, then the child deleted for good on A (${order}): the same stamps with and without values, what was in the child gone on both`, async () => {
      const { a, b } = await threeNodes(27);
      const n1 = await newNote(a, "fefefefe-fefe-4fef-8fef-fefefefefefe", "Source");
      await write(a, n1, "First paragraph here {plan}\n\nSecond paragraph here {plan}\n");
      const x = await firstAnchor(a, n1);
      const child = await toChild(a, n1, x, how);
      await exchange(a, b); await exchange(b, a);
      expect(await whereIs(b, x)).toEqual({ anchor: [child], row: how === "block" ? [n1] : [child] });
      await purge(a, child);
      await settle(a, b, order);
      for (const p of [a, b]) expect(await whereIs(p, x), p.name).toEqual({ anchor: [], row: how === "block" ? [n1] : [] });
      expect(await goneStamps(b)).toEqual(await goneStamps(a));
      for (const p of [a, b]) expect(await unitNotRows(p), p.name).toEqual({ differ: 0, missing: 0 });
    }, 600_000);
  }

  // round 3, point 11: an anchor deleted on A (its `*` a tombstone, and A's unit without it) while B writes its words (a write of places only): the two agree.
  it("round 3, 11: an anchor's removal against a concurrent write of its place: both nodes agree", async () => {
    const { a, b } = await threeNodes(18);
    const note = await newNote(a, "f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6", "Removed");
    await write(a, note, "First paragraph here {plan}\n\nSecond paragraph here {plan}\n");
    await exchange(a, b);
    const first = (p: Peer) => onNode(p.node, async () => (await q<{ id: string }>(`SELECT anchor_id AS id FROM block_anchors WHERE note_id = $1 ORDER BY from_utf16 LIMIT 1`, [note])).rows[0]!.id);
    const x = await first(a);
    await onNode(a.node, () => withTransaction(() => seedQ(`DELETE FROM block_anchors WHERE anchor_id = $1 AND workspace_id = $2`, [x, a.ws])));
    await onNode(b.node, () => withTransaction(() => seedQ(`UPDATE block_anchors SET quote = 'B wrote these words' WHERE anchor_id = $1 AND workspace_id = $2`, [x, b.ws])));
    await exchange(a, b); await exchange(b, a);
    expect(await replicated(b, note)).toEqual(await replicated(a, note));
  }, 600_000);

  // round 3, point 11: an anchor rehomed into another note, and an anchor renamed: both notes' units follow their rows, on the writer and on the receiver.
  it("round 3, 11: rehome between two notes and rename: both units follow, the same on both nodes", async () => {
    const { a, b } = await threeNodes(19);
    const n1 = await newNote(a, "f7f7f7f7-f7f7-4f7f-8f7f-f7f7f7f7f7f7", "From");
    const n2 = await newNote(a, "f8f8f8f8-f8f8-4f8f-8f8f-f8f8f8f8f8f8", "To");
    await write(a, n1, "First paragraph here {plan}\n\nSecond paragraph here {plan}\n");
    const n2Body = "A paragraph of the other note\n";
    await write(a, n2, n2Body);
    await exchange(a, b);
    const [x, y] = await onNode(a.node, async () => (await q<{ id: string }>(`SELECT anchor_id AS id FROM block_anchors WHERE note_id = $1 ORDER BY from_utf16`, [n1])).rows.map((r) => r.id));
    await onNode(a.node, () => withEventTransaction(a.ws, async () => {
      await stampTransaction(a.ws, a.owner.id);
      expect(await rehomeAnchor(a.ws, x!, n2, n2Body, { from: 0, to: n2Body.length - 1 })).toBe(true);
      expect(await renameAnchor(a.ws, n1, y!, "renamed0001")).toBe(true);
    }));
    for (const p of [a]) expect(await unitNotRows(p), p.name).toEqual({ differ: 0, missing: 0 });
    await exchange(a, b);
    for (const n of [n1, n2]) expect(await replicated(b, n)).toEqual(await replicated(a, n));
    expect(await unitNotRows(b)).toEqual({ differ: 0, missing: 0 });
  }, 600_000);

  // round 3, point 11: a node that joins by snapshot while a note is in the 8b state. Pinned as refused until own-node-transport batch 2 (snapshot_foreign_origin: every node in
  // that state holds another node's stamps); now the source names the other origin it holds (`brought`) and the joiner takes the unit with both heads as it is. "Joining then
  // one more bundle" is re-checked here, as the merge README asked when this gate opened: the joiner settles the unit with a save, and every node agrees.
  it("round 3, 11: a node in the 8b state is the source of a snapshot: the joiner holds the same heads and anchors; a save there settles them; every node agrees", async () => {
    const { a, b, world } = await threeNodes(20);
    const note = await newNote(a, "f9f9f9f9-f9f9-4f9f-8f9f-f9f9f9f9f9f9", "Joined");
    await write(a, note, "Only paragraph here {plan}\n");
    await exchange(a, b);
    await write(b, note, "Only paragraph here, B edited it {plan}\n");
    await onNode(a.node, () => withTransaction(() => seedQ(`UPDATE block_anchors SET status = 'lost', from_utf16 = 0, to_utf16 = 0 WHERE note_id = $1`, [note])));
    await exchange(b, a); // A: two heads
    expect(await unitHeads(a, note)).toBe(1);
    const nd = await openNode("d");
    open.push(nd);
    await fillFrom(nd, world, await capture(a.node!, world, 12_000));
    const d = peerOf("D", nd, world);
    await onNode(d.node, () => setModulesOn(d.ws, null));
    expect(await unitHeads(d, note)).toBe(1);
    expect(await replicated(d, note)).toEqual(await replicated(a, note));
    expect(await headsOf(d, note)).toEqual(await headsOf(a, note));
    await admit(a, d);
    expect((await resendAll(a, d)).stored, "the joiner holds everything its source holds").toBe(0);
    await write(d, note, "Only paragraph here, B edited it, D saved it {plan}\n");
    await exchange(d, a); await exchange(a, b); await exchange(a, d);
    for (const p of [a, b, d]) expect(await unitHeads(p, note), p.name).toBe(0);
    expect(await replicated(a, note)).toEqual(await replicated(d, note));
    expect(await replicated(b, note)).toEqual(await replicated(d, note));
    for (const p of [a, b, d]) expect(await unitNotRows(p), p.name).toEqual({ differ: 0, missing: 0 });
    expect((await resendAll(a, d)).stored).toBe(0);
    expect((await resendAll(d, a)).stored).toBe(0);
  }, 600_000);

  // round 3, point 7: on a note whose unit holds two heads (the 8b state), a write that is not a person's (an AI or an automation, stampTransaction notAPerson) is
  // refused with sync_unit_in_conflict; the heads stay. Since round 4 the unit is written after each statement, so it is the statement that fails, not the COMMIT.
  it("round 3, 7: a write that is not a person's (what mutate stamps for an AI token) on a note in the 8b state is refused at its statement; the heads stay", async () => {
    const { a, b } = await threeNodes(21);
    const note = await newNote(a, "fafafafa-fafa-4afa-8afa-fafafafafafa", "Not a person");
    await write(a, note, "Only paragraph here {plan}\n");
    await exchange(a, b);
    await write(b, note, "Only paragraph here, B edited it {plan}\n");
    await onNode(a.node, () => withTransaction(() => seedQ(`UPDATE block_anchors SET status = 'lost', from_utf16 = 0, to_utf16 = 0 WHERE note_id = $1`, [note])));
    await exchange(b, a);
    expect(await unitHeads(a, note)).toBe(1);
    const anchor = await onNode(a.node, async () => (await q<{ id: string }>(`SELECT anchor_id AS id FROM block_anchors WHERE note_id = $1`, [note])).rows[0]!.id);
    let afterStatement = "not reached";
    const result = await onNode(a.node, () => withEventTransaction(a.ws, async () => {
      await stampTransaction(a.ws, a.owner.id, { notAPerson: true });
      await retireAnchor(a.ws, note, anchor);
      afterStatement = "the statement was taken"; // not reached: the unit is written at the end of the statement, which is refused
    }).then(() => "committed", (e: { code?: string }) => e.code ?? String(e)));
    expect(afterStatement).toBe("not reached");
    expect(result).toBe("sync_unit_in_conflict"); // ON001, spine/unitInConflict.ts
    expect(await unitHeads(a, note)).toBe(1);
  }, 600_000);

  // round 3, point 11: a review card on the paragraph of an anchor the losing write minted (8a). Pinned as it is: the card travels with its paragraph row and stays; the next
  // save hides the row on the node that saves (not on the other until it saves) and keeps the card on it, so the card is on a paragraph that is not in the note.
  it("round 3, 11: a review card on the paragraph of the losing write's anchor: kept, on a row the next save hides (pinned)", async () => {
    const { a, b } = await threeNodes(22);
    const note = await newNote(a, "fbfbfbfb-fbfb-4fbf-8fbf-fbfbfbfbfbfb", "Card");
    await write(a, note, "First paragraph stays {plan}\n\nSecond paragraph stays\n");
    await exchange(a, b);
    await write(a, note, "First paragraph stays {plan}\n\nSecond paragraph stays\n\nA new paragraph only A writes {plan}\n");
    await onNode(a.node, () => seedQ(`INSERT INTO function_refs (workspace_id, function_id, holder_block_id)
      SELECT $1, 'review', b.id FROM block_nodes b JOIN block_anchors x ON x.anchor_id = b.anchor_id AND x.workspace_id = b.workspace_id
       WHERE b.note_id = $2 AND x.quote = 'A new paragraph only A writes {plan}'`, [a.ws, note]));
    await write(b, note, "First paragraph stays {plan}\n\nSecond paragraph stays, B edited it\n"); // later: its body wins
    await exchange(a, b); await exchange(b, a);
    const card = (p: Peer) => onNode(p.node, async () => (await q<{ cards: number; hidden: boolean | null; status: string | null }>(
      `SELECT (SELECT count(*)::int FROM function_refs r JOIN block_nodes b ON b.id = r.holder_block_id WHERE b.note_id = $1 AND r.function_id = 'review') AS cards,
              (SELECT b.hidden_at IS NOT NULL FROM block_nodes b JOIN block_anchors x ON x.anchor_id = b.anchor_id AND x.workspace_id = b.workspace_id
                WHERE b.note_id = $1 AND x.quote = 'A new paragraph only A writes {plan}') AS hidden,
              (SELECT x.status FROM block_anchors x WHERE x.note_id = $1 AND x.quote = 'A new paragraph only A writes {plan}') AS status`, [note])).rows[0]!);
    const exchanged = [await card(a), await card(b)];
    expect(exchanged[1]).toEqual(exchanged[0]);
    expect(exchanged[0]).toEqual({ cards: 1, hidden: false, status: "lost" }); // the card came along with its paragraph row; the anchor is lost, its row not yet hidden
    await write(a, note, "First paragraph stays {plan}\n\nSecond paragraph stays, B edited it, A saved\n");
    await exchange(a, b); await exchange(b, a);
    const saved = [await card(a), await card(b)];
    // the card stays, on a paragraph row the saving node hides (hidden_at is worked out by each node's own save, not replicated: B hides it at its own next save)
    expect(saved).toEqual([{ cards: 1, hidden: true, status: "lost" }, { cards: 1, hidden: false, status: "lost" }]);
  }, 600_000);

  // point 9: two nodes tag the same new paragraph at once: two anchors (two ids), two rows, two tasks. The next save keeps the row of the anchor made first (ORDER BY
  // created_at, anchor_id: the minting node's wall clock, carried with the row), hides the other and trashes its task. Pinned; the rule proposed is in the PR.
  it("9: the same new task line written on two nodes: two anchors and two tasks after the exchange; the next save on each keeps the same one", async () => {
    const { a, b } = await threeNodes(10);
    const note = await newNote(a, "bebebebe-bebe-4ebe-8ebe-bebebebebebe", "Twice");
    await write(a, note, "Intro\n\n- [ ] the shared task\n");
    await exchange(a, b);
    await write(a, note, "Intro\n\n- [ ] the shared task {task}\n");
    await write(b, note, "Intro\n\n- [ ] the shared task {task}\n");
    await exchange(a, b); await exchange(b, a);
    const live = (p: Peer) => onNode(p.node, async () => (await q<{ id: string; task: string | null; trashed: boolean | null }>(
      `SELECT b.id::text, b.task_id::text AS task, (SELECT c.deleted_at IS NOT NULL FROM content_nodes c WHERE c.id = b.task_id) AS trashed
         FROM block_nodes b WHERE b.note_id = $1 AND b.hidden_at IS NULL ORDER BY b.id`, [note])).rows);
    expect((await live(a)).length).toBe(2);
    expect(await live(b)).toEqual(await live(a));
    await write(a, note, "Intro, edited\n\n- [ ] the shared task {task}\n");
    await write(b, note, "Intro, edited\n\n- [ ] the shared task {task}\n");
    const [la, lb] = [await live(a), await live(b)];
    expect(la).toHaveLength(1);
    expect(lb).toEqual(la); // the same row stays on both
  }, 600_000);

  // point 10 (round 9, point 1): a task note deleted for good on B before B receives the paragraph row that names it. B makes the row with its task link empty, as the
  // database leaves it when the task goes (dbUnits.ts clearedOnDelete), and A empties its own when the deletion reaches it: the same rows on both. Pinned as wrong before.
  it("10: a task note deleted for good on the receiver, then the line's row arrives: both nodes hold the same rows", async () => {
    const { a, b } = await threeNodes(11);
    const note = await newNote(a, "cfcfcfcf-cfcf-4fcf-8fcf-cfcfcfcfcfcf", "Purged task");
    const task = await newNote(a, "d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0", "The task");
    await exchange(a, b);
    await onNode(a.node, () => seedQ(`INSERT INTO block_nodes (workspace_id, note_id, block_ref, anchor_id, kind, label, text_cache, task_id) VALUES ($1, $2, 'purged1', NULL, 'listItem', 't', 't', $3)`, [a.ws, note, task]));
    await onNode(b.node, () => seedQ(`DELETE FROM content_nodes WHERE id = $1`, [task]));
    await exchange(a, b); await exchange(b, a);
    expect((await replicated(b, note)).rows).toEqual((await replicated(a, note)).rows);
  }, 600_000);
});
