// Where 存 puts an article (modules/rss/destination.ts):
//   * a chosen destination (tags like folders + an optional parent note) wins;
//   * otherwise the default: the source's own (explicit; a feed subscribed with
//     an auto tag has that tag as its explicit default) > the RSS module's
//     workspace default > top level, no tags;
//   * the parent is always a NOTE, never a tag: refused (422) when chosen, at
//     subscribe and in a source's settings; ignored in a stored default;
//   * GET /sources tells the reader each feed's default.
//
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { apiOnError } from "../httpError.js";
import { q, getWorkspaceId } from "../db.js";
import { drainOutbox, registerOutboxEffect } from "../services/outbox.js";
import rssRouter from "../modules/rss/routes.js";
import { __setFeedFetchForTests, rssFetchEffect, type ParsedFeed, type FeedItem } from "../modules/rss/fetch.js";
import { MODULE_DEFAULT_KEYS } from "../modules/rss/destination.js";
import type { ActorCtx } from "../types.js";
import { persistActor } from "./helpers/persistActor.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { isTestDatabase } from "./helpers/testDatabase.js";
import { seedQ } from "./helpers/seedQ.js";
import { setSiteConfig } from "./helpers/siteConfigFixture.js";

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/rss", rssRouter);
registerOutboxEffect(rssFetchEffect);
registerShippedModules();

