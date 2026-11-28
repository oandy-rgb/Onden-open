// A system or background write must not resolve a conflict nobody has looked at (batch 2b-1, migration 206 sync_stamp_put_over; spine/eventTransaction.ts turns the database's
// refusal into the retryable `sync_unit_in_conflict`). A unit holds other heads once a merge has kept a write the node never saw (mergeUnitsIntoWorkspace is the test's way to make
// one). A person's write has seen every head and replaces them; a system job's write has seen only the head the unit shows, and a `saw` cannot say that.
// SAFETY: only runs against a *_test database; skips otherwise.
import { describe, expect, it, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { mutate } from "../spine/mutate.js";
import { withTransaction } from "../db.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { stampTransaction } from "../spine/stamps.js";
import { writesAsPerson } from "../spine/authority.js";
import { systemActorFor } from "../spine/systemJobs.js";
import { mergeUnitsIntoWorkspace } from "../spine/stampedImport.js";
import { readUnit } from "../spine/stampedMerge/dbUnits.js";
import { conflictsOf } from "../spine/stampedMerge/unit.js";
import { PermanentOutboxFailure, RETRY_DAY_ATTEMPTS } from "../services/outbox.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { makeCaller } from "./helpers/stampedWorld.js";
import { makeSpace } from "./helpers/spaceFixtures.js";

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));
const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

