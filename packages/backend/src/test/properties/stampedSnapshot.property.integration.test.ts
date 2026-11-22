// After any batch of random writes (notes, nesting, renames, tags, attributes, links, board cards, deletes and purges through the real
// routes), a stamped snapshot copied into a fresh database always has the same digest as its source, table by table; the copy goes on
// as a node of its own (its writes are stamped with its own id, from sequence number 1, after what it received); and a copy is not
// exported again as it is (it holds stamps it did not make): the first stage's deliberate limit.
// The source keeps growing from one run to the next, so later runs copy bigger, older, more edited workspaces.
// SAFETY: two databases in one process (PGlite, or databases of the real server: helpers/distSim/postgresNodes.ts); runs on a database named *_test.
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { q } from "../../db.js";
import { RealNode, onNode } from "../helpers/distSim/realNode.js";
import { buildSourceWorld, capture, digestAs, fillFrom, makeCaller, openNode, type SourceWorld } from "../helpers/stampedWorld.js";
import { readStampedPages } from "../../services/stampedSnapshot.js";
import { compareDigests } from "../../spine/snapshotSql.js";
import { CARRIED_LABELS } from "../../spine/stampedMerge/index.js";
import { checkAsync } from "../helpers/propsConfig.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? ""); // both engines: a node is a PGlite, or a database of the real server (helpers/distSim/postgresNodes.ts)

type Op =
  | { kind: "create"; space: 0 | 1; under: number | null }
  | { kind: "rename"; note: number; n: number }
  | { kind: "body"; note: number; n: number }
  | { kind: "tag"; note: number; on: boolean }
  | { kind: "attr"; note: number; value: number | null }
  | { kind: "delete"; note: number }
  | { kind: "purge"; note: number }
  | { kind: "card"; note: number; x: number }
  | { kind: "pointer"; parent: number; target: number };
const idx = fc.integer({ min: 0, max: 7 });
const OPS: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("create" as const), space: fc.constantFrom(0 as const, 1 as const), under: fc.option(idx, { nil: null }) }),
  fc.record({ kind: fc.constant("rename" as const), note: idx, n: fc.integer({ min: 0, max: 4 }) }),
  fc.record({ kind: fc.constant("body" as const), note: idx, n: fc.integer({ min: 0, max: 4 }) }),
  fc.record({ kind: fc.constant("tag" as const), note: idx, on: fc.boolean() }),
  fc.record({ kind: fc.constant("attr" as const), note: idx, value: fc.option(fc.integer({ min: 0, max: 3 }), { nil: null }) }),
  fc.record({ kind: fc.constant("delete" as const), note: idx }),
  fc.record({ kind: fc.constant("purge" as const), note: idx }),
  fc.record({ kind: fc.constant("card" as const), note: idx, x: fc.integer({ min: 0, max: 3 }) }),
  fc.record({ kind: fc.constant("pointer" as const), parent: idx, target: idx }).filter((o) => o.parent !== o.target),
);

