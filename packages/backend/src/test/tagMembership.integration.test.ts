// One membership rule (tagHierarchy.memberTagIds): a tag's members are notes
// carrying the tag, a child tag, or a tag that extends it — for saved views
// and /api/query alike. /api/query also sorts attributes by type like a view.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { getWorkspaceId } from "../db.js";
import queryRouter from "../routes/query.js";
import { executeView } from "../services/collectionViewQuery.js";
import { memberTagIds } from "../services/tagHierarchy.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let actor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
app.route("/api/query", queryRouter);

describe.skipIf(!isTestDb)("tag membership is one rule (DB)", () => {
  const stamp = `${Date.now()}`;
  let WS = "";
  let base = "", child = "", extender = "", unrelated = "";
  const notes: Record<string, string> = {};

  const tag = async (title: string, parentId: string | null, extendsIds: string[] = []) => (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id, tag_schema)
     VALUES ($1,'manual','class_tag',$2,$3,'',$4,$5) RETURNING id`,
    [WS, title, `tm-${title}-${stamp}-${Math.random().toString(36).slice(2, 7)}`, parentId, extendsIds.length ? JSON.stringify({ extends: extendsIds }) : null])).rows[0]!.id;
  const note = async (name: string, tagId: string, amount: string) => {
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$3,'') RETURNING id`, [WS, `${name} ${stamp}`, `tm-${name}-${stamp}`])).rows[0]!.id;
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2)`, [id, tagId]);
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1,$2,'amount',$3,'number','explicit')`, [WS, id, amount]);
    notes[name] = id;
  };

  beforeAll(async () => {
    WS = await getWorkspaceId();
    actor = await persistActor(WS, { id: "tm-admin", name: "Admin", role: "admin", type: "human" });
    base = await tag(`課程${stamp}`, null);
    child = await tag(`演算法${stamp}`, base);
    extender = await tag(`研究所${stamp}`, null, [base]);
    unrelated = await tag(`其他${stamp}`, null);
    await note("direct", base, "10");
    await note("viaChild", child, "9");
    await note("viaExtends", extender, "100");
    await note("outside", unrelated, "1");
  });

  it("memberTagIds covers the tag, its child tags and the tags that extend it", async () => {
    expect(new Set(await memberTagIds(WS, base))).toEqual(new Set([base, child, extender]));
  });

  it("a saved view and /api/query list the same members", async () => {
    const readableIds = Object.values(notes);
    const view = await executeView({ workspaceId: WS, tagId: base, filters: [], sorts: [], visibleFields: [], readableIds } as Parameters<typeof executeView>[0]);
    const viaView = new Set(view.rows.map((r) => r.id));
    const res = await app.request("/api/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tags: [`課程${stamp}`], sort: "amount" }) });
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { rows: Array<{ id: string }> }).rows;
    const expected = new Set([notes.direct, notes.viaChild, notes.viaExtends]);
    expect(viaView).toEqual(expected);
    expect(new Set(rows.map((r) => r.id))).toEqual(expected);
    // Typed sort, like a view: 9, 10, 100 — not the text order 10, 100, 9.
    expect(rows.map((r) => r.id)).toEqual([notes.viaChild, notes.direct, notes.viaExtends]);
  });

  it("several tag names match ANY of them; a name under two parents counts both", async () => {
    const twinParent = await tag(`另一個${stamp}`, null);
    const twin = await tag(`演算法${stamp}`, twinParent); // same title as `child`, other parent
    await note("viaTwin", twin, "5");
    const ask = async (body: unknown) => {
      const res = await app.request("/api/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      expect(res.status).toBe(200);
      return new Set(((await res.json()) as { rows: Array<{ id: string }> }).rows.map((r) => r.id));
    };
    expect(await ask({ tags: [`演算法${stamp}`] })).toEqual(new Set([notes.viaChild, notes.viaTwin]));
    expect(await ask({ tags: [`其他${stamp}`, `演算法${stamp}`] })).toEqual(new Set([notes.outside, notes.viaChild, notes.viaTwin]));
  });

  it("a malformed date value sorts last instead of failing the query", async () => {
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1,$2,'due','2024-02-30','date','explicit')`, [WS, notes.direct]);
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1,$2,'due','2024-01-15','date','explicit')`, [WS, notes.viaChild]);
    const res = await app.request("/api/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tags: [`課程${stamp}`], sort: "due" }) });
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { rows: Array<{ id: string }> }).rows.map((r) => r.id);
    expect(ids.indexOf(notes.viaChild)).toBeLessThan(ids.indexOf(notes.direct));
  });
});
