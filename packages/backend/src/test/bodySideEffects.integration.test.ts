// Every body rewrite keeps derived state in step (services/bodySideEffects.ts).
//
//   • Undoing an edit removes the backlink and block id the edit added; they
//     used to stay, describing text the user had taken back.
//   • Restoring a version re-derives them too, and is itself undoable
//     (NODE_RESTORED carries an inverse since 2026-10-14).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import { restoreEvent } from "../services/eventRestore/index.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(database) || /_test\b/.test(database);
let workspaceId = "";
let actor: ActorCtx = { id: "body-effects-admin", name: "Body effects", role: "admin", type: "human" };
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/nodes", nodesRouter);
const send = (url: string, method: string, body: unknown = {}) => app.request(url, {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

async function note(title: string, markdown = "") {
  return (await seedQ<{ id: string }>(`INSERT INTO content_nodes (workspace_id,title,slug,markdown,node_type,source_type)
    VALUES ($1,$2,$3,$4,'content','manual') RETURNING id`, [workspaceId, title, randomUUID(), markdown])).rows[0]!.id;
}
const edit = async (id: string, markdown: string) => expect((await send(`/nodes/${id}`, "PATCH", { markdown })).status).toBe(200);
const latestEvent = async (id: string, type: string) => (await q<{ id: string }>(
  `SELECT id::text FROM domain_events WHERE target_id = $1 AND event_type = $2 ORDER BY domain_events.id DESC LIMIT 1`, [id, type])).rows[0]!.id;
const links = async (from: string, to: string) => (await q(
  `SELECT 1 FROM node_edges WHERE source_node_id = $1 AND target_node_id = $2 AND origin = 'wikilink'`, [from, to])).rowCount;
const body = async (id: string) => (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;

describe.skipIf(!isTestDb)("body rewrites keep derived state in step (DB)", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Body effects',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    actor = await persistActor(workspaceId, actor);
  });

  it("undoing an edit removes the backlink it added", async () => {
    const stamp = randomUUID().slice(0, 8);
    const target = await note(`Target ${stamp}`);
    const source = await note(`Source ${stamp}`, "plain text");
    await edit(source, `see [[Target ${stamp}]]\n\na paragraph ^blk-${stamp}`);
    expect(await links(source, target)).toBe(1);

    expect(await restoreEvent(await latestEvent(source, "NODE_UPDATED"), { actor, workspaceId })).toMatchObject({ restored: true });
    expect(await body(source)).toBe("plain text");
    expect(await links(source, target)).toBe(0);
  });

  it("restoring a version re-derives links, and the restore itself can be undone", async () => {
    const stamp = randomUUID().slice(0, 8);
    const target = await note(`Linked ${stamp}`);
    const id = await note(`Versions ${stamp}`, "start");
    await edit(id, `v1 links [[Linked ${stamp}]]`);
    const v1 = await latestEvent(id, "NODE_UPDATED");
    await edit(id, "v2 has no link");
    expect(await links(id, target)).toBe(0);

    expect((await send(`/nodes/${id}/versions/${v1}/restore`, "POST")).status).toBe(200);
    expect(await body(id)).toBe(`v1 links [[Linked ${stamp}]]`);
    expect(await links(id, target)).toBe(1);

    expect(await restoreEvent(await latestEvent(id, "NODE_RESTORED"), { actor, workspaceId })).toMatchObject({ restored: true });
    expect(await body(id)).toBe("v2 has no link");
    expect(await links(id, target)).toBe(0);
  });

  it("refuses to undo a version restore recorded before inverses existed", async () => {
    const id = await note(`Legacy ${randomUUID().slice(0, 8)}`, "now");
    const legacy = (await q<{ id: string }>(
      `INSERT INTO domain_events (id, workspace_id, actor_type, actor_id, event_type, target_type, target_id, payload, tx_meta)
       VALUES (nextval(pg_get_serial_sequence('domain_events','id')), $1, 'user', $2, 'NODE_RESTORED', 'node', $3,
               '{"title":"x"}'::jsonb, '{"ui_context":"node.version.restore"}'::jsonb) RETURNING id::text`,
      [workspaceId, actor.id, id])).rows[0]!.id;
    expect(await restoreEvent(legacy, { actor, workspaceId })).toMatchObject({ code: "history_incomplete", status: 409 });
  });
});
