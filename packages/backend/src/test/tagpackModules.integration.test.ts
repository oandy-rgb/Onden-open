import { persistActor } from "./helpers/persistActor.js";
// TagPack × module binding (module contract #2/#10) against a real DB:
//   • exporting a tag stamps explicit review/reading module configuration;
//     no tag is bound to a module by name or reserved key (RSS's
//     #subscription binding retired with migration 114);
//   • an ordinary tag's pack carries NO modules field;
//   • importing a pack that declares a module this build doesn't ship still
//     SUCCEEDS (contract #10 graceful degradation — the tag lands as an
//     ordinary schema tag) and the response carries the missing_modules
//     warning;
//   • round-trip: export → import (renamed) → re-export preserves
//     fields/policy/behaviour/version/dependencies; the re-export of the
//     renamed review/reading tags preserve binding.
//
// Mirrors src/test/tagSchemaSpine.integration.test.ts conventions.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { randomUUID } from "node:crypto";
import { q, getWorkspaceId } from "../db.js";
import tagsRouter from "../routes/tags.js";
import { presentModuleIds } from "../services/moduleCatalog.js";
import type { ActorCtx } from "../types.js";
import { patchTagModules as setTagModules } from "../services/legacyTagFunctionWrites.js";
import { setModuleImported } from "../services/workspaceModules.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { registerStandInFunction } from "./helpers/registerStandInFunction.js";
import { seedQ } from "./helpers/seedQ.js";

registerShippedModules();
registerStandInFunction();

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
// Production error boundary — router harnesses must map spine errors the
// same way src/index.ts does (401/403 instead of Hono's default 500).
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/tags", tagsRouter);

const admin: ActorCtx = { id: "tp-admin", name: "Admin", role: "admin", type: "human" };

const stamp = Date.now();

type Pack = {
  name: string; color: string; description: string; version: string;
  dependencies: string[]; policy: Record<string, unknown>; fields: unknown[];
  behaviour: Record<string, unknown>; template_children: unknown[];
  modules?: string[]; _format: string;
};

const get = (path: string) => app.request(path);
const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** Find-or-create a class_tag by TITLE — #review may already exist in the
 *  shared test DB. */
