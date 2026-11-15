// Pre-invite fixes in core (docs/archive/research/integration-audit-2026-10-13.md §4,
// items 6, 9 and 10):
//   * an uploaded file belongs to the first note saved with it — pasting its
//     URL into another note grants nothing, through GET /api/media or the
//     markdown export;
//   * `_published:: true` in a note's text does not publish it;
//   * the Site Config note (with the owner's share and access tokens) is in a
//     space no member reads, and members get the settings without the secrets;
//   * two published notes sharing a slug (slugs are unique per space) get
//     distinct pages, the default space keeping the plain slug;
//   * a space move, or a publish / external_ai / backup switch, reaches the
//     modules' space-audience hook after it commits (the website republishes);
//   * publishing the site is the owner's: not another admin's, not an
//     admin-role token's. (Pruning the trash was too, until D95 removed the
//     workspace-wide prune route; the trash itself is gone since.)
//
// SAFETY: skips entirely unless DATABASE_URL points at a *_test database.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiOnError } from "../httpError.js";
import { pool, q } from "../db.js";
import nodeRouter from "../routes/nodes.js";
import mediaRouter from "../routes/media.js";
import { MEDIA_DIR } from "../services/mediaStore.js";
import exportRouter from "../routes/export.js";
import publishRouter from "../modules/website/routes.js";
import { canReadMedia } from "../services/mediaAccess.js";
import { publishedNodeIds, uniquePublishedSlugs } from "../modules/website/publishing/publishedSet.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import { isWorkspaceConfigNode } from "../spine/reservedNodes.js";
import { readFileSync } from "node:fs";
import { registerNodeHooks } from "../spine/nodeHooks.js";
import { moveToSpace, updateSpace } from "../services/spaces.js";
import { setWorkspaceOwner } from "./helpers/setOwner.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";
import { ensureConfigNode } from "./helpers/siteConfigFixture.js";
import { postVia, publishWithPreview } from "./helpers/publishWithPreview.js";

registerShippedModules();

const isTestDb = /_test\b/.test(process.env.DATABASE_URL ?? "");

// A workspace of the file's own: the publish test hands its ownership around,
// which on the shared 'default' workspace would leak into later files. The
// routes find it through getWorkspaceId.
let ws = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ws }));

