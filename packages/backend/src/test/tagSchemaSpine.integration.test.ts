import { persistActor } from "./helpers/persistActor.js";
// Tag identity + schema mutations through the spine (Phase C cont.) against a
// real Postgres. A tag's schema defines fields and automation (tags carry no
// access policy any more — spaces decide), so editing it must clear the
// principal admin gate, leave an attributed audit event, be atomic with the
// row write, and no-op silently.
//
//   - a non-admin is refused (403) and emits no event;
//   - an admin schema edit emits an attributed TAG_SCHEMA_UPDATED and
//     persists; identity edit emits TAG_UPDATED carrying prev values;
//   - the create+link path is atomic: if the schema INSERT fails, neither the
//     tag_schema_id link nor the event survives (rollback);
//   - a no-op edit on an already-linked schema emits nothing.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import tagsRouter from "../routes/tags.js";
import { restoreEvent } from "../services/eventRestore/index.js";
import { AuthorityError } from "../spine/authority.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
// Production error boundary — router harnesses must map spine errors the
// same way src/index.ts does (401/403 instead of Hono's default 500).
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/tags", tagsRouter);

const admin: ActorCtx = { id: "admin-1", name: "Admin", role: "admin", type: "human" };
const editor: ActorCtx = { id: "editor-1", name: "Editor", role: "editor", type: "human" };
// Delegated admin-role token — must NOT be able to rewrite a tag's schema.
const adminToken: ActorCtx = {
  id: "admin-1", name: "Admin", role: "admin", type: "agent",
  tokenScope: { tokenId: "t", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null },
};

