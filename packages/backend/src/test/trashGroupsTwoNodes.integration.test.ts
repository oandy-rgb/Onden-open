// "Deleted together" across two databases (history batch 5, docs/architecture/proposals/history-replication-2026-11-22.md §9 row 5): A deletes a tree,
// B takes the bundle, and "restore together" on B gives what it gives on A — though B holds none of A's events, which main's judgement read.
// A descendant deleted on its own earlier stays in the trash on both. The one-node proofs are trashGroups.integration.test.ts.
// SAFETY: databases made from the migrated template (PGlite, or new databases on a `_test` server); nothing shared is touched.
import { describe, expect, it } from "vitest";
import { q, withTransaction } from "../db.js";
import { trashNode } from "../services/nodeTrash.js";
import { seedQ } from "./helpers/seedQ.js";
import { rerunMigration } from "./helpers/rerunMigration.js";
import { onNode } from "./helpers/distSim/realNode.js";
import { buildSourceWorld, capture, fillFrom, openNode } from "./helpers/stampedWorld.js";
import { admit, bundleFor, peerOf, take, type Peer } from "./helpers/stampedBundleWorld.js";
import { chainedTogether, routeNote, togetherIds, trashedStates } from "./helpers/trashChain.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

describe.skipIf(!isTestDb)("deleted together on a node that took the bundle", () => {
  it("B, which took A's bundle and has none of A's events, restores together what A does; a child deleted on its own earlier stays", async () => {
    const [na, nb] = [await openNode("a"), await openNode("b")];
    const world = await buildSourceWorld(na);
    const a = peerOf("A", na, world);
    await fillFrom(nb, world, await capture(na, world, 12_000));
    const b: Peer = peerOf("B", nb, world);
    await admit(a, b);

    const ids = await onNode(na, async () => {
      const root = await routeNote(a.call, a.space, "Root");
      const child = await routeNote(a.call, a.space, "Child", root);
      const grandchild = await routeNote(a.call, a.space, "Grandchild", child);
      const alone = await routeNote(a.call, a.space, "Deleted alone", root);
      await a.call("DELETE", `/api/nodes/${alone}`);
      await a.call("DELETE", `/api/nodes/${root}`);
      return { root, child, grandchild, alone };
    });
    await take(b, await bundleFor(a, b));

    const onA = await onNode(na, () => togetherIds(a.ws, ids.root));
    const onB = await onNode(nb, () => togetherIds(b.ws, ids.root));
    expect(onA, "A: the subtree of the delete, the note deleted earlier left out").toEqual([ids.child, ids.grandchild]);
    expect(onB, "B judges the same").toEqual(onA);
    expect(await onNode(nb, () => q(`SELECT 1 FROM domain_events WHERE target_id = ANY($1::text[])`, [Object.values(ids)])).then((r) => r.rows.length),
      "B holds none of the events A's judgement used to read").toBe(0);
    expect(await onNode(na, () => chainedTogether(a.ws, ids.root)), "and on A it is what the event chain says").toEqual(onA);

    // "Restore together" itself, on each: the same notes come back, the one deleted alone stays in the trash.
    await onNode(na, () => a.call("POST", `/api/nodes/${ids.root}/undelete`, {}));
    await onNode(nb, () => b.call("POST", `/api/nodes/${ids.root}/undelete`, {}));
    const expected = { [ids.root]: false, [ids.child]: false, [ids.grandchild]: false, [ids.alone]: true };
    expect(await onNode(na, () => trashedStates(Object.values(ids)))).toEqual(expected);
    expect(await onNode(nb, () => trashedStates(Object.values(ids)))).toEqual(expected);
    for (const n of [na, nb]) await n.close().catch(() => undefined);
  }, 120_000);

  // What trash_groups holds is this node's own record (spine/syncClasses.json `separate`): it does not travel until history batches 3 and 4
  // carry it. In three cases the stamps alone say something else, so B — which holds the same rows and stamps as A, and no groups — judges
  // differently (review of PR #1989, round 1, point 5; listed in spine/stampedMerge/README.md 「接上傳輸前必須完成」). Each scenario runs once
  // on A, then B joins by snapshot (rows and stamps exactly as A holds them); two tests read it: "today" asserts the difference exactly, so the
  // run is known to have happened, and "desired" (`it.fails`) asserts B judges as A does.
  type Judged = { a: Record<string, string[]>; b: Record<string, string[]>; names: Record<string, string> };
  const scenarios = new Map<string, Promise<Judged>>();
  function judged(name: string, scenario: (a: Peer) => Promise<Record<string, string>>): Promise<Judged> {
    if (!scenarios.has(name)) scenarios.set(name, (async () => {
      const [na, nb] = [await openNode("a"), await openNode("b")];
      try {
        const world = await buildSourceWorld(na);
        const a = peerOf("A", na, world);
        const ids = await onNode(na, () => scenario(a));
        await fillFrom(nb, world, await capture(na, world, 12_000));
        const names = Object.fromEntries(Object.entries(ids).map(([k, v]) => [v, k]));
        const on = (node: typeof na) => onNode(node, async () => {
          const deleted = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE id = ANY($1::uuid[]) AND deleted_at IS NOT NULL`, [Object.values(ids)])).rows;
          return Object.fromEntries(await Promise.all(deleted.map(async ({ id }) => [names[id]!, (await togetherIds(world.ws, id)).map((x) => names[x] ?? x)] as const)));
        });
        // order within one depth follows the notes' ids, which are random: compare as sorted lists
        const sorted = (j: Record<string, string[]>) => Object.fromEntries(Object.entries(j).map(([k, v]) => [k, [...v].sort()]));
        return { a: sorted(await on(na)), b: sorted(await on(nb)), names };
      } finally { for (const n of [na, nb]) await n.close().catch(() => undefined); }
    })());
    return scenarios.get(name)!;
  }
  const tree = async (a: Peer) => {
    const root = await routeNote(a.call, a.space, "Root");
    const child = await routeNote(a.call, a.space, "Child", root);
    const grandchild = await routeNote(a.call, a.space, "Grandchild", child);
    const sibling = await routeNote(a.call, a.space, "Sibling", root);
    return { root, child, grandchild, sibling };
  };
  const beforeChange = (a: Peer) => tree(a).then(async (ids) => {
    // deleted before stamps existed (no stamp on the delete), then the upgrade wrote the group from the event chain
    await a.call("DELETE", `/api/nodes/${ids.root}`);
    await seedQ(`DELETE FROM sync_stamps WHERE table_name = 'content_nodes' AND field = 'deleted' AND row_key = ANY($1::text[])`, [Object.values(ids)]);
    await seedQ(`DELETE FROM trash_groups WHERE root_id = ANY($1::uuid[])`, [Object.values(ids)]);
    await rerunMigration("230_trash_groups");
    return ids;
  });
  const nestedInOneTransaction = (a: Peer) => tree(a).then(async (ids) => {
    await withTransaction(async () => { await trashNode(a.owner, a.ws, ids.child); await trashNode(a.owner, a.ws, ids.root); });
    return ids;
  });
  const oneBroughtBackAlone = (a: Peer) => tree(a).then(async (ids) => {
    // the whole tree deleted; then the sibling's undo brings the root back with it, and the child (with its grandchild) stays
    await a.call("DELETE", `/api/nodes/${ids.root}`);
    await a.call("POST", `/api/nodes/${ids.sibling}/undelete`, {});
    return ids;
  });

  it("today, deleted before this change: A brings the subtree back, B nothing (its delete has no stamp and B has no group)", async () => {
    const r = await judged("before", beforeChange);
    expect(r.a).toEqual({ root: ["child", "grandchild", "sibling"], child: [], grandchild: [], sibling: [] });
    expect(r.b).toEqual({ root: [], child: [], grandchild: [], sibling: [] });
  }, 120_000);
  it.fails("desired, deleted before this change: B judges as A", async () => {
    const r = await judged("before", beforeChange);
    expect(r.b).toEqual(r.a);
  }, 120_000);

  it("today, a child and then its parent deleted in one transaction: B puts the child's subtree under the parent", async () => {
    const r = await judged("nested", nestedInOneTransaction);
    expect(r.a).toEqual({ root: ["sibling"], child: ["grandchild"], grandchild: [], sibling: [] });
    expect(r.b).toEqual({ root: ["child", "grandchild", "sibling"], child: [], grandchild: [], sibling: [] });
  }, 120_000);
  it.fails("desired, a child and then its parent deleted in one transaction: B judges as A", async () => {
    const r = await judged("nested", nestedInOneTransaction);
    expect(r.b).toEqual(r.a);
  }, 120_000);

  it("today, after one note came back on its own: B brings the grandchild back with the child, A does not", async () => {
    const r = await judged("left", oneBroughtBackAlone);
    expect(r.a).toEqual({ child: [], grandchild: [] });
    expect(r.b).toEqual({ child: ["grandchild"], grandchild: [] });
  }, 120_000);
  it.fails("desired, after one note came back on its own: B judges as A", async () => {
    const r = await judged("left", oneBroughtBackAlone);
    expect(r.b).toEqual(r.a);
  }, 120_000);
});