describe.skipIf(!isTestDb)("a stamped snapshot after random writes", { timeout: 600_000 }, () => {
  let src: RealNode;
  let world: SourceWorld;
  const notes: string[] = [];
  let tagId = "";
  const opened: RealNode[] = [];

  beforeAll(async () => {
    src = await openNode("property-source");
    world = await buildSourceWorld(src);
    await onNode(src, async () => {
      tagId = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE node_type = 'class_tag' AND title LIKE 'tag-%' LIMIT 1`)).rows[0]!.id;
      notes.push(...(await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND node_type = 'content' AND deleted_at IS NULL AND space_id = $2 ORDER BY title LIMIT 4`, [world.ws, world.spaceA])).rows.map((r) => r.id));
    });
  }, 120_000);
  afterAll(async () => { await src?.close(); for (const n of opened) await n.close(); });

  const live = (i: number) => (notes.length === 0 ? null : notes[i % notes.length]!);

  /** One operation through the routes; a refusal of the route itself (the note is deleted, a name is taken) is part of the batch, not a failure. */
  const run = (op: Op) => onNode(src, async () => {
    const call = world.call;
    const note = "note" in op ? live(op.note) : null;
    try {
      switch (op.kind) {
        case "create": {
          const id = randomUUID();
          const under = op.under === null ? null : live(op.under);
          await call("POST", "/api/nodes", { id, title: `n-${id.slice(0, 6)}`, markdown: `# ${id}\n\ntext`, space_id: op.space === 0 ? world.spaceA : world.spaceB, ...(under ? { parent_id: under } : {}) });
          notes.push(id);
          break;
        }
        case "rename": if (note) await call("PATCH", `/api/nodes/${note}`, { title: `renamed ${op.n} ${note.slice(0, 4)}` }); break;
        case "body": if (note) await call("PATCH", `/api/nodes/${note}`, { markdown: `body ${op.n}\n\nline two ${op.n}` }); break;
        case "tag": if (note) await call(op.on ? "PUT" : "DELETE", `/api/nodes/${note}/tags/${tagId}`); break;
        case "attr": if (note) await call(op.value === null ? "DELETE" : "PUT", `/api/nodes/${note}/attributes/rank`, op.value === null ? undefined : { value: op.value, value_type: "number" }); break;
        case "delete": if (note) await call("DELETE", `/api/nodes/${note}`); break;
        case "purge": if (note) { await call("DELETE", `/api/nodes/${note}`).catch(() => undefined); await call("POST", `/api/nodes/${note}/purge`, { expected_ids: [note] }); } break;
        case "card": if (note) await call("PUT", `/api/nodes/${note}/position`, { surface: "graph", x: op.x, y: op.x * 2 }); break;
        case "pointer": { const [p, t] = [live(op.parent), live(op.target)]; if (p && t) await call("POST", "/api/pointers", { parent_id: p, target_id: t }); break; }
      }
    } catch { /* refused by the route: the database is as it was */ }
  });

  it("copies to the same digest every time; the copy writes on as its own node; a copy is exported in turn, bringing its source at the cut", async () => {
    await checkAsync(fc.asyncProperty(fc.array(OPS, { minLength: 2, maxLength: 9 }), async (ops) => {
      for (const op of ops) await run(op);
      const cap = await capture(src, world, 15_000);
      const dst = await openNode(`property-receiver-${opened.length}`);
      opened.push(dst);
      await fillFrom(dst, world, cap);
      const mine = await digestAs(dst, world.ws, world.owner);
      expect(compareDigests(cap.summary.digest, mine)).toEqual([]);
      // the copy's first write is its own sequence number 1, and no stamp it holds is its own before that
      const own = await onNode(dst, async () => {
        const node = (await q<{ node_id: string }>(`SELECT node_id FROM sync_node`)).rows[0]!.node_id;
        expect((await q(`SELECT 1 FROM sync_stamps WHERE workspace_id = $1 AND origin = $2 LIMIT 1`, [world.ws, node])).rows).toHaveLength(0);
        const id = (await makeCaller(world.owner)("POST", "/api/nodes", { title: "after the copy", markdown: "x", space_id: world.spaceA })).id as string;
        return (await q<{ origin: string; seq: string }>(`SELECT origin, seq::text FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = $2 AND field = '*'`, [world.ws, id])).rows[0]!;
      });
      expect(own.seq).toBe("1");
      // and the copy is a source in turn: its snapshot brings the node it was copied from, at the cut it took, in every label (own-node-transport batch 2)
      const relayed = await onNode(dst, () => readStampedPages(world.owner, world.ws, { since: null, layer: "rows" }, async () => undefined));
      for (const of of Object.values(relayed.brought)) expect(of).toEqual({ [cap.summary.source]: cap.summary.cut });
      expect(Object.keys(relayed.brought)).toHaveLength(CARRIED_LABELS.length);
      await dst.close();
      opened.splice(opened.indexOf(dst), 1);
    }), 15);
    expect(true).toBe(true);
  });
});
