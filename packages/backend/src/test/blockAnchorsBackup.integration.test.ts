// A workspace's backup carries its paragraph anchors, and importing one follows the restore rule:
// docs/architecture/proposals/block-anchors-2026-11-01.md §10, batch 0 (a full backup is the
// workspace export; restoring it is the import).
//   * into another workspace the anchors come back on the restored notes, same ids, same text;
//   * into the workspace they came from the ids are taken (an id is never reused), so they are
//     skipped and the originals are left as they were;
//   * a note whose blocks carry `{標籤}` and a task line (their identity is only the anchor: the text has no `^id`)
//     comes back with its block rows and its task answering to the same ids.
// SAFETY: only runs against a *_test database; skips otherwise.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import backupRouter from "../routes/backup.js";
import { createNote } from "../services/noteCreate.js";
import { ensureBlockAnchor, listNoteAnchors } from "../services/blockAnchors/index.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { applyAndWait } from "./helpers/restoreJob.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import type { RestoreReport } from "@onden/contract";

let currentWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => currentWorkspace }));
registerShippedModules();

const enabled = isTestDatabase();
const A = "二分搜尋要先排序，再比較中間值，找不到就縮小範圍。";
const B = "雜湊表用鍵直接算出位置，碰撞要另外處理，例如鏈結法。";
const BODY = `${A}\n\n${B}\n`;

const app = (actor: ActorCtx) => {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.route("/api/backup", backupRouter);
  return hono;
};

