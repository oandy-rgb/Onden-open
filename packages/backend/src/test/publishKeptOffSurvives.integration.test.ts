// 「不發布」 (`_published` 'false') is the only thing that keeps a note off the site of a space that publishes, so a path that
// drops it makes the note public at the next publish. Each way a note is copied or carried must keep it:
//   · the Markdown export → import (`publish: false` in the frontmatter, Obsidian Publish's own key),
//   · a backup restored as a 「備份」 copy or under a new id (always kept off) and as itself (the backup's value),
//   · a duplicate (noteDuplicate.ts carries a 'false', whoever wrote it),
//   · a block or a selection made a child note of its note (blockChildNote.ts).
// Each test also checks the control: the same note without the mark IS on the site, so the test could fail.
// (A note made new under a kept-off parent is unpublishedParentDefault.integration.test.ts; text pasted into another note is not covered.)
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q, getWorkspaceId } from "../db.js";

let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
import { apiOnError } from "../httpError.js";
import backupRouter from "../routes/backup.js";
import nodesRouter from "../routes/nodes.js";
import { exportedNoteFile } from "../services/exportZip.js";
import { importMarkdownNote } from "../modules/importers/markdown/note.js";
import { stampImportedNote } from "../modules/importers/shared/identity.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { duplicateNote } from "../services/noteDuplicate.js";
import { moveBlockToChildNote, moveSelectionToChildNote } from "../services/blockChildNote.js";
import { ensureBlockAnchor } from "../services/blockAnchors/index.js";
import { restoreSystemAttrs } from "../services/backupSystemAttrs.js";
import { seedQ } from "./helpers/seedQ.js";
import { publishedNodeIds } from "../modules/website/publishing/publishedSet.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { applyAndWait } from "./helpers/restoreJob.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

registerShippedModules();
const enabled = isTestDatabase();

