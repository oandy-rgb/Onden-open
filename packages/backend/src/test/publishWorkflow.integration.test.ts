// A COHERENT real-world journey: "publish a digital garden / blog" — one of
// the canonical note-app uses (web surveys + the user's own four core uses).
// Walked end to end against the real publish path, asserting the D9 privacy
// contract at every beat:
//
//   1. write a public post that [[links]] to a private draft + the draft itself
//   2. nothing is public until opted in and published (GET /api/site is empty)
//   3. publish ONE note → only it goes public at Publish; the private draft stays hidden
//      AND the post's [[link]] to the private draft is redacted to "(private)"
//      (a private title can't leak through a published page)
//   4. publish the draft too → the link resolves at the next Publish
//   5. un-publish the post → it drops from the site on the NEXT read
//      (serve-time allowlist, not a stale snapshot)
//
// SAFETY: only runs against a *_test database (describe.skipIf).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { getWorkspaceId, pool, q } from "../db.js";
import { buildAndEnqueueSnapshot } from "../modules/website/publishing/snapshot.js";
import nodeRouter from "../routes/nodes.js";
import publishRouter from "../modules/website/routes.js";
import type { ActorCtx } from "../types.js";
import { joinDefaultSpace, publishDefaultSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
// Its own workspace: it empties it before and after, and the shared
// 'default' one holds other files' notes.
let ownWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => ownWorkspace }));
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodeRouter);
app.route("/api", publishRouter);

const J = { "content-type": "application/json" };
// The owner's Publish (POST /api/publish is the owner's; this author is an admin).
const publish = async () => { await buildAndEnqueueSnapshot(await getWorkspaceId(), { id: currentActor!.id, type: "human" }, { title: "Garden" }); };
// Spaces (docs/architecture/spaces.md): only notes in a space whose `publish`
// switch is on can go public — the default shared space (a top-level note
// would otherwise land in the author's personal space).
let defaultSpaceId = "";
const createNote = async (title: string, markdown = "") => {
  const res = await app.request("/api/nodes", { method: "POST", headers: J, body: JSON.stringify({ title, markdown, space_id: defaultSpaceId }) });
  expect(res.status, `create "${title}"`).toBe(201);
  return (await res.json()) as { id: string; slug: string; title: string };
};
const setPublished = (id: string, value: "true" | "false") =>
  app.request(`/api/nodes/${id}/attributes/_published`, {
    method: "PUT", headers: J, body: JSON.stringify({ value, value_type: "text", is_inheritable: false }),
  });
type SiteNode = { id: string; title: string; markdown: string };
const siteNodes = async (): Promise<SiteNode[]> => {
  const res = await app.request("/api/site");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { payload: { nodes: SiteNode[] } };
  return body.payload.nodes ?? [];
};

describe.skipIf(!isTestDb)("digital-garden publish journey (D9 privacy, end to end)", () => {
  let workspaceId: string;

  beforeAll(async () => {
    const ws = await q<{ id: string }>(
      `INSERT INTO workspaces (name, slug) VALUES ('Site test', $1) RETURNING id`, [randomUUID()],
    );
    workspaceId = ownWorkspace = ws.rows[0]!.id;
    await publishDefaultSpace(workspaceId);
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [workspaceId]);
    await q(`DELETE FROM publish_snapshots WHERE workspace_id = $1`, [workspaceId]);
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1`, [workspaceId]);
    const r = await q<{ id: string }>(
      `INSERT INTO actors (workspace_id, name, type) VALUES ($1, 'Author', 'human') RETURNING id`,
      [workspaceId],
    );
    currentActor = { id: r.rows[0]!.id, name: "Author", role: "admin", type: "human" };
    // membership is explicit since 097: the author writes 共用 (publish on)
    await joinDefaultSpace(workspaceId, r.rows[0]!.id, "admin");
    defaultSpaceId = (await q<{ id: string }>(
      `SELECT id::text FROM spaces WHERE workspace_id = $1 AND is_default`, [workspaceId])).rows[0]!.id;
  });

  afterAll(async () => {
    await q(`DELETE FROM outbox WHERE workspace_id = $1`, [workspaceId]);
    await q(`DELETE FROM publish_snapshots WHERE workspace_id = $1`, [workspaceId]);
    await seedQ(`DELETE FROM content_nodes WHERE workspace_id = $1`, [workspaceId]);
    await pool.end();
  });

  it("walks write → publish-one (redact private link) → publish-both → un-publish", async () => {
    const draft = await createNote("Secret Draft", "unreleased thoughts");
    const post = await createNote("My First Post", "Welcome! See [[Secret Draft]] for the backstory.");

    // ── 2. Nothing public until the first Publish ───────────────────────────
    expect(await siteNodes()).toEqual([]);

    // ── 3. Publish ONLY the post: the space publishes, the draft is kept off ─
    expect((await setPublished(draft.id, "false")).status).toBe(200);
    expect(await siteNodes()).toEqual([]); // public only at the next Publish
    await publish();
    let nodes = await siteNodes();
    expect(nodes.map((n) => n.title)).toEqual(["My First Post"]);     // draft NOT public
    const published = nodes.find((n) => n.id === post.id)!;
    // the [[Secret Draft]] link is neutralized — the private title can't leak
    expect(published.markdown).toContain("（未公開）");
    expect(published.markdown).not.toContain("Secret Draft");

    // ── 4. Put the draft back (its space's rule) → the link resolves ─────────
    expect((await app.request(`/api/nodes/${draft.id}/attributes/_published`, { method: "DELETE" })).status).toBe(200);
    await publish();
    nodes = await siteNodes();
    expect(nodes.map((n) => n.title).sort()).toEqual(["My First Post", "Secret Draft"]);
    expect(nodes.find((n) => n.id === post.id)!.markdown).toContain("[[Secret Draft]]"); // link kept

    // ── 5. Un-publish the post → drops on the next read (serve-time gate) ────
    // 「不發布」 keeps it off, whatever its space says (the note menu does this).
    expect((await setPublished(post.id, "false")).status).toBe(200);
    expect((await siteNodes()).map((n) => n.title)).toEqual(["Secret Draft"]);
  });
});
