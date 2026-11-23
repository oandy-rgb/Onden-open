// A credential whose actor has been removed answers exactly like a credential that never existed: 401, same body, same headers,
// so a response never tells that a token was once valid. Through the real assembled app (app.ts), one case per kind of request
// that resolves its actor through spine/currentActor.ts resolveCurrentActor:
//   - an agent token (ondt_) on an MCP tool, and on the MCP protocol endpoint
//   - an agent token on a plain /api/* route (refused before the route either way)
//   - a temporary session's credential (onds_) whose opener was removed, or that was ended
//   - a person's sign-in (cookie) after they were removed (not a token, but the same resolution: never a 500)
// SAFETY: only runs against a *_test database; skips otherwise.

import { CLIENT_PROTOCOL } from "@onden/markdown";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { q, pool } from "../db.js";
import { createToken } from "../services/agentTokens.js";
import { removeActor } from "../services/actors.js";
import { endTemporarySession } from "../services/participantSessions.js";
import { toolsForAccess } from "../services/agentTools/index.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { turnModuleOn } from "./helpers/setModulesOn.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { newNote, newPerson, openAs, standardWorld } from "./helpers/sessionWorld.js";

registerShippedModules();
const session = vi.hoisted(() => ({ workspaceId: "", signedInAs: null as string | null }));
vi.mock("../db.js", async (original) => ({
  ...await original<typeof import("../db.js")>(),
  getWorkspaceId: async () => session.workspaceId,
}));
vi.mock("../auth.js", () => ({
  auth: {
    handler: vi.fn(async () => new Response("noop", { status: 200 })),
    api: { getSession: vi.fn(async () => session.signedInAs ? { user: { id: session.signedInAs, name: "Person", email: `${session.signedInAs}@removed.test` } } : null) },
    $context: Promise.resolve({ runMigrations: async () => {} }),
  },
  configuredSocialProviders: [],
}));
const { app } = await import("../app.js");

type Answer = { status: number; body: string; headers: Array<[string, string]> };
type Req = { method: "GET" | "POST"; path: string; body?: unknown; accept?: string };
const MCP_SEARCH: Req = { method: "POST", path: "/api/mcp/tools/searchNodes", body: { args: { query: "x" } } };
const MCP_PROTOCOL: Req = { method: "POST", path: "/api/mcp/protocol", body: { jsonrpc: "2.0", id: 1, method: "tools/list" }, accept: "application/json, text/event-stream" };
let API_NODES: Req = { method: "GET", path: "/api/nodes" };

async function send(req: Req, auth: { bearer: string } | { cookie: string }): Promise<Answer> {
  session.signedInAs = "cookie" in auth ? auth.cookie : null;
  try {
    const res = await app.request(req.path, {
      method: req.method,
      headers: {
        "x-onden-client-protocol": String(CLIENT_PROTOCOL),
        ...("bearer" in auth ? { authorization: `Bearer ${auth.bearer}` } : {}),
        ...(req.body === undefined ? {} : { "content-type": "application/json" }),
        ...(req.accept ? { accept: req.accept } : {}),
      },
      ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
    });
    return { status: res.status, body: await res.text(), headers: [...res.headers.entries()].sort() };
  } finally { session.signedInAs = null; }
}
// A credential of the same shape that was never issued.
const neverIssuedToken = () => `ondt_${randomUUID().replaceAll("-", "")}never`;
const neverIssuedSession = () => `onds_${randomUUID().replaceAll("-", "")}never`;

