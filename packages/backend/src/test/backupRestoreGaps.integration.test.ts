// Gaps found by an audit of restoring from a backup (fix/backup-restore-gaps). Each case is a real round trip: build a
// workspace through the ordinary writers, back it up, restore into another space, and compare what a person would see.
//   1  a task keeps its body, tags and other attributes, a line task too; a task whose note is missing is counted;
//   2  every kind of saved view of a note and of a tag comes back (table, kanban, calendar, gallery, whiteboard, slides…);
//   3  what was left out is reported in the result (counts by reason), never silently.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q, getWorkspaceId } from "../db.js";

let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
import { apiOnError } from "../httpError.js";
import backupRouter from "../routes/backup.js";
import tasksRouter, { addTaskUnderNote } from "../modules/tasks/routes.js";
import nodesRouter from "../routes/nodes.js";
import tagsRouter from "../routes/tags.js";
import type { ActorCtx } from "../types.js";
import type { RestoreReport } from "@onden/contract";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { applyAndWait } from "./helpers/restoreJob.js";
import { rawZip } from "./helpers/rawZip.js";
import { undoInSteps } from "../services/backupRestore.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { noteViewsOf, type NoteView } from "./helpers/noteViews.js";

registerShippedModules();
const enabled = isTestDatabase();

