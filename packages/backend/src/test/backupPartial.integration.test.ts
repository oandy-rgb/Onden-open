// A session written somewhere else (the browser app's temporary mode) travels as a partial backup and is merged into a
// workspace under ONE new parent note: routes/backup.ts `full.zip?written=&since=&note=`, `parent_title` / `parent_id`
// on preview and apply, services/backupArchive.ts BackupSelection, services/backupRestore.ts RestoreParentNote.
// The source and the target are two workspaces (the phone's has its own notes), so the same ids really are new there.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { q } from "../db.js";

let currentWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => currentWorkspace }));
import { apiOnError } from "../httpError.js";
import backupRouter from "../routes/backup.js";
import { MEDIA_DIR } from "../services/mediaStore.js";
import { storeMedia } from "../services/media.js";
import { createNote } from "../services/noteCreate.js";
import { updateNode } from "../services/nodeUpdate.js";
import { setNodeAttribute } from "../services/attributeWrites.js";
import { createTag } from "../services/tagHierarchy.js";
import { applyTagToNode } from "../services/tagMembershipWrites.js";
import { restoreEvent } from "../services/eventRestore/index.js";
import type { RestorePreview } from "@onden/contract";
import type { RestoreJob } from "@onden/contract";
import type { ActorCtx } from "../types.js";
import type { RestoreReport } from "@onden/contract";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { waitForJob } from "./helpers/restoreJob.js";
import { zipEntries } from "./helpers/zipEntries.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { seedQ } from "./helpers/seedQ.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

registerShippedModules();

const enabled = isTestDatabase();

function app(actor: ActorCtx) {
  const hono = new Hono<{ Variables: { actor: ActorCtx } }>();
  hono.onError(apiOnError);
  hono.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  hono.route("/api/backup", backupRouter);
  return hono;
}

type Side = { ws: string; actor: ActorCtx; space: string };
type NoteRow = { id: string; title: string; markdown: string; parent_id: string | null; space_id: string | null; deleted: boolean };

async function sideOf(name: string): Promise<Side> {
  const ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ($1, $2) RETURNING id::text`, [name, `partial-${randomUUID()}`])).rows[0]!.id;
  const actor = await persistActor(ws, { id: "", name: `${name} ${randomUUID().slice(0, 6)}`, type: "human", role: "editor" });
  await setWorkspaceOwner(ws, actor.id);
  await q(`DELETE FROM space_members m USING spaces s WHERE m.space_id = s.id AND m.actor_id = $1 AND s.kind <> 'personal'`, [actor.id]);
  const space = await makeSpace(ws, `${name} space`, [{ id: actor.id, permission: "edit" }]);
  return { ws, actor, space };
}

async function zipOf(side: Side, query = ""): Promise<Buffer> {
  currentWorkspace = side.ws;
  const res = await app(side.actor).request(`/api/backup/full.zip${query}`);
  expect(res.status, await res.clone().text()).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

const sidecars = (zip: Buffer) => [...zipEntries(zip)].filter(([name]) => name.startsWith(".onden/notes/")).map(([, data]) => JSON.parse(data.toString()) as { id: string; title: string; markdown: string; tags: string[]; attributes: Array<{ key: string; value: string }> });
const manifestOf = (zip: Buffer) => JSON.parse(zipEntries(zip).get(".onden/manifest.json")!.toString()) as { counts: { notes: number; attachments: number } };

async function uploaded(side: Side, zip: Buffer): Promise<string> {
  currentWorkspace = side.ws;
  const res = await app(side.actor).request("/api/backup/restore/upload", { method: "POST", headers: { "content-type": "application/zip" }, body: new Uint8Array(zip) });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { upload_id: string }).upload_id;
}

type Parent = { parent_title?: string; parent_id?: string };
const queryOf = (p: Parent) => Object.entries(p).map(([k, v]) => `&${k}=${encodeURIComponent(v)}`).join("");

async function preview(side: Side, upload: string, mode: "empty" | "merge", parent: Parent = {}): Promise<Response> {
  currentWorkspace = side.ws;
  return app(side.actor).request(`/api/backup/restore/${upload}/preview?space=${side.space}&mode=${mode}${queryOf(parent)}`);
}

async function apply(side: Side, upload: string, parent: Parent = {}, mode: "empty" | "merge" = "merge"): Promise<Response> {
  currentWorkspace = side.ws;
  const hono = app(side.actor);
  const started = await hono.request(`/api/backup/restore/${upload}/apply`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ space_id: side.space, mode, ...parent }),
  });
  if (started.status !== 202 && started.status !== 200) return started;
  const job = await waitForJob(hono, ((await started.json()) as { job: RestoreJob }).job);
  return job.status === "done" ? Response.json(job.result, { status: 200 }) : Response.json({ error: job.error, job }, { status: job.error_status ?? 500 });
}

const notesIn = async (ws: string) => (await q<NoteRow>(
  `SELECT id::text, title, markdown, parent_id::text, space_id::text, deleted_at IS NOT NULL AS deleted
     FROM content_nodes WHERE workspace_id = $1 AND node_type = 'content' ORDER BY title`, [ws])).rows;
const attributesOf = async (id: string) => Object.fromEntries((await q<{ key: string; value: string }>(`SELECT key, value FROM node_attributes WHERE node_id = $1`, [id])).rows.map((r) => [r.key, r.value]));
const tagNamesOf = async (id: string) => (await q<{ title: string }>(`SELECT t.title FROM node_tags nt JOIN content_nodes t ON t.id = nt.tag_id WHERE nt.node_id = $1 ORDER BY t.title`, [id])).rows.map((r) => r.title);

/** Delete a workspace's notes for good: the source computer is gone, so its ids are free again where the notes land
 *  (in one database two workspaces cannot both hold an id, which two real devices can). */
async function purge(ws: string): Promise<void> {
  await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1`, [ws]);
  // The files it uploaded are no longer anyone's here either.
  await seedQ(`DELETE FROM media_uploads WHERE workspace_id = $1`, [ws]);
}

