// The ids a body write mints, on two nodes that hold the same text. Step 1b of docs/architecture/proposals/anchors-deterministic-2026-11-16.md:
// each `it.fails` below turns around in step 3 (the writer mints an id once and carries it).
//
// A writes the body (and derives its anchors, paragraph rows and the task note); a bundle gives B the text only (pinned in stampedBundle.integration.test.ts:
// B derives nothing from it); then B edits one word of that text, so B's own write derives what A derived, for the same paragraphs and the same task line.
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

type Side = { anchors: string[]; paragraphRows: string[]; taskNotes: Array<{ id: string; linkedToALine: boolean }>; agendaTaskIds: string[] };
async function probe(): Promise<{ atA: Side; atB: Side }> {
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
    anchors: (await q<{ anchor_id: string }>(`SELECT anchor_id FROM block_anchors WHERE note_id = $1 ORDER BY from_utf16, anchor_id`, [note])).rows.map((r) => r.anchor_id),
    paragraphRows: (await q<{ id: string }>(`SELECT id::text FROM block_nodes WHERE note_id = $1 ORDER BY id`, [note])).rows.map((r) => r.id),
    taskNotes: (await q<{ id: string; linked: boolean }>(
      `SELECT c.id::text, EXISTS (SELECT 1 FROM block_nodes b WHERE b.task_id = c.id AND b.note_id = $1) AS linked
         FROM content_nodes c WHERE c.parent_id = $1 ORDER BY c.id`, [note])).rows.map((r) => ({ id: r.id, linkedToALine: r.linked })),
    // what the task lists show (modules/tasks/agenda.ts): the open tasks of the workspace
    agendaTaskIds: Object.values((await taskAgenda(p.owner, p.ws)).buckets).flat().map((t) => (t as { id: string }).id).sort(),
  }));
  return { atA: await read(a), atB: await read(b) };
}
let memo: ReturnType<typeof probe> | null = null; // the nodes are closed after each test; what is kept is plain data
const result = () => (memo ??= probe());
const inCommon = (x: string[], y: string[]) => x.filter((id) => y.includes(id));

describe.skipIf(!isTestDb)("the ids a body write mints, on two nodes that hold the same text", () => {
  it("both nodes end up with anchors, paragraph rows and a task note for the text (so the comparisons below compare something)", async () => {
    const { atA, atB } = await result();
    for (const side of [atA, atB]) { expect(side.anchors.length).toBeGreaterThan(0); expect(side.paragraphRows.length).toBeGreaterThan(0); expect(side.taskNotes.length).toBeGreaterThan(0); }
  }, 300_000);
  it.fails("anchor ids: B draws its own id for a paragraph A already gave one (newBlockId in store.ts insertAnchor)", async () => {
    const { atA, atB } = await result();
    expect(inCommon(atA.anchors, atB.anchors)).toEqual(atA.anchors);
  }, 300_000);
  it.fails("paragraph rows: B draws its own block_nodes.id for a paragraph A already has a row for (the column default, services/blockNodes.ts syncBlockNodes)", async () => {
    const { atA, atB } = await result();
    expect(inCommon(atA.paragraphRows, atB.paragraphRows)).toEqual(atA.paragraphRows);
  }, 300_000);
  it.fails("tasks: the one task line `- [ ] do a thing {task}` is one task note on B, as it is on A (today B holds A's, which arrived by bundle, AND a second one it made itself)", async () => {
    const { atA, atB } = await result();
    expect(atA.taskNotes).toHaveLength(1);
    expect(atB.taskNotes).toHaveLength(1);
  }, 300_000);
  it.fails("tasks, the consequence: on B the line's block row points at ONE of the two task notes, so A's task note, which arrived by bundle, has no line on B: the line is ticked on B's own task note, and the same task is two notes", async () => {
    const { atB } = await result();
    expect(atB.taskNotes.filter((t) => !t.linkedToALine)).toEqual([]);
  }, 300_000);
  it("task lists: B's list shows the one task of the line, not two (A's note that arrived by bundle has no line on B, so the list does not show it)", async () => {
    const { atA, atB } = await result();
    expect(atA.agendaTaskIds).toHaveLength(1);
    expect(atB.agendaTaskIds).toHaveLength(1);
    expect(atB.agendaTaskIds[0]).toBe(atB.taskNotes.find((t) => t.linkedToALine)!.id);
  }, 300_000);
  it.fails("task lists: it is the same task on both nodes (today B lists its own note, with another id than the one A lists)", async () => {
    const { atA, atB } = await result();
    expect(atB.agendaTaskIds).toEqual(atA.agendaTaskIds);
  }, 300_000);
});