function app(actor: ActorCtx) {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.route("/api/backup", backupRouter);
  hono.post("/api/nodes/:id/tasks", addTaskUnderNote);
  hono.route("/api/nodes", nodesRouter);
  hono.route("/api/tags", tagsRouter);
  hono.route("/api/tasks", tasksRouter);
  return hono;
}
const send = (a: ActorCtx, url: string, method: string, body: unknown = {}) =>
  app(a).request(url, method === "GET" ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** Saved views of a holder as a person sees them: everything but the ids and times. */
const viewShape = (views: unknown[]) => (views as Array<Record<string, unknown>>)
  .map(({ id: _id, node_id: _n, tag_id: _t, created_at: _c, updated_at: _u, ...rest }) => rest)
  .sort((a, b) => String(a.name).localeCompare(String(b.name)));

// Format 2 is the archive as it always was; format 3 is the same with version history (`?history=1`, services/backupHistory.ts).
// What a restore brings back of tasks, views and the skip counts must hold for both.
for (const format of [2, 3] as const) describe.skipIf(!enabled)(`restoring a backup of format ${format}: tasks and saved views come back whole`, () => {
  let ws = "";
  let solo: ActorCtx;
  let spaceA = "";
  let spaceB = "";
  let source: Map<string, NoteView>;
  let restored: Map<string, NoteView>;
  let report: RestoreReport;
  let noteViewsBefore: unknown[] = [];
  let tagViewsBefore: unknown[] = [];
  let noteViewsAfter: unknown[] = [];
  let tagViewsAfter: unknown[] = [];
  let tagName = "";
  const stamp = randomUUID().slice(0, 6);

  const create = async (title: string, markdown: string, extra: Record<string, unknown> = {}) => {
    const res = await send(solo, "/api/nodes", "POST", { title, markdown, space_id: spaceA, ...extra });
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };

  beforeAll(async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Gaps', $1) RETURNING id::text`, [`gaps-${randomUUID()}`])).rows[0]!.id;
    ws = await getWorkspaceId();
    await setModulesOn(ws, null);
    solo = await persistActor(ws, { id: "", name: `Solo ${stamp}`, type: "human", role: "editor" });
    await setWorkspaceOwner(ws, solo.id);
    spaceA = await makeSpace(ws, `A ${stamp}`, [{ id: solo.id, permission: "edit" }]);
    spaceB = await makeSpace(ws, `B ${stamp}`, [{ id: solo.id, permission: "edit" }]);

    tagName = `Label ${stamp}`;
    const tag = ((await (await send(solo, "/api/tags", "POST", { name: tagName })).json()) as { id: string }).id;

    // Gap 1: a task of a note with a body, a tag and its own attributes; a line task with the same.
    const host = await create("Host", "- [ ] 行任務 {task}\n");
    const added = await send(solo, `/api/nodes/${host}/tasks`, "POST", { title: "加的任務" });
    expect(added.status, await added.clone().text()).toBe(201);
    const addedId = ((await added.json()) as { id: string }).id;
    const line = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE parent_id = $1 AND hidden AND title = '行任務'`, [host])).rows[0]!.id;
    for (const [id, body] of [[addedId, "任務內文\n\n第二段。\n"], [line, "行任務的備註\n"]] as const) {
      const patched = await send(solo, `/api/nodes/${id}`, "PATCH", { markdown: body });
      expect(patched.status, await patched.clone().text()).toBe(200);
      expect((await send(solo, `/api/nodes/${id}/tags/${tag}`, "PUT")).status).toBe(200);
      const attr = await send(solo, `/api/nodes/${id}/attributes/priority`, "PUT", { value: "高" });
      expect(attr.status, await attr.clone().text()).toBe(200);
    }

    // Gap 2: every layout a note or a tag can hold as a saved view.
    const viewHost = await create("Views", "子筆記\n");
    await create("Child", "x\n", { parent_id: viewHost });
    for (const [name, layout] of [["表", "table"], ["看板", "kanban"], ["月曆", "calendar"], ["相簿", "gallery"], ["白板", "canvas"], ["簡報", "slides"]] as const) {
      const res = await send(solo, `/api/nodes/${viewHost}/views`, "POST", {
        name, layout, filters: [], sorts: [{ field: "title", dir: "desc" }], visible_fields: ["title"], layout_config: { marker: name }, pin_order: 3,
      });
      expect(res.status, `${layout}: ${await res.clone().text()}`).toBe(201);
    }
    for (const [name, layout] of [["表", "table"], ["看板", "kanban"], ["月曆", "calendar"], ["相簿", "gallery"]] as const) {
      const res = await send(solo, `/api/tags/${tag}/views`, "POST", { name, layout, layout_config: { marker: name } });
      expect(res.status, `${layout}: ${await res.clone().text()}`).toBe(201);
    }
    const viewHostId = viewHost;

    source = await noteViewsOf(ws);
    noteViewsBefore = ((await (await send(solo, `/api/nodes/${viewHostId}/views`, "GET")).json()) as { views: unknown[] }).views;
    tagViewsBefore = ((await (await send(solo, `/api/tags/${tag}/views`, "GET")).json()) as { views: unknown[] }).views;

    const zip = Buffer.from(await (await app(solo).request(`/api/backup/full.zip${format === 3 ? "?history=1" : ""}`)).arrayBuffer());
    const upload0 = await app(solo).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
    expect(((await upload0.json()) as { manifest: { version: number } }).manifest.version, "the backup is of the format under test").toBe(format);
    // The tag is gone by the time of the restore: the restore makes it again, with the views the backup holds.
    expect((await send(solo, `/api/nodes/${tag}`, "DELETE")).status).toBe(200);
    const up = await app(solo).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
    const uploadId = ((await up.json()) as { upload_id: string }).upload_id;
    const done = await applyAndWait(app(solo), uploadId, spaceB, "empty");
    expect(done.status, await done.clone().text()).toBe(200);
    report = (await done.json()) as RestoreReport;
    restored = await noteViewsOf(ws);

    const copyId = (await q<{ id: string }>(`SELECT n.id::text FROM content_nodes n WHERE n.space_id = $1 AND n.title = 'Views'`, [spaceB])).rows[0]!.id;
    noteViewsAfter = ((await (await send(solo, `/api/nodes/${copyId}/views`, "GET")).json()) as { views: unknown[] }).views;
    const newTag = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND node_type = 'class_tag' AND title = $2 AND deleted_at IS NULL`, [ws, tagName])).rows[0]!.id;
    tagViewsAfter = ((await (await send(solo, `/api/tags/${newTag}/views`, "GET")).json()) as { views: unknown[] }).views;
  });

  const inSpace = (views: Map<string, NoteView>, name: string) => [...views.values()].filter((v) => v.space === name);
  const taskOf = (views: Map<string, NoteView>, space: string, title: string) => inSpace(views, space).find((n) => n.hidden && n.title === title)!;

  describe("gap 1: a task keeps its content", () => {
    for (const title of ["加的任務", "行任務"]) {
      const pair = () => [taskOf(source, `A ${stamp}`, title), taskOf(restored, `B ${stamp}`, title)] as const;
      it(`${title}: its body`, () => {
        const [before, after] = pair();
        expect(before.markdown).not.toBe("");
        expect(after.markdown).toBe(before.markdown);
      });
      it(`${title}: its tags`, () => {
        const [before, after] = pair();
        expect(before.tags).toContain(tagName);
        expect(after.tags).toEqual(before.tags);
      });
      it(`${title}: its other attributes, and nothing else added`, () => {
        const [before, after] = pair();
        expect(after.attributes.priority).toBe("高");
        const own = (a: Record<string, string>) => Object.fromEntries(Object.entries(a).filter(([k]) => k !== "_task_done_at"));
        expect(own(after.attributes)).toEqual(own(before.attributes));
      });
    }
  });

  describe("gap 2: saved views", () => {
    it("a note's views of every layout come back", () => {
      expect(noteViewsBefore).toHaveLength(6);
      expect(viewShape(noteViewsAfter)).toEqual(viewShape(noteViewsBefore));
    });
    it("a tag the restore makes again gets its views", () => {
      expect(tagViewsBefore).toHaveLength(4);
      expect(viewShape(tagViewsAfter)).toEqual(viewShape(tagViewsBefore));
    });
  });

  it("gap 3: the report says what was left out (nothing here, so all zero)", () => {
    expect(report.skipped).toEqual({ tags: 0, attributes: 0, links: 0, positions: 0, tag_settings: 0, tag_automation: 0, tasks: 0, views: 0, functions: 0, attachments_too_large: 0, attachments_unreadable: 0, attachments_not_yours: 0 });
    expect(report.tasks).toBe(2);
    expect(report.views).toBe(6 + 4);
  });
});