async function ensureTag(WS: string, name: string): Promise<string> {
  const found = await q<{ id: string }>(
    `SELECT id FROM content_nodes
      WHERE workspace_id = $1 AND node_type = 'class_tag' AND deleted_at IS NULL AND title = $2
      LIMIT 1`,
    [WS, name],
  );
  if (found.rows[0]) return found.rows[0].id;
  const ins = await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1, 'manual', 'class_tag', $2, $3, '') RETURNING id`,
    [WS, name, `tag-${name}-${stamp}-${Math.random().toString(36).slice(2, 6)}`],
  );
  return ins.rows[0]!.id;
}

describe.skipIf(!isTestDb)("tagpack × module binding (DB)", () => {
  let WS = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default')
             ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    Object.assign(admin, await persistActor(WS, admin));

    currentActor = admin;
  });

  it("offline-parity: honors a client-supplied class_tag id, and rejects a malformed one", async () => {
    const clientId = randomUUID();
    const name = `client-tag-${stamp}`;
    const ok = await post("/api/tags/import", { id: clientId, name, fields: [] });
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as { id: string };
    // The server used the client's id verbatim — the sidebar's optimistic tag
    // reconciles by id on /api/sync, no server-minted duplicate.
    expect(body.id).toBe(clientId);
    const row = await q<{ node_type: string }>(
      `SELECT node_type FROM content_nodes WHERE id = $1 AND workspace_id = $2`, [clientId, WS]);
    expect(row.rows[0]?.node_type).toBe("class_tag");

    // A malformed id 400s at the route (never reaches the ::uuid cast as a 500).
    const bad = await post("/api/tags/import", { id: "not-a-uuid", name: `bad-${stamp}`, fields: [] });
    expect(bad.status).toBe(400);
  });

  it("registry: every shipped module is present for the import warning", () => {
    expect(presentModuleIds()).toEqual(new Set(["review", "rss", "semantic", "website", "canvas", "skills", "slides", "handwriting", "table", "calendar", "kanban", "gallery", "daily", "tasks", "importers", "capture", "ai", "external_calendars"]));
  });

  it("export stamps the explicit review binding; a tag titled subscription is an ordinary pack", async () => {
    const reviewId = await ensureTag(WS, "review");
    await setTagModules({ actor: admin, workspaceId: WS, tagId: reviewId, modules: { review: true } });
    const r1 = await get(`/api/tags/${reviewId}/export`);
    expect(r1.status).toBe(200);
    const reviewPack = (await r1.json()) as Pack;
    expect(reviewPack.name).toBe("review");
    expect(reviewPack.modules).toEqual(["review"]);
    expect(reviewPack._format).toBe("onden.tagpack/v1");

    const subId = await ensureTag(WS, "subscription");
    const r2 = await get(`/api/tags/${subId}/export`);
    expect(r2.status).toBe(200);
    expect("modules" in ((await r2.json()) as Pack)).toBe(false);
  });

  it("an ordinary tag's pack carries no modules field", async () => {
    const plainId = await ensureTag(WS, `plain-${stamp}`);
    const res = await get(`/api/tags/${plainId}/export`);
    expect(res.status).toBe(200);
    const pack = (await res.json()) as Pack;
    expect("modules" in pack).toBe(false);
  });

  it("a renamed module tag round-trips its capability without losing identity or reporting a missing dependency", async () => {
    // The import turns the switches into extends of the module tags (D72).
    for (const module of ["skills"]) await setModuleImported({ actor: admin, workspaceId: WS, module, imported: true });
    const tagId = await ensureTag(WS, `study-${stamp}`);
    await setTagModules({ actor: admin, workspaceId: WS, tagId, modules: { skills: true } });
    const exported = await (await get(`/api/tags/${tagId}/export`)).json() as Pack;
    expect(exported.modules).toEqual(["skills"]);
    const response = await post("/api/tags/import", { ...exported, name: `study-copy-${stamp}` });
    expect(response.status).toBe(201);
    const imported = await response.json() as { id: string; missing_modules: string[]; module_switches: unknown[] };
    expect(imported.missing_modules).toEqual([]);
    expect(imported.module_switches).toEqual([{ module: "skills", result: "extends" }]);
    const reexported = await (await get(`/api/tags/${imported.id}/export`)).json() as Pack;
    expect(reexported.modules).toEqual(["skills"]);
    expect(reexported.behaviour).toEqual(exported.behaviour);
  });

  it("import with modules:['nonexistent'] SUCCEEDS with a missing_modules warning (contract #10)", async () => {
    const name = `ghostmod-${stamp}`;
    const res = await post("/api/tags/import", {
      name,
      modules: ["nonexistent"],
      fields: [{ name: "topic", type: "text" }],
      _format: "onden.tagpack/v1",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; missing_modules: string[]; missing_dependencies: string[] };
    expect(body.missing_modules).toEqual(["nonexistent"]);

    // Graceful degradation: the tag landed as an ordinary schema tag.
    const tag = await q<{ id: string; fields: unknown[] }>(
      `SELECT n.id, n.tag_schema->'fields' AS fields FROM content_nodes n
        WHERE n.workspace_id = $1 AND n.title = $2 AND n.node_type = 'class_tag' AND n.deleted_at IS NULL`,
      [WS, name],
    );
    expect(tag.rows).toHaveLength(1);
    expect(tag.rows[0]!.fields).toEqual([{ name: "topic", type: "text" }]);
  });

  it("malformed modules (not a string array) is a 400", async () => {
    const res = await post("/api/tags/import", { name: `badmod-${stamp}`, modules: "rss" });
    expect(res.status).toBe(400);
  });

  it("a pack exported before migration 114 (modules:[\"rss\"]) still imports: no warning, an ordinary tag", async () => {
    const subId = await ensureTag(WS, "subscription");
    const exported = (await (await get(`/api/tags/${subId}/export`)).json()) as Pack;
    expect("modules" in exported).toBe(false);

    // The old exporter stamped modules:["rss"] on #subscription. Such a pack
    // keeps working: rss ships, so nothing is missing; the tag lands as an
    // ordinary tag (no reserved key — it makes nothing a feed).
    const legacy = { ...exported, name: `subscription-copy-${stamp}`, modules: ["rss"] };
    const res = await post("/api/tags/import", legacy);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; missing_modules: string[] };
    expect(body.missing_modules).toEqual([]);
    const row = await q<{ reserved_key: string | null }>(`SELECT reserved_key FROM content_nodes WHERE id = $1`, [body.id]);
    expect(row.rows[0]!.reserved_key).toBeNull();

    const reexported = (await (await get(`/api/tags/${body.id}/export`)).json()) as Pack;
    expect(reexported.name).toBe(legacy.name);
    expect(reexported.fields).toEqual(exported.fields);
    expect(reexported.behaviour).toEqual(exported.behaviour);
    expect(reexported.version).toEqual(exported.version);
    expect(reexported.template_children).toEqual(exported.template_children);
    expect("modules" in reexported).toBe(false);
  });
});
