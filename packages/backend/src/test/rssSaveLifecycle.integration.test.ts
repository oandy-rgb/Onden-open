// An RSS save follows its note's life (W22):
//   * trashing the saved note makes the article unsaved again; saving it again
//     RESTORES that note (one note per article, never two; it used to answer
//     "already saved" with the trashed note forever); restoring the note by hand
//     shows the article saved again;
//   * two saves at once make one note (the second waits on the event lock
//     and finds the first);
//   * an offline replay re-links only the note that is this article's save,
//     never another note whose id it carries;
//   * a source's auto_tag is stored as the tag's id: a title two tags share is
//     refused at subscribe, and a renamed tag still applies.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import { drainOutbox, registerOutboxEffect } from "../services/outbox.js";
import rssRouter from "../modules/rss/routes.js";
import nodesRouter from "../routes/nodes.js";
import { __setFeedFetchForTests, rssFetchEffect, type ParsedFeed, type FeedItem } from "../modules/rss/fetch.js";
import { K } from "../modules/rss/sources.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/rss", rssRouter);
app.route("/api/nodes", nodesRouter);
registerOutboxEffect(rssFetchEffect);
registerShippedModules();

const admin: ActorCtx = { id: "rss-life-admin", name: "Admin", role: "admin", type: "human" };
const stamp = `${Date.now()}-${randomUUID().slice(0, 6)}`;
const FEEDS = new Map<string, ParsedFeed>();
const item = (n: number, feed = ""): FeedItem => ({
  guid: `life-${stamp}-${feed}-${n}`, title: `Story ${n} ${stamp}`, url: `https://feed.test/life/${n}`,
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

/** Subscribe to a fresh feed with `count` items; returns its source and items. */
async function feedWith(count: number, extra: Record<string, unknown> = {}): Promise<{ source: string; items: Item[]; feed: string }> {
  const feed = randomUUID();
  const url = `https://feed.test/life-${feed}.xml`;
  FEEDS.set(url, { title: `Life ${stamp}`, etag: null, lastModified: null, notModified: false,
    items: Array.from({ length: count }, (_, i) => item(i + 1, feed)) });
  const res = await post("/api/rss/subscribe", { url, ...extra });
  expect(res.status, await res.clone().text()).toBe(201);
  const source = (await json<{ id: string }>(res)).id;
  await drainFetchFor(source);
  const items = (await json<{ items: Item[] }>(await app.request(`/api/rss/items?source=${source}`))).items;
  return { source, items, feed };
}
const savedPointer = async (source: string, itemId: string) =>
  (await json<{ items: Item[] }>(await app.request(`/api/rss/items?source=${source}`))).items.find((i) => i.id === itemId)!.saved_node_id;

describe.skipIf(!isTestDb)("an RSS save follows its note's life (DB)", () => {
  beforeAll(async () => {
    await q(`INSERT INTO workspaces (name, slug) VALUES ('Test','default') ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name`);
    Object.assign(admin, await persistActor(await getWorkspaceId(), admin));
    currentActor = admin;
    __setFeedFetchForTests(async (url) => {
      const feed = FEEDS.get(url);
      if (!feed) throw new Error(`stub: no feed for ${url}`);
      return feed;
    });
  });
  afterAll(() => { __setFeedFetchForTests(null); });

  it("save → trash → save again restores the same note; restoring by hand shows it saved again", async () => {
    const { source, items, feed } = await feedWith(2);
    const [a, b] = items;

    const first = await post(`/api/rss/items/${a!.id}/save`);
    expect(first.status).toBe(201);
    const firstNode = (await json<{ node_id: string }>(first)).node_id;
    const titleBefore = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [firstNode])).rows[0]!.title;
    expect((await app.request(`/api/nodes/${firstNode}`, { method: "DELETE" })).status).toBe(200);
    expect(await savedPointer(source, a!.id)).toBeNull();

    const again = await post(`/api/rss/items/${a!.id}/save`, { node_id: randomUUID() });
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ node_id: firstNode, restored: true });
    expect(await savedPointer(source, a!.id)).toBe(firstNode);
    const live = await q(`SELECT n.id FROM content_nodes n JOIN node_attributes g ON g.node_id = n.id AND g.key = $1 AND g.value = $2
                           WHERE n.deleted_at IS NULL`, [K.guid, item(1, feed).guid]);
    expect(live.rows).toEqual([{ id: firstNode }]);
    expect((await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [firstNode])).rows[0]!.title).toBe(titleBefore);

    // Without a second save, restoring the note shows the article saved again.
    const bNode = (await json<{ node_id: string }>(await post(`/api/rss/items/${b!.id}/save`))).node_id;
    expect((await app.request(`/api/nodes/${bNode}`, { method: "DELETE" })).status).toBe(200);
    expect(await savedPointer(source, b!.id)).toBeNull();
    expect((await post(`/api/nodes/${bNode}/undelete`)).status).toBe(200);
    expect(await savedPointer(source, b!.id)).toBe(bNode);
  });

  it("two saves at once make one note", async () => {
    const { items, feed } = await feedWith(1);
    const [r1, r2] = await Promise.all([post(`/api/rss/items/${items[0]!.id}/save`), post(`/api/rss/items/${items[0]!.id}/save`)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    const notes = await q(
      `SELECT n.id FROM content_nodes n JOIN node_attributes a ON a.node_id = n.id AND a.key = $1 AND a.value = $2
        WHERE n.deleted_at IS NULL`, [K.guid, item(1, feed).guid]);
    expect(notes.rows).toHaveLength(1);
  });

  it("an offline replay re-links only this article's own note", async () => {
    const { source, items } = await feedWith(2);
    const minted = randomUUID();
    expect((await post(`/api/rss/items/${items[0]!.id}/save`, { node_id: minted })).status).toBe(201);
    // Another article's save carrying the first note's id is refused.
    const wrong = await post(`/api/rss/items/${items[1]!.id}/save`, { node_id: minted });
    expect(wrong.status).toBe(409);
    expect(await savedPointer(source, items[1]!.id)).toBeNull();
    // The same save replayed converges on its note.
    const replay = await post(`/api/rss/items/${items[0]!.id}/save`, { node_id: minted });
    expect(replay.status).toBe(200);
    expect((await json<{ node_id: string }>(replay)).node_id).toBe(minted);
    // Once that note is in the trash, a late replay restores it (the article's one note).
    expect((await app.request(`/api/nodes/${minted}`, { method: "DELETE" })).status).toBe(200);
    const late = await post(`/api/rss/items/${items[0]!.id}/save`, { node_id: minted });
    expect(late.status).toBe(200);
    expect(await json(late)).toMatchObject({ node_id: minted, restored: true });
    expect(await savedPointer(source, items[0]!.id)).toBe(minted);
  });

  it("auto_tag is stored by id: a shared title is refused, a renamed tag still applies", async () => {
    const WS = await getWorkspaceId();
    const tagTitle = `life-tag-${stamp}`;
    const tag = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug)
       VALUES ($1,'manual','class_tag',$2,$3) RETURNING id::text`, [WS, tagTitle, `tag-${randomUUID()}`])).rows[0]!.id;
    const { source, items } = await feedWith(1, { auto_tag: tagTitle });
    expect((await q(`SELECT auto_tag_id::text AS value FROM rss_subscriptions WHERE id=$1`, [source])).rows)
      .toEqual([{ value: tag }]);

    await seedQ(`UPDATE content_nodes SET title = $2 WHERE id = $1`, [tag, `${tagTitle}-renamed`]);
    const saved = (await json<{ node_id: string }>(await post(`/api/rss/items/${items[0]!.id}/save`))).node_id;
    expect((await q(`SELECT 1 FROM node_tags WHERE node_id=$1 AND tag_id=$2`, [saved, tag])).rows).toHaveLength(1);
    const sources = (await json<{ sources: Array<{ id: string; auto_tag: string | null }> }>(await app.request("/api/rss/sources"))).sources;
    expect(sources.find((s) => s.id === source)?.auto_tag).toBe(`${tagTitle}-renamed`);

    // Two tags with one title (under different parents): which one is meant?
    const dupTitle = `life-dup-${stamp}`;
    for (let i = 0; i < 2; i++) {
      const parent = (await seedQ<{ id: string }>(
        `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug) VALUES ($1,'manual','class_tag',$2,$3) RETURNING id::text`,
        [WS, `life-parent-${i}-${stamp}`, `tag-${randomUUID()}`])).rows[0]!.id;
      await seedQ(`INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, parent_id) VALUES ($1,'manual','class_tag',$2,$3,$4)`,
        [WS, dupTitle, `tag-${randomUUID()}`, parent]);
    }
    FEEDS.set("https://feed.test/dup.xml", { title: "Dup", etag: null, lastModified: null, notModified: false, items: [] });
    const refused = await post("/api/rss/subscribe", { url: "https://feed.test/dup.xml", auto_tag: dupTitle });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: "auto_tag_ambiguous" });
  });
  it("refuses an article over the note body cap as too_large and cuts a long title to the cap (D67)", async () => {
    const { items } = await feedWith(2);
    const [tooBig, longTitled] = items;
    await q(`UPDATE rss_staging SET body = $2 WHERE id = $1`, [tooBig!.id, `<p>${"x".repeat(2_000_100)}</p>`]);
    const refused = await post(`/api/rss/items/${tooBig!.id}/save`);
    expect(refused.status).toBe(413);
    expect(await refused.json()).toMatchObject({ error: "too_large" });
    expect((await q(`SELECT saved_node_id FROM rss_staging WHERE id = $1`, [tooBig!.id])).rows[0]).toMatchObject({ saved_node_id: null });

    const title = `T${stamp}`.padEnd(600, "t");
    await q(`UPDATE rss_staging SET title = $2 WHERE id = $1`, [longTitled!.id, title]);
    const saved = await post(`/api/rss/items/${longTitled!.id}/save`);
    expect(saved.status).toBe(201);
    const body = await json<{ node_id: string; title_truncated?: boolean }>(saved);
    expect(body.title_truncated).toBe(true);
    const node = (await q<{ title: string }>(`SELECT title FROM content_nodes WHERE id = $1`, [body.node_id])).rows[0]!;
    expect(node.title).toBe(title.slice(0, 500));
  });
});
