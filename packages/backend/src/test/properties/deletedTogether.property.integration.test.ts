// "Deleted together" on one node: the new judgement (services/nodeTrash.ts restorePlan → deletedTogether: stamps and trash_groups, migration 230)
// against the one main made (helpers/trashChain.ts: this node's event chain), over random sequences of deletes and ways back. History batch 5 of
// docs/architecture/proposals/history-replication-2026-11-22.md: on a single server the answer must not change.
//
// Commands, on a small tree of notes made through the routes: delete a note (DELETE /api/nodes/:id), undo a delete (POST …/undelete), restore a
// recorded NODE_DELETED or NODE_UNDELETED event from History (restoreEvent, alone or with its cascade), delete a note and then one above it in ONE
// transaction (what History's rewind can do), several deletes and ways back in ONE transaction (one stamp for all of them), delete for good,
// and the upgrade: trash_groups emptied and migration 230 run again (sometimes on a trash whose deletes have no stamp, as before migration
// 190), so that at any point the trash may be one that came from before this change. After every command, for every note of the run that is
// deleted, the two judgements give the same notes in the same order.
//
// Size: RUNS runs (default 150) of up to MAX_COMMANDS (24) commands on NOTES (9) notes: 2 min 12 s on PGlite in one worker (2026-11-23, the
// cloud runner, another test file running beside it), 6 min 44 s inside a run of 65 files; 30 runs took 16 s. Larger runs: PROPS_RUNS (at most 500).
//
// The seed is new every run (PROPS_SEED replays one) and printed; a failure prints fast-check's shrunk command list. A red from a new seed is a
// finding: shrink it and pin it with `it.fails` (README of spine/stampedMerge, 「接上傳輸前必須完成」), never retry or fix the seed.
// SAFETY: skips unless DATABASE_URL points at a *_test database.
import { randomInt, randomUUID } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { getWorkspaceId, q, withTransaction } from "../../db.js";
import { purgeDeleted, restorePlan, trashNode, undeleteNode } from "../../services/nodeTrash.js";
import { restoreEvent } from "../../services/eventRestore/restore.js";
import { persistActor } from "../helpers/persistActor.js";
import { makeSpace } from "../helpers/spaceFixtures.js";
import { makeCaller } from "../helpers/stampedWorld.js";
import { chainedTogether } from "../helpers/trashChain.js";
import { seedQ } from "../helpers/seedQ.js";
import { rerunMigration } from "../helpers/rerunMigration.js";
import { AuthorityError } from "../../spine/authority.js";
import type { ActorCtx } from "../../types.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");
const SEED = process.env.PROPS_SEED ? Number(process.env.PROPS_SEED) : randomInt(1, 2 ** 31 - 1);
const RUNS = process.env.PROPS_RUNS ? Math.min(Number(process.env.PROPS_RUNS), 500) : 150;
const NOTES = 9;
const MAX_COMMANDS = 24;

type World = { ws: string; owner: ActorCtx; call: ReturnType<typeof makeCaller>; ids: string[] };
type Command =
  | { kind: "delete"; at: number }
  | { kind: "undo"; at: number }
  | { kind: "restore"; type: "NODE_DELETED" | "NODE_UNDELETED"; pick: number; cascade: boolean }
  | { kind: "twoInOneTransaction"; at: number }
  | { kind: "severalInOneTransaction"; steps: Array<{ trash: boolean; at: number }> }
  | { kind: "upgrade"; withoutStamps: boolean }
  | { kind: "purge"; at: number };

const command: fc.Arbitrary<Command> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant("delete" as const), at: fc.nat() }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("undo" as const), at: fc.nat() }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("restore" as const), type: fc.constantFrom("NODE_DELETED" as const, "NODE_UNDELETED" as const), pick: fc.nat(), cascade: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("twoInOneTransaction" as const), at: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("severalInOneTransaction" as const), steps: fc.array(fc.record({ trash: fc.boolean(), at: fc.nat() }), { minLength: 2, maxLength: 5 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("upgrade" as const), withoutStamps: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("purge" as const), at: fc.nat() }) },
);
/** Parent of note i (index into the same list, or null): drawn per run. */
const shape = fc.array(fc.option(fc.nat(), { nil: null, freq: 3 }), { minLength: NOTES, maxLength: NOTES });

