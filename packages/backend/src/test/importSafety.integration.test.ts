import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q, getWorkspaceId } from "../db.js";
import { apiOnError } from "../httpError.js";
import importRouter from "../modules/importers/routes.js";
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import { syncFrontmatterAttributes } from "../services/nodes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { seedQ } from "./helpers/seedQ.js";

const isTestDb = isTestDatabase();
const admin: ActorCtx = { id: "import-safety-admin", name: "Import safety", type: "human", role: "admin" };
const source = (name = "相同資料夾名稱") => ({ id: randomUUID(), name });
function appFor(actor = admin) {
  const app = new Hono<{ Variables: { actor: ActorCtx } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/import", importRouter);
  return app;
}
async function upload(from: { id: string; name: string }, content: string, path = "課程/note.md", actor = admin) {
  const response = await appFor(actor).request("/api/import/obsidian", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: from, upsert: true, files: [{ path, content }] }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe.skipIf(!isTestDb)("import source identity and local edit protection", () => {
  let ws: string;
  beforeAll(async () => {
    ws = await getWorkspaceId();
    Object.assign(admin, await persistActor(ws, admin));
  });
  const bySource = (id: string) => q<{ id: string; title: string; markdown: string; parent_id: string | null }>(
    `SELECT n.id,n.title,n.markdown,n.parent_id FROM content_nodes n
     JOIN node_attributes s ON s.node_id=n.id AND s.key='_import_source_id' AND s.value=$2
     WHERE n.workspace_id=$1 AND EXISTS (SELECT 1 FROM node_attributes p WHERE p.node_id=n.id AND p.key='_import_path')`, [ws,id]);

  it("isolates identical paths and folder names across sources, then updates each original ID", async () => {
    const a = source(), b = source();
    expect(await upload(a, "red")).toMatchObject({ imported: 1, folders: 1 });
    expect(await upload(b, "blue")).toMatchObject({ imported: 1, updated: 0, folders: 1 });
    const first = (await bySource(a.id)).rows[0]!;
    const second = (await bySource(b.id)).rows[0]!;
    expect(first.id).not.toBe(second.id);
    expect(first.parent_id).not.toBe(second.parent_id);
    expect(await upload(a, "red v2")).toMatchObject({ updated: 1, folders_reused: 1 });
    expect((await bySource(a.id)).rows[0]).toMatchObject({ id: first.id, markdown: "red v2" });
    expect((await bySource(b.id)).rows[0]).toMatchObject({ id: second.id, markdown: "blue" });
  });

  it("re-imports a note with inline key:: value attributes again and again (derived attributes aren't local changes)", async () => {
    const from = source(`inline-${randomUUID().slice(0, 6)}`);
    const path = `inline/${randomUUID().slice(0, 6)}.md`;
    const derived = async (id: string, value: string) => {
      for (let i = 0; i < 50; i++) {
        const row = (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id=$1 AND key='status'`, [id])).rows[0];
        if (row?.value === value) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`status never became ${value}`);
    };
    expect(await upload(from, "v1\n\nstatus:: draft", path)).toMatchObject({ imported: 1 });
    const id = (await bySource(from.id)).rows[0]!.id;
    await derived(id, "draft");
    expect(await upload(from, "v2\n\nstatus:: review", path)).toMatchObject({ updated: 1 });
    await derived(id, "review");
    // The second update used to be refused as local_changes: the baseline was
    // stamped before the inline attribute was derived after commit.
    expect(await upload(from, "v3\n\nstatus:: done", path)).toMatchObject({ updated: 1 });
    await derived(id, "done");
    expect((await bySource(from.id)).rows[0]!.markdown).toBe("v3\n\nstatus:: done");
  });

  it("preserves later body edits and does not create tags/events on a refused update", async () => {
    const from = source(), path = `note-${randomUUID()}.md`;
    await upload(from, "imported", path);
    const node = (await bySource(from.id)).rows[0]!;
    await seedQ("UPDATE content_nodes SET markdown='My newer study notes' WHERE id=$1", [node.id]);
    const before = (await q("SELECT count(*)::int n FROM domain_events WHERE workspace_id=$1", [ws])).rows[0].n;
    const tag = `refused-${randomUUID()}`;
    expect(await upload(from, `---\ntags: [${tag}]\n---\nsource changed`, path)).toMatchObject({
      imported: 0, updated: 0, skipped: 1, conflicts: [{ path, reason: "local_changes" }],
    });
    expect((await bySource(from.id)).rows[0]!.markdown).toBe("My newer study notes");
    expect((await q("SELECT id FROM content_nodes WHERE workspace_id=$1 AND title=$2", [ws,tag])).rows).toHaveLength(0);
    expect((await q("SELECT count(*)::int n FROM domain_events WHERE workspace_id=$1", [ws])).rows[0].n).toBe(before);
  });

  it("preserves title, property and parent edits; an unchanged reimport never approves later overwrites", async () => {
    for (const change of ["title", "attribute", "parent"]) {
      const from = source(), path = `${randomUUID()}/note.md`;
      await upload(from, "original", path);
      const node = (await bySource(from.id)).rows[0]!;
      if (change === "title") await seedQ("UPDATE content_nodes SET title='My name' WHERE id=$1", [node.id]);
      if (change === "parent") await seedQ("UPDATE content_nodes SET parent_id=NULL WHERE id=$1", [node.id]);
      if (change === "attribute") await seedQ("INSERT INTO node_attributes(workspace_id,node_id,key,value,source) VALUES($1,$2,'status','personal','ui')", [ws,node.id]);
      await upload(from, "original", path);
      expect(await upload(from, "external update", path)).toMatchObject({ updated: 0, skipped: 1, conflicts: [{ path, reason: "local_changes" }] });
      expect((await bySource(from.id)).rows[0]!.markdown).toBe("original");
    }
  });

  it("never claims a handmade same-title note, or overwrites a legacy note without a baseline", async () => {
    const title = `hand-${randomUUID()}`, from = source();
    const hand = (await seedQ("INSERT INTO content_nodes(workspace_id,source_type,node_type,title,slug,markdown) VALUES($1,'manual','content',$2,$2,'Personal') RETURNING id", [ws,title])).rows[0].id;
    expect(await upload(from, `---\ntitle: ${title}\n---\nImported`, `${title}.md`)).toMatchObject({ imported: 1, updated: 0 });
    expect((await q("SELECT markdown FROM content_nodes WHERE id=$1", [hand])).rows[0].markdown).toBe("Personal");
    const node = (await bySource(from.id)).rows[0]!;
    await seedQ("DELETE FROM node_attributes WHERE node_id=$1 AND key='_import_baseline'", [node.id]);
    expect(await upload(from, "Changed", `${title}.md`)).toMatchObject({ updated: 0, conflicts: [{ reason: "history_incomplete", path: `${title}.md` }] });
  });

  it("source listing follows current role and scope, and a refused target does not fork", async () => {
    const from = source(`private-${randomUUID()}`), path = `private-${randomUUID()}.md`;
    await upload(from, "Private", path);
    const node = (await bySource(from.id)).rows[0]!;
    const editor = await persistActor(ws, { ...admin, name: "Editor", role: "editor" });
    await putInSpace(node.id, await adminOnlySpace(ws, `private-${randomUUID()}`, [admin.id]));
    for (const actor of [editor]) { // in the default space, not the private one
      const response = await appFor(actor).request("/api/import/sources");
      expect(response.status).toBe(200);
      expect((await response.json()).sources).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: from.id })]));
      expect(await upload(from, "Private", path, actor)).toMatchObject({ imported: 0, updated: 0, unchanged: 0, skipped: 1 });
    }
    expect((await bySource(from.id)).rows).toHaveLength(1);
    const listed = await (await appFor().request("/api/import/sources")).json();
    expect(listed.sources).toEqual(expect.arrayContaining([expect.objectContaining(from)]));
  });

  it("does not recreate deleted notes or choose one of multiple matching copies", async () => {
    const from = source(), path = `deleted-${randomUUID()}.md`;
    await upload(from,"Keep deleted",path);
    const node = (await bySource(from.id)).rows[0]!;
    await seedQ("UPDATE content_nodes SET deleted_at=now() WHERE id=$1",[node.id]);
    expect(await upload(from,"Restored without asking",path)).toMatchObject({imported:0,skipped:1,conflicts:[{path,reason:"unavailable"}]});
    await seedQ("UPDATE content_nodes SET deleted_at=NULL WHERE id=$1",[node.id]);
    const copy = await appFor().request("/api/import/obsidian", {method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({source:from,upsert:false,files:[{path,content:"A separate copy"}]})});
    expect(copy.status).toBe(200);
    expect(await upload(from,"Do not choose one",path)).toMatchObject({updated:0,skipped:1,conflicts:[{path,reason:"ambiguous"}]});
    expect((await bySource(from.id)).rows).toHaveLength(2);
  });

  it("serializes identical uploads and records a baseline usable by a later request", async () => {
    const from = source(), path = `${randomUUID()}/note.md`;
    const results = await Promise.all([upload(from,"v1",path),upload(from,"v1",path)]);
    expect(results.reduce((n,r) => n+r.imported,0)).toBe(1);
    expect(results.reduce((n,r) => n+r.unchanged,0)).toBe(1);
    expect(await upload(from,"v2",path)).toMatchObject({updated:1});
    expect((await bySource(from.id)).rows).toHaveLength(1);
  });

  it("rolls back note, newly resolved tags, baseline and events on DB failure; retry succeeds", async () => {
    const from = source(), tag = `rollback-${randomUUID()}`, path = `${randomUUID()}.md`;
    const content = `---\ntags: [${tag}/a, ${tag}/b]\n---\nbody`;
    const count = async () => (await q("SELECT count(*)::int n FROM domain_events WHERE workspace_id=$1",[ws])).rows[0].n;
    const before = await count();
    await q("ALTER TABLE node_attributes ADD CONSTRAINT import_baseline_fault CHECK (key <> '_import_baseline') NOT VALID");
    try {
      const failed = await appFor().request("/api/import/obsidian",{method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({source:from,upsert:true,files:[{path,content}]})});
      expect(failed.status).toBe(500);
      expect((await bySource(from.id)).rows).toHaveLength(0);
      expect((await q("SELECT id FROM content_nodes WHERE workspace_id=$1 AND title=$2",[ws,tag])).rows).toHaveLength(0);
      expect(await count()).toBe(before);
    } finally { await q("ALTER TABLE node_attributes DROP CONSTRAINT import_baseline_fault"); }
    expect(await upload(from,content,path)).toMatchObject({imported:1});
    expect(await upload(from,content+"\nnew",path)).toMatchObject({updated:1});
  });

  it("user frontmatter cannot rewrite source identity or approve a new baseline", async () => {
    const from = source(), path = `${randomUUID()}.md`;
    await upload(from,"original",path);
    const node = (await bySource(from.id)).rows[0]!;
    const stamp = async () => (await q("SELECT key,value,source FROM node_attributes WHERE node_id=$1 AND left(key,8)='_import_' ORDER BY key",[node.id])).rows;
    const before = await stamp();
    await syncFrontmatterAttributes(ws,node.id,`---\n_import_path: stolen.md\n_import_source_id: ${randomUUID()}\n_import_baseline: forged\n---\ntext`,admin);
    expect(await stamp()).toEqual(before);
  });

  it("rejects missing source for updates and malformed/duplicate paths before any writes", async () => {
    const before = (await q("SELECT count(*)::int n FROM domain_events WHERE workspace_id=$1",[ws])).rows[0].n;
    for (const payload of [
      {upsert:true,files:[{path:"a.md",content:"x"}]},
      {source:source(),files:[{path:"../a.md",content:"x"}]},
      {source:source(),files:[{path:"a/./b.md",content:"x"},{path:"a/b.md",content:"y"}]},
      {source:source(),files:[{path:"a.md",content:25}]},
    ]) {
      const response = await appFor().request("/api/import/obsidian",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
      expect(response.status).toBe(400);
    }
    expect((await q("SELECT count(*)::int n FROM domain_events WHERE workspace_id=$1",[ws])).rows[0].n).toBe(before);
  });
});
