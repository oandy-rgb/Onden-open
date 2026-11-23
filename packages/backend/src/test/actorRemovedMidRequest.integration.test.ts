// An agent (or a person) is removed through the real removal — the owner's DELETE /api/actors/:id, services/actors.ts removeActor — WHILE
// a request signed in as them is running. Every entry must answer that request like a credential that never existed: 401
// `{ error: "unauthorized" }`, never a 500 (the database refusing an event for a missing actor, migration 071) and never a 200 that
// carries a "something went wrong" tool error (the MCP protocol endpoint). This is what the full-stack TOKEN-01 spec saw on main
// (zzDeepToken01.spec.ts:45, `expected 401, received 500`, the server log naming callTool's audit write).
//
// The interleaving is fixed, not timed: one connection holds the workspace event lock; the owner's removal is started and seen queued on
// that lock; then the agent's request is started — it signs in (the removal has not committed) and its first write queues behind the
// removal; the lock is released; Postgres grants it in the order asked, so the removal commits first and the request's write finds the
// actor gone. Two connections: real Postgres only (on PGlite that part is not registered), `npm run test:real-pg` runs it:
// realPostgresAlso: the owner's real removal commits while the agent's request waits for the workspace lock behind it.
//
// The boundary's own rule (spine/currentActor.ts actorGoneDuring, used by httpError.ts apiOnError) is also tested on its own, on both
// drivers: a step that trips over the vanished identity is a 401; the same failure for an identity that still resolves stays a 500.
//
// SAFETY: only runs against a *_test database; skips otherwise.
import { CLIENT_PROTOCOL } from "@onden/markdown";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { event, pool, q } from "../db.js";
import { apiOnError } from "../httpError.js";
import { createToken } from "../services/agentTokens.js";
import { toolsForAccess } from "../services/agentTools/index.js";
import { eventAppendLockKey } from "../spine/eventLock.js";
import type { ActorCtx } from "../types.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { waitForEventLockWaiter } from "./helpers/eventLockWait.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { turnModuleOn } from "./helpers/setModulesOn.js";
import { newNote, newPerson, standardWorld } from "./helpers/sessionWorld.js";

registerShippedModules();

