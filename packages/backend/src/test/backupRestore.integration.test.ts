// Restoring a backup a person made themselves (routes/backup.ts,
// services/backupRestore.ts, services/backupFile.ts): upload → preview →
// restore, into an empty space or merged into the current one; the archive
// checks; who may restore; one undoable event.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { q, getWorkspaceId } from "../db.js";

// A workspace of its own: a backup or export reads the whole workspace, so in
// the shared default workspace its cost would grow with every other test's
// notes (on a reused DB the export query alone took 1–2 s).
let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
import { apiOnError } from "../httpError.js";
import backupRouter from "../routes/backup.js";
import { MEDIA_DIR } from "../services/mediaStore.js";
import { storeMedia } from "../services/media.js";
import { createNote } from "../services/noteCreate.js";
import { trashNode } from "../services/nodeTrash.js";
import { updateNode } from "../services/nodeUpdate.js";
import { setNodeAttribute } from "../services/attributeWrites.js";
import { createTag } from "../services/tagHierarchy.js";
import { applyTagToNode } from "../services/tagMembershipWrites.js";
import { createTaskNode } from "../services/tasksStore.js";
import { stageBackupUpload } from "../services/backupFile.js";
import { restoreEvent } from "../services/eventRestore/index.js";
import { applyRestore, RestoreAbandoned } from "../services/backupRestore.js";
import { openBackupUpload } from "../services/backupFile.js";
import type { RestorePreview } from "@onden/contract";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { rawZip } from "./helpers/rawZip.js";
import { applyAndWait } from "./helpers/restoreJob.js";
import { zipEntries } from "./helpers/zipEntries.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";
import type { RestoreReport } from "@onden/contract";

registerShippedModules();

const enabled = isTestDatabase();

function app(actor: ActorCtx) {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.route("/api/backup", backupRouter);
  return hono;
}

async function backupOf(actor: ActorCtx): Promise<Buffer> {
  const res = await app(actor).request("/api/backup/full.zip");
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

async function upload(actor: ActorCtx, zip: Buffer): Promise<Response> {
  return app(actor).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
}

async function uploaded(actor: ActorCtx, zip: Buffer): Promise<string> {
  const res = await upload(actor, zip);
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { upload_id: string }).upload_id;
}

async function preview(actor: ActorCtx, id: string, space: string, mode: "empty" | "merge"): Promise<Response> {
  return app(actor).request(`/api/backup/restore/${id}/preview?space=${space}&mode=${mode}`);
}

/** Start the restore job and wait for it (helpers/restoreJob.ts). */
async function apply(actor: ActorCtx, id: string, space: string, mode: "empty" | "merge"): Promise<Response> {
  return applyAndWait(app(actor), id, space, mode);
}

type Row = { id: string; title: string; markdown: string; parent_id: string | null; deleted: boolean; created_at: string; hidden: boolean };
const notesIn = async (space: string) => (await q<Row>(
  `SELECT id::text, title, markdown, parent_id::text, deleted_at IS NOT NULL AS deleted, created_at::text, hidden
     FROM content_nodes WHERE space_id = $1 AND node_type <> 'class_tag' ORDER BY title`, [space])).rows;
const attributes = async (id: string) => Object.fromEntries((await q<{ key: string; value: string }>(
  `SELECT key, value FROM node_attributes WHERE node_id = $1`, [id])).rows.map((r) => [r.key, r.value]));
const tagsOf = async (id: string) => (await q<{ tag_id: string }>(`SELECT tag_id::text FROM node_tags WHERE node_id = $1 ORDER BY tag_id`, [id])).rows.map((r) => r.tag_id);