describe.skipIf(!enabled)("restoring a backup: a task with no place to go is counted", () => {
  it("merge into another space: the host stays in its own space, the task it had (purged since) cannot be put under it", async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Gaps2', $1) RETURNING id::text`, [`gaps2-${randomUUID()}`])).rows[0]!.id;
    const ws = await getWorkspaceId();
    const stamp = randomUUID().slice(0, 6);
    const solo = await persistActor(ws, { id: "", name: `Solo2 ${stamp}`, type: "human", role: "editor" });
    await setWorkspaceOwner(ws, solo.id);
    const from = await makeSpace(ws, `From ${stamp}`, [{ id: solo.id, permission: "edit" }]);
    const into = await makeSpace(ws, `Into ${stamp}`, [{ id: solo.id, permission: "edit" }]);
    const made = await send(solo, "/api/nodes", "POST", { title: "Host", markdown: "內文\n", space_id: from });
    const hostId = ((await made.json()) as { id: string }).id;
    const added = await send(solo, `/api/nodes/${hostId}/tasks`, "POST", { title: "孤兒" });
    expect(added.status, await added.clone().text()).toBe(201);
    const taskId = ((await added.json()) as { id: string }).id;
    const zip = Buffer.from(await (await app(solo).request("/api/backup/full.zip")).arrayBuffer());
    expect((await send(solo, `/api/nodes/${taskId}`, "DELETE")).status).toBe(200);
    expect((await send(solo, `/api/nodes/${taskId}/purge`, "POST", { expected_ids: [taskId] })).status).toBe(200);
    const up = await app(solo).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
    const uploadId = ((await up.json()) as { upload_id: string }).upload_id;
    const done = await applyAndWait(app(solo), uploadId, into, "merge");
    expect(done.status, await done.clone().text()).toBe(200);
    const report = (await done.json()) as RestoreReport;
    expect(report.skipped.tasks).toBe(1);
    expect(report.tasks).toBe(0);
    expect((await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [taskId])).rows).toHaveLength(0);
  });
});

