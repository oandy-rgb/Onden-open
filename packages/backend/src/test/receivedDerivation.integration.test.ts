// What a node derives from the rows it took by change bundle (batch 4a: services/receivedDerivation.ts, the finishing step of spine/stampedImport.ts applyChangeBundle;
// docs/architecture/proposals/own-node-transport-2026-11-22.md §2.12). Two nodes of this process (helpers/distSim/realNode.ts: PGlite databases, or databases of the real
// server of DATABASE_URL; the same test bodies run on both).
// What is proved, each by a test that fails when its mechanism is taken out:
//   P1  taking a bundle and deriving writes ZERO units here: every unit of every table of UNIT_SOURCES (row, watched fields) and every stamp and head of the workspace are
//       the same just before and just after the derivation, and this node's sequence number does not move (a control proves the check sees a replicated write).
//       It watches EVERY bundle every test of this file takes (beforeEach / afterEach below), not only the tests that name it.
//   P2  for every scenario, the derived rows (DERIVED below) are the same on the node that wrote and on the node that took the write, in both orders of delivery and
//       after everything is sent again.
//   P5  `- [ ] milk {task}` written on one node is ONE task on both.
//   and: the values a note's text gives it travel (migration 223); slugs (spine/noteSlugs.ts): a move made here never changes the slug of a note already in the
//   target space, and two nodes that each moved a note with one slug into one space end with the same slugs in either order; `[[slug]]` names the same note; a tag
//   applied and a tag's schema taken by bundle type the values as they are typed where they were written; the website hears a takedown that came by bundle, and a
//   bundle never publishes; a permanent delete taken by bundle erases what a local one erases and keeps what a living note shares; a bundle is never taken without
//   its derivation, and a derivation that fails refuses it with a code.
// The writes before each test are random: a new seed each run (PROPS_SEED replays one; it is printed).
// SAFETY: databases made from the migrated template (PGlite, or new databases on a `_test` server); nothing shared is touched.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, fillFrom, openNode } from "./helpers/stampedWorld.js";
import { admit, exchange, markWorld, peerOf, resendAll, writeFor, makeRng, type Peer } from "./helpers/stampedBundleWorld.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import { UNIT_SOURCES, rowMatchOf, unitTextsSql, quote } from "../spine/stampedMerge/dbUnits.js";
import { receivedDerivation, setReceivedDerivation } from "../spine/receivedDerivation.js";

type ReceivedDerivation = NonNullable<ReturnType<typeof receivedDerivation>>;
import { syncBlockNodes } from "../services/blockNodes.js";
import { PROPS_SEED } from "./helpers/propsConfig.js";

/** A new seed each run unless PROPS_SEED names one (helpers/propsConfig.ts; its default is fixed, so it is used only when set). */
const SEED = process.env.PROPS_SEED ? PROPS_SEED : 1 + Math.floor(Math.random() * 2 ** 30);
console.log(`[receivedDerivation] seed ${SEED} (replay: PROPS_SEED=${SEED})`);

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
registerShippedModules(); // the website's and the semantic index's hooks, as the app mounts them

const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

/** A (the centre) holds a world; B joins it by snapshot; A admits B. Every module on in both. */
async function pair(seed: number): Promise<{ a: Peer; b: Peer; nodes: RealNode[] }> {
  const [na, nb] = [await openNode("a"), await openNode("b")];
  open.push(na, nb);
  const world = await buildSourceWorld(na);
  const a = peerOf("A", na, world);
  await markWorld(a);
  await writeFor(a, makeRng(SEED + seed), 6, { weights: { title: 0, body: 0, move: 0, reorder: 0, trash: 0, undelete: 0, purge: 0, recreate: 0 } });
  const cap = await capture(na, world, 12_000);
  await fillFrom(nb, world, cap);
  const b = peerOf("B", nb, world);
  await admit(a, b);
  for (const p of [a, b]) await onNode(p.node, () => setModulesOn(p.ws, null));
  return { a, b, nodes: [na, nb] };
}

/** A write through the routes, with the dispatcher's work after commit (the values the text gives) done before it returns. */
const write = async (p: Peer, method: string, path: string, body?: unknown): Promise<any> => onNode(p.node, async () => {
  const r = await p.call(method, path, body);
  await awaitAllDispatchers();
  return r;
});
const note = async (p: Peer, title: string, markdown = "", extra: Record<string, unknown> = {}): Promise<string> =>
  (await write(p, "POST", "/api/nodes", { id: randomUUID(), title, markdown, space_id: p.space, ...extra })).id as string;

/** The derived rows of the notes `ids` (and of what links to or from them), as plain data two nodes can be compared by. Every derived table a body write or a
 *  received bundle writes (spine/syncClasses.json `derived`, and the derived columns of stamped tables): see the PR's list. */
