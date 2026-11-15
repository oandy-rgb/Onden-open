// Undo with `cascade: true` (services/eventRestore/restore.ts), against a model of the notes.
//
// A generated history builds a note tree (create under a random parent, rename,
// delete, undelete). Then one note with its live subtree is deleted — one root
// NODE_DELETED event with every descendant's NODE_DELETED chained to it
// (triggered_by) — and the root event is undone with cascade.
//
// Invariants:
//  C1  success: every note (title, parent, text, in-trash or not) is exactly as it was
//      before the delete — the cascade undoes the whole chain;
//  C2  a failure in the middle leaves everything exactly as it was BEFORE the undo:
//      no note row changed and no event or restore marker was added. Three failures:
//        purged  one descendant's row is gone (domain refusal 410, after the newer
//                descendants were already undone);
//        denied  one descendant sits in a space the restoring editor may only view
//                (AuthorityError thrown mid-cascade).
//        refused a chained edit whose undo is a domain refusal (410, returned not thrown).
//      All-or-nothing: an undo that stopped halfway would be worse than a slow one;
//  C3  after a refused undo the same undo succeeds once the obstacle is removed
//      (the failed attempt consumed nothing; not for `refused`: an event cannot be deleted).
//
// Run count: PROPS_RUNS (default 10 here: a run is ~40 writes), seed PROPS_SEED.
//   PROPS_SEED=… PROPS_RUNS=100 npx vitest run src/test/properties/cascadeUndo.property.integration.test.ts
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

let WS = "";
vi.mock("../../db.js", async (original) => ({ ...await original<typeof import("../../db.js")>(), getWorkspaceId: async () => WS }));

import { event, pool, q } from "../../db.js";
import { awaitAllDispatchers } from "../../services/dispatcherQueue.js";
import { restoreEvent } from "../../services/eventRestore/index.js";
import { createNote } from "../../services/noteCreate.js";
import { trashNode, undeleteNode } from "../../services/nodeTrash.js";
import { updateNode } from "../../services/nodeUpdate.js";
import type { ActorCtx } from "../../types.js";
import { persistActor } from "../helpers/persistActor.js";
import { makeSpace, putInSpace } from "../helpers/spaceFixtures.js";
import { seedQ } from "../helpers/seedQ.js";
import { isTestDatabase } from "../helpers/testDatabase.js";
import { checkAsync } from "../helpers/propsConfig.js";

const isTestDb = isTestDatabase();
const RUN_CAP = process.env.PROPS_RUNS ? Infinity : 10;

afterAll(async () => { await awaitAllDispatchers(); await pool.end(); });

type Op =
  | { k: "create"; under: number | null }
  | { k: "rename"; n: number }
  | { k: "delete"; n: number }
  | { k: "undelete"; n: number };

const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ k: fc.constant("create" as const), under: fc.option(fc.nat(30), { nil: null, freq: 8 }) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("rename" as const), n: fc.nat(30) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("delete" as const), n: fc.nat(30) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("undelete" as const), n: fc.nat(30) }) },
);
const scenario = fc.record({
  ops: fc.array(op, { minLength: 3, maxLength: 24 }),
  rootPick: fc.nat(1000),
  failure: fc.constantFrom("purged" as const, "denied" as const, "refused" as const),
  failAt: fc.nat(1000),
});

type NodeRow = { id: string; title: string; parent_id: string | null; markdown: string; trashed: boolean };
/** The whole workspace's notes, by id — what the undo must put back or leave alone. */
async function notes(): Promise<NodeRow[]> {
  return (await q<NodeRow>(
    `SELECT id::text, title, parent_id::text, markdown, deleted_at IS NOT NULL AS trashed
       FROM content_nodes WHERE workspace_id = $1 ORDER BY id`, [WS],
  )).rows;
}
const eventCount = async (): Promise<number> =>
  (await q<{ n: number }>(`SELECT count(*)::int AS n FROM domain_events WHERE workspace_id = $1`, [WS])).rows[0]!.n;

