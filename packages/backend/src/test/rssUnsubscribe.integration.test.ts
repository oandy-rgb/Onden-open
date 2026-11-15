// 取消訂閱 (POST /api/rss/sources/:id/unsubscribe):
//   * the subscription row is deleted, so nothing fetches it (the scheduler
//     skips it, a pending intent finds nothing); it records no domain event;
//   * already-saved articles — and any note filed by hand — are notes and are
//     not touched: they stay live where they are;
//   * the source's stream (unsaved articles, tombstones) goes with the row;
//   * someone who cannot see the source gets 404 and nothing changes; someone
//     who may only view it gets 403 and nothing changes; an id that is not a
//     source (a note's) is 404.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import { drainOutbox, registerOutboxEffect } from "../services/outbox.js";
import rssRouter from "../modules/rss/routes.js";
import {
  __setFeedFetchForTests, rssFetchEffect, performRssFetch, enqueueDueRssFetches, type ParsedFeed, type FeedItem,
} from "../modules/rss/fetch.js";
import { findSource } from "../modules/rss/sources.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { seedQ } from "./helpers/seedQ.js";

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/rss", rssRouter);
registerOutboxEffect(rssFetchEffect);
registerShippedModules();

const admin: ActorCtx = { id: "rss-unsub-admin", name: "Admin", role: "admin", type: "human" };
const editor: ActorCtx = { id: "rss-unsub-editor", name: "Editor", role: "editor", type: "human" };
const stamp = `${Date.now()}-${randomUUID().slice(0, 6)}`;
const FEEDS = new Map<string, ParsedFeed>();
const item = (n: number, feed: string): FeedItem => ({
  guid: `unsub-${stamp}-${feed}-${n}`, title: `Unsub story ${n} ${stamp}`, url: `https://feed.test/unsub/${n}`,
  publishedAt: new Date(Date.now() - n * 60_000).toISOString(), contentHtml: `<p>Story ${n}</p>`,
});
const post = (path: string, body: unknown = {}) =>
  app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const json = async <T>(res: Response) => (await res.json()) as T;
type Item = { id: string; saved_node_id: string | null };

async function drainFetchFor(sourceId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const row = (await q<{ id: string; status: string }>(
      `SELECT id::text, status FROM outbox WHERE dedup_key = $1 ORDER BY outbox.id DESC LIMIT 1`, [`rss_fetch:${sourceId}`])).rows[0];
    if (!row) throw new Error(`no rss_fetch intent for ${sourceId}`);
    if (row.status === "done") return;
    await drainOutbox({ id: row.id });
    await new Promise((res) => setTimeout(res, 30));
  }
  throw new Error("rss_fetch never drained");
}

