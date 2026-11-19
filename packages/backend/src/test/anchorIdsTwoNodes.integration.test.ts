// The ids a body write mints, on two nodes that hold the same text. Steps 2-3 of docs/architecture/proposals/anchors-deterministic-2026-11-16.md (migration 215):
// the node where the person wrote mints each id once, the id travels with the write, and the receiving node adopts it and never mints its own for text it received.
//
// A writes the body (and so its anchors, paragraph rows and the task note); a bundle gives B the text, the anchors (block_anchors), the paragraph rows
// (block_nodes, with the task line's link to its task note) and the task note with its reference and `_task_status`; then B edits one word of that text, so B's own
// write moves A's anchors, finds A's rows and keeps A's task, instead of drawing ids of its own (step 1b pinned the old behaviour here with `it.fails`).
// Both engines: a node is a PGlite, or a database of the real server (helpers/distSim/postgresNodes.ts).
import { afterEach, describe, expect, it } from "vitest";
import { q } from "../db.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, fillFrom, openNode } from "./helpers/stampedWorld.js";
import { admit, exchange, makeRng, markWorld, peerOf, writeFor, type Peer } from "./helpers/stampedBundleWorld.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { taskAgenda } from "../modules/tasks/agenda.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

/** A holds the world and some shared notes; B joins A by snapshot (the same start as `cluster` in stampedBundle.integration.test.ts, without C). */
async function twoNodes(seed: number): Promise<{ a: Peer; b: Peer }> {
  const [na, nb] = [await openNode("a"), await openNode("b")];
  open.push(na, nb);
  const world = await buildSourceWorld(na);
  const a = peerOf("A", na, world);
  await markWorld(a);
  await writeFor(a, makeRng(900 + seed), 14, { weights: { title: 0, body: 0, move: 0, reorder: 0, trash: 0, undelete: 0, purge: 0, recreate: 0 } });
  await fillFrom(nb, world, await capture(na, world, 12_000));
  const b = peerOf("B", nb, world);
  await admit(a, b);
  return { a, b };
}

const BODY = "# Mint\n\nSee [[Target Note]] here {#mint-tag}\n\n- [ ] do a thing {task}\n\nlast paragraph {^para2}\n";