describe.skipIf(!enabled)("restore from a backup", () => {
  let ws: string;
  const outerStamp = randomUUID().slice(0, 8);
  let stamp = "";
  let solo: ActorCtx;
  let spaceA = "";
  const ids: Record<string, string> = {};
  let media = "";
  let tagId = "";
  let zip: Buffer;

  // Restoring a backup into a shared space is the workspace owner's. Each
  // fixture's Solo takes ownership when it is built, and beforeEach hands it
  // back to the file's shared Solo, so a test is the owner of whichever Solo it uses.
  const makeOwner = (id: string) => setWorkspaceOwner(ws, id);
  async function soloActor(name: string, owner = false): Promise<ActorCtx> {
    const actor = await persistActor(ws, { id: "", name: `${name} ${outerStamp}`, type: "human", role: "editor" });
    if (owner) await makeOwner(actor.id);
    // Only their personal space and the spaces a test gives them.
    await q(`DELETE FROM space_members m USING spaces s WHERE m.space_id = s.id AND m.actor_id = $1 AND s.kind <> 'personal'`, [actor.id]);
    return actor;
  }

  // Solo, their space A with a parent, a child (media, link, attributes, a
  // drawing, a tag), a deleted note and a task, and Solo's backup of it. The
  // tests that change space A build their own; the rest share one.
  let fixtures = 0;
  async function buildFixture() {
    const stamp = `${outerStamp}x${++fixtures}`;
    const ids: Record<string, string> = {};
    const solo = await soloActor("Solo", true);
    const spaceA = await makeSpace(ws, `A ${stamp}`, [{ id: solo.id, permission: "edit" }]);
    const stored = await storeMedia(Buffer.from(`%PDF-1.4 restore ${stamp}`), ".pdf", { actor: solo, workspaceId: ws, origin: "upload" });
    if (!stored.ok) throw new Error(stored.reason);
    const media = stored.filename;
    const note = async (name: string, markdown: string, parentId: string | null = null) => {
      ids[name] = String((await createNote({ actor: solo, workspaceId: ws, title: `${name} ${stamp}`, markdown, spaceId: spaceA, parentId, event: { uiContext: "test.restore" } })).node.id);
    };
    await note("Parent", "The parent.\n");
    await note("Child", `A [file](/api/media/${media}).\n`, ids.Parent);
    await updateNode(ws, ids.Parent!, { markdown: `The parent, see [child](onden://node/${ids.Child}).\n` }, { actor: solo });
    await note("Gone", "Deleted before the backup.\n");
    await trashNode(solo, ws, ids.Gone!);
    await setNodeAttribute({ workspaceId: ws, actor: solo, nodeId: ids.Child!, attribute: { key: "rating", value: "5" } });
    await setNodeAttribute({ workspaceId: ws, actor: solo, nodeId: ids.Child!, attribute: { key: "ink_data", value: `{"v":1,"items":["${stamp}"]}` } });
    const tagId = (await createTag({ actor: solo, workspaceId: ws, name: `restore${stamp}` })).id;
    await applyTagToNode({ workspaceId: ws, actor: solo, nodeId: ids.Child!, tagId });
    // A note a tag makes a task keeps its state on itself (`_task_*`, written as the Tasks page does).
    for (const [key, value] of [["_task_status", "done"], ["_task_deadline", "2026-11-05"]]) {
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1, $2, $3, $4, 'text', 'ui')`, [ws, ids.Child, key, value]);
    }
    ids.Task = await createTaskNode({ workspaceId: ws, actor: solo, hostId: ids.Parent!, title: `Task ${stamp}`, when: "2026-11-01" });
    const zip = await backupOf(solo);
    return { stamp, solo, spaceA, ids, media, tagId, zip };
  }

  beforeAll(async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Test', $1) RETURNING id::text`, [`backup-restore-${randomUUID()}`])).rows[0]!.id;
    ws = await getWorkspaceId();
    let built: Record<string, string>;
    ({ stamp, solo, spaceA, ids: built, media, tagId, zip } = await buildFixture());
    Object.assign(ids, built);
  });

  beforeEach(async () => { await makeOwner(solo.id); });

  it("restores into an empty space: the same notes, tags, attributes, drawings, media, hierarchy and deleted notes", async () => {
    const { stamp, solo, spaceA, ids, media, zip } = await buildFixture();
    const spaceB = await makeSpace(ws, `B ${stamp}`, [{ id: solo.id, permission: "edit" }]);
    const upload = await uploaded(solo, zip);
    const shown = await preview(solo, upload, spaceB, "empty");
    expect(shown.status).toBe(200);
    const body = await shown.json() as RestorePreview;
    expect(body.refusal).toBeNull();
    // The originals still hold their ids, so every note gets a new one: three are second copies of a live note, the fourth (a trashed note) is not.
    expect(body.counts).toEqual(expect.objectContaining({ notes_new: 2, notes_new_deleted: 1, tasks: 1, notes_second_copy: 3, notes_new_id: 1, tags_new: 0 }));
    // Tag definitions are everyone's: the backup's are the workspace's own.
    expect(body.counts.tags_existing).toBeGreaterThan(0);

    // A file gone from disk comes back from the backup, under its own id.
    const original = readFileSync(join(MEDIA_DIR, media));
    rmSync(join(MEDIA_DIR, media));
    const res = await apply(solo, upload, spaceB, "empty");
    expect(res.status, await res.clone().text()).toBe(200);
    const report = await res.json() as RestoreReport;
    expect(report).toEqual(expect.objectContaining({ created: 4, copies: 0, deleted_again: 1, attachments_written: 1 }));
    expect(readFileSync(join(MEDIA_DIR, media))).toEqual(original);

    const a = await notesIn(spaceA);
    const b = await notesIn(spaceB);
    expect(b.map((n) => [n.title, n.deleted, n.hidden, n.created_at])).toEqual(a.map((n) => [n.title, n.deleted, n.hidden, n.created_at]));
    const byTitle = (rows: Row[], name: string) => rows.find((n) => n.title === `${name} ${stamp}`)!;
    const [parentB, childB, taskB] = ["Parent", "Child", "Task"].map((name) => byTitle(b, name));
    expect(childB!.parent_id).toBe(parentB!.id);
    expect(taskB!.parent_id).toBe(parentB!.id);
    // The link follows the child to its new id; the media keeps its own.
    expect(parentB!.markdown).toBe(`The parent, see [child](onden://node/${childB!.id}).\n`);
    expect(childB!.markdown).toBe(byTitle(a, "Child").markdown);
    expect(await attributes(childB!.id)).toEqual(expect.objectContaining({ rating: "5", ink_data: `{"v":1,"items":["${stamp}"]}`, _task_status: "done", _task_deadline: "2026-11-05" }));
    expect(await tagsOf(childB!.id)).toEqual(await tagsOf(ids.Child!));
    expect((await attributes(taskB!.id))._task_when).toBe("2026-11-01");
    expect(byTitle(b, "Gone").deleted).toBe(true);

    // The upload is gone once used.
    // The job reports "done" a moment before it discards its upload, so wait for that instead of racing it.
    let after = await preview(solo, upload, spaceB, "empty");
    for (let i = 0; i < 100 && after.status !== 404; i++) { await new Promise((r) => setTimeout(r, 20)); after = await preview(solo, upload, spaceB, "empty"); }
    expect(after.status).toBe(404);

    // One event group: undoing it with its caused changes removes what it added.
    const refused = await restoreEvent(report.event_id, { actor: solo, workspaceId: ws });
    expect(refused).toEqual(expect.objectContaining({ code: "state_conflict" }));
    const undone = await restoreEvent(report.event_id, { actor: solo, workspaceId: ws, cascade: true });
    expect(undone).toEqual(expect.objectContaining({ restored: true }));
    expect((await notesIn(spaceB)).every((n) => n.deleted)).toBe(true);
    expect((await notesIn(spaceA)).filter((n) => !n.deleted).length).toBe(3);
  });

  it("an older backup whose tasks carry the tasks tag: the tag is not restored, the tasks come back as tasks", async () => {
    const fx = await buildFixture();
    // Make the archive the way it was written before tasks became function references: the tasks module's tag is a tag
    // record of the backup and the task note lists it among its tags.
    const entries = zipEntries(fx.zip);
    const taskPath = `.onden/notes/${fx.ids.Task}.json`;
    const task = JSON.parse(entries.get(taskPath)!.toString("utf8")) as Record<string, unknown>;
    const oldTagId = randomUUID();
    task.tags = [oldTagId];
    entries.set(taskPath, Buffer.from(JSON.stringify(task)));
    entries.set(`.onden/notes/${oldTagId}.json`, Buffer.from(JSON.stringify({
      id: oldTagId, node_type: "class_tag", title: "task", slug: null, parent_id: null, space_id: null, hidden: false, sort_order: 0, source_type: "manual",
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), deleted_at: null, markdown: "", presentation: null, attributes: [], tags: [], file: null, media: [],
      tag: { path: "task", color: null, schema: { name: "task", module: "tasks" }, views: null, reserved_key: null },
    })));
    const older = rawZip([...entries].map(([name, data]) => ({ name, data })));
    const space = await makeSpace(ws, `Older ${fx.stamp}`, [{ id: fx.solo.id, permission: "edit" }]);
    const tagsBefore = (await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag'`, [ws])).rowCount;
    const upload = await uploaded(fx.solo, older);
    const res = await apply(fx.solo, upload, space, "empty");
    expect(res.status, await res.clone().text()).toBe(200);
    const report = await res.json() as RestoreReport;
    expect(report.skipped.tags).toBe(0);
    const restored = (await notesIn(space)).find((n) => n.title === `Task ${fx.stamp}`)!;
    expect((await q(`SELECT 1 FROM function_refs WHERE holder_node_id = $1 AND function_id = 'tasks'`, [restored.id])).rowCount).toBe(1);
    expect((await q(`SELECT 1 FROM node_tags WHERE node_id = $1`, [restored.id])).rowCount).toBe(0);
    expect((await attributes(restored.id))._task_status).toBe("todo");
    // The old tag was not made here as a tag.
    expect((await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag'`, [ws])).rowCount).toBe(tagsBefore);
  });

  it("a backup made before views, functions and extras were written (no extras file, no views in its sidecars) still restores", async () => {
    const fx = await buildFixture();
    const entries = zipEntries(fx.zip);
    entries.delete(".onden/extras.json");
    for (const [name, data] of entries) {
      if (!name.startsWith(".onden/notes/")) continue;
      const sidecar = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      delete sidecar.views;
      if (sidecar.tag && typeof sidecar.tag === "object") (sidecar.tag as Record<string, unknown>).views = null;
      entries.set(name, Buffer.from(JSON.stringify(sidecar)));
    }
    const older = rawZip([...entries].map(([name, data]) => ({ name, data })));
    const space = await makeSpace(ws, `Before views ${fx.stamp}`, [{ id: fx.solo.id, permission: "edit" }]);
    const res = await apply(fx.solo, await uploaded(fx.solo, older), space, "empty");
    expect(res.status, await res.clone().text()).toBe(200);
    const report = await res.json() as RestoreReport;
    expect(report.created).toBeGreaterThan(0);
    expect(report.skipped.views).toBe(0);
    expect(report.skipped.functions).toBe(0);
  });

  it("restores into another workspace: a tag id that lives in the first one is created, not counted as existing", async () => {
    const first = await buildFixture();
    const firstWorkspace = ws;
    const otherWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Other', $1) RETURNING id::text`, [`backup-other-${randomUUID()}`])).rows[0]!.id;
    try {
      ownWorkspace = ws = otherWorkspace;
      const other = await soloActor("Other", true);
      const space = await makeSpace(ws, `Other ${first.stamp}`, [{ id: other.id, permission: "edit" }]);
      const upload = await uploaded(other, first.zip);
      const res = await apply(other, upload, space, "empty");
      expect(res.status, await res.clone().text()).toBe(200);
      const report = await res.json() as RestoreReport;
      expect(report.skipped.tags).toBe(0);
      expect(report.tags_created).toBeGreaterThan(0);
      const child = (await notesIn(space)).find((n) => n.title === `Child ${first.stamp}`)!;
      const tags = await q<{ title: string; workspace_id: string }>(
        `SELECT t.title, t.workspace_id::text FROM node_tags nt JOIN content_nodes t ON t.id = nt.tag_id WHERE nt.node_id = $1`, [child.id]);
      expect(tags.rows).toEqual([{ title: `restore${first.stamp}`, workspace_id: otherWorkspace }]);
    } finally {
      ownWorkspace = ws = firstWorkspace;
    }
  });

  it("the job names its event in the transaction that commits it, before any batch runs", async () => {
    const fx = await buildFixture();
    const space = await makeSpace(ws, `Job ${fx.stamp}`, [{ id: fx.solo.id, permission: "edit" }]);
    const upload = await uploaded(fx.solo, fx.zip);
    await q(`INSERT INTO backup_restore_jobs (id, workspace_id, actor_id, upload_id, space_id, mode, status, phase)
             VALUES ($1, $2, $3, $4, $5, 'empty', 'running', 'queued')`, [randomUUID(), ws, fx.solo.id, upload, space]);
    const reader = await openBackupUpload(fx.solo.id, upload);
    try {
      // A crash right after the first commit: the batches never record anything.
      await expect(applyRestore(fx.solo, ws, reader, "empty", space, upload, async (p) => {
        if (p.phase === "notes") throw new Error("process died");
      })).rejects.toBeInstanceOf(RestoreAbandoned);
    } finally { reader.close(); }
    const job = (await q<{ event_id: string | null }>(`SELECT event_id::text FROM backup_restore_jobs WHERE upload_id = $1`, [upload])).rows[0]!;
    const event = (await q<{ id: string }>(`SELECT id::text FROM domain_events WHERE event_type = 'BACKUP_RESTORED' AND target_id = $1`, [space])).rows[0]!;
    expect(job.event_id).toBe(event.id);
  });

  it("refuses an empty-space restore into a space with notes", async () => {
    const upload = await uploaded(solo, zip);
    const body = await (await preview(solo, upload, spaceA, "empty")).json() as RestorePreview;
    expect(body.refusal).toBe("target_not_empty");
    const res = await apply(solo, upload, spaceA, "empty");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "target_not_empty" });
  });

  it("merges: unchanged notes stay single, a changed note keeps its current text and gains the backup's as a copy", async () => {
    const { stamp, solo, spaceA, ids } = await buildFixture();
    await updateNode(ws, ids.Child!, { markdown: "Edited after the backup.\n" }, { actor: solo });
    // A note deleted for good after the backup comes back with its id; one
    // made (and deleted for good) after it does not.
    const twin = await createNote({ actor: solo, workspaceId: ws, title: `Twin ${stamp}`, markdown: "In the backup.\n", spaceId: spaceA, event: { uiContext: "test" } });
    const withTwin = await backupOf(solo);
    const twinId = String(twin.node.id);
    const local = await createNote({ actor: solo, workspaceId: ws, title: `Local ${stamp}`, markdown: "Not in the backup.\n", spaceId: spaceA, event: { uiContext: "test" } });
    await seedQ(`DELETE FROM content_nodes WHERE id = ANY($1::uuid[])`, [[twinId, String(local.node.id)]]);
    // A new note with the twin's title, at the root like it.
    await createNote({ actor: solo, workspaceId: ws, title: `Twin ${stamp}`, markdown: "Made later.\n", spaceId: spaceA, event: { uiContext: "test" } });
    await updateNode(ws, ids.Child!, { markdown: "Edited again.\n" }, { actor: solo });

    const upload = await uploaded(solo, withTwin);
    const body = await (await preview(solo, upload, spaceA, "merge")).json() as RestorePreview;
    expect(body.counts).toEqual(expect.objectContaining({ notes_new: 1, notes_conflict: 1, tasks: 0 }));
    // Gone (and the first test's undone restore) are in History already.
    expect(body.counts.notes_in_history).toBeGreaterThanOrEqual(1);
    expect(body.conflicts).toEqual([{ id: ids.Child, title: `Child ${stamp}` }]);
    expect(body.title_clashes).toEqual([{ id: twinId, title: `Twin ${stamp}` }]);

    const res = await apply(solo, upload, spaceA, "merge");
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual(expect.objectContaining({ created: 1, copies: 1 }));
    const live = (await notesIn(spaceA)).filter((n) => !n.deleted);
    const child = live.find((n) => n.id === ids.Child)!;
    expect(child.markdown).toBe("Edited again.\n");
    const copy = live.find((n) => n.title.startsWith(`Child ${stamp}（備份 `))!;
    expect(copy.markdown).toBe("Edited after the backup.\n");
    expect(copy.parent_id).toBe(ids.Parent);
    expect(live.filter((n) => n.title === `Parent ${stamp}`)).toHaveLength(1);
    expect(live.filter((n) => n.title === `Twin ${stamp}`).map((n) => n.id)).toContain(twinId);
    expect(live.filter((n) => n.title === `Twin ${stamp}`)).toHaveLength(2);
    expect(live.some((n) => n.title === `Local ${stamp}`)).toBe(false);
  });

  it("only the workspace owner restores, an editor of the target space does not; an upload is its uploader's", async () => {
    const editor = await soloActor("Editor");
    await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'edit')`, [spaceA, editor.id]);
    const theirs = await uploaded(editor, zip);
    expect((await preview(editor, theirs, spaceA, "merge")).status).toBe(403);
    expect((await apply(editor, theirs, spaceA, "merge")).status).toBe(403);
    // Someone else's upload id is not found, not forbidden.
    expect((await preview(solo, theirs, spaceA, "merge")).status).toBe(404);
    const token = { ...solo, tokenScope: { tokenId: "t", allowedTools: null, access: "write" as const, writeMode: "apply" as const, expiresAt: null } };
    expect((await upload(token, zip)).status).toBe(403);
  });

  it("an editor's backup holds only what they can read, so restoring it brings back nothing else", async () => {
    const reader = await soloActor("Reader");
    const shared = await makeSpace(ws, `Shared ${stamp}`, [{ id: solo.id, permission: "edit" }, { id: reader.id, permission: "edit" }]);
    const seen = await createNote({ actor: solo, workspaceId: ws, title: `Seen ${stamp}`, markdown: "", spaceId: shared, event: { uiContext: "test" } });
    const theirs = zipEntries(await backupOf(reader));
    expect(theirs.has(`.onden/notes/${String(seen.node.id)}.json`)).toBe(true);
    expect(theirs.has(`.onden/notes/${ids.Parent}.json`)).toBe(false);
    expect([...theirs.values()].some((data) => data.toString("utf8").includes(`Parent ${stamp}`))).toBe(false);
  });

  it("refuses unsafe and unexpected entries, broken files and oversized uploads", async () => {
    const manifest = JSON.stringify({ format: "onden-backup", version: 1, created_at: new Date().toISOString(), counts: {} });
    const refusal = async (zipFile: Buffer) => {
      const res = await upload(solo, zipFile);
      return [res.status, ((await res.json()) as { error: string }).error];
    };
    expect(await refusal(rawZip([{ name: ".onden/manifest.json", data: manifest }, { name: "../evil.md", data: "x" }]))).toEqual([400, "unsafe_entry"]);
    expect(await refusal(rawZip([{ name: ".onden/manifest.json", data: manifest }, { name: "attachments/../../x.png", data: "x" }]))).toEqual([400, "unsafe_entry"]);
    expect(await refusal(rawZip([{ name: ".onden/manifest.json", data: manifest }, { name: "/etc/passwd.md", data: "x" }]))).toEqual([400, "unsafe_entry"]);
    expect(await refusal(rawZip([{ name: ".onden/manifest.json", data: manifest }, { name: "scripts/run.sh", data: "x" }]))).toEqual([400, "unexpected_entry"]);
    expect(await refusal(rawZip([{ name: ".onden/manifest.json", data: manifest }, { name: "attachments/payload.exe", data: "x" }]))).toEqual([400, "unexpected_entry"]);
    expect(await refusal(rawZip([{ name: "a.md", data: "no manifest" }]))).toEqual([400, "no_manifest"]);
    expect(await refusal(rawZip([{ name: ".onden/manifest.json", data: JSON.stringify({ format: "onden-backup", version: 99 }) }]))).toEqual([400, "newer_version"]);
    expect(await refusal(Buffer.from("not a zip at all"))).toEqual([400, "not_zip"]);
    // A sidecar that says it inflates to 100 MB (a zip bomb, or just too big).
    expect(await refusal(rawZip([{ name: ".onden/manifest.json", data: manifest },
      { name: `.onden/notes/${randomUUID()}.json`, data: "{}", deflate: true, declaredSize: 100 * 1024 * 1024 }]))).toEqual([400, "entry_too_large"]);
    // An attachment that inflates far past its compressed size.
    expect(await refusal(rawZip([{ name: ".onden/manifest.json", data: manifest },
      { name: "attachments/0123456789abcdef0123456789abcdef.png", data: Buffer.alloc(4 * 1024 * 1024), deflate: true }]))).toEqual([400, "entry_too_large"]);
    // Over the transport cap: by its declared length, and by what arrives.
    const big = await app(solo).request("/api/backup/restore/upload", { method: "POST", headers: { "content-length": String(17 * 1024 ** 3) }, body: "x" });
    expect(big.status).toBe(413);
    // The page learns the cap from the server (ONDEN_MAX_BACKUP_MB, else 16 GB) and the size of a backup before it is made.
    expect(await (await app(solo).request("/api/backup/restore/limit")).json()).toEqual({ max_bytes: 16 * 1024 ** 3 });
    const size = await (await app(solo).request("/api/backup/size")).json() as { bytes: number };
    expect(size.bytes).toBeGreaterThan(0);
    // One number: the limit the page states beside the download is the one the upload refuses at (ONDEN_MAX_BACKUP_MB).
    const configured = process.env.ONDEN_MAX_BACKUP_MB;
    process.env.ONDEN_MAX_BACKUP_MB = "5";
    try {
      expect(await (await app(solo).request("/api/backup/restore/limit")).json()).toEqual({ max_bytes: 5 * 1024 * 1024 });
      const justOver = await app(solo).request("/api/backup/restore/upload", { method: "POST", headers: { "content-length": String(5 * 1024 * 1024 + 1) }, body: "x" });
      expect(justOver.status).toBe(413);
    } finally {
      if (configured === undefined) delete process.env.ONDEN_MAX_BACKUP_MB; else process.env.ONDEN_MAX_BACKUP_MB = configured;
    }
    await expect(stageBackupUpload(solo.id, Readable.from([zip]), null, { maxBytes: 1024 })).rejects.toMatchObject({ code: "backup_too_large", status: 413 });
    // Nothing refused was kept.
    const staged = join(process.cwd(), "content", "backup-uploads");
    expect(existsSync(staged) ? readdirSync(staged).filter((n) => n.endsWith(".part")) : []).toEqual([]);
  }, 60_000);
});
