// Issue #2019 (#1974 item 3, the owner chose 甲 on 2026-11-23: value convergence outranks bookkeeping convergence). A note that one node deleted for good and another
// made again under its id (a day's note opened again): a third node that held the note alive all along, and had not seen the delete, holds rows on it that the nodes
// which took the delete dropped (they had no note when those writes came) and that no exchange sends again (they are below everyone's `have`). The holder sends them
// again when the new creation reaches it (README of spine/stampedMerge 「筆記以同一個 id 重建時，握有掛在它上面的列的節點把它們再送出」).
//
// The PROPERTY, on every scenario: after the nodes exchanged until nothing moves, every row that hangs on the note made again (every carried table with a cascading key
// to the note, read from the catalog here, through rows that hang on rows) is on every node with the same values, stamps and heads; the whole workspace is the same on
// every node; one more round stores nothing; a full resend between any two nodes makes and removes no row and changes no stamp. Written out with no randomness; the
// random three-node test (stampedSawThreeNodes, recreate) runs the same class with fresh seeds.
// SAFETY: node databases (a PGlite each, or a database of the test server on a real Postgres), dropped after each test.
import { afterEach, describe, expect, it } from "vitest";
import { q, withTransaction } from "../db.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { stampTransaction } from "../spine/stamps.js";
import { FIND_BUDGET, recoverAnchors } from "../services/blockAnchors/index.js";
import { seedQ } from "./helpers/seedQ.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { exchange, expectSame, peerStateOf, resendAll, threePeers, writeAsOwner, type Peer } from "./helpers/stampedBundleWorld.js";
import { DERIVED_PER_NODE_COLUMNS, SNAPSHOT_SPECS } from "../spine/snapshotTables.js";
import { asCompared } from "./helpers/stampedWorld.js";
import { UNIT_SOURCES, labelsOf, rowMatchOf } from "../spine/stampedMerge/index.js";

const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

/** The carried tables whose rows hang on a note: a cascading foreign key (one column) to content_nodes, or to a table that hangs on a note, read from the catalog
 *  (not a hand list: a new table that hangs on a note is checked here as soon as it is carried). */
async function hangingEdges(p: Peer): Promise<{ table: string; column: string; on: string; onColumn: string }[]> {
  const carried = UNIT_SOURCES.filter((s) => s.rows && s.table !== "content_nodes").map((s) => s.table);
  const all = await onNode(p.node, async () => (await q<{ table: string; column: string; on: string; onColumn: string }>(
    `SELECT c.conrelid::regclass::text AS table, a.attname::text AS column, c.confrelid::regclass::text AS on, b.attname::text AS "onColumn"
       FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1] JOIN pg_attribute b ON b.attrelid = c.confrelid AND b.attnum = c.confkey[1]
      WHERE c.contype = 'f' AND c.confdeltype = 'c' AND array_length(c.conkey, 1) = 1 AND c.conrelid::regclass::text = ANY($1::text[]) ORDER BY 1, 2`, [carried])).rows);
  const hangs = new Set(["content_nodes"]);
  for (let grew = true; grew;) { grew = false; for (const e of all) if (hangs.has(e.on) && !hangs.has(e.table)) { hangs.add(e.table); grew = true; } }
  return all.filter((e) => hangs.has(e.on));
}
const hangingTables = async (p: Peer) => [...new Set((await hangingEdges(p)).map((e) => e.table))].sort();

