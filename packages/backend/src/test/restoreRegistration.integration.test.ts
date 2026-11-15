// A tag-membership event restores through the eventRestore entry alone: the
// module graph that runs the restore never imported tagMembership itself;
// eventRestore loads services/restoreHandlers.ts (unit-tested in
// restoreHandlers.test.ts) before its first restore.

import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = /(?:onden_test|\w+_test)(?:\?|$)/.test(process.env.DATABASE_URL ?? "");
let workspaceId = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));

describe.skipIf(!isTestDb)("restore registration", () => {
  it("restores TAG_APPLIED with only the eventRestore entry imported", async () => {
    // Write the event with the app's own route, in one module graph.
    const { q } = await import("../db.js");
    const { persistActor } = await import("./helpers/persistActor.js");
    const { seedClassTag } = await import("./helpers/seedClassTag.js");
    const { apiOnError } = await import("../httpError.js");
    const nodesRouter = (await import("../routes/nodes.js")).default;
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Restore registration',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    const admin = await persistActor(workspaceId, { id: "restore-registration-admin", name: "Admin", role: "admin", type: "human" });
    const nodeId = (await seedQ<{ id: string }>(`INSERT INTO content_nodes(workspace_id,title,slug,node_type,source_type)
      VALUES($1,'Registration test',$2,'content','manual') RETURNING id`, [workspaceId, randomUUID()])).rows[0]!.id;
    const { tagId } = await seedClassTag(workspaceId, { name: `Registration tag ${randomUUID()}`, slug: randomUUID() });
    const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
    app.onError(apiOnError);
    app.use("*", async (c, next) => { c.set("actor", admin); await next(); });
    app.route("/nodes", nodesRouter);
    expect((await app.request(`/nodes/${nodeId}/tags/${tagId}`, { method: "PUT" })).status).toBe(200);
    const applied = (await q<{ id: string }>(`SELECT id::text FROM domain_events
      WHERE target_id=$1 AND event_type='TAG_APPLIED' ORDER BY domain_events.id DESC LIMIT 1`, [nodeId])).rows[0]!.id;

    // Restore it from a fresh module graph that imports only the entry.
    vi.resetModules();
    const { restoreEvent } = await import("../services/eventRestore/index.js");
    expect(await restoreEvent(applied, { actor: admin, workspaceId })).toMatchObject({ restored: true, restore_event_type: "TAG_REMOVED" });
    const fresh = await import("../db.js");
    const state = (await fresh.q<{ is_applied: boolean }>(`SELECT is_applied FROM node_tag_states WHERE node_id=$1 AND tag_id=$2`, [nodeId, tagId])).rows[0];
    expect(state?.is_applied).toBe(false);
  }, 120_000); // loads the app's module graph twice
});
