// A write of a temporary session that is WAITING for the workspace lock when the session ends is refused when it gets the lock, and commits nothing.
// This is the real thing participantSessions.integration.test.ts builds without a second connection (it resolves the actor, ends the session, then writes with
// the old actor): here one connection holds the workspace lock, the session's PATCH queues behind it, the same connection ends the session and commits, and
// only then does the PATCH proceed.
//
// It needs two connections, which PGlite does not have: on PGlite the test is not REGISTERED (not skipped: nothing is counted as skipped, no skip list
// entry), and `npm run test:real-pg` runs it. realPostgresAlso: a second connection ends the session while a write waits for the workspace lock.
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, q } from "../db.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { newNote, openAs, standardWorld } from "./helpers/sessionWorld.js";
import { waitForEventLockWaiter } from "./helpers/eventLockWait.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { eventAppendLockKey } from "../spine/eventLock.js";

registerShippedModules();

let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
  configuredSocialProviders: [],
}));
const { app } = await import("../app.js");

const onPglite = process.env.ONDEN_DB_DRIVER === "pglite";

describe("a session ends while its write waits for the workspace lock", () => {
  it("is registered on real Postgres only (PGlite has one connection)", () => {
    expect(typeof onPglite).toBe("boolean");
  });

  if (!onPglite) {
    describe.skipIf(!isTestDatabase())("real Postgres", () => {
      let w: Awaited<ReturnType<typeof standardWorld>>;
      beforeAll(async () => {
        w = await standardWorld("sessionsLock");
        ownWorkspace = w.ws;
      });
      afterAll(async () => { await pool.end(); });

      // Tests are shuffled and each ends the session it opens: every test has its OWN note (a shared one made the result depend on which test ran first).
      /** The session's PATCH queues behind the workspace lock held by `blocker`; `endIt` runs on that same connection (what ends the session), then COMMIT. */
      async function waitingWriteThenEnd(endIt: (blocker: import("pg").PoolClient, s: Awaited<ReturnType<typeof openAs>>, actorId: string) => Promise<void>) {
        const note = await newNote(w.ws, "locked note", w.spaceA, "body");
        const s = await openAs(w.owner, w.ws, { spaces: [{ spaceId: w.spaceA, permission: "edit" }] });
        const actorId = (await q<{ actor_id: string }>(`SELECT actor_id::text FROM participant_sessions WHERE id = $1`, [s.sessionId])).rows[0]!.actor_id;
        const blocker = await pool.connect();
        let status = 0;
        try {
          await blocker.query("BEGIN");
          await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [eventAppendLockKey(w.ws)]);
          const pending = app.request(`/api/nodes/${note}`, {
            method: "PATCH",
            headers: { authorization: `Bearer ${s.credential}`, "content-type": "application/json" },
            body: JSON.stringify({ title: "written after the end", base_markdown: "body" }),
          });
          await waitForEventLockWaiter(blocker, w.ws);
          await endIt(blocker, s, actorId);
          await blocker.query("COMMIT");
          status = (await pending).status;
        } finally {
          blocker.release();
        }
        return { note, actorId, status };
      }

      it("the waiting write is refused (401) after the end commits; the note and the event log are as they were", async () => {
        const r = await waitingWriteThenEnd(async (blocker, s, actorId) => {
          // the end, on the connection that holds the lock: what endTemporarySession does, in its own transaction
          await blocker.query(`UPDATE participant_sessions SET ended_at = now() WHERE id = $1`, [s.sessionId]);
          await blocker.query(`DELETE FROM space_members WHERE actor_id = $1::uuid`, [actorId]);
        });
        expect(r.status).toBe(401);
        expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [r.note])).rows[0]!.title).toBe("locked note");
        expect((await q(`SELECT 1 FROM domain_events WHERE workspace_id = $1 AND actor_id = $2`, [w.ws, r.actorId])).rows).toEqual([]);
      });

      it("the same when the session EXPIRES (its time passes) while the write waits: refused, nothing written", async () => {
        const r = await waitingWriteThenEnd(async (blocker, s) => {
          await blocker.query(`UPDATE participant_sessions SET expires_at = now() WHERE id = $1`, [s.sessionId]);
        });
        expect(r.status).toBe(401);
        expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [r.note])).rows[0]!.title).toBe("locked note");
        expect((await q(`SELECT 1 FROM domain_events WHERE workspace_id = $1 AND actor_id = $2`, [w.ws, r.actorId])).rows).toEqual([]);
      });

      it("a write that took the lock first commits, and stays history after the end", async () => {
        const note = await newNote(w.ws, "locked note", w.spaceA, "body");
        const s = await openAs(w.owner, w.ws, { spaces: [{ spaceId: w.spaceA, permission: "edit" }] });
        const actorId = (await q<{ actor_id: string }>(`SELECT actor_id::text FROM participant_sessions WHERE id = $1`, [s.sessionId])).rows[0]!.actor_id;
        const res = await app.request(`/api/nodes/${note}`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${s.credential}`, "content-type": "application/json" },
          body: JSON.stringify({ title: "written before the end", base_markdown: "body" }),
        });
        expect(res.status).toBe(200);
        await q(`UPDATE participant_sessions SET ended_at = now() WHERE id = $1`, [s.sessionId]);
        expect((await q(`SELECT 1 FROM domain_events WHERE workspace_id = $1 AND actor_id = $2 AND event_type = 'NODE_UPDATED'`, [w.ws, actorId])).rows.length).toBe(1);
      });
    });
  }
});