type OnNote = Record<string, { key: string; row: string }[]>;
/** Every row of a carried table that hangs on one of `notes` on `p` (through rows that hang on rows), table by table: its key and its carried columns as JSON. */
async function rowsOn(p: Peer, notes: string[]): Promise<OnNote> {
  const edges = await hangingEdges(p);
  return onNode(p.node, async () => {
    const out: OnNote = {};
    const ids = new Map<string, Set<string>>([["content_nodes.id", new Set(notes)]]);
    for (let grew = true; grew;) {
      grew = false;
      for (const e of edges) {
        const on = ids.get(`${e.on}.${e.onColumn}`);
        if (!on?.size) continue;
        const src = UNIT_SOURCES.find((s) => s.table === e.table)!;
        const drop = SNAPSHOT_SPECS.find((s) => s.table === e.table)?.exclude ?? [];
        // a column each node derives for itself (DERIVED_PER_NODE_COLUMNS: a card's updated_at) is compared the way every check of "the same" compares it
        const derived = Object.keys(DERIVED_PER_NODE_COLUMNS[e.table] ?? {}).map((c) => ` || jsonb_build_object('${c}', ${asCompared(e.table, c, `t."${c}"`)})`).join("");
        const r = await q<{ key: string; v: Record<string, unknown> }>(
          `SELECT ${rowMatchOf(src, []).idSql("t")} AS key, to_jsonb(t)${derived} AS v FROM "${e.table}" t WHERE t."${e.column}"::text = ANY($1::text[])${src.where ? ` AND ${src.where}` : ""}`, [[...on]]);
        for (const x of r.rows) {
          const list = (out[e.table] ??= []);
          if (list.some((y) => y.key === x.key)) continue;
          for (const c of drop) delete x.v[c];
          list.push({ key: x.key, row: JSON.stringify(x.v) });
          grew = true;
          for (const f of edges.filter((f) => f.on === e.table)) if (x.v[f.onColumn] != null) (ids.get(`${e.table}.${f.onColumn}`) ?? ids.set(`${e.table}.${f.onColumn}`, new Set()).get(`${e.table}.${f.onColumn}`)!).add(String(x.v[f.onColumn]));
        }
      }
    }
    for (const k of Object.keys(out)) out[k]!.sort((x, y) => (x.key < y.key ? -1 : 1));
    return out;
  });
}
/** The stamps and other heads of the rows `rows` names (table → keys), every label of each table, as text. */
async function unitsOf(p: Peer, rows: OnNote): Promise<string[]> {
  return onNode(p.node, async () => {
    const out: string[] = [];
    for (const [table, list] of Object.entries(rows)) {
      const labels = labelsOf(UNIT_SOURCES.find((s) => s.table === table)!), keys = list.map((x) => x.key);
      for (const t of ["sync_stamps", "sync_stamp_heads"]) {
        const r = await q<{ r: unknown }>(`SELECT to_jsonb(s) - 'workspace_id' AS r FROM ${t} s WHERE workspace_id = $1 AND table_name = ANY($2::text[]) AND row_key = ANY($3::text[])`, [p.ws, labels, keys]);
        out.push(...r.rows.map((x) => `${t} ${JSON.stringify(x.r)}`));
      }
    }
    return out.sort();
  });
}
/** The union of the keys of `xs`, table by table (what any node holds). */
const union = (xs: OnNote[]): OnNote => {
  const out: OnNote = {};
  for (const x of xs) for (const [t, list] of Object.entries(x)) for (const r of list) if (!(out[t] ??= []).some((y) => y.key === r.key)) out[t]!.push({ key: r.key, row: "" });
  return out;
};

const purge = (p: Peer, note: string) => onNode(p.node, async () => {
  await p.call("DELETE", `/api/nodes/${note}`);
  const plan = (await p.call("GET", `/api/nodes/${note}/purge-preview`)) as { ids: string[] };
  await p.call("POST", `/api/nodes/${note}/purge`, { expected_ids: plan.ids });
});
/** Every pair, both ways, three times. */
async function settle(peers: Peer[]): Promise<void> {
  for (let r = 0; r < 3; r++) for (const x of peers) for (const y of peers) if (x !== y) await exchange(x, y);
}
/** The property: the rows on `notes` and their units the same on every peer, the whole workspace the same, one more round and a full resend change nothing. */
async function expectSettled(peers: Peer[], notes: string[]): Promise<OnNote> {
  const held = await Promise.all(peers.map((p) => rowsOn(p, notes)));
  for (let i = 1; i < peers.length; i++) expect(held[i], `rows on the note: ${peers[i]!.name} against ${peers[0]!.name}`).toEqual(held[0]);
  const all = union(held);
  const units = await Promise.all(peers.map((p) => unitsOf(p, all)));
  for (let i = 1; i < peers.length; i++) expect(units[i], `their stamps and heads: ${peers[i]!.name} against ${peers[0]!.name}`).toEqual(units[0]);
  for (let i = 1; i < peers.length; i++) await expectSame(peers[0]!, peers[i]!, "the whole workspace");
  for (const x of peers) for (const y of peers) if (x !== y) {
    const again = await exchange(x, y);
    expect({ stored: again.stored, created: again.created, removed: again.removed }, `${x.name} to ${y.name}, one more round`).toEqual({ stored: 0, created: 0, removed: 0 });
    const before = await peerStateOf(y);
    const everything = await resendAll(x, y);
    expect({ created: everything.created, removed: everything.removed }, `${x.name} to ${y.name}, everything again`).toEqual({ created: 0, removed: 0 });
    const after = await peerStateOf(y);
    expect([after.stamps, after.heads], `${x.name} to ${y.name}, everything again: the same stamps and heads`).toEqual([before.stamps, before.heads]);
  }
  return held[0]!;
}

const DAY = "d1d1d1d1-0000-4d1d-8d1d-d1d1d1d1d1d1";
const TAG_DAY = "d2d2d2d2-0000-4d2d-8d2d-d2d2d2d2d2d2";

/**
 * A makes the day's note D (its body has a paragraph with a tag: an anchor, a paragraph row, the paragraph's tag, the anchors unit) and a tag note T; B and C take
 * both. A deletes both for good; C takes the deletes and makes both again under their ids (D through the route, T through the table, as a tag has no route that
 * takes an id). B, offline all along, writes on the old ones: a row of every table that hangs on a note, and a chain (a review card on B's own paragraph row).
 */
