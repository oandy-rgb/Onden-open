// T13: saved view events, which have no inverse, are not offered for restore.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import tagsRouter from "../routes/tags.js";
import { restoreEvent, type EventRow } from "../services/eventRestore/index.js";
import { isRestorable as restorable } from "../services/restoreContract.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);
let workspaceId = "";
let actor: ActorCtx = { id: "t13-admin", name: "T13 admin", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/tags", tagsRouter);
const write = (url: string, method: string, body: unknown = {}) => app.request(url, {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
async function latest(targetId: string): Promise<EventRow> {
  return (await q<EventRow>(`SELECT id::text,workspace_id,event_type,target_type,target_id,payload,tx_meta,external
    FROM domain_events WHERE target_id=$1 ORDER BY domain_events.id DESC LIMIT 1`, [targetId])).rows[0]!;
}
const restore = (id: string) => restoreEvent(id, { actor, workspaceId });

describe.skipIf(!isTestDb)("saved view events and restore (T13)", () => {
  let tagId = "";

  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('T13',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
    const created = await write("/tags", "POST", { name: `Products ${randomUUID()}` });
    expect(created.status).toBe(201);
    tagId = ((await created.json()) as { id: string }).id;
    expect((await write(`/tags/${tagId}/schema`, "PATCH", { fields: [{ name: "title", type: "text", required: true }] })).status).toBe(200);
  });

  it("saved view events are not offered for restore, and restore refuses them unchanged", async () => {
    const created = await write(`/tags/${tagId}/views`, "POST", { name: `View ${randomUUID()}` });
    expect(created.status).toBe(201);
    const viewId = ((await created.json()) as { id: string }).id;
    const view = await latest(viewId);
    expect(view.event_type).toBe("COLLECTION_VIEW_CREATED");
    expect(restorable(view)).toBe(false);
    for (const type of ["COLLECTION_VIEW_UPDATED", "COLLECTION_VIEW_DELETED", "COLLECTION_SCHEMA_UPDATED"]) {
      expect(restorable({ external: false, event_type: type })).toBe(false);
    }
    expect(await restore(view.id)).toMatchObject({ code: "unsupported", status: 422 });
    const views = (await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM function_refs WHERE holder_node_id=$1 AND instance <> ''`, [tagId])).rows[0]!.n;
    expect(views).toBe(1);
  });
});