describe.skipIf(!enabled)("restoring a backup: an attachment that cannot be written is counted", () => {
  it("a picture whose bytes are not a picture is left out and the report says so", async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Gaps3', $1) RETURNING id::text`, [`gaps3-${randomUUID()}`])).rows[0]!.id;
    const ws = await getWorkspaceId();
    const stamp = randomUUID().slice(0, 6);
    const solo = await persistActor(ws, { id: "", name: `Solo3 ${stamp}`, type: "human", role: "editor" });
    await setWorkspaceOwner(ws, solo.id);
    const space = await makeSpace(ws, `S ${stamp}`, [{ id: solo.id, permission: "edit" }]);
    const media = `${randomUUID().replaceAll("-", "")}.png`;
    const now = new Date().toISOString();
    const note = {
      id: randomUUID(), node_type: "content", title: "有圖", slug: null, parent_id: null, space_id: null, hidden: false, sort_order: 0, source_type: "manual",
      created_at: now, updated_at: now, deleted_at: null, markdown: `![](/api/media/${media})\n`, presentation: null, attributes: [], tags: [], file: null, media: [media],
    };
    const zip = rawZip([
      { name: `.onden/notes/${note.id}.json`, data: JSON.stringify(note), deflate: true },
      { name: `attachments/${media}`, data: "this is not a picture" },
      { name: ".onden/manifest.json", data: JSON.stringify({ format: "onden-backup", version: 2, created_at: now, counts: {} }) },
    ]);
    const up = await app(solo).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
    expect(up.status, await up.clone().text()).toBe(200);
    const uploadId = ((await up.json()) as { upload_id: string }).upload_id;
    const done = await applyAndWait(app(solo), uploadId, space, "empty");
    expect(done.status, await done.clone().text()).toBe(200);
    const report = (await done.json()) as RestoreReport;
    expect(report.created).toBe(1);
    expect(report.attachments_written).toBe(0);
    expect(report.skipped.attachments_unreadable).toBe(1);
    expect(report.skipped.attachments_too_large + report.skipped.attachments_not_yours).toBe(0);
  });
});

describe.skipIf(!enabled)("a failed or interrupted restore is cleaned up without taking later work", () => {
  it("notes the restore made and nobody touched are deleted for good; a note edited since, or one with a note written under it since, stays", async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Gaps4', $1) RETURNING id::text`, [`gaps4-${randomUUID()}`])).rows[0]!.id;
    const ws = await getWorkspaceId();
    const stamp = randomUUID().slice(0, 6);
    const solo = await persistActor(ws, { id: "", name: `Solo4 ${stamp}`, type: "human", role: "editor" });
    await setWorkspaceOwner(ws, solo.id);
    const from = await makeSpace(ws, `From ${stamp}`, [{ id: solo.id, permission: "edit" }]);
    const into = await makeSpace(ws, `Into ${stamp}`, [{ id: solo.id, permission: "edit" }]);
    const mk = async (title: string, markdown: string, space: string, parent_id?: string) => {
      const res = await send(solo, "/api/nodes", "POST", { title, markdown, ...(parent_id ? { parent_id } : { space_id: space }) });
      expect(res.status, await res.clone().text()).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    await mk("Untouched", "原樣。\n", from);
    await mk("Edited", "舊內文。\n", from);
    await mk("Parent", "父。\n", from);
    const zip = Buffer.from(await (await app(solo).request("/api/backup/full.zip")).arrayBuffer());
    const up = await app(solo).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
    const uploadId = ((await up.json()) as { upload_id: string }).upload_id;
    const done = await applyAndWait(app(solo), uploadId, into, "empty");
    expect(done.status, await done.clone().text()).toBe(200);
    const report = (await done.json()) as RestoreReport;

    const here = async (title: string) => (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE space_id = $1 AND title = $2`, [into, title])).rows[0]?.id;
    const untouched = (await here("Untouched"))!;
    const edited = (await here("Edited"))!;
    const parent = (await here("Parent"))!;
    // Work written after the restore, by the person: an edit, and a new note under a restored one.
    expect((await send(solo, `/api/nodes/${edited}`, "PATCH", { markdown: "新內文，還原之後寫的。\n" })).status).toBe(200);
    const later = await mk("Written later", "之後才寫的。\n", into, parent);

    // What a failed batch (or a restart in the middle) does: the restore's own undo, then the clean-up.
    expect(await undoInSteps(solo, ws, report.event_id)).toBe(true);

    const row = async (id: string) => (await q<{ title: string; markdown: string; deleted: boolean }>(`SELECT title, markdown, deleted_at IS NOT NULL AS deleted FROM content_nodes WHERE id = $1`, [id])).rows[0];
    expect(await row(untouched), "a note nobody touched is cleaned away").toBeUndefined();
    expect((await row(edited))?.markdown, "a note edited since stays, with its new text").toContain("還原之後寫的");
    expect(await row(parent), "a restored note with a note written under it since stays").toBeDefined();
    expect((await row(later))?.markdown, "the note written under it is untouched").toContain("之後才寫的");
  });
});
