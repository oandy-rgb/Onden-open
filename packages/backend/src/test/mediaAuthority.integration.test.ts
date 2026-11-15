// Media authorization regression (media-auth bug 2026-06-13) — GET /api/media/*
// served attachments of read-restricted nodes with ZERO auth: anyone (incl. an
// anonymous caller) could fetch /api/media/<filename> and read an image embedded
// only in a node behind an admin-required read policy. Under spaces
// (docs/architecture/spaces.md) "restricted" means: in an admin-only space the
// viewer is not a member of (and whose `publish` switch is off).
//
// A media file has no DB record; its "owner" is the set of nodes whose markdown
// embeds `/api/media/<filename>`. The fix gates the route through
// canReadMedia(actor, filename, ws):
//
//   • a file referenced ONLY by a restricted node → 404 for a non-readers
//     (anonymous + low-role human), 200 for a reader (admin)
//   • a file referenced by a PUBLIC (untagged) node → 200 for signed-in readers;
//     anonymous only when the served site (latest snapshot minus takedowns,
//     W38a) shows it through that node (a published note, the site-config node). GAP-236: readable-by-viewer used to count as
//     public, so an unpublished note's image was anonymous; being marked for
//     publishing is not enough either until a Publish.
//   • an UNATTACHED file (no node references it — fresh upload / favicon) → 200
//     for authenticated actors only (new-upload preview)
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import { adminOnlySpace, joinDefaultSpace, makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import mediaRouter from "../routes/media.js";
import { MEDIA_DIR } from "../services/mediaStore.js";
import { buildAndEnqueueSnapshot } from "../modules/website/publishing/snapshot.js";
import type { ActorCtx } from "../types.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";
import { ensureConfigNode } from "./helpers/siteConfigFixture.js";

registerShippedModules();

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/media", mediaRouter);

const viewer: ActorCtx = { id: "22222222-2222-2222-2222-2222222222aa", name: "Viewer", role: "viewer", type: "human" };
const admin: ActorCtx = { id: "22222222-2222-2222-2222-2222222222cc", name: "Admin", role: "admin", type: "human" };

const get = (filename: string) => app.request(`/api/media/${filename}`);
const publish = async () => { await buildAndEnqueueSnapshot(await getWorkspaceId(), { id: admin.id, type: "human" }, { title: "Media site" }); };
// The admin-only space restricted notes go into (set in beforeAll).
let secretSpace = "";
const restrict = (nodeId: string) => putInSpace(nodeId, secretSpace);
// A space whose 「發布到網站」 is on (every note in it goes out at a publish): the notes a test publishes live here, so
// the default space's other notes stay private.
let publishingSpace = "";
const publishIn = (nodeId: string) => putInSpace(nodeId, publishingSpace);

describe.skipIf(!isTestDb)("media authorization — GET /api/media/* obeys node read policy (DB)", () => {
  const stamp = Date.now();
  const restrictedFile = `${stamp}-restricted.webp`;
  const publicFile = `${stamp}-public.webp`;
  const orphanFile = `${stamp}-orphan.webp`;
  const created: string[] = [];

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    const WS = await getWorkspaceId();

    // Drop a few bytes on disk for each filename so existsSync passes and the
    // route reaches the auth gate (a missing file 404s before the gate).
    mkdirSync(MEDIA_DIR, { recursive: true });
    for (const f of [restrictedFile, publicFile, orphanFile]) {
      const p = join(MEDIA_DIR, f);
      writeFileSync(p, Buffer.from([0x52, 0x49, 0x46, 0x46])); // "RIFF"
      created.push(p);
    }

    // Real actor rows in the default space (membership is explicit since
    // 097), and an admin-only space for the restricted notes.
    for (const a of [viewer, admin]) {
      await q(`INSERT INTO actors (id, workspace_id, name, type) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
        [a.id, WS, a.name, a.type]);
      await joinDefaultSpace(WS, a.id, a.role);
    }
    secretSpace = await adminOnlySpace(WS, `ma-secret-${stamp}`, [admin.id]);
    publishingSpace = await makeSpace(WS, `ma-publishing-${stamp}`, [{ id: admin.id, role: "manager" }], { publish: true, external_ai: true, backup: true });

    // A restricted node that embeds restrictedFile, and a public (default-space) node
    // that embeds publicFile. orphanFile is referenced by nobody.
    const restricted = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Restricted ${stamp}','restricted-${stamp}',$2) RETURNING id`,
      [WS, `secret\n\n![](/api/media/${restrictedFile})`]);
    await seedQ(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content','Public ${stamp}','public-${stamp}',$2)`,
      [WS, `hello\n\n![](/api/media/${publicFile})`]);

    await restrict(restricted.rows[0]!.id);
  });

  afterAll(() => {
    for (const p of created) if (existsSync(p)) rmSync(p, { force: true });
  });

  // Re-enabled after reproducing the false empty reference set in PostgreSQL:
  // a PGroonga ILIKE index scan missed media URLs that a sequential scan found.
  // canReadMedia now uses literal containment, independent of that search index.
  it("(a) anonymous CANNOT fetch a restricted node's asset → 404", async () => {
    currentActor = null;
    expect((await get(restrictedFile)).status).toBe(404);
  });

  it("(b) a low-role human CANNOT fetch a restricted node's asset → 404", async () => {
    currentActor = viewer;
    expect((await get(restrictedFile)).status).toBe(404);
  });

  it("(c) an admin (reader of the owning node) CAN fetch it → 200", async () => {
    currentActor = admin;
    expect((await get(restrictedFile)).status).toBe(200);
  });

  it("(c2) pasting a seen URL into your own note does not grant the file (oldest reference decides)", async () => {
    const ws = await getWorkspaceId();
    // The viewer copies the restricted file's URL into a note they can read.
    await seedQ(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$2,$3)`,
      [ws, `paste-${stamp}`, `![](/api/media/${restrictedFile})`]);
    currentActor = viewer;
    expect((await get(restrictedFile)).status).toBe(404);
    currentActor = admin;
    expect((await get(restrictedFile)).status).toBe(200);
  });

  it("(c3) trashing the original does not hand its file to a later paste", async () => {
    const ws = await getWorkspaceId();
    const filename = `${stamp}-trashed-owner.webp`;
    writeFileSync(join(MEDIA_DIR, filename), Buffer.from("RIFF")); created.push(join(MEDIA_DIR, filename));
    const original = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, created_at)
       VALUES ($1,'manual','content',$2,$2,$3, now() - interval '1 hour') RETURNING id`,
      [ws, `trash-owner-${stamp}`, `![](/api/media/${filename})`])).rows[0]!;
    await restrict(original.id);
    await seedQ(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$2,$3)`,
      [ws, `trash-paste-${stamp}`, `![](/api/media/${filename})`]);
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [original.id]);
    currentActor = viewer;
    expect((await get(filename)).status).toBe(404);
  });

  it("(c4) a recorded upload previews for its uploader only", async () => {
    const ws = await getWorkspaceId();
    const filename = `${stamp}-uploaded.webp`;
    writeFileSync(join(MEDIA_DIR, filename), Buffer.from("RIFF")); created.push(join(MEDIA_DIR, filename));
    await q(`INSERT INTO media_uploads (filename, workspace_id, uploader_actor_id) VALUES ($1,$2,$3)`,
      [filename, ws, admin.id]);
    currentActor = viewer;
    expect((await get(filename)).status).toBe(404);
    currentActor = admin;
    expect((await get(filename)).status).toBe(200);
  });

  it("(d) an UNPUBLISHED public node's asset is not anonymous (GAP-236), but readers keep it", async () => {
    currentActor = null;
    expect((await get(publicFile)).status).toBe(404);
    currentActor = viewer;
    expect((await get(publicFile)).status).toBe(200);
  });

  it("(d2) publishing the note makes its asset anonymous; unpublishing withdraws it", async () => {
    const ws = await getWorkspaceId();
    const filename = `${stamp}-published.webp`;
    writeFileSync(join(MEDIA_DIR, filename), Buffer.from("RIFF")); created.push(join(MEDIA_DIR, filename));
    const node = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$2,$3) RETURNING id`,
      [ws, `published-${stamp}`, `![](/api/media/${filename})`])).rows[0]!;
    await publishIn(node.id);
    currentActor = null;
    expect((await get(filename)).status).toBe(404);
    await seedQ(`INSERT INTO node_attributes (workspace_id,node_id,key,value,value_type,source) VALUES ($1,$2,'_published','true','bool','explicit')`, [ws, node.id]);
    expect((await get(filename)).status).toBe(404); // marked, not yet published
    await publish();
    expect((await get(filename)).status).toBe(200);
    // A file the published note embeds after the snapshot waits for the next publish.
    const later = `${stamp}-published-later.webp`;
    writeFileSync(join(MEDIA_DIR, later), Buffer.from("RIFF")); created.push(join(MEDIA_DIR, later));
    await seedQ(`UPDATE content_nodes SET markdown = markdown || $2 WHERE id = $1`, [node.id, `\n![](/api/media/${later})`]);
    expect((await get(later)).status).toBe(404);
    await publish();
    expect((await get(later)).status).toBe(200);
    await seedQ(`UPDATE node_attributes SET value='false' WHERE node_id=$1 AND key='_published'`, [node.id]);
    expect((await get(filename)).status).toBe(404); // a takedown needs no publish
  });

  it("(d3) a published but read-restricted note's asset stays private to anonymous", async () => {
    const ws = await getWorkspaceId();
    const filename = `${stamp}-pub-locked.webp`;
    writeFileSync(join(MEDIA_DIR, filename), Buffer.from("RIFF")); created.push(join(MEDIA_DIR, filename));
    const node = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$2,$3) RETURNING id`,
      [ws, `pub-locked-${stamp}`, `![](/api/media/${filename})`])).rows[0]!;
    await seedQ(`INSERT INTO node_attributes (workspace_id,node_id,key,value,value_type,source) VALUES ($1,$2,'_published','true','bool','explicit')`, [ws, node.id]);
    await restrict(node.id);
    currentActor = null;
    expect((await get(filename)).status).toBe(404);
  });

  it("(d4) site logo/favicon on the config node are anonymous once a publish carries them", async () => {
    const ws = await getWorkspaceId();
    const configId = await ensureConfigNode(ws);
    const logo = `${stamp}-logo.webp`;
    for (const f of [logo]) { writeFileSync(join(MEDIA_DIR, f), Buffer.from("RIFF")); created.push(join(MEDIA_DIR, f)); }
    const prevLogo = (await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id=$1 AND key='logo'`, [configId])).rows[0]?.value;
    await seedQ(`INSERT INTO node_attributes (workspace_id,node_id,key,value,source) VALUES ($1,$2,'logo',$3,'explicit')
             ON CONFLICT (node_id,key) DO UPDATE SET value=EXCLUDED.value`, [ws, configId, `/api/media/${logo}`]);
    try {
      currentActor = null;
      // Settings are frozen into the snapshot: the logo is public once a
      // publish carries it.
      await publish();
      expect((await get(logo)).status).toBe(200);
    } finally {
      if (prevLogo === undefined) await seedQ(`DELETE FROM node_attributes WHERE node_id=$1 AND key='logo'`, [configId]);
      else await seedQ(`UPDATE node_attributes SET value=$2 WHERE node_id=$1 AND key='logo'`, [configId, prevLogo]);
    }
  });

  it("(e) an unattached asset is NOT anonymously readable, but an authed actor (the uploader) CAN fetch it", async () => {
    // Closes the capability-URL leak: a fresh upload's opaque URL, if copied or
    // logged before it's embedded, must not be readable by an anonymous caller.
    currentActor = null;
    expect((await get(orphanFile)).status).toBe(404);
    // The uploader (any authenticated actor) can still fetch it, so upload →
    // preview → embed keeps working. Favicons/og-images are attached via the
    // site-config node, so they go through the per-node gate, not this branch.
    currentActor = admin;
    expect((await get(orphanFile)).status).toBe(200);
  });

  it("(e2) gated media is private and revalidated; anonymous-readable media is public for minutes, then revalidated (GAP-232)", async () => {
    currentActor = admin;
    const gated = await get(restrictedFile);
    expect(gated.headers.get("cache-control")).toBe("private, no-cache");
    const etag = gated.headers.get("etag");
    expect(etag).toBeTruthy();

    // Revalidation runs the read gate before answering 304.
    const again = await app.request(`/api/media/${restrictedFile}`, { headers: { "If-None-Match": etag! } });
    expect(again.status).toBe(304);
    currentActor = viewer;
    const denied = await app.request(`/api/media/${restrictedFile}`, { headers: { "If-None-Match": etag! } });
    expect(denied.status).toBe(404);

    const ws = await getWorkspaceId();
    const filename = `${stamp}-cache-published.webp`;
    writeFileSync(join(MEDIA_DIR, filename), Buffer.from("RIFF")); created.push(join(MEDIA_DIR, filename));
    const node = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$2,$3) RETURNING id`,
      [ws, `cache-published-${stamp}`, `![](/api/media/${filename})`])).rows[0]!;
    await publishIn(node.id);
    await seedQ(`INSERT INTO node_attributes (workspace_id,node_id,key,value,value_type,source) VALUES ($1,$2,'_published','true','bool','explicit')`, [ws, node.id]);
    await publish();
    currentActor = null;
    const open = await get(filename);
    expect(open.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");
    const publicEtag = open.headers.get("etag")!;
    expect(publicEtag).toBeTruthy();
    // Unchanged and still public: revalidation answers 304, without the bytes.
    const fresh = await app.request(`/api/media/${filename}`, { headers: { "If-None-Match": publicEtag } });
    expect(fresh.status).toBe(304);
    expect(fresh.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");
    // Taken down: the next revalidation is refused, so a cache drops it
    // within max-age instead of keeping it for a year (「不發布」: the space alone would keep it on).
    await seedQ(`UPDATE node_attributes SET value='false' WHERE node_id = $1 AND key = '_published'`, [node.id]);
    expect((await app.request(`/api/media/${filename}`, { headers: { "If-None-Match": publicEtag } })).status).toBe(404);
  });

  it("(h) a signed-in member outside the note's space sees what a logged-out visitor sees on the site (D107)", async () => {
    const ws = await getWorkspaceId();
    // A space that publishes, which the viewer is not in.
    const team = await makeSpace(ws, `ma-team-${stamp}`, [{ id: admin.id, role: "manager" }], { publish: true, external_ai: true, backup: true });
    const embedded = `${stamp}-team-embedded.webp`, uploaded = `${stamp}-team-uploaded.webp`;
    for (const f of [embedded, uploaded]) { writeFileSync(join(MEDIA_DIR, f), Buffer.from("RIFF")); created.push(join(MEDIA_DIR, f)); }
    const node = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$2,$3) RETURNING id`,
      [ws, `team-pub-${stamp}`, `![](/api/media/${embedded})\n![](/api/media/${uploaded})`])).rows[0]!;
    await putInSpace(node.id, team);
    // One file by the oldest-reference rule, one by an upload record the note claimed.
    await q(`INSERT INTO media_uploads (filename, workspace_id, uploader_actor_id, node_id) VALUES ($1,$2,$3,$4)`,
      [uploaded, ws, admin.id, node.id]);
    const status = async (as: ActorCtx | null) => {
      currentActor = as;
      return [(await get(embedded)).status, (await get(uploaded)).status];
    };
    // Not on the site yet: only the space's member reads them.
    expect(await status(null)).toEqual([404, 404]);
    expect(await status(viewer)).toEqual([404, 404]);
    expect(await status(admin)).toEqual([200, 200]);
    await seedQ(`INSERT INTO node_attributes (workspace_id,node_id,key,value,value_type,source) VALUES ($1,$2,'_published','true','bool','explicit')`, [ws, node.id]);
    await publish();
    expect(await status(null)).toEqual([200, 200]);
    expect(await status(viewer)).toEqual([200, 200]);
    // A takedown withdraws it from both again.
    await seedQ(`UPDATE node_attributes SET value='false' WHERE node_id=$1 AND key='_published'`, [node.id]);
    expect(await status(null)).toEqual([404, 404]);
    expect(await status(viewer)).toEqual([404, 404]);
  });

  it("(f) a missing file still 404s (existence check precedes the gate)", async () => {
    currentActor = admin;
    expect((await get(`${stamp}-does-not-exist.webp`)).status).toBe(404);
  });

  it("an attribute-only image follows its owning node's read policy", async () => {
    const ws = await getWorkspaceId(), filename = `${stamp}-attribute.webp`;
    const diskPath = join(MEDIA_DIR, filename);
    writeFileSync(diskPath, Buffer.from("RIFF"));
    created.push(diskPath);
    const node = (await seedQ<{ id: string }>("INSERT INTO content_nodes(workspace_id,source_type,node_type,title,slug,markdown) VALUES($1,'manual','content',$2,$2,'') RETURNING id", [ws, `cover-${stamp}`])).rows[0]!;
    await restrict(node.id);
    await seedQ("INSERT INTO node_attributes(workspace_id,node_id,key,value,source) VALUES($1,$2,'cover',$3,'explicit')", [ws, node.id, `/api/media/${filename}`]);
    for (const as of [null, viewer, admin]) {
      currentActor = as;
      expect((await get(filename)).status).toBe(as === admin ? 200 : 404);
    }
  });
});