describe.skipIf(!isTestDatabase())("a removed actor's credential answers like one that never existed", () => {
  let w: Awaited<ReturnType<typeof standardWorld>>;
  let noteA = "";
  let logged: string[] = [];
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeAll(async () => {
    w = await standardWorld("removed-credential");
    session.workspaceId = w.ws;
    await turnModuleOn(w.ws, "ai"); // the MCP tools run: before removal the token is answered by the tool, not by a missing module
    noteA = await newNote(w.ws, "note in A", w.spaceA);
    API_NODES = { method: "GET", path: `/api/nodes/${noteA}` };
    // What the server writes to its log while these requests run (item 4: no credential, no actor id).
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
    return { agent, token: token.plaintext };
  }

  /** Same status, body and headers as a never-issued credential, and nothing in the answer or the log names the credential or the actor. */
  async function expectSameAsNeverIssued(req: Req, removed: { bearer: string } | { cookie: string }, neverIssued: { bearer: string } | { cookie: string }, actorId: string) {
    logged = [];
    const after = await send(req, removed);
    const never = await send(req, neverIssued);
    expect(after.status).toBe(401);
    expect(after).toEqual(never);
    const secret = "bearer" in removed ? removed.bearer : removed.cookie;
    for (const text of [after.body, JSON.stringify(after.headers), ...logged]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(actorId);
    }
  }

  it("an agent token on an MCP tool, after the agent was removed (it had written before)", async () => {
    const { agent, token } = await agentWithToken();
    // As the e2e does: the agent works first, so its events and attributions remain after it is gone.
    expect((await send({ method: "POST", path: "/api/mcp/tools/updateNode", body: { args: { id: noteA, title: `by agent ${randomUUID()}` } } }, { bearer: token })).status).toBe(200);
    expect((await send(MCP_SEARCH, { bearer: token })).status).toBe(200);
    await removeActor(w.owner.ctx, agent);
    await expectSameAsNeverIssued(MCP_SEARCH, { bearer: token }, { bearer: neverIssuedToken() }, agent);
  });

  it("an agent token on the MCP protocol endpoint, after the agent was removed", async () => {
    const { agent, token } = await agentWithToken();
    expect((await send(MCP_PROTOCOL, { bearer: token })).status).toBe(200);
    await removeActor(w.owner.ctx, agent);
    await expectSameAsNeverIssued(MCP_PROTOCOL, { bearer: token }, { bearer: neverIssuedToken() }, agent);
  });

  it("an agent token on a plain /api/* route, after the agent was removed", async () => {
    const { agent, token } = await agentWithToken();
    expect((await send(API_NODES, { bearer: token })).status).toBe(403); // a live token is confined to /api/mcp (token_scope)
    await removeActor(w.owner.ctx, agent);
    await expectSameAsNeverIssued(API_NODES, { bearer: token }, { bearer: neverIssuedToken() }, agent);
  });

  it("a temporary session's credential, after the person who opened it was removed", async () => {
    // Only the owner opens sessions and the owner is never removed, so hand the workspace over first.
    const opener = await newPerson(w.ws, "Opener");
    await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'edit')`, [w.spaceA, opener.id]);
    await setWorkspaceOwner(w.ws, opener.id);
    const opened = await openAs(opener, w.ws, { spaces: [{ spaceId: w.spaceA, permission: "view" }] });
    await setWorkspaceOwner(w.ws, w.owner.id);
    expect((await send(API_NODES, { bearer: opened.credential })).status).toBe(200);
    await removeActor(w.owner.ctx, opener.id);
    await expectSameAsNeverIssued(API_NODES, { bearer: opened.credential }, { bearer: neverIssuedSession() }, opener.id);
  });

  it("a temporary session's credential, after the session was ended (a session is ended, never removed as a member)", async () => {
    const opened = await openAs(w.owner, w.ws, { spaces: [{ spaceId: w.spaceA, permission: "view" }] });
    const sessionActor = (await q<{ actor_id: string }>(`SELECT actor_id::text FROM participant_sessions WHERE id = $1`, [opened.sessionId])).rows[0]!.actor_id;
    expect((await send(API_NODES, { bearer: opened.credential })).status).toBe(200);
    await expect(removeActor(w.owner.ctx, sessionActor)).rejects.toMatchObject({ status: 409 });
    expect(await endTemporarySession(w.owner.ctx, w.ws, opened.sessionId)).toEqual({ ended: true });
    await expectSameAsNeverIssued(API_NODES, { bearer: opened.credential }, { bearer: neverIssuedSession() }, sessionActor);
  });

  it("a person's sign-in after they were removed is refused, never a 500", async () => {
    const person = await newPerson(w.ws, "Leaving");
    await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'edit')`, [w.spaceA, person.id]);
    expect((await send(API_NODES, { cookie: person.ext })).status).toBe(200);
    await removeActor(w.owner.ctx, person.id);
    const after = await send(API_NODES, { cookie: person.ext });
    expect(after.status).toBeGreaterThanOrEqual(400);
    expect(after.status).toBeLessThan(500);
  });
});
