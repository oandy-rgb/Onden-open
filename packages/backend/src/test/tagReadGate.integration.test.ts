// Tag read gate under spaces (docs/architecture/spaces.md): tag definitions
// are global — a tag never decides who can see anything, so every member
// (and every token, whatever its space scope) reads every tag surface, both in
// the list and by id. What stays: an unknown or trashed tag id is 404 on every
// per-id surface, never a different error (no existence oracle).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import tagsRouter from "../routes/tags.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { persistActor } from "./helpers/persistActor.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/tags", tagsRouter);

const viewer: ActorCtx = { id: "trg-viewer", name: "Viewer", role: "viewer", type: "human" };
const admin: ActorCtx = { id: "trg-admin", name: "Admin", role: "admin", type: "human" };
// A token that reaches no space still reads tag definitions.
const scopedToken: ActorCtx = {
  id: "trg-token", name: "Scoped token", role: "admin", type: "agent",
  tokenScope: { tokenId: "trg-token-1", allowedTools: null, access: "read", writeMode: "apply", expiresAt: null },
};

async function get(path: string, actor: ActorCtx): Promise<Response> {
  currentActor = actor;
  return app.request(path, { method: "GET" });
}

describe.skipIf(!isTestDb)("tag read gate on per-id endpoints (DB)", () => {
  let WS = "";
  let secretTagId = "";
  let publicTagId = "";
  let trashedTagId = "";
  let stamp = 0;

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    // Authentication injects real IDs, not synthetic role/scope assertions.
    // GET /tags now rechecks those rows within the catalog read snapshot.
    Object.assign(viewer, await persistActor(WS, viewer));
    Object.assign(admin, await persistActor(WS, admin));
    Object.assign(scopedToken, await persistActor(WS, scopedToken));
    stamp = Date.now();

    const secret = await seedClassTag(WS, {
      name: `trg-secret-${stamp}`,
      slug: `trg-secret-${stamp}`,
      nodeSlug: `tag-trg-secret-${stamp}`,
      markdown: `TRG TAG BODY ${stamp}`,
    });
    secretTagId = secret.tagId;
    const pub = await seedClassTag(WS, {
      name: `trg-public-${stamp}`,
      slug: `trg-public-${stamp}`,
      nodeSlug: `tag-trg-public-${stamp}`,
    });
    publicTagId = pub.tagId;
    trashedTagId = (await seedClassTag(WS, {
      name: `trg-trashed-${stamp}`, slug: `trg-trashed-${stamp}`, nodeSlug: `tag-trg-trashed-${stamp}`,
    })).tagId;
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [trashedTagId]);
  });

  const SURFACES = ["", "/export", "/path", "/descendants", "/views", "/blocks", "/delete-preview"];

  it("every member and every token lists every tag", async () => {
    for (const actor of [viewer, admin, scopedToken]) {
      const res = await get("/api/tags", actor);
      expect(res.status).toBe(200);
      const ids = new Set(((await res.json()) as Array<{ id: string }>).map((r) => r.id));
      expect(ids.has(publicTagId)).toBe(true);
      expect(ids.has(secretTagId)).toBe(true);
      expect(ids.has(trashedTagId)).toBe(false);
      const tree = await get("/api/tags/tree", actor);
      const treeIds = new Set(((await tree.json()) as { tags: Array<{ id: string }> }).tags.map((t) => t.id));
      expect(treeIds.has(secretTagId)).toBe(true);
    }
  });

  it("per-id surfaces answer the same for everyone", async () => {
    for (const actor of [viewer, admin, scopedToken]) {
      for (const suffix of SURFACES) {
        expect((await get(`/api/tags/${secretTagId}${suffix}`, actor)).status, `${actor.name} ${suffix}`).toBe(200);
      }
      expect((await get(`/api/tags/${secretTagId}/merge-preview?target=${publicTagId}`, actor)).status).toBe(200);
    }
    const body = await (await get(`/api/tags/${secretTagId}`, viewer)).text();
    expect(body).toContain(`TRG TAG BODY ${stamp}`);
  });

  it("an unknown or trashed tag id is 404 on every per-id surface", async () => {
    const unknown = "00000000-0000-4000-8000-00000000dead";
    for (const id of [unknown, trashedTagId]) {
      for (const suffix of SURFACES) {
        expect((await get(`/api/tags/${id}${suffix}`, admin)).status, `${id} ${suffix}`).toBe(404);
      }
      expect((await get(`/api/tags/${publicTagId}/merge-preview?target=${id}`, admin)).status).toBe(404);
    }
  });
});
