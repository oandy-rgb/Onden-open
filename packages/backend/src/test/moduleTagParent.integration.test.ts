// The 功能 layer takes no part in the tag tree (services/parentKind.ts,
// docs/architecture/module-library.md「模型：分層的圖」): a module tag has no
// parent tag and no tag sits under one. New writes are refused with 409
// module_tag_parent — create, reparent (PATCH, merge, undo share
// assertReparent), `#a/b` path typing — and migration 129 repairs old rows.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { pool, q } from "../db.js";
import nodesRouter from "../routes/nodes.js";
import { createTag, tagIdForWrittenName } from "../services/tagHierarchy.js";
import { insertTagRow } from "../services/tagWrites.js";
import { assertReparent } from "../services/nodeTree.js";
import { mergeTags } from "../services/tagMerge.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { ModuleTagParentError } from "../services/parentKind.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);

const J = { "content-type": "application/json" };
const patch = (id: string, body: unknown): Promise<Response> =>
  Promise.resolve(app.request(`/api/nodes/${id}`, { method: "PATCH", headers: J, body: JSON.stringify(body) }));
const row = async (id: string) =>
  (await q<{ parent_id: string | null; title: string; tag_schema: { extends?: string[] } | null }>(
    `SELECT parent_id::text, title, tag_schema FROM content_nodes WHERE id = $1`, [id])).rows[0]!;

describe.skipIf(!isTestDb)("functions stay out of the tag tree", () => {
  const stamp = Date.now();
  let owner: ActorCtx = { id: "mt-owner", name: "Owner", role: "admin", type: "human" };
  let moduleTag = "", plainTag = "";

  const mk = async (label: string, parent: string | null, schema: object | null): Promise<string> =>
    (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id, tag_color, tag_schema)
       VALUES ($1,'manual','class_tag',$2,$3,'',$4,'#888',$5) RETURNING id::text`,
      [WS, `mt${label}${stamp}`, `mt-${label}-${stamp}`, parent, schema ? JSON.stringify(schema) : null])).rows[0]!.id;

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Module tag parent', $1) RETURNING id::text`,
      [`module-tag-parent-${randomUUID()}`])).rows[0]!.id;
    owner = await persistActor(WS, owner);
    currentActor = owner;
    moduleTag = await mk("review", null, { module: "review" });
    plainTag = await mk("plain", null, null);
  });

  it("creating a tag under a module tag is refused; a root tag and a tag under a plain tag work", async () => {
    await expect(createTag({ actor: owner, workspaceId: WS, name: `mtbad${stamp}`, parentId: moduleTag }))
      .rejects.toBeInstanceOf(ModuleTagParentError);
    expect((await q(`SELECT 1 FROM content_nodes WHERE title = $1`, [`mtbad${stamp}`])).rowCount).toBe(0);
    const child = await createTag({ actor: owner, workspaceId: WS, name: `mtok${stamp}`, parentId: plainTag });
    expect((await row(child.id)).parent_id).toBe(plainTag);
  });

  it("inserting a module tag with a parent is refused; at the root it works", async () => {
    await expect(withEventTransaction(WS, () =>
      insertTagRow(WS, { title: `mtmod${stamp}`, parentId: plainTag, schema: { module: "board" } }),
    )).rejects.toBeInstanceOf(ModuleTagParentError);
    expect((await q(`SELECT 1 FROM content_nodes WHERE title = $1`, [`mtmod${stamp}`])).rowCount).toBe(0);
  });

  it("PATCH: a tag cannot move under a module tag, a module tag cannot move under a tag", async () => {
    const res = await patch(plainTag, { parent_id: moduleTag });
    expect(res.status).toBe(409);
    expect((await res.json() as { error: string }).error).toBe("module_tag_parent");
    expect((await row(plainTag)).parent_id).toBeNull();
    const res2 = await patch(moduleTag, { parent_id: plainTag });
    expect(res2.status).toBe(409);
    expect((await res2.json() as { error: string }).error).toBe("module_tag_parent");
    expect((await row(moduleTag)).parent_id).toBeNull();
    // Moving either to the root, or a tag under another plain tag, stays allowed.
    const other = await mk("other", null, null);
    expect((await patch(other, { parent_id: plainTag })).status).toBe(200);
    expect((await patch(other, { parent_id: null })).status).toBe(200);
  });

  it("assertReparent (undo, merge, PATCH share it) refuses both directions", async () => {
    await withEventTransaction(WS, async () => {
      await expect(assertReparent(WS, { id: plainTag, node_type: "class_tag", title: `mtplain${stamp}`, parent_id: null }, moduleTag, owner))
        .rejects.toBeInstanceOf(ModuleTagParentError);
      await expect(assertReparent(WS, { id: moduleTag, node_type: "class_tag", title: `mtreview${stamp}`, parent_id: null }, plainTag, owner))
        .rejects.toBeInstanceOf(ModuleTagParentError);
    });
  });

  it("merging a tag with sub-tags into a module tag is refused and moves nothing", async () => {
    const source = await mk("src", null, null);
    const sub = await mk("srcsub", source, null);
    await expect(mergeTags(owner, WS, source, moduleTag)).rejects.toThrow();
    expect((await row(sub)).parent_id).toBe(source);
  });

  it("typing #模組/子標籤 refuses instead of creating a function link; typing the module alone resolves it", async () => {
    await expect(tagIdForWrittenName(WS, `mtreview${stamp}/child`, { create: true, actor: owner }))
      .rejects.toBeInstanceOf(ModuleTagParentError);
    expect((await q(`SELECT 1 FROM content_nodes WHERE title = 'child' AND parent_id = $1`, [moduleTag])).rowCount).toBe(0);
    expect((await tagIdForWrittenName(WS, `mtreview${stamp}`, { create: true, actor: owner })).id).toBe(moduleTag);
  });

  it("migration 129: module tag → root; tag under a module tag → root + extends it; repeatable; notes untouched", async () => {
    const sql = readFileSync(fileURLToPath(new URL("../../db/migrations/129_module_tags_out_of_tag_tree.sql", import.meta.url)), "utf8");
    const mod = await mk("migmod", null, { module: "board" });
    const holder = await mk("holder", null, null);
    // Legacy rows the guard now refuses are written directly.
    await seedQ(`UPDATE content_nodes SET parent_id = $2 WHERE id = $1`, [mod, holder]);
    const under = await mk("under", moduleTag, null);
    const grand = await mk("grand", under, { fields: [] });
    const withExt = await mk("withext", moduleTag, { extends: ["keep-me"] });
    const note = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$3,'body') RETURNING id::text`, [WS, `mtnote${stamp}`, `mt-note-${stamp}`])).rows[0]!.id;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(sql);
      await client.query("COMMIT");
    } finally { client.release(); }
    expect((await row(mod)).parent_id).toBeNull();
    const moved = await row(under);
    expect(moved.parent_id).toBeNull();
    expect(moved.tag_schema?.extends).toEqual([moduleTag]);
    expect((await row(grand)).parent_id).toBe(under);
    const kept = await row(withExt);
    expect(kept.parent_id).toBeNull();
    expect(kept.tag_schema?.extends).toEqual(["keep-me", moduleTag]);
    expect((await row(note)).title).toBe(`mtnote${stamp}`);
  });
});
