// Audit D56: one rule decides who owns an uploaded file — the first note saved
// with a reference to it, wherever the reference is (services/mediaOwners.ts).
// Before, only a title or body claimed: a cover uploaded into a media field of
// a note in a private space stayed unclaimed, so the next body save that
// pasted its URL — in a shared space — claimed it for that space; and an
// attribute-only file went to the OLDEST note referencing it, so adding the URL
// to an older note of one's own handed that note the file.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { apiOnError } from "../httpError.js";
import { getWorkspaceId, pool, q, withTransaction } from "../db.js";
import nodeRouter from "../routes/nodes.js";
import { canReadMedia } from "../services/mediaAccess.js";
import { anonymousMediaOwners } from "../services/mediaOwners.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";
import { ensureConfigNode, setSiteConfig, setChrome } from "./helpers/siteConfigFixture.js";

registerShippedModules();

function appFor(actor: ActorCtx) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/nodes", nodeRouter);
  return app;
}
const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe.skipIf(!isTestDatabase())("D56: every reference claims an upload, first one wins", () => {
  let ws = "";
  let defaultSpace = "";
  let privateSpace = "";
  const stamp = Date.now();
  // Alice and Bob share a private space; Carol is only in the default one.
  const alice: ActorCtx = { id: "", name: "Alice", role: "editor", type: "human" };
  const bob: ActorCtx = { id: "", name: "Bob", role: "editor", type: "human" };
  const carol: ActorCtx = { id: "", name: "Carol", role: "editor", type: "human" };

  const uploaded = async (by: ActorCtx, name: string) => {
    const file = `${stamp}${name}.webp`;
    await q(`INSERT INTO media_uploads (filename, workspace_id, uploader_actor_id) VALUES ($1, $2, $3)`, [file, ws, by.id]);
    return file;
  };
  const owner = async (file: string) =>
    (await q<{ node_id: string | null }>(`SELECT node_id::text FROM media_uploads WHERE filename = $1`, [file])).rows[0]?.node_id ?? null;
  const create = async (by: ActorCtx, title: string, body: Record<string, unknown> = {}) => {
    const res = await appFor(by).request("/api/nodes", json("POST", { title: `MOC ${title} ${stamp}`, markdown: "", ...body }));
    expect(res.status).toBe(201);
    return (await res.json() as { id: string }).id;
  };
  const setAttribute = async (by: ActorCtx, nodeId: string, key: string, value: string) =>
    expect((await appFor(by).request(`/api/nodes/${nodeId}/attributes/${key}`, json("PUT", { value }))).status).toBe(200);

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test', 'default') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`);
    ws = await getWorkspaceId();
    for (const a of [alice, bob, carol]) Object.assign(a, await persistActor(ws, a));
    defaultSpace = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [ws])).rows[0]!.id;
    privateSpace = await makeSpace(ws, `moc-private-${stamp}`, [{ id: alice.id, role: "editor" }, { id: bob.id, role: "editor" }]);
  });

  afterAll(async () => {
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1 AND title LIKE $2`, [ws, `MOC %${stamp}%`]);
    await pool.end();
  });

  it("a cover uploaded into a private note's media field stays private when a reader pastes it into a shared note", async () => {
    const file = await uploaded(alice, "-cover");
    const cover = await create(alice, "private cover", { space_id: privateSpace });
    await setAttribute(alice, cover, "cover", `/api/media/${file}`);
    expect(await owner(file)).toBe(cover);

    // Bob can read the cover note, so he has seen the URL; he pastes it into a
    // note in the space everyone shares.
    const shared = await create(bob, "shared paste", { space_id: defaultSpace, markdown: `![](/api/media/${file})` });
    expect((await appFor(bob).request(`/api/nodes/${shared}`, json("PATCH", { markdown: `again ![](/api/media/${file})` }))).status).toBe(200);

    expect(await owner(file)).toBe(cover);
    expect(await anonymousMediaOwners(ws, file)).toEqual([cover]);
    expect(await canReadMedia(carol, file, ws)).toBe(false);
    expect(await canReadMedia(null, file, ws)).toBe(false);
    expect(await canReadMedia(bob, file, ws)).toBe(true);
    expect(await canReadMedia(alice, file, ws)).toBe(true);
  });

  it("an attribute-first file is its note's; adding the URL to an attribute of an older note changes nothing", async () => {
    // Carol's note is the older one, in the space everyone shares.
    const older = await create(carol, "older", { space_id: defaultSpace });
    await seedQ(`UPDATE content_nodes SET created_at = now() - interval '1 day' WHERE id = $1`, [older]);
    const file = await uploaded(alice, "-field");
    const field = await create(alice, "field", { space_id: privateSpace });
    await setAttribute(alice, field, "photo", `/api/media/${file}`);
    expect(await owner(file)).toBe(field);

    await setAttribute(carol, older, "photo", `/api/media/${file}`);
    expect(await owner(file)).toBe(field);
    expect(await canReadMedia(carol, file, ws)).toBe(false);
  });

  it("a note created with a media attribute owns the file", async () => {
    const file = await uploaded(alice, "-created");
    const note = await create(alice, "created with", { space_id: privateSpace, attributes: [{ key: "pdf_url", value: `/api/media/${file}` }] });
    expect(await owner(file)).toBe(note);
    expect(await canReadMedia(carol, file, ws)).toBe(false);
  });

  it("a page design (presentation) claims its upload", async () => {
    const file = await uploaded(alice, "-design");
    const page = await create(alice, "design", { space_id: privateSpace });
    const presentation = { blocks: [{ type: "hero", props: { image: `/api/media/${file}`, caption: "x\n/api/media/never-uploaded.webp" } }] };
    expect((await appFor(alice).request(`/api/nodes/${page}`, json("PATCH", { presentation }))).status).toBe(200);
    expect(await owner(file)).toBe(page);

    await create(carol, "design paste", { space_id: defaultSpace, markdown: `![](/api/media/${file})` });
    expect(await owner(file)).toBe(page);
    expect(await canReadMedia(carol, file, ws)).toBe(false);
  });

  it("the site's logo and chrome uploads belong to the config note", async () => {
    // A workspace of its own: whether Carol reads the logo depends on whether
    // the workspace's site is published, and the shared default workspace may
    // hold another test's live site.
    const site = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('MOC site', $1) RETURNING id::text`, [`moc-${randomUUID()}`])).rows[0]!.id;
    const siteAlice = await persistActor(site, { id: "", name: "Alice", role: "editor", type: "human" });
    const siteCarol = await persistActor(site, { id: "", name: "Carol", role: "editor", type: "human" });
    const upload = async (name: string) => {
      const file = `${stamp}${name}.webp`;
      await q(`INSERT INTO media_uploads (filename, workspace_id, uploader_actor_id) VALUES ($1, $2, $3)`, [file, site, siteAlice.id]);
      return file;
    };
    const configId = await ensureConfigNode(site);
    const logo = await upload("-logo");
    const hero = await upload("-hero");
    await setSiteConfig(site, { logo: `/api/media/${logo}` });
    await setChrome(site, { header: [{ type: "hero", props: { image: `/api/media/${hero}` } }] });
    expect(await owner(logo)).toBe(configId);
    expect(await owner(hero)).toBe(configId);
    // The uploader still previews them (the config note itself is no member's note).
    expect(await canReadMedia(siteAlice, logo, site)).toBe(true);
    expect(await canReadMedia(siteCarol, logo, site)).toBe(false);
  });

  it("an unclaimed upload is its uploader's alone, whatever notes reference it", async () => {
    // Written past every claiming path (as a note whose owner was deleted for
    // good leaves it): the oldest reference no longer decides for an upload.
    const file = await uploaded(alice, "-unclaimed");
    await seedQ(`INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id, created_at)
             VALUES ($1, 'manual', 'content', $2, $2, $3, $4, now() - interval '2 days')`,
      [ws, `MOC raw ${stamp}`, `![](/api/media/${file})`, defaultSpace]);
    expect(await owner(file)).toBeNull();
    // The site rule (publish preview, pages push) agrees: no note decides.
    expect(await anonymousMediaOwners(ws, file)).toEqual([]);
    expect(await canReadMedia(carol, file, ws)).toBe(false);
    expect(await canReadMedia(null, file, ws)).toBe(false);
    expect(await canReadMedia(alice, file, ws)).toBe(true);
  });

  it("migration 107 claims an unclaimed upload for the note that decided for it (oldest reference), and only unclaimed ones", async () => {
    const migration = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../db/migrations/107_media_owner_attributes.sql"), "utf8");
    const raw = async (title: string, age: string, markdown = "") => (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id, created_at)
       VALUES ($1, 'manual', 'content', $2, $2, $3, $4, now() - $5::interval) RETURNING id::text`,
      [ws, `MOC ${title} ${stamp}`, markdown, privateSpace, age])).rows[0]!.id;
    const viaAttribute = await uploaded(alice, "-m107-attr");
    const viaPresentation = await uploaded(alice, "-m107-pres");
    const alreadyClaimed = await uploaded(alice, "-m107-claimed");
    const nowhere = await uploaded(alice, "-m107-nowhere");

    const oldest = await raw("m107 oldest", "3 days");
    const newer = await raw("m107 newer", "1 day", `![](/api/media/${viaAttribute})`);
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, source) VALUES ($1, $2, 'cover', $3, 'explicit')`,
      [ws, oldest, `/API/MEDIA/${viaAttribute.toUpperCase()}`]);
    const designed = await raw("m107 design", "2 days");
    await seedQ(`UPDATE content_nodes SET presentation = $2 WHERE id = $1`, [designed, JSON.stringify({ image: `/api/media/${viaPresentation}` })]);
    await seedQ(`UPDATE content_nodes SET markdown = $2 WHERE id = $1`, [oldest, `![](/api/media/${alreadyClaimed})`]);
    await q(`UPDATE media_uploads SET node_id = $2 WHERE filename = $1`, [alreadyClaimed, newer]);

    // The migration is a workspace-wide UPDATE: on the shared test database it
    // would scan (and claim) every other test's uploads too, and slow down as
    // the database grows. (CREATE TABLE AS takes no bind parameters; the
    // filenames and ids are this test's own.) Run its exact SQL against temporary copies of this
    // test's rows instead — a temp table shadows the public one of the same
    // name for unqualified references — and roll them away afterwards.
    const files = [viaAttribute, viaPresentation, alreadyClaimed, nowhere];
    const nodes = [oldest, newer, designed];
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TEMP TABLE media_uploads ON COMMIT DROP AS
        SELECT * FROM public.media_uploads WHERE filename = ANY('{${files.join(",")}}'::text[])`);
      await client.query(`CREATE TEMP TABLE content_nodes ON COMMIT DROP AS
        SELECT * FROM public.content_nodes WHERE id = ANY('{${nodes.join(",")}}'::uuid[])`);
      await client.query(`CREATE TEMP TABLE node_attributes ON COMMIT DROP AS
        SELECT * FROM public.node_attributes WHERE node_id = ANY('{${nodes.join(",")}}'::uuid[])`);
      await client.query(migration);
      await client.query(migration); // idempotent
      const tempOwner = async (file: string) => (await client.query<{ node_id: string | null }>(
        `SELECT node_id::text FROM pg_temp.media_uploads WHERE filename = $1`, [file])).rows[0]?.node_id ?? null;
      expect(await tempOwner(viaAttribute)).toBe(oldest);
      expect(await tempOwner(viaPresentation)).toBe(designed);
      expect(await tempOwner(alreadyClaimed)).toBe(newer);
      expect(await tempOwner(nowhere)).toBeNull();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
