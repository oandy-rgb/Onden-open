// RSS module (modules/rss) against a real DB — the staging-buffer model
// ([[rss-rebuild]] revision: an article is NOT a node until saved):
//   • subscribe creates the SOURCE row (rss_subscriptions: a setting in a space,
//     not a note) and files the first rss_fetch outbox intent;
//   • the fetch effect (STUBBED feed via __setFeedFetchForTests) lands items
//     in rss_staging — NO nodes, NO domain events, NO inbox arrivals;
//   • guid dedup across two fetches; the backfill window pre-seens old items;
//   • READ POLICY (iron law): a viewer / empty-scope token sees a restricted
//     source's articles in NO list, single read, count, or sweep;
//   • seen is plain reversible buffer state;
//   • save materializes THE node through the spine, authored by the human:
//     the source's save default (tags), provenance attrs, embed
//     opt-in fires at save (not ingest), idempotent, client-mintable id;
//   • fulltext replaces the staging body in place (no version, no event);
//   • retention sweep: unseen ages to seen (default + per-source override),
//     long-seen rows tombstone beyond the per-source floor, saved rows are
//     exempt, tombstones block re-ingest;
//   • OPML round-trip; no note, tag or attribute makes a source.
// (Migrations 061/080/145 have their own files: migration.integration.test.ts,
// rssSubscriptionsMigration.integration.test.ts.)
//
// Mirrors src/test/reviewModule.integration.test.ts conventions.
// SAFETY: only runs against a *_test database; skips otherwise.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { apiOnError } from "../httpError.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { q, pool, getWorkspaceId } from "../db.js";

// A workspace of its own for the whole file: it asserts things about the
// workspace as a whole (no keyed #subscription, the inbox queue), and other
// tests — migration tests run their SQL over every workspace — may leave such
// rows in the shared default workspace.
let fileWorkspace = "";
vi.mock("../db.js", async (original) => ({ ...await original<typeof import("../db.js")>(), getWorkspaceId: async () => fileWorkspace }));
import { adminOnlySpace, putInSpace } from "./helpers/spaceFixtures.js";
import { drainOutbox, registerOutboxEffect } from "../services/outbox.js";
import rssRouter from "../modules/rss/routes.js";
import inboxRouter from "../routes/inbox.js";
import {
  __setFeedFetchForTests, __setPageFetchForTests,
  enqueueDueRssFetches, sweepRssStaging, rssFetchEffect,
  DEAD_SOURCE_REST_HOURS, UNSEEN_AGE_DAYS, TOMBSTONE_AFTER_SEEN_DAYS, KEEP_FLOOR_PER_SOURCE,
  type ParsedFeed, type FeedItem,
} from "../modules/rss/fetch.js";
import { K, findSource } from "../modules/rss/sources.js";
import type { ActorCtx } from "../types.js";
import { SafeFetchError } from "../services/safeFetch.js";
import { persistActor } from "./helpers/persistActor.js";
import { setModulesOn } from "./helpers/setModulesOn.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";
import { seedQ } from "./helpers/seedQ.js";

const DB = process.env.DATABASE_URL ?? "";
const isTestDb = /onden_test(\?|$)/.test(DB) || /_test\b/.test(DB);

let currentActor: ActorCtx | null = null;
const app = new Hono<{ Variables: { actor: ActorCtx | null } }>();
// Production error boundary — router harnesses must map spine errors the
// same way src/index.ts does (401/403 instead of Hono's default 500).
app.onError(apiOnError);
app.use("*", async (c, next) => { c.set("actor", currentActor); await next(); });
app.route("/api/rss", rssRouter);
app.route("/api/inbox", inboxRouter);
// This harness mounts the router directly, so register the module's outbox
// effect the way mountModules does for the real app.
registerOutboxEffect(rssFetchEffect);
// Saved articles embed through the semantic module's content hook.
registerShippedModules();

const admin: ActorCtx = { id: "rss-admin", name: "Admin", role: "admin", type: "human" };
const viewer: ActorCtx = { id: "rss-viewer", name: "Viewer", role: "viewer", type: "human" };
const emptyToken: ActorCtx = {
  id: "rss-token", name: "Scoped token", role: "admin", type: "agent",
  tokenScope: { tokenId: "rss-tok-1", allowedTools: null, access: "read", writeMode: "apply", expiresAt: null },
};

const stamp = Date.now();

function feedOf(items: FeedItem[], title = `Probe Feed ${stamp}`): ParsedFeed {
  return { title, etag: `"e-${stamp}"`, lastModified: null, notModified: false, items };
}
// Recent by default — the backfill window pre-seens anything older than
// BACKFILL_WINDOW_DAYS, so unseen-expecting fixtures must publish recently.
function mkItem(n: number, run: string, extra: Partial<FeedItem> = {}): FeedItem {
  return {
    guid: `guid-${run}-${n}`,
    title: `Article ${run} ${n} (${stamp})`,
    url: `https://feed.test/${run}/${n}`,
    publishedAt: new Date(Date.now() - n * 3600_000).toISOString(),
    contentHtml: `<p>Body of article ${run} ${n}.</p><script>evil()</script>`,
    ...extra,
  };
}

// The feeds the stub serves, keyed by URL.
const FEEDS = new Map<string, ParsedFeed>();

const post = (path: string, body: unknown = {}) =>
  app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const get = (path: string) => app.request(path);

/** Drain the latest rss_fetch row for a source (scoped by row id — never the
 *  global queue) and wait until it's terminal. Robust against the route's own
 *  fire-and-forget kick racing us (drainOutbox's `draining` guard makes the
 *  overlapping call a no-op, so we poll). */
async function drainFetchFor(sourceId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const r = await q<{ id: string; status: string }>(
      `SELECT id::text, status FROM outbox WHERE dedup_key = $1 ORDER BY outbox.id DESC LIMIT 1`,
      [`rss_fetch:${sourceId}`],
    );
    const row = r.rows[0];
    if (!row) throw new Error(`no rss_fetch intent for ${sourceId}`);
    if (row.status === "done") return;
    if (row.status !== "pending") throw new Error(`rss_fetch for ${sourceId} ended ${row.status}`);
    await drainOutbox({ id: row.id });
    await new Promise((res) => setTimeout(res, 30));
  }
  throw new Error("rss_fetch never drained");
}

type Item = {
  id: string; title: string; source_id: string; url: string | null;
  published_at: string | null; fetched_at: string; seen: boolean; saved_node_id: string | null;
};
type ItemList = { items: Item[]; next_cursor: string | null };

/** The list rows the caller has not seen (the list itself has no unseen filter: it is a stream). */
async function unseenList(sourceId: string): Promise<ItemList> {
  const all = (await (await get(`/api/rss/items?source=${sourceId}`)).json()) as ItemList;
  return { ...all, items: all.items.filter((i) => !i.seen) };
}
type SourceList = { sources: Array<{ id: string; title: string; unseen: number; latest_unseen_at?: string | null; last_error: string | null }>; total_unseen: number; latest_unseen_at?: string | null };

beforeAll(async () => {
  if (!isTestDb) return;
  fileWorkspace = (await q<{ id: string }>(`INSERT INTO workspaces (name, slug) VALUES ('RSS', $1) RETURNING id::text`, [`rss-${randomUUID()}`])).rows[0]!.id;
  await setModulesOn(fileWorkspace, null);
});

