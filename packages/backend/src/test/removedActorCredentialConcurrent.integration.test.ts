// An agent is removed WHILE its token's request is in flight: the request authenticated (the removal had not committed), then its write
// (the tool call's audit record, or the tool's own write) queued on the workspace event lock behind the removal. When it gets the lock the
// actor is gone. That request must be answered exactly like a credential that never existed: 401, same body, same headers — never the
// database's refusal of an event for a missing actor (migration 071) surfacing as a 500. The sequential cases (actor removed, THEN the
// request) are in removedActorCredential.integration.test.ts; they were already 401 before this file existed, so a removal that has
// committed is refused at authentication (spine/currentActor.ts resolveCurrentActor joins the actor row; agent_tokens cascades with it).
//
// One connection holds BEGIN + the workspace event lock + DELETE FROM actors (what removeActor does inside mutate() for an agent that issued
// no tokens and opened no sessions) without committing; the token request goes through the real app on another connection; once it is seen
// waiting on that lock, the removal commits.
//
// It needs two connections, which PGlite does not have: on PGlite the test is not REGISTERED (not skipped: nothing is counted as skipped, no
// skip list entry), and `npm run test:real-pg` runs it:
// realPostgresAlso: a second connection removes the actor while the request waits for the workspace lock.
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { CLIENT_PROTOCOL } from "@onden/markdown";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { pool, q } from "../db.js";
import { createToken } from "../services/agentTokens.js";
import { toolsForAccess } from "../services/agentTools/index.js";
import { eventAppendLockKey } from "../spine/eventLock.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { waitForEventLockWaiter } from "./helpers/eventLockWait.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { turnModuleOn } from "./helpers/setModulesOn.js";
import { newNote, standardWorld } from "./helpers/sessionWorld.js";

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

type Answer = { status: number; body: string; headers: Array<[string, string]> };
async function answer(res: Response | Promise<Response>): Promise<Answer> {
  const r = await res;
  return { status: r.status, body: await r.text(), headers: [...r.headers.entries()].sort() };
}
function tool(name: string, args: unknown, bearer: string): Promise<Response> {
  return Promise.resolve(app.request(`/api/mcp/tools/${name}`, {
    method: "POST",
    headers: { "x-onden-client-protocol": String(CLIENT_PROTOCOL), authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ args }),
  }));
}
const neverIssuedToken = () => `ondt_${randomUUID().replaceAll("-", "")}never`;

describe("an agent is removed while its token's request waits for the workspace lock", () => {
  it("is registered on real Postgres only (PGlite has one connection)", () => {
    expect(typeof onPglite).toBe("boolean");
  });

  if (!onPglite) {
    describe.skipIf(!isTestDatabase())("real Postgres", () => {
      let w: Awaited<ReturnType<typeof standardWorld>>;
      let logged: string[] = [];
      const spies: Array<ReturnType<typeof vi.spyOn>> = [];
      beforeAll(async () => {
        w = await standardWorld("removedActorLock");
        ownWorkspace = w.ws;
        await turnModuleOn(w.ws, "ai");
        for (const level of ["log", "info", "warn", "error"] as const) {
          spies.push(vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); }));
        }
      });
      afterAll(async () => {
        for (const spy of spies) spy.mockRestore();
        await pool.end();
      });

      async function agentWithToken() {
        const agent = (await q<{ id: string }>(`INSERT INTO actors (workspace_id, name, type) VALUES ($1, $2, 'agent') RETURNING id::text`, [w.ws, `agent-${randomUUID()}`])).rows[0]!.id;
        await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'edit')`, [w.spaceA, agent]);
        const token = await createToken(agent, { access: "write", allowedTools: toolsForAccess("write") });
        return { agent, token: token.plaintext, tokenId: token.id };
      }

      /** `send` is started while `blocker` holds the event lock and has deleted the agent (not committed); once the request waits on that
       *  lock, the removal commits. Returns the request's answer and a never-issued token's answer to the same request. */
      async function removedWhileWaiting(send: (bearer: string) => Promise<Response>) {
        const { agent, token, tokenId } = await agentWithToken();
        expect((await send(token)).status).toBe(200); // the token works before the removal
        const eventsBefore = (await q<{ n: string }>(`SELECT count(*)::text AS n FROM domain_events WHERE workspace_id = $1`, [w.ws])).rows[0]!.n;
        logged = [];
        const blocker = await pool.connect();
        let during: Answer;
        try {
          await blocker.query("BEGIN");
          await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [eventAppendLockKey(w.ws)]);
          await blocker.query(`DELETE FROM actors WHERE workspace_id = $1 AND id = $2`, [w.ws, agent]);
          const pending = answer(send(token));
          await waitForEventLockWaiter(blocker, w.ws);
          await blocker.query("COMMIT");
          during = await pending;
        } finally {
          blocker.release();
        }
        const never = await answer(send(neverIssuedToken()));
        const eventsAfter = (await q<{ n: string }>(`SELECT count(*)::text AS n FROM domain_events WHERE workspace_id = $1`, [w.ws])).rows[0]!.n;
        return { agent, token, tokenId, during, never, eventsBefore, eventsAfter, logged: [...logged] };
      }

      function expectSameAsNeverIssued(r: Awaited<ReturnType<typeof removedWhileWaiting>>) {
        expect(r.during.status).toBe(401);
        expect(r.during).toEqual(r.never);
        for (const text of [r.during.body, JSON.stringify(r.during.headers), ...logged]) {
          expect(text).not.toContain(r.token);
          expect(text).not.toContain(r.agent);
        }
        // Nothing was recorded for the request that lost its actor (the removal itself was raw SQL here, so it adds no event).
        expect(r.eventsAfter).toBe(r.eventsBefore);
        // One line for the owner (httpError.ts logActorGone): the removed party's last attempt, by token id and route, with the 401. The
        // never-issued token's request was refused at sign-in and writes none.
        const gone = r.logged.filter((line) => line.includes("[auth]") && line.includes("gone since this request signed in"));
        expect(gone).toHaveLength(1);
        expect(gone[0]).toContain(r.tokenId);
        expect(gone[0]).toContain("401");
      }

      it("a read tool (searchNodes): its audit record waits for the lock, and the request is refused like a never-issued token", async () => {
        expectSameAsNeverIssued(await removedWhileWaiting((bearer) => tool("searchNodes", { query: "x" }, bearer)));
      });

      it("a write tool (updateNode): its write waits for the lock, and the request is refused like a never-issued token; the note is unchanged", async () => {
        const note = await newNote(w.ws, "untouched", w.spaceA, "body");
        let n = 0;
        const r = await removedWhileWaiting((bearer) => tool("updateNode", { id: note, title: `by agent ${++n}`, base_markdown: "body" }, bearer));
        expectSameAsNeverIssued(r);
        // The write before the removal stands; the one that waited did not commit.
        expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [note])).rows[0]!.title).toBe("by agent 1");
      });
    });
  }
});
