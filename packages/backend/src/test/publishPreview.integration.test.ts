import { persistActor } from "./helpers/persistActor.js";
// W38b publish preview + hash confirmation against a real Postgres.
//   - The preview is the candidate a publish would store (same builder): what
//     is added / removed / changed against the live site, links that will read
//     "(private)", media readers won't get, and a hash.
//   - Publish with that hash stores exactly the previewed candidate; once the
//     candidate changes, the same hash answers 409 preview_stale and nothing
//     is stored.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { mkdir, rm, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { apiOnError } from "../httpError.js";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import publishRouter from "../modules/website/routes.js";
import { STATIC_VIDEO_MAX_BYTES } from "../modules/website/publishing/videoLimit.js";
import { MEDIA_DIR } from "../services/mediaStore.js";
import type { ActorCtx } from "../types.js";
import type { PublishPreview } from "@onden/contract";
import { buildCandidate, candidateHash } from "../modules/website/publishing/snapshot.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";
import { setSiteConfig } from "./helpers/siteConfigFixture.js";
import { publishDefaultSpace } from "./helpers/spaceFixtures.js";

registerShippedModules();

// The site is a workspace singleton, so every test publishes into a workspace
// of its own: the routes' getWorkspaceId() answers that workspace, and what
// other files (or earlier tests) published elsewhere is never in the diff.
let WS = "";
vi.mock("../db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db.js")>()),
  getWorkspaceId: async () => WS,
}));

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api", publishRouter);

const admin: ActorCtx = { id: "admin-w38b", name: "Admin", role: "admin", type: "human" };
const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const preview = async (body: unknown = { title: "Site" }) => {
  const res = await post("/api/publish/preview", body);
  expect(res.status).toBe(200);
  return await res.json() as PublishPreview;
};
const snapshotCount = async () =>
  Number((await q<{ n: string }>(`SELECT count(*)::text AS n FROM publish_snapshots WHERE workspace_id = $1`, [WS])).rows[0]!.n);

// Per test (beforeEach): a fresh stamp names its workspace, slugs and files.
let stamp = "";
let privateFile = "", missingFile = "", ownFile = "", logoFile = "";

async function note(title: string, markdown: string, published: boolean): Promise<string> {
  const id = (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1,'manual','content',$2,$3,$4) RETURNING id`,
    [WS, title, `${title.toLowerCase().replace(/\s+/g, "-")}-${stamp}`, markdown],
  )).rows[0]!.id;
  // The default space publishes; an unpublished note is one kept off (「不發布」).
  await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type) VALUES ($2, $1, '_published', $3, 'bool')`,
    [id, WS, published ? "true" : "false"]);
  return id;
}

