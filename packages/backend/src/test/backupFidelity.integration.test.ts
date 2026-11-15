// A backup restored comes back as it was (services/backupRestore.ts): the slug of
// a note that is not in the trash stays (a trashed twin of its title does not take
// it), `[[links]]` point where they pointed, a task keeps its time, status and
// day, and the system attributes that belong to a note itself return with it.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q, getWorkspaceId } from "../db.js";

let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
import { apiOnError } from "../httpError.js";
import backupRouter from "../routes/backup.js";
import tasksRouter from "../modules/tasks/routes.js";
import nodesRouter from "../routes/nodes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { applyAndWait } from "./helpers/restoreJob.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";
import { noteViewsOf, type NoteView } from "./helpers/noteViews.js";
import tagsRouter from "../routes/tags.js";
import { addTaskUnderNote } from "../modules/tasks/routes.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { TASK_STATUSES } from "@onden/markdown";
import { noteViewLayouts, viewLayouts, WHITEBOARD_LAYOUT } from "../services/viewLayouts.js";
import { classifySystemAttr } from "../services/backupSystemAttrs.js";
import {
  ATTRIBUTE_SOURCES, NODE_TABLES, NODE_TYPES, SOURCE_TYPES, SYSTEM_ATTRIBUTE_CLASSES, TASK_STATUSES_CONVERTED, VALUE_TYPES, VIEW_LAYOUTS_NOT_IN_A_BACKUP,
} from "./helpers/backupInventory.js";
import type { RestoreReport } from "@onden/contract";

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

