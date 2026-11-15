// RSS fetch loop — entirely on the existing rails, zero new mechanisms:
//
//   • PERIODIC: a small scheduler (startRssScheduler, booted by mountModules
//     outside tests) enqueues an `rss_fetch` outbox intent per DUE source
//     (now - last_fetched_at >= fetch_interval_minutes). The outbox
//     reconciler performs it with retry/backoff like any other effect — the
//     module files intents, it does not invent its own queue ("no third
//     rails", modules/README.md).
//
//   • PERFORM: performRssFetch, registered as the module's `rss_fetch` outbox effect
//     fetches + parses the feed and lands each new item in rss_staging — the
//     inbound BOUNDARY BUFFER (the outbox table's mirror image). An article is
//     NOT a node, not an event, not an actor's change until the human SAVES it
//     (routes.ts POST /items/:id/save); until then it's "the internet passing
//     by": streamed, skippable, aged out. Dedup is the (subscription_id, guid)
//     unique key — a staging row, tombstoned or not, blocks re-ingest forever
//     (miniflux's entry_tombstones).
//
//   • RETENTION (sweepRssStaging, each scheduler pass): unseen items age to
//     seen after UNSEEN_AGE_DAYS (an unread pile must not be a debt — Feedly
//     marks >30d read for the same reason); seen items older than
//     TOMBSTONE_AFTER_SEEN_DAYS lose their body but KEEP their row (the guid
//     tombstone); the newest KEEP_FLOOR_PER_SOURCE rows per source are always
//     kept; saved articles are exempt (they're notes now — the library is
//     permanent, the stream is not).
//
//   • BACKFILL BOUND: on any fetch, items published more than
//     BACKFILL_WINDOW_DAYS ago arrive pre-seen — subscribing to a busy feed
//     must not mint a 200-item unseen debt (Feedly/Inoreader's 30-day window).

import Parser from "rss-parser";
import { safeFetch } from "../../services/safeFetch.js";

function headerStr(v: string | string[] | undefined): string | null {
  return Array.isArray(v) ? v[0] ?? null : v ?? null;
}
import { sha256Hex } from "../../utils.js";
import { derivedIdName } from "@onden/markdown";
import { derivedId } from "../../services/derivedIds.js";
import { pool, q } from "../../db.js";
import { startPeriodicJob } from "../../backgroundJobs.js";
import { log } from "../../logger.js";
import { workspaceHasModule } from "../../services/workspaceModules.js";
import type { OutboxEffect } from "../../services/outbox.js";
import { absolutizeUrls, sanitizeFeedHtml } from "./sanitize.js";
import { RSS_FETCH_KIND, findSource, enqueueRssFetch, recordFetch, type RssFetchPayload } from "./sources.js";
import { itemUrl } from "./feedUrl.js";
import { isTest } from "../../config.js";
import { liveNodeSql } from "../../spine/nodeSql.js";

export const BACKFILL_WINDOW_DAYS = 30;
export const UNSEEN_AGE_DAYS = 30;
export const TOMBSTONE_AFTER_SEEN_DAYS = 90;
export const KEEP_FLOOR_PER_SOURCE = 50;
/** How long a source whose retry budget ran out is left alone before the scheduler tries it again. */
export const DEAD_SOURCE_REST_HOURS = 6;

export type FeedItem = {
  guid: string;
  title: string;
  url: string | null;
  publishedAt: string | null;
  contentHtml: string;
  /** The article's byline, when the feed names one (voice.ts uses it once, at subscribe time). */
  author?: string | null;
};

export type ParsedFeed = {
  title: string | null;
  etag: string | null;
  lastModified: string | null;
  notModified: boolean;
  items: FeedItem[];
};

// ── Feed fetching (injectable for tests) ────────────────────────────────────

type FeedFetcher = (url: string, conditional: { etag?: string | null; lastModified?: string | null }) => Promise<ParsedFeed>;

let feedFetchOverride: FeedFetcher | null = null;

/** Test seam: stub the network fetch (NODE_ENV=test only — production feeds
 *  can't be forged through this). */
export function __setFeedFetchForTests(fn: FeedFetcher | null): void {
  if (!isTest()) return;
  feedFetchOverride = fn;
}

