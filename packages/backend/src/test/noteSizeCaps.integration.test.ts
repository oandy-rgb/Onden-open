// D67: the note size caps (@onden/markdown noteLimits.ts) hold on every path
// that stores a note, not only at the REST edge. Before, a 2.1M-character
// Obsidian file imported fine and every later edit of it was a 400; now an
// over-size body is skipped as `too_large` by each importer (Obsidian /
// Markdown notes, Notion row pages), createNote and applyBodyChange refuse
// one, and a title derived from content (a file name, a frontmatter title, a
// CSV cell, a duplicate's "(Copy)") is cut to the cap and reported.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q, getWorkspaceId } from "../db.js";
import { apiOnError } from "../httpError.js";
import importRouter from "../modules/importers/routes.js";
import nodesRouter from "../routes/nodes.js";
import { createNote } from "../services/noteCreate.js";
import { applyBodyChange } from "../services/bodySideEffects.js";
import { importMarkdownNote } from "../modules/importers/markdown/note.js";
import { importNotionDatabases } from "../modules/importers/notion/database.js";
import { NoteSizeError } from "../services/noteSize.js";
import { awaitAllDispatchers } from "../services/dispatcherQueue.js";
import { NODE_MARKDOWN_MAX, NODE_TITLE_MAX } from "../utils.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { isTestDatabase } from "./helpers/testDatabase.js";

const admin: ActorCtx = { id: "d67-size-admin", name: "Size caps", type: "human", role: "admin" };
const stamp = randomUUID().slice(0, 8);
const big = "x".repeat(NODE_MARKDOWN_MAX + 100_000);
// An over-long title per test: two tests importing the same title would
// meet each other's note (the Obsidian import then finds the title taken).
const longTitleFor = (tag: string) => `L${stamp}${tag}`.padEnd(600, "長");