function app(actor: ActorCtx) {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.route("/api/backup", backupRouter);
  hono.route("/api/nodes", nodesRouter);
  return hono;
}
const send = (a: ActorCtx, url: string, method: string, body: unknown = {}) =>
  app(a).request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe.skipIf(!enabled)("「不發布」 survives every path that copies or carries a note", () => {
  let ws = "";
  let solo: ActorCtx;
  let site = "";
  const stamp = randomUUID().slice(0, 6);

  const create = async (title: string, extra: Record<string, unknown> = {}) => {
    const res = await send(solo, "/api/nodes", "POST", { title, markdown: `${title} 的內文。\n`, space_id: site, ...extra });
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const keepOff = async (id: string) => expect((await send(solo, `/api/nodes/${id}/attributes/_published`, "PUT", { value: "false", value_type: "bool" })).status).toBe(200);
  const idsByTitle = async (title: string) => (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = $2 AND deleted_at IS NULL`, [ws, title])).rows.map((r) => r.id);
  const flagOf = async (id: string) => (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = '_published'`, [id])).rows[0]?.value ?? null;

  beforeAll(async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Kept off', $1) RETURNING id::text`, [`kept-off-${randomUUID()}`])).rows[0]!.id;
    ws = await getWorkspaceId();
    solo = await persistActor(ws, { id: "", name: `Solo ${stamp}`, type: "human", role: "editor" });
    await setWorkspaceOwner(ws, solo.id);
    // An import lands in its creator's own space: that one publishes too, so the control notes show up on the site.
    await q(`UPDATE spaces SET capabilities = capabilities || '{"publish": true}'::jsonb WHERE workspace_id = $1`, [ws]);
    site = await makeSpace(ws, `Site ${stamp}`, [{ id: solo.id, permission: "edit" }], { publish: true, external_ai: false, backup: true });
  });

  it("export → import: the exported file carries it and the imported note is kept off the site", async () => {
    const off = await create("Export off");
    await keepOff(off);
    const plain = await create("Export plain");
    const exported = async (id: string) => {
      const row = (await q<{ id: string; slug: string; title: string; markdown: string; updated_at: string }>(`SELECT id::text, slug, title, markdown, updated_at::text FROM content_nodes WHERE id = $1`, [id])).rows[0]!;
      const attributes = (await q<{ key: string; value: string; source: string }>(`SELECT key, value, source FROM node_attributes WHERE node_id = $1`, [id])).rows;
      return exportedNoteFile({ ...row, tags: [] }, attributes, row.markdown);
    };
    const offFile = await exported(off);
    expect(offFile).toMatch(/^publish: false$/m);
    expect(await exported(plain)).not.toMatch(/^publish:/m);

    const source = { id: randomUUID(), name: "kept-off" } as never;
    for (const content of [offFile.replace(/^title: .*$/m, "title: Imported off"), (await exported(plain)).replace(/^title: .*$/m, "title: Imported plain")]) {
      const result = await importMarkdownNote({ actor: solo, workspaceId: ws, source, file: { path: `${randomUUID()}.md`, content }, parentId: null, reuse: false });
      expect(result.status).toBe("imported");
    }
    const [importedOff] = await idsByTitle("Imported off");
    const [importedPlain] = await idsByTitle("Imported plain");
    expect(await flagOf(importedOff!)).toBe("false");
    const published = await publishedNodeIds(ws);
    expect(published.has(importedOff!)).toBe(false);
    expect(published.has(importedPlain!)).toBe(true);
  });

  it("an import that updates an existing note applies the mark too", async () => {
    const source = { id: randomUUID(), name: "kept-off-update" } as never;
    const path = `${randomUUID()}.md`;
    const first = await importMarkdownNote({ actor: solo, workspaceId: ws, source, file: { path, content: "---\ntitle: Update me\n---\nfirst" }, parentId: null, reuse: true });
    expect(first.status).toBe("imported");
    const [id] = await idsByTitle("Update me");
    expect(await publishedNodeIds(ws)).toContain(id);
    const second = await importMarkdownNote({ actor: solo, workspaceId: ws, source, file: { path, content: "---\ntitle: Update me\npublish: false\n---\nsecond" }, parentId: null, reuse: true });
    expect(second.status).toBe("updated");
    expect(await flagOf(id!)).toBe("false");
    expect((await publishedNodeIds(ws)).has(id!)).toBe(false);
  });

  it("a file imported before the mark was read, and unchanged since, gets the mark on the next import", async () => {
    const source = { id: randomUUID(), name: "kept-off-old" } as never;
    const path = `${randomUUID()}.md`;
    const content = "---\ntitle: Old import\npublish: false\n---\nsame text";
    expect((await importMarkdownNote({ actor: solo, workspaceId: ws, source, file: { path, content }, parentId: null, reuse: true })).status).toBe("imported");
    const [id] = await idsByTitle("Old import");
    await asBeforeTheMarkWasRead(id!, source, path);
    expect((await publishedNodeIds(ws)).has(id!)).toBe(true);
    const again = await importMarkdownNote({ actor: solo, workspaceId: ws, source, file: { path, content }, parentId: null, reuse: true });
    expect(again.status).toBe("updated");
    expect(await flagOf(id!)).toBe("false");
    expect((await publishedNodeIds(ws)).has(id!)).toBe(false);
    // A later 「發布」 by the person is not undone by importing the same file again.
    expect((await send(solo, `/api/nodes/${id}/attributes/_published`, "PUT", { value: "true", value_type: "bool" })).status).toBe(200);
    expect((await importMarkdownNote({ actor: solo, workspaceId: ws, source, file: { path, content }, parentId: null, reuse: true })).status).toBe("unchanged");
    expect(await flagOf(id!)).toBe("true");
  });

  // What an import from before the mark was read left: no mark, no record of one applied, and a baseline recorded without it.
  const asBeforeTheMarkWasRead = (id: string, source: never, path: string) => withEventTransaction(ws, async () => {
    await q(`DELETE FROM node_attributes WHERE node_id = $1 AND key = '_published'`, [id]);
    await stampImportedNote(ws, id, source, path);
  });
  const importFile = (source: never, path: string, content: string) =>
    importMarkdownNote({ actor: solo, workspaceId: ws, source, file: { path, content }, parentId: null, reuse: true });

  it("a note imported kept off can be updated by importing the changed file", async () => {
    const source = { id: randomUUID(), name: "kept-off-reimport" } as never;
    const path = `${randomUUID()}.md`;
    expect((await importFile(source, path, "---\ntitle: Reimport off\npublish: false\n---\nfirst")).status).toBe("imported");
    const [id] = await idsByTitle("Reimport off");
    expect(await flagOf(id!)).toBe("false");
    expect((await importFile(source, path, "---\ntitle: Reimport off\npublish: false\n---\nsecond")).status).toBe("updated");
    expect(await flagOf(id!)).toBe("false");
    // The update path records its baseline after the mark too: a third version is not refused.
    expect((await importFile(source, path, "---\ntitle: Reimport off\npublish: false\n---\nthird")).status).toBe("updated");
  });

  it("an older import that gets the mark later can still be updated by the changed file", async () => {
    const source = { id: randomUUID(), name: "kept-off-old-update" } as never;
    const path = `${randomUUID()}.md`;
    const content = "---\ntitle: Old then updated\npublish: false\n---\nsame text";
    expect((await importFile(source, path, content)).status).toBe("imported");
    const [id] = await idsByTitle("Old then updated");
    await asBeforeTheMarkWasRead(id!, source, path);
    expect((await importFile(source, path, content)).status).toBe("updated");
    expect(await flagOf(id!)).toBe("false");
    expect((await importFile(source, path, content.replace("same text", "edited in the vault"))).status).toBe("updated");
    expect(await flagOf(id!)).toBe("false");
  });

  it("putting an imported note back on the site is not reversed by importing the same file again", async () => {
    const source = { id: randomUUID(), name: "kept-off-put-back" } as never;
    const path = `${randomUUID()}.md`;
    const content = "---\ntitle: Put back\npublish: false\n---\nbody";
    expect((await importFile(source, path, content)).status).toBe("imported");
    const [id] = await idsByTitle("Put back");
    // What the site page's 「放回網站」 does: the row is removed.
    expect((await send(solo, `/api/nodes/${id}/attributes/_published`, "DELETE")).status).toBe(200);
    expect((await importFile(source, path, content)).status).toBe("unchanged");
    expect(await flagOf(id!)).toBeNull();
    expect((await publishedNodeIds(ws)).has(id!)).toBe(true);
  });

  it("a duplicate keeps the mark; a 「發布」 is not carried", async () => {
    const off = await create("Dup off");
    await keepOff(off);
    const copyId = String((await duplicateNote({ workspaceId: ws, actor: solo, sourceId: off })).node.id);
    expect(await flagOf(copyId)).toBe("false");
    expect((await publishedNodeIds(ws)).has(copyId)).toBe(false);
    expect((await publishedNodeIds(ws)).has(off)).toBe(false);
    // The control: the copy of a note nobody marked is on the site, so the assertion above could fail.
    const plain = await create("Dup plain");
    const plainCopy = String((await duplicateNote({ workspaceId: ws, actor: solo, sourceId: plain })).node.id);
    expect(await flagOf(plainCopy)).toBeNull();
    expect((await publishedNodeIds(ws)).has(plainCopy)).toBe(true);
  });

  it("a duplicate keeps a 「不發布」 that an agent wrote (not a person's own value)", async () => {
    const off = await create("Dup agent off");
    await keepOff(off);
    await seedQ(`UPDATE node_attributes SET source = 'dispatcher' WHERE node_id = $1 AND key = '_published'`, [off]);
    const copyId = String((await duplicateNote({ workspaceId: ws, actor: solo, sourceId: off })).node.id);
    expect(await flagOf(copyId)).toBe("false");
    expect((await publishedNodeIds(ws)).has(copyId)).toBe(false);
  });

  it("a block made a child note stays off the site with its note; from a plain note the child is on the site", async () => {
    const body = "# 標題\n\n要搬出去的一段文字。\n\n留在原處的一段。\n";
    for (const keepIdentity of [false, true]) {
      const off = await create(`Block off ${keepIdentity}`, { markdown: body });
      await keepOff(off);
      const plain = await create(`Block plain ${keepIdentity}`, { markdown: body });
      const move = async (noteId: string) => {
        const anchor = await ensureBlockAnchor(ws, noteId, body, body.indexOf("要搬出去"), { actor: solo });
        expect(anchor).toBeTruthy();
        return String((await moveBlockToChildNote({ workspaceId: ws, actor: solo, noteId, blockRef: anchor!, fallbackTitle: `Child ${noteId.slice(0, 4)}`, keepIdentity })).childId);
      };
      const offChild = await move(off);
      const plainChild = await move(plain);
      const published = await publishedNodeIds(ws);
      expect(await flagOf(offChild), `keepIdentity ${keepIdentity}`).toBe("false");
      expect(published.has(offChild)).toBe(false);
      expect(published.has(plainChild)).toBe(true); // the control
    }
  });

  it("a selection made a child note stays off the site with its note; from a plain note the child is on the site", async () => {
    const body = "第一段。\n\n選起來的這一段。\n\n最後一段。\n";
    const selection = { from: body.indexOf("選起來"), to: body.indexOf("選起來") + "選起來的這一段。".length, text: "選起來的這一段。" };
    const off = await create("Selection off", { markdown: body });
    await keepOff(off);
    const plain = await create("Selection plain", { markdown: body });
    const offChild = String((await moveSelectionToChildNote({ workspaceId: ws, actor: solo, noteId: off, selection, fallbackTitle: "Sel off child" })).childId);
    const plainChild = String((await moveSelectionToChildNote({ workspaceId: ws, actor: solo, noteId: plain, selection, fallbackTitle: "Sel plain child" })).childId);
    const published = await publishedNodeIds(ws);
    expect(await flagOf(offChild)).toBe("false");
    expect(published.has(offChild)).toBe(false);
    expect(published.has(plainChild)).toBe(true);
  });

  it("a backup restored as a copy is always kept off the site; as itself it keeps the backup's value", async () => {
    const off = await create("Backed off");
    await keepOff(off);
    const plain = await create("Backed plain");
    const zip = Buffer.from(await (await app(solo).request("/api/backup/full.zip")).arrayBuffer());
    // The notes change after the backup, so a merge restore brings each back as a 「備份」 copy next to it.
    for (const id of [off, plain]) expect((await send(solo, `/api/nodes/${id}`, "PATCH", { title: `Changed ${id.slice(0, 4)}` })).status).toBe(200);
    const up = await app(solo).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
    const uploadId = ((await up.json()) as { upload_id: string }).upload_id;
    const done = await applyAndWait(app(solo), uploadId, site, "merge");
    expect(done.status, await done.clone().text()).toBe(200);

    const copies = (await q<{ id: string; title: string }>(`SELECT id::text, title FROM content_nodes WHERE workspace_id = $1 AND title LIKE '%（備份 %' AND deleted_at IS NULL`, [ws])).rows;
    const copyOf = (name: string) => copies.find((c) => c.title.startsWith(name))!;
    expect(copyOf("Backed off")).toBeDefined();
    expect(copyOf("Backed plain")).toBeDefined();
    const published = await publishedNodeIds(ws);
    for (const name of ["Backed off", "Backed plain"]) {
      expect(await flagOf(copyOf(name).id)).toBe("false");
      expect(published.has(copyOf(name).id)).toBe(false);
    }
    // The control: a note of the same space that nobody marked is on the site.
    const control = await create("Control");
    expect((await publishedNodeIds(ws)).has(control)).toBe(true);
  }, 30000);

  it("an empty-mode restore of a backup brings a 「不發布」 back", async () => {
    const off = await create("Round trip off");
    await keepOff(off);
    const target = await makeSpace(ws, `Target ${stamp}`, [{ id: solo.id, permission: "edit" }], { publish: true, external_ai: false, backup: true });
    const zip = Buffer.from(await (await app(solo).request("/api/backup/full.zip")).arrayBuffer());
    const up = await app(solo).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
    const uploadId = ((await up.json()) as { upload_id: string }).upload_id;
    const done = await applyAndWait(app(solo), uploadId, target, "empty");
    expect(done.status, await done.clone().text()).toBe(200);
    const restored = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = 'Round trip off' AND space_id = $2 AND deleted_at IS NULL`, [ws, target])).rows;
    expect(restored).toHaveLength(1);
    expect(await flagOf(restored[0]!.id)).toBe("false");
    expect((await publishedNodeIds(ws)).has(restored[0]!.id)).toBe(false);
  }, 30000);

  it("a note restored under a new id (its own is in use here) is a second copy, kept off the site", async () => {
    const plain = await create("Remapped plain");
    const target = await makeSpace(ws, `Remap ${stamp}`, [{ id: solo.id, permission: "edit" }], { publish: true, external_ai: false, backup: true });
    const zip = Buffer.from(await (await app(solo).request("/api/backup/full.zip")).arrayBuffer());
    const up = await app(solo).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
    const uploadId = ((await up.json()) as { upload_id: string }).upload_id;
    const done = await applyAndWait(app(solo), uploadId, target, "empty");
    expect(done.status, await done.clone().text()).toBe(200);
    const second = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = 'Remapped plain' AND space_id = $2 AND deleted_at IS NULL`, [ws, target])).rows;
    expect(second).toHaveLength(1);
    expect(second[0]!.id).not.toBe(plain);
    expect(await flagOf(second[0]!.id)).toBe("false");
    const published = await publishedNodeIds(ws);
    expect(published.has(second[0]!.id)).toBe(false);
    expect(published.has(plain)).toBe(true); // the original, never marked, is still on the site
  }, 30000);

  it("a note whose id is only in the trash comes back as the backup had it (a 「不發布」 stays), and the preview counts it apart from second copies", async () => {
    const off = await create("Trash off");
    await keepOff(off);
    const plain = await create("Trash plain");
    const target = await makeSpace(ws, `Remap trash ${stamp}`, [{ id: solo.id, permission: "edit" }], { publish: true, external_ai: false, backup: true });
    const zip = Buffer.from(await (await app(solo).request("/api/backup/full.zip")).arrayBuffer());
    for (const id of [off, plain]) expect((await send(solo, `/api/nodes/${id}`, "DELETE")).status).toBe(200);
    const up = await app(solo).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
    const uploadId = ((await up.json()) as { upload_id: string }).upload_id;
    const preview = await app(solo).request(`/api/backup/restore/${uploadId}/preview?space=${target}&mode=empty`);
    expect(preview.status).toBe(200);
    const counts = ((await preview.json()) as { counts: { notes_new_id: number; notes_second_copy: number } }).counts;
    // Their own ids are taken by the deleted originals, which are not live notes here: these two are counted as new
    // places, not as second copies (other tests' live notes in the same backup are the second copies).
    expect(counts.notes_new_id).toBeGreaterThanOrEqual(2);
    const done = await applyAndWait(app(solo), uploadId, target, "empty");
    expect(done.status, await done.clone().text()).toBe(200);
    const back = async (title: string) => (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = $2 AND space_id = $3 AND deleted_at IS NULL`, [ws, title, target])).rows;
    const [offBack] = await back("Trash off");
    const [plainBack] = await back("Trash plain");
    expect(offBack!.id).not.toBe(off);
    expect(await flagOf(offBack!.id)).toBe("false");
    expect((await publishedNodeIds(ws)).has(offBack!.id)).toBe(false);
    // Restored as it was: the note nobody marked follows its space (a restore does not invent a mark for it).
    expect(await flagOf(plainBack!.id)).toBeNull();
  }, 30000);

  it("a restore puts a child back as the backup had it: one put back on the site under a kept-off parent stays on it (no new-note default)", async () => {
    const parent = await create("Restore parent off");
    await keepOff(parent);
    const child = await create("Restore child on", { parent_id: parent });
    expect((await send(solo, `/api/nodes/${child}/attributes/_published`, "DELETE")).status).toBe(200); // 「放回網站」
    expect(await flagOf(child)).toBeNull();
    const target = await makeSpace(ws, `Restore default ${stamp}`, [{ id: solo.id, permission: "edit" }], { publish: true, external_ai: false, backup: true });
    const zip = Buffer.from(await (await app(solo).request("/api/backup/full.zip")).arrayBuffer());
    for (const id of [child, parent]) expect((await send(solo, `/api/nodes/${id}`, "DELETE")).status).toBe(200);
    const up = await app(solo).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
    const uploadId = ((await up.json()) as { upload_id: string }).upload_id;
    expect((await applyAndWait(app(solo), uploadId, target, "empty")).status).toBe(200);
    const back = async (title: string) => (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND title = $2 AND space_id = $3 AND deleted_at IS NULL`, [ws, title, target])).rows[0]!.id;
    const parentBack = await back("Restore parent off");
    const childBack = await back("Restore child on");
    expect(await flagOf(parentBack)).toBe("false");
    expect(await flagOf(childBack)).toBeNull();
    expect((await q<{ parent_id: string | null }>(`SELECT parent_id::text FROM content_nodes WHERE id = $1`, [childBack])).rows[0]!.parent_id).toBe(parentBack);
    const published = await publishedNodeIds(ws);
    expect(published.has(childBack)).toBe(true);
    expect(published.has(parentBack)).toBe(false);
  }, 30000);

  it("a 「不發布」 that cannot be written fails the restore of that note; any other attribute is counted and skipped", async () => {
    const swallow = async (change: () => Promise<unknown>) => { try { await change(); return true; } catch { return false; } };
    const nowhere = randomUUID(); // a note the writes are refused for
    await expect(restoreSystemAttrs(solo, ws, nowhere, [{ key: "_published", value: "false" }], { withPerson: false, published: "as_backed" }, swallow)).rejects.toThrow();
    await expect(restoreSystemAttrs(solo, ws, nowhere, [], { withPerson: false, published: "always_off" }, swallow)).rejects.toThrow();
    // The control: a refused write of another key is counted, not thrown.
    expect(await restoreSystemAttrs(solo, ws, nowhere, [{ key: "_pinned", value: "true" }], { withPerson: false, published: "as_backed" }, swallow)).toBe(1);
  });
});
