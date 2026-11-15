// Real PostgreSQL: tag functions are registered by modules (mountModules), so the
// core never lists module ids. Unregistered ids are refused on write, and stored
// switches of an absent module survive other changes.
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import * as db from "../db.js";
import { apiOnError } from "../httpError.js";
import tagsRouter from "../routes/tags.js";
import { mountModules, type ModuleApp, type ModuleDefinition } from "../modules/index.js";
import { registeredFunctionIds as tagModuleIds } from "../services/functionRefs.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

registerShippedModules();

let workspaceId: string;
vi.mock("../db.js", async original => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
let owner: ActorCtx;

function patch(tagId: string, modules: unknown) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", owner); await next(); });
  app.route("/api/tags", tagsRouter);
  return app.request(`/api/tags/${tagId}/modules`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(modules),
  });
}
async function tagWithModules(modules: Record<string, unknown>): Promise<string> {
  const schema = { fields: [], views: {}, behaviour: { modules }, policy: {} };
  return (await seedQ<{ id: string }>(`INSERT INTO content_nodes(workspace_id,source_type,node_type,title,slug,markdown,tag_schema)
    VALUES($1,'manual','class_tag',$2,$3,'',$4::jsonb) RETURNING id`,
    [workspaceId, `fn-${randomUUID()}`, randomUUID(), JSON.stringify(schema)])).rows[0].id;
}
async function storedModules(tagId: string) {
  return (await db.q<{ modules: Record<string, { enabled?: boolean }> }>(
    "SELECT tag_schema->'behaviour'->'modules' AS modules FROM content_nodes WHERE id=$1", [tagId])).rows[0].modules;
}
async function heldFunctions(tagId: string) {
  return (await db.q<{ function_id: string }>("SELECT function_id FROM function_refs WHERE holder_node_id=$1 ORDER BY function_id", [tagId])).rows.map((r) => r.function_id);
}
async function eventCount(tagId: string) {
  return Number((await db.q<{ n: string }>("SELECT count(*)::text AS n FROM domain_events WHERE target_id=$1", [tagId])).rows[0].n);
}

describe("tag function registry (unit)", () => {
  it("lists the shipped tag functions without the core naming them", () => {
    expect(tagModuleIds()).toEqual(expect.arrayContaining(["skills"]));
  });

  it("mountModules registers a module that declares tagFunction", () => {
    const id = `probe-${randomUUID()}`;
    const probe: ModuleDefinition = { id, registerRoutes: () => {}, tagFunction: true };
    mountModules(new Hono() as unknown as ModuleApp, [probe]);
    expect(tagModuleIds()).toContain(id);
  });
});

describe.skipIf(!/_test\b/.test(process.env.DATABASE_URL ?? ""))("tag function registry (database)", () => {
  beforeAll(async () => {
    workspaceId = (await db.q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES('Tag functions',$1) RETURNING id", [randomUUID()])).rows[0].id;
    owner = await persistActor(workspaceId, { id: "fn-owner", name: "Owner", role: "admin", type: "human" });
  });
  afterAll(async () => { await seedQ("DELETE FROM content_nodes WHERE workspace_id=$1", [workspaceId]); });

  it("refuses an unregistered id without writing anything", async () => {
    const tag = await tagWithModules({});
    const res = await patch(tag, { skills: true, not_installed: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("not_installed") });
    expect(await storedModules(tag)).toEqual({});
    expect(await eventCount(tag)).toBe(0);
  });

  it("enables a function contributed by a newly mounted module", async () => {
    const id = `extra-${randomUUID()}`;
    mountModules(new Hono() as unknown as ModuleApp, [{ id, registerRoutes: () => {}, tagFunction: true }]);
    const tag = await tagWithModules({});
    expect((await patch(tag, { [id]: true })).status).toBe(200);
    expect(await heldFunctions(tag)).toEqual([id]); // a function reference now, not a behaviour switch
  });

  it("keeps the stored switch of a module that is not installed", async () => {
    const tag = await tagWithModules({ removed_module: { enabled: true, keep: "me" } });
    expect((await patch(tag, { skills: true })).status).toBe(200);
    // The old switch of the module that is not installed is left exactly as stored; the new one is a reference.
    expect(await storedModules(tag)).toEqual({ removed_module: { enabled: true, keep: "me" } });
    expect(await heldFunctions(tag)).toEqual(["skills"]);
  });
});