const app = new Hono<{ Variables: { actor: ActorCtx } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", admin); await next(); });
app.route("/api/import", importRouter);
app.route("/api/nodes", nodesRouter);
const send = (method: string, path: string, body: unknown) => app.request(path, {
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

describe.skipIf(!isTestDatabase())("note size caps on every write path (D67)", () => {
  let ws = "";
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    ws = await getWorkspaceId();
    Object.assign(admin, await persistActor(ws, admin));
  });

  it("skips an Obsidian file over the body cap as too_large instead of storing a note no edit can save", async () => {
    const source = { id: randomUUID(), name: `d67-${stamp}` };
    const res = await send("POST", "/api/import/obsidian", { source, upsert: true, files: [
      { path: `big-${stamp}.md`, content: big },
      { path: `ok-${stamp}.md`, content: "fits" },
    ] });
    expect(res.status).toBe(200);
    const out = await res.json() as { imported: number; skipped: number; conflicts: Array<{ path: string; reason: string }> };
    expect(out).toMatchObject({ imported: 1, skipped: 1, conflicts: [{ path: `big-${stamp}.md`, reason: "too_large" }] });
    const stored = await q(`SELECT 1 FROM content_nodes WHERE workspace_id=$1 AND title=$2`, [ws, `big-${stamp}`]);
    expect(stored.rows).toHaveLength(0);
  });

  it("a folder import skips a file holding U+0000 with a reason and imports the rest", async () => {
    const source = { id: randomUUID(), name: `nul-${stamp}` };
    const res = await send("POST", "/api/import/obsidian", { source, upsert: true, files: [
      { path: `nul-${stamp}.md`, content: "bad\u0000text" },
      { path: `fine-${stamp}.md`, content: "fine" },
    ] });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ imported: 1, skipped: 1, conflicts: [{ path: `nul-${stamp}.md`, reason: "invalid_text" }] });
    await awaitAllDispatchers();
  });

  it("a PATCH holding U+0000 is a 400, not a database error", async () => {
    const created = await (await send("POST", "/api/nodes", { title: `nulpatch-${stamp}`, markdown: "x" })).json() as { id: string };
    const res = await send("PATCH", `/api/nodes/${created.id}`, { markdown: "a\u0000b" });
    expect(res.status).toBe(400);
  });

  it("cuts an over-long Obsidian title to the cap, reports it, and the note's first edit saves", async () => {
    const longTitle = longTitleFor("o");
    const source = { id: randomUUID(), name: `d67-title-${stamp}` };
    const res = await send("POST", "/api/import/obsidian", { source, upsert: true, files: [
      { path: `fm-${stamp}.md`, content: `---\ntitle: ${longTitle}\n---\nbody` },
    ] });
    const out = await res.json() as { imported: number; titles_truncated: Array<{ path: string }> };
    expect(out.imported).toBe(1);
    expect(out.titles_truncated).toEqual([{ path: `fm-${stamp}.md` }]);
    const row = (await q<{ id: string; title: string }>(
      `SELECT id, title FROM content_nodes WHERE workspace_id=$1 AND title LIKE $2 AND deleted_at IS NULL`, [ws, `L${stamp}o%`])).rows[0]!;
    expect(row.title).toBe(longTitle.slice(0, NODE_TITLE_MAX));
    const edit = await send("PATCH", `/api/nodes/${row.id}`, { markdown: "edited" });
    expect(edit.status, await edit.clone().text()).toBe(200);
    // Importing the file again compares against the cut title: the only
    // difference is the edit made in Onden, which the import keeps.
    const again = await (await send("POST", "/api/import/obsidian", { source, upsert: true, files: [
      { path: `fm-${stamp}.md`, content: `---\ntitle: ${longTitle}\n---\nbody` },
    ] })).json() as { conflicts: Array<{ path: string; reason: string }> };
    expect(again.conflicts).toEqual([{ path: `fm-${stamp}.md`, reason: "local_changes" }]);
    await awaitAllDispatchers();
  });

  it("importMarkdownNote: too_large for a body over the cap, a title cut from the file name", async () => {
    const source = { id: randomUUID(), name: `d67-md-${stamp}` };
    const base = { actor: admin, workspaceId: ws, source, parentId: null, reuse: true };
    expect(await importMarkdownNote({ ...base, file: { path: `m-${stamp}.md`, content: big } }))
      .toEqual({ status: "refused", reason: "too_large" });
    const name = `F${stamp}`.padEnd(520, "f");
    expect(await importMarkdownNote({ ...base, file: { path: `${name}.md`, content: "short" } }))
      .toEqual({ status: "imported", nodeId: expect.any(String), titleTruncated: true });
    const titles = await q<{ title: string }>(`SELECT title FROM content_nodes WHERE workspace_id=$1 AND title LIKE $2`, [ws, `F${stamp}%`]);
    expect(titles.rows.map(r => r.title)).toEqual([name.slice(0, NODE_TITLE_MAX)]);
    await awaitAllDispatchers();
  });

  it("Notion/CSV: a row page over the cap is skipped as too_large, a long title cell is cut and reported", async () => {
    const pageId = "fedcba9876543210fedcba9876543210";
    const longTitle = longTitleFor("n");
    const rowTitle = `Row ${stamp}`;
    const result = await importNotionDatabases(ws,
      [{ path: `D67 DB ${stamp}.csv`, content: `Name,Status\n${rowTitle} ${pageId},Open\n${longTitle},Done\n` }],
      [{ path: `D67 DB ${stamp}/${rowTitle} ${pageId}.md`, content: big }],
      admin);
    expect(result.rows).toBe(2);
    expect(result.bodiesAttached).toBe(0);
    expect(result.bodiesSkipped).toEqual([{ path: `D67 DB ${stamp}/${rowTitle} ${pageId}.md`, reason: "too_large" }]);
    expect(result.titlesTruncated).toEqual([{ path: `D67 DB ${stamp}.csv`, row: 2 }]);
    const cut = (await q<{ title: string; markdown: string }>(
      `SELECT title, markdown FROM content_nodes WHERE workspace_id=$1 AND title LIKE $2`, [ws, `L${stamp}n%`])).rows;
    expect(cut.map(r => r.title)).toContain(longTitle.slice(0, NODE_TITLE_MAX));
    // The row with the over-size page is in, without its body.
    const row = (await q<{ markdown: string }>(
      `SELECT markdown FROM content_nodes WHERE workspace_id=$1 AND title=$2`, [ws, `${rowTitle} ${pageId}`])).rows[0]!;
    expect(row.markdown).toBe("");
    await awaitAllDispatchers();
  });

  it("the folder import reports a Notion row page over the cap among the files not imported", async () => {
    const pageId = "0011223344556677889900aabbccddee";
    const res = await send("POST", "/api/import/obsidian", { source: { id: randomUUID(), name: `d67-db-${stamp}` }, upsert: true, files: [
      { path: `Dbx ${stamp}.csv`, content: `Name\nPage ${pageId}\n` },
      { path: `Dbx ${stamp}/Page ${pageId}.md`, content: big },
    ] });
    const out = await res.json() as { skipped: number; conflicts: Array<{ path: string; reason: string }>; collection_rows_imported: number };
    expect(out.collection_rows_imported).toBe(1);
    expect(out.conflicts).toEqual([{ path: `Dbx ${stamp}/Page ${pageId}.md`, reason: "too_large" }]);
    expect(out.skipped).toBe(1);
    await awaitAllDispatchers();
  });

  it("createNote and applyBodyChange refuse a note over a cap", async () => {
    const event = { uiContext: "test.d67" };
    await expect(createNote({ actor: admin, workspaceId: ws, title: "too big", markdown: big, event }))
      .rejects.toMatchObject({ code: "too_large" });
    await expect(createNote({ actor: admin, workspaceId: ws, title: "t".repeat(NODE_TITLE_MAX + 1), event }))
      .rejects.toBeInstanceOf(NoteSizeError);
    await expect(applyBodyChange({ workspaceId: ws, nodeId: randomUUID(), title: "t", markdown: big, previousMarkdown: null, eventId: randomUUID(),
      actor: admin, cascadeLabel: "test.d67", backupPrefix: "TEST" })).rejects.toMatchObject({ code: "too_large" });
    const atCap = await createNote({ actor: admin, workspaceId: ws, title: `C${stamp}`.padEnd(NODE_TITLE_MAX, "c"), event });
    expect((atCap.node.title as string).length).toBe(NODE_TITLE_MAX);
    // Its copy keeps " (Copy)" within the cap.
    const copy = await send("POST", `/api/nodes/${atCap.node.id as string}/duplicate`, {});
    expect(copy.status, await copy.clone().text()).toBe(201);
    const copied = await copy.json() as { title: string };
    expect(copied.title.length).toBe(NODE_TITLE_MAX);
    expect(copied.title.endsWith(" (Copy)")).toBe(true);
    await awaitAllDispatchers();
  });
});
