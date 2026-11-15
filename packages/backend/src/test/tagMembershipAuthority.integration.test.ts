// Exercise the real REST/tool entrances and database. Only authentication is
// injected; actor rows, spaces, event ordering and rollback are real. Under
// the spaces model (docs/architecture/spaces.md) tagging a note needs edit
// permission in the note's space; tags themselves carry no permission.
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import * as db from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import { applyTag } from "../services/agentTools/applyTag.js";
import { removeTag } from "../services/agentTools/removeTag.js";
import { createToken, resolveBearerActor } from "../services/agentTokens.js";
import { seedClassTag, type SeedClassTagOpts } from "./helpers/seedClassTag.js";
import { adminOnlySpace, joinDefaultSpace, makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { AuthorityError } from "../spine/authority.js";
import { ScopeError } from "../spine/toolScope.js";
import type { ActorCtx } from "../types.js";
import { deleteWorkspaceActors } from "./helpers/setOwner.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { needsSecondConnection } from "./helpers/pgliteSkips.js";
import { seedQ } from "./helpers/seedQ.js";

let workspaceId: string;
// Injects a failure into the last synchronous step of a tag apply (the field
// defaults), to prove membership and success events roll back with it.
let failFieldDefaults = false;
vi.mock("../services/fieldDefaults.js", async original => {
  const real = await original<typeof import("../services/fieldDefaults.js")>();
  return { ...real, applyFieldDefaults: async (...args: Parameters<typeof real.applyFieldDefaults>) => {
    if (failFieldDefaults) throw new Error("tag membership injected failure");
    return real.applyFieldDefaults(...args);
  } };
});
vi.mock("../db.js", async original => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
type Surface = "REST" | "MCP";
type Operation = "apply" | "remove";

// An editor of the default space (membership is explicit since migration 097).
async function actor(): Promise<ActorCtx> {
  const result = await db.q<ActorCtx>(`INSERT INTO actors(workspace_id,name,type,external_id)
    VALUES($1,'Tag writer','human',$2) RETURNING id,name,type`, [workspaceId,randomUUID()]);
  await joinDefaultSpace(workspaceId, result.rows[0].id, "editor");
  return { ...result.rows[0] };
}
// A write token reaches its actor's space memberships: the human's own (the
// default space), or, when `onlySpaceIds` is given, an agent that is an editor
// of exactly those spaces (a token no longer carries a space list of its own).
async function delegated(onlySpaceIds: string[] | null = null): Promise<ActorCtx> {
  let holder: ActorCtx;
  if (onlySpaceIds === null) holder = await actor();
  else {
    const agent = await db.q<{ id: string }>(`INSERT INTO actors(workspace_id,name,type)
      VALUES($1,'Tag agent','agent') RETURNING id`, [workspaceId]);
    for (const spaceId of onlySpaceIds) {
      await db.q("INSERT INTO space_members(space_id,actor_id,permission) VALUES($1,$2,'edit')", [spaceId, agent.rows[0].id]);
    }
    holder = { id: agent.rows[0].id, name: "Tag agent", type: "agent" };
  }
  const issued = await createToken(holder.id, { access: "write" });
  return (await resolveBearerActor(issued.plaintext))!;
}
async function defaultSpace() {
  return (await db.q<{ id: string }>("SELECT id::text FROM spaces WHERE workspace_id=$1 AND is_default", [workspaceId])).rows[0].id;
}
/** Put `target` where `identity` may not do `restricted`: a space they are not
 *  in (read), or one where they are only a viewer (write_node). */
async function restrict(target: string, identity: ActorCtx, restricted: "read" | "write_node") {
  const space = restricted === "read"
    ? await adminOnlySpace(workspaceId, `hidden-${randomUUID()}`, [])
    : await makeSpace(workspaceId, `read-only-${randomUUID()}`, [{ id: identity.id, permission: "view" }]);
  await putInSpace(target, space);
}
async function tag(options: Omit<SeedClassTagOpts,"name"> = {}) {
  return (await seedClassTag(workspaceId, { name: `membership-${randomUUID()}`, ...options })).tagId;
}
async function node(tags: string[] = [], parentId: string | null = null) {
  const id = randomUUID();
  await seedQ(`INSERT INTO content_nodes(id,workspace_id,source_type,node_type,title,slug,markdown,parent_id)
    VALUES($1::uuid,$2,'manual','content','Membership test',($1::uuid)::text,'body',$3)`, [id,workspaceId,parentId]);
  for (const tagId of tags) await seedQ("INSERT INTO node_tags(node_id,tag_id) VALUES($1,$2)", [id,tagId]);
  return id;
}
async function invoke(surface: Surface, operation: Operation, identity: ActorCtx, nodeId: string, tagId: string, dryRun = false) {
  if (surface === "MCP") {
    try {
      const args = { nodeId, tagId }, ctx = { actor: identity, workspaceId, dryRun };
      const result = operation === "apply" ? await applyTag.handler(args, ctx) : await removeTag.handler(args, ctx);
      return { status: 200, result };
    } catch (error) {
      if (error instanceof AuthorityError || error instanceof ScopeError) return { status: 403, result: null };
      throw error;
    }
  }
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", identity); await next(); });
  app.route("/api/nodes", nodesRouter);
  const response = await app.request(`/api/nodes/${nodeId}/tags/${tagId}`, { method: operation === "apply" ? "PUT" : "DELETE" });
  return { status: response.status, result: await response.json() };
}
async function membership(nodeId: string, tagId: string) {
  return (await db.q("SELECT 1 FROM node_tags WHERE node_id=$1 AND tag_id=$2", [nodeId,tagId])).rows.length > 0;
}
async function events(nodeId: string) {
  return (await db.q<{ event_type: string; actor_id: string }>(`SELECT event_type,actor_id FROM domain_events
    WHERE workspace_id=$1 AND target_id=$2 ORDER BY id`, [workspaceId,nodeId])).rows;
}
async function waitForBlockedWriter() {
  const deadline = Date.now() + 5000;
  for (;;) {
    const blocked = await db.q(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
      AND wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock%'`);
    if (blocked.rows.length) return;
    if (Date.now() >= deadline) throw new Error("tag writer did not reach the event lock");
    await delay(10);
  }
}

describe.skipIf(!isTestDatabase())("tag membership authorization across REST and MCP", () => {
  beforeAll(async () => {
    workspaceId = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Tag membership authority',$1) RETURNING id", [randomUUID()])).rows[0].id;
  });
  afterAll(async () => {
    if (!workspaceId) return;
    await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [workspaceId]);
    await deleteWorkspaceActors(workspaceId);
  });

  for (const surface of ["REST","MCP"] as const) {
    for (const operation of ["apply","remove"] as const) for (const restricted of ["read","write_node"] as const) {
      it(`${surface} ${operation} respects the target space's ${restricted} rule before changing membership`, async () => {
        const targetTag = await tag();
        const target = await node(operation === "remove" ? [targetTag] : []);
        const identity = await actor();
        await restrict(target, identity, restricted);
        const response = await invoke(surface, operation, identity, target, targetTag);
        expect(response.status).toBe(403);
        expect(await membership(target,targetTag)).toBe(operation === "remove");
        expect(await events(target)).toEqual([]);
      });
    }
    it.skipIf(needsSecondConnection)(`${surface} duplicate apply/remove is a no-op and field defaults are seeded only once`, async () => {
      const capability = await tag({ fields: [{ name: "stage", type: "text", default: "first" }] });
      const target = await node(), identity = await actor();
      expect((await invoke(surface,"apply",identity,target,capability)).status).toBe(200);
      expect((await db.q("SELECT value FROM node_attributes WHERE node_id=$1 AND key='stage'", [target])).rows[0].value).toBe("first");
      await seedQ("UPDATE node_attributes SET value='newer input' WHERE node_id=$1 AND key='stage'", [target]);
      expect((await invoke(surface,"apply",identity,target,capability)).status).toBe(200);
      expect((await db.q("SELECT value FROM node_attributes WHERE node_id=$1 AND key='stage'", [target])).rows[0].value).toBe("newer input");
      expect((await events(target)).filter(row => row.event_type === "TAG_APPLIED")).toEqual([{ event_type: "TAG_APPLIED", actor_id: identity.id }]);
      expect((await invoke(surface,"remove",identity,target,capability)).status).toBe(200);
      expect((await invoke(surface,"remove",identity,target,capability)).status).toBe(200);
      expect((await events(target)).filter(row => row.event_type === "TAG_REMOVED")).toHaveLength(1);
    });
    for (const operation of ["apply","remove"] as const) {
      it.skipIf(needsSecondConnection)(`${surface} ${operation} rechecks space membership after waiting for the event lock`, async () => {
        const targetTag = await tag(), target = await node(operation === "remove" ? [targetTag] : []);
        const identity = await actor(), holder = await db.pool.connect();
        let pending: ReturnType<typeof invoke> | undefined;
        try {
          await holder.query("BEGIN");
          await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`event-append:${workspaceId}`]);
          pending = invoke(surface,operation,identity,target,targetTag);
          await waitForBlockedWriter();
          await holder.query("UPDATE space_members SET permission='view' WHERE space_id=$1 AND actor_id=$2", [await defaultSpace(),identity.id]);
          await holder.query("COMMIT");
          expect((await pending).status).toBe(403);
          expect(await membership(target,targetTag)).toBe(operation === "remove");
          expect(await events(target)).toEqual([]);
        } finally {
          await holder.query("ROLLBACK"); holder.release();
          await pending;
        }
      });
    }
    it.skipIf(needsSecondConnection)(`${surface} rolls back membership and success events when a later step fails`, async () => {
      const capability = await tag();
      const target = await node(), identity = await actor();
      failFieldDefaults = true;
      try {
        if (surface === "REST") expect((await invoke(surface,"apply",identity,target,capability)).status).toBe(500);
        else await expect(invoke(surface,"apply",identity,target,capability)).rejects.toThrow("tag membership injected failure");
      } finally { failFieldDefaults = false; }
      expect(await membership(target,capability)).toBe(false);
      expect(await events(target)).toEqual([]);
    });
  }

  it.skipIf(needsSecondConnection)("MCP preserves token enrollment of an untagged readable/writable note", async () => {
    const capability = await tag(), target = await node();
    expect((await invoke("MCP","apply",await delegated(),target,capability)).status).toBe(200);
    expect(await membership(target,capability)).toBe(true);
  });
  it.skipIf(needsSecondConnection)("MCP token enrollment does not reach a child of a note in a space the owner is not in", async () => {
    const capability = await tag();
    const parent = await node(), target = await node([],parent);
    await putInSpace(parent, await adminOnlySpace(workspaceId, `hidden-${randomUUID()}`, []));
    expect((await invoke("MCP","apply",await delegated(),target,capability)).status).toBe(403);
    expect(await membership(target,capability)).toBe(false);
    expect(await events(target)).toEqual([]);
  });
  it("MCP cannot use a task-local tag to bypass its token's write scope", async () => {
    const capability = await tag();
    const taskTag = (await seedClassTag(workspaceId,{ name: "task" })).tagId;
    const host = await node(), task = await node([taskTag,capability],host);
    await seedQ(`INSERT INTO node_attributes(workspace_id,node_id,key,value,value_type)
      VALUES($1,$2,'_task_status','todo','text')`, [workspaceId,task]);
    const elsewhere = await makeSpace(workspaceId, `elsewhere-${randomUUID()}`, []);
    expect((await invoke("MCP","remove",await delegated([elsewhere]),task,capability)).status).toBe(403);
    expect(await membership(task,capability)).toBe(true);
    expect(await events(task)).toEqual([]);
  });
  it("MCP dry-run rejects space violations and never creates membership or events", async () => {
    const capability = await tag();
    const allowed = await node(), denied = await node(), identity = await actor();
    await restrict(denied, identity, "write_node");
    expect((await invoke("MCP","apply",identity,allowed,capability,true)).status).toBe(200);
    expect((await invoke("MCP","apply",identity,denied,capability,true)).status).toBe(403);
    expect(await membership(allowed,capability)).toBe(false);
    expect(await membership(denied,capability)).toBe(false);
    expect(await events(allowed)).toEqual([]);
    expect(await events(denied)).toEqual([]);
  });
});