async function everyTable(): Promise<{ a: Peer; b: Peer; c: Peer; notes: string[]; onB: OnNote }> {
  const [a, b, c] = await threePeers(open);
  const other = String((await onNode(a!.node, () => a!.call("POST", "/api/nodes", { title: "M", markdown: "m", space_id: a!.space }))).id);
  await onNode(a!.node, () => a!.call("POST", "/api/tags", { name: "booky" }));
  await onNode(a!.node, () => a!.call("POST", "/api/nodes", { id: DAY, title: "A day", markdown: "A's paragraph {booky}\n\nthe day", space_id: a!.space }));
  // a tag note of its own, made like the day's note (its columns copied, then made a tag): a tag has no route that takes an id
  await onNode(a!.node, () => writeAsOwner(a!, `INSERT INTO content_nodes SELECT * FROM jsonb_populate_record(NULL::content_nodes, (SELECT to_jsonb(t) FROM content_nodes t WHERE id = $2)
    || jsonb_build_object('id', $1::text, 'title', 'a day tag', 'markdown', '', 'node_type', 'class_tag', 'slug', 'a-day-tag'))`, [TAG_DAY, DAY]));
  await exchange(a!, b!); await exchange(a!, c!);
  const tagRow = await onNode(c!.node, async () => (await q<{ v: unknown }>(`SELECT to_jsonb(t) AS v FROM content_nodes t WHERE id = $1`, [TAG_DAY])).rows[0]!.v);
  await purge(a!, DAY);
  await onNode(a!.node, () => writeAsOwner(a!, `DELETE FROM content_nodes WHERE id = $1`, [TAG_DAY]));
  await exchange(a!, c!);
  await onNode(c!.node, () => c!.call("POST", "/api/nodes", { id: DAY, title: "The same day again", markdown: "again", space_id: c!.space }));
  await onNode(c!.node, () => writeAsOwner(c!, `INSERT INTO content_nodes SELECT * FROM jsonb_populate_record(NULL::content_nodes, $1::jsonb)`, [JSON.stringify(tagRow)]));
  const booky = await onNode(b!.node, async () => (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND title = 'booky'`, [b!.ws])).rows[0]!.id);
  await onNode(b!.node, async () => {
    await b!.call("PATCH", `/api/nodes/${DAY}`, { markdown: "A's paragraph {booky}\n\nB's paragraph {booky}\n\nthe day" });
    await b!.call("PUT", `/api/nodes/${DAY}/attributes/status`, { value: "B's" });
    await writeAsOwner(b!, `INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [DAY, booky]);
    await b!.call("POST", "/api/pointers", { target_id: DAY, parent_id: other });
    await b!.call("POST", "/api/pointers", { target_id: other, parent_id: DAY });
    await writeAsOwner(b!, `INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status, origin) VALUES ($1, $2, $3, 'related', 'active', 'manual')`, [b!.ws, DAY, other]);
    await writeAsOwner(b!, `INSERT INTO node_positions (node_id, surface, x, y, workspace_id) VALUES ($1, 'scale-board', 408, 86, $2)`, [DAY, b!.ws]);
    await writeAsOwner(b!, `INSERT INTO function_refs (workspace_id, function_id, holder_node_id) VALUES ($1, 'tasks', $2)`, [b!.ws, DAY]);
    const paragraph = (await q<{ id: string }>(`SELECT id::text FROM block_nodes WHERE note_id = $1 AND text_cache LIKE 'B''s paragraph%'`, [DAY])).rows[0]!.id;
    await writeAsOwner(b!, `INSERT INTO function_refs (workspace_id, function_id, holder_block_id, config) VALUES ($1, 'review', $2, '{"due": "B"}'::jsonb)`, [b!.ws, paragraph]);
    await writeAsOwner(b!, `INSERT INTO actor_module_settings (actor_id, tag_id, settings) VALUES ($1, $2, '{"by": "B"}'::jsonb)`, [b!.owner.id, TAG_DAY]);
  });
  const onB = await rowsOn(b!, [DAY, TAG_DAY]);
  return { a: a!, b: b!, c: c!, notes: [DAY, TAG_DAY], onB };
}

