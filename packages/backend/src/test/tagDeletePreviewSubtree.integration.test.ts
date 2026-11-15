// T7: the tag delete-preview must report what the delete actually takes.
// Deleting a tag trashes its whole live subtree (nodeTrash.trashNode): child
// tags, their children, and any note filed under them. The preview used to
// count the tag alone. Sub-tag names are global (the tag tree is unfiltered);
// notes under the tag are counted only when the caller can read them, and the
// unreadable remainder is a bare number for the workspace owner — the only
// one who can delete a tag — and absent for everyone else.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q } from "../db.js";
import tagsRouter from "../routes/tags.js";
import { trashNode } from "../services/nodeTrash.js";
import { persistActor } from "./helpers/persistActor.js";
import { makeSpace } from "./helpers/spaceFixtures.js";
import type { ActorCtx } from "../types.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

// A workspace of the file's own, owned by this file's owner rather than
// handing the shared 'default' workspace to it; the routes find it through
// getWorkspaceId.
let WS = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => WS }));

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/tags", tagsRouter);

let owner: ActorCtx = { id: "t7-owner", name: "Owner", role: "admin", type: "human" };
let viewer: ActorCtx = { id: "t7-viewer", name: "Viewer", role: "viewer", type: "human" };

type Preview = {
  members: number;
  sub_tags: Array<{ id: string; name: string }>;
  sub_tag_members: number;
  descendant_items: number;
  hidden_descendants?: number;
};

describe.skipIf(!isTestDb)("tag delete-preview covers the subtree the delete trashes (T7)", () => {
  const stamp = Date.now();
  let root = "", child = "", grandchild = "", trashedChild = "", readableNote = "", hiddenNote = "", member = "";
  let trees = 0;

  const mkTag = async (name: string, parent: string | null, deleted = false): Promise<string> =>
    (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, tag_color, parent_id, deleted_at)
       VALUES ($1,'manual','class_tag',$2,$3,'#888',$4,${deleted ? "now()" : "NULL"}) RETURNING id`,
      [WS, name, `t7-tag-${name}`, parent])).rows[0]!.id;
  // The tree under one root tag (a fresh one per call: the trash test deletes its own).
  const mkNote = async (slug: string, parent: string | null): Promise<string> =>
    (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id)
       VALUES ($1,'manual','content',$2,$3,'b',$4) RETURNING id`,
      [WS, `t7 ${slug} ${stamp}`, `t7-${slug}-${stamp}`, parent])).rows[0]!.id;
  const preview = async (actor: ActorCtx, tagId: string): Promise<Preview> => {
    currentActor = actor;
    const res = await app.request(`/api/tags/${tagId}/delete-preview`);
    expect(res.status).toBe(200);
    return (await res.json()) as Preview;
  };

  const buildTree = async () => {
    const tag = `${stamp}x${++trees}`;
    const root = await mkTag(`t7root${tag}`, null);
    const child = await mkTag(`t7child${tag}`, root);
    const grandchild = await mkTag(`t7grand${tag}`, child);
    const trashedChild = await mkTag(`t7gone${tag}`, root, true);
    const readableNote = await mkNote(`readable-${tag}`, child);
    // Filed under the child tag, but in a space the owner is not in.
    const hiddenNote = await mkNote(`hidden-${tag}`, child);
    const viewerOnly = await makeSpace(WS, `t7-viewer-only-${tag}`, [{ id: viewer.id, role: "viewer" }]);
    await seedQ(`UPDATE content_nodes SET space_id = $1 WHERE id = $2`, [viewerOnly, hiddenNote]);

    // A note tagged with the grandchild loses that tag when it is trashed.
    const member = await mkNote(`member-${tag}`, null);
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2)`, [member, grandchild]);
    // Counted once, not again as "loses a sub-tag": a note carrying the root
    // tag too (it is in `members`), and one filed under the tag (it goes to
    // the Trash).
    const both = await mkNote(`both-${tag}`, null);
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2), ($1,$3)`, [both, root, child]);
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2)`, [readableNote, grandchild]);
    return { root, child, grandchild, trashedChild, readableNote, hiddenNote, member };
  };

  beforeAll(async () => {
    WS = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('T7 delete preview', $1) RETURNING id::text`,
      [`t7-delete-preview-${randomUUID()}`])).rows[0]!.id;
    owner = await persistActor(WS, owner); // a human admin: it owns this workspace
    viewer = await persistActor(WS, viewer);

    ({ root, child, grandchild, trashedChild, readableNote, hiddenNote, member } = await buildTree());
  });

  it("names the live sub-tags, nearest first, and leaves trashed ones out", async () => {
    const p = await preview(owner, root);
    expect(p.sub_tags.map((t) => t.id)).toEqual([child, grandchild]);
    expect(p.sub_tags.map((t) => t.id)).not.toContain(trashedChild);
    expect(p.members).toBe(1);
    expect(p.sub_tag_members).toBe(1);
  });

  it("counts readable notes under the tag; the owner also gets the unreadable remainder as a number", async () => {
    const p = await preview(owner, root);
    expect(p.descendant_items).toBe(1);
    expect(p.hidden_descendants).toBe(1);
  });

  it("a non-owner sees only what it can read, with no hidden count", async () => {
    const p = await preview(viewer, root);
    expect(p.sub_tags.map((t) => t.id)).toEqual([child, grandchild]);
    expect(p.descendant_items).toBe(2); // both: the default space and its own space
    expect(p).not.toHaveProperty("hidden_descendants");
  });

  it("the preview matches what trashNode then trashes", async () => {
    // Its own tree: the trash takes it away from the other tests.
    const { root, child, grandchild, readableNote, hiddenNote, member } = await buildTree();
    const p = await preview(owner, root);
    const expected = 1 + p.sub_tags.length + p.descendant_items + (p.hidden_descendants ?? 0);
    await trashNode(owner, WS, root);
    const r = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM content_nodes
        WHERE id = ANY($1::uuid[]) AND deleted_at IS NOT NULL`,
      [[root, child, grandchild, readableNote, hiddenNote]]);
    expect(Number(r.rows[0]!.n)).toBe(expected);
    // A note that only carried a sub-tag loses the tag, not itself.
    const kept = await q<{ deleted_at: string | null }>(`SELECT deleted_at FROM content_nodes WHERE id = $1`, [member]);
    expect(kept.rows[0]!.deleted_at).toBeNull();
  });
});