async function newWorkspace(label: string): Promise<{ ws: string; owner: ActorCtx; space: string }> {
  const ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id::text`, [label, `${label}-${randomUUID()}`])).rows[0]!.id;
  const owner = await persistActor(ws, { id: "", name: `${label} owner`, type: "human", role: "editor" });
  await setWorkspaceOwner(ws, owner.id);
  await q(`DELETE FROM space_members m USING spaces s WHERE m.space_id = s.id AND m.actor_id = $1 AND s.kind <> 'personal'`, [owner.id]);
  const space = await makeSpace(ws, `${label} space`, [{ id: owner.id, permission: "edit" }]);
  return { ws, owner, space };
}

async function restoreInto(from: { owner: ActorCtx }, zip: Buffer, space: string): Promise<RestoreReport> {
  const hono = app(from.owner);
  const up = await hono.request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
  expect(up.status, await up.clone().text()).toBe(200);
  const uploadId = ((await up.json()) as { upload_id: string }).upload_id;
  const res = await applyAndWait(hono, uploadId, space, "empty");
  expect(res.status, await res.clone().text()).toBe(200);
  return await res.json() as RestoreReport;
}

describe.skipIf(!enabled)("anchors in a backup (DB)", () => {
  let source: Awaited<ReturnType<typeof newWorkspace>>;
  let noteId = "";
  let anchorIds: string[] = [];
  let zip: Buffer;

  const noteIn = async (ws: string, space: string) => (await q<{ id: string; markdown: string }>(
    `SELECT id::text, markdown FROM content_nodes WHERE workspace_id = $1 AND space_id = $2 AND title = $3 AND deleted_at IS NULL`, [ws, space, "Anchored note"])).rows[0]!;

  beforeAll(async () => {
    source = await newWorkspace("anchors-src");
    currentWorkspace = source.ws;
    noteId = String((await createNote({ actor: source.owner, workspaceId: source.ws, title: "Anchored note", markdown: BODY, spaceId: source.space, event: { uiContext: "test.anchors" } })).node.id);
    const body = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [noteId])).rows[0]!.markdown;
    anchorIds = [];
    for (const t of [A, B]) anchorIds.push((await ensureBlockAnchor(source.ws, noteId, body, body.indexOf(t), { actor: source.owner }))!);
    const res = await app(source.owner).request("/api/backup/full.zip");
    expect(res.status).toBe(200);
    zip = Buffer.from(await res.arrayBuffer());
  });

  afterEach(() => { vi.unstubAllEnvs(); currentWorkspace = source.ws; });

  it("into another workspace the anchors come back on the restored note: same ids, same paragraphs", async () => {
    const target = await newWorkspace("anchors-dst");
    currentWorkspace = target.ws;
    await restoreInto(target, zip, target.space);
    const restored = await noteIn(target.ws, target.space);
    const anchors = await listNoteAnchors(target.ws, restored.id);
    expect(anchors.map((a) => a.anchorId).sort()).toEqual([...anchorIds].sort());
    expect(anchors.every((a) => a.status === "valid")).toBe(true);
    const texts = anchors.sort((x, y) => x.span.from - y.span.from).map((a) => restored.markdown.slice(a.span.from, a.span.to));
    expect(texts).toEqual([A, B]);
  });

  it("into the workspace they came from the ids are taken: skipped, the originals untouched", async () => {
    currentWorkspace = source.ws;
    const before = await listNoteAnchors(source.ws, noteId);
    const space2 = await makeSpace(source.ws, "anchors-src second", [{ id: source.owner.id, permission: "edit" }]);
    await restoreInto(source, zip, space2);
    const copy = await noteIn(source.ws, space2);
    expect(copy.id).not.toBe(noteId);
    expect(await listNoteAnchors(source.ws, copy.id)).toEqual([]);
    expect(await listNoteAnchors(source.ws, noteId)).toEqual(before);
  });

  it("a note with tagged blocks and a task line round-trips through a backup: same ids, rows, tags and task", async () => {
    const markdown = "考點段落 {考點}\n\n- [ ] 交報告 {task}\n\n沒有標籤的段落\n";
    currentWorkspace = source.ws;
    const id = String((await createNote({ actor: source.owner, workspaceId: source.ws, title: "Blocky note", markdown, spaceId: source.space, event: { uiContext: "test.anchors" } })).node.id);
    const rowsOf = async (ws: string, note: string) => (await q<{ block_ref: string; anchor_id: string | null; label: string; hidden: boolean; kind: string; task: boolean; tags: string[] }>(
      `SELECT b.block_ref, b.anchor_id, b.label, b.kind, b.hidden_at IS NOT NULL AS hidden, b.task_id IS NOT NULL AS task,
              coalesce(array_agg(t.title ORDER BY t.title) FILTER (WHERE t.title IS NOT NULL), '{}') AS tags
         FROM block_nodes b LEFT JOIN block_node_tags bt ON bt.block_node_id = b.id LEFT JOIN content_nodes t ON t.id = bt.tag_id
        WHERE b.workspace_id = $1 AND b.note_id = $2 GROUP BY b.id ORDER BY b.label`, [ws, note])).rows;
    const original = await rowsOf(source.ws, id);
    expect(original.map((r) => r.label)).toEqual(["交報告", "考點段落"]);
    expect(original.every((r) => r.anchor_id === r.block_ref && !r.hidden)).toBe(true);
    expect(original.find((r) => r.label === "交報告")!.task).toBe(true);
    const savedBody = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [id])).rows[0]!.markdown;
    expect(savedBody).toBe(markdown); // no `^id` written

    const exported = await app(source.owner).request("/api/backup/full.zip");
    expect(exported.status).toBe(200);
    const blocky = Buffer.from(await exported.arrayBuffer());

    // Into another workspace: the same ids, rows, tags and a task for the task line; the text is as it was.
    const target = await newWorkspace("anchors-blocky");
    currentWorkspace = target.ws;
    await restoreInto(target, blocky, target.space);
    const restored = (await q<{ id: string; markdown: string }>(
      `SELECT id::text, markdown FROM content_nodes WHERE workspace_id = $1 AND space_id = $2 AND title = 'Blocky note' AND deleted_at IS NULL`, [target.ws, target.space])).rows[0]!;
    expect(restored.markdown).toBe(markdown);
    const back = await rowsOf(target.ws, restored.id);
    expect(back.map(({ block_ref, anchor_id, label, kind, tags, hidden }) => ({ block_ref, anchor_id, label, kind, tags, hidden })))
      .toEqual(original.map(({ block_ref, anchor_id, label, kind, tags, hidden }) => ({ block_ref, anchor_id, label, kind, tags, hidden })));
    expect(back.find((r) => r.label === "交報告")!.task).toBe(true);
    expect((await listNoteAnchors(target.ws, restored.id)).every((a) => a.status === "valid")).toBe(true);

    // Into the workspace it came from: the originals are untouched (their ids are taken); the copy's blocks are known by ids of their own.
    currentWorkspace = source.ws;
    const space2 = await makeSpace(source.ws, "anchors-blocky second", [{ id: source.owner.id, permission: "edit" }]);
    await restoreInto(source, blocky, space2);
    expect(await rowsOf(source.ws, id)).toEqual(original);
    const copy = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND space_id = $2 AND title = 'Blocky note' AND deleted_at IS NULL`, [source.ws, space2])).rows[0]!;
    const copyRows = await rowsOf(source.ws, copy.id);
    expect(copyRows.map((r) => r.label)).toEqual(["交報告", "考點段落"]);
    expect(copyRows.every((r) => r.anchor_id === r.block_ref && !original.some((o) => o.block_ref === r.block_ref))).toBe(true);
    expect(copyRows.find((r) => r.label === "交報告")!.task).toBe(true);
  });
});
