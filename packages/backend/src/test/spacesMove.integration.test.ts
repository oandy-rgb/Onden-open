// Spaces phase 1b: managing spaces and moving notes between them
// (docs/architecture/spaces.md 「移動」「寫入規則」).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q } from "../db.js";

// A workspace of its own: the owner is whoever is persisted last as the
// fixture "admin" human, which must not race other suites on the default one.
let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));
import spacesRouter from "../routes/spaces.js";
import nodesRouter from "../routes/nodes.js";
import eventsRouter from "../routes/events.js";
import { persistActor } from "./helpers/persistActor.js";
import { assertAuthority } from "../spine/authority.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /_test\b/.test(DB) || /onden_test(\?|$)/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/spaces", spacesRouter);
app.route("/api/nodes", nodesRouter);
app.route("/api/events", eventsRouter);

const J = { "content-type": "application/json" };
const call = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: J, body: body === undefined ? undefined : JSON.stringify(body) });

describe.skipIf(!isTestDb)("spaces: manage and move", () => {
  const stamp = Date.now();
  let admin: ActorCtx;   // the workspace owner
  let editor: ActorCtx;  // edit member of the default space
  let viewer: ActorCtx;  // view member of the default space
  let lab = "";          // a shared space the owner creates (beforeAll)

  const mk = async (title: string, parentId: string | null = null) => (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id)
     VALUES ($1,'manual','content',$2,$2,'x',$3) RETURNING id::text`, [WS, `${title}-${stamp}`, parentId])).rows[0]!.id;
  const spaceOf = async (id: string) =>
    (await q<{ s: string }>(`SELECT space_id::text AS s FROM content_nodes WHERE id = $1`, [id])).rows[0]!.s;
  // A shared space the owner creates (and so edits), with the editor as an edit member.
  let labs = 0;
  const makeLab = async () => {
    currentActor = admin;
    const res = await call("POST", "/api/spaces", { name: `Lab ${stamp} ${++labs}` });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    expect((await call("PUT", `/api/spaces/${id}/members/${editor.id}`, { permission: "edit" })).status).toBe(200);
    return id;
  };
  const epoch = async () => (await q<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [WS])).rows[0]!.e;

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Spaces move', $1) RETURNING id::text`, [`spaces-move-${stamp}`])).rows[0]!.id;
    admin = await persistActor(WS, { id: `mv-admin-${stamp}`, name: "Admin", role: "admin", type: "human" });
    editor = await persistActor(WS, { id: `mv-editor-${stamp}`, name: "Editor", role: "editor", type: "human" });
    viewer = await persistActor(WS, { id: `mv-viewer-${stamp}`, name: "Viewer", role: "viewer", type: "human" });
    lab = await makeLab();
  });

  it("only the owner creates a shared space and manages it; a member who edits it cannot", async () => {
    currentActor = editor;
    expect((await call("POST", "/api/spaces", { name: `Editor lab ${stamp}` })).status).toBe(403);
    const lab = await makeLab();
    const members = ((await (await call("GET", `/api/spaces/${lab}/members`)).json()) as { members: Array<{ id: string; permission: string; type: string }> }).members;
    expect(members.every((m) => m.type === "human" || m.type === "agent")).toBe(true); // 空間與成員 draws the AI badge from it
    expect(members.map((m) => [m.id, m.permission]).sort()).toEqual([[admin.id, "edit"], [editor.id, "edit"]].sort());
    // An edit member is not a manager: no member changes, no space changes.
    currentActor = editor;
    expect((await call("PUT", `/api/spaces/${lab}/members/${viewer.id}`, { permission: "view" })).status).toBe(403);
    expect((await call("DELETE", `/api/spaces/${lab}/members/${admin.id}`)).status).toBe(403);
    expect((await call("PATCH", `/api/spaces/${lab}`, { name: "Renamed by editor" })).status).toBe(403);
    // A non-member cannot even list them; the owner removes an editor.
    currentActor = viewer;
    expect((await call("PUT", `/api/spaces/${lab}/members/${viewer.id}`, { permission: "edit" })).status).toBe(403);
    expect((await call("GET", `/api/spaces/${lab}/members`)).status).toBe(403);
    currentActor = admin;
    expect((await call("DELETE", `/api/spaces/${lab}/members/${editor.id}`)).status).toBe(200);
  });

  it("a personal space has only its owner", async () => {
    const personal = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id::text = $1`, [editor.id])).rows[0]!.id;
    currentActor = editor;
    expect((await call("PUT", `/api/spaces/${personal}/members/${admin.id}`, { permission: "view" })).status).toBe(409);
    // The workspace owner cannot step into someone's personal space either.
    currentActor = admin;
    expect((await call("PATCH", `/api/spaces/${personal}`, { capabilities: { external_ai: true } })).status).toBe(404);
  });

  it("preview names who gains and loses access; a stale confirmation is refused", async () => {
    const root = await mk("mv-root");
    currentActor = admin;
    const preview = (await (await call("GET", `/api/spaces/move-preview?node=${root}&to=${lab}`)).json()) as {
      gain: Array<{ id: string }>; lose: Array<{ id: string }>; membership_epoch: string; notes: number };
    expect(preview.notes).toBe(1);
    expect(preview.lose.map((m) => m.id)).toContain(viewer.id);
    expect(preview.gain).toEqual([]);
    expect((await call("POST", "/api/spaces/move", { node_id: root, to_space_id: lab, membership_epoch: String(Number(preview.membership_epoch) - 1) })).status).toBe(409);
    expect(await spaceOf(root)).not.toBe(lab);
  });

  it("moves the whole subtree, trashed children too, detaching it from a parent left behind", async () => {
    const parent = await mk("mv-parent");
    const note = await mk("mv-note", parent);
    const child = await mk("mv-child", note);
    const trashed = await mk("mv-trashed", note);
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [trashed]);
    currentActor = admin;
    const before = await epoch();
    const res = await call("POST", "/api/spaces/move", { node_id: note, to_space_id: lab, membership_epoch: before });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { moved: number }).moved).toBe(3);
    for (const id of [note, child, trashed]) expect(await spaceOf(id)).toBe(lab);
    expect((await q<{ p: string | null }>(`SELECT parent_id::text AS p FROM content_nodes WHERE id = $1`, [note])).rows[0]!.p).toBeNull();
    expect(Number(await epoch())).toBeGreaterThan(Number(before));

    // Undo moves it back and re-attaches it under its old parent.
    const ev = (await q<{ id: string }>(
      `SELECT id::text FROM domain_events WHERE event_type = 'NODE_MOVED_SPACE' AND target_id = $1 ORDER BY domain_events.id DESC LIMIT 1`, [note])).rows[0]!;
    const undo = await call("POST", `/api/events/${ev.id}/restore`, {});
    expect(undo.status).toBe(200);
    expect(await spaceOf(note)).toBe(await spaceOf(parent));
    expect(await spaceOf(trashed)).toBe(await spaceOf(parent));
    expect((await q<{ p: string | null }>(`SELECT parent_id::text AS p FROM content_nodes WHERE id = $1`, [note])).rows[0]!.p).toBe(parent);
  });

  it("only the owner may move notes out of a shared source space", async () => {
    const note = await mk("mv-editor-note");
    currentActor = editor; // an edit member (not the owner) of the default space
    expect((await call("POST", "/api/spaces/move", { node_id: note, to_space_id: lab, membership_epoch: await epoch() })).status).toBe(403);
  });

  it("putting a note under a note in another space is refused (409), not a commit-time failure", async () => {
    const here = await mk("mv-here");
    currentActor = admin;
    const there = await mk("mv-there");
    await call("POST", "/api/spaces/move", { node_id: there, to_space_id: lab, membership_epoch: await epoch() });
    const res = await call("PATCH", `/api/nodes/${here}`, { parent_id: there });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("parent_in_other_space");
  });

  it("a delegated token never acts on spaces", async () => {
    const token: ActorCtx = { ...admin, tokenScope: { tokenId: "t", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null } };
    await expect(assertAuthority(token, { kind: "space", spaceId: lab, need: "read" })).rejects.toThrow(/delegated token/);
  });

  it("only an empty shared space can be deleted", async () => {
    const full = await makeLab();
    currentActor = admin;
    expect((await call("POST", "/api/spaces/move", { node_id: await mk("mv-full"), to_space_id: full, membership_epoch: await epoch() })).status).toBe(200);
    currentActor = editor;
    expect((await call("DELETE", `/api/spaces/${full}`)).status).toBe(403); // not the owner
    currentActor = admin;
    expect((await call("DELETE", `/api/spaces/${full}`)).status).toBe(409); // holds notes
    currentActor = admin;
    const empty = ((await (await call("POST", "/api/spaces", { name: `Empty ${stamp}` })).json()) as { id: string }).id;
    currentActor = editor;
    expect((await call("DELETE", `/api/spaces/${empty}`)).status).toBe(403);
    currentActor = admin;
    expect((await call("DELETE", `/api/spaces/${empty}`)).status).toBe(200);
    const def = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [WS])).rows[0]!.id;
    currentActor = admin;
    expect((await call("DELETE", `/api/spaces/${def}`)).status).toBe(409);
  });
});