const patch = (path: string, body: unknown) =>
  app.request(path, { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const eventsFor = (tagId: string) =>
  q<{ event_type: string; actor_type: string; actor_id: string; payload: Record<string, unknown> }>(
    `SELECT event_type, actor_type, actor_id, payload FROM domain_events
      WHERE target_type = 'tag' AND target_id = $1 ORDER BY id ASC`,
    [tagId],
  );
// Tag titles are unique in a workspace and the shared test DB keeps earlier
// runs' tags, so every name this file uses carries the run's stamp.
const stamp = Date.now();
const named = (name: string) => `${name} ${stamp}`;
const mkTag = async (WS: string, name: string) =>
  (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1,'manual','class_tag',$2,$3,'') RETURNING id`,
    [WS, name, `tag-${name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`],
  )).rows[0]!.id;

describe.skipIf(!isTestDb)("tag identity + schema mutations via spine (DB)", () => {
  let WS = "";
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default')
             ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    Object.assign(admin, await persistActor(WS, admin));
    Object.assign(editor, await persistActor(WS, editor));
    Object.assign(adminToken, await persistActor(WS, adminToken));
  });

  it("a non-admin cannot edit the schema and emits no event", async () => {
    currentActor = editor;
    const tag = await mkTag(WS, named("Locked"));
    const res = await patch(`/api/tags/${tag}/schema`, { views: { v: 1 } });
    expect(res.status).toBe(403);
    expect((await eventsFor(tag)).rows.length).toBe(0);
  });

  it("a delegated admin-role token cannot rewrite a tag's schema (owner_only), emits no event", async () => {
    currentActor = adminToken; // admin role but tokenScope → blocked
    const tag = await mkTag(WS, named("TokenLocked"));
    const res = await patch(`/api/tags/${tag}/schema`, { views: { v: 1 } });
    expect(res.status).toBe(403);
    expect((await eventsFor(tag)).rows.length).toBe(0);
  });

  it("an admin schema edit creates+links the schema, emits attributed TAG_SCHEMA_UPDATED, persists", async () => {
    currentActor = admin;
    const tag = await mkTag(WS, named("Governed"));
    const res = await patch(`/api/tags/${tag}/schema`, { views: { board: { group_by: "status" } }, fields: [{ key: "x", type: "text" }] });
    expect(res.status).toBe(200);

    const evs = await eventsFor(tag);
    const ev = evs.rows.find((e) => e.event_type === "TAG_SCHEMA_UPDATED");
    expect(ev).toBeDefined();
    expect(ev!.actor_type).toBe("user");      // human admin → 'user'
    expect(ev!.actor_id).toBe(admin.id);
    expect(ev!.payload.created).toBe(true);

    // Schema linked + views persisted (state change committed with the event).
    const linked = await q<{ views: Record<string, unknown> }>(
      `SELECT n.tag_schema->'views' AS views FROM content_nodes n WHERE n.id = $1`,
      [tag],
    );
    expect(linked.rows[0]?.views).toMatchObject({ board: { group_by: "status" } });
  });

  // (P4.1 CONTRACT) The old "create+link atomicity" case is gone: folding a schema
  // onto a tag is now a single UPDATE of content_nodes.tag_schema inside the spine
  // tx — there is no separate collection_schemas INSERT (and no UNIQUE(slug)) that
  // could half-fail, so the rollback is atomic by construction.

  it("a no-op schema edit on an already-linked schema emits no event", async () => {
    currentActor = admin;
    const tag = await mkTag(WS, named("NoopTag"));
    await patch(`/api/tags/${tag}/schema`, { fields: [{ key: "z", type: "text" }] }); // links a schema (+1 event)
    const before = (await eventsFor(tag)).rows.length;
    const res = await patch(`/api/tags/${tag}/schema`, {}); // nothing to change
    expect(res.status).toBe(200);
    expect((await eventsFor(tag)).rows.length).toBe(before); // no new event
  });

  it("re-submitting identical schema values is a no-op (no event)", async () => {
    currentActor = admin;
    const tag = await mkTag(WS, named("SameVal"));
    await patch(`/api/tags/${tag}/schema`, { views: { v: 1 } }); // +1 event
    const before = (await eventsFor(tag)).rows.length;
    const res = await patch(`/api/tags/${tag}/schema`, { views: { v: 1 } }); // identical
    expect(res.status).toBe(200);
    expect((await eventsFor(tag)).rows.length).toBe(before); // unchanged → no new event
  });

  it("an empty-body schema PATCH on a schema-less tag creates nothing and emits nothing (#7 unified)", async () => {
    currentActor = admin;
    const tag = await mkTag(WS, named("EmptySchema"));
    const res = await patch(`/api/tags/${tag}/schema`, {});
    expect(res.status).toBe(200);
    expect((await eventsFor(tag)).rows.length).toBe(0);
    const linked = await q<{ tag_schema: unknown | null }>(`SELECT tag_schema FROM content_nodes WHERE id = $1`, [tag]);
    expect(linked.rows[0]?.tag_schema).toBeNull(); // no empty schema created
  });

  const lastEventId = (tag: string, type: string) =>
    q<{ id: string }>(
      `SELECT id::text FROM domain_events WHERE target_type='tag' AND target_id=$1 AND event_type=$2 ORDER BY domain_events.id DESC LIMIT 1`,
      [tag, type],
    ).then((r) => r.rows[0]!.id);

  it("restoring a TAG_SCHEMA_UPDATED reverts the schema; a delegated token cannot restore it (#5 + principal)", async () => {
    currentActor = admin;
    const tag = await mkTag(WS, named("Revertible"));
    await patch(`/api/tags/${tag}/schema`, { views: { v: 1 } }); // create (prev null)
    await patch(`/api/tags/${tag}/schema`, { views: { v: 2 } }); // update, prev views = {v:1}
    const ev = await lastEventId(tag, "TAG_SCHEMA_UPDATED");

    // A delegated admin token cannot restore a schema change (principal_admin).
    await expect(restoreEvent(ev, { workspaceId: WS, actor: adminToken })).rejects.toThrow(AuthorityError);

    // The principal restores → views revert to {v:1} (no longer 422 unsupported).
    const r = await restoreEvent(ev, { workspaceId: WS, actor: admin });
    expect("restored" in r && r.restored).toBe(true);
    const views = await q<{ views: Record<string, unknown> }>(
      `SELECT n.tag_schema->'views' AS views FROM content_nodes n WHERE n.id = $1`,
      [tag],
    );
    expect(views.rows[0]?.views).toEqual({ v: 1 });
  });

  it("restoring a TAG_UPDATED reverts the tag name", async () => {
    currentActor = admin;
    const tag = await mkTag(WS, named("FirstName"));
    await patch(`/api/tags/${tag}`, { name: named("SecondName") });
    const ev = await lastEventId(tag, "TAG_UPDATED");
    const r = await restoreEvent(ev, { workspaceId: WS, actor: admin });
    expect("restored" in r && r.restored).toBe(true);
    const name = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [tag])).rows[0]?.title;
    expect(name).toBe(named("FirstName"));
  });

  it("identity edit (rename) emits TAG_UPDATED with prev values; same-value/no-op emits nothing", async () => {
    currentActor = admin;
    const tag = await mkTag(WS, named("OldName"));
    const res = await patch(`/api/tags/${tag}`, { name: named("NewName") });
    expect(res.status).toBe(200);
    const ev = (await eventsFor(tag)).rows.find((e) => e.event_type === "TAG_UPDATED");
    expect(ev).toBeDefined();
    expect((ev!.payload as { changed: string[] }).changed).toContain("name");

    const before = (await eventsFor(tag)).rows.length;
    expect((await patch(`/api/tags/${tag}`, {})).status).toBe(200); // empty-body no-op
    expect((await patch(`/api/tags/${tag}`, { name: named("NewName") })).status).toBe(200); // same-value no-op
    expect((await eventsFor(tag)).rows.length).toBe(before); // neither emitted

    // non-admin identity edit refused
    currentActor = editor;
    expect((await patch(`/api/tags/${tag}`, { name: named("Hacked") })).status).toBe(403);
  });
});