async function build(parents: Array<number | null>): Promise<World> {
  const ws = await getWorkspaceId();
  const owner = await persistActor(ws, { id: "", name: "Owner", role: "admin", type: "human" });
  const space = await makeSpace(ws, `Together ${randomUUID().slice(0, 6)}`, [{ id: owner.id, permission: "edit" }]);
  const call = makeCaller(owner);
  const ids: string[] = [];
  for (let i = 0; i < parents.length; i++) {
    const p = parents[i];
    const parent = p === null || p === undefined || i === 0 ? undefined : ids[p % i];
    ids.push((await call("POST", "/api/nodes", { id: randomUUID(), title: `n${i} ${randomUUID().slice(0, 6)}`, markdown: `n${i}`, space_id: space, ...(parent ? { parent_id: parent } : {}) })).id);
  }
  return { ws, owner, call, ids };
}

const stateOf = async (w: World) => (await q<{ id: string; deleted: boolean; parent: string | null }>(
  `SELECT id::text, deleted_at IS NOT NULL AS deleted, parent_id::text AS parent FROM content_nodes WHERE id = ANY($1::uuid[])`, [w.ids])).rows;
/** Deleted notes that can be deleted for good: every note under them is deleted too (a live one makes purgeDeleted refuse, and the
 *  commands never ask for a refusal: every refusal but the pinned one below is a failure). */
const purgeable = async (w: World, gone: Array<{ id: string }>) => (await q<{ id: string }>(
  `WITH RECURSIVE below AS (SELECT n.id AS root, n.id FROM content_nodes n WHERE n.id = ANY($1::uuid[])
     UNION SELECT b.root, c.id FROM content_nodes c JOIN below b ON c.parent_id = b.id)
   SELECT r.id::text FROM content_nodes r WHERE r.id = ANY($1::uuid[])
      AND NOT EXISTS (SELECT 1 FROM below b JOIN content_nodes c ON c.id = b.id WHERE b.root = r.id AND c.deleted_at IS NULL)
    ORDER BY r.id`, [gone.map((g) => g.id)])).rows;

