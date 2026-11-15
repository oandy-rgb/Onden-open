// GET /api/site carries an ETag of the served content and answers 304 to the
// same If-None-Match. The version is a hash of what is served, so every
// takedown (docs/architecture/site-render-model.md) changes it: a renderer that
// keeps a copy by ETag can never be told "unchanged" about a page that is gone.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { q } from "../db.js";
import { apiOnError } from "../httpError.js";
import nodesRouter from "../routes/nodes.js";
import publishRouter from "../modules/website/routes.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { makeSpace, putInSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";
import { publishWithPreview } from "./helpers/publishWithPreview.js";

const database = process.env.DATABASE_URL ?? "";
const isTestDb = /_test\b/.test(database);
let workspaceId = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => workspaceId }));
let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodesRouter);
app.route("/api", publishRouter);
registerShippedModules();
const send = (url: string, method: string, body: unknown = {}) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let owner: ActorCtx = { id: "etag-owner", name: "Owner", role: "admin", type: "human" };
let space = "";

/** An anonymous visitor's GET /api/site. */
async function visit(ifNoneMatch?: string): Promise<{ status: number; etag: string | null; slugs: string[] }> {
  const actor = currentActor;
  currentActor = null;
  try {
    const res = await app.request("/api/site", ifNoneMatch ? { headers: { "If-None-Match": ifNoneMatch } } : undefined);
    const body = res.status === 200 ? (await res.json()) as { payload: { nodes: Array<{ slug: string }> } } : null;
    return { status: res.status, etag: res.headers.get("ETag"), slugs: body?.payload.nodes.map((n) => n.slug).sort() ?? [] };
  } finally { currentActor = actor; }
}

async function note(title: string): Promise<{ id: string; slug: string }> {
  const slug = `${title.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const id = (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1,'manual','content',$2,$3,'body') RETURNING id::text`, [workspaceId, title, slug])).rows[0]!.id;
  await putInSpace(id, space);
  expect((await send(`/api/nodes/${id}/attributes/_published`, "PUT", { value: "true", value_type: "bool" })).status).toBe(200);
  return { id, slug };
}
const publish = async () => { expect((await publishWithPreview((p, b) => send(p, "POST", b))).status).toBe(201); };

describe.skipIf(!isTestDb)("GET /api/site ETag (DB)", () => {
  beforeAll(async () => {
    workspaceId = (await q<{ id: string }>(`INSERT INTO workspaces(name,slug) VALUES('Etag',$1) RETURNING id`, [randomUUID()])).rows[0]!.id;
    owner = await persistActor(workspaceId, owner);
    currentActor = owner;
    space = await makeSpace(workspaceId, `etag-${randomUUID()}`, [{ id: owner.id, role: "manager" }], { publish: true, external_ai: false, backup: true });
  });
  afterAll(async () => { await q(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]).catch(() => {}); });

  it("never-published workspace: same ETag on repeat, 304 on match", async () => {
    const a = await visit();
    expect(a.status).toBe(200);
    expect(a.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect((await visit()).etag).toBe(a.etag); // created_at is stamped per read; it must not move the version
    expect((await visit(a.etag!)).status).toBe(304);
    expect((await visit('"other"')).status).toBe(200);
    expect((await visit(`"other", ${a.etag}`)).status).toBe(304);
    expect((await visit(`W/${a.etag}`)).status).toBe(304);
    expect((await visit("*")).status).toBe(304);
  });

  it("a publish changes the ETag; the old one then gets the full site", async () => {
    const before = (await visit()).etag!;
    const kept = await note("Kept");
    await publish();
    const after = await visit(before);
    expect(after.status).toBe(200);
    expect(after.etag).not.toBe(before);
    expect(after.slugs).toContain(kept.slug);
    expect((await visit(after.etag!)).status).toBe(304);
  });

  /** Take `slug` off the site with `takedown` and show the version moved. */
  async function expectTakedown(name: string, takedown: (n: { id: string }) => Promise<void>) {
    const n = await note(name);
    await publish();
    const live = await visit();
    expect(live.slugs).toContain(n.slug);
    expect((await visit(live.etag!)).status).toBe(304);
    await takedown(n);
    const gone = await visit(live.etag!); // the renderer asks with the version it holds
    expect(gone.status).toBe(200);
    expect(gone.etag).not.toBe(live.etag);
    expect(gone.slugs).not.toContain(n.slug);
  }

  it("the publish switch turned off", () => expectTakedown("Off", async (n) => {
    expect((await send(`/api/nodes/${n.id}/attributes/_published`, "PUT", { value: "false", value_type: "bool" })).status).toBe(200);
  }));

  it("the note deleted", () => expectTakedown("Trashed", async (n) => {
    await seedQ(`UPDATE content_nodes SET deleted_at = now() WHERE id = $1`, [n.id]);
  }));

  it("the note hidden", () => expectTakedown("Hidden", async (n) => {
    await seedQ(`UPDATE content_nodes SET hidden = true WHERE id = $1`, [n.id]);
  }));

  it("moved to a space that cannot publish", () => expectTakedown("Moved", async (n) => {
    const closed = await makeSpace(workspaceId, `closed-${randomUUID()}`, [{ id: owner.id, role: "manager" }], { publish: false, external_ai: false, backup: true });
    await putInSpace(n.id, closed);
  }));

  it("its space stops publishing", async () => {
    const own = await makeSpace(workspaceId, `own-${randomUUID()}`, [{ id: owner.id, role: "manager" }], { publish: true, external_ai: false, backup: true });
    const was = space;
    space = own;
    try {
      await expectTakedown("Closed", async () => {
        await q(`UPDATE spaces SET capabilities = capabilities || '{"publish": false}'::jsonb WHERE id = $1`, [own]);
      });
    } finally { space = was; }
  });

  it("a tag hidden since (its chip leaves the page)", async () => {
    const tag = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','class_tag','Topic',$2,'') RETURNING id::text`, [workspaceId, `topic-${randomUUID().slice(0, 8)}`])).rows[0]!.id;
    const n = await note("Tagged");
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [n.id, tag]);
    await publish();
    const live = await visit();
    expect((await visit(live.etag!)).status).toBe(304);
    await seedQ(`UPDATE content_nodes SET hidden = true WHERE id = $1`, [tag]);
    const after = await visit(live.etag!);
    expect(after.status).toBe(200);
    expect(after.etag).not.toBe(live.etag);
  });

  it("a space member removed: the public site is unchanged, so the version is too", async () => {
    const extra = await persistActor(workspaceId, { id: "etag-extra", name: "Extra", role: "editor", type: "human" });
    await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2::uuid, 'edit')`, [space, extra.id]);
    const live = await visit();
    await q(`DELETE FROM space_members WHERE space_id = $1 AND actor_id = $2::uuid`, [space, extra.id]);
    expect((await visit(live.etag!)).status).toBe(304);
  });
});
