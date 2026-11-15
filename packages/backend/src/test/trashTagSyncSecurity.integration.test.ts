// Two punch-list bugs:
//   (1) the trash listing (/api/nodes/trash, since removed — History's
//       "Deleted" view, /api/events?deleted=1, took its place) leaked
//       titles/slugs of read-restricted notes: it applied no read bound, so a
//       viewer / tag-scoped token saw a #confidential note's title simply
//       because it was deleted. The Deleted view keeps the same bound.
//   (2) /api/sync never shipped a node row on TAG_APPLIED / TAG_REMOVED, so a
//       client's offline class_tag_ids / label_tag_ids projection went stale
//       (collection items mixing into note feeds after a tag change).
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId, event } from "../db.js";
import nodeRouter from "../routes/nodes.js";
import eventsRouter from "../routes/events.js";
import syncRouter from "../routes/sync.js";
import { seedClassTag } from "./helpers/seedClassTag.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/nodes", nodeRouter);
app.route("/api/sync", syncRouter);
app.route("/api/events", eventsRouter);

let admin: ActorCtx = { id: "tts-admin", name: "Admin", role: "admin", type: "human" };
let viewer: ActorCtx = { id: "tts-viewer", name: "Viewer", role: "viewer", type: "human" };

/** History's Deleted view, as the notes it names. */
const trash = async () => {
  const r = await app.request("/api/events?deleted=1&limit=500");
  return ((await r.json()) as { events: Array<{ target_id: string }> }).events.map((e) => ({ id: e.target_id }));
};
const mkContent = async (WS: string, title: string, slug: string) =>
  (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
     VALUES ($1,'manual','content',$2,$3,'body') RETURNING id`, [WS, title, slug])).rows[0]!.id;
const tag = (nodeId: string, tagId: string) =>
  seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [nodeId, tagId]);

describe.skipIf(!isTestDb)("trash read-policy + tag-apply sync (DB)", () => {
  let WS = "", restrictedId = "", openId = "", cascadeChildId = "";
  const stamp = Date.now();
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    WS = await getWorkspaceId();
    admin = await persistActor(WS, admin);
    viewer = await persistActor(WS, viewer);
    const secret = await adminOnlySpace(WS, `TTS Secret ${stamp}`, [admin.id]);

    restrictedId = await mkContent(WS, `tts restricted ${stamp}`, `tts-restricted-${stamp}`);
    openId = await mkContent(WS, `tts open ${stamp}`, `tts-open-${stamp}`);
    // A child of the restricted node — children take their parent's space, so
    // it is hidden along with it.
    cascadeChildId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, parent_id)
       VALUES ($1,'manual','content',$2,$3,'body',$4) RETURNING id`,
      [WS, `tts cascade child ${stamp}`, `tts-cascade-${stamp}`, restrictedId])).rows[0]!.id;
    await putInSpace(restrictedId, secret); // the restricted note and its child
    // delete all three, each by its own event (the child's not chained to its
    // parent's, so the Deleted view lists it on its own)
    for (const id of [restrictedId, openId, cascadeChildId]) {
      const eventId = await event(WS, "NODE_DELETED", "node", id, {}, "user", admin.id);
      await seedQ(`UPDATE content_nodes SET deleted_at = now(), deleted_by_event_id = $2 WHERE id = $1`, [id, eventId]);
    }
  });

  it("#1 the Deleted view hides a read-restricted deleted note (and its child) from a viewer", async () => {
    currentActor = viewer;
    const v = await trash();
    expect(v.some((n) => n.id === openId)).toBe(true);          // a plain trashed note shows
    expect(v.some((n) => n.id === restrictedId)).toBe(false);   // admin-only space → hidden
    expect(v.some((n) => n.id === cascadeChildId)).toBe(false); // child in the same space → hidden

    currentActor = admin;
    const a = await trash();
    expect(a.some((n) => n.id === restrictedId)).toBe(true);    // admin sees both
    expect(a.some((n) => n.id === cascadeChildId)).toBe(true);
  });

  it("#2 sync ships the node row on TAG_APPLIED so tag membership converges", async () => {
    currentActor = admin;
    const node = await mkContent(WS, `tts sync ${stamp}`, `tts-sync-${stamp}`);
    // Backed off 256 ids: /api/sync parses `since` as a JS number (lossy past 2^53).
    const since = (await q<{ max: string }>(`SELECT GREATEST(COALESCE(MAX(id),0) - 256, 0)::text AS max FROM domain_events`)).rows[0]!.max;
    const classTag = (await seedClassTag(WS, { name: `TTS Class ${stamp}`, slug: `tts-class-${stamp}`, nodeSlug: `tag-tts-class-${stamp}` })).tagId;
    await tag(node, classTag);
    await event(WS, "TAG_APPLIED", "node", node, { tag_id: classTag }, "user", admin.id);

    const delta = (await (await app.request(`/api/sync?since=${since}`)).json()) as { nodes: { upsert: Array<{ id: string; class_tag_ids?: string[] }> } };
    const row = delta.nodes.upsert.find((n) => n.id === node);
    expect(row, "the tagged node must be re-shipped").toBeTruthy();
    expect(row!.class_tag_ids).toContain(classTag); // its projection now carries the class tag
  });
});
