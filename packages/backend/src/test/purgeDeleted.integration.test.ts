// Deleting a deleted note for good (History's 「永久刪除」, services/nodeTrash.ts
// purgeDeleted) and deleting a shared space that still holds deleted notes
// (services/spaces.ts deleteSpace).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import nodesRouter from "../routes/nodes.js";
import { addTaskUnderNote } from "../modules/tasks/routes.js";
import eventsRouter from "../routes/events.js";
import spacesRouter from "../routes/spaces.js";
import { buildSyncDelta } from "../services/sync/delta.js";
import { createNote } from "../services/noteCreate.js";
import { MEDIA_DIR } from "../services/mediaStore.js";
import { mediaFiles } from "../services/mediaFiles.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import type { ActorCtx } from "../types.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";

registerShippedModules();

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);
app.post("/api/nodes/:id/tasks", addTaskUnderNote);
app.route("/api/events", eventsRouter);
app.route("/api/spaces", spacesRouter);

const call = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const as = (actor: ActorCtx) => { currentActor = actor; };

const stamp = `${Date.now()}`;
type Preview = {
  node: { id: string; title: string }; subtree: Array<{ id: string; title: string }>; tasks: number;
  live_descendants: Array<{ id: string }>; media: { images: number; files: number; kept: number };
  versions: number; attributes: number; ids: string[];
};