describe.skipIf(!enabled)("a restored backup keeps what a person would notice", () => {
  let ws = "";
  let solo: ActorCtx;
  let spaceA = "";
  let spaceB = "";
  let source: Map<string, NoteView>;
  let restored: Map<string, NoteView>;
  const stamp = randomUUID().slice(0, 6);

  const create = async (title: string, markdown: string, extra: Record<string, unknown> = {}) => {
    const res = await send(solo, "/api/nodes", "POST", { title, markdown, space_id: spaceA, ...extra });
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };

  beforeAll(async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Fidelity', $1) RETURNING id::text`, [`fidelity-${randomUUID()}`])).rows[0]!.id;
    ws = await getWorkspaceId();
    solo = await persistActor(ws, { id: "", name: `Solo ${stamp}`, type: "human", role: "editor" });
    await setWorkspaceOwner(ws, solo.id);
    spaceA = await makeSpace(ws, `A ${stamp}`, [{ id: solo.id, permission: "edit" }]);
    spaceB = await makeSpace(ws, `B ${stamp}`, [{ id: solo.id, permission: "edit" }]);

    // A trashed note and a live one with the same title: the trashed one is older, so it is restored first.
    const old = await create("二分搜尋法", "舊的。\n");
    expect((await send(solo, `/api/nodes/${old}`, "DELETE")).status).toBe(200);
    const live = await create("二分搜尋法", "新的。\n");
    // Links by title: the live note links to a title that two notes (one trashed) carry; a trashed note links to one too.
    await create("Linker", "見 [[二分搜尋法]]。\n");
    const ghost = await create("Ghost", "見 [[二分搜尋法]] 與 [[Linker]]。\n");
    expect((await send(solo, `/api/nodes/${ghost}`, "DELETE")).status).toBe(200);

    // Tasks written as lines of a note, with a clock time and an end, a day, a deadline and a finished one.
    const plan = await create("Plan", "- [ ] 晨跑 {task}\n- [x] 喝水 {task}\n- [ ] 暫時的 {task}\n");
    const tasks = (await q<{ id: string; title: string }>(`SELECT id::text, title FROM content_nodes WHERE parent_id = $1 AND hidden ORDER BY title`, [plan])).rows;
    const task = (title: string) => tasks.find((t) => t.title === title)!.id;
    expect((await send(solo, `/api/tasks/${task("晨跑")}`, "PATCH", { when_date: "2026-11-09", time: "07:30", until: "08:15", deadline: "2026-11-12" })).status).toBe(200);
    expect((await send(solo, `/api/tasks/${task("喝水")}`, "PATCH", { when_date: "2026-11-08", time: "21:00", until: "21:30", recur: "1w", recur_mode: "after" })).status).toBe(200);
    // A task whose line was taken out of the note: it sits in the trash.
    const body = (await q<{ markdown: string }>(`SELECT markdown FROM content_nodes WHERE id = $1`, [plan])).rows[0]!.markdown;
    await send(solo, `/api/nodes/${plan}`, "PATCH", { markdown: body.split("\n").filter((line) => !line.includes("暫時的")).join("\n") });

    // System attributes of a note itself.
    const marked = await create("Marked", "內文。\n");
    for (const [key, value] of [["_import_source_id", "obsidian:1"], ["_import_path", "folder/Marked.md"], ["_pinned", "true"], ["_color", "#aabbcc"], ["_captured", "true"], ["_tpl_origin", "t"], ["_published", "true"]]) {
      await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source) VALUES ($1, $2, $3, $4, 'text', 'ui')`, [ws, marked, key, value]);
    }

    source = await noteViewsOf(ws);
    const zip = Buffer.from(await (await app(solo).request("/api/backup/full.zip")).arrayBuffer());
    const up = await app(solo).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
    const uploadId = ((await up.json()) as { upload_id: string }).upload_id;
    const done = await applyAndWait(app(solo), uploadId, spaceB, "empty");
    expect(done.status, await done.clone().text()).toBe(200);
    restored = await noteViewsOf(ws);
  });

  const inSpace = (views: Map<string, NoteView>, name: string) => [...views.values()].filter((v) => v.space === name).sort((a, b) => a.key.replace(/^[^|]*/, "").localeCompare(b.key.replace(/^[^|]*/, "")));

  it("keeps the slug of every note, a live one over its trashed twin", () => {
    const a = inSpace(source, `A ${stamp}`).filter((n) => n.title === "二分搜尋法").map((n) => [n.deleted, n.slug]);
    const b = inSpace(restored, `B ${stamp}`).filter((n) => n.title === "二分搜尋法").map((n) => [n.deleted, n.slug]);
    expect(b.sort()).toEqual(a.sort());
    expect(b.find(([deleted]) => !deleted)![1]).toBe("二分搜尋法");
  });

  it("keeps the links: the live note links the live one, nothing links the trashed twin", () => {
    const edges = (views: Map<string, NoteView>, name: string) => inSpace(views, name).filter((n) => n.title === "Linker" || n.title === "Ghost").map((n) => [n.key.replace(/^[^|]*/, ""), n.edges.map((e) => e.replace(/^[^|]*/, ""))]);
    expect(edges(restored, `B ${stamp}`)).toEqual(edges(source, `A ${stamp}`));
  });

  it("keeps the fields of a task made from a line, and the task that sits in the trash", () => {
    const tasks = (views: Map<string, NoteView>, name: string) => inSpace(views, name).filter((n) => n.hidden).map((n) => [n.title, n.deleted, Object.fromEntries(Object.entries(n.attributes).filter(([k]) => k.startsWith("_task_") && k !== "_task_done_at"))]);
    const before = tasks(source, `A ${stamp}`);
    expect(before.length).toBeGreaterThanOrEqual(3);
    expect(tasks(restored, `B ${stamp}`)).toEqual(before);
    expect(JSON.stringify(before)).toContain("07:30");
  });

  it("brings back the system attributes that belong to a note", () => {
    const attrs = (views: Map<string, NoteView>, name: string) => Object.fromEntries(Object.entries(inSpace(views, name).find((n) => n.title === "Marked")!.attributes).filter(([k]) => k.startsWith("_")));
    // B is restored beside A in the same workspace, so every note took a new id and is a second copy: kept off the
    // site whatever the backup said (a 「發布」 does not carry to a copy). Everything else comes back as it was.
    const { _published: was, ...others } = attrs(source, `A ${stamp}`);
    expect(was).toBe("true");
    expect(attrs(restored, `B ${stamp}`)).toEqual({ ...others, _published: "false" });
    expect(attrs(restored, `B ${stamp}`)).toEqual(expect.objectContaining({ _import_source_id: "obsidian:1", _pinned: "true", _published: "false" }));
  });
});

// ── Everything the schema has is restored, or listed as not in a backup ──────────────────────────────────────────────
// helpers/backupInventory.ts is the one list. A kind that exists but is in neither column fails here until the backup
// handles it or the list says why it does not.

const keysOf = (record: Record<string, unknown>) => Object.keys(record).sort();
const checkValues = async (constraint: string): Promise<string[]> => {
  const def = (await q<{ d: string }>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1`, [constraint])).rows[0]?.d ?? "";
  return [...def.matchAll(/'([^']+)'::text/g)].map((m) => m[1]!).sort();
};

