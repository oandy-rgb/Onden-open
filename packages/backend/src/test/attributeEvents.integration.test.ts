// Every attribute change is an event (services/attributeChange.ts, W28):
//   * `status:: done` typed in a body, and a frontmatter value, reach another
//     device's sync delta and undo from history (they were raw INSERTs);
//   * a child:* copy is an ATTRIBUTE_SET too.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import syncRouter from "../routes/sync.js";
import { restoreEvent } from "../services/eventRestore/index.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);
let workspaceId = "";
let actor: ActorCtx = { id: "attr-events-admin", name: "Attr events", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/nodes", nodesRouter);
app.route("/sync", syncRouter);
const send = (url: string, method: string, body: unknown = {}) => app.request(url, {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

const create = async (body: Record<string, unknown>) => {
  const res = await send("/nodes", "POST", body);
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
};
const attr = async (id: string, key: string) => (await q<{ value: string; source: string; is_inheritable: boolean }>(
  `SELECT value, source, is_inheritable FROM node_attributes WHERE node_id = $1 AND key = $2`, [id, key])).rows[0];
const attrEvent = async (id: string, key: string) => (await q<{ id: string; event_type: string }>(
  `SELECT id::text, event_type FROM domain_events
    WHERE target_id = $1 AND event_type IN ('ATTRIBUTE_SET','ATTRIBUTE_DELETED') AND payload->>'key' = $2
    ORDER BY domain_events.id DESC LIMIT 1`, [id, key])).rows[0];
const cursor = async () => Number((await q<{ c: string }>(
  `SELECT coalesce(max(id),0)::text AS c FROM domain_events WHERE workspace_id = $1`, [workspaceId])).rows[0]!.c);
const syncedAttributes = async (since: number) =>
  ((await (await app.request(`/sync?since=${since}`)).json()) as { attributes: { upsert: Array<{ node_id: string; key: string; value: string }> } })
    .attributes.upsert;

describe.skipIf(!isTestDb)("every attribute change is an event (DB)", () => {
  beforeAll(async () => {
    registerShippedModules();
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Attr events',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
  });

  it("an inline value typed in a body syncs to other devices and undoes", async () => {
    const id = await create({ title: `Plan ${randomUUID().slice(0, 6)}`, markdown: "start" });
    const since = await cursor();
    expect((await send(`/nodes/${id}`, "PATCH", { markdown: "start\nstatus:: done" })).status).toBe(200);
    // Inline values are derived after the edit commits.
    await expect.poll(async () => (await attr(id, "status"))?.value, { timeout: 5000 }).toBe("done");
    expect((await attr(id, "status"))!.source).toBe("markdown");
    expect(await syncedAttributes(since)).toContainEqual(expect.objectContaining({ node_id: id, key: "status", value: "done" }));

    const set = (await attrEvent(id, "status"))!;
    expect(set.event_type).toBe("ATTRIBUTE_SET");
    expect(await restoreEvent(set.id, { actor, workspaceId })).toMatchObject({ restored: true });
    expect(await attr(id, "status")).toBeUndefined();
  });

  it("a frontmatter value at creation is an ATTRIBUTE_SET chained to the creation", async () => {
    const id = await create({ title: `FM ${randomUUID().slice(0, 6)}`, markdown: "---\nstage: draft\n---\nbody" });
    expect((await attr(id, "stage"))).toMatchObject({ value: "draft", source: "frontmatter" });
    const created = (await q<{ id: string }>(
      `SELECT id::text FROM domain_events WHERE target_id = $1 AND event_type = 'NODE_CREATED'`, [id])).rows[0]!.id;
    const set = (await q<{ triggered_by_event_id: string }>(
      `SELECT triggered_by_event_id::text FROM domain_events WHERE target_id = $1 AND event_type = 'ATTRIBUTE_SET' AND payload->>'key' = 'stage'`,
      [id])).rows[0]!;
    expect(set.triggered_by_event_id).toBe(created);
  });

  it("a child:* value copied onto a new child is an ATTRIBUTE_SET", async () => {
    const parent = await create({ title: `Parent ${randomUUID().slice(0, 6)}`, attributes: [{ key: "child:status", value: "todo" }] });
    const child = await create({ title: `Child ${randomUUID().slice(0, 6)}`, parent_id: parent });
    expect(await attr(child, "status")).toMatchObject({ value: "todo" });
    expect((await attrEvent(child, "status"))?.event_type).toBe("ATTRIBUTE_SET");
    // Chained to the child's creation, like its frontmatter values.
    const created = (await q<{ id: string }>(
      `SELECT id::text FROM domain_events WHERE target_id = $1 AND event_type = 'NODE_CREATED'`, [child])).rows[0]!.id;
    expect((await q<{ t: string }>(
      `SELECT triggered_by_event_id::text AS t FROM domain_events WHERE target_id = $1 AND event_type = 'ATTRIBUTE_SET' AND payload->>'key' = 'status'`,
      [child])).rows[0]!.t).toBe(created);
  });
});
