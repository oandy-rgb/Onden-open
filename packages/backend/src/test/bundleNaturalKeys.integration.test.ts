// Two nodes made two rows with one natural key (a unique index besides the row key) under two ids (review of PR #1853, point 1). The rule is declared per source
// (spine/stampedMerge/dbUnits.ts `naturalKeys`): the row made first stays on every node, the other is not made, the report names both (`duplicateRows`), and what hangs
// on the row left out goes with it. A unique key nobody declared refuses the bundle with a code (`bundle_unique_clash`), never a quiet missing row.
// The paragraph rows here are written directly (as rows made before their ids were derived from the anchor, or after an anchor was renamed): a row made today by a save
// for the same anchor has the same id on both nodes (derivedIdName.blockNode) and does not clash at all. Both engines.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { q } from "../db.js";
import { RealNode, onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, fillFrom, openNode } from "./helpers/stampedWorld.js";
import { admit, bundleFor, exchange, peerOf, take, type Peer } from "./helpers/stampedBundleWorld.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const open: RealNode[] = [];
afterEach(async () => { for (const n of open.splice(0)) await n.close().catch(() => undefined); });

async function twoNodes(): Promise<{ a: Peer; b: Peer; note: string; child: string; task: string; tag: string }> {
  const [na, nb] = [await openNode("a"), await openNode("b")];
  open.push(na, nb);
  const world = await buildSourceWorld(na);
  const a = peerOf("A", na, world);
  const ids = await onNode(na, async () => {
    const mk = async (title: string, type = "content") => (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id) VALUES ($1, 'manual', $4, $2, $2 || '-' || gen_random_uuid(), '', $3) RETURNING id::text`,
      [world.ws, title, world.spaceA, type])).rows[0]!.id;
    return { note: await mk("Keys"), child: await mk("Child"), task: await mk("Task"), tag: await mk("Keytag", "class_tag") };
  });
  await fillFrom(nb, world, await capture(na, world, 1_000_000));
  const b = peerOf("B", nb, world);
  await admit(a, b);
  return { a, b, ...ids };
}
type RowSpec = { anchor: string | null; ref: string; task?: string; detached?: string };
const addRow = (p: Peer, note: string, r: RowSpec): Promise<string> => onNode(p.node, async () => (await seedQ<{ id: string }>(
  `INSERT INTO block_nodes (id, workspace_id, note_id, block_ref, anchor_id, kind, label, text_cache, task_id, detached_note_id) VALUES ($1, $2, $3, $4, $5, 'paragraph', 'p', 'p', $6, $7) RETURNING id::text`,
  [randomUUID(), p.ws, note, r.ref, r.anchor, r.task ?? null, r.detached ?? null])).rows[0]!.id);
const rowsOf = (p: Peer, note: string) => onNode(p.node, async () => (await q<{ id: string }>(`SELECT id::text FROM block_nodes WHERE note_id = $1 ORDER BY id`, [note])).rows.map((r) => r.id));
const tagsOf = (p: Peer, row: string) => onNode(p.node, async () => (await q(`SELECT 1 FROM block_node_tags WHERE block_node_id = $1`, [row])).rows.length);

const CASES: Array<{ key: string; rows: (x: { child: string; task: string }) => [RowSpec, RowSpec] }> = [
  { key: "block_nodes_anchor_uq", rows: () => [{ anchor: "kanc01", ref: "kref-a" }, { anchor: "kanc01", ref: "kref-b" }] },
  { key: "block_nodes_note_ref_uq", rows: () => [{ anchor: null, ref: "kref-same" }, { anchor: null, ref: "kref-same" }] },
  { key: "block_nodes_task_uq", rows: ({ task }) => [{ anchor: null, ref: "kt-a", task }, { anchor: null, ref: "kt-b", task }] },
  { key: "block_nodes_detached_uq", rows: ({ child }) => [{ anchor: null, ref: "kd-a", detached: child }, { anchor: null, ref: "kd-b", detached: child }] },
];

describe.skipIf(!isTestDb)("two rows with one natural key, made on two nodes: the earlier stays on both, the report names it", () => {
  for (const c of CASES) {
    it(`${c.key}: A's row (made first) is the row on both nodes; B's is left out with its tag; both reports name it`, async () => {
      const { a, b, note, child, task, tag } = await twoNodes();
      const [ra, rb] = c.rows({ child, task });
      const rowA = await addRow(a, note, ra);
      const rowB = await addRow(b, note, rb);
      await onNode(b.node, () => seedQ(`INSERT INTO block_node_tags (block_node_id, tag_id, workspace_id) VALUES ($1, $2, $3)`, [rowB, tag, b.ws]));
      const ab = await bundleFor(a, b), ba = await bundleFor(b, a); // both read before either is taken
      const atB = await take(b, ab), atA = await take(a, ba);
      expect(await rowsOf(a, note)).toEqual([rowA]);
      expect(await rowsOf(b, note)).toEqual([rowA]);
      expect(await tagsOf(b, rowB)).toBe(0); // it went with the row left out (the database's cascade), on the node that held it
      for (const r of [atA, atB]) expect(r.duplicateRows).toContainEqual({ table: "block_nodes", key: c.key, kept: rowA, lost: rowB });
      // a second round changes nothing
      await exchange(a, b); await exchange(b, a);
      expect([await rowsOf(a, note), await rowsOf(b, note)]).toEqual([[rowA], [rowA]]);
    }, 600_000);
  }

  it("a clash on a unique key no source declares refuses the bundle (bundle_unique_clash) and writes nothing", async () => {
    const { a, b, note } = await twoNodes();
    // a unique index the sources do not know about, on B only (as a later migration could add one): A's row clashes with B's on it
    await onNode(b.node, () => q(`CREATE UNIQUE INDEX test_block_label_uq ON block_nodes (note_id, label)`));
    await addRow(b, note, { anchor: null, ref: "u-b" });
    await addRow(a, note, { anchor: null, ref: "u-a" });
    const before = await rowsOf(b, note);
    const refused = await take(b, await bundleFor(a, b)).then(() => null, (e: { code?: string }) => e.code);
    expect(refused).toBe("bundle_unique_clash");
    expect(await rowsOf(b, note)).toEqual(before);
  }, 600_000);
});
