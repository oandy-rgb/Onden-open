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
import { asCompared, buildSourceWorld, capture, fillFrom, openNode } from "./helpers/stampedWorld.js";
import { admit, exchange, markWorld, peerOf, resendAll, writeFor, makeRng, type Peer } from "./helpers/stampedBundleWorld.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import { UNIT_SOURCES, rowMatchOf, unitTextsSql, quote } from "../spine/stampedMerge/dbUnits.js";
import { receivedDerivation, setReceivedDerivation } from "../spine/receivedDerivation.js";

type ReceivedDerivation = NonNullable<ReturnType<typeof receivedDerivation>>;
import { syncBlockNodes } from "../services/blockNodes.js";
import { PROPS_SEED } from "./helpers/propsConfig.js";
import { buildSyncDelta } from "../services/sync/index.js";
import { listNoteVersions } from "../services/history/index.js";
import { restoreEvent } from "../services/eventRestore/restore.js";
import { collectOrphanBlobs } from "../services/maintenance/prune.js";
import { seedQ } from "./helpers/seedQ.js";
import { INK_CHUNK_THRESHOLD, readChunkedValues } from "../services/inkChunks.js";
import { appendReceivedEvents } from "../spine/receivedEvents.js";
import { event } from "../db.js";
import { inboxQueue } from "../services/inboxQueue.js";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import tasksRouter, { addTaskUnderNote } from "../modules/tasks/routes.js";
import nodesRouter from "../routes/nodes.js";
import type { ActorCtx } from "../types.js";

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
  // the display columns of the paragraph rows (no unit: dbUnits.ts fields of block_nodes); hidden_at as the one list compares it (only whether it is set)
  blockDisplay: `SELECT id::text, block_ref, kind, label, text_cache, parent_block_id::text, ${asCompared("block_nodes", "hidden_at", "hidden_at")} AS hidden FROM block_nodes WHERE workspace_id = $1 AND note_id = ANY($2::uuid[]) ORDER BY 1`,
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