describe.skipIf(!isTestDb)("rss module (DB)", () => {
  let WS = "";

  beforeAll(async () => {
    WS = await getWorkspaceId();
    for (const actor of [admin, viewer, emptyToken]) Object.assign(actor, await persistActor(WS, actor));
    // persistActor joined the default space; this token's agent must reach no space.
    await q(`DELETE FROM space_members WHERE actor_id = $1::uuid`, [emptyToken.id]);
    __setFeedFetchForTests(async (url) => {
      if (url.endsWith("/huge.xml")) throw new SafeFetchError("response exceeded 26214400 bytes", "too_large");
      const feed = FEEDS.get(url);
      if (!feed) throw new Error(`stub: no feed for ${url}`);
      return feed;
    });
  });

  afterAll(() => {
    __setFeedFetchForTests(null);
    __setPageFetchForTests(null);
  });

  // Every test subscribes its own feed (a unique URL), so it does not depend
  // on which tests ran before it or on what else the shared DB holds.
  let feedSeq = 0;
  async function subscribeFresh(items: FeedItem[], extra: Record<string, unknown> = {}): Promise<{ id: string; url: string }> {
    const url = `https://feed.test/own-${stamp}-${++feedSeq}-${randomUUID().slice(0, 8)}.xml`;
    FEEDS.set(url, feedOf(items));
    const res = await post("/api/rss/subscribe", { url, ...extra });
    expect(res.status).toBe(201);
    return { id: ((await res.json()) as { id: string }).id, url };
  }
  /** A subscription fetched once: its items sit unseen in staging. */
  async function fetchedSource(items: FeedItem[] = [mkItem(1, "a"), mkItem(2, "a")], extra: Record<string, unknown> = {}) {
    const source = await subscribeFresh(items, extra);
    await drainFetchFor(source.id);
    return source;
  }
  const autoTagNamed = async (title: string) => (await seedQ<{ id: string }>(
    `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug)
     VALUES ($1, 'manual', 'class_tag', $2, $3) RETURNING id::text`,
    [WS, title, `tag-${title}`])).rows[0]!.id;
  /** A fetched source with an auto-tag, one of its articles saved as a note. */
  async function savedArticle() {
    const tagTitle = `rss-auto-${stamp}-${randomUUID().slice(0, 8)}`;
    const autoTag = await autoTagNamed(tagTitle);
    const source = await fetchedSource(undefined, { auto_tag: tagTitle });
    const items = (await (await get(`/api/rss/items?source=${source.id}`)).json()) as ItemList;
    const target = items.items.find((i) => i.url)!;
    const res = await post(`/api/rss/items/${target.id}/save`);
    expect(res.status).toBe(201);
    return { sourceId: source.id, autoTag, tagTitle, target, nodeId: ((await res.json()) as { node_id: string }).node_id };
  }

  // ── A. subscribe → source node shape ──────────────────────────────────────
  it("subscribe creates the pinned source shape: a table row in the subscriber's space + a pending fetch, no note", async () => {
    currentActor = admin;
    // The auto-tag exists ahead of any save (saving never mints tags either —
    // it only applies ones that already exist).
    const tagTitle = `rss-auto-${stamp}-${randomUUID().slice(0, 8)}`;
    const autoTag = await autoTagNamed(tagTitle);
    const mainUrl = `https://feed.test/main-${stamp}-${randomUUID().slice(0, 8)}.xml`;
    FEEDS.set(mainUrl, feedOf([mkItem(1, "a"), mkItem(2, "a")]));
    const res = await post("/api/rss/subscribe", { url: mainUrl, auto_tag: tagTitle });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; title: string };
    const mainSourceId = body.id;
    expect(body.title).toBe(`Probe Feed ${stamp}`); // from the validated feed

    // Not a note: nothing in the note tree for it.
    expect((await q(`SELECT 1 FROM content_nodes WHERE id = $1`, [mainSourceId])).rows).toHaveLength(0);
    expect((await q(`SELECT 1 FROM node_attributes WHERE node_id = $1`, [mainSourceId])).rows).toHaveLength(0);
    const events = await q(`SELECT 1 FROM domain_events WHERE workspace_id = $1 AND target_id = $2`, [WS, mainSourceId]);
    expect(events.rows).toHaveLength(0);

    const row = await q<{ url: string; auto_tag_id: string; space_id: string; created_by_actor_id: string; default_tag_ids: string[] }>(
      `SELECT url, auto_tag_id::text, space_id::text, created_by_actor_id::text, default_tag_ids::text[] FROM rss_subscriptions
        WHERE id = $1 AND workspace_id = $2`, [mainSourceId, WS]);
    expect(row.rows[0]).toMatchObject({ url: mainUrl, created_by_actor_id: admin.id });
    expect(row.rows[0]!.auto_tag_id).toBe(autoTag); // stored by id (W22), not by title
    // An auto tag is the feed's own save default.
    expect(row.rows[0]!.default_tag_ids).toEqual([autoTag]);
    const personal = await q<{ id: string }>(
      `SELECT id::text FROM spaces WHERE kind = 'personal' AND owner_actor_id::text = $1`, [admin.id]);
    expect(row.rows[0]!.space_id).toBe(personal.rows[0]?.id ?? row.rows[0]!.space_id);

    const intent = await q<{ status: string; effect_kind: string }>(
      `SELECT status, effect_kind FROM outbox WHERE dedup_key = $1 ORDER BY id DESC LIMIT 1`,
      [`rss_fetch:${mainSourceId}`]);
    expect(intent.rows[0]?.effect_kind).toBe("rss_fetch");

    // duplicate subscribe → 409 with the existing id
    const dup = await post("/api/rss/subscribe", { url: mainUrl });
    expect(dup.status).toBe(409);
  });

  it("subscribe rejects an unfetchable feed inline (422) and bad input (400)", async () => {
    currentActor = admin;
    expect((await post("/api/rss/subscribe", { url: "https://feed.test/missing.xml" })).status).toBe(422);
    expect((await post("/api/rss/subscribe", { url: "not-a-url" })).status).toBe(400);
  });

  it("a feed over the size cap is refused with a code the reader can explain", async () => {
    currentActor = admin;
    const res = await post("/api/rss/subscribe", { url: "https://feed.test/huge.xml" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "feed_too_large" });
  });

  // ── B. the fetch effect: staging rows, not nodes ──────────────────────────
  it("fetch lands items in rss_staging: no nodes, no events, no inbox arrivals", async () => {
    currentActor = admin;
    const { id: mainSourceId } = await subscribeFresh([mkItem(1, "a"), mkItem(2, "a")]);
    const evBefore = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM domain_events WHERE workspace_id = $1`, [WS]);
    await drainFetchFor(mainSourceId);
    const evAfter = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM domain_events WHERE workspace_id = $1`, [WS]);
    // The internet passing by is not a change to your knowledge.
    expect(evAfter.rows[0]!.n).toBe(evBefore.rows[0]!.n);

    const items = (await (await get(`/api/rss/items?source=${mainSourceId}`)).json()) as ItemList;
    expect(items.items).toHaveLength(2);
    expect(items.items.every((it) => !it.seen && it.saved_node_id === null)).toBe(true);

    // Staging shape: sanitized body, no node behind it.
    const row = await q<{ body: string; saved_node_id: string | null }>(
      `SELECT body, saved_node_id FROM rss_staging WHERE id = $1`, [items.items[0]!.id]);
    expect(row.rows[0]!.body).toContain("Body of article");
    expect(row.rows[0]!.body).not.toContain("<script>");
    const noNode = await q(
      `SELECT 1 FROM content_nodes n
        JOIN node_attributes a ON a.node_id = n.id AND a.key = $2 AND a.value = $1
       WHERE n.hidden`,
      [mainSourceId, K.source]);
    expect(noNode.rows).toHaveLength(0);

    // Source bookkeeping landed.
    const lf = await q<{ last_fetched_at: Date | null; etag: string | null }>(
      `SELECT last_fetched_at, etag FROM rss_subscriptions WHERE id = $1`, [mainSourceId]);
    expect(lf.rows[0]?.last_fetched_at).toBeTruthy();
    expect(lf.rows[0]?.etag).toBeTruthy();
  });

  it("guid dedup across two fetches: the second run creates nothing new for old guids", async () => {
    currentActor = admin;
    const { id: mainSourceId, url: mainUrl } = await fetchedSource([mkItem(1, "a"), mkItem(2, "a")]);
    FEEDS.set(mainUrl, feedOf([mkItem(1, "a"), mkItem(2, "a"), mkItem(3, "b")])); // 2 old + 1 new
    const res = await post(`/api/rss/sources/${mainSourceId}/refresh`);
    expect(res.status).toBe(200);
    await drainFetchFor(mainSourceId);

    const items = (await (await get(`/api/rss/items?source=${mainSourceId}`)).json()) as ItemList;
    expect(items.items).toHaveLength(3); // not 5
    const guids = await q<{ n: string }>(
      `SELECT count(DISTINCT guid)::text AS n FROM rss_staging WHERE subscription_id = $1`, [mainSourceId]);
    expect(Number(guids.rows[0]!.n)).toBe(3);
  });

  it("the backfill window: items published >30d ago arrive pre-seen (no unseen debt on subscribe)", async () => {
    currentActor = admin;
    const url = `https://feed.test/backfill-${stamp}.xml`;
    FEEDS.set(url, feedOf([
      mkItem(1, "bf"),
      mkItem(2, "bf", { publishedAt: new Date(Date.now() - 40 * 86_400_000).toISOString() }),
    ], `Backfill Feed ${stamp}`));
    const sub = (await (await post("/api/rss/subscribe", { url })).json()) as { id: string };
    await drainFetchFor(sub.id);

    const all = (await (await get(`/api/rss/items?source=${sub.id}`)).json()) as ItemList;
    expect(all.items).toHaveLength(2);
    const unseen = (await unseenList(sub.id));
    expect(unseen.items).toHaveLength(1);
    expect(unseen.items[0]!.title).toContain("bf 1");
  });

  it("items list paginates: limit + next_cursor walk the whole set without overlap", async () => {
    currentActor = admin;
    const { id: mainSourceId } = await fetchedSource([mkItem(1, "a"), mkItem(2, "a"), mkItem(3, "b")]);
    const first = (await (await get(`/api/rss/items?source=${mainSourceId}&limit=2`)).json()) as ItemList;
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).toBeTruthy();
    const second = (await (await get(
      `/api/rss/items?source=${mainSourceId}&limit=2&cursor=${encodeURIComponent(first.next_cursor!)}`)).json()) as ItemList;
    expect(second.items).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    const ids = new Set([...first.items, ...second.items].map((i) => i.id));
    expect(ids.size).toBe(3);
    expect((await get(`/api/rss/items?cursor=garbage`)).status).toBe(400);
  });

  it("the scheduler sweep only enqueues DUE sources (fresh fetch → not due)", async () => {
    // A source just fetched → last_fetched is now → not due at the
    // default 60min interval, so the sweep must not re-file its intent.
    currentActor = admin;
    const { id: mainSourceId } = await fetchedSource();
    await enqueueDueRssFetches();
    const pending = await q(
      `SELECT 1 FROM outbox WHERE dedup_key = $1 AND status = 'pending'`, [`rss_fetch:${mainSourceId}`]);
    expect(pending.rows).toHaveLength(0);
  });

  describe("a source that cannot be fetched backs off instead of being retried every tick", () => {
    const outboxRows = (sourceId: string) => q<{ id: string; status: string; attempts: number; next_attempt_at: Date }>(
      `SELECT id::text, status, attempts, next_attempt_at FROM outbox WHERE dedup_key = $1 ORDER BY outbox.id`,
      [`rss_fetch:${sourceId}`]);
    /** Run the row until it has one more failed attempt or went dead (drainOutbox is a no-op while another drain is in flight, so poll). */
    async function drainOneAttempt(sourceId: string, outboxId: string) {
      const start = (await outboxRows(sourceId)).rows.find((r) => r.id === outboxId)!;
      for (let i = 0; i < 100; i++) {
        await drainOutbox({ id: outboxId });
        const row = (await outboxRows(sourceId)).rows.find((r) => r.id === outboxId)!;
        if (row.status !== "pending" || row.attempts > start.attempts) return;
        await new Promise((res) => setTimeout(res, 30));
      }
      throw new Error("attempt never ran");
    }
    /** A subscribed feed whose server stops answering; its first fetch attempt has failed once. */
    async function failingSource() {
      const source = await subscribeFresh([mkItem(1, "bo")]);
      const feed = FEEDS.get(source.url)!;
      FEEDS.delete(source.url);
      const first = (await outboxRows(source.id)).rows.at(-1)!;
      await drainOneAttempt(source.id, first.id);
      return { ...source, feed, outboxId: first.id };
    }

    it("the next tick does not pull a failed fetch forward or reset its attempts", async () => {
      currentActor = admin;
      const src = await failingSource();
      const before = (await outboxRows(src.id)).rows;
      expect(before).toHaveLength(1);
      expect(before[0]!.attempts).toBe(1);
      await enqueueDueRssFetches();
      await enqueueDueRssFetches();
      const after = (await outboxRows(src.id)).rows;
      expect(after).toHaveLength(1);
      expect(after[0]!.attempts).toBe(1);
      expect(after[0]!.next_attempt_at.getTime()).toBeGreaterThan(Date.now());
    });

    it("the wait grows with each failure", async () => {
      currentActor = admin;
      const src = await failingSource();
      const waitAfter = async () => (await outboxRows(src.id)).rows[0]!.next_attempt_at.getTime() - Date.now();
      const first = await waitAfter();
      await q(`UPDATE outbox SET next_attempt_at = now() WHERE id = $1::bigint`, [src.outboxId]);
      await enqueueDueRssFetches();
      await drainOneAttempt(src.id, src.outboxId);
      expect((await outboxRows(src.id)).rows[0]!.attempts).toBe(2);
      expect(await waitAfter()).toBeGreaterThan(first);
    });

    it("a source whose retries ran out is left alone by the scheduler, and says why", async () => {
      currentActor = admin;
      const src = await failingSource();
      await q(`UPDATE outbox SET attempts = max_attempts - 1, next_attempt_at = now() WHERE id = $1::bigint`, [src.outboxId]);
      await drainOneAttempt(src.id, src.outboxId);
      expect((await outboxRows(src.id)).rows.map((r) => r.status)).toEqual(["dead"]);
      await enqueueDueRssFetches();
      expect((await outboxRows(src.id)).rows.map((r) => r.status)).toEqual(["dead"]);
      const list = (await (await get(`/api/rss/sources`)).json()) as SourceList;
      expect(list.sources.find((s) => s.id === src.id)?.last_error).toBeTruthy();
    });

    it("a source whose retries ran out is tried again after the rest period, not before", async () => {
      currentActor = admin;
      const src = await failingSource();
      await q(`UPDATE outbox SET attempts = max_attempts - 1, next_attempt_at = now() WHERE id = $1::bigint`, [src.outboxId]);
      await drainOneAttempt(src.id, src.outboxId);
      const rest = (hours: number) => q(`UPDATE outbox SET updated_at = now() - ($2::text || ' hours')::interval WHERE id = $1::bigint`, [src.outboxId, String(hours)]);
      await rest(DEAD_SOURCE_REST_HOURS - 1);
      await enqueueDueRssFetches();
      expect((await outboxRows(src.id)).rows.some((r) => r.status === "pending")).toBe(false);
      await rest(DEAD_SOURCE_REST_HOURS + 1);
      await enqueueDueRssFetches();
      expect((await outboxRows(src.id)).rows.some((r) => r.status === "pending")).toBe(true);
    });

    it("a manual refresh still fetches at once, and one success restores the normal schedule", async () => {
      currentActor = admin;
      const src = await failingSource();
      await q(`UPDATE outbox SET attempts = max_attempts - 1, next_attempt_at = now() WHERE id = $1::bigint`, [src.outboxId]);
      await drainOneAttempt(src.id, src.outboxId);
      FEEDS.set(src.url, src.feed);
      expect((await post(`/api/rss/sources/${src.id}/refresh`)).status).toBe(200);
      await drainFetchFor(src.id);
      const source = await findSource(WS, { id: src.id });
      expect(source?.last_error).toBeNull();
      expect(source?.last_fetched_at).toBeTruthy();
      // The old dead row is history now; when the interval passes the source is due again.
      await q(`UPDATE outbox SET updated_at = now() - interval '3 hours' WHERE dedup_key = $1 AND status = 'dead'`, [`rss_fetch:${src.id}`]);
      await seedQ(`UPDATE rss_subscriptions SET last_fetched_at = now() - interval '2 hours' WHERE id = $1::uuid`, [src.id]);
      await enqueueDueRssFetches();
      expect((await outboxRows(src.id)).rows.some((r) => r.status === "pending")).toBe(true);
    });

    it("a manual refresh pulls a backed-off fetch forward", async () => {
      currentActor = admin;
      const src = await failingSource();
      FEEDS.set(src.url, src.feed);
      expect((await post(`/api/rss/sources/${src.id}/refresh`)).status).toBe(200);
      await drainFetchFor(src.id);
      expect((await findSource(WS, { id: src.id }))?.last_error).toBeNull();
    });
  });

  // ── C. read policy (iron law) ──────────────────────────────────────────────
  let secretSourceId = "";
  let secretItemId = "";

  it("a restricted source's articles leak through NO list, single read, or unseen count", async () => {
    currentActor = admin;
    // Source in a space only the admin is in; its items are gated THROUGH it.
    const secretSpace = await adminOnlySpace(WS, `rss-secret-${stamp}`, [admin.id]);

    const url = `https://feed.test/secret-${stamp}.xml`;
    FEEDS.set(url, feedOf([mkItem(1, "sec")], `Secret Feed ${stamp}`));
    const sub = (await (await post("/api/rss/subscribe", { url })).json()) as { id: string };
    secretSourceId = sub.id;
    await putInSpace(sub.id, secretSpace);
    await drainFetchFor(sub.id);

    // Admin sees it everywhere.
    currentActor = admin;
    const adminItems = (await (await get(`/api/rss/items?source=${sub.id}`)).json()) as ItemList;
    expect(adminItems.items).toHaveLength(1);
    secretItemId = adminItems.items[0]!.id;
    const adminSources = (await (await get(`/api/rss/sources`)).json()) as SourceList;
    expect(adminSources.sources.find((s) => s.id === sub.id)?.unseen).toBe(1);

    // Viewer: items list empty, single read 404s, no source row, no count.
    currentActor = viewer;
    const vItems = (await (await get(`/api/rss/items?source=${sub.id}`)).json()) as ItemList;
    expect(vItems.items).toHaveLength(0);
    expect((await get(`/api/rss/items/${secretItemId}`)).status).toBe(404);
    const vSources = (await (await get(`/api/rss/sources`)).json()) as SourceList;
    expect(vSources.sources.some((s) => s.id === sub.id)).toBe(false);

    // …and the viewer's writes bounce too: seen 404s, save 404s.
    expect((await post(`/api/rss/items/${secretItemId}/seen`)).status).toBe(404);
    expect((await post(`/api/rss/items/${secretItemId}/save`)).status).toBe(404);

    // Bearer token whose agent is in no space: nothing at all.
    currentActor = emptyToken;
    const tItems = (await (await get(`/api/rss/items`)).json()) as ItemList;
    expect(tItems.items).toHaveLength(0);
    currentActor = admin;
  });

  // ── D. seen: plain reversible buffer state ─────────────────────
  it("seen is reversible buffer state — no domain event, unseen filter follows", async () => {
    currentActor = admin;
    const { id: mainSourceId } = await fetchedSource();
    const items = (await unseenList(mainSourceId));
    expect(items.items.length).toBeGreaterThanOrEqual(2);
    const first = items.items[0]!;

    const evBefore = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM domain_events WHERE workspace_id = $1`, [WS]);
    expect((await post(`/api/rss/items/${first.id}/seen`)).status).toBe(200);
    const evAfter = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM domain_events WHERE workspace_id = $1`, [WS]);
    expect(evAfter.rows[0]!.n).toBe(evBefore.rows[0]!.n); // skimming past is a non-event

    const unseenAfter = (await unseenList(mainSourceId));
    expect(unseenAfter.items).toHaveLength(items.items.length - 1);

    // Reversible: seen:false puts it back.
    expect((await post(`/api/rss/items/${first.id}/seen`, { seen: false })).status).toBe(200);
    const back = (await unseenList(mainSourceId));
    expect(back.items).toHaveLength(items.items.length);
  });

  // ── E. save: THE node-creating moment ──────────────────────────────────────
  it("save materializes a visible node via the spine, authored by the human, with tags + provenance", async () => {
    currentActor = admin;
    const tagTitle = `rss-auto-${stamp}-${randomUUID().slice(0, 8)}`;
    await autoTagNamed(tagTitle);
    const { id: mainSourceId } = await fetchedSource(undefined, { auto_tag: tagTitle });
    const items = (await (await get(`/api/rss/items?source=${mainSourceId}`)).json()) as ItemList;
    const target = items.items.find((i) => i.url)!;

    const res = await post(`/api/rss/items/${target.id}/save`);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { node_id: string };
    const savedNodeId = body.node_id;

    // Node shape: visible, at the feed's save default (no parent: a source is not a note), the staging body.
    const node = await q<{ hidden: boolean; parent_id: string; markdown: string; source_type: string }>(
      `SELECT hidden, parent_id, markdown, source_type FROM content_nodes WHERE id = $1 AND deleted_at IS NULL`,
      [savedNodeId]);
    expect(node.rows[0]).toMatchObject({ hidden: false, parent_id: null, source_type: "rss" });
    expect(node.rows[0]!.markdown).toContain("Body of article");

    // Authored by the HUMAN (actor_type user), not a feed pseudo-agent —
    // so it does NOT enter the inbox governance queue.
    const ev = await q<{ actor_type: string; actor_id: string }>(
      `SELECT actor_type, actor_id FROM domain_events
        WHERE target_id = $1 AND event_type = 'NODE_CREATED' ORDER BY id DESC LIMIT 1`, [savedNodeId]);
    expect(ev.rows[0]).toMatchObject({ actor_type: "user", actor_id: admin.id });

    // Source tags ride on (the auto-tag).
    const tags = await q<{ title: string }>(
      `SELECT t.title FROM node_tags nt JOIN content_nodes t ON t.id = nt.tag_id WHERE nt.node_id = $1`,
      [savedNodeId]);
    const titles = tags.rows.map((r) => r.title);
    expect(titles).toContain(tagTitle);

    // Provenance attrs.
    const attrs = await q<{ key: string; value: string }>(
      `SELECT key, value FROM node_attributes WHERE node_id = $1`, [savedNodeId]);
    const map = Object.fromEntries(attrs.rows.map((r) => [r.key, r.value]));
    expect(map[K.guid]).toBeTruthy();
    expect(map[K.source]).toBe(mainSourceId);
    expect(map[K.itemUrl]).toBe(target.url);

    // The staging row points at its note; it reads as seen for the saver only
    // (seen is per person, migration 092).
    const staged = await q<{ saved_node_id: string }>(
      `SELECT saved_node_id FROM rss_staging WHERE id = $1`, [target.id]);
    expect(staged.rows[0]!.saved_node_id).toBe(savedNodeId);
    const mine = await q<{ seen: boolean }>(
      `SELECT seen FROM rss_seen WHERE staging_id = $1 AND actor_id = $2`, [target.id, admin.id]);
    expect(mine.rows[0]?.seen).toBe(true);

    // Idempotent: saving again returns the same node, creates nothing.
    const again = await post(`/api/rss/items/${target.id}/save`);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { node_id: string; already_saved: boolean })).toMatchObject({
      node_id: savedNodeId, already_saved: true,
    });
  });

  it("save honors a client-minted node id (offline replay convergence)", async () => {
    currentActor = admin;
    const { id: mainSourceId } = await fetchedSource();
    const items = (await (await get(`/api/rss/items?source=${mainSourceId}`)).json()) as ItemList;
    const target = items.items.find((i) => !i.saved_node_id)!;
    const minted = randomUUID();
    const res = await post(`/api/rss/items/${target.id}/save`, { node_id: minted });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { node_id: string }).node_id).toBe(minted);
    // Replay (the queued request fires twice): converges, no second node.
    const replay = await post(`/api/rss/items/${target.id}/save`, { node_id: minted });
    expect(replay.status).toBe(200);
    const nodes = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM content_nodes WHERE id = $1`, [minted]);
    expect(Number(nodes.rows[0]!.n)).toBe(1);
  });

  // (Removed: "save carries only the source tags the saver may apply" — it
  // tested a tag apply policy; tags carry no permission under spaces.)

  it("per-source embed opt-in fires at SAVE, not at ingest", async () => {
    currentActor = admin;
    const embedCount = async () => Number((await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM outbox WHERE effect_kind = 'embed' AND workspace_id = $1`, [WS],
    )).rows[0]!.n);

    const c0 = await embedCount();
    const url = `https://feed.test/embed-${stamp}.xml`;
    FEEDS.set(url, feedOf([mkItem(1, "em")], `Embed Feed ${stamp}`));
    const sub = (await (await post("/api/rss/subscribe", { url, embed: true })).json()) as { id: string };
    await drainFetchFor(sub.id);

    // Ingest of an opted-in source enqueues NOTHING (compute belongs to what
    // you chose, not to what arrived). Count-delta, not time-window: this
    // file re-runs back-to-back on a shared DB.
    expect(await embedCount()).toBe(c0);
    const items = (await (await get(`/api/rss/items?source=${sub.id}`)).json()) as ItemList;
    expect(items.items).toHaveLength(1);

    const saved = (await (await post(`/api/rss/items/${items.items[0]!.id}/save`)).json()) as { node_id: string };
    const embeds = await q<{ status: string }>(
      `SELECT status FROM outbox WHERE effect_kind = 'embed' AND dedup_key = $1`,
      [`embed:${saved.node_id}`]);
    expect(embeds.rows).toHaveLength(1);
    expect(await embedCount()).toBe(c0 + 1);
  });

  // ── F. fulltext ─────────────────────────────────────────────────────────────
  it("fulltext replaces the staging body in place — no node, no event; 409 once saved", async () => {
    currentActor = admin;
    __setPageFetchForTests(async () =>
      `<html><body><nav>chrome</nav><article><h1>Full</h1><p>The whole story, recovered.</p></article></body></html>`);
    const { sourceId: mainSourceId, target: { id: savedItemId } } = await savedArticle();
    const items = (await (await get(`/api/rss/items?source=${mainSourceId}`)).json()) as ItemList;
    const target = items.items.find((i) => i.url && !i.saved_node_id)!;
    const res = await post(`/api/rss/items/${target.id}/fulltext`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { body: string };
    expect(body.body).toContain("The whole story");
    expect(body.body).not.toContain("chrome");

    const single = (await (await get(`/api/rss/items/${target.id}`)).json()) as { body: string };
    expect(single.body).toContain("The whole story");
    // Buffer state: no version, no event for a staging id.
    const ev = await q(`SELECT 1 FROM domain_events WHERE target_id = $1`, [target.id]);
    expect(ev.rows).toHaveLength(0);

    // Already saved → the note owns the content now.
    expect((await post(`/api/rss/items/${savedItemId}/fulltext`)).status).toBe(409);
  });

  // ── F2. a link inside an article ───────────────────────────────────────────
  it("a link to the same source's article opens in the reader: held, or fetched once; anything else is the browser's", async () => {
    currentActor = admin;
    const writer = `https://writer.test/@ann-${stamp}`;
    const url = `https://feed.test/writer-${stamp}.xml`;
    FEEDS.set(url, feedOf([1, 2].map((n) => mkItem(n, `wr${stamp}`, { url: `${writer}/a${n}` })), `Writer ${stamp}`));
    const sub = (await (await post("/api/rss/subscribe", { url })).json()) as { id: string };
    await drainFetchFor(sub.id);
    const sources = (await (await get("/api/rss/sources")).json()) as { sources: Array<{ id: string; article_prefix: string | null }> };
    expect(sources.sources.find((x) => x.id === sub.id)!.article_prefix).toBe(`${writer}/`);
    const items = ((await (await get(`/api/rss/items?source=${sub.id}`)).json()) as ItemList).items;
    const from = items.find((i) => i.url === `${writer}/a1`)!;
    const second = items.find((i) => i.url === `${writer}/a2`)!;
    const link = async (to: string) => (await get(`/api/rss/items/${from.id}/link?url=${encodeURIComponent(to)}`)).json();

    expect(await link(`${writer}/a2#comments`)).toEqual({ kind: "item", id: second.id });
    const fetched: string[] = [];
    __setPageFetchForTests(async (page) => {
      fetched.push(page);
      return page.endsWith("/older")
        ? `<html><head><title>An older one</title></head><body><nav>chrome</nav><article><p>Written last year.</p></article></body></html>`
        : `<html><body></body></html>`;
    });
    try {
      const older = await link(`${writer}/older`) as { kind: string; title: string; body: string; url: string };
      expect(older).toMatchObject({ kind: "page", title: "An older one", url: `${writer}/older` });
      expect(older.body).toContain("Written last year.");
      expect(older.body).not.toContain("chrome");
      expect(await link(`${writer}/empty`)).toEqual({ kind: "failed" });
      // Another writer on the same platform, another site, not a web address: the browser, and nothing fetched.
      expect(await link(`https://writer.test/@bob-${stamp}/x`)).toEqual({ kind: "outside" });
      expect(await link("https://elsewhere.test/a")).toEqual({ kind: "outside" });
      expect(await link("javascript:alert(1)")).toEqual({ kind: "outside" });
      expect(fetched).toEqual([`${writer}/older`, `${writer}/empty`]);
    } finally { __setPageFetchForTests(null); }
    // Nothing kept: no staging row for the fetched page.
    expect((await q(`SELECT 1 FROM rss_staging WHERE url = $1`, [`${writer}/older`])).rowCount).toBe(0);
    expect((await get(`/api/rss/items/${from.id}/link`)).status).toBe(400);
  });

  // ── G. retention sweep ──────────────────────────────────────────────────────
  it("seen is per person: one reader marking items seen leaves them unseen for another", async () => {
    currentActor = admin;
    const { id: mainSourceId } = await fetchedSource();
    const before = (await unseenList(mainSourceId));
    expect(before.items.length).toBeGreaterThan(0);
    const editor = { ...admin, id: `${admin.id}-peer`, role: "editor" };
    currentActor = editor;
    const peerBefore = ((await unseenList(mainSourceId))).items.length;
    currentActor = admin;
    for (const it of before.items) await post(`/api/rss/items/${it.id}/seen`);
    expect(((await unseenList(mainSourceId))).items).toHaveLength(0);
    currentActor = editor;
    expect(((await unseenList(mainSourceId))).items).toHaveLength(peerBefore);
    currentActor = admin;
  });

  // ── 聲音: person or media, guessed at subscribe, always changeable ─────────
  it("a feed's voice is guessed when subscribing, can be chosen up front, and can be changed", async () => {
    currentActor = admin;
    const voiceOf = async (id: string) => ((await (await get(`/api/rss/sources`)).json()) as { sources: Array<{ id: string; voice: string }> }).sources.find((x) => x.id === id)!.voice;
    const items = [mkItem(1, "v", { author: "Alice Chen" }), mkItem(2, "v", { author: "Alice Chen" }), mkItem(3, "v", { author: "Alice Chen" })];

    const guessed = await subscribeFresh(items); // one author on every article
    expect(await voiceOf(guessed.id)).toBe("person");

    const url = `https://feed.test/many-${stamp}-${randomUUID().slice(0, 8)}.xml`;
    FEEDS.set(url, feedOf([mkItem(1, "w", { author: "A" }), mkItem(2, "w", { author: "B" }), mkItem(3, "w", { author: "C" })]));
    const media = (await (await post("/api/rss/subscribe", { url })).json()) as { id: string };
    expect(await voiceOf(media.id)).toBe("media");

    const url2 = `https://feed.test/chosen-${stamp}-${randomUUID().slice(0, 8)}.xml`;
    FEEDS.set(url2, feedOf([mkItem(1, "x", { author: "A" }), mkItem(2, "x", { author: "B" })]));
    const chosen = (await (await post("/api/rss/subscribe", { url: url2, voice: "person" })).json()) as { id: string };
    expect(await voiceOf(chosen.id)).toBe("person");

    // 「聲音」 lists only the people's feeds.
    await drainFetchFor(guessed.id);
    await drainFetchFor(chosen.id);
    const people = (await (await get(`/api/rss/items?voice=person&limit=100`)).json()) as ItemList;
    expect(people.items.length).toBeGreaterThan(0);
    expect(people.items.every((i) => i.source_id === guessed.id || i.source_id === chosen.id)).toBe(true);

    const patched = await app.request(`/api/rss/sources/${guessed.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voice: "media" }) });
    expect(patched.status).toBe(200);
    expect(await voiceOf(guessed.id)).toBe("media");
    const bad = await app.request(`/api/rss/sources/${guessed.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voice: "robot" }) });
    expect(bad.status).toBe(400);
  });

  // ── 顯示方式: text / image / video per feed ───────────────────────────────
  it("a feed's display mode defaults to text, can be changed, and the list carries what plays", async () => {
    currentActor = admin;
    const { id } = await fetchedSource([mkItem(1, "dm", { contentHtml: '<p>clip</p><video controls src="https://cdn.test/clip.mp4"></video>' }), mkItem(2, "dm")]);
    const modeOf = async () => ((await (await get(`/api/rss/sources`)).json()) as { sources: Array<{ id: string; display_mode: string }> }).sources.find((x) => x.id === id)!.display_mode;
    expect(await modeOf()).toBe("text");
    const patch = (body: unknown) => app.request(`/api/rss/sources/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const ok = await patch({ display_mode: "video" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { display_mode: string }).display_mode).toBe("video");
    expect(await modeOf()).toBe("video");
    expect((await patch({ display_mode: "image" })).status).toBe(200);
    expect(await modeOf()).toBe("image");
    expect((await patch({ display_mode: "audio" })).status).toBe(400);
    const list = (await (await get(`/api/rss/items?source=${id}`)).json()) as { items: Array<{ title: string; media: { kind: string; url: string } | null }> };
    expect(list.items.find((i) => i.title.includes("dm 1"))!.media).toEqual({ kind: "video", url: "https://cdn.test/clip.mp4" });
    expect(list.items.find((i) => i.title.includes("dm 2"))!.media).toBeNull();
  });

  // ── 少看這種: a person's own, time-limited mutes ───────────────────────────
  it("a keyword mute hides matching titles from the caller's list and counts only, then ends by itself", async () => {
    currentActor = admin;
    const { id } = await fetchedSource([mkItem(1, "mu"), mkItem(2, "mu")]);
    const titles = async () => ((await (await get(`/api/rss/items?source=${id}`)).json()) as ItemList).items.map((i) => i.title);
    const unseen = async () => ((await (await get(`/api/rss/sources`)).json()) as SourceList).sources.find((s) => s.id === id)!.unseen;
    expect(await titles()).toHaveLength(2);
    expect(await unseen()).toBe(2);

    const made = await post(`/api/rss/mutes`, { keyword: "  MU   1 " });
    expect(made.status).toBe(201);
    const muteId = ((await made.json()) as { id: string }).id;
    expect((await titles()).some((t) => t.includes("mu 1"))).toBe(false);
    expect(await titles()).toHaveLength(1);
    expect(await unseen()).toBe(1);
    // Nothing was deleted, and an article opened on purpose still opens.
    const row = await q<{ n: string }>(`SELECT count(*)::text AS n FROM rss_staging WHERE subscription_id = $1`, [id]);
    expect(row.rows[0]!.n).toBe("2");

    // Only the caller's list changes: another person's mute does not touch it.
    await seedQ(`DELETE FROM rss_mutes WHERE id = $1`, [muteId]);
    await seedQ(`INSERT INTO rss_mutes (workspace_id, actor_id, keyword, expires_at) VALUES ($1, 'someone-else', 'Article', now() + interval '1 day')`, [WS]);
    expect(await titles()).toHaveLength(2);
    await seedQ(`DELETE FROM rss_mutes WHERE actor_id = 'someone-else'`);
    const again = await post(`/api/rss/mutes`, { keyword: "mu 1" });
    const againId = ((await again.json()) as { id: string }).id;
    expect(againId).not.toBe(muteId);

    // It lists, with no feed for a keyword.
    const listed = (await (await get(`/api/rss/mutes`)).json()) as { mutes: Array<{ id: string; keyword: string | null; source_id: string | null }> };
    expect(listed.mutes.find((m) => m.id === againId)).toMatchObject({ keyword: "mu 1", source_id: null });

    // A mute that ran out is inert.
    await seedQ(`UPDATE rss_mutes SET expires_at = now() - interval '1 minute' WHERE id = $1`, [againId]);
    expect(await titles()).toHaveLength(2);
    expect((await (await get(`/api/rss/mutes`)).json() as { mutes: unknown[] }).mutes.some((m) => (m as { id: string }).id === againId)).toBe(false);
  });

  it("a feed mute hides the whole feed for the caller, can be ended early, and is the caller's own", async () => {
    currentActor = admin;
    const { id } = await fetchedSource([mkItem(1, "fm"), mkItem(2, "fm")]);
    const count = async () => ((await (await get(`/api/rss/items?source=${id}`)).json()) as ItemList).items.length;
    const made = await post(`/api/rss/mutes`, { source_id: id });
    expect(made.status).toBe(201);
    const muteId = ((await made.json()) as { id: string }).id;
    expect(await count()).toBe(0);
    const listed = (await (await get(`/api/rss/mutes`)).json()) as { mutes: Array<{ id: string; source_title: string | null; expires_at: string }> };
    const mine = listed.mutes.find((m) => m.id === muteId)!;
    expect(mine.source_title).toBeTruthy();
    const days = (Date.parse(mine.expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);

    // Someone else's mute is not the caller's to end; their own is.
    const theirs = (await seedQ<{ id: string }>(
      `INSERT INTO rss_mutes (workspace_id, actor_id, subscription_id, expires_at) VALUES ($1, 'someone-else', $2, now() + interval '1 day') RETURNING id::text`, [WS, id])).rows[0]!.id;
    expect((await app.request(`/api/rss/mutes/${theirs}`, { method: "DELETE" })).status).toBe(404);
    expect((await q(`SELECT 1 FROM rss_mutes WHERE id = $1`, [theirs])).rowCount).toBe(1);
    await seedQ(`DELETE FROM rss_mutes WHERE id = $1`, [theirs]);
    expect(await count()).toBe(0);
    expect((await app.request(`/api/rss/mutes/${muteId}`, { method: "DELETE" })).status).toBe(200);
    expect(await count()).toBe(2);
  });

  it("refuses a mute with neither or both targets, an empty or over-long keyword, and an unknown feed", async () => {
    currentActor = admin;
    expect((await post(`/api/rss/mutes`, {})).status).toBe(400);
    expect((await post(`/api/rss/mutes`, { keyword: "a", source_id: randomUUID() })).status).toBe(400);
    expect((await post(`/api/rss/mutes`, { keyword: "   " })).status).toBe(422);
    expect((await post(`/api/rss/mutes`, { keyword: "x".repeat(81) })).status).toBe(422);
    expect((await post(`/api/rss/mutes`, { source_id: randomUUID() })).status).toBe(404);
    expect((await post(`/api/rss/mutes`, { keyword: "ok", days: 99 })).status).toBe(400);
  });

  it("unseen ages to seen: default window + per-source auto_dismiss_days override", async () => {
    currentActor = admin;
    const url = `https://feed.test/aging-${stamp}.xml`;
    FEEDS.set(url, feedOf([mkItem(1, "ag"), mkItem(2, "ag")], `Aging Feed ${stamp}`));
    const sub = (await (await post("/api/rss/subscribe", { url, auto_dismiss_days: 7 })).json()) as { id: string };
    await drainFetchFor(sub.id);

    const items = (await (await get(`/api/rss/items?source=${sub.id}`)).json()) as ItemList;
    const [first, second] = items.items;
    // Backdate ONE past the source's 7-day override; its sibling stays young.
    await q(`UPDATE rss_staging SET fetched_at = now() - interval '8 days' WHERE id = $1`, [first!.id]);

    await sweepRssStaging();
    const after = (await (await get(`/api/rss/items?source=${sub.id}`)).json()) as ItemList;
    expect(after.items.find((i) => i.id === first!.id)!.seen).toBe(true);
    expect(after.items.find((i) => i.id === second!.id)!.seen).toBe(false);

    // Default window: a source WITHOUT the override ages at UNSEEN_AGE_DAYS.
    const { id: mainSourceId } = await fetchedSource();
    const mainItems = (await unseenList(mainSourceId));
    expect(mainItems.items.length).toBeGreaterThan(0);
    {
      // An explicit personal "unseen again" outranks aging; start from none.
      await seedQ(`DELETE FROM rss_seen WHERE staging_id = $1`, [mainItems.items[0].id]);
      await q(`UPDATE rss_staging SET fetched_at = now() - make_interval(days => $2::int) WHERE id = $1`,
        [mainItems.items[0].id, UNSEEN_AGE_DAYS + 1]);
      await sweepRssStaging();
      const aged = (await (await get(`/api/rss/items?source=${mainSourceId}`)).json()) as ItemList;
      expect(aged.items.find((i) => i.id === mainItems.items[0]!.id)!.seen).toBe(true);
    }
  });

  it("long-seen rows tombstone beyond the per-source floor; saved rows exempt; tombstones survive as guids", async () => {
    currentActor = admin;
    // A dedicated source with floor+5 old seen rows, one of them saved.
    const url = `https://feed.test/ttl-${stamp}.xml`;
    FEEDS.set(url, feedOf([], `TTL Feed ${stamp}`));
    const sub = (await (await post("/api/rss/subscribe", { url })).json()) as { id: string };
    await drainFetchFor(sub.id);

    const total = KEEP_FLOOR_PER_SOURCE + 5;
    const oldSeen = `now() - make_interval(days => ${TOMBSTONE_AFTER_SEEN_DAYS + 10})`;
    for (let i = 0; i < total; i++) {
      // published_at ordered: item 0 newest … item total-1 oldest.
      await q(
        `INSERT INTO rss_staging (workspace_id, subscription_id, guid, title, body, published_at, fetched_at, seen_at)
         VALUES ($1, $2, $3, $4, 'body', now() - make_interval(hours => $5::int), ${oldSeen}, ${oldSeen})`,
        [WS, sub.id, `ttl-${stamp}-${i}`, `TTL ${i}`, i + 1]);
    }
    // Mark the OLDEST row saved — beyond the floor, but exempt.
    const oldest = await q<{ id: string }>(
      `SELECT id FROM rss_staging WHERE subscription_id = $1 AND guid = $2`, [sub.id, `ttl-${stamp}-${total - 1}`]);
    const keptNote = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1, 'rss', 'content', 'TTL saved', $2, '') RETURNING id`, [WS, `ttl-saved-${stamp}`])).rows[0]!.id;
    await q(`UPDATE rss_staging SET saved_node_id = $2 WHERE id = $1`, [oldest.rows[0]!.id, keptNote]);

    // The sweep is global (a shared test DB may age other runs' leftovers too)
    // — assert the exact carve on THIS source below, not the global count.
    const swept = await sweepRssStaging();
    expect(swept.tombstoned).toBeGreaterThanOrEqual(4); // 5 beyond the floor, minus the saved one

    const live = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM rss_staging WHERE subscription_id = $1 AND tombstoned_at IS NULL`, [sub.id]);
    expect(Number(live.rows[0]!.n)).toBe(total - 4);
    // Tombstones keep the guid but lose the body.
    const stones = await q<{ body: string; guid: string }>(
      `SELECT body, guid FROM rss_staging WHERE subscription_id = $1 AND tombstoned_at IS NOT NULL`, [sub.id]);
    expect(stones.rows).toHaveLength(4);
    expect(stones.rows.every((r) => r.body === "")).toBe(true);

    // A tombstoned guid can't be re-ingested (the resurrection guard)…
    const stoneGuid = stones.rows[0]!.guid;
    const n = Number(stoneGuid.split("-").pop());
    FEEDS.set(url, feedOf([mkItem(n, "ttl-re", { guid: stoneGuid })], `TTL Feed ${stamp}`));
    await post(`/api/rss/sources/${sub.id}/refresh`);
    await drainFetchFor(sub.id);
    const still = await q<{ n: string }>(
      `SELECT count(*)::text AS n FROM rss_staging WHERE subscription_id = $1 AND guid = $2`, [sub.id, stoneGuid]);
    expect(Number(still.rows[0]!.n)).toBe(1); // the tombstone, nothing new

    // …and a tombstoned item reads 410, never a resurrected body.
    const stoneRow = await q<{ id: string }>(
      `SELECT id FROM rss_staging WHERE subscription_id = $1 AND guid = $2`, [sub.id, stoneGuid]);
    expect((await get(`/api/rss/items/${stoneRow.rows[0]!.id}`)).status).toBe(410);
  });

  // ── H. OPML ────────────────────────────────────────────────────────────────
  it("OPML round-trip: import creates sources, export lists them back", async () => {
    currentActor = admin;
    const { url: mainUrl } = await subscribeFresh([mkItem(1, "a")]);
    const u1 = `https://feed.test/opml-a-${stamp}.xml`;
    const u2 = `https://feed.test/opml-b-${stamp}.xml`;
    const opml = `<?xml version="1.0"?><opml version="2.0"><body>
      <outline type="rss" title="Opml A ${stamp}" xmlUrl="${u1}"/>
      <outline type="rss" title="Opml B ${stamp}" xmlUrl="${u2}"/>
      <outline type="rss" title="Dup of main" xmlUrl="${mainUrl}"/>
    </body></opml>`;
    const res = await post("/api/rss/opml", { opml });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ imported: 2, skipped: 1 });

    const out = await get("/api/rss/opml");
    expect(out.status).toBe(200);
    const xml = await out.text();
    expect(xml).toContain(u1);
    expect(xml).toContain(u2);
    expect(xml).toContain(mainUrl);
  });

  // ── H2. feed URLs and the source rule (depth audit D53) ───────────────────
  it("OPML feed:// URLs are stored as https and fetch (not bad_protocol on every poll)", async () => {
    currentActor = admin;
    const https = `https://feed.test/d53-opml-${stamp}.xml`;
    FEEDS.set(https, feedOf([mkItem(1, "d53o")], `D53 OPML ${stamp}`));
    const opml = `<opml><body><outline title="D53 feed scheme ${stamp}" xmlUrl="feed://feed.test/d53-opml-${stamp}.xml"/></body></opml>`;
    expect(await (await post("/api/rss/opml", { opml })).json()).toMatchObject({ imported: 1, skipped: 0 });

    const list = (await (await get(`/api/rss/sources`)).json()) as { sources: Array<{ id: string; url: string; last_error: string | null }> };
    const src = list.sources.find((s) => s.url === https);
    expect(src).toBeTruthy();
    await drainFetchFor(src!.id);
    const items = (await (await get(`/api/rss/items?source=${src!.id}`)).json()) as ItemList;
    expect(items.items).toHaveLength(1);
    const after = (await (await get(`/api/rss/sources`)).json()) as { sources: Array<{ id: string; last_error: string | null }> };
    expect(after.sources.find((s) => s.id === src!.id)?.last_error).toBeNull();
  });

  it("a feed is one subscription whatever its spelling: trailing slash, host case, feed://", async () => {
    currentActor = admin;
    const url = `https://feed.test/d53-dup-${stamp}/feed/`;
    FEEDS.set(url, feedOf([mkItem(1, "d53d")]));
    const first = await post("/api/rss/subscribe", { url });
    expect(first.status).toBe(201);
    const { id } = (await first.json()) as { id: string };

    const again = await post("/api/rss/subscribe", { url: `https://FEED.test/d53-dup-${stamp}/feed` });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "already_subscribed", id });

    const opml = `<opml><body><outline title="same" xmlUrl="feed://feed.test/d53-dup-${stamp}/feed"/></body></opml>`;
    expect(await (await post("/api/rss/opml", { opml })).json()).toMatchObject({ imported: 0, skipped: 1 });

    // A row stored before normalisation (raw spelling) still blocks a duplicate.
    const legacy = `https://feed.test/d53-legacy-${stamp}/rss/`;
    FEEDS.set(legacy, feedOf([]));
    const sub = (await (await post("/api/rss/subscribe", { url: legacy })).json()) as { id: string };
    await seedQ(`UPDATE rss_subscriptions SET url = $2 WHERE id = $1`,
      [sub.id, `HTTPS://Feed.Test/d53-legacy-${stamp}/rss/#x`]);
    const legacyDup = await post("/api/rss/subscribe", { url: `https://feed.test/d53-legacy-${stamp}/rss` });
    expect(legacyDup.status).toBe(409);
  });

  it("relative item links are resolved against the feed, not left to open on Onden's origin", async () => {
    currentActor = admin;
    const url = `https://feed.test/d53-rel-${stamp}/atom.xml`;
    FEEDS.set(url, feedOf([
      mkItem(1, "d53r", { url: "/posts/1" }),
      mkItem(2, "d53r", { url: "entry-2" }),
      mkItem(3, "d53r", { url: "javascript:alert(1)" }),
    ]));
    const { id } = (await (await post("/api/rss/subscribe", { url })).json()) as { id: string };
    await drainFetchFor(id);
    const items = (await (await get(`/api/rss/items?source=${id}`)).json()) as ItemList;
    expect(items.items.map((it) => it.url).sort()).toEqual([
      "https://feed.test/d53-rel-" + stamp + "/entry-2",
      "https://feed.test/posts/1",
      null,
    ].sort());
  });

  it("an item is never a source: a saved article carries _rss_url but is no subscription", async () => {
    currentActor = admin;
    const { sourceId: mainSourceId, nodeId: savedNodeId } = await savedArticle();
    // The saved article holds the article link under the `_rss_url` key and its
    // subscription's id under `_rss_source`: provenance, not a source.
    const url = (await q<{ value: string }>(
      `SELECT value FROM node_attributes WHERE node_id = $1 AND key = $2`, [savedNodeId, K.itemUrl])).rows[0]?.value;
    expect(url).toBeTruthy();
    expect((await q<{ value: string }>(
      `SELECT value FROM node_attributes WHERE node_id = $1 AND key = $2`, [savedNodeId, K.source])).rows[0]?.value).toBe(mainSourceId);
    expect(await findSource(WS, { id: savedNodeId })).toBeNull();
    const list = (await (await get(`/api/rss/sources`)).json()) as SourceList;
    expect(list.sources.map((s) => s.id)).not.toContain(savedNodeId);
    expect((await post(`/api/rss/sources/${savedNodeId}/refresh`)).status).toBe(404);
    expect(await findSource(WS, { id: mainSourceId })).not.toBeNull();
  });

  it("a note carrying a feed URL and a #subscription tag by hand is an ordinary note, not a source", async () => {
    currentActor = admin;
    const tagId = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug)
       VALUES ($1, 'manual', 'class_tag', $2, $3) RETURNING id`,
      [WS, `subscription-${stamp}`, `tag-sub-hand-${stamp}`])).rows[0]!.id;
    const note = (await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown)
       VALUES ($1, 'manual', 'content', $2, $3, '') RETURNING id`,
      [WS, `D53 hand-tagged ${stamp}`, `d53-hand-${stamp}`])).rows[0]!.id;
    await seedQ(`INSERT INTO node_tags (node_id, tag_id) VALUES ($1, $2)`, [note, tagId]);
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value) VALUES ($1, $2, $3, 'https://feed.test/hand.xml')`, [WS, note, K.itemUrl]);
    await seedQ(`INSERT INTO node_attributes (workspace_id, node_id, key, value) VALUES ($1, $2, '_rss_kind', 'source')`, [WS, note]);
    try {
      const list = (await (await get(`/api/rss/sources`)).json()) as SourceList;
      expect(list.sources.map((s) => s.id)).not.toContain(note);
      expect((await post(`/api/rss/sources/${note}/refresh`)).status).toBe(404);
      expect(await (await get("/api/rss/opml")).text()).not.toContain(`D53 hand-tagged ${stamp}`);
    } finally {
      await seedQ(`DELETE FROM content_nodes WHERE id = ANY($1::uuid[])`, [[note, tagId]]);
    }
  });

  it("#subscription appears nowhere: subscribing applies no tag and keys none", async () => {
    currentActor = admin;
    const { id: mainSourceId } = await fetchedSource();
    const tags = await q(`SELECT 1 FROM node_tags WHERE node_id = $1`, [mainSourceId]);
    expect(tags.rows).toHaveLength(0);
    const keyed = await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND reserved_key = 'subscription' AND deleted_at IS NULL`, [WS]);
    expect(keyed.rows).toHaveLength(0);
  });
});