type Side = { anchors: string[]; paragraphRows: string[]; taskNotes: Array<{ id: string; linkedToALine: boolean }>; agendaTaskIds: string[]; fields: string[] };
async function probe(): Promise<{ atA: Side; atB: Side; afterRoundTrip: { atA: Side; atB: Side } }> {
  const { a, b } = await twoNodes(41);
  for (const p of [a, b]) await onNode(p.node, () => setModulesOn(p.ws, null));
  await onNode(a.node, () => a.call("POST", "/api/tags", { name: "mint-tag" }));
  await exchange(a, b);
  const note = await onNode(a.node, async () => (await a.call("POST", "/api/nodes", { id: "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e", title: "Mint", markdown: "", space_id: a.space })).id as string);
  await onNode(a.node, () => a.call("POST", "/api/nodes", { id: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f", title: "Target Note", markdown: "", space_id: a.space }));
  await exchange(a, b);
  await onNode(a.node, () => a.call("PATCH", `/api/nodes/${note}`, { markdown: BODY }));
  await exchange(a, b);
  await onNode(b.node, () => b.call("PATCH", `/api/nodes/${note}`, { markdown: BODY.replace("here", "there") }));
  const read = (p: Peer): Promise<Side> => onNode(p.node, async () => ({
    // every replicated column of the anchors and paragraph rows (review point 15: compare fields, not only ids)
    fields: [
      ...(await q<{ r: string }>(`SELECT jsonb_build_object('a', anchor_id, 'n', note_id, 'f', from_utf16, 't', to_utf16, 'h', at_body_hash, 'q', quote, 'qp', quote_prefix, 'qs', quote_suffix,
        's', status, 'cf', candidate_from_utf16, 'ct', candidate_to_utf16, 'p', recovery_pending)::text AS r FROM block_anchors WHERE note_id = $1 ORDER BY anchor_id`, [note])).rows.map((r) => r.r),
      ...(await q<{ r: string }>(`SELECT jsonb_build_object('id', id, 'n', note_id, 'a', anchor_id, 'r', block_ref, 't', task_id, 'd', detached_note_id)::text AS r FROM block_nodes WHERE note_id = $1 ORDER BY id`, [note])).rows.map((r) => r.r),
    ],
    anchors: (await q<{ anchor_id: string }>(`SELECT anchor_id FROM block_anchors WHERE note_id = $1 ORDER BY from_utf16, anchor_id`, [note])).rows.map((r) => r.anchor_id),
    paragraphRows: (await q<{ id: string }>(`SELECT id::text FROM block_nodes WHERE note_id = $1 ORDER BY id`, [note])).rows.map((r) => r.id),
    taskNotes: (await q<{ id: string; linked: boolean }>(
      `SELECT c.id::text, EXISTS (SELECT 1 FROM block_nodes b WHERE b.task_id = c.id AND b.note_id = $1) AS linked
         FROM content_nodes c WHERE c.parent_id = $1 ORDER BY c.id`, [note])).rows.map((r) => ({ id: r.id, linkedToALine: r.linked })),
    // what the task lists show (modules/tasks/agenda.ts): the open tasks of the workspace
    agendaTaskIds: Object.values((await taskAgenda(p.owner, p.ws)).buckets).flat().map((t) => (t as { id: string }).id).sort(),
  }));
  const before = { atA: await read(a), atB: await read(b) };
  await exchange(b, a); // B's write goes back to A
  return { ...before, afterRoundTrip: { atA: await read(a), atB: await read(b) } };
}
// One run of the scenario for all the tests below (each reads a different part of the same plain data, so their shuffled order cannot matter); the nodes are closed after each test.
let memo: ReturnType<typeof probe> | null = null;
const result = () => (memo ??= probe());
const inCommon = (x: string[], y: string[]) => x.filter((id) => y.includes(id));

describe.skipIf(!isTestDb)("the ids a body write mints, on two nodes that hold the same text", () => {
  it("both nodes end up with anchors, paragraph rows and a task note for the text (so the comparisons below compare something)", async () => {
    const { atA, atB } = await result();
    for (const side of [atA, atB]) { expect(side.anchors.length).toBeGreaterThan(0); expect(side.paragraphRows.length).toBeGreaterThan(0); expect(side.taskNotes.length).toBeGreaterThan(0); }
  }, 300_000);
  it("anchor ids: B's write moves the anchors A minted and mints none of its own (the same ids, in the same order, on both nodes)", async () => {
    const { atA, atB } = await result();
    expect(inCommon(atA.anchors, atB.anchors)).toEqual(atA.anchors);
    expect(atB.anchors).toEqual(atA.anchors);
  }, 300_000);
  it("paragraph rows: B's write finds the block_nodes rows A made (the column default draws no second id)", async () => {
    const { atA, atB } = await result();
    expect(inCommon(atA.paragraphRows, atB.paragraphRows)).toEqual(atA.paragraphRows);
    expect(atB.paragraphRows).toEqual(atA.paragraphRows);
  }, 300_000);
  it("tasks: the one task line `- [ ] do a thing {task}` is one task note on B, as it is on A (B's write keeps the one that arrived with the line's row)", async () => {
    const { atA, atB } = await result();
    expect(atA.taskNotes).toHaveLength(1);
    expect(atB.taskNotes).toHaveLength(1);
    expect(atB.taskNotes.map((t) => t.id)).toEqual(atA.taskNotes.map((t) => t.id));
  }, 300_000);
  it("tasks: on B the line's block row points at the task note that arrived by bundle (no task note is left without its line)", async () => {
    const { atB } = await result();
    expect(atB.taskNotes.filter((t) => !t.linkedToALine)).toEqual([]);
  }, 300_000);
  // What a person sees: B's task list showed the ONE task line as TWO tasks after batch 2b-2a (A's task note arrived with its reference and status, B's own write made a
  // second one). The writer minting the id once removes it; spine/stampedMerge/README.md (接上傳輸前必須完成) no longer lists it.
  it("after B's write goes back to A, both nodes hold the same anchors and paragraph rows, every replicated column (positions, quotes, links), not only the same ids", async () => {
    const { afterRoundTrip } = await result();
    expect(afterRoundTrip.atA.fields.length).toBeGreaterThanOrEqual(4); // the anchors and the rows of the tagged paragraphs
    expect(afterRoundTrip.atA.fields).toEqual(afterRoundTrip.atB.fields);
    expect(afterRoundTrip.atA.agendaTaskIds).toEqual(afterRoundTrip.atB.agendaTaskIds);
  }, 300_000);
  it("task lists: it is the same ONE task on both nodes", async () => {
    const { atA, atB } = await result();
    expect(atB.agendaTaskIds).toHaveLength(1);
    expect(atB.agendaTaskIds).toEqual(atA.agendaTaskIds);
  }, 300_000);
});
