// A temporary session's `actors` row is kept for as long as anything names its id: the invariant that `neverLeaves` of space_members reads
// (spine/snapshotTables.json: "the member is an actor of type 'session'") and that services/authorName.ts takes as the evidence that an author was a
// session. A session is ENDED (services/participantSessions.ts), never removed: removeActor refuses it, and the one statement that deletes an actor
// excludes type 'session'; the database refuses it too (migration 217, tested below).
//
// Also verified here, not assumed: a delete by FOREIGN-KEY CASCADE (a removed member's space seats) writes tombstone stamps like a direct delete.
//
// SAFETY: only runs against a *_test database; skips otherwise. Each test makes its own workspace (shared database; tests run shuffled).
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { allowUnstampedWrite, pool, q, withTransaction } from "../db.js";
import { db } from "../dbKysely.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { newNote, newPerson, newWorkspace, openAs, standardWorld } from "./helpers/sessionWorld.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { deleteWorkspaceActors, setWorkspaceOwner } from "./helpers/setOwner.js";
import { seedQ } from "./helpers/seedQ.js";
import { removeActor } from "../services/actors.js";
import { endTemporarySession, resolveTemporarySessionActor } from "../services/participantSessions.js";
import { updateNode } from "../services/nodeUpdate.js";
import { stampMayLeaveSql } from "../spine/snapshotTables.js";

registerShippedModules();
let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
// removeActor ends a removed person's sign-in sessions through the auth library; nothing here signs in
vi.mock("../auth.js", () => ({ auth: { $context: Promise.resolve({ internalAdapter: { deleteUserSessions: async () => undefined } }) }, configuredSocialProviders: [] }));

/** The stamps of one space_members row (key "<space>/<actor>"), all of them and the ones a snapshot, a bundle or a digest may carry. */
async function membershipStamps(ws: string, spaceId: string, actorId: string): Promise<{ held: number; tombstones: number; mayLeave: number }> {
  const key = `${spaceId}/${actorId}`;
  const r = await q<{ held: string; tombstones: string; may_leave: string }>(
    `SELECT count(*)::text AS held, count(*) FILTER (WHERE s.deleted)::text AS tombstones, count(*) FILTER (WHERE ${stampMayLeaveSql("s")})::text AS may_leave
       FROM sync_stamps s WHERE s.workspace_id = $1 AND s.table_name = 'space_members' AND s.row_key = $2`, [ws, key]);
  return { held: Number(r.rows[0]!.held), tombstones: Number(r.rows[0]!.tombstones), mayLeave: Number(r.rows[0]!.may_leave) };
}
const actorRow = async (id: string) => (await q<{ type: string }>(`SELECT type FROM actors WHERE id = $1::uuid`, [id])).rows[0]?.type ?? null;

/** A world with a session the owner opened on space A, that wrote one note there and was ended. */
async function endedSession(label: string) {
  const w = await standardWorld(label);
  ownWorkspace = w.ws;
  const opened = await openAs(w.owner, w.ws, { spaces: [{ spaceId: w.spaceA, permission: "edit" }] });
  const session = (await resolveTemporarySessionActor(opened.credential, w.ws))!;
  const note = await newNote(w.ws, `${label} note`, w.spaceA, "first");
  await updateNode(w.ws, note, { markdown: "typed on a stranger's computer" }, { actor: session });
  await endTemporarySession(w.owner.ctx, w.ws, opened.sessionId);
  return { ...w, opened, session, note };
}

// one pool for the file: ended once, after both describes (guards/testFileTeardown.guard.test.ts)
afterAll(async () => { await pool.end(); });

