// TASK-07: assembled session HTTP, real spaces/DB and token resolution.
// A task takes its host note's space; "scope" is the host's space.
// Tokens remain MCP-only at the public boundary. Internal router tests exercise
// defense-in-depth token scope without granting a new public REST capability.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as db from "../db.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import tasksRouter, { addTaskUnderNote } from "../modules/tasks/routes.js";
import syncRouter from "../routes/sync.js";
import nodesRouter from "../routes/nodes.js";
import { withActorReadSnapshot } from "../services/actorReadSnapshot.js";
import { taskRowsForBootstrap } from "../services/tasksStore.js";
import { createToken, resolveBearerActor } from "../services/agentTokens.js";
import { canReadNode, canReadRetainedNode, readableNodeIdSet, readableScopeSql } from "../services/readPolicy.js";
import type { ActorCtx } from "../types.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { deleteWorkspaceActors } from "./helpers/setOwner.js";
import { seedQ } from "./helpers/seedQ.js";

let ws: string;
let sessionExternalId: string | null = null;
vi.mock("../db.js", async original => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
vi.mock("../auth.js", () => ({ auth: {
  handler: vi.fn(async () => new Response("unused")),
  api: { getSession: vi.fn(async () => sessionExternalId
    ? { user: { id: sessionExternalId, name: "Acceptance", email: "acceptance@task.test" } } : null) },
  $context: Promise.resolve({ runMigrations: async () => {} }),
} }));
const { app } = await import("../app.js");

// The database NAME decides (helpers/testDatabase), not '_test' text elsewhere in the URL.
describe.skipIf(!isTestDatabase())("TASK-07 task access follows the host's space", () => {
  let host: string, task: string, scope: string, otherScope: string, ownerExternal: string, ownerId: string;
  let actor: ActorCtx, external: string, bearer: string | undefined;

  function internalApp() {
    const internal = new Hono<{ Variables: { actor: ActorCtx | null } }>();
    internal.onError(apiOnError);
    internal.use("*", async (c, next) => { c.set("actor", actor); await next(); });
    internal.route("/api/tasks", tasksRouter);
    internal.post("/api/nodes/:id/tasks", addTaskUnderNote);
    internal.route("/api/sync", syncRouter);
    internal.route("/api/nodes", nodesRouter);
    // Bootstrap's task projection under the same current-actor snapshot. The
    // assembled bootstrap itself is separately covered by all session cases.
    internal.get("/api/bootstrap", async c => withActorReadSnapshot(actor, ws, async current =>
      c.json({ tasks: await taskRowsForBootstrap(ws, [...await readableNodeIdSet(current, ws)]), nodes: [] })));
    return internal;
  }
  async function request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    return (bearer ? internalApp() : app).request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async function read(path: string, body?: unknown) {
    const response = await request(path, body);
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  }
  /** human: the spaces the reader is in (null = both test spaces), with
   *  `permission` there. token: undefined = no token; an array = a write token
   *  of a separate agent that is an editor of exactly those spaces (a token
   *  reaches its actor's memberships, it carries no space list); "own" = a
   *  write token of the human reader, reaching the human's own spaces. */
  async function credentials(human: string[] | null, token: string[] | "own" | undefined, permission: "view" | "edit" = "edit") {
    await db.q("DELETE FROM space_members WHERE actor_id=$1", [actor.id]);
    for (const spaceId of human ?? [scope, otherScope]) {
      await db.q("INSERT INTO space_members(space_id,actor_id,permission) VALUES($1,$2,$3)", [spaceId, actor.id, permission]);
    }
    await db.bumpMembershipEpoch(ws);
    actor = { ...actor, tokenScope: undefined };
    bearer = undefined;
    sessionExternalId = external;
    if (token !== undefined) {
      let holder = actor.id;
      if (token !== "own") {
        holder = (await db.q<{ id: string }>("INSERT INTO actors(workspace_id,name,type) VALUES($1,'Task agent','agent') RETURNING id", [ws])).rows[0].id;
        for (const spaceId of token) {
          await db.q("INSERT INTO space_members(space_id,actor_id,permission) VALUES($1,$2,'edit')", [spaceId, holder]);
        }
        await db.bumpMembershipEpoch(ws);
      }
      const issued = await createToken(holder, { access: "write" });
      bearer = issued.plaintext;
      sessionExternalId = null;
      actor = (await resolveBearerActor(bearer))!;
      expect(actor).not.toBeNull();
    }
  }
  async function eventCount() {
    return Number((await db.q("SELECT count(*) AS n FROM domain_events WHERE workspace_id=$1", [ws])).rows[0].n);
  }
  const ids = (rows: Array<{ id: string }>) => rows.map(row => row.id);

  async function visibleEverywhere(visible: boolean) {
    const agenda = await read("/api/tasks/agenda");
    expect(ids(Object.values(agenda.buckets).flat() as Array<{ id: string }>).includes(task), "agenda").toBe(visible);
    const bootstrap = await read("/api/bootstrap");
    expect(ids(bootstrap.tasks).includes(task), "bootstrap").toBe(visible);
    expect(ids(bootstrap.nodes)).not.toContain(task);
    const delta = await read("/api/sync?since=0");
    expect(ids(delta.tasks.upsert).includes(task), "sync delta").toBe(visible);
    const byIds = await read("/api/sync/nodes", { ids: [host, task] });
    expect(ids(byIds.tasks).includes(task), "sync by ids").toBe(visible);
    const membership = await read("/api/sync/membership");
    expect(membership.ids.includes(task), "membership").toBe(visible);
    const single = await request(`/api/nodes/${task}`);
    // Unreadable reads as missing: no 403 that would confirm the id exists.
    expect(single.status, "node by id").toBe(visible ? 200 : 404);
    expect(await canReadNode(actor, task), "single policy").toBe(visible);
    expect((await readableNodeIdSet(actor, ws)).has(task), "read set").toBe(visible);
    const params: unknown[] = [task];
    const predicate = readableScopeSql(actor, "n", params);
    const selected = await db.q(`SELECT n.id FROM content_nodes n WHERE n.id=$1 AND ${predicate}`, params);
    expect(selected.rows.length, "SQL predicate").toBe(visible ? 1 : 0);
  }

  beforeAll(async () => {
    ws = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('驗收 TASK-07',$1) RETURNING id", [randomUUID()])).rows[0].id;
    ownerExternal = randomUUID();
    ownerId = (await db.q<{ id: string }>("INSERT INTO actors(workspace_id,name,type,external_id) VALUES($1,'Owner','human',$2) RETURNING id", [ws, ownerExternal])).rows[0].id;
  });
  beforeEach(async () => {
    bearer = undefined;
    sessionExternalId = ownerExternal;
    const caps = { publish: false, external_ai: true, backup: true };
    const owner = [{ id: ownerId, permission: "edit" as const }];
    scope = await makeSpace(ws, `scope-${randomUUID()}`, owner, caps);
    otherScope = await makeSpace(ws, `other-${randomUUID()}`, owner, caps);
    host = randomUUID();
    await seedQ(`INSERT INTO content_nodes(id,workspace_id,source_type,node_type,title,slug)
      VALUES($1::uuid,$2,'manual','content','Host',($1::uuid)::text)`, [host, ws]);
    await putInSpace(host, scope);
    const made = await request(`/api/nodes/${host}/tasks`, { title: "驗收 scoped task" });
    expect(made.status, await made.clone().text()).toBe(201);
    task = (await made.json()).id;
    external = randomUUID();
    actor = (await db.q<ActorCtx>(`INSERT INTO actors(workspace_id,name,type,external_id)
      VALUES($1,'Reader','human',$2) RETURNING id,name,type`, [ws, external])).rows[0];
  });

  afterAll(async () => {
    await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [ws]);
    await db.q("DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE workspace_id=$1)", [ws]);
    await db.q("DELETE FROM spaces WHERE workspace_id=$1", [ws]);
    await deleteWorkspaceActors(ws);
  });
  it("bearer credentials stay confined to MCP at the assembled public boundary", async () => {
    await credentials([scope], [scope]);
    for (const path of ["/api/tasks/agenda", "/api/bootstrap", "/api/sync", `/api/nodes/${task}`]) {
      const response = await app.request(path, { headers: { authorization: `Bearer ${bearer}` } });
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("token_scope");
    }
  });

  for (const mode of ["human", "agent token", "own token", "unscoped"] as const) {
    it(`${mode}: the host's space grants the same task on every read and PATCH`, async () => {
      await credentials(mode === "human" || mode === "own token" ? [scope] : null,
        mode === "agent token" ? [scope] : mode === "own token" ? "own" : undefined);
      await visibleEverywhere(true);
      const response = await request(`/api/tasks/${task}`, { title: "Updated scoped task" }, "PATCH");
      expect(response.status, await response.clone().text()).toBe(200);
      expect((await response.json()).title).toBe("Updated scoped task");
    });
  }
  for (const mode of ["empty human", "agent token in no space", "agent token in another space"] as const) {
    it(`${mode}: no read or write reaches a task outside the reader's spaces`, async () => {
      await credentials(mode === "empty human" ? [] : [scope],
        mode === "agent token in no space" ? [] : mode === "agent token in another space" ? [otherScope] : undefined);
      await visibleEverywhere(false);
      const before = await eventCount();
      const response = await request(`/api/tasks/${task}`, { title: "Forbidden" }, "PATCH");
      expect(response.status, await response.clone().text()).toBe(403);
      expect(await eventCount()).toBe(before);
      expect((await db.q("SELECT title FROM content_nodes WHERE id=$1", [task])).rows[0].title).toBe("驗收 scoped task");
    });
  }
  it("a task cannot sit in another space than its host", async () => {
    await expect(seedQ("UPDATE content_nodes SET space_id=$2 WHERE id=$1", [task, otherScope])).rejects.toThrow();
  });
  it("a viewer of the host's space reads the task but cannot change it", async () => {
    await credentials([scope], undefined, "view");
    await visibleEverywhere(true);
    const before = await eventCount();
    for (const body of [{ title: "Forbidden" }, { status: "done" }, { title: "驗收 scoped task" }, { status: "todo" }]) {
      expect((await request(`/api/tasks/${task}`, body, "PATCH")).status).toBe(403);
    }
    expect(await eventCount()).toBe(before);
  });
  it("leaving the host's space revokes the held task and rejects even a no-op PATCH", async () => {
    await credentials([scope], undefined);
    await visibleEverywhere(true);
    const start = await read("/api/sync/membership");
    await db.q("DELETE FROM space_members WHERE space_id=$1 AND actor_id=$2", [scope, actor.id]);
    await db.bumpMembershipEpoch(ws);
    await visibleEverywhere(false);
    const delta = await read("/api/sync", { since: 0, known: [host, task] });
    expect(delta.tasks.delete).toContain(task);
    const end = await read("/api/sync/membership");
    expect(Number(end.epoch)).toBeGreaterThan(Number(start.epoch));
    const before = await eventCount();
    expect((await request(`/api/tasks/${task}`, { status: "todo" }, "PATCH")).status).toBe(403);
    expect(await eventCount()).toBe(before);
  });
  it("an out-of-scope no-op PATCH cannot return the task or emit an event", async () => {
    await credentials([], undefined);
    const before = await eventCount();
    for (const body of [{ status: "todo" }, { title: "驗收 scoped task" }, { due_date: null }, { recur: null }]) {
      expect((await request(`/api/tasks/${task}`, body, "PATCH")).status).toBe(403);
    }
    expect(await eventCount()).toBe(before);
  });
  for (const scoped of [false, true]) {
    it(`a trashed host hides its live task, retaining history scope (scoped=${scoped})`, async () => {
      await credentials(scoped ? [scope] : null, undefined);
      await seedQ("UPDATE content_nodes SET deleted_at=now() WHERE id=$1", [host]);
      await visibleEverywhere(false);
      expect((await request(`/api/tasks/${task}`, { status: "todo" }, "PATCH")).status).toBe(403);
      expect(await canReadRetainedNode(actor, task)).toBe(true);
      if (scoped) {
        await db.q("DELETE FROM space_members WHERE space_id=$1 AND actor_id=$2", [scope, actor.id]);
        expect(await canReadRetainedNode(actor, task)).toBe(false);
      }
    });
  }
  it("moving the task under another host moves it to that host's space", async () => {
    await credentials([scope], undefined);
    await visibleEverywhere(true);
    const otherHost = (await seedQ<{ id: string }>(`INSERT INTO content_nodes(workspace_id,source_type,node_type,title,slug)
      VALUES($1,'manual','content','Other host',$2) RETURNING id`, [ws, randomUUID()])).rows[0].id;
    await putInSpace(otherHost, otherScope);
    await seedQ("UPDATE content_nodes SET parent_id=$2, space_id=$3 WHERE id=$1", [task, otherHost, otherScope]);
    await visibleEverywhere(false);
    await credentials([otherScope], undefined);
    await visibleEverywhere(true);
  });

  it("only the workspace owner gets example-seed eligibility for a truly empty projection", async () => {
    const originalWorkspace = ws;
    const emptyWorkspace = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('驗收 empty',$1) RETURNING id", [randomUUID()])).rows[0].id;
    const identity = randomUUID(), memberIdentity = randomUUID();
    // The first human of an ownerless workspace becomes its owner (trigger).
    const principal = (await db.q<{ id: string }>(`INSERT INTO actors(workspace_id,name,type,external_id)
      VALUES($1,'Owner','human',$2) RETURNING id`, [emptyWorkspace, identity])).rows[0].id;
    const member = (await db.q<{ id: string }>(`INSERT INTO actors(workspace_id,name,type,external_id)
      VALUES($1,'Member','human',$2) RETURNING id`, [emptyWorkspace, memberIdentity])).rows[0].id;
    expect((await db.q("SELECT 1 FROM workspaces WHERE id=$1 AND owner_actor_id=$2", [emptyWorkspace, principal])).rows).toHaveLength(1);
    ws = emptyWorkspace;
    bearer = undefined;
    try {
      sessionExternalId = identity;
      expect((await read("/api/bootstrap")).example_seed_eligible).toBe(true);
      // A member is not eligible whatever they may do in the default space.
      sessionExternalId = memberIdentity;
      for (const permission of ["edit", "view"] as const) {
        await db.q(`INSERT INTO space_members(space_id,actor_id,permission)
          SELECT id,$2,$3 FROM spaces WHERE workspace_id=$1 AND is_default
          ON CONFLICT (space_id,actor_id) DO UPDATE SET permission=EXCLUDED.permission`, [emptyWorkspace, member, permission]);
        expect((await read("/api/bootstrap")).example_seed_eligible, permission).toBe(false);
      }
      sessionExternalId = identity;
      await seedQ(`INSERT INTO content_nodes(workspace_id,source_type,node_type,title,slug)
        VALUES($1,'manual','content','Existing note',$2)`, [ws,randomUUID()]);
      expect((await read("/api/bootstrap")).example_seed_eligible).toBe(false);
    } finally {
      ws = originalWorkspace;
      await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [emptyWorkspace]);
      await db.q("DELETE FROM space_members WHERE space_id IN (SELECT id FROM spaces WHERE workspace_id=$1)", [emptyWorkspace]);
      await db.q("DELETE FROM spaces WHERE workspace_id=$1", [emptyWorkspace]);
      await deleteWorkspaceActors(emptyWorkspace);
    }
  });

});