describe.skipIf(!enabled)("a session written elsewhere, merged under one parent note", () => {
  const stamp = randomUUID().slice(0, 8);

  /** A temporary workspace after a session: a blank note, a lecture with a slide file and a tag, a sketch with a drawing. */
  async function tabletSession() {
    const tablet = await sideOf("Tablet");
    const ids: Record<string, string> = {};
    currentWorkspace = tablet.ws;
    const write = async (name: string, markdown: string, parentId: string | null = null) => {
      currentWorkspace = tablet.ws;
      ids[name] = String((await createNote({ actor: tablet.actor, workspaceId: tablet.ws, title: `${name} ${stamp}`, markdown, spaceId: tablet.space, parentId, event: { uiContext: "test.session" } })).node.id);
    };
    // What a fresh temporary workspace holds before anything is written: one blank note.
    await createNote({ actor: tablet.actor, workspaceId: tablet.ws, title: "Untitled", markdown: "", spaceId: tablet.space, event: { uiContext: "test.session" } });
    const stored = await storeMedia(Buffer.from(`%PDF-1.4 partial ${randomUUID()}`), ".pdf", { actor: tablet.actor, workspaceId: tablet.ws, origin: "upload" });
    if (!stored.ok) throw new Error(stored.reason);
    const media = stored.filename;
    await write("Lecture", "Notes from class.\n");
    await write("Slides", `The [slides](/api/media/${media}).\n`, ids.Lecture!);
    await write("Sketch", "A page with a drawing.\n");
    await setNodeAttribute({ workspaceId: tablet.ws, actor: tablet.actor, nodeId: ids.Sketch!, attribute: { key: "ink_data", value: `{"v":1,"items":["${stamp}"]}` } });
    const tagName = `course${randomUUID().slice(0, 8)}`;
    const tagId = (await createTag({ actor: tablet.actor, workspaceId: tablet.ws, name: tagName })).id;
    await applyTagToNode({ workspaceId: tablet.ws, actor: tablet.actor, nodeId: ids.Slides!, tagId });
    const edit = async (name: string, markdown: string) => { currentWorkspace = tablet.ws; await updateNode(tablet.ws, ids[name]!, { markdown }, { actor: tablet.actor }); };
    return { tablet, ids, media, tagName, write, edit };
  }

  /** A workspace that already has notes of its own; they must come out of an import exactly as they went in. */
  async function phoneWithNotes(name = "Phone") {
    const phone = await sideOf(name);
    currentWorkspace = phone.ws;
    await createNote({ actor: phone.actor, workspaceId: phone.ws, title: `Existing ${stamp}`, markdown: "Mine.\n", spaceId: phone.space, event: { uiContext: "test.phone" } });
    return phone;
  }

  it("a written-only backup leaves out the blank note, keeps ancestors, tags, drawings and attachments", async () => {
    const { tablet } = await tabletSession();
    const zip = await zipOf(tablet, "?written=1");
    const notes = sidecars(zip);
    const titles = notes.map((n) => n.title).filter((t) => t.includes(stamp)).sort();
    expect(titles).toEqual([`Lecture ${stamp}`, `Sketch ${stamp}`, `Slides ${stamp}`]);
    expect(notes.some((n) => n.title === "Untitled" && n.markdown === "")).toBe(false);
    expect(manifestOf(zip).counts).toEqual(expect.objectContaining({ notes: 3, attachments: 1 }));
    expect(notes.find((n) => n.title === `Slides ${stamp}`)!.tags.length).toBe(1);
    expect(notes.find((n) => n.title === `Sketch ${stamp}`)!.attributes).toContainEqual(expect.objectContaining({ key: "ink_data", value: `{"v":1,"items":["${stamp}"]}` }));
    // A full backup still has everything (the blank note too).
    expect(sidecars(await zipOf(tablet)).some((n) => n.title === "Untitled" && n.markdown === "")).toBe(true);
  });

  it("a backup of one note carries that note, its ancestors and its attachment only; `since` carries what changed", async () => {
    const { tablet, ids, edit } = await tabletSession();
    const one = await zipOf(tablet, `?note=${ids.Slides}`);
    expect(sidecars(one).map((n) => n.title).filter((t) => t.includes(stamp)).sort()).toEqual([`Lecture ${stamp}`, `Slides ${stamp}`]);
    expect(manifestOf(one).counts.attachments).toBe(1);
    expect(manifestOf(await zipOf(tablet, `?note=${ids.Sketch}`)).counts.attachments).toBe(0);

    const cursor = new Date().toISOString();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await edit("Sketch", "A page with a drawing.\nAnd more.\n");
    const changed = await zipOf(tablet, `?written=1&since=${encodeURIComponent(cursor)}`);
    expect(sidecars(changed).map((n) => n.title).filter((t) => t.includes(stamp))).toEqual([`Sketch ${stamp}`]);
    // Nothing changed since the newest cursor: nothing of the session in it.
    const nothing = await zipOf(tablet, `?written=1&since=${encodeURIComponent(new Date(Date.now() + 1000).toISOString())}`);
    expect(sidecars(nothing).filter((n) => n.title.includes(stamp))).toEqual([]);
  });

  it("merges under one new parent note: the phone's notes are untouched, the shape, files, tags and drawings arrive", async () => {
    const { tablet, ids, media, tagName } = await tabletSession();
    const zip = await zipOf(tablet, "?written=1");
    await purge(tablet.ws);
    const phone = await phoneWithNotes();
    const before = (await notesIn(phone.ws)).map((n) => [n.id, n.title, n.markdown, n.parent_id]);
    const upload = await uploaded(phone, zip);
    const shown = await (await preview(phone, upload, "merge", { parent_title: `Class ${stamp}` })).json() as RestorePreview;
    expect(shown.new_parent).toEqual({ title: `Class ${stamp}`, exists: false });
    expect(shown.counts).toEqual(expect.objectContaining({ notes_new: 3, notes_conflict: 0, notes_new_id: 0 }));
    // Without the option the preview says nothing about a parent.
    expect((await (await preview(phone, upload, "merge")).json() as RestorePreview).new_parent).toBeNull();

    const original = readFileSync(join(MEDIA_DIR, media));
    rmSync(join(MEDIA_DIR, media));
    const res = await apply(phone, upload, { parent_title: `Class ${stamp}` });
    expect(res.status, await res.clone().text()).toBe(200);
    const report = await res.json() as RestoreReport;
    expect(report).toEqual(expect.objectContaining({ created: 3, superseded: 0, copies: 0, attachments_written: 1 }));
    expect(readFileSync(join(MEDIA_DIR, media))).toEqual(original);

    const after = await notesIn(phone.ws);
    const parent = after.find((n) => n.id === report.parent_note_id)!;
    expect(parent.title).toBe(`Class ${stamp}`);
    expect(parent.space_id).toBe(phone.space);
    for (const [id, title, markdown, parentId] of before) expect(after.find((n) => n.id === id)).toEqual(expect.objectContaining({ title, markdown, parent_id: parentId }));
    const byId = (name: string) => after.find((n) => n.id === ids[name])!;
    expect(byId("Lecture").parent_id).toBe(parent.id);
    expect(byId("Sketch").parent_id).toBe(parent.id);
    expect(byId("Slides").parent_id).toBe(ids.Lecture);
    expect(byId("Slides").markdown).toContain(`/api/media/${media}`);
    expect(await tagNamesOf(ids.Slides!)).toEqual([tagName]);
    expect((await attributesOf(ids.Sketch!)).ink_data).toBe(`{"v":1,"items":["${stamp}"]}`);
    // The blank note did not come along.
    expect(after.filter((n) => n.title === "Untitled" && n.id !== parent.id)).toEqual([]);

    // Importing the same package again (a new upload of the same bytes) changes nothing: same ids, same content.
    const again = await apply(phone, await uploaded(phone, zip), { parent_title: `Class ${stamp}`, parent_id: parent.id });
    expect(await again.json()).toEqual(expect.objectContaining({ created: 0, copies: 0, superseded: 0, unchanged: 3, parent_note_id: parent.id }));
    expect((await notesIn(phone.ws)).length).toBe(after.length);

    // Undo the first import: its notes go, the parent note with them, and the phone's own notes are as they were.
    currentWorkspace = phone.ws;
    const undone = await restoreEvent(report.event_id, { actor: phone.actor, workspaceId: phone.ws, cascade: true });
    expect("restored" in undone, JSON.stringify(undone)).toBe(true);
    const left = (await notesIn(phone.ws)).filter((n) => !n.deleted);
    expect(left.map((n) => [n.id, n.title, n.markdown, n.parent_id])).toEqual(before);
  });

  it("the same session imported again with a parent id: a note written further replaces its earlier version, unless it was edited here", async () => {
    const { tablet, ids, edit, write } = await tabletSession();
    const first = await zipOf(tablet, "?written=1");
    // On the tablet the lecture is written further, a new note is added, and later the sketch too.
    await edit("Lecture", "Notes from class.\nA few more lines.\n");
    await write("Homework", "Due Friday.\n", ids.Lecture!);
    const second = await zipOf(tablet, "?written=1");
    await edit("Sketch", "A page with a drawing.\nWritten on the tablet.\n");
    const third = await zipOf(tablet, "?written=1");
    await purge(tablet.ws);

    const phone = await phoneWithNotes("Phone2");
    const parentId = randomUUID();
    const parent = { parent_title: `Class ${stamp}`, parent_id: parentId };
    expect(await (await apply(phone, await uploaded(phone, first), parent)).json()).toEqual(expect.objectContaining({ created: 3, parent_note_id: parentId }));

    const upload2 = await uploaded(phone, second);
    const shown = await (await preview(phone, upload2, "merge", parent)).json() as RestorePreview;
    expect(shown.new_parent).toEqual({ title: `Class ${stamp}`, exists: true });
    expect(shown.counts).toEqual(expect.objectContaining({ notes_new: 1, notes_updated: 1, notes_unchanged: 2, notes_conflict: 0 }));
    expect(await (await apply(phone, upload2, parent)).json()).toEqual(expect.objectContaining({ created: 1, superseded: 1, copies: 0, unchanged: 2, parent_note_id: parentId }));
    const notes = await notesIn(phone.ws);
    expect(notes.filter((n) => n.title === `Lecture ${stamp}`)).toHaveLength(1);
    expect(notes.find((n) => n.title === `Lecture ${stamp}`)!.markdown).toBe("Notes from class.\nA few more lines.\n");
    expect(notes.find((n) => n.title === `Homework ${stamp}`)!.parent_id).toBe(ids.Lecture);
    expect(notes.filter((n) => n.parent_id === parentId)).toHaveLength(2);

    // Someone edits the Sketch on the phone before the tablet's newer version arrives: the phone's edit is never overwritten.
    currentWorkspace = phone.ws;
    await updateNode(phone.ws, ids.Sketch!, { markdown: "Edited on the phone.\n" }, { actor: phone.actor });
    const kept = await (await apply(phone, await uploaded(phone, third), parent)).json() as RestoreReport;
    expect(kept).toEqual(expect.objectContaining({ superseded: 0, copies: 1 }));
    const sketches = (await notesIn(phone.ws)).filter((n) => n.title.startsWith(`Sketch ${stamp}`));
    expect(sketches.map((n) => n.markdown).sort()).toEqual(["A page with a drawing.\nWritten on the tablet.\n", "Edited on the phone.\n"]);
    expect(sketches.every((n) => n.parent_id === parentId)).toBe(true);
  });

  it("refuses a parent note outside merge mode, and a target the person may not manage", async () => {
    const { tablet } = await tabletSession();
    const zip = await zipOf(tablet, "?written=1");
    const solo = await sideOf("Solo");
    const upload = await uploaded(solo, zip);
    const empty = await preview(solo, upload, "empty", { parent_title: "x" });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "bad_request" });
    expect((await apply(solo, upload, { parent_title: "x" }, "empty")).status).toBe(400);

    // A member who does not manage the space is refused, and nothing is made.
    const guest = await persistActor(solo.ws, { id: "", name: `Guest ${stamp}`, type: "human", role: "editor" });
    await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2::uuid, 'edit')`, [solo.space, guest.id]);
    const asGuest = { ...solo, actor: guest };
    const refused = await apply(asGuest, await uploaded(asGuest, zip), { parent_title: "x" });
    expect(refused.status).toBe(403);
    expect((await notesIn(solo.ws)).filter((n) => n.title === "x")).toEqual([]);
  });
});
