// Soft-deleting a node cascades to its whole live subtree (M5): trashing a
// parent trashes its descendants, and undeleting the parent brings them all
// back. Without the cascade, children kept a parent_id pointing at a trashed
// node (orphaned) and fell out of the parent's read-policy ancestor cascade.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import nodesRouter from "../routes/nodes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);

const del = (id: string): Promise<Response> => Promise.resolve(app.request(`/api/nodes/${id}`, { method: "DELETE" }));
const undel = (id: string): Promise<Response> =>
  Promise.resolve(app.request(`/api/nodes/${id}/undelete`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
const isTrashed = async (id: string): Promise<boolean> =>
  (await q<{ d: string | null }>(`SELECT deleted_at AS d FROM content_nodes WHERE id=$1`, [id])).rows[0]!.d !== null;

describe.skipIf(!isTestDb)("soft-delete cascades to the subtree, reversibly (M5)", () => {
  let WS = "";
  const stamp = Date.now();
  let trees = 0;

  const mk = async (label: string, parent: string | null): Promise<string> =>
    (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id, hidden, sort_order)
       VALUES ($1,'manual','content',$2,$3,'body',$4,false,0) RETURNING id`,
      [WS, `cd ${label} ${stamp}`, `cd-${label}-${stamp}`, parent],
    )).rows[0]!.id;

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    currentActor = await persistActor(WS, { id: "cd-admin", name: "Admin", role: "admin", type: "human" });
  });

  // Each test gets its own tree.
  const tree = async () => {
    const n = ++trees;
    const p = await mk(`parent${n}`, null);
    const c = await mk(`child${n}`, p);     // child of p
    const g = await mk(`grand${n}`, c);     // grandchild (child of c)
    const u = await mk(`unrelated${n}`, null);
    return { p, c, g, u };
  };

  it("deleting a parent trashes its whole live subtree; an unrelated node is untouched", async () => {
    const { p, c, g, u } = await tree();
    expect((await del(p)).status).toBe(200);
    expect(await isTrashed(p), "parent trashed").toBe(true);
    expect(await isTrashed(c), "child trashed").toBe(true);
    expect(await isTrashed(g), "grandchild trashed").toBe(true);
    expect(await isTrashed(u), "unrelated NOT trashed").toBe(false);
  });

  it("undeleting the parent brings the whole subtree back", async () => {
    const { p, c, g } = await tree();
    expect((await del(p)).status).toBe(200);
    expect((await undel(p)).status).toBe(200);
    expect(await isTrashed(p), "parent restored").toBe(false);
    expect(await isTrashed(c), "child restored").toBe(false);
    expect(await isTrashed(g), "grandchild restored").toBe(false);
    // parent_id links intact — the subtree is whole again, not orphaned.
    const links = await q<{ id: string; parent_id: string | null }>(
      `SELECT id, parent_id FROM content_nodes WHERE id = ANY($1::uuid[])`, [[c, g]],
    );
    const byId = Object.fromEntries(links.rows.map((r) => [r.id, r.parent_id]));
    expect(byId[c]).toBe(p);
    expect(byId[g]).toBe(c);
  });
});