describe.skipIf(!isTestDatabase())("a temporary session's actors row is kept", () => {

  it("removeActor refuses a session (409 session_not_removable): its row, its participant_sessions row and its history stay, and no ACTOR_DELETED is written", async () => {
    const w = await endedSession("keptRefused");
    await expect(removeActor(w.owner.ctx, w.session.id)).rejects.toMatchObject({ status: 409, body: { error: "session_not_removable" } });
    expect(await actorRow(w.session.id)).toBe("session");
    expect(Number((await q<{ n: string }>(`SELECT count(*)::text n FROM participant_sessions WHERE actor_id = $1::uuid`, [w.session.id])).rows[0]!.n)).toBe(1);
    expect(Number((await q<{ n: string }>(`SELECT count(*)::text n FROM domain_events WHERE workspace_id = $1 AND event_type = 'ACTOR_DELETED' AND target_id = $2`, [w.ws, w.session.id])).rows[0]!.n)).toBe(0);
    // its membership's tombstone (written when it was ended) is still held back
    expect(await membershipStamps(w.ws, w.spaceA, w.session.id)).toMatchObject({ tombstones: 1, mayLeave: 0 });
  });

  it("the person who opened it is removed: the session ends, its participant_sessions row goes with them (FK cascade), and its actors row stays, so its membership tombstone still never leaves", async () => {
    const w = await standardWorld("keptOpenerGone");
    ownWorkspace = w.ws;
    const opened = await openAs(w.owner, w.ws, { spaces: [{ spaceId: w.spaceA, permission: "edit" }] });
    const session = (await resolveTemporarySessionActor(opened.credential, w.ws))!;
    // the opener must be removable: hand the workspace to the member first (an owner is never removed)
    await setWorkspaceOwner(w.ws, w.member.id);
    await removeActor(w.member.ctx, w.owner.id);
    expect(await actorRow(w.owner.id)).toBeNull(); // control: the removal happened
    expect(await resolveTemporarySessionActor(opened.credential, w.ws)).toBeNull();
    expect(Number((await q<{ n: string }>(`SELECT count(*)::text n FROM participant_sessions WHERE actor_id = $1::uuid`, [session.id])).rows[0]!.n)).toBe(0);
    expect(await actorRow(session.id)).toBe("session");
    expect(await membershipStamps(w.ws, w.spaceA, session.id)).toMatchObject({ tombstones: 1, mayLeave: 0 });
  });

  it("a delete by foreign-key cascade writes tombstone stamps: a removed member's seat in a space leaves a deleted stamp, and it is one that may leave (a person's)", async () => {
    const w = await standardWorld("keptCascade");
    ownWorkspace = w.ws;
    const before = await membershipStamps(w.ws, w.spaceA, w.member.id);
    expect(before.tombstones).toBe(0);
    await removeActor(w.owner.ctx, w.member.id); // removeActor deletes the actors row; space_members goes by ON DELETE CASCADE
    expect(Number((await q<{ n: string }>(`SELECT count(*)::text n FROM space_members WHERE actor_id = $1::uuid`, [w.member.id])).rows[0]!.n)).toBe(0);
    expect(await membershipStamps(w.ws, w.spaceA, w.member.id)).toMatchObject({ tombstones: 1, mayLeave: 1 });
  });

  it("why the row must stay (what the rule depends on): the same tombstone, keyed to an id this node holds no row for, is one that may leave", async () => {
    const w = await endedSession("keptWhy");
    expect(await membershipStamps(w.ws, w.spaceA, w.session.id)).toMatchObject({ tombstones: 1, mayLeave: 0 });
    // The database refuses to delete the row (migration 217, even with triggers set to replica), so the dependency is shown on a copy of the stamp:
    // the session's tombstone, keyed to a fresh id that has no actors row (what the stamp would look like to the rule were the row gone).
    const gone = randomUUID();
    await seedQ(
      `INSERT INTO sync_stamps (workspace_id, table_name, row_key, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted)
       SELECT workspace_id, table_name, $3, field, origin, seq, hlc_wall, hlc_counter, author, device, deleted
         FROM sync_stamps WHERE workspace_id = $1 AND table_name = 'space_members' AND row_key = $2`,
      [w.ws, `${w.spaceA}/${w.session.id}`, `${w.spaceA}/${gone}`]);
    expect(await membershipStamps(w.ws, w.spaceA, gone)).toMatchObject({ tombstones: 1, mayLeave: 1 });
  });

  it("a person who is not a session is still removed as before (control)", async () => {
    const w = await standardWorld("keptPerson");
    ownWorkspace = w.ws;
    const other = await newPerson(w.ws, "Other");
    await removeActor(w.owner.ctx, other.id);
    expect(await actorRow(other.id)).toBeNull();
  });
});