const world = vi.hoisted(() => ({ ws: "" }));
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => world.ws }));
// A cookie sign-in is the header below: two requests in flight at once sign in as different people.
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: {
      getSession: vi.fn(async ({ headers }: { headers: Headers }) => {
        const ext = headers.get("x-test-signed-in-as");
        return ext ? { user: { id: ext, name: "Person", email: `${ext}@mid-request.test` } } : null;
      }),
    },
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
type Who = { bearer: string } | { cookie: string };
function send(method: string, path: string, who: Who, body?: unknown, accept?: string): Promise<Response> {
  return Promise.resolve(app.request(path, {
    method,
    headers: {
      "x-onden-client-protocol": String(CLIENT_PROTOCOL),
      ...("bearer" in who ? { authorization: `Bearer ${who.bearer}` } : { "x-test-signed-in-as": who.cookie }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(accept ? { accept } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}
const restTool = (name: string, args: unknown) => (who: Who) => send("POST", `/api/mcp/tools/${name}`, who, { args });
const protocolTool = (name: string, args: unknown) => (who: Who) => send("POST", "/api/mcp/protocol", who,
  { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, "application/json, text/event-stream");
const neverIssuedToken = () => `ondt_${randomUUID().replaceAll("-", "")}never`;

let logged: string[] = [];
const spies: Array<ReturnType<typeof vi.spyOn>> = [];
let w: Awaited<ReturnType<typeof standardWorld>>;

describe.skipIf(!isTestDatabase())("a request whose actor is removed while it runs", () => {
  beforeAll(async () => {
    w = await standardWorld("removedMidRequest");
    world.ws = w.ws;
    await turnModuleOn(w.ws, "ai");
    for (const level of ["log", "info", "warn", "error"] as const) {
      spies.push(vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); }));
    }
  });
  afterAll(async () => {
    for (const spy of spies) spy.mockRestore();
    await pool.end();
  });

  describe("the boundary decides by the identity's current state (actorGoneDuring)", () => {
    /** A route that, as `actor`, runs `step` — a write that trips over a database check — answered by the app's own error boundary. */
    function routeAs(actor: ActorCtx, step: () => Promise<unknown>) {
      const testApp = new Hono<{ Variables: { actor: ActorCtx | null } }>();
      testApp.use("*", async (c, next) => { c.set("actor", actor); await next(); });
      testApp.post("/step", async (c) => { await step(); return c.json({ ok: true }); });
      testApp.onError(apiOnError);
      return answer(testApp.request("/step", { method: "POST" }));
    }

    it("an event signed by an actor removed mid-request is a 401 like a never-issued credential, logged without the actor's id", async () => {
      const person = await newPerson(w.ws, `gone-${randomUUID()}`);
      logged = [];
      const res = await routeAs(person.ctx, async () => {
        await q(`DELETE FROM actors WHERE workspace_id = $1 AND id = $2`, [w.ws, person.id]); // the removal, committed in between
        await event(w.ws, "NODE_UPDATED", "node", randomUUID(), {}, "user", person.id); // the database's actor check refuses it
      });
      expect(res.status).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ error: "unauthorized" });
      expect(logged.some((line) => line.includes("[unhandled]"))).toBe(false);
      for (const line of logged) expect(line).not.toContain(person.id);
      expect(logged.filter((line) => line.includes("gone since this request signed in"))).toHaveLength(1);
    });

    it("the same database refusal for a request whose identity still resolves stays a 500", async () => {
      const person = await newPerson(w.ws, `live-${randomUUID()}`);
      logged = [];
      const res = await routeAs(person.ctx, () => event(w.ws, "NODE_UPDATED", "node", randomUUID(), {}, "user", randomUUID()));
      expect(res.status).toBe(500);
      expect(logged.some((line) => line.includes("[unhandled]"))).toBe(true);
    });
  });

  if (!onPglite) {
    describe("the owner's real removal commits while the request waits behind it (two connections)", () => {
      async function agentWithToken() {
        const agent = (await q<{ id: string }>(`INSERT INTO actors (workspace_id, name, type) VALUES ($1, $2, 'agent') RETURNING id::text`, [w.ws, `agent-${randomUUID()}`])).rows[0]!.id;
        await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'edit')`, [w.spaceA, agent]);
        const token = await createToken(agent, { access: "write", allowedTools: toolsForAccess("write") });
        return { agent, token: token.plaintext, tokenId: token.id };
      }
      const toolEvents = async (actorId: string) => Number((await q<{ n: string }>(
        `SELECT count(*)::text AS n FROM domain_events WHERE workspace_id = $1 AND actor_id = $2 AND event_type LIKE 'AGENT_TOOL_%'`, [w.ws, actorId])).rows[0]!.n);

      /** The owner removes `actorId` through DELETE /api/actors/:id; `request` is started once that removal waits on the event lock, and the
       *  lock is let go once the request waits behind the removal. */
      async function removedMidRequest(actorId: string, request: () => Promise<Response>) {
        const blocker = await pool.connect();
        try {
          await blocker.query("BEGIN");
          await blocker.query("SELECT pg_advisory_xact_lock(hashtext($1))", [eventAppendLockKey(w.ws)]);
          const removal = answer(send("DELETE", `/api/actors/${actorId}`, { cookie: w.owner.ext }));
          await waitForEventLockWaiter(blocker, w.ws, 500, 1);
          const during = answer(request());
          await waitForEventLockWaiter(blocker, w.ws, 500, 2);
          await blocker.query("COMMIT");
          return { removal: await removal, during: await during };
        } finally {
          blocker.release();
        }
      }

      /** The tool request through `entry`, before and during the removal; `during` must equal a never-issued token's answer. */
      async function agentRemovedDuring(entry: (who: Who) => Promise<Response>) {
        const { agent, token, tokenId } = await agentWithToken();
        expect((await send("POST", "/api/mcp/tools/searchNodes", { bearer: token }, { args: { query: "x" } })).status).toBe(200);
        const auditedBefore = await toolEvents(agent);
        logged = [];
        const { removal, during } = await removedMidRequest(agent, () => entry({ bearer: token }));
        const loggedDuring = [...logged];
        const never = await answer(entry({ bearer: neverIssuedToken() }));
        expect(removal.status).toBe(200);
        expect(during.status).toBe(401);
        expect(during).toEqual(never);
        // Nothing recorded for the request that lost its actor; nothing in the answer or the log names the token or the actor.
        expect(await toolEvents(agent)).toBe(auditedBefore);
        for (const text of [during.body, JSON.stringify(during.headers), ...loggedDuring]) {
          expect(text).not.toContain(token);
          expect(text).not.toContain(agent);
        }
        const gone = loggedDuring.filter((line) => line.includes("[auth]") && line.includes("gone since this request signed in"));
        expect(gone).toHaveLength(1);
        expect(gone[0]).toContain(tokenId);
        return { agent };
      }

      it("REST tools, a read (searchNodes): its audit record waits behind the removal; 401, not 500", async () => {
        await agentRemovedDuring(restTool("searchNodes", { query: "x" }));
      });

      it("REST tools, a write (updateNode): its write waits behind the removal; 401, and the note is unchanged", async () => {
        const note = await newNote(w.ws, "before", w.spaceA, "body");
        await agentRemovedDuring(restTool("updateNode", { id: note, title: "by the removed agent", base_markdown: "body" }));
        expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [note])).rows[0]!.title).toBe("before");
      });

      it("the MCP protocol endpoint, tools/call: 401 like a never-issued token, not a 200 carrying a server-error tool result", async () => {
        await agentRemovedDuring(protocolTool("searchNodes", { query: "x" }));
      });

      it("a person's own write (PATCH /api/nodes/:id) while the owner removes them: 401, and the note is unchanged", async () => {
        const person = await newPerson(w.ws, `member-${randomUUID()}`);
        await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'edit')`, [w.spaceA, person.id]);
        const note = await newNote(w.ws, "before", w.spaceA, "body");
        logged = [];
        const { removal, during } = await removedMidRequest(person.id, () => send("PATCH", `/api/nodes/${note}`, { cookie: person.ext }, { title: "by the removed person" }));
        expect(removal.status).toBe(200);
        expect(during.status).toBe(401);
        expect(JSON.parse(during.body)).toEqual({ error: "unauthorized" });
        expect(logged.some((line) => line.includes("[unhandled]"))).toBe(false);
        expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [note])).rows[0]!.title).toBe("before");
      });
    });
  }
});
