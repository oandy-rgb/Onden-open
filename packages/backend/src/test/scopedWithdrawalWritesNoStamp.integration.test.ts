// Pins for docs/architecture/proposals/scoped-sync-2026-11-16.md §4 ("a withdrawal writes no stamp").
//
// A scoped device that stops carrying a space has to delete that space's rows locally. A plain DELETE goes through the stamp trigger,
// which writes a tombstone ('*' with deleted = true). That tombstone is a replicated write: it would travel to the full node and
// delete the notes for everyone. A withdrawal must therefore be a local drop that is not a write at all.
//
// What exists today, and is pinned by the first tests: the one switch with which the stamp triggers of a workspace stand aside
// (spine/stamps.ts standAsideForImport, reason "merge"). What does not exist: the withdrawal itself (`withdrawSpaces`), which is
// proposal §4's one path. Its test is an it.fails that imports the module the proposal names; when the step lands the import
// succeeds, the assertions become the real test, vitest reports the unexpected pass, and the step flips it to `it`.
// Not testable yet, and not faked here: that the per-scope `have` of sync_origins (PR #1758, not on main) forgets the space.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getWorkspaceId, pool, q } from "../db.js";
import type { ActorCtx } from "../types.js";
import { createNote } from "../services/noteCreate.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { standAsideForImport } from "../spine/stamps.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

describe.skipIf(!isTestDb)("dropping a space's rows locally (scoped sync, proposal §4)", () => {
  let ws = "";
  let owner!: ActorCtx;

  const newSpaceWithNotes = async (label: string) => {
    const space = await makeSpace(ws, `${label} ${Date.now()} ${randomUUID().slice(0, 6)}`, [{ id: owner.id, permission: "edit" }]);
    const note = (title: string) => createNote({ actor: owner, workspaceId: ws, title, markdown: "body", spaceId: space, event: { uiContext: "node.create" } });
    const a = await note(`${label} a`);
    const b = await note(`${label} b`);
    return { space, ids: [a.node.id, b.node.id] };
  };
  const clock = async () => (await q<{ next_seq: string; hlc_wall: string; hlc_counter: number }>(
    `SELECT next_seq::text, hlc_wall::text, hlc_counter FROM sync_clock WHERE workspace_id = $1`, [ws])).rows[0]!;
  const tombstones = async () => Number((await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM sync_stamps WHERE workspace_id = $1 AND deleted`, [ws])).rows[0]!.n);
  const stampsOf = async (ids: string[]) => Number((await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM (
       SELECT 1 FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = ANY($2::text[])
       UNION ALL SELECT 1 FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = 'content_nodes' AND row_key = ANY($2::text[])) x`, [ws, ids])).rows[0]!.n);
  const rowsOf = async (ids: string[]) => Number((await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM content_nodes WHERE id = ANY($1::uuid[])`, [ids])).rows[0]!.n);

  beforeAll(async () => {
    registerShippedModules();
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test', 'default') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`);
    ws = await getWorkspaceId();
    owner = await persistActor(ws, { id: "", name: "Withdrawal Owner", role: "admin", type: "human" });
  });
  afterAll(async () => { await pool.end(); });

  it("an ordinary hard delete of a note writes a tombstone: this is what a withdrawal must not do", async () => {
    const { ids } = await newSpaceWithNotes("ordinary");
    const before = await tombstones();
    await seedQ(`DELETE FROM content_nodes WHERE id = $1`, [ids[0]]);
    expect(await tombstones()).toBe(before + 1);
  });

  it("with the stand-aside switch a hard delete writes no tombstone and does not move the clock (the primitive the withdrawal uses)", async () => {
    const { ids } = await newSpaceWithNotes("aside");
    const tombstonesBefore = await tombstones();
    const clockBefore = await clock();
    await withEventTransaction(ws, async () => {
      await standAsideForImport(ws, "merge");
      await q(`DELETE FROM content_nodes WHERE id = ANY($1::uuid[])`, [ids]);
    });
    expect(await rowsOf(ids)).toBe(0);
    expect(await tombstones()).toBe(tombstonesBefore);
    const clockAfter = await clock();
    expect(clockAfter.next_seq).toBe(clockBefore.next_seq);
    expect(clockAfter.hlc_wall).toBe(clockBefore.hlc_wall);
    expect(clockAfter.hlc_counter).toBe(clockBefore.hlc_counter);
  });

  it("…but the switch alone leaves the dropped rows' own stamps behind: a withdrawal has to remove them too (proposal §4, the step after the switch)", async () => {
    const { ids } = await newSpaceWithNotes("leftover");
    expect(await stampsOf(ids)).toBeGreaterThan(0);
    await withEventTransaction(ws, async () => {
      await standAsideForImport(ws, "merge");
      await q(`DELETE FROM content_nodes WHERE id = ANY($1::uuid[])`, [ids]);
    });
    // Stamps of rows that are not there: a bundle reader would skip them silently while still claiming to have covered them
    // (the "chosen but not sent" gap of PR #1758 review A1-3). Pinned as today's behaviour; the withdrawal must make this 0.
    expect(await stampsOf(ids)).toBeGreaterThan(0);
  });

  it.fails("withdrawSpaces drops a space's rows and their stamps, writes no stamp and no tombstone, and does not move the clock (proposal §4; not built)", async () => {
    const kept = await newSpaceWithNotes("kept");
    const dropped = await newSpaceWithNotes("dropped");
    // The module the proposal names. Until it exists this import throws and the test "fails", which is what it.fails expects.
    const modulePath = "../spine/scopedWithdrawal.js";
    const { withdrawSpaces } = (await import(/* @vite-ignore */ modulePath)) as {
      withdrawSpaces(workspaceId: string, spaceIds: string[]): Promise<{ droppedRows: number }>;
    };
    const tombstonesBefore = await tombstones();
    const clockBefore = await clock();
    const keptStamps = await stampsOf(kept.ids);

    await withdrawSpaces(ws, [dropped.space]);

    expect(await rowsOf(dropped.ids)).toBe(0);
    expect(await stampsOf(dropped.ids)).toBe(0);
    expect(await rowsOf(kept.ids)).toBe(2);
    expect(await stampsOf(kept.ids)).toBe(keptStamps);
    expect(await tombstones()).toBe(tombstonesBefore);
    expect(await clock()).toEqual(clockBefore);
  });
});