// Batch 4b (own-node-transport §2.12.5, "證明 4b"): what a node records in ITS OWN event log of a bundle it took (services/receivedEvents.ts, spine/receivedEvents.ts).
// The same writes done on A and taken by B: a mirror client of each node, from the moment before the writes, is told the same things by /api/sync; History lists a
// received save at the time it was written; "undo this one" of a received save is refused; the blob of a received text is not taken for an orphan; nothing is minted.
// P1 (the wrapper above) holds for every bundle here too: the events write no unit.
describe.skipIf(!isTestDb)("what a node records of a bundle it took (batch 4b)", () => {
  /** The [[link]] edges a node holds (derived: each node has its own ids), by their ends and kind. */
  const linksOf = (p: Peer): Promise<string[]> => onNode(p.node, async () => (await q<{ k: string }>(
    `SELECT source_node_id::text || '>' || target_node_id::text || ':' || edge_type || ':' || status AS k FROM node_edges WHERE workspace_id = $1 AND origin = 'wikilink' ORDER BY 1`, [p.ws])).rows.map((r) => r.k));
  /** Where each node's event log ends now: a mirror client's cursor. */
  const headOf = (p: Peer): Promise<number> => onNode(p.node, async () => Number((await q<{ n: string }>(`SELECT COALESCE(MAX(id), 0)::text AS n FROM domain_events WHERE workspace_id = $1`, [p.ws])).rows[0]!.n));
  /** What /api/sync tells a mirror client of `p` (the owner, holding nothing) that read up to `since`, as data two nodes can be compared by. Ids that each node makes
   *  for itself (a derived edge's) are not compared, nor the columns the local log alone gives (who touched a note last, and when). */
  const mirrorOf = (p: Peer, since: number) => onNode(p.node, async () => {
    const d = await buildSyncDelta(p.owner, p.ws, { since, known: [] });
    const sorted = (xs: Iterable<string>) => [...xs].sort();
    return {
      nodes: d.nodes.upsert.map((n) => JSON.stringify({ id: n.id, title: n.title, markdown: n.markdown, parent_id: n.parent_id, hidden: n.hidden })).sort(),
      nodeDeletes: sorted(d.nodes.delete),
      edges: sorted(d.edges.upsert.map((e) => `${e.source_node_id}>${e.target_node_id}:${e.edge_type}:${e.status}`)),
      edgeDeletes: d.edges.delete.length,
      tasks: sorted(d.tasks.upsert.map((t) => t.id)),
      taskDeletes: sorted(d.tasks.delete),
      attributes: sorted(d.attributes.upsert.map((a) => `${a.node_id}/${a.key}=${a.value}`)),
      attributeDeletes: sorted(d.attributes.delete.map((a) => `${a.node_id}/${a.key}`)),
      // with the counts: a paragraph's tag leaving or coming back moves only them (review of PR #1997, round 1, point 5)
      tags: d.tags ? sorted(d.tags.map((t) => `${t.id}:${String(t.title ?? t.name ?? "")}:${String(t.usage_count ?? "")}:${String(t.block_usage_count ?? "")}`)) : null,
      workspace: d.workspace !== null,
    };
  });

  it("a mirror client is told the same by the node that wrote and by the node that took the writes (random writes of every table, a tagged paragraph, a task line)", async () => {
    const { a, b } = await pair(40);
    const [sinceA, sinceB] = [await headOf(a), await headOf(b)];
    // what the run is compared on: not the links B lacks since it joined (pinned below), nor a delete of a note the run made and removed (no client held it)
    const [linksA, linksB] = [await linksOf(a), await linksOf(b)];
    const lackedAtJoin = new Set(linksA.filter((l) => !linksB.includes(l)));
    const before = new Set(await onNode(a.node, async () => (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1`, [a.ws])).rows.map((r) => r.id)));
    const valuesBefore = new Set(await onNode(b.node, async () => (await q<{ k: string }>(`SELECT node_id::text || '/' || key AS k FROM node_attributes WHERE workspace_id = $1`, [b.ws])).rows.map((r) => r.k)));
    // a removal is compared where a client could hold what was removed (a value the run set and removed again was never sent to anyone)
    // nor a note A's tab is sent again only for pointers the run made and removed (nothing of it changed; B cannot name it: the test below this one)
    const pointersAt = () => onNode(a.node, async () => new Map((await q<{ target_id: string; ids: string }>(
      `SELECT target_id::text, string_agg(id::text, ',' ORDER BY id) AS ids FROM note_pointers WHERE workspace_id = $1 GROUP BY target_id`, [a.ws])).rows.map((r) => [r.target_id, r.ids] as const)));
    const pointersBefore = await pointersAt();
    let pointedOnly = new Set<string>();
    const comparable = (m: Awaited<ReturnType<typeof mirrorOf>>) => ({ ...m, edges: m.edges.filter((e) => !lackedAtJoin.has(e)), nodeDeletes: m.nodeDeletes.filter((id) => before.has(id)),
      // a task is a note: the same for a task the run made and removed (seed 546235826: Probe trashed with its task line; A's tab is told the task is gone, B took it gone)
      taskDeletes: m.taskDeletes.filter((id) => before.has(id)),
      attributeDeletes: m.attributeDeletes.filter((k) => valuesBefore.has(k)), nodes: m.nodes.filter((n) => !pointedOnly.has(JSON.parse(n).id)) });
    const n = await note(a, "Probe", "");
    await note(a, "Target Note");
    await write(a, "PATCH", `/api/nodes/${n}`, { markdown: BODY });
    await writeFor(a, makeRng(SEED + 41), 24, { weights: { attr: 6, unattr: 2, tagMake: 2, tag: 5, untag: 2, point: 4, unpoint: 2, schemaKey: 3, row: 8 } });
    // a task line the random writes cannot reach: the ending's pinned finding (ENDING_FAILS, TASK_COPY) is on every run, also when a seed purges Probe (which takes
    // Probe's paragraph rows and that finding with it)
    await write(a, "PATCH", `/api/nodes/${await note(a, "Kept Task")}`, { markdown: "- [ ] kept {task}" });
    await exchange(a, b);
    const pointersAfter = await pointersAt();
    const eventsOnA = await onNode(a.node, async () => (await q<{ target_id: string; kinds: string[] }>(
      `SELECT target_id::text, array_agg(DISTINCT event_type) AS kinds FROM domain_events WHERE workspace_id = $1 AND id > $2 AND target_type = 'node' GROUP BY target_id`, [a.ws, sinceA])).rows);
    pointedOnly = new Set(eventsOnA.filter((e) => e.kinds.every((k) => k === "POINTER_CREATED" || k === "POINTER_DELETED") && pointersBefore.get(e.target_id) === pointersAfter.get(e.target_id))
      .map((e) => e.target_id));
    const [ma, mb] = [await mirrorOf(a, sinceA), await mirrorOf(b, sinceB)];
    expect(ma.nodes.length, "the writes reach a mirror client of the writer").toBeGreaterThan(0);
    // leftover of 4a: the paragraph tag the body made moves the tag catalog (and the task words with it) on the node that took it too
    expect(ma.tags, "the writer's client is sent the tag catalog").not.toBeNull();
    expect(comparable(mb)).toEqual(comparable(ma));
  }, 600_000);

  // Found by the test above (seed 745433883), a difference of what the writer's own log tells, not a gap: a pointer made and removed on A records
  // POINTER_CREATED and POINTER_DELETED on the note it pointed at, so A's tab is sent that note again. B never held the pointer, so its removal names no note
  // there (services/receivedEvents.ts names a removed pointer's note from the row read before the merge), and nothing of the note changed on either node:
  // B's tab already holds what A's tab is sent again. The test above does not compare such a note.
  it("a pointer made and removed on A before B heard of it: A's tab is sent the note it pointed at again, which changed on neither node", async () => {
    const { a, b } = await pair(57);
    const holder = await note(a, "Holder"), x = await note(a, "Pointed at");
    await exchange(a, b);
    const rowOf = (p: Peer) => onNode(p.node, async () => (await q(`SELECT title, markdown, parent_id, hidden, deleted_at, space_id, updated_at FROM content_nodes WHERE id = $1`, [x])).rows[0]);
    const rows = [await rowOf(a), await rowOf(b)];
    expect(rows[1], "B holds the note as A does").toEqual(rows[0]);
    const sinceA = await headOf(a);
    const pointer = await write(a, "POST", "/api/pointers", { target_id: x, parent_id: holder });
    await write(a, "DELETE", `/api/pointers/${pointer.id}`);
    await exchange(a, b);
    expect((await mirrorOf(a, sinceA)).nodes.map((n) => JSON.parse(n).id), "the writer's tab is sent the note again (its two writes)").toContain(x);
    expect([await rowOf(a), await rowOf(b)], "nothing of the note changed on either node").toEqual(rows);
  }, 600_000);

  // Found by the test above (a deterministic difference, not a seed's): a snapshot carries the hand-made edges only (snapshotTables.json node_edges `origin =
  // 'manual'`), and joining derives none, so a node that joined holds no [[link]] edge of a note it took until that note is saved again. README 「接上傳輸前必須完成」.
  it.fails("a node that joined by snapshot holds the [[link]] edges of the notes it took, as its source does", async () => {
    const { a, b } = await pair(44);
    await exchange(a, b); // and a bundle taken since changes nothing of it (P1 watches it)
    expect(await linksOf(b)).toEqual(await linksOf(a));
  }, 600_000);

  /** A tag's description saved on A after B has the tag, taken by B later than it was written: what B's log and version list say of it. */
  const receivedDescription = async (seed: number) => {
    const { a, b } = await pair(seed);
    const tag = (await write(a, "POST", "/api/tags", { name: "described-tag" })).id as string;
    await exchange(a, b);
    await write(a, "PATCH", `/api/nodes/${tag}`, { markdown: "what this tag is for" });
    const writtenAt = await onNode(a.node, async () => new Date((await q<{ at: Date }>(`SELECT created_at AS at FROM domain_events WHERE target_id = $1 AND payload ? 'body_hash' ORDER BY id DESC LIMIT 1`, [tag])).rows[0]!.at).getTime());
    await new Promise((r) => setTimeout(r, 1500)); // taken later than it was written
    const versionsBefore = await onNode(b.node, async () => (await q<{ n: string }>(`SELECT count(*)::text AS n FROM note_versions WHERE workspace_id = $1`, [b.ws])).rows[0]!.n);
    await exchange(a, b);
    return { a, b, tag, writtenAt, versionsBefore };
  };

  it("a received save is marked as received (the time it was written, its base not known), mints no version here, and undoing it alone is refused; the text stays", async () => {
    const { b, tag, versionsBefore } = await receivedDescription(42);
    expect(await onNode(b.node, async () => (await q<{ n: string }>(`SELECT count(*)::text AS n FROM note_versions WHERE workspace_id = $1`, [b.ws])).rows[0]!.n), "nothing is minted").toBe(versionsBefore);
    const received = await onNode(b.node, async () => (await q<{ id: string; meta: Record<string, unknown>; base: string | null; actor: string }>(
      `SELECT id, tx_meta AS meta, base_hash AS base, actor_type AS actor FROM domain_events WHERE target_id = $1 AND payload ? 'body_hash' ORDER BY id DESC LIMIT 1`, [tag])).rows[0]!);
    expect(received.meta).toMatchObject({ received: true, base_unknown: true });
    expect(typeof received.meta.written_at, "the time it was written").toBe("string");
    expect(received.actor, "the owner wrote it").toBe("user");
    expect(received.base, "the writer's base is not known here: none, not this node's previous text").toBeNull();
    const undo = await onNode(b.node, () => restoreEvent(String(received.id), { actor: b.owner, workspaceId: b.ws }));
    expect((undo as { code?: string }).code, "a change made on another device is not undone alone").toBe("made_elsewhere");
    expect(await onNode(b.node, async () => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [tag])).rows[0]!.markdown)).toBe("what this tag is for");
  }, 600_000);

  // Since history batch 8 (migration 231) a tag's description has versions, and its list reads them; a bundle mints none (the versions are the writer's and
  // travel with history batch 4), so the received save is not in B's list yet. README 「接上傳輸前必須完成」.
  it.fails("History on the node that took it lists a received save, at the time it was written and by who wrote it (waits for versions to travel: history batch 4)", async () => {
    const { b, tag, writtenAt } = await receivedDescription(53);
    const first = (await onNode(b.node, () => listNoteVersions(b.ws, b.owner, tag, { raw: true })))![0]!;
    expect(first.markdown).toBe("what this tag is for");
    expect(Math.abs(new Date(first.changed_at as string).getTime() - writtenAt), "the time it was written, not the time it arrived").toBeLessThan(1000);
    expect(first.actor_kind, "the owner wrote it").toBe("human");
  }, 600_000);

  /** The task routes as the owner (the world's caller has the notes' routes only). */
  const tasksOf = (p: Peer) => {
    const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
    app.onError(apiOnError);
    app.use("*", async (c, next) => { c.set("actor", p.owner); await next(); });
    app.route("/api/tasks", tasksRouter);
    app.post("/api/nodes/:id/tasks", addTaskUnderNote);
    app.route("/api/nodes", nodesRouter);
    return async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
      await awaitAllDispatchers();
      return res.json() as Promise<any>;
    };
  };

  // The owner's decision (2026-11-23, review of PR #1997, round 1, point 2): deleting the next occurrence for good does not end the series; finishing
  // the task again makes it anew (main's behaviour, asserted on A above). Between two nodes: one finish made on both makes ONE next occurrence.
  it("the same recurring task finished on A and on B before either heard of the other: one next occurrence, the same id on both", async () => {
    const { a, b } = await pair(51);
    const host = await note(a, "Shared weekly host");
    const task = (await onNode(a.node, () => tasksOf(a)("POST", `/api/nodes/${host}/tasks`, { title: "shared weekly chore", due_date: new Date().toISOString().slice(0, 10), recur: "1w" }))).id as string;
    await exchange(a, b);
    for (const p of [a, b]) await onNode(p.node, () => tasksOf(p)("PATCH", `/api/tasks/${task}`, { status: "done" }));
    const nextOf = (p: Peer) => onNode(p.node, async () => (await q<{ id: string }>(
      `SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = 'shared weekly chore' AND id <> $2 ORDER BY id`, [p.ws, task])).rows.map((r) => r.id));
    const [madeOnA, madeOnB] = [await nextOf(a), await nextOf(b)];
    expect(madeOnA, "each node made its own next occurrence").toHaveLength(1);
    expect(madeOnB, "derived from the task's id: the same id").toEqual(madeOnA);
    await exchange(a, b); await exchange(b, a);
    expect(await nextOf(a), "after exchanging both ways: one").toEqual(madeOnA);
    expect(await nextOf(b)).toEqual(madeOnA);
  }, 600_000);

  // Decided by the owner (2026-11-23, review of PR #1997, round 1, point 2): as on main, a next occurrence deleted for good is made anew when the task is
  // finished again (deleting one occurrence does not end the series). The node that took the purge by bundle does the same, from the same state.
  it("a recurring task finished on A, whose next occurrence A then deleted for good: finished again, it is made anew on A (as on main) and on B (which took both)", async () => {
    const { a, b } = await pair(45);
    const host = await note(a, "Weekly host");
    const task = (await onNode(a.node, () => tasksOf(a)("POST", `/api/nodes/${host}/tasks`, { title: "weekly chore", due_date: new Date().toISOString().slice(0, 10), recur: "1w" }))).id as string;
    await onNode(a.node, () => tasksOf(a)("PATCH", `/api/tasks/${task}`, { status: "done" }));
    const next = await onNode(a.node, async () => (await q<{ id: string }>(`SELECT target_id AS id FROM domain_events WHERE event_type = 'NODE_CREATED' AND payload->>'rolled_from' = $1`, [task])).rows[0]!.id);
    await write(a, "DELETE", `/api/nodes/${next}`);
    const preview = await write(a, "GET", `/api/nodes/${next}/purge-preview`);
    await write(a, "POST", `/api/nodes/${next}/purge`, { expected_ids: (preview.ids ?? preview.notes?.map((x: { id: string }) => x.id) ?? [next]) as string[] });
    await exchange(a, b);
    expect(await onNode(b.node, async () => (await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [next])).rows.length), "B took the delete").toBe(0);
    const tombstone = await onNode(a.node, async () => (await q(`SELECT 1 FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2 AND field = '*' AND deleted`, [a.ws, next])).rows.length);
    const again = async (p: Peer) => {
      await onNode(p.node, () => tasksOf(p)("PATCH", `/api/tasks/${task}`, { status: "todo" }));
      await onNode(p.node, () => tasksOf(p)("PATCH", `/api/tasks/${task}`, { status: "done" }));
      return onNode(p.node, async () => (await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [next])).rows.length);
    };
    const [onA, onB] = [await again(a), await again(b)];
    console.log(`[recurring] after a purge of the next occurrence: tombstone kept on the writer: ${tombstone === 1}; finished again, made anew on A: ${onA === 1}, on B: ${onB === 1}`);
    expect(onA, "the writer keeps main's behaviour: the occurrence is made anew").toBe(1);
    expect(onB, "the node that took the purge does the same").toBe(onA);
  }, 600_000);

  it("a note renamed and then put in the trash on A, taken in one bundle: a tab of B is told it is gone, as a tab of A is (the delete is written last)", async () => {
    const { a, b } = await pair(47);
    const x = await note(a, "Going soon");
    await exchange(a, b);
    const [sinceA, sinceB] = [await headOf(a), await headOf(b)];
    await write(a, "PATCH", `/api/nodes/${x}`, { title: "Renamed, then trashed" });
    await write(a, "DELETE", `/api/nodes/${x}`);
    await exchange(a, b);
    const [ma, mb] = [await mirrorOf(a, sinceA), await mirrorOf(b, sinceB)];
    expect(ma.nodeDeletes).toContain(x);
    expect({ nodes: mb.nodes, nodeDeletes: mb.nodeDeletes }).toEqual({ nodes: ma.nodes, nodeDeletes: ma.nodeDeletes });
  }, 600_000);

  // Found by the random test above (seed 380206382): a note put in the trash and taken out again on A is told again to A's tab (NODE_DELETED, NODE_UNDELETED), while
  // on B the bundle writes its `deleted` unit back to what B had (live), so no trash and no restore was seen and nothing was recorded: B's tab was never told the note,
  // whose row did change (its `updated_at` follows the stamps, migration 232). Every note unit a bundle writes records an event, whether or not it moved the
  // note's state (services/receivedEvents.ts, the notes).
  it("a note put in the trash and taken out again on A, taken in one bundle: a tab of B is told the note again, as a tab of A is", async () => {
    const { a, b } = await pair(56);
    const x = await note(a, "Out and back");
    await exchange(a, b);
    const editedAt = (p: Peer) => onNode(p.node, async () => (await q<{ u: string }>(`SELECT updated_at::text AS u FROM content_nodes WHERE id = $1`, [x])).rows[0]!.u);
    const heldByB = await editedAt(b);
    const [sinceA, sinceB] = [await headOf(a), await headOf(b)];
    await write(a, "DELETE", `/api/nodes/${x}`);
    await write(a, "POST", `/api/nodes/${x}/undelete`);
    await exchange(a, b);
    expect(await editedAt(b), "the row changed on B too: the time it was last written, as on A").toBe(await editedAt(a));
    expect(await editedAt(b), "not the row B's tab held").not.toBe(heldByB);
    const [ma, mb] = [await mirrorOf(a, sinceA), await mirrorOf(b, sinceB)];
    expect(ma.nodes.map((n) => JSON.parse(n).id), "the writer's tab is told the note again").toEqual([x]);
    expect({ nodes: mb.nodes, nodeDeletes: mb.nodeDeletes }).toEqual({ nodes: ma.nodes, nodeDeletes: ma.nodeDeletes });
  }, 600_000);

  it("a tagged paragraph taken out of the text on A, and put back: B's tab is sent the tag catalog with the same counts as A's tab each time", async () => {
    const { a, b } = await pair(48);
    const text = "# Counted\n\nfirst paragraph {counted-tag}\n\nsecond paragraph\n";
    const n = await note(a, "Counted", text);
    await exchange(a, b);
    for (const markdown of ["# Counted\n\nsecond paragraph\n", text]) {
      const [sinceA, sinceB] = [await headOf(a), await headOf(b)];
      await write(a, "PATCH", `/api/nodes/${n}`, { markdown });
      await exchange(a, b);
      const [ma, mb] = [await mirrorOf(a, sinceA), await mirrorOf(b, sinceB)];
      expect(ma.tags, "the writer's tab is sent the catalog").not.toBeNull();
      expect(mb.tags, markdown.includes("{counted-tag}") ? "put back" : "taken out").toEqual(ma.tags);
    }
  }, 600_000);

  it("a bundle taken again writes no event, so no tab is told anything new", async () => {
    const { a, b } = await pair(49);
    await note(a, "Sent twice", "some text");
    await exchange(a, b);
    const head = await headOf(b);
    await resendAll(a, b);
    expect(await headOf(b)).toBe(head);
  }, 600_000);

  it("an AI's change taken by bundle is not put in this node's review list again; the AI's own changes here are", async () => {
    const { a, b } = await pair(50);
    const target = await note(a, "Reviewed where it was made");
    await exchange(a, b);
    const listed = await onNode(b.node, async () => {
      const agent = (await seedQ<{ id: string }>(`INSERT INTO actors (workspace_id, name, type) VALUES ($1, 'Helper AI', 'agent') RETURNING id::text`, [b.ws])).rows[0]!.id;
      const origin = (await q<{ o: string }>(`SELECT node_id AS o FROM sync_node`)).rows[0]!.o;
      const stamp = { origin, seq: 1, wall: Date.now(), counter: 0, author: agent, device: null };
      const received = await withEventTransaction(b.ws, () => appendReceivedEvents(b.ws, [{ type: "NODE_UPDATED", targetType: "node", targetId: target, payload: { fields: ["title"] }, stamp }]));
      expect(received).toBe(1);
      const local = await withEventTransaction(b.ws, () => event(b.ws, "NODE_UPDATED", "node", target, { fields: ["title"] }, "ai_agent", agent));
      const queue = await inboxQueue(b.owner, b.ws, { limit: 50, actorId: null, eventType: null, since: null });
      return { ids: queue.events.map((e) => String(e.id)), local };
    });
    expect(listed.ids).toEqual([listed.local]);
  }, 600_000);

  // Found by stampedSawThreeNodes (seed 171997, real Postgres): the purge's sweep deleted a blob row in the bundle's transaction, and storing the same text
  // for a received note's event then waited on its own connection for that transaction (a statement timeout); on PGlite the text was lost instead.
  it("one bundle deletes a note for good and brings another with the same text: taken, and the text the received note's event names is stored", async () => {
    const { a, b } = await pair(52);
    const same = "a text two notes share, one of them deleted for good";
    const going = await note(a, "Going for good", same);
    await exchange(a, b);
    await write(a, "DELETE", `/api/nodes/${going}`);
    const preview = await write(a, "GET", `/api/nodes/${going}/purge-preview`);
    await write(a, "POST", `/api/nodes/${going}/purge`, { expected_ids: (preview.ids ?? preview.notes?.map((x: { id: string }) => x.id) ?? [going]) as string[] });
    const staying = await note(a, "Staying", same);
    await exchange(a, b);
    const named = await onNode(b.node, async () => (await q<{ h: string; stored: boolean }>(
      `SELECT e.body_hash AS h, EXISTS (SELECT 1 FROM blobs WHERE hash = e.body_hash) AS stored FROM domain_events e WHERE e.target_id = $1 AND e.event_type = 'NODE_CREATED'`, [staying])).rows[0]);
    expect(named?.h, "the received creation names its text").toBeTruthy();
    expect(named?.stored, "and that text is stored").toBe(true);
  }, 600_000);

  // The same for a drawing (review of PR #1997, confirming round, point 1): its event's snapshot stores the drawing (encodeSnapshot: putBlob on its own
  // connection), which waited for the bundle's transaction once the purge's sweep had deleted the same blob.
  it("one bundle deletes a note for good and brings another with the same drawing: taken, and the drawing the received value's event names is stored", async () => {
    const { a, b } = await pair(54);
    const drawing = JSON.stringify({ v: 1, strokes: [{ id: "s1", points: [[0, 0], [4, 4]] }, { id: "s2", points: [[1, 1], [5, 5]] }] });
    const going = await note(a, "Drawing going for good");
    await write(a, "PUT", `/api/nodes/${going}/attributes/ink_data`, { value: drawing });
    await exchange(a, b);
    await write(a, "DELETE", `/api/nodes/${going}`);
    const preview = await write(a, "GET", `/api/nodes/${going}/purge-preview`);
    await write(a, "POST", `/api/nodes/${going}/purge`, { expected_ids: (preview.ids ?? preview.notes?.map((x: { id: string }) => x.id) ?? [going]) as string[] });
    const staying = await note(a, "Drawing staying");
    await write(a, "PUT", `/api/nodes/${staying}/attributes/ink_data`, { value: drawing });
    await exchange(a, b);
    const named = await onNode(b.node, async () => (await q<{ h: string | null; stored: boolean }>(
      `SELECT e.payload->>'value_ref' AS h, EXISTS (SELECT 1 FROM blobs WHERE hash = e.payload->>'value_ref') AS stored FROM domain_events e
        WHERE e.target_id = $1 AND e.event_type = 'ATTRIBUTE_SET' AND e.payload->>'key' = 'ink_data'`, [staying])).rows[0]);
    expect(named?.h, "the received value names its drawing").toBeTruthy();
    expect(named?.stored, "and that drawing is stored").toBe(true);
  }, 600_000);

  // A drawing over INK_CHUNK_THRESHOLD is stored as chunks of the note that holds it (services/inkChunks.ts putInkChunks: in the bundle's own transaction,
  // keyed by that note), not as one blob (review of PR #1997, after the confirming round).
  it("one bundle deletes a note for good and brings another with the same LARGE drawing (stored as chunks): taken, and every chunk the event names is there", async () => {
    const { a, b } = await pair(55);
    const strokes = Array.from({ length: 3000 }, (_, i) => ({ id: `s${i}`, points: Array.from({ length: 6 }, (_, j) => [i + j * 1.25, i * 0.5 + j]) }));
    const drawing = JSON.stringify({ v: 1, strokes });
    expect(drawing.length, "over the chunk threshold").toBeGreaterThan(INK_CHUNK_THRESHOLD);
    const going = await note(a, "Large drawing going for good");
    await write(a, "PUT", `/api/nodes/${going}/attributes/ink_data`, { value: drawing });
    await exchange(a, b);
    await write(a, "DELETE", `/api/nodes/${going}`);
    const preview = await write(a, "GET", `/api/nodes/${going}/purge-preview`);
    await write(a, "POST", `/api/nodes/${going}/purge`, { expected_ids: (preview.ids ?? preview.notes?.map((x: { id: string }) => x.id) ?? [going]) as string[] });
    const staying = await note(a, "Large drawing staying");
    await write(a, "PUT", `/api/nodes/${staying}/attributes/ink_data`, { value: drawing });
    await exchange(a, b);
    const stored = await onNode(b.node, async () => {
      const ref = (await q<{ h: string | null }>(`SELECT payload->>'value_ref' AS h FROM domain_events WHERE target_id = $1 AND event_type = 'ATTRIBUTE_SET' AND payload->>'key' = 'ink_data'`, [staying])).rows[0]?.h ?? null;
      const chunks = Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM ink_chunks WHERE node_id = $1`, [staying])).rows[0]!.n);
      // the drawing the event names, rebuilt from its chunks as History reads it
      const rebuilt = ref ? (await readChunkedValues(b.ws, staying, [ref])).get(ref) : undefined;
      return { ref, chunks, rebuilt };
    });
    expect(stored.ref, "the received value names its drawing").toBeTruthy();
    expect(stored.chunks, "stored as chunks of the note that holds it").toBeGreaterThan(1);
    expect(stored.rebuilt, "every chunk is there: the drawing is whole").toBe(drawing);
  }, 600_000);

  it("the blob of a received text is named by its event: the orphan sweep keeps it (else the received version's text is lost)", async () => {
    const { a, b } = await pair(43);
    const n = await note(a, "Kept text", "a text that only came by bundle");
    await exchange(a, b);
    const hash = await onNode(b.node, async () => (await q<{ h: string }>(`SELECT body_hash AS h FROM domain_events WHERE target_id = $1 AND body_hash IS NOT NULL ORDER BY id DESC LIMIT 1`, [n])).rows[0]?.h);
    expect(hash, "the received creation names its text").toBeTruthy();
    // undoing the received creation alone would put the note in the trash here: refused, the note stays (review of PR #1997, round 1, point 3)
    const created = await onNode(b.node, async () => String((await q<{ id: string }>(`SELECT id FROM domain_events WHERE target_id = $1 AND event_type = 'NODE_CREATED'`, [n])).rows[0]!.id));
    expect(((await onNode(b.node, () => restoreEvent(created, { actor: b.owner, workspaceId: b.ws }))) as { code?: string }).code).toBe("made_elsewhere");
    expect(await onNode(b.node, async () => (await q<{ d: boolean }>(`SELECT deleted_at IS NOT NULL AS d FROM content_nodes WHERE id = $1`, [n])).rows[0]!.d)).toBe(false);
    await onNode(b.node, async () => {
      await seedQ(`UPDATE blobs SET created_at = now() - interval '30 days' WHERE hash = $1`, [hash]);
      await collectOrphanBlobs();
      expect((await q(`SELECT 1 FROM blobs WHERE hash = $1`, [hash])).rows.length).toBe(1);
    });
  }, 600_000);
});