describe.skipIf(!isTestDb)("cascade undo is all-or-nothing and exact (DB, property)", () => {
  const admin: ActorCtx = { id: "cascade-prop-admin", name: "Cascade admin", role: "admin", type: "human" };
  let editor: ActorCtx;

  beforeAll(async () => {
    WS = (await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Cascade undo props', gen_random_uuid()::text) RETURNING id`,
    )).rows[0]!.id;
    Object.assign(admin, await persistActor(WS, admin));
    editor = await persistActor(WS, { id: "cascade-prop-editor", name: "Cascade editor", role: "editor", type: "human" });
  });

  it("C1–C3 over random histories", async () => {
    await checkAsync(fc.asyncProperty(scenario, async (s) => {
      // ── Build a random tree (a model of which notes are live decides what is legal).
      const ids: string[] = [];
      const live = new Map<string, boolean>(); // id → in the trash?
      const trashed = (i: number) => live.get(ids[i % ids.length]!) === true;
      for (const o of s.ops) {
        if (o.k === "create") {
          const parent = o.under !== null && ids.length && !trashed(o.under) ? ids[o.under % ids.length]! : undefined;
          const id = (await createNote({
            actor: admin, workspaceId: WS, title: `note ${ids.length}`, markdown: `body ${ids.length}\n`,
            parentId: parent, event: { uiContext: "test" },
          })).node.id as string;
          ids.push(id); live.set(id, false);
        } else if (ids.length) {
          const id = ids[o.n % ids.length]!;
          if (o.k === "rename" && !trashed(o.n)) await updateNode(WS, id, { title: `renamed ${o.n} ${ids.length}` }, { actor: admin });
          if (o.k === "delete" && !trashed(o.n)) {
            await trashNode(admin, WS, id);
            for (const r of (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND deleted_at IS NOT NULL`, [WS])).rows) live.set(r.id, true);
          }
          if (o.k === "undelete" && trashed(o.n)) {
            // A deleted note whose parent is still deleted cannot come back alone; skip those.
            await undeleteNode(admin, WS, id).catch(() => undefined);
            for (const r of (await q<{ id: string; t: boolean }>(`SELECT id::text, deleted_at IS NOT NULL AS t FROM content_nodes WHERE workspace_id = $1`, [WS])).rows) live.set(r.id, r.t);
          }
        }
      }
      // Pick a live note to delete with its subtree (create one when everything is in the trash).
      let liveIds = ids.filter((id) => live.get(id) === false);
      if (!liveIds.length) {
        const id = (await createNote({ actor: admin, workspaceId: WS, title: "fresh", markdown: "", event: { uiContext: "test" } })).node.id as string;
        ids.push(id); live.set(id, false); liveIds = [id];
      }
      // Prefer a note with live children so the chain is not empty.
      const parents = new Set((await q<{ p: string }>(`SELECT DISTINCT parent_id::text AS p FROM content_nodes WHERE workspace_id = $1 AND deleted_at IS NULL AND parent_id IS NOT NULL`, [WS])).rows.map((r) => r.p));
      const withChildren = liveIds.filter((id) => parents.has(id));
      const rootChoices = withChildren.length ? withChildren : liveIds;
      const rootNote = rootChoices[s.rootPick % rootChoices.length]!;
      const before = await notes();
      await trashNode(admin, WS, rootNote);
      const rootEvent = (await q<{ id: string }>(
        `SELECT id::text FROM domain_events WHERE workspace_id = $1 AND event_type = 'NODE_DELETED' AND target_id = $2
          ORDER BY domain_events.id DESC LIMIT 1`, [WS, rootNote],
      )).rows[0]!.id;
      const chain = (await q<{ target_id: string }>(
        `SELECT target_id FROM domain_events WHERE workspace_id = $1 AND triggered_by_event_id = $2::bigint ORDER BY id`, [WS, rootEvent],
      )).rows.map((r) => r.target_id);

      // ── C1 / C2 / C3 (see the header).
      // A failure needs a descendant to break; with none, only C1 applies.
      if (chain.length) {
        const victim = chain[s.failAt % chain.length]!;
        let actor = admin;
        let undoObstacle: (() => Promise<void>) | null;
        if (s.failure === "purged") {
          const row = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE id = $1`, [victim])).rows[0]!;
          // Purge = the row is gone while its event stays (a hard delete after the fact).
          const saved = (await q(`SELECT * FROM content_nodes WHERE id = $1`, [row.id])).rows[0]!;
          // The foreign key detaches the purged note's children (parent_id → NULL); remember them.
          const kids = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE parent_id = $1`, [row.id])).rows.map((r) => r.id);
          await seedQ(`DELETE FROM content_nodes WHERE id = $1`, [row.id]);
          undoObstacle = async () => {
            const cols = Object.keys(saved);
            await seedQ(`INSERT INTO content_nodes (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, cols.map((c) => saved[c]));
            if (kids.length) await seedQ(`UPDATE content_nodes SET parent_id = $1 WHERE id = ANY($2::uuid[])`, [row.id, kids]);
          };
        } else if (s.failure === "refused") {
          // A chained edit whose undo is a domain refusal (a conflict, 409). It
          // is the newest event, so it is tried first — after the root was brought back.
          await event(WS, "NODE_UPDATED", "node", victim, { title: "never" }, "user", admin.id, {
            triggeredBy: rootEvent, txMeta: { prev_field_values: { title: "before" } },
          });
          undoObstacle = null; // the log is append-only: this obstacle cannot be taken away (no C3)
        } else {
          actor = editor;
          const space = await makeSpace(WS, `view-only ${Math.random()}`, [{ id: admin.id, role: "manager" }, { id: editor.id, role: "viewer" }]);
          // putInSpace moves the whole subtree and detaches the note from its parent: put every
          // note's space and parent back afterwards, in one statement.
          const saved = (await q<{ id: string; space_id: string | null; parent_id: string | null }>(
            `SELECT id::text, space_id::text, parent_id::text FROM content_nodes WHERE workspace_id = $1`, [WS])).rows;
          await putInSpace(victim, space);
          undoObstacle = async () => {
            await seedQ(
              `UPDATE content_nodes n SET space_id = v.space_id, parent_id = v.parent_id
                 FROM unnest($1::uuid[], $2::uuid[], $3::uuid[]) AS v(id, space_id, parent_id) WHERE n.id = v.id`,
              [saved.map((r) => r.id), saved.map((r) => r.space_id), saved.map((r) => r.parent_id)]);
          };
        }
        const stateBefore = await notes();
        const eventsBefore = await eventCount();
        // C2: refused (domain code) or thrown — either way nothing moved.
        const outcome = await restoreEvent(rootEvent, { actor, workspaceId: WS, cascade: true }).then((r) => r, (e: unknown) => e);
        expect("restored" in (outcome as object)).toBe(false);
        expect(await notes()).toEqual(stateBefore);
        expect(await eventCount()).toBe(eventsBefore);
        if (s.failure === "refused") expect(outcome).toHaveProperty("status");
        // C3: remove the obstacle; the same undo now works.
        if (!undoObstacle) return;
        await undoObstacle();
        const retry = await restoreEvent(rootEvent, { actor: admin, workspaceId: WS, cascade: true });
        expect(retry).toMatchObject({ restored: true });
        expect(await notes()).toEqual(before);
      } else {
        const result = await restoreEvent(rootEvent, { actor: admin, workspaceId: WS, cascade: true });
        expect(result).toMatchObject({ restored: true });
        expect(await notes()).toEqual(before);
      }
    }), RUN_CAP);
  }, 600_000);
});