/** What the database says to a statement that would take a session's row away: refused with SQLSTATE 23001 (migration 217). */
const refusedByTheDatabase = { code: "23001", message: expect.stringMatching(/temporary session's actors row/) }; // the message too: a RESTRICT foreign key shares the code
let spelling = 0;
const write = <T>(fn: () => Promise<T>) => allowUnstampedWrite("test: try to take a session's row", () => withTransaction(fn));

describe.skipIf(!isTestDatabase())("the database keeps a session's actors row (migration 217)", () => {

  // Every spelling the old text scan missed, and the one that looked like it excluded sessions but did not.
  it.each([
    ["DELETE FROM actors", (id: string) => [`DELETE FROM actors WHERE id = $1::uuid`, [id]]],
    ["DELETE FROM public.actors", (id: string) => [`DELETE FROM public.actors WHERE id = $1::uuid`, [id]]],
    ["DELETE FROM ONLY \"actors\"", (id: string) => [`DELETE FROM ONLY "actors" WHERE id = $1::uuid`, [id]]],
    ["an alias and a USING join", (id: string) => [`DELETE FROM actors a USING participant_sessions p WHERE p.actor_id = a.id AND a.id = $1::uuid`, [id]]],
    // reads as if it excluded sessions; the OR lets this one row through (kept to this row: on a shared database nothing else may be at stake)
    ["type <> 'session' OR …", (id: string) => [`DELETE FROM actors WHERE id = $1::uuid AND (type <> 'session' OR name IS NOT NULL)`, [id]]],
    ["a table name in a variable (EXECUTE format)", (id: string) => [`DO $$ BEGIN EXECUTE format('DELETE FROM %I WHERE id = %L', 'actors', '${id}'); END $$`, []]],
  ] as const)("refuses %s on a session's row, and the row stays", async (_how, statement) => {
    const w = await endedSession(`trigDel${++spelling}`);
    const [text, params] = statement(w.session.id) as [string, unknown[]];
    await expect(write(() => q(text, params))).rejects.toMatchObject(refusedByTheDatabase);
    expect(await actorRow(w.session.id)).toBe("session");
    expect(await membershipStamps(w.ws, w.spaceA, w.session.id)).toMatchObject({ tombstones: 1, mayLeave: 0 });
  });

  it("is not skipped by session_replication_role = replica (ENABLE ALWAYS), and a temporary table named workspaces does not stand in for the real one", async () => {
    const w = await endedSession("trigAlways");
    await expect(write(async () => {
      await q(`SET LOCAL session_replication_role = replica`);
      await q(`DELETE FROM actors WHERE id = $1::uuid`, [w.session.id]);
    })).rejects.toMatchObject(refusedByTheDatabase);
    await expect(write(async () => {
      await q(`CREATE TEMP TABLE workspaces (id uuid) ON COMMIT DROP`); // empty: an unqualified EXISTS would read it and let the delete through
      await q(`DELETE FROM actors WHERE id = $1::uuid`, [w.session.id]);
    })).rejects.toMatchObject(refusedByTheDatabase);
    expect(await actorRow(w.session.id)).toBe("session");
  });

  it("refuses a delete through the query builder (dbKysely, an aliased table)", async () => {
    const w = await endedSession("trigKysely");
    await expect(write(() => db.deleteFrom("actors as a").where("a.id", "=", w.session.id).execute())).rejects.toMatchObject(refusedByTheDatabase);
    expect(await actorRow(w.session.id)).toBe("session");
  });

  it("refuses changing a session's type, id or workspace, and making a person's row a session's", async () => {
    const w = await endedSession("trigUpdate");
    const other = await newWorkspace("trigUpdateOther");
    await expect(write(() => q(`UPDATE actors SET type = 'human' WHERE id = $1::uuid`, [w.session.id]))).rejects.toMatchObject(refusedByTheDatabase);
    await expect(write(() => q(`UPDATE actors SET id = gen_random_uuid() WHERE id = $1::uuid`, [w.session.id]))).rejects.toMatchObject(refusedByTheDatabase);
    await expect(write(() => q(`UPDATE actors SET workspace_id = $2::uuid WHERE id = $1::uuid`, [w.session.id, other]))).rejects.toMatchObject(refusedByTheDatabase);
    await expect(write(() => q(`UPDATE actors SET type = 'session' WHERE id = $1::uuid`, [w.member.id]))).rejects.toMatchObject(refusedByTheDatabase);
    expect(await actorRow(w.session.id)).toBe("session");
    expect(await actorRow(w.member.id)).toBe("human");
    // control: a session's row may still change what the rule does not read (its name), and a person's row is untouched by the trigger
    await write(() => q(`UPDATE actors SET name = name WHERE id = $1::uuid`, [w.session.id]));
    await write(() => q(`UPDATE actors SET name = name WHERE id = $1::uuid`, [w.member.id]));
  });

  it("the test teardown helper says so plainly for a world with a session (it cannot delete every actor there)", async () => {
    const w = await endedSession("trigHelper");
    await expect(deleteWorkspaceActors(w.ws)).rejects.toThrow(/temporary session row\(s\) in these workspaces; migration 217/);
    expect(await actorRow(w.session.id)).toBe("session");
    expect(await actorRow(w.owner.id)).toBe("human"); // nothing was deleted before the refusal
  });

  it("a person's row is deleted as before (control: the trigger only stands in front of a session's)", async () => {
    const w = await standardWorld("trigPerson");
    ownWorkspace = w.ws;
    const other = await newPerson(w.ws, "Other");
    await write(() => q(`DELETE FROM actors WHERE id = $1::uuid`, [other.id]));
    expect(await actorRow(other.id)).toBeNull();
  });

  it("deleting the person who opened it does not reach the session's row (no foreign key from it to the opener): the opener goes, the session's row stays", async () => {
    const w = await standardWorld("trigOpener");
    ownWorkspace = w.ws;
    const opened = await openAs(w.owner, w.ws, { spaces: [{ spaceId: w.spaceA, permission: "edit" }] });
    const session = (await resolveTemporarySessionActor(opened.credential, w.ws))!;
    await setWorkspaceOwner(w.ws, w.member.id); // an owner's row cannot be deleted (migration 128): hand the workspace over first
    await write(() => q(`DELETE FROM actors WHERE id = $1::uuid`, [w.owner.id])); // participant_sessions goes with the opener (opened_by cascades)
    expect(await actorRow(w.owner.id)).toBeNull();
    expect(await actorRow(session.id)).toBe("session");
    expect(Number((await q<{ n: string }>(`SELECT count(*)::text n FROM participant_sessions WHERE actor_id = $1::uuid`, [session.id])).rows[0]!.n)).toBe(0);
  });

  it("deleting the whole workspace takes the session's row with everything else (the one case it may go), and its stamps are deleted with it", async () => {
    // a workspace with no saved text (an event that carries text can never be deleted, so such a workspace is never deleted whole)
    const w = await standardWorld("trigWorkspace");
    ownWorkspace = w.ws;
    const opened = await openAs(w.owner, w.ws, { spaces: [{ spaceId: w.spaceA, permission: "edit" }] });
    const session = (await resolveTemporarySessionActor(opened.credential, w.ws))!;
    await endTemporarySession(w.owner.ctx, w.ws, opened.sessionId);
    expect(await membershipStamps(w.ws, w.spaceA, session.id)).toMatchObject({ tombstones: 1 });
    // the way spine/stampedImport.ts deletes a workspace: the events go only in a transaction that opts in (migration 051), then the stamps
    await write(async () => {
      await q(`SELECT set_config('myapp.allow_event_prune', 'on', true)`);
      await q(`DELETE FROM workspaces WHERE id = $1::uuid`, [w.ws]);
      await q(`DELETE FROM sync_stamps WHERE workspace_id = $1::uuid`, [w.ws]);
    });
    expect(await actorRow(session.id)).toBeNull();
    expect(Number((await q<{ n: string }>(`SELECT count(*)::text n FROM actors WHERE workspace_id = $1::uuid`, [w.ws])).rows[0]!.n)).toBe(0);
    expect(await membershipStamps(w.ws, w.spaceA, session.id)).toMatchObject({ held: 0 });
  });

  it("a TRUNCATE of actors is refused while a session's row exists (a statement trigger; read from the catalog, not run: it would empty a shared database were it missing)", async () => {
    const r = await q<{ n: string }>(
      `SELECT count(*)::text n FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgrelid = 'actors'::regclass AND NOT t.tgisinternal AND p.proname = 'actors_keep_session_row'
          AND (t.tgtype & 32) <> 0 AND (t.tgtype & 2) <> 0`); // TRIGGER_TYPE_TRUNCATE = 32, TRIGGER_TYPE_BEFORE = 2
    expect(Number(r.rows[0]!.n)).toBe(1);
  });
});