describe.skipIf(!isTestDb)("a system write beside a conflict", () => {
  const scheduler = systemActorFor("task-scheduler");
  let owner!: ActorCtx;
  let note = "";
  const heads = async () => (await q(`SELECT 1 FROM sync_stamp_heads WHERE workspace_id = $1 AND row_key = $2 AND field = 'title'`, [WS, note])).rows.length;
  const systemWrites = (title: string) => mutate({
    actor: scheduler, workspaceId: WS, authority: { kind: "system" },
    event: { type: "TASK_OCCURRENCE_MISSED", targetType: "node", targetId: note },
    apply: async () => { await q(`UPDATE content_nodes SET title = $2 WHERE id = $1`, [note, title]); },
  });

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('System conflict', $1) RETURNING id`, [`system-conflict-${Date.now()}`])).rows[0]!.id;
    owner = await persistActor(WS, { id: "", name: "Owner", role: "admin", type: "human" });
    await setModulesOn(WS, null);
    const space = await makeSpace(WS, `space ${Date.now()}`, [{ id: owner.id, permission: "edit" }]);
    note = (await makeCaller(owner)("POST", "/api/nodes", { id: randomUUID(), title: "Mine", markdown: "", space_id: space })).id;
  });

  it("is refused while the unit holds another head, with a retryable code, and changes nothing; a person's write resolves it; then the system may write", async () => {
    const merged = await mergeUnitsIntoWorkspace(WS, [{ address: { table: "content_nodes", row: note, field: "title" },
      unit: [{ stamp: { origin: "another-node", seq: 7, wall: Date.now(), counter: 0, author: null, device: null }, saw: {}, deleted: false, value: "Theirs" }] }]);
    expect(merged.events[0]?.result.outcome).toBe("conflict");
    expect(await heads()).toBe(1);
    const before = await readUnit(WS, { table: "content_nodes", row: note, field: "title" });

    await expect(systemWrites("recalculated")).rejects.toMatchObject({ status: 409, code: "sync_unit_in_conflict" });
    // B4, the retry limit: this batch adds none of its own. A refused job that runs from the outbox is an ordinary retryable failure (not a PermanentOutboxFailure), so it keeps the outbox's budget
    // (RETRY_DAY_ATTEMPTS attempts with backoff, about a day) and then lands among the dead rows the owner can see; a job that is not an outbox effect fails its request with the 409. The note that holds
    // the conflict is the place where a person decides; a screen that lists those notes is a later batch (needs 2b-2's conflict list).
    const refused = await systemWrites("recalculated").catch((e: unknown) => e);
    expect(refused).not.toBeInstanceOf(PermanentOutboxFailure);
    expect(RETRY_DAY_ATTEMPTS).toBe(35);
    expect(await heads()).toBe(1); // not cleared
    expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [note])).rows[0]!.title).toBe(before![0]!.value); // not written
    expect(conflictsOf((await readUnit(WS, { table: "content_nodes", row: note, field: "title" }))!)).toHaveLength(1);
    expect((await q(`SELECT 1 FROM domain_events WHERE workspace_id = $1 AND target_id = $2 AND event_type = 'TASK_OCCURRENCE_MISSED'`, [WS, note])).rows).toHaveLength(0); // no event of the refused write

    // an AI agent or a delegated token is not a person either: its write, stamped as such, is refused the same way (what a person accepted of its suggestion is the person's write)
    const asAi = () => withTransaction(() => withEventTransaction(WS, async () => {
      await stampTransaction(WS, owner.id, { notAPerson: true });
      await q(`UPDATE content_nodes SET title = 'proposed by an agent' WHERE id = $1`, [note]);
    }));
    await expect(asAi()).rejects.toMatchObject({ status: 409, code: "sync_unit_in_conflict" });
    expect(await heads()).toBe(1);
    const t = { access: "write", allowedTools: [], tokenId: "t" } as never;
    expect([writesAsPerson(owner), writesAsPerson({ ...owner, tokenScope: t }), writesAsPerson({ ...owner, type: "agent" }), writesAsPerson({ ...owner, type: "system" })]).toEqual([true, false, false, false]);

    // a write outside every root (no mutate, no stampTransaction: its stamp is the one sync_allocate_stamp makes, with no author) has not looked at the heads either:
    // refused the same way (migration 221; before, it settled the conflict as a person's write does: README "接上傳輸前必須完成", the trigger did not know who wrote)
    const other = (await makeCaller(owner)("POST", "/api/nodes", { id: randomUUID(), title: "Another", markdown: "", space_id: (await q<{ s: string }>(`SELECT space_id::text AS s FROM content_nodes WHERE id = $1`, [note])).rows[0]!.s })).id as string;
    const outside = () => withTransaction(() => withEventTransaction(WS, async () => { await q(`UPDATE content_nodes SET title = 'written outside the roots' WHERE id = $1`, [note]); }));
    await expect(outside()).rejects.toMatchObject({ status: 409, code: "sync_unit_in_conflict" });
    expect(await heads()).toBe(1);
    expect(conflictsOf((await readUnit(WS, { table: "content_nodes", row: note, field: "title" }))!)).toHaveLength(1);
    // a write outside the roots to a unit WITHOUT other heads is written as before (the same number allocated, the clock's count of such writes goes up)
    const count = async () => Number((await q<{ n: string }>(`SELECT writes_without_mutate::text AS n FROM sync_clock WHERE workspace_id = $1`, [WS])).rows[0]!.n);
    const n0 = await count();
    await withTransaction(() => withEventTransaction(WS, async () => { await q(`UPDATE content_nodes SET title = 'Another, outside the roots' WHERE id = $1`, [other]); }));
    expect(await count()).toBe(n0 + 1);
    expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [other])).rows[0]!.title).toBe("Another, outside the roots");
    // a person's root later in the transaction of such a write is the person's: from then the stamp is no system's, and the person's write settles the conflict
    await withTransaction(() => withEventTransaction(WS, async () => {
      await q(`UPDATE content_nodes SET title = 'Another, again' WHERE id = $1`, [other]);
      await stampTransaction(WS, owner.id, { system: false, notAPerson: false });
      await q(`UPDATE content_nodes SET title = 'Decided in the same transaction' WHERE id = $1`, [note]);
    }));
    expect(await heads()).toBe(0);

    await makeCaller(owner)("PATCH", `/api/nodes/${note}`, { title: "Decided by a person" }); // a person's ordinary save
    expect(await heads()).toBe(0);
    await systemWrites("recalculated"); // a unit without other heads: as before
    expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [note])).rows[0]!.title).toBe("recalculated");

    // migration 240 (review of PR #2024, round 1, point 5): a conflict is a head whose CONTENT differs (unit.ts conflictsOf); a head that says what the winner says (a
    // holder's re-send beside a row's creation, two nodes that wrote the same value) is none, so a system or AI write beside it is written. The control is the test above:
    // the same write beside a head with another value is refused.
    // (in this test: the file's ending skips it by name, helpers/stampedEndingExceptions.ts, as it merges units from no node)
    {
      const space = (await q<{ s: string }>(`SELECT space_id::text AS s FROM content_nodes WHERE id = $1`, [note])).rows[0]!.s;
      const mine = (await makeCaller(owner)("POST", "/api/nodes", { id: randomUUID(), title: "Same", markdown: "", space_id: space })).id as string;
      // an earlier clock reading than the note's creation: the head is kept beside the winner, not in its place (a winner's creation value equal to it would not be stored)
      const other = (s: number) => ({ origin: "another-node", seq: s, wall: 1_000, counter: 0, author: null, device: null });
      const merged = await mergeUnitsIntoWorkspace(WS, [{ address: { table: "content_nodes", row: mine, field: "title" }, unit: [{ stamp: other(70), saw: {}, deleted: false, value: "Same" }] }]);
      expect(merged.events.map((e) => e.result.outcome), "the same value: no conflict in the core").not.toContain("conflict");
      const titleHeads = async () => (await q(`SELECT 1 FROM sync_stamp_heads WHERE workspace_id = $1 AND row_key = $2 AND field = 'title'`, [WS, mine])).rows.length;
      expect(await titleHeads(), "the head is kept").toBe(1);
      expect(conflictsOf((await readUnit(WS, { table: "content_nodes", row: mine, field: "title" }))!)).toHaveLength(0);
      await mutate({ actor: scheduler, workspaceId: WS, authority: { kind: "system" }, event: { type: "TASK_OCCURRENCE_MISSED", targetType: "node", targetId: mine },
        apply: async () => { await q(`UPDATE content_nodes SET title = 'recalculated beside the same' WHERE id = $1`, [mine]); } });
      expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [mine])).rows[0]!.title).toBe("recalculated beside the same");
      expect(await titleHeads(), "the system's write had seen it").toBe(0);
      // a row's `*`: a second creation head (what a holder's re-send or a second maker of a derived id leaves), and a system write that deletes the row
      const tagged = (await makeCaller(owner)("POST", "/api/nodes", { id: randomUUID(), title: "Tagged", markdown: "", space_id: space })).id as string;
      const tag = (await makeCaller(owner)("POST", "/api/tags", { name: `same-${Date.now()}` })) as { id: string };
      await makeCaller(owner)("PUT", `/api/nodes/${tagged}/tags/${tag.id}`);
      const key = `${tagged}/${tag.id}`;
      await mergeUnitsIntoWorkspace(WS, [{ address: { table: "node_tags", row: key, field: "*" }, unit: [{ stamp: other(71), saw: {}, deleted: false, value: {}, meta: { resent: true } }] }]);
      const starHeads = async () => (await q(`SELECT 1 FROM sync_stamp_heads WHERE workspace_id = $1 AND table_name = 'node_tags' AND row_key = $2 AND field = '*'`, [WS, key])).rows.length;
      expect(await starHeads(), "the row's `*` holds a second head").toBe(1);
      await mutate({ actor: scheduler, workspaceId: WS, authority: { kind: "system" }, event: { type: "TASK_OCCURRENCE_MISSED", targetType: "node", targetId: tagged },
        apply: async () => { await q(`DELETE FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [tagged, tag.id]); } });
      expect((await q(`SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [tagged, tag.id])).rows, "the system removed the tag").toHaveLength(0);
      expect(await starHeads(), "its delete had seen both").toBe(0);
    }
  });
});