function appFor(actor: ActorCtx | null) {
  const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
  app.onError(apiOnError);
  app.use("*", async (c, next) => { c.set("actor", actor); await next(); });
  app.route("/api/nodes", nodeRouter);
  app.route("/api/media", mediaRouter);
  app.route("/api/export", exportRouter);
  app.route("/api", publishRouter);
  return app;
}
const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe.skipIf(!isTestDb)("pre-invite fixes in core", () => {
  let defaultSpace = "";
  const stamp = Date.now();
  const alice: ActorCtx = { id: "", name: "Alice", role: "admin", type: "human" };
  const bob: ActorCtx = { id: "", name: "Bob", role: "editor", type: "human" };
  const file = `${stamp}-owned.webp`;

  beforeAll(async () => {
    ws = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('Pre-invite core', $1) RETURNING id::text`,
      [`pre-invite-${randomUUID()}`])).rows[0]!.id;
    Object.assign(bob, await persistActor(ws, bob));
    Object.assign(alice, await persistActor(ws, alice));
    defaultSpace = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [ws])).rows[0]!.id;
    mkdirSync(MEDIA_DIR, { recursive: true });
    writeFileSync(join(MEDIA_DIR, file), Buffer.from([0x52, 0x49, 0x46, 0x46]));
    await q(`INSERT INTO media_uploads (filename, workspace_id, uploader_actor_id) VALUES ($1, $2, $3)`, [file, ws, alice.id]);
  });

  afterAll(async () => {
    rmSync(join(MEDIA_DIR, file), { force: true });
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1 AND title LIKE $2`, [ws, `PIC %${stamp}%`]);
    await pool.end();
  });

  it("a file belongs to the first note saved with it; a URL pasted into an older note grants nothing", async () => {
    // Bob's note is older than Alice's.
    const older = await (await appFor(bob).request("/api/nodes", json("POST", { title: `PIC older ${stamp}`, markdown: "" }))).json() as { id: string };
    const shared = await (await appFor(alice).request("/api/nodes", json("POST", {
      title: `PIC shared ${stamp}`, markdown: `![](/api/media/${file})`, space_id: defaultSpace,
    }))).json() as { id: string };
    expect(await canReadMedia(bob, file, ws)).toBe(true); // Bob is in 共用

    // Alice moves the note to her personal space; Bob pastes the URL into his older note.
    const personal = (await q<{ id: string }>(`SELECT id::text FROM spaces WHERE owner_actor_id = $1::uuid AND kind = 'personal'`, [alice.id])).rows[0]!.id;
    await seedQ(`UPDATE content_nodes SET space_id = $2 WHERE id = $1`, [shared.id, personal]);
    expect((await appFor(bob).request(`/api/nodes/${older.id}`, json("PATCH", { markdown: `![](/api/media/${file})` }))).status).toBe(200);

    expect(await canReadMedia(bob, file, ws)).toBe(false);
    expect((await appFor(bob).request(`/api/media/${file}`)).status).toBe(404);
    expect(await canReadMedia(alice, file, ws)).toBe(true);
    // Nor does the export copy it into Bob's zip.
    const zip = Buffer.from(await (await appFor(bob).request("/api/export/markdown.zip")).arrayBuffer());
    expect(zip.includes(Buffer.from(`attachments/${file}`))).toBe(false);
    // Anonymous readers need the owning note on the public site.
    expect(await canReadMedia(null, file, ws)).toBe(false);
  });

  it("`_published:: true` in a note's text does not publish it", async () => {
    const note = await (await appFor(alice).request("/api/nodes", json("POST", {
      title: `PIC inline ${stamp}`, markdown: "_published:: true\n_status:: published", space_id: defaultSpace,
    }))).json() as { id: string };
    const keys = (await q<{ key: string }>(`SELECT key FROM node_attributes WHERE node_id = $1`, [note.id])).rows.map((r) => r.key);
    expect(keys).not.toContain("_published");
    expect(keys).not.toContain("_status");
    expect((await publishedNodeIds(ws)).has(note.id)).toBe(false);
  });

  it("the Site Config note is in a space nobody reads as a note", async () => {
    const configId = await ensureConfigNode(ws);
    const kind = (await q<{ kind: string }>(`SELECT s.kind FROM content_nodes n JOIN spaces s ON s.id = n.space_id WHERE n.id = $1`, [configId])).rows[0]?.kind;
    expect(kind).toBe("system");
    for (const actor of [bob, alice]) expect((await appFor(actor).request(`/api/nodes/${configId}`)).status).toBe(404);
  });

  it("a member's nested #foo/workspace-config is an ordinary tag: not reserved, not moved by migration 096", async () => {
    const { tagId: parent } = await seedClassTag(ws, { name: `pic-foo-${stamp}` });
    const nested = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id)
       VALUES ($1, 'manual', 'class_tag', 'workspace-config', $2, '', $3) RETURNING id::text`,
      [ws, `pic-nested-config-${stamp}`, parent])).rows[0]!.id;
    const note = await (await appFor(alice).request("/api/nodes", json("POST", {
      title: `PIC tagged ${stamp}`, markdown: "", space_id: defaultSpace,
    }))).json() as { id: string };
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [note.id, nested]);

    expect(await isWorkspaceConfigNode(nested)).toBe(false);
    expect(await isWorkspaceConfigNode(note.id)).toBe(false);
    // Re-run 096's move: the note stays in its space.
    const move = readFileSync(new URL("../../db/migrations/096_system_space.sql", import.meta.url), "utf8");
    await seedQ(move.slice(move.lastIndexOf("UPDATE content_nodes")));
    expect((await q<{ space_id: string }>(`SELECT space_id::text FROM content_nodes WHERE id = $1`, [note.id])).rows[0]!.space_id).toBe(defaultSpace);
    await seedQ(`DELETE FROM content_nodes WHERE id = $1`, [nested]);
  });

  it("two published notes sharing a slug get distinct pages; the default space keeps the plain one", async () => {
    const lab = await makeSpace(ws, `pic-lab-${stamp}`, [{ id: alice.id, role: "manager" }], { publish: true, external_ai: false, backup: true });
    const inDefault = (await seedQ<{ id: string }>(`INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id)
      VALUES ($1, 'manual', 'content', $2, $2, '', $3) RETURNING id::text`, [ws, `PIC page ${stamp}`, defaultSpace])).rows[0]!.id;
    const inLab = (await seedQ<{ id: string }>(`INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id)
      VALUES ($1, 'manual', 'content', $2, $2, '', $3) RETURNING id::text`, [ws, `PIC lab page ${stamp}`, lab])).rows[0]!.id;
    // As if both carried one slug (unique per space): the lab note listed first.
    const rows = [{ id: inLab, slug: "notes" }, { id: inDefault, slug: "notes" }];
    await uniquePublishedSlugs(rows);
    expect(rows).toEqual([{ id: inLab, slug: `notes-${inLab.slice(0, 6)}` }, { id: inDefault, slug: "notes" }]);
  });

  it("a space move and a publish, external_ai or backup switch reach the space-audience hook; a rename does not", async () => {
    const hook = vi.fn(async () => {});
    registerNodeHooks(`pic-audience-${stamp}`, { spaceAudienceCommitted: hook });
    const lab = await makeSpace(ws, `pic-audience-lab-${stamp}`, [{ id: alice.id, role: "manager" }],
      { publish: true, external_ai: false, backup: true });
    const note = await (await appFor(alice).request("/api/nodes", json("POST", {
      title: `PIC moved ${stamp}`, markdown: "", space_id: defaultSpace,
    }))).json() as { id: string };

    await moveToSpace(alice, ws, note.id, lab, null);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenLastCalledWith({ workspaceId: ws, actor: alice });

    await updateSpace(alice, ws, lab, { name: `pic-renamed-${stamp}` });
    await updateSpace(alice, ws, lab, { capabilities: { publish: true } }); // already on
    expect(hook).toHaveBeenCalledTimes(1);
    for (const capabilities of [{ publish: false }, { external_ai: true }, { backup: false }]) {
      await updateSpace(alice, ws, lab, { capabilities });
    }
    expect(hook).toHaveBeenCalledTimes(4);

    // A move refused before it commits reaches no one.
    await expect(moveToSpace(bob, ws, note.id, defaultSpace, null)).rejects.toThrow();
    expect(hook).toHaveBeenCalledTimes(4);
  });

  it("publishing the site is the owner's, not another admin's or a token's", async () => {
    const deputy = await persistActor(ws, { id: "", name: `PIC deputy ${stamp}`, role: "admin", type: "human" });
    await setWorkspaceOwner(ws, alice.id); // Alice stays the owner
    const adminToken = await persistActor(ws, {
      id: "", name: `PIC admin agent ${stamp}`, role: "admin", type: "agent",
      tokenScope: { tokenId: "", allowedTools: null, access: "write", writeMode: "apply", expiresAt: null },
    });
    for (const actor of [deputy, adminToken, bob]) {
      expect((await appFor(actor).request("/api/publish", json("POST", {}))).status).toBe(403);
    }
    expect((await publishWithPreview(postVia(appFor(alice)), { title: `PIC site ${stamp}` })).status).toBe(201);
  });
});