describe.skipIf(!isTestDb)("publish preview + hash confirmation (DB)", () => {
  let home = "", secret = "", other = "";
  beforeEach(async () => {
    stamp = randomUUID().replace(/-/g, "").slice(0, 12);
    privateFile = `w38b${stamp}aaaaaaaaaaaaaaaaaaaaaaaaaa.png`;
    missingFile = `w38b${stamp}bbbbbbbbbbbbbbbbbbbbbbbbbb.png`;
    ownFile = `w38b${stamp}cccccccccccccccccccccccccc.png`;
    logoFile = `w38b${stamp}dddddddddddddddddddddddddd.png`;
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('W38b', $1) RETURNING id::text`, [`w38b-${stamp}`])).rows[0]!.id;
    await publishDefaultSpace(WS);
    Object.assign(admin, await persistActor(WS, { ...admin, id: "admin-w38b" }));
    secret = await note("Secret plans", "not for the site", false);
    other = await note("Other page", "second page", true);
    home = await note("Home", [
      "Welcome. See [[Secret plans]] and [[Secret plans|our roadmap]] and [[Other page]].",
      `![a](/api/media/${privateFile}) ![b](/api/media/${missingFile}) ![c](/api/media/${ownFile})`,
    ].join("\n"), true);
    // The image belongs to the private note: readers of the site can't open it.
    await mkdir(MEDIA_DIR, { recursive: true });
    await writeFile(join(MEDIA_DIR, privateFile), "png");
    await q(`INSERT INTO media_uploads (filename, workspace_id, uploader_actor_id, node_id) VALUES ($1, $2, $3, $4)`,
      [privateFile, WS, admin.id, secret]);
    // An image owned by the home page itself: not public yet (nothing is
    // published), but public after this publish — so not blocked.
    await writeFile(join(MEDIA_DIR, ownFile), "png");
    await q(`INSERT INTO media_uploads (filename, workspace_id, uploader_actor_id, node_id) VALUES ($1, $2, $3, $4)`,
      [ownFile, WS, admin.id, home]);
    currentActor = admin;
  });
  afterEach(async () => {
    await rm(join(MEDIA_DIR, privateFile), { force: true });
    await rm(join(MEDIA_DIR, ownFile), { force: true });
    await rm(join(MEDIA_DIR, logoFile), { force: true });
  });

  it("before any publish: every published note is new, with private links and blocked media listed", async () => {
    const p = await preview();
    expect(p.live).toBeNull();
    expect(p.diff.added.map((n) => n.id).sort()).toEqual([home, other].sort());
    expect(p.diff.removed).toEqual([]);
    expect(p.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.private_links).toEqual([
      { node_id: home, node_title: "Home", target: "Secret plans", shown_as: "(private)" },
      { node_id: home, node_title: "Home", target: "Secret plans", shown_as: "our roadmap" },
    ]);
    expect(p.blocked_media).toEqual(expect.arrayContaining([
      { filename: privateFile, reason: "not_public", node_ids: [home] },
      { filename: missingFile, reason: "missing", node_ids: [home] },
    ]));
    expect(p.blocked_media.map((m) => m.filename)).not.toContain(ownFile);
    // The candidate is what readers would get: redacted, the private note absent.
    const nodes = p.site.payload.nodes as Array<{ id: string; markdown: string }>;
    expect(nodes.map((n) => n.id)).not.toContain(secret);
    expect(nodes.find((n) => n.id === home)!.markdown).not.toContain("Secret plans");
    expect(await snapshotCount()).toBe(0); // the preview stores nothing
  });

  it("the same content previews to the same hash; publishing with it stores that candidate", async () => {
    const p = await preview();
    expect((await preview()).hash).toBe(p.hash);
    const res = await post("/api/publish", { title: "Site", preview_hash: p.hash });
    expect(res.status).toBe(201);
    const stored = await q<{ payload: { nodes: Array<{ id: string; markdown: string }> } }>(
      `SELECT payload FROM publish_snapshots WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`, [WS]);
    expect(stored.rows[0]!.payload.nodes).toEqual(p.site.payload.nodes);
  });

  it("after a publish: a change shows in the diff, and the old hash is refused with 409", async () => {
    expect((await post("/api/publish", { title: "Site", preview_hash: (await preview()).hash })).status).toBe(201);
    const before = await preview();
    expect(before.live).not.toBeNull();
    expect(before.diff).toEqual({ added: [], removed: [], returning: [], changed: [], moved: [], links_changed: [], settings_changed: false });

    await seedQ(`UPDATE content_nodes SET markdown = 'second page, edited' WHERE id = $1`, [other]);
    await seedQ(`UPDATE node_attributes SET value = 'false' WHERE node_id = $1 AND key = '_published'`, [home]);
    const after = await preview();
    expect(after.hash).not.toBe(before.hash);
    expect(after.diff.changed.map((n) => n.id)).toEqual([other]);
    // Unpublishing took it off the site at once; this publish makes it final.
    expect(after.diff.removed).toEqual([expect.objectContaining({ id: home, taken_down: true })]);

    const count = await snapshotCount();
    const stale = await post("/api/publish", { title: "Site", preview_hash: before.hash });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "preview_stale" });
    expect(await snapshotCount()).toBe(count);

    expect((await post("/api/publish", { title: "Site", preview_hash: after.hash })).status).toBe(201);
  });

  it("a different title is a different candidate (settings_changed, new hash)", async () => {
    expect((await post("/api/publish", { title: "Site", preview_hash: (await preview()).hash })).status).toBe(201);
    const same = await preview({ title: "Site" });
    const renamed = await preview({ title: "Renamed" });
    expect(renamed.hash).not.toBe(same.hash);
    expect(renamed.diff.settings_changed).toBe(true);
  });

  it("building the candidate twice gives the same hash, even when rows tie on created_at", async () => {
    // Ties everywhere the candidate is ordered: notes, edges, tag rows.
    const tie = "2026-01-01T00:00:00Z";
    const a = await note("Tie A", "a", true);
    const b = await note("Tie B", "b", true);
    await seedQ(`UPDATE content_nodes SET created_at = $2 WHERE id = ANY($1::uuid[])`, [[a, b, other], tie]);
    await seedQ(`INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status, created_at)
             VALUES ($1, $2, $3, 'link', 'active', $5), ($1, $3, $4, 'link', 'active', $5)`, [WS, a, b, other, tie]);
    const first = candidateHash(await buildCandidate(WS, { title: "Site" }));
    // Rewrite the earlier rows (no visible change): a scan now meets them in another order.
    await seedQ(`UPDATE content_nodes SET title = title WHERE id = $1`, [a]);
    await seedQ(`UPDATE node_edges SET status = status WHERE source_node_id = $1`, [a]);
    expect(candidateHash(await buildCandidate(WS, { title: "Site" }))).toBe(first);
    expect((await preview()).hash).toBe(first);
  });

  it("a changed site setting counts as a settings change", async () => {
    const published = await preview();
    expect((await post("/api/publish", { title: "Site", preview_hash: published.hash })).status).toBe(201);
    await setSiteConfig(WS, { tagline: `changed ${stamp}` });
    const after = await preview();
    expect(after.diff.settings_changed).toBe(true);
  });

  it("a logo set after the last publish is not flagged: this publish freezes it into the site", async () => {
    expect((await post("/api/publish", { title: "Site", preview_hash: (await preview()).hash })).status).toBe(201);
    await writeFile(join(MEDIA_DIR, logoFile), "png");
    await setSiteConfig(WS, { logo: `/api/media/${logoFile}` });
    const p = await preview();
    expect(JSON.stringify(p.site.payload.presentation)).toContain(logoFile);
    expect(p.blocked_media.map((m) => m.filename)).not.toContain(logoFile);
    // …and it is listed as newly public, as the logo; the home page's own
    // image was public already and is not listed again.
    expect(p.new_media).toEqual([{ filename: logoFile, used_as: "logo", node_ids: [] }]);
  });

  it("a first publish lists the images it makes public; a site icon is told apart from a logo", async () => {
    await writeFile(join(MEDIA_DIR, logoFile), "png");
    await setSiteConfig(WS, { favicon: `/api/media/${logoFile}` });
    const p = await preview();
    expect(p.new_media).toEqual(expect.arrayContaining([
      { filename: ownFile, used_as: "other", node_ids: [home] },
      { filename: logoFile, used_as: "favicon", node_ids: [] },
    ]));
    expect(p.new_media.map((m) => m.filename)).not.toContain(privateFile);
  });

  it("names a video too large for the static copy (large_videos), and only that one", async () => {
    const big = `w38b${stamp}eeeeeeeeeeeeeeeeeeeeeeeeee.mp4`;
    const small = `w38b${stamp}ffffffffffffffffffffffffff.mp4`;
    try {
      await writeFile(join(MEDIA_DIR, big), "v");
      await truncate(join(MEDIA_DIR, big), STATIC_VIDEO_MAX_BYTES + 1); // sparse: no real 100 MB written
      await writeFile(join(MEDIA_DIR, small), "v");
      for (const f of [big, small]) {
        await q(`INSERT INTO media_uploads (filename, workspace_id, uploader_actor_id, node_id) VALUES ($1, $2, $3, $4)`, [f, WS, admin.id, home]);
      }
      await seedQ(`UPDATE content_nodes SET markdown = markdown || $2 WHERE id = $1`, [home, `\n![big](/api/media/${big}) ![small](/api/media/${small})`]);
      const p = await preview();
      expect(p.large_videos).toEqual([{ filename: big, size_mb: Math.ceil((STATIC_VIDEO_MAX_BYTES + 1) / (1024 * 1024)), node_ids: [home] }]);
    } finally {
      await rm(join(MEDIA_DIR, big), { force: true });
      await rm(join(MEDIA_DIR, small), { force: true });
    }
  });

  it("only the workspace owner may preview", async () => {
    currentActor = await persistActor(WS, { id: "member-w38b", name: "Editor", role: "editor", type: "human" }) as ActorCtx;
    expect((await post("/api/publish/preview", { title: "Site" })).status).toBe(403);
    currentActor = admin;
  });

  // D80: the preview lists what readers will see change, and the hash covers
  // exactly that — no more (a bumped updated_at) and no less (order, links).
  it("reordering two published siblings is listed as moved", async () => {
    const parent = await note("Shelf", "a shelf", true);
    const first = await note("Shelf first", "1", true);
    const second = await note("Shelf second", "2", true);
    await seedQ(`UPDATE content_nodes SET parent_id = $1, sort_order = CASE id WHEN $2 THEN 0 ELSE 1 END WHERE id = ANY($3::uuid[])`,
      [parent, first, [first, second]]);
    expect((await post("/api/publish", { title: "Site", preview_hash: (await preview()).hash })).status).toBe(201);
    const before = await preview();
    expect(before.diff.moved).toEqual([]);

    await seedQ(`UPDATE content_nodes SET sort_order = 2 WHERE id = $1`, [first]);
    const after = await preview();
    expect(after.hash).not.toBe(before.hash);
    expect(after.diff.moved.map((n) => n.id)).toHaveLength(1);
    expect([first, second]).toContain(after.diff.moved[0]!.id);
    expect(after.diff.changed).toEqual([]);
    // Renumbering that keeps the order is no change at all.
    await seedQ(`UPDATE content_nodes SET sort_order = sort_order + 10 WHERE id = ANY($1::uuid[])`, [[first, second]]);
    expect((await preview()).hash).toBe(after.hash);
  });

  it("a new link between two published notes is listed as links changed", async () => {
    const a = await note("Linked A", "a", true);
    const b = await note("Linked B", "b", true);
    expect((await post("/api/publish", { title: "Site", preview_hash: (await preview()).hash })).status).toBe(201);
    const before = await preview();
    await seedQ(`INSERT INTO node_edges (workspace_id, source_node_id, target_node_id, edge_type, status)
             VALUES ($1, $2, $3, 'knowledge_link', 'active')`, [WS, a, b]);
    const after = await preview();
    expect(after.hash).not.toBe(before.hash);
    expect(after.diff.links_changed.map((n) => n.id).sort()).toEqual([a, b].sort());
    expect(after.diff.changed).toEqual([]);
    expect((await post("/api/publish", { title: "Site", preview_hash: before.hash })).status).toBe(409);
  });

  it("an updated_at-only bump is no change and doesn't stale the preview", async () => {
    expect((await post("/api/publish", { title: "Site", preview_hash: (await preview()).hash })).status).toBe(201);
    const before = await preview();
    await seedQ(`UPDATE content_nodes SET updated_at = now() + interval '1 hour' WHERE id = $1`, [other]);
    const after = await preview();
    expect(after.hash).toBe(before.hash);
    expect(after.diff).toEqual({ added: [], removed: [], returning: [], changed: [], moved: [], links_changed: [], settings_changed: false });
    expect((await post("/api/publish", { title: "Site", preview_hash: before.hash })).status).toBe(201);
  });

  it("the candidate carries each note's sibling order (D64)", async () => {
    await seedQ(`UPDATE content_nodes SET sort_order = 4 WHERE id = $1`, [other]);
    const nodes = (await buildCandidate(WS, { title: "Site" })).payload.nodes as Array<{ id: string; sort_order: number; created_at: unknown }>;
    const row = nodes.find((n) => n.id === other)!;
    expect(row.sort_order).toBe(4);
    expect(row.created_at).toBeTruthy();
  });
});