describe.skipIf(!isTestDatabase())("rss unsubscribe (DB)", () => {
  let WS = "";
  // Each test gets its own subscribed feed (fresh source, a saved article and
  // a note beside it), so no test depends on another having run.
  let feed = "";
  let url = "";
  let source = "";
  let items: Item[] = [];
  let savedNode = "";
  let filedNote = "";
  const created: string[] = [];

  beforeAll(async () => {
    WS = await getWorkspaceId();
    Object.assign(admin, await persistActor(WS, admin));
    Object.assign(editor, await persistActor(WS, editor));
    __setFeedFetchForTests(async (u) => {
      const f = FEEDS.get(u);
      if (!f) throw new Error(`stub: no feed for ${u}`);
      return f;
    });
  });

  beforeEach(async () => {
    feed = randomUUID();
    url = `https://feed.test/unsub-${feed}.xml`;
    FEEDS.set(url, { title: `Unsub ${stamp}`, etag: null, lastModified: null, notModified: false,
      items: [1, 2, 3].map((n) => item(n, feed)) });
    currentActor = admin;
    const res = await post("/api/rss/subscribe", { url });
    expect(res.status).toBe(201);
    source = (await json<{ id: string }>(res)).id;
    await drainFetchFor(source);
    items = (await json<{ items: Item[] }>(await app.request(`/api/rss/items?source=${source}`))).items;
    expect(items).toHaveLength(3);
    savedNode = (await json<{ node_id: string }>(await post(`/api/rss/items/${items[0]!.id}/save`))).node_id;
    // A note the person wrote about the feed.
    filedNote = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id)
       SELECT $1, 'manual', 'content', 'my notes on this feed', $2, '', s.id FROM spaces s
        WHERE s.workspace_id = $1 AND s.kind = 'personal' AND s.owner_actor_id = $3 RETURNING id`,
      [WS, `unsub-filed-${stamp}-${feed}`, admin.id])).rows[0]!.id;
    created.push(savedNode, filedNote, source);
  });

  /** Unsubscribe the test's source (the step the later tests start from). */
  async function unsubscribe() {
    currentActor = admin;
    const res = await post(`/api/rss/sources/${source}/unsubscribe`);
    expect(res.status).toBe(200);
    return res;
  }

  afterAll(async () => {
    __setFeedFetchForTests(null);
    await seedQ(`DELETE FROM rss_subscriptions WHERE id = ANY($1::uuid[])`, [created.filter(Boolean)]);
    await seedQ(`DELETE FROM content_nodes WHERE id = ANY($1::uuid[])`, [created.filter(Boolean)]);
  });

  it("someone who cannot see the source gets 404 and nothing changes", async () => {
    currentActor = editor; // the source sits in the admin's personal space
    expect((await post(`/api/rss/sources/${source}/unsubscribe`)).status).toBe(404);
    expect(await findSource(WS, { id: source })).not.toBeNull();
  });

  it("someone who may only view the source's space gets 403 and nothing changes", async () => {
    const spaceId = (await findSource(WS, { id: source }))!.space_id;
    await q(`INSERT INTO space_members (space_id, actor_id, permission) VALUES ($1, $2, 'view') ON CONFLICT (space_id, actor_id) DO UPDATE SET permission = 'view'`,
      [spaceId, editor.id]);
    try {
      currentActor = editor;
      expect((await post(`/api/rss/sources/${source}/unsubscribe`)).status).toBe(403);
      expect(await findSource(WS, { id: source })).not.toBeNull();
    } finally {
      await q(`DELETE FROM space_members WHERE space_id = $1 AND actor_id = $2`, [spaceId, editor.id]);
    }
  });

  it("a note's id is not a source: 404", async () => {
    currentActor = admin;
    expect((await post(`/api/rss/sources/${savedNode}/unsubscribe`)).status).toBe(404);
  });

  it("deletes the subscription, keeps saved articles and notes as they are, clears the stream", async () => {
    const eventsBefore = (await q<{ n: string }>(`SELECT count(*)::text AS n FROM domain_events WHERE workspace_id = $1`, [WS])).rows[0]!.n;
    const res = await unsubscribe();
    expect(await json(res)).toMatchObject({ id: source, unsubscribed: true, kept: 1, cleared: 2 });
    expect(await findSource(WS, { id: source })).toBeNull();

    const rows = (await q<{ id: string; trashed: boolean }>(
      `SELECT id::text, deleted_at IS NOT NULL AS trashed FROM content_nodes WHERE id = ANY($1::uuid[])`,
      [[savedNode, filedNote]])).rows;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !r.trashed)).toBe(true);
    // The saved article keeps its provenance.
    const origin = await q<{ value: string }>(`SELECT value FROM node_attributes WHERE node_id = $1 AND key = '_rss_source'`, [savedNode]);
    expect(origin.rows[0]?.value).toBe(source);

    // The stream went with the row; a setting records no event.
    expect((await q(`SELECT 1 FROM rss_staging WHERE subscription_id = $1`, [source])).rows).toHaveLength(0);
    // (The save above made its own events before the count was taken.)
    expect((await q<{ n: string }>(`SELECT count(*)::text AS n FROM domain_events WHERE workspace_id = $1`, [WS])).rows[0]!.n).toBe(eventsBefore);
  });

  it("stops fetching: not listed, not due, a pending intent ingests nothing", async () => {
    await unsubscribe();
    const list = await json<{ sources: Array<{ id: string }> }>(await app.request("/api/rss/sources"));
    expect(list.sources.map((s) => s.id)).not.toContain(source);
    FEEDS.get(url)!.items.push(item(4, feed));
    await enqueueDueRssFetches();
    const pending = await q(`SELECT 1 FROM outbox WHERE dedup_key = $1 AND status = 'pending'`, [`rss_fetch:${source}`]);
    expect(pending.rows).toHaveLength(0);
    expect(await performRssFetch({ workspaceId: WS, subscriptionId: source })).toEqual({ created: 0, skipped: 0 });
    expect((await q(`SELECT 1 FROM rss_staging WHERE subscription_id = $1`, [source])).rows).toHaveLength(0);
    expect((await post(`/api/rss/sources/${source}/unsubscribe`)).status).toBe(404);
  });

  it("subscribing again starts a new subscription with its own stream", async () => {
    await unsubscribe();
    const again = await post("/api/rss/subscribe", { url });
    expect(again.status).toBe(201);
    const fresh = (await json<{ id: string }>(again)).id;
    created.push(fresh);
    expect(fresh).not.toBe(source);
    await drainFetchFor(fresh);
    const visible = (await json<{ items: Item[] }>(await app.request(`/api/rss/items?source=${fresh}`))).items;
    expect(visible).toHaveLength(3);
  });
});
