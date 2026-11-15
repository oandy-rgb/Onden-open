// Tag apply/remove atomicity (Phase C cont.) against a real Postgres. Applying
// a tag writes the node_tags row AND emits TAG_APPLIED; these must be atomic and authority-gated:
//   - authority checks both the target and tag under the event lock;
//   - the node_tags row and the TAG_APPLIED event commit in one transaction —
//     a failed write leaves neither (rollback);
//   - re-applying / removing-absent is a no-op with no event;
//   - the event is attributed to the acting actor.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import nodesRouter from "../routes/nodes.js";
import type { ActorCtx } from "../types.js";
import { joinDefaultSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
// Production error boundary — router harnesses must map spine errors the
// same way src/index.ts does (401/403 instead of Hono's default 500).
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);

let editor: ActorCtx;
let admin: ActorCtx;
let viewer: ActorCtx;

const put = (p: string) => app.request(p, { method: "PUT" });
const del = (p: string) => app.request(p, { method: "DELETE" });
const tagEvents = (nodeId: string) =>
  q<{ event_type: string; actor_type: string; actor_id: string }>(
    `SELECT event_type, actor_type, actor_id FROM domain_events
      WHERE target_type = 'node' AND target_id = $1
        AND event_type IN ('TAG_APPLIED','TAG_REMOVED') ORDER BY id ASC`,
    [nodeId],
  );

describe.skipIf(!isTestDb)("tag apply/remove atomicity via spine (DB)", () => {
  let WS = "";
  let node = "";
  let openTag = "";
  let otherTag = "";

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default')
             ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    // `role` is the fixture shorthand for the default-space permission only
    // (viewer = view, anything else = edit); actors have no workspace role.
    const seedActor = async (role: string) => {
      const actor = (await q<ActorCtx>(
        `INSERT INTO actors(workspace_id,name,type) VALUES($1,$2,'human') RETURNING id,name,type`,
        [WS,`Tag spine ${role}`],
      )).rows[0]!;
      await joinDefaultSpace(WS, actor.id, role);
      return actor;
    };
    editor = await seedActor("editor");
    admin = await seedActor("admin");
    viewer = await seedActor("viewer"); // a viewer of the default space
  });

  // A fresh note and tags per test: the event counts below are per note, so
  // no test may start from another test's applies and removes.
  beforeEach(async () => {
    node = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Doc','doc-${Date.now()}','body') RETURNING id`,
      [WS],
    )).rows[0]!.id;
    const mkTag = async (name: string) => {
      return (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
         VALUES ($1,'manual','class_tag',$2,$3,'') RETURNING id`,
        [WS, name, `tag-${name}-${Date.now()}`],
      )).rows[0]!.id;
    };
    // Tag titles are unique per workspace: suffix them.
    const suffix = randomUUID().slice(0, 8);
    openTag = await mkTag(`open-${suffix}`);
    otherTag = await mkTag(`other-${suffix}`);
  });

  it("an editor applies an open tag: row written + TAG_APPLIED attributed; re-apply is a no-op", async () => {
    currentActor = editor;
    const res = await put(`/api/nodes/${node}/tags/${openTag}`);
    expect(res.status).toBe(200);
    const row = await q(`SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [node, openTag]);
    expect(row.rows.length).toBe(1);
    const evs = await tagEvents(node);
    const applied = evs.rows.filter((e) => e.event_type === "TAG_APPLIED");
    expect(applied.length).toBe(1);
    expect(applied[0]!.actor_type).toBe("user");
    expect(applied[0]!.actor_id).toBe(editor.id);

    // Re-apply → no-op, no second event
    expect((await (await put(`/api/nodes/${node}/tags/${openTag}`)).json()).noop).toBe(true);
    expect((await tagEvents(node)).rows.filter((e) => e.event_type === "TAG_APPLIED").length).toBe(1);
  });

  it("remove emits TAG_REMOVED; removing-absent is a no-op with no event", async () => {
    currentActor = editor;
    expect((await put(`/api/nodes/${node}/tags/${openTag}`)).status).toBe(200);
    const res = await del(`/api/nodes/${node}/tags/${openTag}`);
    expect(res.status).toBe(200);
    expect((await tagEvents(node)).rows.filter((e) => e.event_type === "TAG_REMOVED").length).toBe(1);
    // remove again → no-op
    expect((await (await del(`/api/nodes/${node}/tags/${openTag}`)).json()).noop).toBe(true);
    expect((await tagEvents(node)).rows.filter((e) => e.event_type === "TAG_REMOVED").length).toBe(1);
  });

  // Spaces model: tags carry no permission; tagging a note is editing it, so a
  // viewer of the note's space is refused.
  it("a viewer of the note's space is refused (403), no row, no new event", async () => {
    const before = (await tagEvents(node)).rows.filter((e) => e.event_type === "TAG_APPLIED").length;
    currentActor = viewer;
    const res = await put(`/api/nodes/${node}/tags/${otherTag}`);
    expect(res.status).toBe(403);
    expect((await q(`SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [node, otherTag])).rows.length).toBe(0);
    expect((await tagEvents(node)).rows.filter((e) => e.event_type === "TAG_APPLIED").length).toBe(before); // no new event
    // an editing member can
    currentActor = admin;
    expect((await put(`/api/nodes/${node}/tags/${otherTag}`)).status).toBe(200);
  });

  it("concurrent applies/removes of the same tag emit the event at most once (no check-then-act race)", async () => {
    currentActor = editor;
    const n = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Race','race-${Date.now()}','b') RETURNING id`,
      [WS],
    )).rows[0]!.id;

    // 8 concurrent applies — only the one that wins the unique-index insert may
    // dispatch, so exactly one TAG_APPLIED lands.
    await Promise.all(Array.from({ length: 8 }, () => put(`/api/nodes/${n}/tags/${openTag}`)));
    expect((await tagEvents(n)).rows.filter((e) => e.event_type === "TAG_APPLIED").length).toBe(1);
    expect((await q(`SELECT 1 FROM node_tags WHERE node_id = $1 AND tag_id = $2`, [n, openTag])).rows.length).toBe(1);

    // 8 concurrent removes — exactly one TAG_REMOVED.
    await Promise.all(Array.from({ length: 8 }, () => del(`/api/nodes/${n}/tags/${openTag}`)));
    expect((await tagEvents(n)).rows.filter((e) => e.event_type === "TAG_REMOVED").length).toBe(1);
  });

  it("a missing node is refused without an orphan TAG_APPLIED event", async () => {
    currentActor = admin;
    // Missing targets are domain refusals before attempting a join INSERT.
    const phantom = randomUUID();
    const res = await put(`/api/nodes/${phantom}/tags/${openTag}`);
    expect(res.status).toBe(404);
    expect((await tagEvents(phantom)).rows.length).toBe(0); // no orphan event
  });
});