describe.skipIf(!isTestDatabase())("rows on a note made again under its id: the node that holds them sends them again", () => {
  it("the tables that hang on a note come from the catalog, chains included (and not a note's own children, nor a table that hangs on nothing of a note)", async () => {
    const [a] = await threePeers(open);
    const tables = await hangingTables(a!);
    // a control that the reading finds what it must: a direct one, a row that goes with its note, a chain through a paragraph row, a tag note's own settings
    for (const t of ["node_positions", "note_pointers", "block_anchors", "block_node_tags", "actor_module_settings"]) expect(tables, t).toContain(t);
    // and does not find what it must not: the notes themselves, the feeds' mutes (they hang on a feed), the workspace's tables
    for (const t of ["content_nodes", "rss_mutes", "spaces", "workspaces"]) expect(tables, t).not.toContain(t);
  }, 600_000);

  it("every table that hangs on a note, and a chain: B's rows reach A and C; the paragraph A's delete had seen is on no node; everything settles", async () => {
    const { a, b, c, notes, onB } = await everyTable();
    // B wrote a row of every table the catalog says hangs on a note (so a table added later is covered or this fails)
    expect(Object.keys(onB).sort(), "B holds a row of every table that hangs on a note").toEqual(await hangingTables(b));
    await exchange(b, a); await exchange(c, b); await exchange(c, a);
    // (a control that the comparison sees a difference: A took B's rows while it had no D, so it holds only their stamps, and C has none of them yet)
    expect(await rowsOn(a, notes), "A, before B learns that D was made again").not.toEqual(await rowsOn(b, notes));
    await settle([a, b, c]);
    const held = await expectSettled([a, b, c], notes);
    expect(held, "every node holds B's rows").toEqual(await rowsOn(b, notes));
    for (const t of Object.keys(onB)) expect(held[t]?.length ?? 0, `${t}: B's rows are on every node`).toBeGreaterThan(0);
    // A's paragraph was in D when A deleted it for good: it went with D on A and C, and on B too (B dropped what the delete had seen when D's new creation came)
    for (const p of [a, b, c]) {
      const quotes = await onNode(p.node, async () => (await q<{ quote: string }>(`SELECT quote FROM block_anchors WHERE note_id = $1 ORDER BY quote`, [DAY])).rows.map((r) => r.quote));
      expect(quotes, `${p.name}: only B's paragraph is an anchor of D`).toEqual(["B's paragraph {booky}"]);
    }
  }, 900_000);

  // Three nodes, every order of the first three deliveries after B wrote (B to A while A has no D, C to B with D made again, C to A with it), then every pair.
  const orders = [["ba", "cb", "ca"], ["ba", "ca", "cb"], ["cb", "ba", "ca"], ["cb", "ca", "ba"], ["ca", "ba", "cb"], ["ca", "cb", "ba"]];
  for (const order of orders) {
    it(`three nodes, the deliveries in the order ${order.join(", ")}: the same rows on the note everywhere, and everything settles`, async () => {
      const [a, b, c] = await threePeers(open);
      const peers = { a: a!, b: b!, c: c! } as Record<string, Peer>;
      await onNode(a!.node, () => a!.call("POST", "/api/nodes", { id: DAY, title: "A day", markdown: "the day", space_id: a!.space }));
      await exchange(a!, b!); await exchange(a!, c!);
      await purge(a!, DAY);
      await exchange(a!, c!);
      await onNode(c!.node, () => c!.call("POST", "/api/nodes", { id: DAY, title: "The same day again", markdown: "again", space_id: c!.space }));
      await onNode(b!.node, async () => {
        await writeAsOwner(b!, `INSERT INTO node_positions (node_id, surface, x, y, workspace_id) VALUES ($1, 'scale-board', 408, 86, $2)`, [DAY, b!.ws]);
        await b!.call("PUT", `/api/nodes/${DAY}/attributes/status`, { value: "B's" });
        await b!.call("PATCH", `/api/nodes/${DAY}`, { markdown: "B's words" });
      });
      for (const step of order) await exchange(peers[step[0]!]!, peers[step[1]!]!);
      await settle([a!, b!, c!]);
      const held = await expectSettled([a!, b!, c!], [DAY]);
      expect(Object.keys(held).sort(), "B's card and attribute are on every node").toEqual(["node_attributes", "node_positions"]);
    }, 900_000);
  }

  it("the holder sent its card to a node without the note, is offline when the note is made again, and comes back later through the node that deleted it: its card reaches every node, the others' rows too", async () => {
    const [a, b, c] = await threePeers(open);
    await onNode(a!.node, () => a!.call("POST", "/api/nodes", { id: DAY, title: "A day", markdown: "the day", space_id: a!.space }));
    await exchange(a!, b!); await exchange(a!, c!);
    await purge(a!, DAY);
    // B, not knowing, places D's card and sends it to A, which has no D: A keeps only the card's `*` (its values are dropped there); then B goes offline
    await onNode(b!.node, () => writeAsOwner(b!, `INSERT INTO node_positions (node_id, surface, x, y, workspace_id) VALUES ($1, 'scale-board', 408, 86, $2)`, [DAY, b!.ws]));
    await exchange(b!, a!);
    await exchange(a!, c!);
    await onNode(c!.node, () => c!.call("POST", "/api/nodes", { id: DAY, title: "The same day again", markdown: "again", space_id: c!.space }));
    // A and C go on without B: C's new D reaches A, both write on it
    await exchange(c!, a!); await exchange(a!, c!);
    await onNode(c!.node, () => c!.call("PUT", `/api/nodes/${DAY}/attributes/status`, { value: "C's" }));
    await onNode(a!.node, () => writeAsOwner(a!, `INSERT INTO node_positions (node_id, surface, x, y, workspace_id) VALUES ($1, 'other-board', 1, 2, $2)`, [DAY, a!.ws]));
    await exchange(c!, a!); await exchange(a!, c!);
    // B comes back, and meets A first: A's bundle brings the delete and the new D at once (B never held the delete)
    await exchange(a!, b!); await exchange(b!, a!);
    await settle([a!, b!, c!]);
    const held = await expectSettled([a!, b!, c!], [DAY]);
    expect(held.node_positions?.map((x) => x.key.split("/")[1]).sort(), "B's card and A's are on every node").toEqual(["other-board", "scale-board"]);
    expect(held.node_attributes?.length, "C's attribute is on every node").toBe(1);
  }, 900_000);

  /** The card's `*` on `p`: the head shown first, then the other heads, each as (deleted, a re-send, its clock reading). */
  const cardStar = (p: Peer) => onNode(p.node, async () => {
    const cols = `deleted, COALESCE((meta->>'resent')::boolean, false) AS resent, hlc_wall::text AS wall`, where = `table_name = 'node_positions' AND row_key = $1 AND field = '*'`;
    const shown = (await q<{ deleted: boolean; resent: boolean; wall: string }>(`SELECT ${cols} FROM sync_stamps WHERE ${where}`, [`${DAY}/scale-board`])).rows;
    return [...shown, ...(await q<{ deleted: boolean; resent: boolean; wall: string }>(`SELECT ${cols} FROM sync_stamp_heads WHERE ${where}`, [`${DAY}/scale-board`])).rows];
  });
  const cardOn = (p: Peer) => onNode(p.node, async () => (await q(`SELECT 1 FROM node_positions WHERE node_id = $1 AND surface = 'scale-board'`, [DAY])).rows.length);

  // A delete written after the re-creation is not undone (the issue's "must not"). B and C both hold B's card; A deletes D for good and makes it again. B learns of the
  // new D first and sends the card again; A takes it and deletes the card. C learns of the new D from B (not from A: C has not seen A's delete of the card) and sends
  // the card again too, beside a delete it had not seen: the card stays deleted on every node.
  async function deleteBesideResend(): Promise<Peer[]> {
    const [a, b, c] = await threePeers(open);
    await onNode(a!.node, () => a!.call("POST", "/api/nodes", { id: DAY, title: "A day", markdown: "the day", space_id: a!.space }));
    await exchange(a!, b!); await exchange(a!, c!);
    await onNode(b!.node, () => writeAsOwner(b!, `INSERT INTO node_positions (node_id, surface, x, y, workspace_id) VALUES ($1, 'scale-board', 408, 86, $2)`, [DAY, b!.ws]));
    await exchange(b!, c!);
    await purge(a!, DAY);
    await onNode(a!.node, () => a!.call("POST", "/api/nodes", { id: DAY, title: "The same day again", markdown: "again", space_id: a!.space }));
    await exchange(a!, b!); // B: D made again over a delete it had not seen: it sends the card again
    await exchange(b!, a!); // A makes the card from B's re-send
    expect(await cardOn(a!), "A holds the card B sent again").toBe(1);
    await onNode(a!.node, () => writeAsOwner(a!, `DELETE FROM node_positions WHERE node_id = $1 AND surface = 'scale-board'`, [DAY]));
    await exchange(b!, c!); // C: learns of the new D from B (B has not seen A's delete of the card): it sends the card again
    await exchange(c!, a!);
    const star = await cardStar(a!);
    expect(star.find((x) => !x.deleted && x.resent), "C's re-send is a head on A, beside A's delete").toBeDefined();
    expect(star[0], "the head A shows is its delete").toMatchObject({ deleted: true });
    return [a!, b!, c!];
  }
  it("a delete written after one holder's re-send is not undone by a second holder's later re-send", async () => {
    const [a, b, c] = await deleteBesideResend();
    await settle([a!, b!, c!]);
    for (const p of [a!, b!, c!]) expect(await cardOn(p), `${p.name}: the card stays deleted`).toBe(0);
    await expectSettled([a!, b!, c!], [DAY]);
  }, 900_000);
  // Review of PR #2024, round 2, point 1: the re-send beside that later delete is no other value (unit.ts conflictsOf skips it, and so does migration 240's refusal
  // of a system write). Before, the system and the AI could never write that row again: every write was refused with sync_unit_in_conflict until a person wrote it.
  it("a system write (not a person's) to the row whose `*` holds a re-send beside a later delete is written, and reaches every node", async () => {
    const [a, b, c] = await deleteBesideResend();
    await onNode(a!.node, () => withTransaction(() => withEventTransaction(a!.ws, async () => {
      await stampTransaction(a!.ws, a!.owner.id, { notAPerson: true });
      await q(`INSERT INTO node_positions (node_id, surface, x, y, workspace_id) VALUES ($1, 'scale-board', 5, 6, $2)`, [DAY, a!.ws]);
    })));
    expect(await cardOn(a!), "A: the system's card is written").toBe(1);
    expect((await cardStar(a!)).map((x) => [x.deleted, x.resent]), "it had seen the delete and the re-send: one head").toEqual([[false, false]]);
    await settle([a!, b!, c!]);
    for (const p of [a!, b!, c!]) expect(await cardOn(p), `${p.name}: the card is there`).toBe(1);
    await expectSettled([a!, b!, c!], [DAY]);
  }, 900_000);

  // The case where the RANK decides, not the clock: a delete the holder had not seen, written before the note was made again. B and C hold B's card; C deletes it
  // (and tells no one); A deletes D for good and makes it again; B learns of the new D and sends the card again, beside C's delete, which it never saw. B's re-send has
  // the later clock reading (the new creation's), and still the card stays deleted: a re-send ranks below every head that is not one (unit.ts isResent).
  it("a delete the holder had not seen, written before the note was made again, is not undone by its re-send (the rank decides, not the clock)", async () => {
    const [a, b, c] = await threePeers(open);
    await onNode(a!.node, () => a!.call("POST", "/api/nodes", { id: DAY, title: "A day", markdown: "the day", space_id: a!.space }));
    await exchange(a!, b!); await exchange(a!, c!);
    await onNode(b!.node, () => writeAsOwner(b!, `INSERT INTO node_positions (node_id, surface, x, y, workspace_id) VALUES ($1, 'scale-board', 408, 86, $2)`, [DAY, b!.ws]));
    await exchange(b!, c!);
    await onNode(c!.node, () => writeAsOwner(c!, `DELETE FROM node_positions WHERE node_id = $1 AND surface = 'scale-board'`, [DAY]));
    await new Promise((r) => setTimeout(r, 30)); // the new creation has a later clock reading than C's delete
    await purge(a!, DAY);
    await onNode(a!.node, () => a!.call("POST", "/api/nodes", { id: DAY, title: "The same day again", markdown: "again", space_id: a!.space }));
    await exchange(a!, b!); // B sends the card again
    await exchange(b!, c!); // C takes B's re-send beside its own delete
    const star = await cardStar(c!);
    // the control: the re-send is the later stamp, so by the clock alone it would show the card again
    expect(star.map((x) => [x.deleted, x.resent]), "C: its delete and B's re-send").toEqual([[true, false], [false, true]]);
    expect(Number(star[1]!.wall), "B's re-send is later than C's delete").toBeGreaterThan(Number(star[0]!.wall));
    expect(await cardOn(c!), "C: the card stays deleted").toBe(0);
    await settle([a!, b!, c!]);
    for (const p of [a!, b!, c!]) expect(await cardOn(p), `${p.name}: the card stays deleted`).toBe(0);
    await expectSettled([a!, b!, c!], [DAY]);
  }, 900_000);

  // Found by the order "ca, ba, cb" of the test above when B also changed D's TITLE (main has it too, without this batch: the same order and steps fail there on the
  // same column): a note's slug is no unit (README 「slug」). A creation that wins `*` over a note that is here writes its carried columns, the slug among them
  // (dbRows.ts carriedFrom `overwrite`), while this node's own later title stays the winner of `title`: on B the slug is then the creation's, under B's title; on A,
  // which took B's title as the incoming winner, it is the title's. Pinned, not fixed here (the slug's rule, not the rows on the note).
  async function slugOverRetitled(): Promise<{ a: Peer; b: Peer }> {
    const [a, b, c] = await threePeers(open);
    await onNode(a!.node, () => a!.call("POST", "/api/nodes", { id: DAY, title: "A day", markdown: "the day", space_id: a!.space }));
    await exchange(a!, b!); await exchange(a!, c!);
    await purge(a!, DAY);
    await exchange(a!, c!);
    await onNode(c!.node, () => c!.call("POST", "/api/nodes", { id: DAY, title: "The same day again", markdown: "again", space_id: c!.space }));
    await onNode(b!.node, () => b!.call("PATCH", `/api/nodes/${DAY}`, { title: "B's day" }));
    await exchange(c!, a!); await exchange(b!, a!); await exchange(c!, b!);
    await settle([a!, b!, c!]);
    return { a: a!, b: b! };
  }
  const slugAndTitle = (p: Peer) => onNode(p.node, async () => (await q<{ slug: string; title: string }>(`SELECT slug, title FROM content_nodes WHERE id = $1`, [DAY])).rows[0]);
  it("the slug of a note made again, under a title another node changed: what differs today (the same title, two slugs)", async () => {
    const { a, b } = await slugOverRetitled();
    const [sa, sb] = [await slugAndTitle(a), await slugAndTitle(b)];
    expect(sa?.title, "the same title").toBe(sb?.title);
    expect(sb?.slug, "B: the slug of C's creation").toBe("the-same-day-again");
    expect(sa?.slug, "A: the slug of B's title").not.toBe(sb?.slug);
  }, 600_000);
  it.fails("FINDING: the slug of a note made again, under a title another node changed: the same slug on both (fails today: the slug is no unit, so a creation that wins `*` writes its own slug under this node's later title; README 「slug」, fixed with the slug as a unit)", async () => {
    const { a, b } = await slugOverRetitled();
    expect(await slugAndTitle(b)).toEqual(await slugAndTitle(a));
  }, 600_000);
});