const DERIVED: Record<string, string> = {
  // [[links]] out of and into the notes (node_edges of origin `wikilink`: derived; only `manual` edges are units)
  edges: `SELECT source_node_id::text, target_node_id::text, status FROM node_edges WHERE workspace_id = $1 AND origin = 'wikilink' AND (source_node_id = ANY($2::uuid[]) OR target_node_id = ANY($2::uuid[])) ORDER BY 1, 2`,
  // what each note links to (note_link_index), the index relinkTarget reads
  linkIndex: `SELECT note_id::text, link_lc, link_slug, stale FROM note_link_index WHERE workspace_id = $1 AND note_id = ANY($2::uuid[]) ORDER BY 1`,
  // the anchor id index of the block-link fallback (note_block_refs)
  blockRefs: `SELECT note_id::text, block_ref FROM note_block_refs WHERE workspace_id = $1 AND note_id = ANY($2::uuid[]) ORDER BY 1, 2`,
  // the display columns of the paragraph rows (no unit: dbUnits.ts fields of block_nodes)
  blockDisplay: `SELECT id::text, block_ref, kind, label, text_cache, parent_block_id::text, hidden_at IS NOT NULL AS hidden FROM block_nodes WHERE workspace_id = $1 AND note_id = ANY($2::uuid[]) ORDER BY 1`,
  // slug and the space a note is in (derived from the tree, migration 218)
  placeAndSlug: `SELECT id::text, slug, space_id::text, deleted_at IS NOT NULL AS deleted FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[]) ORDER BY 1`,
  // every attribute of the notes: the values their text gives (units since migration 223) and the derived ones (`_block_autotag` on a tag a block save made), with type and source
  attributes: `SELECT node_id::text, key, value, value_type, source FROM node_attributes WHERE workspace_id = $1 AND (node_id = ANY($2::uuid[]) OR node_id IN (SELECT tag_id FROM block_node_tags bt JOIN block_nodes b ON b.id = bt.block_node_id WHERE b.note_id = ANY($2::uuid[]))) ORDER BY 1, 2`,
  // the tasks of task lines (one per line) and their notes
  tasks: `SELECT b.block_ref, t.title, t.parent_id::text FROM block_nodes b JOIN content_nodes t ON t.id = b.task_id WHERE b.workspace_id = $1 AND b.note_id = ANY($2::uuid[]) ORDER BY 1`,
};
const derivedOf = (p: Peer, ids: readonly string[]) => onNode(p.node, async () =>
  Object.fromEntries(await Promise.all(Object.entries(DERIVED).map(async ([k, sql]) => [k, (await q(sql, [p.ws, ids])).rows] as const))));
async function expectSameDerived(a: Peer, b: Peer, ids: readonly string[], label: string): Promise<Record<string, unknown>> {
  const [da, db] = [await derivedOf(a, ids), await derivedOf(b, ids)];
  for (const k of Object.keys(DERIVED)) expect(db[k], `${label}: ${k}`).toEqual(da[k]);
  return da;
}

/** Every unit of the workspace (row keys and the text of every watched field, by UNIT_SOURCES and its `where`), every stamp and head, and the clock's next
 *  sequence number: what P1 compares just before and just after the derivation. */
async function unitsAndStamps(workspaceId: string): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const src of UNIT_SOURCES) {
    const m = rowMatchOf(src, []);
    const params: unknown[] = [workspaceId];
    const r = await q<{ d: string | null }>(
      `SELECT md5(string_agg(${m.idSql("t")} || '=' || (${unitTextsSql(src, "t")})::text, ',' ORDER BY ${m.idSql("t")})) AS d
         FROM ${quote(src.table)} t WHERE ${m.workspace("t", "$1")}${src.where ? ` AND ${src.where}` : ""}`, params);
    out[src.label] = r.rows[0]?.d ?? null;
  }
  for (const t of ["sync_stamps", "sync_stamp_heads"]) {
    out[t] = (await q<{ d: string | null }>(`SELECT md5(string_agg(row(s.*)::text, ',' ORDER BY row(s.*)::text)) AS d FROM ${t} s WHERE s.workspace_id = $1`, [workspaceId])).rows[0]?.d ?? null;
  }
  out.next_seq = (await q<{ n: string }>(`SELECT next_seq::text AS n FROM sync_clock WHERE workspace_id = $1`, [workspaceId])).rows[0]?.n ?? null;
  return out;
}

/** Run `fn` with the derivation wrapped so that every unit and stamp is read just before it and just after it; returns the pairs, one per bundle taken. */
async function watchingUnits<T>(fn: () => Promise<T>, extra?: (workspaceId: string) => Promise<void>): Promise<{ result: T; pairs: Array<[Record<string, string | null>, Record<string, string | null>]> }> {
  const real = receivedDerivation()!;
  const pairs: Array<[Record<string, string | null>, Record<string, string | null>]> = [];
  const watched: ReceivedDerivation = {
    before: real.before,
    after: async (prepared, bundle) => {
      const before = await unitsAndStamps(bundle.workspaceId);
      await real.after(prepared, bundle);
      await extra?.(bundle.workspaceId);
      pairs.push([before, await unitsAndStamps(bundle.workspaceId)]);
    },
  };
  setReceivedDerivation(watched);
  try { return { result: await fn(), pairs }; } finally { setReceivedDerivation(real); }
}

/** P1 around every bundle of every test: the pairs of the test that runs (`control`: the one test that expects a unit written, to prove the check sees one). */
let watch: { pairs: Array<[Record<string, string | null>, Record<string, string | null>]>; control: boolean; restore: () => void } | null = null;
beforeEach(() => {
  const real = receivedDerivation()!;
  const pairs: Array<[Record<string, string | null>, Record<string, string | null>]> = [];
  setReceivedDerivation({
    before: real.before,
    after: async (prepared, bundle) => {
      const before = await unitsAndStamps(bundle.workspaceId);
      await real.after(prepared, bundle);
      pairs.push([before, await unitsAndStamps(bundle.workspaceId)]);
    },
  });
  watch = { pairs, control: false, restore: () => setReceivedDerivation(real) };
});
afterEach(() => {
  const w = watch!;
  w.restore();
  watch = null;
  if (w.control) return;
  expect(w.pairs.length, "P1: the test took at least one bundle").toBeGreaterThan(0);
  for (const [i, [before, after]] of w.pairs.entries()) expect(after, `P1: bundle ${i + 1} of the test`).toEqual(before);
});