async function run(w: World, c: Command): Promise<void> {
  const rows = await stateOf(w);
  const live = rows.filter((r) => !r.deleted);
  const gone = rows.filter((r) => r.deleted);
  if (c.kind === "delete" && live.length) await w.call("DELETE", `/api/nodes/${live[c.at % live.length]!.id}`);
  if (c.kind === "undo" && gone.length) await w.call("POST", `/api/nodes/${gone[c.at % gone.length]!.id}/undelete`, {});
  if (c.kind === "purge") {
    const can = await purgeable(w, gone);
    if (can.length) await purgeDeleted(w.owner, w.ws, can[c.at % can.length]!.id);
  }
  if (c.kind === "restore") {
    const events = (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE workspace_id = $1 AND event_type = $2 AND target_id = ANY($3::text[]) ORDER BY domain_events.id`,
      [w.ws, c.type, w.ids])).rows;
    if (!events.length) return;
    const eventId = events[c.pick % events.length]!.id;
    await restoreEvent(eventId, { actor: w.owner, workspaceId: w.ws, cascade: c.cascade }).catch(async (error: unknown) => {
      // Found with seed 1571509623: the event of a note deleted for good throws AuthorityError instead of answering target_gone. Pinned by
      // the `it.fails` below; only that case passes here.
      if (error instanceof AuthorityError && await purgedTarget(w.ws, eventId, c.cascade)) return;
      throw error;
    });
  }
  if (c.kind === "severalInOneTransaction") {
    // each step: delete a live note, or bring a deleted one back (the undo toast's undeleteNode), all under one stamp
    await withTransaction(async () => {
      for (const step of c.steps) {
        const now = await stateOf(w);
        const pool = now.filter((r) => r.deleted !== step.trash);
        if (!pool.length) continue;
        const id = pool[step.at % pool.length]!.id;
        if (step.trash) await trashNode(w.owner, w.ws, id);
        else await undeleteNode(w.owner, w.ws, id);
      }
    });
  }
  if (c.kind === "upgrade") {
    // the trash as it is before this change: no groups (and, sometimes, no stamp on the deletes: before migration 190); then the migration
    if (c.withoutStamps) {
      await seedQ(`DELETE FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND field = 'deleted'
                    AND row_key = ANY($2::text[]) AND row_key IN (SELECT id::text FROM content_nodes WHERE deleted_at IS NOT NULL)`, [w.ws, w.ids]);
    }
    await seedQ(`DELETE FROM trash_groups`);
    await rerunMigration("230_trash_groups");
  }
  if (c.kind === "twoInOneTransaction") {
    // a live note with a live ancestor: the note first, then the ancestor, in one transaction
    const byId = new Map(rows.map((r) => [r.id, r]));
    const pairs = live.flatMap((r) => {
      const above: string[] = [];
      for (let p = r.parent; p && byId.get(p) && !byId.get(p)!.deleted; p = byId.get(p)!.parent) above.push(p);
      return above.map((a) => [r.id, a] as const);
    });
    if (pairs.length) {
      const [below, above] = pairs[c.at % pairs.length]!;
      await withTransaction(async () => { await trashNode(w.owner, w.ws, below); await trashNode(w.owner, w.ws, above); });
    }
  }
}

/** Whether the note the event is about no longer exists (deleted for good), or — only when the restore takes its cascade along — the note
 *  an event chained to it is about. Seed 589374866 found the cascade form of the same refusal. */
const purgedTarget = async (workspaceId: string, eventId: string, cascade: boolean): Promise<boolean> => (await q(
  `WITH RECURSIVE chain AS (SELECT e.id, e.target_id FROM domain_events e WHERE e.workspace_id = $1 AND e.id = $2::bigint
     UNION SELECT c.id, c.target_id FROM domain_events c JOIN chain ON c.triggered_by_event_id = chain.id WHERE c.workspace_id = $1 AND $3::boolean)
   SELECT 1 FROM chain WHERE NOT EXISTS (SELECT 1 FROM content_nodes n WHERE n.id::text = chain.target_id) LIMIT 1`,
  [workspaceId, eventId, cascade])).rows.length > 0;

describe.skipIf(!isTestDb)("deleted together: stamps and groups judge as the event chain did, on one node", () => {
  // FINDING (seed 1571509623, 2026-11-23; not this batch's code: services/eventRestore/restore.ts checks authority on the retained note before it
  // looks whether the note still exists): restoring the delete of a note deleted for good should answer target_gone (410), like every other
  // event of a gone note; it throws AuthorityError (403). With `cascade`, a chained event about such a note does the same (seed 589374866).
// Listed in spine/stampedMerge/README.md 「接上傳輸前必須完成」.
  it.fails("restoring the delete of a note deleted for good answers target_gone, not a refusal of access", async () => {
    const w = await build([null]);
    await w.call("DELETE", `/api/nodes/${w.ids[0]}`);
    await purgeDeleted(w.owner, w.ws, w.ids[0]!);
    const deleted = (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE workspace_id = $1 AND event_type = 'NODE_DELETED' AND target_id = $2`, [w.ws, w.ids[0]])).rows[0]!.id;
    expect(await restoreEvent(deleted, { actor: w.owner, workspaceId: w.ws })).toMatchObject({ code: "target_gone", status: 410 });
  });

  it(`random deletes and ways back (seed ${SEED})`, async () => {
    console.log(`[deletedTogether props] seed ${SEED}, ${RUNS} runs (replay: PROPS_SEED=${SEED} PROPS_RUNS=${RUNS})`);
    await fc.assert(fc.asyncProperty(shape, fc.array(command, { minLength: 1, maxLength: MAX_COMMANDS }), async (parents, commands) => {
      const w = await build(parents);
      for (const [step, c] of commands.entries()) {
        await run(w, c);
        for (const r of (await stateOf(w)).filter((row) => row.deleted)) {
          const plan = (await restorePlan(w.ws, r.id)).subtree.map((row) => row.id);
          expect(plan, `after command ${step} (${c.kind}), note ${w.ids.indexOf(r.id)}`).toEqual(await chainedTogether(w.ws, r.id));
        }
      }
    }), { seed: SEED, numRuns: RUNS });
  }, 1_800_000);
});