const admin: ActorCtx = { id: "rss-dest-admin", name: "Admin", role: "admin", type: "human" };
const stamp = `${Date.now()}-${randomUUID().slice(0, 6)}`;
const FEEDS = new Map<string, ParsedFeed>();
const send = (method: string, path: string, body: unknown = {}) =>
  app.request(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const post = (path: string, body: unknown = {}) => send("POST", path, body);
const json = async <T>(res: Response) => (await res.json()) as T;
type Item = { id: string };
type SourceJson = { id: string; save_default: { tag_ids: string[]; parent_id: string | null; parent_title: string | null; origin: string } };

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

describe.skipIf(!isTestDatabase())("rss save destination (DB)", () => {
  let WS = "";
  const created: string[] = [];
  let news = "", tech = "", folderNote = "", otherNote = "";

  async function tag(title: string) {
    const id = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug) VALUES ($1, 'manual', 'class_tag', $2, $3) RETURNING id::text`,
      [WS, title, `tag-${title}`])).rows[0]!.id;
    created.push(id);
    return id;
  }
  async function note(title: string) {
    const id = (await seedQ<{ id: string; space_id: string | null }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, space_id)
       SELECT $1, 'manual', 'content', $2, $3, '', s.id FROM spaces s
        WHERE s.workspace_id = $1 AND s.kind = 'personal' AND s.owner_actor_id = $4 RETURNING id::text`,
      [WS, title, `dest-${title}`, admin.id])).rows[0]!.id;
    created.push(id);
    return id;
  }
  /** Subscribe to a fresh feed with two items; returns the source and items. */
  async function feed(extra: Record<string, unknown> = {}): Promise<{ source: string; items: Item[] }> {
    const f = randomUUID();
    const url = `https://feed.test/dest-${f}.xml`;
    FEEDS.set(url, { title: `Dest ${stamp}`, etag: null, lastModified: null, notModified: false,
      items: [1, 2, 3].map((n): FeedItem => ({ guid: `dest-${f}-${n}`, title: `Dest ${n} ${stamp}`, url: `https://feed.test/d/${f}/${n}`,
        publishedAt: new Date(Date.now() - n * 60_000).toISOString(), contentHtml: `<p>Dest ${n}</p>` })) });
    const res = await post("/api/rss/subscribe", { url, ...extra });
    expect(res.status, await res.clone().text()).toBe(201);
    const source = (await json<{ id: string }>(res)).id;
    created.push(source);
    await drainFetchFor(source);
    return { source, items: (await json<{ items: Item[] }>(await app.request(`/api/rss/items?source=${source}`))).items };
  }
  async function placed(nodeId: string) {
    created.push(nodeId);
    const parent = (await q<{ parent_id: string | null }>(`SELECT parent_id::text FROM content_nodes WHERE id = $1`, [nodeId])).rows[0]!.parent_id;
    const tags = (await q<{ tag_id: string }>(`SELECT tag_id::text FROM node_tags WHERE node_id = $1 ORDER BY tag_id`, [nodeId])).rows.map((r) => r.tag_id);
    return { parent, tags };
  }
  const save = async (itemId: string, body: unknown = {}) => {
    const res = await post(`/api/rss/items/${itemId}/save`, body);
    return { status: res.status, body: await json<{ node_id: string; error?: string }>(res) };
  };
  const sourceJson = async (id: string) =>
    (await json<{ sources: SourceJson[]; module_default: unknown }>(await app.request("/api/rss/sources"))).sources.find((s) => s.id === id)!;
  const setModuleDefault = (tags: string, parent: string) =>
    setSiteConfig(WS, { [MODULE_DEFAULT_KEYS.tags]: tags, [MODULE_DEFAULT_KEYS.parent]: parent });

  beforeAll(async () => {
    WS = await getWorkspaceId();
    Object.assign(admin, await persistActor(WS, admin));
    currentActor = admin;
    __setFeedFetchForTests(async (u) => {
      const f = FEEDS.get(u);
      if (!f) throw new Error(`stub: no feed for ${u}`);
      return f;
    });
    news = await tag(`news-${stamp}`);
    tech = await tag(`tech-${stamp}`);
    folderNote = await note(`folder-${stamp}`);
    otherNote = await note(`other-${stamp}`);
    await setModuleDefault("", "");
  });

  afterAll(async () => {
    __setFeedFetchForTests(null);
    await setModuleDefault("", "");
    await seedQ(`DELETE FROM rss_subscriptions WHERE id = ANY($1::uuid[])`, [created]);
    await seedQ(`DELETE FROM content_nodes WHERE id = ANY($1::uuid[])`, [created]);
  });

  it("no default anywhere: top level, no tags", async () => {
    const { source, items } = await feed();
    expect((await sourceJson(source)).save_default).toEqual({ tag_ids: [], parent_id: null, parent_title: null, origin: "none" });
    const saved = await save(items[0]!.id);
    expect(saved.status).toBe(201);
    expect(await placed(saved.body.node_id)).toEqual({ parent: null, tags: [] });
  });

  it("a feed subscribed with an auto tag has that tag as its own default, which beats the module default", async () => {
    const { source, items } = await feed({ auto_tag: `news-${stamp}` });
    await setModuleDefault(tech, folderNote); // loses to the feed's own default
    try {
      expect((await sourceJson(source)).save_default).toMatchObject({ tag_ids: [news], parent_id: null, origin: "source" });
      const saved = await save(items[0]!.id);
      expect(await placed(saved.body.node_id)).toEqual({ parent: null, tags: [news] });
    } finally {
      await setModuleDefault("", "");
    }
  });

  it("per-source default > module default > none", async () => {
    await setModuleDefault(tech, folderNote);
    try {
      // Module default for a source with nothing of its own.
      const plain = await feed();
      expect((await sourceJson(plain.source)).save_default).toEqual({
        tag_ids: [tech], parent_id: folderNote, parent_title: `folder-${stamp}`, origin: "module",
      });
      expect(await placed((await save(plain.items[0]!.id)).body.node_id)).toEqual({ parent: folderNote, tags: [tech] });

      // The source's own explicit default beats it (set at subscribe time).
      const own = await feed({ save_default: { tag_ids: [news], parent_id: otherNote } });
      expect((await sourceJson(own.source)).save_default).toMatchObject({ tag_ids: [news], parent_id: otherNote, origin: "source" });
      expect(await placed((await save(own.items[0]!.id)).body.node_id)).toEqual({ parent: otherNote, tags: [news] });

      // "No tags, top level" is an explicit default too: it still beats the module.
      const patched = await send("PATCH", `/api/rss/sources/${own.source}`, { save_default: { tag_ids: [], parent_id: null } });
      expect(patched.status).toBe(200);
      expect(await placed((await save(own.items[1]!.id)).body.node_id)).toEqual({ parent: null, tags: [] });

      // Cleared (null): back to the module default.
      expect((await send("PATCH", `/api/rss/sources/${own.source}`, { save_default: null })).status).toBe(200);
      expect((await sourceJson(own.source)).save_default.origin).toBe("module");
      expect(await placed((await save(own.items[2]!.id)).body.node_id)).toEqual({ parent: folderNote, tags: [tech] });
    } finally {
      await setModuleDefault("", "");
    }
  });

  it("a chosen destination wins over the default", async () => {
    const { source, items } = await feed({ save_default: { tag_ids: [news], parent_id: null } });
    const saved = await save(items[0]!.id, { destination: { tag_ids: [tech, news], parent_id: folderNote } });
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({ parent_id: folderNote });
    expect(await placed(saved.body.node_id)).toEqual({ parent: folderNote, tags: [news, tech].sort() });
    // The default is untouched.
    expect((await sourceJson(source)).save_default).toMatchObject({ tag_ids: [news], parent_id: null, origin: "source" });
  });

  it("the parent is a note, never a tag", async () => {
    const { source, items } = await feed();
    const asTag = await save(items[0]!.id, { destination: { tag_ids: [], parent_id: news } });
    expect(asTag).toMatchObject({ status: 422, body: { error: "parent_not_a_note" } });
    expect((await save(items[0]!.id, { destination: { tag_ids: [randomUUID()], parent_id: null } })).body.error).toBe("unknown_tag");
    expect((await save(items[0]!.id, { destination: { tag_ids: [], parent_id: randomUUID() } })).body.error).toBe("parent_not_found");
    // Nothing was saved by the refusals.
    const staged = await q<{ saved_node_id: string | null }>(`SELECT saved_node_id FROM rss_staging WHERE id = $1`, [items[0]!.id]);
    expect(staged.rows[0]!.saved_node_id).toBeNull();

    const patched = await send("PATCH", `/api/rss/sources/${source}`, { save_default: { tag_ids: [], parent_id: news } });
    expect(patched.status).toBe(422);
    const sub = await post("/api/rss/subscribe", { url: `https://feed.test/never-${stamp}.xml`, save_default: { tag_ids: [], parent_id: tech } });
    expect(sub.status).toBe(422);

    // A module default that names a tag as the parent is ignored (top level).
    await setModuleDefault(news, tech);
    try {
      expect((await sourceJson(source)).save_default).toMatchObject({ tag_ids: [news], parent_id: null, origin: "module" });
      expect(await placed((await save(items[1]!.id)).body.node_id)).toEqual({ parent: null, tags: [news] });
    } finally {
      await setModuleDefault("", "");
    }
  });

  it("總是載入全文 is a per-feed setting", async () => {
    const { source } = await feed();
    const list = async () => (await json<{ sources: Array<{ id: string; always_fulltext: boolean }> }>(await app.request("/api/rss/sources")))
      .sources.find((s) => s.id === source)!.always_fulltext;
    expect(await list()).toBe(false);
    const on = await send("PATCH", `/api/rss/sources/${source}`, { always_fulltext: true });
    expect(on.status).toBe(200);
    expect(await json(on)).toMatchObject({ always_fulltext: true });
    expect(await list()).toBe(true);
    expect((await send("PATCH", `/api/rss/sources/${source}`, { always_fulltext: false })).status).toBe(200);
    expect(await list()).toBe(false);
  });

  it("GET /sources reports the module default", async () => {
    await setModuleDefault(`${news},${tech}`, folderNote);
    try {
      const body = await json<{ module_default: unknown }>(await app.request("/api/rss/sources"));
      expect(body.module_default).toEqual({ tag_ids: [news, tech], parent_id: folderNote });
    } finally {
      await setModuleDefault("", "");
    }
    const cleared = await json<{ module_default: unknown }>(await app.request("/api/rss/sources"));
    expect(cleared.module_default).toBeNull();
  });
});