// A note body that has every derived thing a body gives: links (by title, by alias), a tagged paragraph (block row, an auto-made tag), a task line, an inline value and frontmatter.
const BODY = [
  "---", "aliases: [Probe Alias]", "rating: 4", "---",
  "# Probe", "", "due:: 2026-12-01", "",
  "See [[Target Note]] and [[Other Alias]] here {probe-made}", "",
  "- [ ] milk {task}", "",
  "a plain paragraph {review}", "",
].join("\n");

describe.skipIf(!isTestDb)("what a node derives from a bundle it took (batch 4a)", () => {
  it("P1 + P2 + P5: a body with links, paragraphs, a task line and text values, edited on both nodes, delivered in both orders and sent again: no unit is written by the derivation, the derived rows are the same, one task", async () => {
    const { a, b, nodes } = await pair(1);
    const target = await note(a, "Target Note");
    const other = await note(a, "Other", "---\naliases: [Other Alias]\n---\nother text");
    const probe = await note(a, "Probe", BODY);
    const linker = await note(a, "Linker", "points at [[Probe Alias]] and [[Target Note]]");
    const ids = [target, other, probe, linker];
    const first = await watchingUnits(() => exchange(a, b));
    expect(first.result.rejected).toEqual([]);
    for (const [before, after] of first.pairs) expect(after).toEqual(before); // P1
    await expectSameDerived(a, b, ids, "after A's writes reached B");
    // the values the text gives travelled (migration 223), so `[[Other Alias]]` reaches Other on B too
    const aliasEdge = (p: Peer) => onNode(p.node, async () => (await q(`SELECT 1 FROM node_edges WHERE source_node_id = $1 AND target_node_id = $2 AND origin = 'wikilink'`, [probe, other])).rowCount);
    expect([await aliasEdge(a), await aliasEdge(b)]).toEqual([1, 1]);
    const due = (p: Peer) => onNode(p.node, async () => (await q<{ value: string; source: string }>(`SELECT value, source FROM node_attributes WHERE node_id = $1 AND key = 'due'`, [probe])).rows);
    expect(await due(b)).toEqual(await due(a));
    expect((await due(a))[0]?.source).toBe("markdown");
    // P5: one task for the one line, on both
    const tasks = (p: Peer) => onNode(p.node, async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM block_nodes WHERE note_id = $1 AND task_id IS NOT NULL`, [probe])).rows[0]!.n));
    const taskNotes = (p: Peer) => onNode(p.node, async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM content_nodes WHERE parent_id = $1`, [probe])).rows[0]!.n));
    expect([await tasks(a), await tasks(b), await taskNotes(a), await taskNotes(b)]).toEqual([1, 1, 1, 1]);

    // both nodes write without exchanging: A renames the target and edits the probe; B edits the probe's other paragraph and adds a link to the new name
    await write(a, "PATCH", `/api/nodes/${target}`, { title: "Target Renamed" });
    await write(a, "PATCH", `/api/nodes/${probe}`, { markdown: BODY.replace("a plain paragraph {review}", "a plain paragraph, edited on A {review}\n\n- [ ] eggs {task}") });
    await write(b, "PATCH", `/api/nodes/${linker}`, { markdown: "points at [[Probe Alias]], [[Target Note]] and [[Target Renamed]] {linker-made}" });
    // the second order from the same state: copies of both nodes
    const a2n = await RealNode.open("a2", nodes[0]!), b2n = await RealNode.open("b2", nodes[1]!);
    open.push(a2n, b2n);
    const a2 = { ...a, node: a2n, name: "A2" } as Peer, b2 = { ...b, node: b2n, name: "B2" } as Peer;
    const one = await watchingUnits(async () => { await exchange(a, b); await exchange(b, a); });
    const two = await watchingUnits(async () => { await exchange(b2, a2); await exchange(a2, b2); });
    for (const [before, after] of [...one.pairs, ...two.pairs]) expect(after).toEqual(before); // P1, every bundle of both orders
    const d1 = await expectSameDerived(a, b, ids, "A→B then B→A");
    const d2 = await expectSameDerived(a2, b2, ids, "B→A then A→B");
    expect(d2).toEqual(d1);
    expect([await tasks(a), await tasks(b)]).toEqual([2, 2]); // P5: milk and eggs, once each
    // everything sent again: nothing derived changes, no unit is written
    const again = await watchingUnits(async () => { await resendAll(a, b); await resendAll(b, a); });
    for (const [before, after] of again.pairs) expect(after).toEqual(before);
    expect(await derivedOf(a, ids)).toEqual(d1);
    expect(await derivedOf(b, ids)).toEqual(d1);
  }, 600_000);

  it("P1 sees a replicated write: a derivation that runs the replicated half of a body write again (blockNodes.ts syncBlockNodes, as a node would if it ran the whole local chain) is caught", async () => {
    const { a, b } = await pair(2);
    watch!.control = true; // this test expects a unit written: it proves the check sees one
    const probe = await note(a, "Probe", "");
    await write(a, "POST", "/api/tags", { name: "other-tag" });
    await exchange(a, b);
    await write(a, "PATCH", `/api/nodes/${probe}`, { markdown: "- [ ] milk {task}\n\nfresh paragraph {made-here}\n" });
    const owner = b.owner;
    const caught = await watchingUnits(() => exchange(a, b), async (workspaceId) => {
      const body = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [probe])).rows[0]!.markdown;
      // the wrong thing: the replicated half of the local chain, run on the receiver over a text that is not the merged one (one more tag on a paragraph): it writes that
      // paragraph's tag mark (block_node_tags, a unit) and makes the tag
      await syncBlockNodes({ workspaceId, noteId: probe, markdown: body.replace("{made-here}", "{made-here, other-tag}"), actor: owner, eventId: (await q<{ id: string }>(`SELECT max(id)::text AS id FROM domain_events WHERE workspace_id = $1`, [workspaceId])).rows[0]!.id });
    });
    expect(caught.pairs.some(([before, after]) => JSON.stringify(before) !== JSON.stringify(after))).toBe(true);
  }, 600_000);

  /** The other space of the world (World B…) as A holds it, the space epoch, and a move through the route. */
  const otherSpace = (p: Peer) => onNode(p.node, async () => (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND id <> $2 AND name LIKE 'World B%'`, [p.ws, p.space])).rows[0]!.id);
  const moveTo = async (p: Peer, nodeId: string, toSpace: string) => {
    const epoch = await onNode(p.node, async () => (await q<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [p.ws])).rows[0]!.e);
    return write(p, "POST", "/api/spaces/move", { node_id: nodeId, to_space_id: toSpace, membership_epoch: epoch });
  };
  const slugsOf = (p: Peer, ids: readonly string[]) => onNode(p.node, async () =>
    Object.fromEntries((await q<{ id: string; slug: string }>(`SELECT id::text, slug FROM content_nodes WHERE id = ANY($1::uuid[])`, [ids])).rows.map((r) => [r.id, r.slug] as const)));
  /** Two ids, the first smaller than the second (uuid text order: the order the id rule and every `ORDER BY id` use). */
  const orderedIds = (): [string, string] => { const x = [randomUUID(), randomUUID()].sort(); return [x[0]!, x[1]!]; };

  it("slugs, a move made here (review of PR #1941, round 1, point 1): the notes already in the target space keep their slugs whichever id is larger; the moved note and the note under it take the next free one, as on main; B ends with the same, and `[[slug]]` names the same note on both", async () => {
    const { a, b } = await pair(3);
    const away = await otherSpace(a);
    for (const residentFirst of [true, false]) {
      const [small, large] = orderedIds(), [small2, large2] = orderedIds();
      const tag = randomUUID().slice(0, 6);
      // in A's space: "Clash" and "Under Clash"; in the other space: a note "Clash" with a child "Under Clash". The id order of resident and mover is set, both ways
      const here = await note(a, `Clash ${tag}`, "", { id: residentFirst ? small : large });
      const hereChild = await note(a, `Under Clash ${tag}`, "", { id: residentFirst ? small2 : large2 });
      const there = await note(a, `Clash ${tag}`, "", { id: residentFirst ? large : small, space_id: away });
      const thereChild = await note(a, `Under Clash ${tag}`, "", { id: residentFirst ? large2 : small2, space_id: away, parent_id: there });
      const linkerBefore = await note(a, "Links to the resident", `see [[clash-${tag}]] and [[under-clash-${tag}]]`);
      await exchange(a, b);
      const before = await slugsOf(a, [here, hereChild]);
      expect(before).toEqual({ [here]: `clash-${tag}`, [hereChild]: `under-clash-${tag}` });
      await moveTo(a, there, a.space);
      const atA = await slugsOf(a, [here, hereChild, there, thereChild]);
      // (i) and (iii): the notes already there keep their slugs (their published address); the moved ones take the next free one (main: services/nodes.ts uniqueSlug)
      expect(atA).toEqual({ ...before, [there]: `clash-${tag}-2`, [thereChild]: `under-clash-${tag}-2` });
      const linker = await note(a, "By slug", `[[clash-${tag}-2]] [[under-clash-${tag}-2]]`);
      await exchange(a, b);
      // (ii): the node that took the move holds the same slugs
      expect(await slugsOf(b, [here, hereChild, there, thereChild])).toEqual(atA);
      await expectSameDerived(a, b, [here, hereChild, there, thereChild, linker, linkerBefore], `slugs, resident id ${residentFirst ? "smaller" : "larger"}`);
      const named = (p: Peer, from: string) => onNode(p.node, async () => (await q<{ t: string }>(`SELECT target_node_id::text AS t FROM node_edges WHERE source_node_id = $1 AND origin = 'wikilink' ORDER BY 1`, [from])).rows.map((r) => r.t));
      expect((await named(a, linker)).sort()).toEqual([there, thereChild].sort());
      expect(await named(b, linker)).toEqual(await named(a, linker));
      // the link written to the resident's slug still names the resident, on both
      for (const p of [a, b]) expect((await named(p, linkerBefore)).sort()).toEqual([here, hereChild].sort());
    }
  }, 600_000);

  it("slugs, two nodes that each moved a note with one slug into one space without seeing the other's: the same slugs on both, in either order of delivery; the earlier move keeps the slug", async () => {
    const { a, b, nodes } = await pair(6);
    const away = await otherSpace(a);
    const tag = randomUUID().slice(0, 6);
    // one title in two spaces: one slug in each (A's space and a new one); the target is the other space, where no note holds it
    const third = (await write(a, "POST", "/api/spaces", { name: `Third ${tag}` })).id as string;
    const [fromA, fromB] = [await note(a, `Twin ${tag}`), await note(a, `Twin ${tag}`, "", { space_id: third })];
    await exchange(a, b);
    expect(await slugsOf(a, [fromA, fromB])).toEqual({ [fromA]: `twin-${tag}`, [fromB]: `twin-${tag}` });
    await moveTo(a, fromA, away);
    await moveTo(b, fromB, away);
    const both = [fromA, fromB];
    expect((await slugsOf(a, both))[fromA]).toBe(`twin-${tag}`);
    expect((await slugsOf(b, both))[fromB]).toBe(`twin-${tag}`);
    // the second order from the same state: copies of both nodes
    const a2n = await RealNode.open("a2", nodes[0]!), b2n = await RealNode.open("b2", nodes[1]!);
    open.push(a2n, b2n);
    const a2 = { ...a, node: a2n, name: "A2" } as Peer, b2 = { ...b, node: b2n, name: "B2" } as Peer;
    await exchange(a, b); await exchange(b, a); // B first takes A's move, then A takes B's
    await exchange(b2, a2); await exchange(a2, b2); // A first takes B's move, then B takes A's
    const end = await slugsOf(a, both);
    for (const p of [b, a2, b2]) expect(await slugsOf(p, both), p.name).toEqual(end);
    // A moved first (its write's stamp is the earlier one: the clocks of this process only move forward): A's note keeps the slug, B's takes the next free one
    expect(end).toEqual({ [fromA]: `twin-${tag}`, [fromB]: `twin-${tag}-2` });
    await expectSameDerived(a, b, both, "two moves, A→B first");
    await expectSameDerived(a2, b2, both, "two moves, B→A first");
  }, 600_000);

  it("slugs, a note that follows its tree into a space while the other node made a note there with its slug: the same slugs on both, in either order; the earlier write keeps it", async () => {
    const { a, b, nodes } = await pair(7);
    const away = await otherSpace(a);
    const tag = randomUUID().slice(0, 6);
    const root = await note(a, `Root ${tag}`, "", { space_id: away });
    const child = await note(a, `Kin ${tag}`, "", { space_id: away, parent_id: root });
    await exchange(a, b);
    const made = await note(b, `Kin ${tag}`); // on B, in A's space: `kin-<tag>`, not knowing A's move
    await moveTo(a, root, a.space); // on A: the child follows its tree into A's space, where its slug is free here
    const ids = [root, child, made];
    const a2n = await RealNode.open("a2", nodes[0]!), b2n = await RealNode.open("b2", nodes[1]!);
    open.push(a2n, b2n);
    const a2 = { ...a, node: a2n, name: "A2" } as Peer, b2 = { ...b, node: b2n, name: "B2" } as Peer;
    await exchange(a, b); await exchange(b, a);
    await exchange(b2, a2); await exchange(a2, b2);
    const end = await slugsOf(a, ids);
    for (const p of [b, a2, b2]) expect(await slugsOf(p, ids), p.name).toEqual(end);
    // B made its note first: it keeps the slug; the note that followed the move takes the next free one
    expect(end).toEqual({ [root]: `root-${tag}`, [child]: `kin-${tag}-2`, [made]: `kin-${tag}` });
    await expectSameDerived(a, b, ids, "follower and a new note, A→B first");
    await expectSameDerived(a2, b2, ids, "follower and a new note, B→A first");
  }, 600_000);

  // NOT SETTLED, pinned (review of PR #1941, round 2, A1): a note that gives way by its PLACE takes the first free slug on the node's state, so three notes moved into one
  // space at once on two nodes can end with different suffixes. A pure function of the replicated state would need each moved note's base slug, which no unit holds (a
  // slug is no unit; after the move only its title travels): with the title's slug as the base, a note `x-2` moved alone into a space where `x` is free would become `x`
  // (main keeps `x-2`), and a note would change slug when ANOTHER note of its group is renamed away or deleted, on one server too. The two ways out (`-<id8>` for every
  // note that gives way; slug as a unit, batch 5) are the owner's to choose (stampedMerge/README.md).
  it.fails("slugs, NOT SETTLED: three notes moved into one space at once (A, B, A; neither node sees the other's), in either order of delivery, end with the same slugs on both", async () => {
    const { a, b, nodes } = await pair(14);
    const away = await otherSpace(a);
    const tag = randomUUID().slice(0, 6);
    const spaces: string[] = [];
    for (const n of [1, 2, 3]) spaces.push((await write(a, "POST", "/api/spaces", { name: `Trio ${n} ${tag}` })).id as string);
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort(); // B settles A's two in id order: the first moved one first
    const [p1, p2, p3] = [await note(a, `Trio ${tag}`, "", { id: ids[0], space_id: spaces[0] }), await note(a, `Trio ${tag}`, "", { id: ids[1], space_id: spaces[1] }), await note(a, `Trio ${tag}`, "", { id: ids[2], space_id: spaces[2] })];
    await exchange(a, b);
    await moveTo(a, p1, away);
    await moveTo(b, p2, away);
    await moveTo(a, p3, away);
    const trio = [p1, p2, p3];
    const a2n = await RealNode.open("a2", nodes[0]!), b2n = await RealNode.open("b2", nodes[1]!);
    open.push(a2n, b2n);
    const a2 = { ...a, node: a2n, name: "A2" } as Peer, b2 = { ...b, node: b2n, name: "B2" } as Peer;
    await exchange(a, b); await exchange(b, a);
    await exchange(b2, a2); await exchange(a2, b2);
    const end = await slugsOf(a, trio);
    for (const p of [b, a2, b2]) expect(await slugsOf(p, trio), p.name).toEqual(end);
  }, 600_000);

  it("the website: a note unpublished, and one trashed, on the device make the centre that took them request a rebuild and take them off its stored snapshot (a leak otherwise)", async () => {
    const { a, b } = await pair(4);
    const kept = await note(a, "Published, then not");
    const trashed = await note(a, "Published, then trashed");
    await write(a, "PATCH", `/api/spaces/${a.space}`, { capabilities: { publish: true } }); // a space that publishes: its notes are public
    for (const id of [kept, trashed]) await write(a, "PUT", `/api/nodes/${id}/attributes/_published`, { value: "true" });
    await exchange(a, b);
    // B (the centre here) published both: a stored snapshot that names them
    await onNode(b.node, () => q(`INSERT INTO publish_snapshots (workspace_id, title, event_cursor, payload) VALUES ($1, 'site', 0, $2::jsonb)`,
      [b.ws, JSON.stringify({ nodes: [{ id: kept }, { id: trashed }] })]));
    const rebuilds = (p: Peer) => onNode(p.node, async () => Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM outbox WHERE workspace_id = $1 AND effect_kind = 'site_rebuild' AND status = 'pending'`, [p.ws])).rows[0]!.n));
    const takenDown = (p: Peer) => onNode(p.node, async () => (await q<{ ids: string[] }>(
      `SELECT ARRAY(SELECT jsonb_array_elements_text(coalesce(payload->'taken_down', '[]'::jsonb)) ORDER BY 1) AS ids FROM publish_snapshots WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`, [p.ws])).rows[0]!.ids);
    await onNode(b.node, () => q(`DELETE FROM outbox WHERE workspace_id = $1 AND effect_kind = 'site_rebuild'`, [b.ws]));
    await write(a, "PUT", `/api/nodes/${kept}/attributes/_published`, { value: "false" });
    await exchange(a, b);
    expect(await rebuilds(b)).toBe(1);
    expect(await takenDown(b)).toEqual([kept]);
    await onNode(b.node, () => q(`DELETE FROM outbox WHERE workspace_id = $1 AND effect_kind = 'site_rebuild'`, [b.ws]));
    await write(a, "DELETE", `/api/nodes/${trashed}`);
    await exchange(a, b);
    expect(await rebuilds(b)).toBe(1);
    expect(await takenDown(b)).toEqual([kept, trashed].sort());
    // a published note emptied on A: B's static copy keeps the old page unless B requests a rebuild (a local body save does: the website's contentCommitted)
    const emptied = await note(a, "Published, then emptied", "words the site shows");
    await write(a, "PUT", `/api/nodes/${emptied}/attributes/_published`, { value: "true" });
    await exchange(a, b);
    await onNode(b.node, () => q(`INSERT INTO publish_snapshots (workspace_id, title, event_cursor, payload) VALUES ($1, 'site', 0, $2::jsonb)`,
      [b.ws, JSON.stringify({ nodes: [{ id: emptied }] })]));
    await onNode(b.node, () => q(`DELETE FROM outbox WHERE workspace_id = $1 AND effect_kind = 'site_rebuild'`, [b.ws]));
    await write(a, "PATCH", `/api/nodes/${emptied}`, { markdown: "" });
    await exchange(a, b);
    expect(await rebuilds(b)).toBe(1);
  }, 600_000);

  it("a permanent delete taken by bundle erases what a local one erases: the events about the note and the blobs of its versions on the node that took it; the links to it go on both", async () => {
    const { a, b } = await pair(5);
    const gone = await note(a, "Doomed", "first text");
    const linker = await note(a, "Links to it", "see [[Doomed]]");
    await exchange(a, b);
    // B edits it twice: B's own events and version blobs about it
    await write(b, "PATCH", `/api/nodes/${gone}`, { markdown: "second text, written on B" });
    await write(b, "PATCH", `/api/nodes/${gone}`, { markdown: "third text, written on B" });
    await exchange(b, a);
    const named = (p: Peer) => onNode(p.node, async () => ({
      events: Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM domain_events WHERE workspace_id = $1 AND target_id = $2 AND payload <> '{"purged": true}'::jsonb`, [p.ws, gone])).rows[0]!.n),
      blobs: Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM blobs WHERE content LIKE '%written on B%'`)).rows[0]!.n),
      edges: Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM node_edges WHERE source_node_id = $1 AND origin = 'wikilink'`, [linker])).rows[0]!.n),
    }));
    expect((await named(b)).events).toBeGreaterThan(0);
    expect((await named(b)).blobs).toBeGreaterThan(0);
    await write(a, "DELETE", `/api/nodes/${gone}`);
    const preview = await write(a, "GET", `/api/nodes/${gone}/purge-preview`);
    await write(a, "POST", `/api/nodes/${gone}/purge`, { expected_ids: preview.ids ?? [gone] });
    await exchange(a, b);
    expect(await onNode(b.node, async () => (await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [gone])).rowCount)).toBe(0);
    expect(await named(b)).toEqual({ events: 0, blobs: 0, edges: 0 });
    expect(await named(a)).toEqual({ events: 0, blobs: 0, edges: 0 });
  }, 600_000);

  it("a tag applied and a tag's schema, taken by bundle: the values are typed as where they were written (a stamped value's type came in the bundle; a derived value is typed again here)", async () => {
    const { a, b } = await pair(8);
    const book = await note(a, "Book note", "pages:: 300\n\nsome text");
    const tag = (await write(a, "POST", "/api/tags", { name: `book-${randomUUID().slice(0, 6)}` })).id as string;
    // a value no stamp watches (source `derived`), the same on both nodes before the governing change
    await exchange(a, b);
    for (const p of [a, b]) await onNode(p.node, () => withEventTransaction(p.ws, () => q(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1, $2, 'rating', '4', 'text', 'derived')`, [p.ws, book])));
    await write(a, "PATCH", `/api/tags/${tag}/schema`, { fields: [{ key: "pages", type: "number" }, { key: "rating", type: "number" }] });
    await write(a, "PUT", `/api/nodes/${book}/tags/${tag}`, {});
    const typed = (p: Peer) => onNode(p.node, async () => (await q<{ key: string; value_type: string; source: string }>(
      `SELECT key, value_type, source FROM node_attributes WHERE node_id = $1 AND key IN ('pages', 'rating') ORDER BY key`, [book])).rows);
    expect(await typed(a)).toEqual([{ key: "pages", value_type: "number", source: "markdown" }, { key: "rating", value_type: "number", source: "derived" }]);
    await exchange(a, b);
    expect(await typed(b)).toEqual(await typed(a));
    // the schema changes again: the types follow on B by the bundle alone
    await write(a, "PATCH", `/api/tags/${tag}/schema`, { fields: [{ key: "pages", type: "text" }, { key: "rating", type: "text" }] });
    await exchange(a, b);
    expect(await typed(b)).toEqual(await typed(a));
    expect((await typed(b)).map((r) => r.value_type)).toEqual(["text", "text"]);
    await expectSameDerived(a, b, [book], "tags and schema");
  }, 600_000);

  it("a bundle is never taken without its derivation: with the slot empty it is refused (bundle_no_derivation) and nothing of it is written", async () => {
    const { a, b } = await pair(9);
    const fresh = await note(a, "Never half taken", "see [[Never half taken]]");
    const slot = setReceivedDerivation(null);
    try {
      await expect(exchange(a, b)).rejects.toMatchObject({ code: "bundle_no_derivation" });
    } finally { setReceivedDerivation(slot); }
    expect(await onNode(b.node, async () => (await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [fresh])).rowCount)).toBe(0);
    await exchange(a, b); // and with the slot filled it is taken
    expect(await onNode(b.node, async () => (await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [fresh])).rowCount)).toBe(1);
  }, 600_000);

  it("a derivation that fails in a way the same bundle would fail again refuses it with a code that names the step (bundle_derivation_failed), not a bare 500; nothing of it is written", async () => {
    const { a, b } = await pair(10);
    const fresh = await note(a, "Fails to derive", "text");
    const slot = setReceivedDerivation(null)!;
    setReceivedDerivation({ before: slot.before, after: async () => { throw new Error("a step that cannot work"); } });
    try {
      await expect(exchange(a, b)).rejects.toMatchObject({ code: "bundle_derivation_failed", status: 422 });
    } finally { setReceivedDerivation(slot); }
    expect(await onNode(b.node, async () => (await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [fresh])).rowCount)).toBe(0);
    await exchange(a, b);
  }, 600_000);

  it("a permanent delete taken by bundle keeps what a living note shares: a version blob of the same text and an upload the living note names stay on the node that took it", async () => {
    const { a, b } = await pair(11);
    const file = `${Date.now()}-shared.webp`;
    const shared = `shared text ![](/api/media/${file}) ${randomUUID()}`;
    const gone = await note(a, "Doomed, sharing", "first");
    const kept = await note(a, "Kept, sharing", "first");
    await exchange(a, b);
    for (const id of [gone, kept]) await write(b, "PATCH", `/api/nodes/${id}`, { markdown: shared });
    await onNode(b.node, () => q(`INSERT INTO media_uploads (filename, workspace_id, uploader_actor_id) VALUES ($1, $2, $3)`, [file, b.ws, b.owner.id]));
    await exchange(b, a);
    const held = () => onNode(b.node, async () => ({
      blobs: Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM blobs WHERE content = $1`, [shared])).rows[0]!.n),
      upload: (await q(`SELECT 1 FROM media_uploads WHERE filename = $1`, [file])).rowCount,
    }));
    expect(await held()).toEqual({ blobs: 1, upload: 1 });
    await write(a, "DELETE", `/api/nodes/${gone}`);
    const preview = await write(a, "GET", `/api/nodes/${gone}/purge-preview`);
    await write(a, "POST", `/api/nodes/${gone}/purge`, { expected_ids: preview.ids ?? [gone] });
    await exchange(a, b);
    expect(await onNode(b.node, async () => (await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [gone])).rowCount)).toBe(0);
    expect(await held()).toEqual({ blobs: 1, upload: 1 });
  }, 600_000);

  it("a bundle never publishes: notes that are not published on the node that wrote them are not on the website of the node that took them", async () => {
    const { a, b } = await pair(12);
    const { publishedNodeIds } = await import("../modules/website/publishing/publishedSet.js");
    await write(a, "PATCH", `/api/spaces/${a.space}`, { capabilities: { publish: true } });
    // in a space that publishes, a note is public unless it says it is not (`_published` false): `quiet` says so on A
    const shown = await note(a, "Published on A", "a page with words on it"); // a blank note stays off (publishedSet.ts KEPT_OFF_SQL)
    const quiet = await note(a, "Not published on A", "a body with [[Published on A]] {made-tag}\n\n- [ ] milk {task}");
    await write(a, "PUT", `/api/nodes/${quiet}/attributes/_published`, { value: "false" });
    await exchange(a, b);
    const on = (p: Peer) => onNode(p.node, () => publishedNodeIds(p.ws));
    const [atA, atB] = [await on(a), await on(b)];
    expect(atA.has(quiet)).toBe(false);
    expect(atB.has(quiet)).toBe(false);
    expect([...atB].sort()).toEqual([...atA].sort());
    expect(atB.has(shown)).toBe(true);
  }, 600_000);

  it("migration 223: a text value a flip from `dispatcher` left with a tombstone `*` (before 223 that flip counted as a removal) is made again by sync_revive_text_attribute_rows, and the node that took the tombstone takes the row back; after 223 the same flip keeps the row (review of PR #1941, round 1, point 2)", async () => {
    const { a, b } = await pair(13);
    const host = await note(a, "Flipped values");
    const rowOn = (p: Peer, key: string) => onNode(p.node, async () => (await q<{ value: string; source: string }>(`SELECT value, source FROM node_attributes WHERE node_id = $1 AND key = $2`, [host, key])).rows);
    const star = (p: Peer, key: string) => onNode(p.node, async () => (await q<{ deleted: boolean; origin: string }>(
      `SELECT deleted, origin FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'node_attributes' AND row_key = $2 AND field = '*'`, [p.ws, `${host}/${key}`])).rows[0]);
    // dispatcher writes, then the text writes the same key: after 223 an UPDATE of a stamped row, the `*` stays live
    for (const key of ["old_flip", "new_flip"]) {
      await onNode(a.node, () => withEventTransaction(a.ws, () => q(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1, $2, $3, 'x', 'text', 'dispatcher')`, [a.ws, host, key])));
    }
    await exchange(a, b);
    await onNode(a.node, () => withEventTransaction(a.ws, () => q(`UPDATE node_attributes SET source = 'markdown', value = 'y' WHERE node_id = $1 AND key = 'new_flip'`, [host])));
    expect((await star(a, "new_flip"))?.deleted).toBe(false);
    // the state 209's trigger left (old_flip): the flip stamped a tombstone with the flip's stamp and dropped the field stamps; the row is live with source markdown
    await onNode(a.node, () => withEventTransaction(a.ws, async () => {
      const rk = `${host}/old_flip`;
      await q(`SELECT sync_stamp_put_over($1::uuid, 'node_attributes', $2, '*', true, sync_stamp_current($1::uuid), NULL, false)`, [a.ws, rk]);
      await q(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'node_attributes' AND row_key = $2 AND field <> '*'`, [a.ws, rk]);
      await q(`UPDATE node_attributes SET source = 'markdown' WHERE node_id = $1 AND key = 'old_flip'`, [host]); // a flip alone: no stamp after 223 either
    }));
    expect((await star(a, "old_flip"))?.deleted).toBe(true);
    await exchange(a, b);
    // the two nodes differ: the tombstone took B's row, A shows it
    expect(await rowOn(b, "old_flip")).toEqual([]);
    expect(await rowOn(a, "old_flip")).toEqual([{ value: "x", source: "markdown" }]);
    const revived = await onNode(a.node, () => withEventTransaction(a.ws, async () => (await q<{ n: string }>(`SELECT sync_revive_text_attribute_rows()::text AS n`)).rows[0]!.n));
    expect(Number(revived)).toBeGreaterThanOrEqual(1);
    expect(await star(a, "old_flip")).toMatchObject({ deleted: false });
    expect((await star(a, "old_flip"))!.origin).not.toBe("genesis");
    await exchange(a, b);
    expect(await rowOn(b, "old_flip")).toEqual(await rowOn(a, "old_flip"));
    expect(await rowOn(b, "old_flip")).toEqual([{ value: "x", source: "markdown" }]);
    // the flip after 223 carried its value; its `source` is no unit (a limit of batch 4a, the stampedMerge README): B keeps the source it had
    expect(await rowOn(b, "new_flip")).toEqual([{ value: "y", source: "dispatcher" }]);
    // run again: nothing left to revive
    expect(await onNode(a.node, () => withEventTransaction(a.ws, async () => (await q<{ n: string }>(`SELECT sync_revive_text_attribute_rows()::text AS n`)).rows[0]!.n))).toBe("0");
  }, 600_000);
});
