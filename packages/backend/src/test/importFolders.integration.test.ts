import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q, getWorkspaceId } from "../db.js";
import { apiOnError } from "../httpError.js";
import importRouter from "../modules/importers/routes.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { importObsidianFolders } from "../modules/importers/obsidian/folders.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = isTestDatabase();
const admin: ActorCtx = { id: "import-audit-admin", name: "Import audit", type: "human", role: "admin" };
function appFor(actor = admin) {
  const app = new Hono<{ Variables: { actor: ActorCtx } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/import", importRouter);
  return app;
}
async function importFiles(paths: string[], upsert = true, actor = admin) {
  const response = await appFor(actor).request("/api/import/obsidian", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: { id:"legacy",name:"Older imports" }, files: paths.map(path => ({ path, content: `Body of ${path}` })), upsert }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe.skipIf(!isTestDb)("import folder identity and failed parents", () => {
  let ws: string;
  beforeAll(async () => {
    ws = await getWorkspaceId();
    Object.assign(admin, await persistActor(ws, admin));
  });
  const prefix = () => `匯入-${randomUUID()}`;
  const nodes = (name: string) => q<{ id: string; title: string; parent_id: string | null; markdown: string }>(
    "SELECT id, title, parent_id, markdown FROM content_nodes WHERE workspace_id=$1 AND title=$2 AND deleted_at IS NULL ORDER BY created_at", [ws, name],
  );

  it("reuses every level on unchanged and changed imports; keeps renamed folder contents", async () => {
    const root = prefix();
    const paths = [`${root}/課程/筆記.md`];
    expect(await importFiles(paths)).toMatchObject({ imported: 1, folders: 2 });
    const rootNode = (await nodes(root)).rows[0]!;
    const child = (await q<{ id: string }>("SELECT id FROM content_nodes WHERE parent_id=$1", [rootNode.id])).rows[0]!;
    await seedQ("UPDATE content_nodes SET title='我的課程', markdown='Keep my folder notes' WHERE id=$1", [child.id]);
    expect(await importFiles(paths)).toMatchObject({ imported: 0, unchanged: 1, folders: 0, folders_reused: 2 });
    expect((await nodes(root)).rows).toHaveLength(1);
    expect((await q("SELECT title,markdown FROM content_nodes WHERE id=$1", [child.id])).rows[0]).toMatchObject({ title: "我的課程", markdown: "Keep my folder notes" });
    expect(await importFiles([`${root}/課程/另一筆.md`])).toMatchObject({ imported: 1, folders: 0, folders_reused: 2 });
    expect((await q("SELECT id FROM content_nodes WHERE parent_id=$1", [child.id])).rows).toHaveLength(2);
  });

  it("keeps copy imports separate, and refuses ambiguous repeated folders", async () => {
    const root = prefix();
    const paths = [`${root}/note.md`];
    await importFiles(paths, false);
    expect(await importFiles(paths, false)).toMatchObject({ imported: 1, folders: 1 });
    expect((await nodes(root)).rows).toHaveLength(2);
    expect(await importFiles(paths)).toMatchObject({ imported: 0, skipped: 1, folders: 0, folders_skipped: 1 });
  });

  it("adopts an unambiguous legacy imported folder, but never a handmade namesake", async () => {
    const root = prefix();
    await importFiles([`${root}/a.md`]);
    const folder = (await nodes(root)).rows[0]!;
    await seedQ("DELETE FROM node_attributes WHERE node_id=$1 AND key='_import_folder_path'", [folder.id]);
    expect(await importFiles([`${root}/b.md`])).toMatchObject({ folders: 0, folders_reused: 1 });
    const hand = prefix();
    await seedQ("INSERT INTO content_nodes(workspace_id,source_type,node_type,title,slug,markdown) VALUES($1,'manual','content',$2,$2,'User text')", [ws, hand]);
    expect(await importFiles([`${hand}/c.md`])).toMatchObject({ imported: 1, folders: 1, folders_reused: 0 });
    expect((await nodes(hand)).rows).toHaveLength(2);
  });

  it("serializes concurrent folder resolution before creating children", async () => {
    const root = prefix();
    const results = await Promise.all([importFiles([`${root}/a.md`]), importFiles([`${root}/b.md`])]);
    expect(results.reduce((count, result) => count + result.imported, 0)).toBe(2);
    const folders = (await nodes(root)).rows;
    expect(folders).toHaveLength(1);
    expect((await q("SELECT id FROM content_nodes WHERE parent_id=$1", [folders[0]!.id])).rows).toHaveLength(2);
  });

  it("does not fall back to root when a reused parent is outside the actor's spaces", async () => {
    const root = prefix();
    await importFiles([`${root}/a.md`]);
    // The admin's folder sits in the admin's personal space, which this
    // editor is not in.
    const scoped = await persistActor(ws, { ...admin, role: "editor" });
    expect(await importFiles([`${root}/子層/b.md`], true, scoped)).toMatchObject({ imported: 0, skipped: 1, folders: 0, folders_skipped: 2 });
    expect((await nodes(root)).rows).toHaveLength(1);
    expect((await q("SELECT id FROM node_attributes WHERE key='_import_path' AND value=$1", [`${root}/子層/b.md`])).rows).toHaveLength(0);
  });

  it("never matches an imported folder as a legacy same-title note", async () => {
    const root = prefix();
    expect(await importFiles([`${root}/${root}.md`])).toMatchObject({ imported: 1, updated: 0, folders: 1 });
    const rows = (await nodes(root)).rows;
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.parent_id === null)?.markdown).toBe("");
    expect(rows.find(row => row.parent_id !== null)?.markdown).toContain("Body of");
  });

  it("concurrent imports of the identical file commit one note and one folder", async () => {
    const path = `${prefix()}/同一筆.md`;
    const results = await Promise.all([importFiles([path]), importFiles([path])]);
    expect(results.reduce((count, result) => count + result.imported, 0)).toBe(1);
    expect(results.reduce((count, result) => count + result.unchanged, 0)).toBe(1);
  });

  it("allows an editor to reuse an open parent, but refuses it after read/write access is revoked", async () => {
    const editor = await persistActor(ws, { ...admin, role: "editor" });
    for (const op of ["read", "write_node"] as const) {
      const root = prefix();
      await importFiles([`${root}/a.md`], true, editor);
      expect(await importFiles([`${root}/b.md`], true, editor)).toMatchObject({ imported: 1, folders_reused: 1 });
      const folder = (await nodes(root)).rows[0]!;
      // Revoke: move the folder to a space the editor is not in (read) or
      // only views (write_node); the admin manages it.
      const space = await makeSpace(ws, `import-${root}`, op === "read"
        ? [{ id: admin.id, role: "manager" }]
        : [{ id: admin.id, role: "manager" }, { id: editor.id, role: "viewer" }]);
      await putInSpace(folder.id, space);
      expect(await importFiles([`${root}/c.md`], true, editor)).toMatchObject({ imported: 0, skipped: 1, folders_skipped: 1 });
      expect(await importFiles([`${root}/c.md`])).toMatchObject({ imported: 1, folders_reused: 1 });
    }
  });

  it("refuses a moved folder without moving it back or creating a root duplicate", async () => {
    const root = prefix(), other = prefix();
    await importFiles([`${root}/a.md`, `${other}/b.md`]);
    const folder = (await nodes(root)).rows[0]!, parent = (await nodes(other)).rows[0]!;
    await seedQ("UPDATE content_nodes SET parent_id=$2 WHERE id=$1", [folder.id, parent.id]);
    expect(await importFiles([`${root}/c.md`])).toMatchObject({ imported: 0, skipped: 1, folders_skipped: 1 });
    expect((await nodes(root)).rows).toEqual([expect.objectContaining({ id: folder.id, parent_id: parent.id })]);
  });

  it("does not reuse an identical path from another workspace", async () => {
    const root = prefix();
    const other = (await q<{ id: string }>("INSERT INTO workspaces(name,slug) VALUES($1,$1) RETURNING id", [root])).rows[0]!.id;
    const otherAdmin = await persistActor(other, admin);
    const outside = await importObsidianFolders({ actor: otherAdmin, workspaceId: other, paths: [root], reuse: true });
    expect(await importFiles([`${root}/a.md`])).toMatchObject({ folders: 1, folders_reused: 0 });
    expect((await nodes(root)).rows[0]!.id).not.toBe(outside.ids.get(root));
  });

  it("rolls back folder, identity and success event together on storage failure; a retry succeeds", async () => {
    const root = prefix();
    const before = (await q<{ n: string }>("SELECT count(*) n FROM domain_events WHERE workspace_id=$1", [ws])).rows[0]!.n;
    await q(`ALTER TABLE node_attributes ADD CONSTRAINT import_audit_fail CHECK (key <> '_import_folder_path' OR value <> '${root}')`);
    try {
      const response = await appFor().request("/api/import/obsidian", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ files: [{ path: `${root}/a.md`, content: "body" }], source: { id:"legacy",name:"Older imports" }, upsert: true }),
      });
      expect(response.status).toBe(500);
      expect((await nodes(root)).rows).toHaveLength(0);
      expect((await q<{ n: string }>("SELECT count(*) n FROM domain_events WHERE workspace_id=$1", [ws])).rows[0]!.n).toBe(before);
    } finally { await q("ALTER TABLE node_attributes DROP CONSTRAINT import_audit_fail"); }
    expect(await importFiles([`${root}/a.md`])).toMatchObject({ folders: 1, imported: 1 });
  });
});
