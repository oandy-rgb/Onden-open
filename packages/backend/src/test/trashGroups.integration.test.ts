// "Deleted together" is judged from facts every node holds (history batch 5, docs/architecture/proposals/history-replication-2026-11-22.md §7;
// services/nodeTrash.ts deletedTogether, migration 230): the write stamp of each note's `deleted` unit, and trash_groups for what the stamps cannot
// tell. What this file proves:
//   - (two databases: trashGroupsTwoNodes.integration.test.ts)
//   - a child, then its parent, deleted in ONE transaction (History's rewind can): the groups are written down and the answer is the event chain's;
//   - deletions from before this change (no stamp on their `deleted` unit, as before migration 190) restore through the groups migration 230
//     writes from the chain, and those groups stop counting once a note is brought back and deleted again.
// The random comparison of the old judgement with the new one is properties/deletedTogether.property.integration.test.ts.
// SAFETY: databases made from the migrated template (PGlite, or new databases on a `_test` server); nothing shared is touched.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getWorkspaceId, q, withTransaction } from "../db.js";
import { trashNode, undeleteNode } from "../services/nodeTrash.js";
import { restoreEvent } from "../services/eventRestore/restore.js";
import { makeCaller } from "./helpers/stampedWorld.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";
import { rerunMigration } from "./helpers/rerunMigration.js";
import { previewSqlOf } from "./helpers/versionsPreview.js";
import { chainedTogether, routeNote, togetherIds, trashedStates } from "./helpers/trashChain.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