describe.skipIf(!enabled)("every kind of note data is restored or listed as not in a backup", () => {
  it("node kinds, note sources, attribute sources and value types", async () => {
    expect(await checkValues("content_nodes_node_type_check"), "a new node kind: restore it or list it in NODE_TYPES").toEqual(keysOf(NODE_TYPES));
    expect(await checkValues("content_nodes_source_type_check")).toEqual(keysOf(SOURCE_TYPES));
    expect(await checkValues("node_attributes_source_check")).toEqual(keysOf(ATTRIBUTE_SOURCES));
    expect(await checkValues("node_attributes_value_type_check")).toEqual(keysOf(VALUE_TYPES));
  });

  it("system attribute families: each class has a key that is classified into it", () => {
    for (const [family, entry] of Object.entries(SYSTEM_ATTRIBUTE_CLASSES)) expect(classifySystemAttr(entry.sample), family).toBe(family);
  });

  it("every table that keeps data about a note", async () => {
    const byKey = (await q<{ t: string }>(`SELECT DISTINCT conrelid::regclass::text AS t FROM pg_constraint WHERE contype = 'f' AND confrelid = 'content_nodes'::regclass`)).rows.map((r) => r.t);
    const byColumn = (await q<{ t: string }>(
      `SELECT DISTINCT table_name AS t FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name IN ('node_id', 'note_id', 'task_id', 'holder_node_id', 'source_node_id', 'target_node_id', 'target_id')`)).rows.map((r) => r.t);
    const found = [...new Set([...byKey, ...byColumn])].sort();
    expect(found, "a new table about notes: the backup must carry it, or NODE_TABLES must say why not").toEqual(keysOf(NODE_TABLES));
  });

  it("task statuses: all but the converted legacy one are round-tripped below", () => {
    expect(TASK_STATUSES.filter((status) => status in TASK_STATUSES_CONVERTED)).toEqual(Object.keys(TASK_STATUSES_CONVERTED).filter((k) => (TASK_STATUSES as readonly string[]).includes(k)));
  });
});