// ── K. migration 061 carries legacy rows over ────────────────────────────────
// The legacy tables are gone from the live schema; this re-seeds them as the
// fixture and re-executes the (re-runnable) migration file against the same
// DB, then asserts the node shape it produced. (080 ran at boot BEFORE this
// re-run, so the nodes 061 re-creates here are post-080 leftovers — harmless
// fixtures; a real upgrade runs 061 → … → 080 in order.)
describe.skipIf(!isTestDb)("migration 061 — legacy rss tables → nodes", () => {
  const mstamp = `m61-${Date.now()}`;
  let WS = "";

  beforeAll(async () => {
    WS = await getWorkspaceId();
  });

  it("migrates seeded rss_sources/rss_items into source nodes + item attrs, then drops the tables", async () => {
    // Seed the legacy shape (as migration 001 defined it).
    await q(`CREATE TABLE IF NOT EXISTS rss_sources (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      workspace_id uuid NOT NULL, url text NOT NULL, title text NOT NULL,
      enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now())`);
    await q(`CREATE TABLE IF NOT EXISTS rss_items (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      workspace_id uuid NOT NULL, rss_source_id uuid, title text NOT NULL, url text NOT NULL,
      summary text NOT NULL DEFAULT '', raw_content text NOT NULL DEFAULT '',
      status text NOT NULL, node_id uuid, created_at timestamptz NOT NULL DEFAULT now())`);

    const src = await q<{ id: string }>(
      `INSERT INTO rss_sources (workspace_id, url, title) VALUES ($1, $2, $3) RETURNING id`,
      [WS, `https://legacy.test/${mstamp}.xml`, `Legacy Feed ${mstamp}`]);
    const node = await seedQ<{ id: string }>(
      `INSERT INTO content_nodes (workspace_id, source_type, node_type, title, slug, markdown, hidden)
       VALUES ($1, 'rss', 'content', $2, $3, 'legacy body', true) RETURNING id`,
      [WS, `Legacy Article ${mstamp}`, `legacy-article-${mstamp}`]);
    await q(
      `INSERT INTO rss_items (workspace_id, rss_source_id, title, url, status, node_id)
       VALUES ($1, $2, $3, $4, 'imported', $5)`,
      [WS, src.rows[0]!.id, `Legacy Article ${mstamp}`, `https://legacy.test/${mstamp}/1`, node.rows[0]!.id]);

    // Re-execute the migration file (guarded → re-runnable).
    const sql = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../db/migrations/061_rss_as_nodes.sql"), "utf8");
    await pool.query(sql);

    // Source node: #subscription + _rss_url.
    const srcNode = await q<{ id: string; hidden: boolean }>(
      `SELECT n.id, n.hidden FROM content_nodes n
         JOIN node_attributes na ON na.node_id = n.id AND na.key = '_rss_url' AND na.value = $2
         JOIN node_tags nt ON nt.node_id = n.id
         JOIN content_nodes t ON t.id = nt.tag_id AND t.title = 'subscription' AND t.node_type = 'class_tag'
        WHERE n.workspace_id = $1 AND n.deleted_at IS NULL`,
      [WS, `https://legacy.test/${mstamp}.xml`]);
    expect(srcNode.rows).toHaveLength(1);
    expect(srcNode.rows[0]!.hidden).toBe(false);

    // Item node: stamped + reparented + unread (status was 'imported').
    const attrs = await q<{ key: string; value: string }>(
      `SELECT key, value FROM node_attributes WHERE node_id = $1 AND key LIKE '\\_rss\\_%'`,
      [node.rows[0]!.id]);
    const map = Object.fromEntries(attrs.rows.map((r) => [r.key, r.value]));
    expect(map["_rss_source"]).toBe(srcNode.rows[0]!.id);
    expect(map["_rss_guid"]).toBe(`https://legacy.test/${mstamp}/1`);
    expect(map["_rss_read"]).toBe("false");
    const parent = await q<{ parent_id: string }>(
      `SELECT parent_id FROM content_nodes WHERE id = $1`, [node.rows[0]!.id]);
    expect(parent.rows[0]!.parent_id).toBe(srcNode.rows[0]!.id);

    // The legacy tables are gone again.
    const reg = await q<{ s: string | null; i: string | null }>(
      `SELECT to_regclass('public.rss_sources')::text AS s, to_regclass('public.rss_items')::text AS i`);
    expect(reg.rows[0]!.s).toBeNull();
    expect(reg.rows[0]!.i).toBeNull();
  });
});