describe.skipIf(!isTestDb)("deleted together, from stamps and trash_groups", () => {
  describe("one node", () => {
    const world = async () => {
      const ws = await getWorkspaceId();
      const owner = await persistActor(ws, { id: "", name: "Owner", role: "admin", type: "human" });
      const space = await makeSpace(ws, `Trash groups ${randomUUID().slice(0, 6)}`, [{ id: owner.id, permission: "edit" }]);
      return { ws, owner, space, call: makeCaller(owner) };
    };

    it("a child, then its parent, deleted in one transaction: each keeps its own group, as the event chain says", async () => {
      const { ws, owner, space, call } = await world();
      const root = await routeNote(call, space, "Root");
      const first = await routeNote(call, space, "Deleted first", root);
      const under = await routeNote(call, space, "Under it", first);
      const second = await routeNote(call, space, "Taken with the root", root);
      await withTransaction(async () => {
        await trashNode(owner, ws, first);
        await trashNode(owner, ws, root);
      });
      const stamps = (await q<{ s: string | null }>(`SELECT trash_deleted_stamp($1, id) AS s FROM content_nodes WHERE id = ANY($2::uuid[])`, [ws, [root, first, under, second]])).rows;
      expect(new Set(stamps.map((row) => row.s)).size, "one transaction, one stamp for all four").toBe(1);
      expect(await togetherIds(ws, root)).toEqual([second]);
      expect(await togetherIds(ws, first)).toEqual([under]);
      for (const id of [root, first, under, second]) expect(await togetherIds(ws, id), id).toEqual(await chainedTogether(ws, id));
    });

    it("a note that comes back without what its delete took along leaves those apart: nothing comes with them later, as the chain says", async () => {
      const { ws, owner, space, call } = await world();
      const root = await routeNote(call, space, "Root");
      const child = await routeNote(call, space, "Child", root);
      const grandchild = await routeNote(call, space, "Grandchild", child);
      const sibling = await routeNote(call, space, "Sibling", root);
      const nephew = await routeNote(call, space, "Nephew", sibling);
      await trashNode(owner, ws, root);
      // History: restore the child's own delete (one of the cascade's). Its parent comes back alone; the sibling and the grandchild stay.
      const childDelete = (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE event_type = 'NODE_DELETED' AND target_id = $1 ORDER BY domain_events.id DESC LIMIT 1`, [child])).rows[0]!.id;
      expect(await restoreEvent(childDelete, { actor: owner, workspaceId: ws })).toMatchObject({ restored: true });
      const all = [root, child, grandchild, sibling, nephew];
      expect(await trashedStates(all)).toEqual({ [root]: false, [child]: false, [grandchild]: true, [sibling]: true, [nephew]: true });
      for (const id of all) expect(await togetherIds(ws, id), id).toEqual(await chainedTogether(ws, id));
      expect(await togetherIds(ws, sibling), "the sibling was taken along: its child does not come with it").toEqual([]);
    });

    it("delete, bring back and delete again in ONE transaction (one stamp): the earlier groups no longer claim the last delete", async () => {
      const { ws, owner, space, call } = await world();
      const root = await routeNote(call, space, "Root");
      const child = await routeNote(call, space, "Child", root);
      const grandchild = await routeNote(call, space, "Grandchild", child);
      const sibling = await routeNote(call, space, "Sibling", root);
      // Review of PR #1989, round 1, point 4: C, then R, then R back, then C back, then R again — all one transaction.
      await withTransaction(async () => {
        await trashNode(owner, ws, child);
        await trashNode(owner, ws, root);
        await undeleteNode(owner, ws, root);
        await undeleteNode(owner, ws, child);
        await trashNode(owner, ws, root);
      });
      const all = [root, child, grandchild, sibling];
      expect(await trashedStates(all)).toEqual({ [root]: true, [child]: true, [grandchild]: true, [sibling]: true });
      expect(await togetherIds(ws, root)).toEqual(await chainedTogether(ws, root));
      expect(new Set(await togetherIds(ws, root)), "the last delete took the whole tree").toEqual(new Set([child, grandchild, sibling]));
      for (const id of all) expect(await togetherIds(ws, id), id).toEqual(await chainedTogether(ws, id));
    });

    it("deletions from before the stamps come back through the groups migration 230 writes; a later delete is judged by its own stamp", async () => {
      const { ws, owner, space, call } = await world();
      const root = await routeNote(call, space, "Old root");
      const child = await routeNote(call, space, "Old child", root);
      const grandchild = await routeNote(call, space, "Old grandchild", child);
      const alone = await routeNote(call, space, "Old, deleted alone", root);
      await trashNode(owner, ws, alone);
      await trashNode(owner, ws, root);
      // As a database from before migration 190 holds them: no stamp on the deletes.
      const all = [root, child, grandchild, alone];
      await seedQ(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = ANY($2::text[]) AND field = 'deleted'`, [ws, all]);
      await seedQ(`DELETE FROM trash_groups WHERE root_id = ANY($1::uuid[])`, [all]);
      expect(await togetherIds(ws, root), "the stamps alone cannot tell").toEqual([]);

      await rerunMigration("230_trash_groups");
      expect(await togetherIds(ws, root)).toEqual([child, grandchild]);
      for (const id of all) expect(await togetherIds(ws, id), id).toEqual(await chainedTogether(ws, id));

      // Back, then the child deleted on its own and the root again: the old group no longer holds.
      await call("POST", `/api/nodes/${root}/undelete`, {});
      expect(await trashedStates(all)).toEqual({ [root]: false, [child]: false, [grandchild]: false, [alone]: true });
      await trashNode(owner, ws, child);
      await trashNode(owner, ws, root);
      expect(await togetherIds(ws, root)).toEqual([]);
      expect(await togetherIds(ws, child)).toEqual([grandchild]);
      for (const id of all) expect(await togetherIds(ws, id), id).toEqual(await chainedTogether(ws, id));
    });

    it("the preview in migration 230's header counts exactly the groups and rows the migration writes", async () => {
      const { ws, owner, space, call } = await world();
      // Every kind the migration writes: a chain that is not empty, two deletes sharing a stamp, and a delete from before the stamps.
      const shared = await routeNote(call, space, "Shared root");
      const first = await routeNote(call, space, "Shared first", shared);
      await routeNote(call, space, "Under first", first);
      await routeNote(call, space, "Shared sibling", shared);
      await withTransaction(async () => { await trashNode(owner, ws, first); await trashNode(owner, ws, shared); });
      const old = await routeNote(call, space, "Before the stamps");
      const oldChild = await routeNote(call, space, "Its child", old);
      await trashNode(owner, ws, old);
      await seedQ(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = ANY($2::text[]) AND field = 'deleted'`, [ws, [old, oldChild]]);
      // As before the migration: nothing in trash_groups anywhere.
      await seedQ(`DELETE FROM trash_groups`);
      const preview = (await q<{ groups: string; rows: string }>(previewSqlOf("230_trash_groups.sql"))).rows[0]!;
      await rerunMigration("230_trash_groups");
      const written = (await q<{ groups: string; rows: string }>(
        `SELECT count(*) FILTER (WHERE root_id = note_id) AS groups, count(*) AS rows FROM trash_groups`)).rows[0]!;
      expect(Number(preview.rows), "something was written").toBeGreaterThan(0);
      expect({ groups: Number(written.groups), rows: Number(written.rows) }).toEqual({ groups: Number(preview.groups), rows: Number(preview.rows) });
    });

    it("the migration writes, for every note in the trash, the answer the event chain gave, also where two deletes share a stamp", async () => {
      const { ws, owner, space, call } = await world();
      const root = await routeNote(call, space, "Shared root");
      const first = await routeNote(call, space, "Shared first", root);
      const under = await routeNote(call, space, "Shared under", first);
      const sibling = await routeNote(call, space, "Shared sibling", root);
      await withTransaction(async () => {
        await trashNode(owner, ws, first);
        await trashNode(owner, ws, root);
      });
      // As before this change: nothing in trash_groups (the stamps are kept: deleted after migration 190).
      const all = [root, first, under, sibling];
      await seedQ(`DELETE FROM trash_groups WHERE root_id = ANY($1::uuid[])`, [all]);
      expect(new Set(await togetherIds(ws, root)), "without the groups the stamps put both subtrees under the root").toEqual(new Set([first, under, sibling]));
      await rerunMigration("230_trash_groups");
      for (const id of all) expect(await togetherIds(ws, id), id).toEqual(await chainedTogether(ws, id));
    });
  });
});