function itemGuid(it: { guid?: string; link?: string; title?: string; pubDate?: string }): string {
  if (it.guid) return it.guid;
  if (it.link) return it.link;
  return sha256Hex(`${it.title ?? ""}|${it.pubDate ?? ""}`).slice(0, 32);
}

/** Feeds that carry every article in full (long-form blogs, newsletters,
 *  podcasts with long show notes) routinely pass 5 MB; the whole document has
 *  to be read to parse it, so the cap only guards against runaway responses. */
export const FEED_MAX_BYTES = 25 * 1024 * 1024;
const PAGE_MAX_BYTES = 8 * 1024 * 1024;

export async function fetchAndParseFeed(
  url: string,
  conditional: { etag?: string | null; lastModified?: string | null } = {},
): Promise<ParsedFeed> {
  if (feedFetchOverride) return feedFetchOverride(url, conditional);

  const headers: Record<string, string> = { "User-Agent": "Onden/1.0 (rss reader)" };
  if (conditional.etag) headers["If-None-Match"] = conditional.etag;
  if (conditional.lastModified) headers["If-Modified-Since"] = conditional.lastModified;

  // SSRF-hardened + size-capped (audit #2/#9): a feed url is user input.
  const res = await safeFetch(url, { headers, timeoutMs: 20_000, maxBytes: FEED_MAX_BYTES });
  if (res.status === 304) {
    return { title: null, etag: conditional.etag ?? null, lastModified: conditional.lastModified ?? null, notModified: true, items: [] };
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`feed fetch failed: HTTP ${res.status}`);
  const xml = res.text;
  const parser = new Parser();
  const feed = await parser.parseString(xml);
  // #9: feeds in the wild repeat GUIDs inside one document (aggregators,
  // broken generators) — first occurrence wins, duplicates dropped here so
  // every downstream consumer sees a batch that is unique by guid.
  const seen = new Set<string>();
  const items: FeedItem[] = [];
  for (const it of feed.items ?? []) {
    const guid = itemGuid(it);
    if (seen.has(guid)) continue;
    seen.add(guid);
    items.push({
      guid,
      title: it.title?.trim() || "(untitled)",
      url: it.link ?? null,
      publishedAt: it.isoDate ?? it.pubDate ?? null,
      contentHtml: (it["content:encoded"] as string | undefined) ?? it.content ?? it.contentSnippet ?? "",
      author: (it.creator as string | undefined) ?? (it.author as string | undefined) ?? null,
    });
  }
  return {
    title: feed.title ?? null,
    etag: headerStr(res.headers.etag),
    lastModified: headerStr(res.headers["last-modified"]),
    notModified: false,
    items,
  };
}

// ── Page fetching for "載入全文" (injectable for tests) ─────────────────────

let pageFetchOverride: ((url: string) => Promise<string>) | null = null;

/** Test seam for the full-text page fetch (NODE_ENV=test only). */
export function __setPageFetchForTests(fn: ((url: string) => Promise<string>) | null): void {
  if (!isTest()) return;
  pageFetchOverride = fn;
}

/** Fetch an article page's HTML — single, user-initiated, inline (the same
 *  posture as routes/bookmark.ts; periodic refresh stays outbox-only). */