const rowOf = (p: Peer, table: string, id: string) => onNode(p.node, async () => (await q<{ v: unknown }>(`SELECT to_jsonb(t) AS v FROM "${table}" t WHERE id = $1`, [id])).rows[0]?.v);
const makeAgain = (p: Peer, row: unknown) => onNode(p.node, () => writeAsOwner(p, `INSERT INTO content_nodes SELECT * FROM jsonb_populate_record(NULL::content_nodes, $1::jsonb)`, [JSON.stringify(row)]));
const count = (p: Peer, sql: string, params: unknown[]) => onNode(p.node, async () => (await q(sql, params)).rows.length);

// Review of PR #2024, round 1, points 2 and 3: a delete the deleter had SEEN is never sent back to life by the holder's re-send. Each scenario is a row that hangs on
// a note A deletes for good after holding all of it, C makes the note again under its id, and B, which held the note alive all along, learns of the new creation:
// B must let the row go as A's delete took it (dbRows.ts goneWithTheDelete, one rule for every table that hangs on a note), never send it again. The judge is what
// A had seen when it deleted: since migration 240 the tombstone's `meta.seen` is A's progress of every origin, so a row written in a transaction of its own (a
// module setting, an anchor recovery) is in it.
describe.skipIf(!isTestDatabase())("a delete the deleter had seen is never sent back to life", () => {

  // point 2 (a): actor_module_settings finds its workspace through its tag (`via:tag_id`, migration 198): when the tag goes, its trigger finds none and writes no
  // tombstone; the setting's `*` stays a live creation on A. Its write is a transaction of its own, after the tag's last write.
  it("a module setting on a tag purged and made again: on no node afterwards", async () => {
    const [a, b, c] = await threePeers(open);
    const tag = String((await onNode(a!.node, () => a!.call("POST", "/api/tags", { name: "settled" }))).id);
    await onNode(a!.node, () => writeAsOwner(a!, `INSERT INTO actor_module_settings (actor_id, tag_id, settings) VALUES ($1, $2, '{"by": "A"}'::jsonb)`, [a!.owner.id, tag]));
    await exchange(a!, b!); await exchange(a!, c!);
    const tagRow = await rowOf(c!, "content_nodes", tag);
    await onNode(a!.node, () => writeAsOwner(a!, `DELETE FROM content_nodes WHERE id = $1`, [tag]));
    await exchange(a!, c!);
    await makeAgain(c!, tagRow);
    const setting = `SELECT 1 FROM actor_module_settings WHERE tag_id = $1`;
    expect(await count(b!, setting, [tag]), "B holds the setting before it learns of the new tag").toBe(1);
    await exchange(c!, b!); // B: the tag made again over a delete it had not seen; the delete had seen the setting
    expect(await count(b!, setting, [tag]), "B: the setting went with the delete").toBe(0);
    await settle([a!, b!, c!]);
    for (const p of [a!, b!, c!]) expect(await count(p, setting, [tag]), `${p.name}: no setting`).toBe(0);
    await expectSettled([a!, b!, c!], [tag]);
  }, 900_000);

  // point 2 (b): node_tags finds its workspace through its note or its tag (`via:node_id,tag_id`, migration 194): both purged in one statement, its trigger finds
  // neither, and writes no tombstone
  it("a note's tag with both ends purged together and made again: on no node afterwards", async () => {
    const [a, b, c] = await threePeers(open);
    const note = String((await onNode(a!.node, () => a!.call("POST", "/api/nodes", { title: "Tagged", markdown: "tagged", space_id: a!.space }))).id);
    const tag = String((await onNode(a!.node, () => a!.call("POST", "/api/tags", { name: "both-ends" }))).id);
    await onNode(a!.node, () => a!.call("PUT", `/api/nodes/${note}/tags/${tag}`));
    await exchange(a!, b!); await exchange(a!, c!);
    const rows = [await rowOf(c!, "content_nodes", note), await rowOf(c!, "content_nodes", tag)];
    await onNode(a!.node, () => writeAsOwner(a!, `DELETE FROM content_nodes WHERE id = ANY($1::uuid[])`, [[note, tag]]));
    await exchange(a!, c!);
    for (const r of rows) await makeAgain(c!, r);
    const link = `SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`;
    expect(await count(b!, link, [note, tag]), "B holds the tag before it learns of the new note and tag").toBe(1);
    await exchange(c!, b!);
    expect(await count(b!, link, [note, tag]), "B: the tag went with the delete").toBe(0);
    await settle([a!, b!, c!]);
    for (const p of [a!, b!, c!]) expect(await count(p, link, [note, tag]), `${p.name}: no tag`).toBe(0);
    await expectSettled([a!, b!, c!], [note, tag]);
  }, 900_000);

  // point 3: the anchor recovery is a system job's transaction of its own (services/blockAnchors/recover.ts): it writes the anchors and the anchors unit, not the note.
  // It runs from the outbox, so it can come after the note went to the trash (the last write of the note's own units): A's delete for good had seen it (it ran on A,
  // before the delete), and the note's own units alone do not say so.
  it("anchors a recovery wrote in a transaction of its own, which the deleter had seen: on no node afterwards, and no bundle refused", async () => {
    const [a, b, c] = await threePeers(open);
    const note = "e3e3e3e3-0000-4e3e-8e3e-e3e3e3e3e3e3";
    const ps = Array.from({ length: FIND_BUDGET + 4 }, (_, i) => `Paragraph number ${i} talks about its own topic ${"abcdefghijklmnop"[i]} at some length {plan}`);
    const doc = (xs: readonly string[]) => xs.join("\n\n") + "\n";
    await onNode(a!.node, () => a!.call("POST", "/api/nodes", { id: note, title: "Recovered", markdown: doc(ps), space_id: a!.space }));
    // a body whose anchors were not measured on it, then a save: more anchors to look up than a save may, so some are left for the recovery (as anchorsReplicated does)
    await onNode(a!.node, () => seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [note, doc([...ps].reverse())]));
    await onNode(a!.node, () => a!.call("PATCH", `/api/nodes/${note}`, { markdown: doc([...ps].reverse()) + "\n" }));
    const pending = (p: Peer) => count(p, `SELECT 1 FROM block_anchors WHERE note_id = $1 AND recovery_pending`, [note]);
    expect(await pending(a!), "the save left anchors to look up").toBeGreaterThan(0);
    await onNode(a!.node, () => a!.call("DELETE", `/api/nodes/${note}`)); // to the trash: the note's own last write
    await onNode(a!.node, () => recoverAnchors(a!.ws, note));
    expect(await pending(a!), "A's recovery found them").toBe(0);
    await exchange(a!, b!); await exchange(a!, c!);
    // the anchors and the note's anchors unit (the recovery wrote the unit's places: the write the note's own units do not know of)
    const anchors = async (p: Peer) => await count(p, `SELECT 1 FROM block_anchors WHERE note_id = $1`, [note]) + await count(p, `SELECT 1 FROM note_anchor_places WHERE note_id = $1`, [note]);
    expect(await anchors(b!), "B holds the anchors A's recovery wrote").toBeGreaterThan(0);
    await onNode(a!.node, async () => {
      const plan = (await a!.call("GET", `/api/nodes/${note}/purge-preview`)) as { ids: string[] };
      await a!.call("POST", `/api/nodes/${note}/purge`, { expected_ids: plan.ids });
    });
    await exchange(a!, c!);
    await onNode(c!.node, () => c!.call("POST", "/api/nodes", { id: note, title: "Made again", markdown: "again", space_id: c!.space }));
    await exchange(c!, b!);
    expect(await anchors(b!), "B: the anchors went with the delete").toBe(0);
    await settle([a!, b!, c!]);
    for (const p of [a!, b!, c!]) expect(await anchors(p), `${p.name}: no anchor of the deleted text`).toBe(0);
    await expectSettled([a!, b!, c!], [note]);
  }, 900_000);
});

