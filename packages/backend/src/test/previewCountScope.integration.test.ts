// delete-preview and merge-preview must report member counts SCOPED to the
// caller's readable set. An unscoped count leaks how many read-restricted nodes
// carry a tag to a low-role actor (L3).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import tagsRouter from "../routes/tags.js";
import { persistActor } from "./helpers/persistActor.js";
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/tags", tagsRouter);

let admin: ActorCtx = { id: "pcs-admin", name: "Admin", role: "admin", type: "human" };
let viewer: ActorCtx = { id: "pcs-viewer", name: "Viewer", role: "viewer", type: "human" };

describe.skipIf(!isTestDb)("preview member counts are read-scoped (L3)", () => {
  let WS = "";
  const stamp = Date.now();
  let labelTag = "", targetTag = "";

  const mkNode = async (slug: string): Promise<string> =>
    (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1,'manual','content',$2,$3,'b') RETURNING id`,
      [WS, `pcs ${slug} ${stamp}`, `pcs-${slug}-${stamp}`],
    )).rows[0]!.id;
  const applyTag = (node: string, tag: string) =>
    seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [node, tag]);

  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    admin = await persistActor(WS, admin);
    viewer = await persistActor(WS, viewer);

    // The tag being previewed (a plain label class_tag) and a merge target.
    labelTag = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, tag_color)
       VALUES ($1,'manual','class_tag',$2,$3,'#888') RETURNING id`,
      [WS, `pcs-label-${stamp}`, `pcs-tag-label-${stamp}`])).rows[0]!.id;
    targetTag = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, tag_color)
       VALUES ($1,'manual','class_tag',$2,$3,'#888') RETURNING id`,
      [WS, `pcs-target-${stamp}`, `pcs-tag-target-${stamp}`])).rows[0]!.id;

    // An admin-only space hides whatever is in it from the viewer.
    const restrict = await adminOnlySpace(WS, `pcs-restrict-${stamp}`, [admin.id]);

    const readable = await mkNode("readable");
    const restricted = await mkNode("restricted");
    await putInSpace(restricted, restrict);   // hidden from the viewer
    for (const n of [readable, restricted]) await applyTag(n, labelTag);
  });

  it("delete-preview counts only the caller's readable members", async () => {
    currentActor = admin;
    expect(((await (await app.request(`/api/tags/${labelTag}/delete-preview`)).json()) as { members: number }).members)
      .toBe(2); // admin sees both
    currentActor = viewer;
    expect(((await (await app.request(`/api/tags/${labelTag}/delete-preview`)).json()) as { members: number }).members)
      .toBe(1); // viewer sees only the readable one (was 2 — the leak)
  });

  it("merge-preview counts only the caller's readable members", async () => {
    currentActor = admin;
    const a = (await (await app.request(`/api/tags/${labelTag}/merge-preview?target=${targetTag}`)).json()) as { members_gaining_target: number };
    expect(a.members_gaining_target).toBe(2);
    currentActor = viewer;
    const v = (await (await app.request(`/api/tags/${labelTag}/merge-preview?target=${targetTag}`)).json()) as { members_gaining_target: number };
    expect(v.members_gaining_target).toBe(1); // only the readable member (was 2)
  });
});
