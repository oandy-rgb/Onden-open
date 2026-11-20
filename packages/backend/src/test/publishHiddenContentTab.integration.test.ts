// Hiding a note's 「內容」 tab only hides a tab: the text is still the note's body, so a published note publishes the
// same words whether the tab shows or not (owner decision, docs/architecture/proposals/pdf-pages-in-note-2026-11-16.md
// §9 item 9). The candidate site before and after hiding is the same for that note.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { pool, q } from "../db.js";
import nodesRouter from "../routes/nodes.js";
import { buildCandidate } from "../modules/website/publishing/snapshot.js";
import type { ActorCtx } from "../types.js";
import { joinDefaultSpace, publishDefaultSpace } from "./helpers/spaceFixtures.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";

registerShippedModules();

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let ws = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));
let actor: ActorCtx;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/api/nodes", nodesRouter);

type SiteNode = { id: string; title: string; markdown: string };
afterAll(async () => { await pool.end(); });

describe.skipIf(!isTestDb)("a note with its 「內容」 tab hidden still publishes (DB)", () => {
  it("publishes the same title and text after the tab is hidden", async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Hidden content', $1) RETURNING id::text`, [randomUUID()])).rows[0]!.id;
    await publishDefaultSpace(ws);
    const a = await q<{ id: string }>(`INSERT INTO actors (workspace_id, name, type) VALUES ($1,'Author','human') RETURNING id`, [ws]);
    actor = { id: a.rows[0]!.id, name: "Author", role: "admin", type: "human" };
    await joinDefaultSpace(ws, actor.id, "admin");
    const spaceId = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [ws])).rows[0]!.id;
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id)
       VALUES ($1,'manual','content','Lecture notes',$2,'Words that stay published.',$3) RETURNING id`,
      [ws, `lecture-${randomUUID().slice(0, 6)}`, spaceId])).rows[0]!.id;
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($1,$2,'_published','true','bool')`, [ws, id]);

    const entry = async () => ((await buildCandidate(ws, { title: "Site" })).payload.nodes as SiteNode[]).find((n) => n.id === id);
    const before = await entry();
    expect(before?.markdown).toContain("Words that stay published.");

    // Another tab is there to show instead (with nothing else, the server keeps 「內容」 showing).
    const other = await app.request(`/api/nodes/${id}/views`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Shelf", layout: "table" }) });
    expect(other.status).toBe(201);
    const hidden = await app.request(`/api/nodes/${id}/views`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Content", layout: "content", layout_config: { hidden: true } }),
    });
    expect(hidden.status, await hidden.clone().text()).toBe(201);

    expect(await entry()).toEqual(before);
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [ws]);
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1`, [ws]);
  });
});