// Review of PR #2024, round 1, point 5: a system job or the AI removes a tag from a day's note made again. The holder's re-send left a second head on the tag's `*`;
// both say "the tag is on the note", so the core counts no conflict, and since migration 240 neither does the database (before, every such write was refused with
// sync_unit_in_conflict until a person removed the tag). The control that a head with other content still refuses is syncSystemWriteConflict.integration.test.ts.
describe.skipIf(!isTestDatabase())("a system write on a note made again", () => {
  it("the AI (a write that is not a person's) removes the tag the holder sent again: written, and gone on every node", async () => {
    const [a, b, c] = await threePeers(open);
    await onNode(a!.node, () => a!.call("POST", "/api/nodes", { id: DAY, title: "A day", markdown: "the day", space_id: a!.space }));
    const tag = String((await onNode(a!.node, () => a!.call("POST", "/api/tags", { name: "daily" }))).id);
    await exchange(a!, b!); await exchange(a!, c!);
    await purge(a!, DAY);
    await exchange(a!, c!);
    await onNode(c!.node, () => c!.call("POST", "/api/nodes", { id: DAY, title: "The same day again", markdown: "again", space_id: c!.space }));
    await onNode(b!.node, () => b!.call("PUT", `/api/nodes/${DAY}/tags/${tag}`)); // B, offline, tags the old day
    await exchange(c!, b!); // B sends the tag again
    await exchange(b!, a!);
    const key = `${DAY}/${tag}`;
    const heads = (p: Peer) => count(p, `SELECT 1 FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = 'node_tags' AND row_key = $2 AND field = '*'`, [p.ws, key]);
    expect(await heads(a!), "A: the tag's `*` holds the re-send beside its creation").toBe(1);
    await onNode(a!.node, () => withTransaction(() => withEventTransaction(a!.ws, async () => {
      await stampTransaction(a!.ws, a!.owner.id, { notAPerson: true });
      await q(`DELETE FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [DAY, tag]);
    })));
    const link = `SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`;
    expect(await count(a!, link, [DAY, tag]), "A: the AI's removal is written").toBe(0);
    expect(await heads(a!), "it had seen both heads").toBe(0);
    await settle([a!, b!, c!]);
    for (const p of [a!, b!, c!]) expect(await count(p, link, [DAY, tag]), `${p.name}: the tag is off`).toBe(0);
    await expectSettled([a!, b!, c!], [DAY]);
  }, 900_000);
});
