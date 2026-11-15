// Spaces decide access (docs/architecture/spaces.md): membership alone decides
// reads and writes; a tag carries no permission, even one with a leftover
// `policy` in its schema.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import nodesRouter from "../routes/nodes.js";
import rssRouter from "../modules/rss/routes.js";
import { persistActor } from "./helpers/persistActor.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { canReadNode, readableNodeIdSet } from "../services/readPolicy.js";
import { assertAuthority } from "../spine/authority.js";
import { createSharedSpace, moveToSpace, setMember } from "../services/spaces.js";
import { filterByCapability } from "../spine/spaceScope.js";
import { backupTarget } from "../services/outbox.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /_test\b/.test(DB) || /onden_test(\?|$)/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);
const rssApp = new Hono<{ Variables: { actor: ActorCtx | null } }>();
rssApp.onError(apiOnError);
rssApp.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
rssApp.route("/api/rss", rssRouter);
const call = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

describe.skipIf(!isTestDb)("spaces decide access", () => {
  const stamp = Date.now();
  let WS = "";
  let admin: ActorCtx;
  let editor: ActorCtx;
  let viewer: ActorCtx;
  let open = "";
  let labNote = "";
  let lockedByTag = "";

  const mk = async (title: string) => (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1,'manual','content',$2,$2,'x') RETURNING id::text`, [WS, `${title}-${stamp}`])).rows[0]!.id;

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    admin = await persistActor(WS, { id: `en-admin-${stamp}`, name: "Admin", role: "admin", type: "human" });
    editor = await persistActor(WS, { id: `en-editor-${stamp}`, name: "Editor", role: "editor", type: "human" });
    viewer = await persistActor(WS, { id: `en-viewer-${stamp}`, name: "Viewer", role: "viewer", type: "human" });
    open = await mk("en-open");
    labNote = await mk("en-lab");
    lockedByTag = await mk("en-locked");
    // A tag schema still carrying an old access policy (094 strips them; a
    // pack or a raw write could bring one back): it must mean nothing.
    const { tagId } = await seedClassTag(WS, { name: `en-lock-${stamp}`, policy: { operations: { read: "admin" } } });
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2)`, [lockedByTag, tagId]);
    // A lab space: the owner manages it, the viewer may read it, the editor is not in it.
    const { id: lab } = await createSharedSpace(admin, WS, `Lab ${stamp}`);
    await setMember(admin, WS, lab, viewer.id, "view");
    const epoch = (await q<{ e: string }>(`SELECT membership_epoch::text AS e FROM workspaces WHERE id = $1`, [WS])).rows[0]!.e;
    await moveToSpace(admin, WS, labNote, lab, epoch);
  });

  it("reads follow membership: outside the lab you cannot see its notes; a tag policy no longer hides anything", async () => {
    expect(await canReadNode(editor, labNote)).toBe(false);
    expect((await readableNodeIdSet(editor, WS)).has(labNote)).toBe(false);
    expect(await canReadNode(viewer, labNote)).toBe(true);
    expect(await canReadNode(viewer, lockedByTag)).toBe(true); // the admin-read tag carries no permission now
    currentActor = editor;
    expect((await call("GET", `/api/nodes/${labNote}`)).status).toBe(404);
  });

  it("writes need edit permission in the note's space", async () => {
    currentActor = viewer;
    expect((await call("PATCH", `/api/nodes/${labNote}`, { title: "viewer edit" })).status).toBe(403);
    expect((await call("PATCH", `/api/nodes/${open}`, { title: "viewer edit" })).status).toBe(403);
    currentActor = editor;
    expect((await call("PATCH", `/api/nodes/${open}`, { title: `edited ${stamp}` })).status).toBe(200);
    currentActor = admin;
    expect((await call("PATCH", `/api/nodes/${labNote}`, { title: `lab edited ${stamp}` })).status).toBe(200);
  });

  it("a read-only member still writes in their own personal space: a root note lands there", async () => {
    currentActor = viewer;
    const res = await call("POST", "/api/nodes", { title: `mine ${stamp}`, markdown: "private" });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    const where = await q<{ kind: string; owner: string | null }>(
      `SELECT s.kind, s.owner_actor_id::text AS owner FROM content_nodes n JOIN spaces s ON s.id = n.space_id WHERE n.id = $1`, [id]);
    expect(where.rows[0]).toEqual({ kind: "personal", owner: viewer.id });
    expect(await canReadNode(editor, id)).toBe(false);
    expect(await canReadNode(admin, id)).toBe(false); // not even the owner sees someone's personal space
  });

  it("a token only reaches spaces whose external_ai switch is on", async () => {
    const token: ActorCtx = { ...admin, tokenScope: { tokenId: "t", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null } };
    const def = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [WS])).rows[0]!.id;
    expect(await canReadNode(token, open)).toBe(true); // the default space was created with external_ai on
    expect(await canReadNode(token, labNote)).toBe(false); // a new shared space starts with it off
    await expect(assertAuthority(token, { kind: "node", nodeId: labNote, op: "write_node" })).rejects.toThrow();
    expect(def).toBeTruthy();
  });

  it("content leaves the server only from spaces whose switch allows it", async () => {
    // AI: the lab started with external_ai off; the default space has it on.
    const allowed = await filterByCapability(WS, "external_ai", new Set([open, labNote]));
    expect([...allowed]).toEqual([open]);
    // Backup: a member's personal space is out of the owner's backup by default.
    currentActor = viewer;
    const res = await call("POST", "/api/nodes", { title: `diary ${stamp}`, markdown: "x" });
    const diary = ((await res.json()) as { id: string }).id;
    expect(await backupTarget({ nodeId: diary })).toBeNull();
    expect(await backupTarget({ nodeId: open })).not.toBeNull();
    // A note that is gone writes nothing (fails closed).
    expect(await backupTarget({ nodeId: "00000000-0000-0000-0000-000000000000" })).toBeNull();
  });

  it("in a space with shared 'seen', one person marking an RSS item seen marks it for everyone there", async () => {
    const lab = (await q<{ space_id: string }>(`SELECT space_id::text FROM content_nodes WHERE id = $1`, [labNote])).rows[0]!.space_id;
    await q(`UPDATE spaces SET capabilities = capabilities || '{"shared_seen": true}'::jsonb WHERE id = $1`, [lab]);
    const source = (await seedQ<{ id: string }>(
      `INSERT INTO rss_subscriptions (workspace_id, space_id, title, url) VALUES ($1,$3,$2,$4) RETURNING id::text`,
      [WS, `en-feed-${stamp}`, lab, `https://feed.test/en-${stamp}.xml`])).rows[0]!.id;
    const item = (await q<{ id: string }>(
      `INSERT INTO rss_staging (workspace_id, subscription_id, guid, title) VALUES ($1,$2,$3,'Paper') RETURNING id::text`,
      [WS, source, `g-${stamp}`])).rows[0]!.id;
    currentActor = admin;
    expect((await rssApp.request(`/api/rss/items/${item}/seen`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(200);
    const row = await q<{ seen_at: string | null }>(`SELECT seen_at FROM rss_staging WHERE id = $1`, [item]);
    expect(row.rows[0]!.seen_at).not.toBeNull(); // shared: the stream's own mark, for the viewer too
    expect((await q(`SELECT 1 FROM rss_seen WHERE staging_id = $1`, [item])).rowCount).toBe(0);
  });
});