export async function fetchPageHtml(url: string): Promise<string> {
  if (pageFetchOverride) return pageFetchOverride(url);
  const res = await safeFetch(url, {
    headers: { "User-Agent": "Onden/1.0 (rss reader)" },
    timeoutMs: 8_000,
    maxBytes: PAGE_MAX_BYTES,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`page fetch failed: HTTP ${res.status}`);
  return res.text;
}

// ── The fetch effect (outbox `rss_fetch`) ───────────────────────────────────

export type RssFetchResult = { created: number; skipped: number };

/** The module's outbox effect, registered by mountModules via rssModule. */
export const rssFetchEffect: OutboxEffect<RssFetchPayload> = {
  kind: RSS_FETCH_KIND,
  parse: (payload) => {
    const { workspaceId, subscriptionId } = payload;
    if (typeof workspaceId !== "string" || typeof subscriptionId !== "string") {
      throw new Error("rss_fetch payload requires workspaceId and subscriptionId");
    }
    return { workspaceId, subscriptionId };
  },
  perform: async (payload) => { await performRssFetch(payload); },
};

export async function performRssFetch(payload: RssFetchPayload): Promise<RssFetchResult> {
  const { workspaceId, subscriptionId } = payload;
  const source = await findSource(workspaceId, { id: subscriptionId });
  // Unsubscribed between enqueue and perform → nothing to do.
  if (!source) return { created: 0, skipped: 0 };
  const url = source.url;

  let feed: ParsedFeed;
  try {
    feed = await fetchAndParseFeed(url, { etag: source.etag, lastModified: source.last_modified });
  } catch (e) {
    // Record the failure on the source (the reader surfaces it), then rethrow
    // so the outbox retry/backoff machinery owns the schedule.
    await recordFetch(workspaceId, subscriptionId, { ok: false, error: e instanceof Error ? e.message : String(e) });
    throw e;
  }

  const stampBookkeeping = () =>
    recordFetch(workspaceId, subscriptionId, { ok: true, etag: feed.etag, lastModified: feed.lastModified });

  if (feed.notModified) {
    await stampBookkeeping();
    return { created: 0, skipped: 0 };
  }

  // Land every item in the staging buffer. No per-poll quota: the feed
  // document is naturally bounded (safeFetch caps it at FEED_MAX_BYTES, 25 MiB) and, after the
  // guid conflict-skip, the steady-state increment IS the feed's real posting
  // rate — a quota would only drop articles (miniflux ships none either).
  let created = 0;
  const backfillCutoff = Date.now() - BACKFILL_WINDOW_DAYS * 86_400_000;
  for (const it of feed.items) {
    const publishedAt = it.publishedAt && !Number.isNaN(Date.parse(it.publishedAt))
      ? new Date(it.publishedAt).toISOString()
      : null;
    // Older than the backfill window → arrives pre-seen, never an unseen debt.
    const preSeen = publishedAt !== null && Date.parse(publishedAt) < backfillCutoff;
    // A relative link (common in Atom) is resolved against the feed, not left
    // to open on Onden's own origin; a non-http(s) link is dropped.
    // The body's relative media and links are the article's too (a podcast's
    // <audio src="/assets/…mp3"> would load from Onden's host).
    const link = itemUrl(it.url, url);
    const ins = await q(
      `INSERT INTO rss_staging (id, workspace_id, subscription_id, guid, title, url, published_at, body, seen_at)
       VALUES ($9, $1, $2, $3, $4, $5, $6, $7, CASE WHEN $8 THEN now() END)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      // The article's id comes from its feed and its guid: whichever node fetches it makes the same row.
      [workspaceId, subscriptionId, it.guid, it.title, link, publishedAt, sanitizeFeedHtml(absolutizeUrls(it.contentHtml, link ?? url)), preSeen,
        derivedId(derivedIdName.rssArticle(subscriptionId, it.guid))],
    );
    created += ins.rowCount ?? 0;
  }

  await stampBookkeeping();
  return { created, skipped: feed.items.length - created };
}

// ── Scheduler: enqueue due sources onto the outbox rail ─────────────────────

/** INSERT one pending `rss_fetch` intent per due source that has none pending
 *  and whose retries have not run out (see the query). */
export async function enqueueDueRssFetches(): Promise<number> {
  const due = await pool.query<{ id: string; workspace_id: string }>(
    `SELECT r.id, r.workspace_id
       FROM rss_subscriptions r
       JOIN spaces sp ON sp.id = r.space_id AND sp.deleted_at IS NULL
      WHERE (r.last_fetched_at IS NULL
         OR r.last_fetched_at <= now() - make_interval(mins => r.fetch_interval_minutes))
        -- A fetch that is still pending owns its own schedule: after a failure the
        -- outbox backs it off, and filing again would fold into it and reset
        -- that backoff to "now" (a dead feed fetched every tick).
        AND NOT EXISTS (SELECT 1 FROM outbox o
                         WHERE o.dedup_key = 'rss_fetch:' || r.id::text AND o.status = 'pending')
        -- Retries that ran out rest for DEAD_SOURCE_REST_HOURS, then get one more
        -- round (a day-long outage or a blog down for a weekend must not silence
        -- sources until the reaper deletes the dead row 30 days later). A
        -- success moves last_fetched_at past the burial and ends the rest at
        -- once; a manual refresh files its own intent. Dead rows have no index
        -- (the partial one covers 'pending'); fine at this table size.
        AND NOT EXISTS (SELECT 1 FROM outbox o
                         WHERE o.dedup_key = 'rss_fetch:' || r.id::text AND o.status = 'dead'
                           AND o.updated_at > now() - make_interval(hours => $1::int)
                           AND (r.last_fetched_at IS NULL OR o.updated_at > r.last_fetched_at))`,
    [DEAD_SOURCE_REST_HOURS],
  );
  // A workspace with RSS off (or not yet agreed to) fetches nothing in the
  // background: the scheduler's own gate, a subscription stays while RSS is off.
  const rssOn = new Map<string, boolean>();
  let enqueued = 0;
  for (const row of due.rows) {
    if (!rssOn.has(row.workspace_id)) rssOn.set(row.workspace_id, await workspaceHasModule(row.workspace_id, "rss"));
    if (!rssOn.get(row.workspace_id)) continue;
    await enqueueRssFetch(row.workspace_id, row.id);
    enqueued++;
  }
  return enqueued;
}

// ── Retention sweep over the staging buffer ─────────────────────────────────
//
// The stream stays bounded by POLICY, not by an ingest quota ("the exit, not
// the entrance"): unseen ages to seen, seen ages to a tombstone, a per-source
// floor keeps a browsable recent window, and anything saved is a note — out of
// the stream's lifecycle entirely. All plain UPDATEs on the buffer: no events,
// no actors, nothing to govern — aging news is not a change to your knowledge.

export type RssSweepResult = { aged: number; tombstoned: number };

export async function sweepRssStaging(): Promise<RssSweepResult> {
  // 1) Unseen → seen after UNSEEN_AGE_DAYS (per-source override:
  //    auto_dismiss_days, validated 1..365 at the subscribe boundary).
  const aged = await q(
    `UPDATE rss_staging s
        SET seen_at = now()
       FROM rss_subscriptions r
      WHERE r.id = s.subscription_id
        AND s.seen_at IS NULL AND s.tombstoned_at IS NULL
        AND s.fetched_at <= now() - make_interval(days => GREATEST(COALESCE(r.auto_dismiss_days, $1::int), 1))`,
    [UNSEEN_AGE_DAYS],
  );

  // 2) Long-seen, unsaved, beyond the newest-N floor → tombstone: body gone,
  //    row (the guid) kept so the next poll can't resurrect it.
  const tombstoned = await q(
    `WITH ranked AS (
       SELECT id, row_number() OVER (
                PARTITION BY subscription_id
                ORDER BY COALESCE(published_at, fetched_at) DESC) AS rn
         FROM rss_staging
        WHERE tombstoned_at IS NULL
     )
     UPDATE rss_staging s
        SET body = '', tombstoned_at = now()
       FROM ranked r
      WHERE r.id = s.id AND r.rn > $1
        -- A save whose note is in the trash no longer keeps the article.
        AND NOT EXISTS (SELECT 1 FROM content_nodes sn WHERE sn.id = s.saved_node_id AND ${liveNodeSql("sn")})
        AND s.seen_at IS NOT NULL
        AND s.seen_at <= now() - make_interval(days => $2::int)`,
    [KEEP_FLOOR_PER_SOURCE, TOMBSTONE_AFTER_SEEN_DAYS],
  );

  return { aged: aged.rowCount ?? 0, tombstoned: tombstoned.rowCount ?? 0 };
}

/** Periodic "which sources are due?" sweep. Booted once (mountModules →
 *  module.startBackground) outside tests; the heavy lifting stays on the
 *  outbox reconciler. Each pass also runs the retention sweep (cheap indexed
 *  UPDATEs; almost always no-ops). */
export function startRssScheduler(intervalMs = 60_000): void {
  startPeriodicJob({ name: "rss", everyMs: intervalMs, exclusive: true }, async () => {
    await enqueueDueRssFetches().catch((e) => log.error("rss", "enqueue sweep failed", { err: e }));
    await sweepRssStaging().catch((e) => log.error("rss", "retention sweep failed", { err: e }));
  });
}
