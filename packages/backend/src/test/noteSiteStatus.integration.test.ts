// GET /api/site/status/:nodeId — where one note stands on the published site,
// against a real Postgres: not there, there but a publish would change what
// readers see, or there as it is. A private attribute changes nothing readers
// see, so it is not "outdated".
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { apiOnError } from "../httpError.js";
import { q } from "../db.js";
import nodesRouter from "../routes/nodes.js";
import publishRouter from "../modules/website/routes.js";
import type { ActorCtx } from "../types.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { armSiteRebuild, disarmSiteRebuild } from "./helpers/siteRebuild.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";
import { publishDefaultSpace } from "./helpers/spaceFixtures.js";
import { postVia, publishWithPreview } from "./helpers/publishWithPreview.js";

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);
app.route("/api", publishRouter);
registerShippedModules();

const admin: ActorCtx = { id: "admin-1", name: "Admin", role: "admin", type: "human" };
const json = { "Content-Type": "application/json" };
const put = (id: string, key: string, value: string) => app.request(`/api/nodes/${id}/attributes/${key}`, {
  method: "PUT", body: JSON.stringify({ value }), headers: json,
});
const publish = async () => expect((await publishWithPreview(postVia(app))).status).toBe(201);
const stateOf = async (id: string) =>
  ((await (await app.request(`/api/site/status/${id}`)).json()) as { state: string }).state;

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

describe.skipIf(!isTestDb)("a note's state on the site (DB)", () => {
  let id = "";
  afterAll(async () => { await disarmSiteRebuild(); });
  beforeAll(async () => {
    armSiteRebuild(() => WS);
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Note status test', $1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    await publishDefaultSpace(WS);
    Object.assign(admin, await persistActor(WS, admin));
    currentActor = admin;
    id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id)
       VALUES ($1, 'manual', 'content', 'Status note', 'status-note', 'first body',
               (SELECT id FROM spaces WHERE workspace_id = $1 AND is_default))
       RETURNING id::text`, [WS],
    )).rows[0]!.id;
  });

  it("takes a note id", async () => {
    expect((await app.request("/api/site/status/not-an-id")).status).toBe(400);
  });

  it("walks not_on_site → current → outdated → current → not_on_site", async () => {
    expect(await stateOf(id)).toBe("not_on_site"); // never published
    expect((await put(id, "_published", "true")).status).toBe(200);
    expect(await stateOf(id)).toBe("not_on_site"); // marked, but the site has no copy of it yet
    await publish();
    expect(await stateOf(id)).toBe("current");

    await seedQ(`UPDATE content_nodes SET markdown = 'second body' WHERE id = $1`, [id]);
    expect(await stateOf(id)).toBe("outdated"); // readers would see the new text
    await publish();
    expect(await stateOf(id)).toBe("current");

    // A private attribute and a sort_order bump are not something readers see.
    expect((await put(id, "mood", "calm")).status).toBe(200);
    await seedQ(`UPDATE content_nodes SET sort_order = sort_order + 5, updated_at = now() WHERE id = $1`, [id]);
    expect(await stateOf(id)).toBe("current");

    await seedQ(`UPDATE content_nodes SET title = 'Renamed' WHERE id = $1`, [id]);
    expect(await stateOf(id)).toBe("outdated");
    await publish();

    expect((await put(id, "_published", "false")).status).toBe(200);
    expect(await stateOf(id)).toBe("not_on_site"); // taken down at once, before any new publish
  });
});