describe.skipIf(!isTestDatabase())("deleting a deleted note for good", () => {
  let WS = "";
  let owner: ActorCtx;      // the workspace owner: the only one who manages (purges from) the lab
  let coEditor: ActorCtx;   // edits the lab like `editor`; formerly a "manager", which no longer exists
  let editor: ActorCtx;     // edits in the lab
  let viewer: ActorCtx;     // reads the lab
  let outsider: ActorCtx;   // edits another space only
  let lab = "";
  const files: string[] = [];

  const create = async (title: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const res = await call("POST", "/api/nodes", { title, space_id: lab, ...extra });
    expect(res.status, title).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const del = async (id: string) => expect((await call("DELETE", `/api/nodes/${id}`)).status).toBe(200);
  const exists = async (id: string) => (await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [id])).rows.length === 1;
  const preview = async (id: string) => call("GET", `/api/nodes/${id}/purge-preview`);
  // The plan is required; a test that only checks a refusal sends the note alone.
  const purge = async (id: string, expected: string[] = [id]) => call("POST", `/api/nodes/${id}/purge`, { expected_ids: expected });
  const media = (ext: string) => {
    const name = `${randomBytes(16).toString("hex")}${ext}`;
    mkdirSync(MEDIA_DIR, { recursive: true });
    writeFileSync(join(MEDIA_DIR, name), "bytes");
    files.push(name);
    return name;
  };
  const deletedView = async (): Promise<Array<{ target_id: string; target_space_id?: string }>> => {
    const res = await call("GET", "/api/events?deleted=1&limit=500");
    expect(res.status).toBe(200);
    return ((await res.json()) as { events: Array<{ target_id: string; target_space_id?: string }> }).events;
  };
  const maxEvent = async () => Number((await q<{ m: string }>(`SELECT coalesce(max(id), 0)::text AS m FROM domain_events`)).rows[0]!.m);

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    owner = await persistActor(WS, { id: "pg-owner", name: "Owner", role: "admin", type: "human" });
    coEditor = await persistActor(WS, { id: "pg-coeditor", name: "Co-editor", role: "editor", type: "human" });
    editor = await persistActor(WS, { id: "pg-editor", name: "Editor", role: "editor", type: "human" });
    viewer = await persistActor(WS, { id: "pg-viewer", name: "Viewer", role: "viewer", type: "human" });
    outsider = await persistActor(WS, { id: "pg-outsider", name: "Outsider", role: "editor", type: "human" });
    lab = await makeSpace(WS, `Lab ${stamp}`, [
      { id: owner.id, permission: "edit" }, { id: coEditor.id, permission: "edit" },
      { id: editor.id, permission: "edit" }, { id: viewer.id, permission: "view" },
    ]);
    await makeSpace(WS, `Other ${stamp}`, [{ id: outsider.id, permission: "edit" }]);
  });

  afterAll(() => {
    for (const file of files) rmSync(join(MEDIA_DIR, file), { force: true });
  });

  it("removes exactly the subtree, its history and the files and blobs no one else uses", async () => {
    as(owner);
    const onlyMine = media(".png");
    const shared = media(".pdf");
    const live = await create(`PG live ${stamp}`, { markdown: `same body ${stamp}\n\n![](/api/media/${shared})` });
    const parent = await create(`PG secret parent ${stamp}`, { markdown: `first secret ${stamp}` });
    // A second version, a field, a link to the live note and both files.
    expect((await call("PATCH", `/api/nodes/${parent}`, {
      markdown: `secret body ${stamp} [[PG live ${stamp}]]\n\n![](/api/media/${onlyMine}) ![](/api/media/${shared})`,
    })).status).toBe(200);
    expect((await call("PUT", `/api/nodes/${parent}/attributes/pg_field`, { value: `secret value ${stamp}` })).status).toBe(200);
    const child = await create(`PG secret child ${stamp}`, { parent_id: parent, markdown: `same body ${stamp}\n\n![](/api/media/${shared})` });
    const task = (await (await call("POST", `/api/nodes/${parent}/tasks`, { title: `PG secret task ${stamp}` })).json() as { id: string }).id;
    // The upload of onlyMine belongs to the parent; shared to the parent too
    // (as if it were attached there first).
    await q(`INSERT INTO media_uploads (filename, workspace_id, uploader_actor_id, node_id) VALUES ($1,$2,$3,$4),($5,$2,$3,$4)`,
      [onlyMine, WS, owner.id, parent, shared]);
    const parentBlobs = (await q<{ h: string }>(
      `SELECT DISTINCT payload->>'body_hash' AS h FROM domain_events WHERE target_id = $1 AND payload ? 'body_hash'`, [parent])).rows.map((r) => r.h);
    const childBlob = (await q<{ h: string }>(
      `SELECT payload->>'body_hash' AS h FROM domain_events WHERE target_id = $1 AND payload ? 'body_hash' LIMIT 1`, [child])).rows[0]!.h;
    // A published snapshot that still carries the parent (published before it was deleted).
    await q(`INSERT INTO publish_snapshots (workspace_id, title, home_node_id, event_cursor, payload, artifact_ref)
             VALUES ($1, 'Site', $2, 0, $3, '/site/')`, [WS, parent, JSON.stringify({
      nodes: [{ id: parent, title: `PG secret parent ${stamp}`, slug: "secret", markdown: `secret body ${stamp}` },
              { id: live, title: `PG live ${stamp}`, slug: "live", markdown: "public" }],
      edges: [{ id: "e1", source_node_id: live, target_node_id: parent }],
      collections: [],
      presentation: { pageLayouts: { [parent]: { blocks: [] }, [live]: { blocks: [] } } },
      home_node_id: parent,
    })]);
    // An outbox row that carries its text under another key: a semantic embed
    // intent (nodeId + text), done or not.
    await q(`INSERT INTO outbox (workspace_id, effect_kind, dedup_key, payload, status) VALUES ($1, 'embed', $2, $3, 'done')`,
      [WS, `embed:${parent}`, JSON.stringify({ nodeId: parent, workspaceId: WS, text: `secret body ${stamp}` })]);
    await del(parent);
    const cursor = await maxEvent();
    expect((await deletedView()).find((e) => e.target_id === parent)?.target_space_id).toBe(lab);

    const shown = await preview(parent);
    expect(shown.status).toBe(200);
    const plan = (await shown.json()) as Preview;
    expect(plan.node).toEqual({ id: parent, title: `PG secret parent ${stamp}` });
    expect(plan.subtree.map((n) => n.id)).toEqual([child]);
    expect(plan.tasks).toBe(1);
    expect(plan.live_descendants).toEqual([]);
    expect(plan.media).toEqual({ images: 1, files: 0, kept: 1 });
    expect(plan.versions).toBeGreaterThanOrEqual(3);
    expect(plan.attributes).toBeGreaterThanOrEqual(1);
    expect([...plan.ids].sort()).toEqual([parent, child, task].sort());

    // The purge removes its files after the commit, without the response waiting for them (services/media.ts removeMediaFiles): the
    // test waits for those very removals instead of reading the disk the moment the response is in (it failed once, under load, doing that).
    const removals: Array<Promise<unknown>> = [];
    const store = mediaFiles();
    const removeFile = store.remove.bind(store);
    const spy = vi.spyOn(store, "remove").mockImplementation((file: string) => { const done = removeFile(file); removals.push(done); return done; });
    const res = await purge(parent, plan.ids);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ purged: 3, media_removed: 1 });
    await Promise.all(removals);
    spy.mockRestore();
    expect(removals).toHaveLength(1);

    for (const id of [parent, child, task]) expect(await exists(id)).toBe(false);
    expect(await exists(live)).toBe(true);
    for (const table of ["node_attributes", "node_tags", "block_nodes"]) {
      const column = table === "block_nodes" ? "note_id" : "node_id";
      expect((await q(`SELECT 1 FROM ${table} WHERE ${column} = ANY($1::uuid[])`, [[parent, child, task]])).rows).toEqual([]);
    }
    expect((await q(`SELECT 1 FROM node_edges WHERE source_node_id = ANY($1::uuid[]) OR target_node_id = ANY($1::uuid[])`,
      [[parent, child, task]])).rows).toEqual([]);
    // The parent's own versions go; the child's body is the live note's too, so its blob stays.
    expect((await q(`SELECT 1 FROM blobs WHERE hash = ANY($1::text[])`, [parentBlobs.filter((h) => h !== childBlob)])).rows).toEqual([]);
    expect((await q(`SELECT 1 FROM blobs WHERE hash = $1`, [childBlob])).rows.length).toBe(1);
    // Only the file no one else uses goes; the shared one moves to the live note.
    expect(existsSync(join(MEDIA_DIR, onlyMine))).toBe(false);
    expect((await q(`SELECT 1 FROM media_uploads WHERE filename = $1`, [onlyMine])).rows).toEqual([]);
    expect(existsSync(join(MEDIA_DIR, shared))).toBe(true);
    expect((await q<{ node_id: string }>(`SELECT node_id::text FROM media_uploads WHERE filename = $1`, [shared])).rows[0]!.node_id).toBe(live);

    expect((await q(`SELECT 1 FROM outbox WHERE dedup_key = ANY($1::text[])`, [[`embed:${parent}`]])).rows).toEqual([]);
    // The event log keeps no title or content of them.
    const leaks = await q(
      `SELECT id FROM domain_events WHERE (payload::text || tx_meta::text) LIKE '%secret%' || $1 || '%'`, [stamp]);
    expect(leaks.rows).toEqual([]);
    const erased = await q<{ payload: unknown; tx_meta: unknown }>(
      `SELECT payload, tx_meta FROM domain_events WHERE target_id = ANY($1::text[])`, [[parent, child, task]]);
    expect(erased.rows.length).toBeGreaterThan(0);
    for (const row of erased.rows) expect(row).toEqual({ payload: { purged: true }, tx_meta: { purged: true } });
    const purgedEvent = (await q<{ target_type: string; target_id: string; payload: Record<string, unknown> }>(
      `SELECT target_type, target_id, payload FROM domain_events WHERE event_type = 'NODES_PURGED' AND id > $1`, [cursor])).rows;
    expect(purgedEvent).toHaveLength(1);
    expect(purgedEvent[0]!.target_type).toBe("space");
    expect(purgedEvent[0]!.target_id).toBe(lab);
    expect(purgedEvent[0]!.payload).toEqual({ count: 3, node_ids: expect.arrayContaining([parent, child]), task_ids: [task] });

    // History no longer lists it, and its events are not readable anywhere.
    expect((await deletedView()).some((e) => [parent, child].includes(e.target_id))).toBe(false);
    const all = (await (await call("GET", "/api/events?limit=500")).json()) as { events: Array<{ target_id: string; event_type: string }> };
    expect(all.events.some((e) => [parent, child, task].includes(e.target_id))).toBe(false);
    expect(all.events.some((e) => e.event_type === "NODES_PURGED" && e.target_id === lab)).toBe(true);

    // The published snapshot no longer contains it; the live page stays.
    const snap = (await q<{ payload: Record<string, unknown>; home_node_id: string | null }>(
      `SELECT payload, home_node_id::text FROM publish_snapshots WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`, [WS])).rows[0]!;
    expect(JSON.stringify(snap.payload)).not.toContain(parent);
    expect(JSON.stringify(snap.payload)).not.toContain("secret");
    expect(JSON.stringify(snap.payload)).toContain(live);
    expect(snap.home_node_id).toBeNull();

    // Sync tells a client of the space to drop the rows (and the checklist item as a task).
    const delta = await buildSyncDelta(viewer, WS, { since: cursor, known: [] });
    expect(delta.nodes.delete).toEqual(expect.arrayContaining([parent, child]));
    expect(delta.tasks.delete).toContain(task);
    // Someone outside the space learns nothing of them.
    const elsewhere = await buildSyncDelta(outsider, WS, { since: cursor, known: [] });
    expect([...elsewhere.nodes.delete, ...elsewhere.tasks.delete].some((id) => [parent, child, task].includes(id))).toBe(false);

    // Idempotent: a second purge finds nothing.
    expect((await purge(parent)).status).toBe(404);
  });

  it("refuses editors, viewers, other spaces, a token, a live note and a stale confirmation", async () => {
    as(owner);
    const note = await create(`PG refuse ${stamp}`);
    as(editor); expect((await purge(note)).status).toBe(409); // live: not deleted (checked after read)
    as(owner); await del(note);
    as(editor); expect((await purge(note)).status).toBe(403);
    expect((await preview(note)).status).toBe(403);
    as(viewer); expect((await purge(note)).status).toBe(403);
    as(outsider); expect((await purge(note)).status).toBe(404); // not their space: not even found
    // An agent with edit permission and a write token: a token never manages spaces (spine/authority.ts).
    const token = await persistActor(WS, {
      id: "pg-agent", name: "Agent", role: "editor", type: "agent", tokenScope: { tokenId: "", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null },
    });
    await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2::uuid, 'edit')`, [lab, token.id]);
    as(token); expect([403, 404]).toContain((await purge(note)).status);
    // Another member with edit permission is refused too: purging is the owner's.
    as(coEditor); expect((await purge(note)).status).toBe(403);
    expect(await exists(note)).toBe(true);
    as(owner);
    // No plan at all is refused before anything is read.
    const planless = await call("POST", `/api/nodes/${note}/purge`, {});
    expect(planless.status).toBe(400);
    const stale = await purge(note, [note, "00000000-0000-0000-0000-000000000000"]);
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toBe("plan_changed");
    expect(await exists(note)).toBe(true);
    // The owner may.
    expect((await purge(note)).status).toBe(200);
    expect(await exists(note)).toBe(false);
  });

  it("a note recreated with a purged id after the purge reaches sync as an upsert, not a delete", async () => {
    // A backup restore brings purged notes back under their ids
    // (services/backupRestore.ts). One sync page holding both events must
    // apply them in order: the later create wins.
    as(owner);
    const note = await create(`PG revive ${stamp}`);
    await del(note);
    const cursor = await maxEvent();
    expect((await purge(note)).status).toBe(200);
    expect(await exists(note)).toBe(false);
    await createNote({ actor: owner, workspaceId: WS, id: note, title: `PG revive ${stamp}`, markdown: "back\n", spaceId: lab, event: { uiContext: "test" } });
    const delta = await buildSyncDelta(viewer, WS, { since: cursor, known: [] });
    expect(delta.nodes.delete).not.toContain(note);
    expect(delta.nodes.upsert.map((r) => r.id)).toContain(note);
    // And the other order: created, then purged in the same page — gone.
    const before = await maxEvent();
    await del(note);
    expect((await purge(note)).status).toBe(200);
    const after = await buildSyncDelta(viewer, WS, { since: before, known: [] });
    expect(after.nodes.delete).toContain(note);
    expect(after.nodes.upsert.map((r) => r.id)).not.toContain(note);
  });

  it("recreated in a space the reader cannot see, the purge still reaches them", async () => {
    as(owner);
    const note = await create(`PG ghost ${stamp}`);
    await del(note);
    const cursor = await maxEvent();
    expect((await purge(note)).status).toBe(200);
    const hidden = await makeSpace(WS, `Hidden ${stamp}`, [{ id: outsider.id, permission: "edit" }]);
    await createNote({ actor: outsider, workspaceId: WS, id: note, title: `PG ghost ${stamp}`, markdown: "elsewhere\n", spaceId: hidden, event: { uiContext: "test" } });
    const delta = await buildSyncDelta(viewer, WS, { since: cursor, known: [] });
    expect(delta.nodes.upsert.map((r) => r.id)).not.toContain(note);
    expect(delta.nodes.delete).toContain(note);
  });

  it("refuses while a note under it is live", async () => {
    as(owner);
    const parent = await create(`PG holds ${stamp}`);
    const child = await create(`PG live child ${stamp}`, { parent_id: parent });
    await del(parent);
    // D111 keeps this from happening; a purge must still not orphan one.
    await seedQ(`UPDATE content_nodes SET deleted_at = NULL, deleted_by_event_id = NULL WHERE id = $1`, [child]);
    const plan = (await (await preview(parent)).json()) as Preview;
    expect(plan.live_descendants.map((n) => n.id)).toEqual([child]);
    const res = await purge(parent);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("live_descendant");
    expect(await exists(parent)).toBe(true);
  });
});

describe.skipIf(!isTestDatabase())("deleting a shared space with deleted notes", () => {
  let WS = "";
  let owner: ActorCtx;
  let editor: ActorCtx;

  const createIn = async (space: string, title: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const res = await call("POST", "/api/nodes", { title, space_id: space, ...extra });
    expect(res.status, title).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const spaceOf = async (id: string) =>
    (await q<{ s: string | null }>(`SELECT space_id::text AS s FROM content_nodes WHERE id = $1`, [id])).rows[0]?.s;
  const isDeletedSpace = async (id: string) =>
    (await q<{ d: boolean }>(`SELECT deleted_at IS NOT NULL AS d FROM spaces WHERE id = $1`, [id])).rows[0]!.d;

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    owner = await persistActor(WS, { id: "sd-owner", name: "Owner", role: "admin", type: "human" });
    editor = await persistActor(WS, { id: "sd-editor", name: "Editor", role: "editor", type: "human" });
  });

  it("「一起永久刪除」 purges its deleted notes, then deletes it", async () => {
    as(owner);
    const space = await makeSpace(WS, `Purge me ${stamp}`, [{ id: owner.id, permission: "edit" }, { id: editor.id, permission: "edit" }]);
    const a = await createIn(space, `SD gone a ${stamp}`, { markdown: `sd secret ${stamp}` });
    const b = await createIn(space, `SD gone b ${stamp}`, { parent_id: a });
    expect((await call("DELETE", `/api/nodes/${a}`)).status).toBe(200);
    const shown = (await (await call("GET", `/api/spaces/${space}/delete-preview`)).json()) as {
      live_notes: number; deleted_notes: Array<{ id: string }>; deleted_count: number; deleted_ids: string[]; can_move_to_personal: boolean };
    expect(shown).toMatchObject({ live_notes: 0, deleted_count: 2, can_move_to_personal: true });
    expect(shown.deleted_notes.map((n) => n.id).sort()).toEqual([a, b].sort());
    expect([...shown.deleted_ids].sort()).toEqual([a, b].sort());
    as(editor);
    expect((await call("DELETE", `/api/spaces/${space}`, { deleted_notes: "purge", expected_deleted_ids: shown.deleted_ids })).status).toBe(403);
    as(owner);
    const unchosen = await call("DELETE", `/api/spaces/${space}`);
    expect(unchosen.status).toBe(409);
    expect(((await unchosen.json()) as { error: string }).error).toBe("deleted_notes");
    // A purge must match what the dialog showed: the same count with another
    // note in place of one (restored one, deleted another) still refuses.
    const swapped = [a, "00000000-0000-0000-0000-000000000000"];
    const stale = await call("DELETE", `/api/spaces/${space}`, { deleted_notes: "purge", expected_deleted_ids: swapped });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toBe("plan_changed");
    expect(await spaceOf(a)).toBe(space);
    expect((await call("DELETE", `/api/spaces/${space}`, { deleted_notes: "purge" })).status).toBe(400);
    const res = await call("DELETE", `/api/spaces/${space}`, { deleted_notes: "purge", expected_deleted_ids: shown.deleted_ids });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, purged: 2, moved: 0 });
    expect(await spaceOf(a)).toBeUndefined();
    expect(await spaceOf(b)).toBeUndefined();
    expect(await isDeletedSpace(space)).toBe(true);
    expect((await q(`SELECT 1 FROM domain_events WHERE payload::text LIKE '%sd secret ' || $1 || '%'`, [stamp])).rows).toEqual([]);
  });

  it("「搬到我的個人空間」 moves them, still deleted and restorable, then deletes it", async () => {
    as(owner);
    const space = await makeSpace(WS, `Move me ${stamp}`, [{ id: owner.id, permission: "edit" }]);
    const a = await createIn(space, `SD kept ${stamp}`);
    const b = await createIn(space, `SD kept child ${stamp}`, { parent_id: a });
    expect((await call("DELETE", `/api/nodes/${a}`)).status).toBe(200);
    const res = await call("DELETE", `/api/spaces/${space}`, { deleted_notes: "move" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, purged: 0, moved: 2 });
    const personal = (await q<{ id: string }>(
      `SELECT id::text FROM spaces WHERE kind = 'personal' AND owner_actor_id = $1`, [owner.id])).rows[0]!.id;
    expect(await spaceOf(a)).toBe(personal);
    expect(await spaceOf(b)).toBe(personal);
    expect(await isDeletedSpace(space)).toBe(true);
    // Still in History's deleted notes, and restoring brings both back.
    const listed = ((await (await call("GET", "/api/events?deleted=1&limit=500")).json()) as {
      events: Array<{ id: string; target_id: string; target_space_id: string }> }).events.find((e) => e.target_id === a)!;
    expect(listed.target_space_id).toBe(personal);
    expect((await call("POST", `/api/events/${listed.id}/restore`, {})).status).toBe(200);
    const alive = await q<{ id: string }>(`SELECT id::text FROM content_nodes WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [[a, b]]);
    expect(alive.rows.map((r) => r.id).sort()).toEqual([a, b].sort());
  });

  it("live notes still block it", async () => {
    as(owner);
    const space = await makeSpace(WS, `Busy ${stamp}`, [{ id: owner.id, permission: "edit" }]);
    const live = await createIn(space, `SD busy ${stamp}`);
    const gone = await createIn(space, `SD busy gone ${stamp}`);
    expect((await call("DELETE", `/api/nodes/${gone}`)).status).toBe(200);
    for (const body of [undefined, { deleted_notes: "purge", expected_deleted_ids: [gone] }, { deleted_notes: "move" }]) {
      const res = await call("DELETE", `/api/spaces/${space}`, body);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("not_empty");
    }
    expect(await spaceOf(live)).toBe(space);
    expect(await spaceOf(gone)).toBe(space);
    expect(await isDeletedSpace(space)).toBe(false);
  });

  it("an RSS subscription in it blocks it, as a live note does, until it is gone", async () => {
    as(owner);
    const space = await makeSpace(WS, `Feeds ${stamp}`, [{ id: owner.id, permission: "edit" }]);
    await seedQ(`INSERT INTO rss_subscriptions (workspace_id, space_id, title, url) VALUES ($1, $2, 'Feed', $3)`,
      [WS, space, `https://example.com/${stamp}.xml`]);
    const preview = await call("GET", `/api/spaces/${space}/delete-preview`);
    expect(((await preview.json()) as { subscriptions: number }).subscriptions).toBe(1);
    const res = await call("DELETE", `/api/spaces/${space}`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("has_subscriptions");
    expect(await isDeletedSpace(space)).toBe(false);
    await seedQ(`DELETE FROM rss_subscriptions WHERE space_id = $1`, [space]);
    expect((await call("DELETE", `/api/spaces/${space}`)).status).toBe(200);
    expect(await isDeletedSpace(space)).toBe(true);
  });
});