// A note and a tag with a view of every layout that exists, and a task of every shape and status: after a restore into
// another space they are all there.
describe.skipIf(!enabled)("a restored backup holds every view layout and every task status", () => {
  let ws = "";
  let solo: ActorCtx;
  let from = "";
  let into = "";
  let layouts: string[] = [];
  let before: Map<string, NoteView>;
  let after: Map<string, NoteView>;
  let viewsBefore: unknown[] = [];
  let viewsAfter: unknown[] = [];
  let report: RestoreReport;
  const statuses = TASK_STATUSES.filter((status) => !(status in TASK_STATUSES_CONVERTED));
  const stamp = randomUUID().slice(0, 6);
  const shape = (views: unknown[]) => (views as Array<Record<string, unknown>>)
    .map(({ id: _i, node_id: _n, tag_id: _t, created_at: _c, updated_at: _u, ...rest }) => rest).sort((a, b) => String(a.name).localeCompare(String(b.name)));

  beforeAll(async () => {
    ownWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Kinds', $1) RETURNING id::text`, [`kinds-${randomUUID()}`])).rows[0]!.id;
    ws = await getWorkspaceId();
    await setModulesOn(ws, null);
    solo = await persistActor(ws, { id: "", name: `Kinds ${stamp}`, type: "human", role: "editor" });
    await setWorkspaceOwner(ws, solo.id);
    from = await makeSpace(ws, `From ${stamp}`, [{ id: solo.id, permission: "edit" }]);
    into = await makeSpace(ws, `Into ${stamp}`, [{ id: solo.id, permission: "edit" }]);
    layouts = [...new Set([...viewLayouts(), WHITEBOARD_LAYOUT, ...noteViewLayouts()])].filter((layout) => !(layout in VIEW_LAYOUTS_NOT_IN_A_BACKUP));

    const made = await send(solo, "/api/nodes", "POST", { title: "Kinds", markdown: "- [ ] 行任務 {task}\n", space_id: from });
    const host = ((await made.json()) as { id: string }).id;
    for (const layout of layouts) {
      const res = await send(solo, `/api/nodes/${host}/views`, "POST", { name: `view ${layout}`, layout, layout_config: { marker: layout }, pin_order: 2 });
      expect(res.status, `a ${layout} view could not be made: ${await res.clone().text()}`).toBe(201);
    }
    for (const status of statuses) {
      const hosted = await send(solo, `/api/nodes/${host}/tasks`, "POST", { title: `hosted ${status}` });
      const standalone = await send(solo, "/api/tasks", "POST", { title: `alone ${status}` });
      for (const res of [hosted, standalone]) {
        expect(res.status, await res.clone().text()).toBe(201);
        const id = ((await res.json()) as { id: string }).id;
        const patched = await send(solo, `/api/tasks/${id}`, "PATCH", { status, when_date: "2026-12-01" });
        expect(patched.status, `${status}: ${await patched.clone().text()}`).toBe(200);
      }
    }
    before = await noteViewsOf(ws);
    viewsBefore = ((await (await send(solo, `/api/nodes/${host}/views`, "GET")).json()) as { views: unknown[] }).views;
    const zip = Buffer.from(await (await app(solo).request("/api/backup/full.zip")).arrayBuffer());
    const up = await app(solo).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
    const uploadId = ((await up.json()) as { upload_id: string }).upload_id;
    const done = await applyAndWait(app(solo), uploadId, into, "empty");
    expect(done.status, await done.clone().text()).toBe(200);
    report = (await done.json()) as RestoreReport;
    after = await noteViewsOf(ws);
    const copy = (await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE space_id = $1 AND title = 'Kinds'`, [into])).rows[0]!.id;
    viewsAfter = ((await (await send(solo, `/api/nodes/${copy}/views`, "GET")).json()) as { views: unknown[] }).views;
  });

  it("a note's view of every layout", () => {
    expect(viewsBefore).toHaveLength(layouts.length);
    expect(shape(viewsAfter)).toEqual(shape(viewsBefore));
    expect(report.skipped.views).toBe(0);
  });

  it("a task of every status, hosted and standalone, with its fields", () => {
    const taskNamed = (views: Map<string, NoteView>, title: string, inSpace: boolean) =>
      [...views.values()].filter((v) => v.hidden && v.title === title && ((v.space === `Into ${stamp}`) === inSpace));
    const fields = (v: NoteView) => Object.fromEntries(Object.entries(v.attributes).filter(([k]) => k.startsWith("_task_") && k !== "_task_done_at"));
    for (const status of statuses) {
      for (const title of [`hosted ${status}`, `alone ${status}`]) {
        const [was] = taskNamed(before, title, false);
        const [now] = taskNamed(after, title, true);
        expect(was, title).toBeDefined();
        expect(now, `${title} did not come back`).toBeDefined();
        expect(fields(now!), title).toEqual(fields(was!));
        expect(fields(now!)["_task_status"]).toBe(status);
      }
    }
    expect(report.skipped.tasks).toBe(0);
  });
});
