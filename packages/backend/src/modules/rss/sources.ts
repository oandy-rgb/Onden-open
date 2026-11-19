// Subscription SOURCES — the one answer to "which feeds do we follow?" (depth
// audit D53; the rule used to be written seven times with different filters).
//
// A source is a row of `rss_subscriptions` (migration 145). It is a SETTING,
// not content: it is not a note, it is not in the note tree, and nothing in it
// is a domain event. Until 145 each one was a note marked `_rss_kind = 'source'`
// with its feed state in `_rss_*` attributes (migration 061); the product
// decision (2026-10-29) was that a subscription is configuration managed on the
// Reading page. What the note form gave and the table keeps: the row carries
// `space_id` and is read under the same space rule as a note
// (services/readPolicy.ts readableSpaceScopeSql), so a subscription in a space
// you cannot read stays invisible together with its articles (rss_staging is
// read THROUGH its source).
//
// Reads: `listSources` / `getSource` / `canReadSource` are read-policy bounded
// (what is SERVED); `findSource` is the unbounded lookup for code that already
// gated the id or runs in the background (the scheduler sweeps every workspace;
// whether a workspace fetches at all, `modules ? 'rss'`, is the scheduler's own
// gate). Writes: this file is the only writer of the table. A write needs the
// `edit` permission in the source's space (`assertSourceWritable`), checked by
// the caller under the workspace event lock with the CURRENT actor
// (spine/currentActor.ts) in the same transaction as the write; it records no
// domain event (spineGate allowlist: a setting has no history to restore, and
// the outbox intent for the first fetch rides the same transaction).
//
// Item provenance (guid/source/url/published_at) is still stamped as `_rss_*`
// attributes onto the NOTE a save materializes (save.ts): that is content, and
// `_rss_source` there is the subscription's id.

import { q, allowUnstampedWrite } from "../../db.js";
import { db } from "../../dbKysely.js";
import type { ActorCtx } from "../../types.js";
import { readableSpaceScopeSql } from "../../services/readPolicy.js";
import { assertAuthority, carriedActorId } from "../../spine/authority.js";
import { enqueueEffect } from "../../services/outbox.js";
import { feedUrlKey } from "./feedUrl.js";
import type { Destination } from "./destination.js";

/** Attribute keys stamped onto a SAVED ARTICLE note (provenance); the
 *  subscription's own state is columns, not attributes. */
export const K = {
  guid: "_rss_guid",
  /** The subscription's id (rss_subscriptions.id). */
  source: "_rss_source",
  publishedAt: "_rss_published_at",
  /** The article's link. */
  itemUrl: "_rss_url",
} as const;

export const DEFAULT_INTERVAL_MINUTES = 60;

export const SOURCE_VOICES = ["person", "media"] as const;
export type SourceVoice = (typeof SOURCE_VOICES)[number];
export const SOURCE_DISPLAY_MODES = ["text", "image", "video"] as const;
export type SourceDisplayMode = (typeof SOURCE_DISPLAY_MODES)[number];

export type SourceRow = {
  id: string;
  workspace_id: string;
  space_id: string;
  title: string;
  url: string;
  created_by_actor_id: string | null;
  created_at: string;
  etag: string | null;
  last_modified: string | null;
  fetch_interval_minutes: number;
  last_fetched_at: string | null;
  last_error: string | null;
  /** A tag id (the tag may have been deleted since). */
  auto_tag_id: string | null;
  embed: boolean;
  /** Days before an unseen article ages to seen; null = the module default. */
  auto_dismiss_days: number | null;
  /** The feed's own save default (destination.ts): null = none set. */
  default_tag_ids: string[] | null;
  default_parent_id: string | null;
  always_fulltext: boolean;
  /** A personal writer's feed or a publication's (voice.ts). */
  voice: SourceVoice;
  /** How its articles look in the list. */
  display_mode: SourceDisplayMode;
};

type RawSourceRow = Omit<SourceRow, "created_at" | "last_fetched_at"> & {
  created_at: Date | string;
  last_fetched_at: Date | string | null;
};

const iso = (v: Date | string): string => new Date(v).toISOString();

const fromRow = (row: RawSourceRow): SourceRow => ({
  ...row,
  created_at: iso(row.created_at),
  last_fetched_at: row.last_fetched_at === null ? null : iso(row.last_fetched_at),
});

// A subscription in a deleted space is inert: neither listed nor fetched.
const FROM = `rss_subscriptions r JOIN spaces sp ON sp.id = r.space_id AND sp.deleted_at IS NULL`;
const COLS = `r.id, r.workspace_id, r.space_id, r.title, r.url, r.created_by_actor_id::text AS created_by_actor_id,
  r.created_at, r.etag, r.last_modified, r.fetch_interval_minutes, r.last_fetched_at, r.last_error,
  r.auto_tag_id, r.embed, r.auto_dismiss_days, r.default_tag_ids, r.default_parent_id, r.always_fulltext, r.voice, r.display_mode`;

/** The caller's readable sources, by title. */
export async function listSources(actor: ActorCtx | null, workspaceId: string): Promise<SourceRow[]> {
  const params: unknown[] = [workspaceId];
  const scope = readableSpaceScopeSql(actor, "r", params);
  const r = await q<RawSourceRow>(
    `SELECT ${COLS} FROM ${FROM} WHERE r.workspace_id = $1 AND ${scope} ORDER BY r.title ASC, r.id`,
    params,
  );
  return r.rows.map(fromRow);
}

/** One source the caller may read, or null (missing and unreadable look the
 *  same: no existence leak). */
export async function getSource(actor: ActorCtx | null, workspaceId: string, id: string): Promise<SourceRow | null> {
  const params: unknown[] = [workspaceId, id];
  const scope = readableSpaceScopeSql(actor, "r", params);
  const r = await q<RawSourceRow>(
    `SELECT ${COLS} FROM ${FROM} WHERE r.workspace_id = $1 AND r.id = $2 AND ${scope}`, params);
  return r.rows[0] ? fromRow(r.rows[0]) : null;
}

/** Can the caller read source `id`? */
export async function canReadSource(actor: ActorCtx | null, workspaceId: string, id: string): Promise<boolean> {
  return (await getSource(actor, workspaceId, id)) !== null;
}

/** One source, by id, or by feed URL within a space (the space a new
 *  subscription would go to). Not read-gated: callers gate the id first, and
 *  a URL match is per space, so someone else's subscription in a space you
 *  cannot see neither blocks yours nor reveals itself. URLs match by
 *  feedUrlKey, so /feed/ and /feed (or an older, unnormalised row) are one. */
export async function findSource(
  workspaceId: string, by: { id: string } | { url: string; spaceId: string },
): Promise<SourceRow | null> {
  if ("id" in by) {
    const r = await q<RawSourceRow>(
      `SELECT ${COLS} FROM ${FROM} WHERE r.workspace_id = $1 AND r.id = $2`, [workspaceId, by.id]);
    return r.rows[0] ? fromRow(r.rows[0]) : null;
  }
  const key = feedUrlKey(by.url);
  if (!key) return null;
  const r = await q<RawSourceRow>(
    `SELECT ${COLS} FROM ${FROM} WHERE r.workspace_id = $1 AND r.space_id = $2 ORDER BY r.created_at ASC, r.id`,
    [workspaceId, by.spaceId]);
  const hit = r.rows.find((row) => feedUrlKey(row.url) === key);
  return hit ? fromRow(hit) : null;
}

/** Does the workspace follow any feed? (The module library's "in use".) */
export async function hasSources(workspaceId: string): Promise<boolean> {
  return ((await q(`SELECT 1 FROM rss_subscriptions WHERE workspace_id = $1 LIMIT 1`, [workspaceId])).rowCount ?? 0) > 0;
}

/** Changing a source needs the `edit` permission in its space (a delegated
 *  token also needs write access and the space's AI switch, like a note). Call
 *  inside the event lock with the current actor. */
export async function assertSourceWritable(actor: ActorCtx, source: Pick<SourceRow, "space_id">): Promise<void> {
  await assertAuthority(actor, { kind: "space_write", spaceId: source.space_id });
}

/** The outbox effect kind fetch.ts performs (rssFetchEffect). */
export const RSS_FETCH_KIND = "rss_fetch";

export type RssFetchPayload = { workspaceId: string; subscriptionId: string };

/** File the `rss_fetch` intent for ONE source (used by the scheduler, the
 *  first fetch of a new source, and the manual refresh route). Returns the
 *  outbox row id so a route can kick a drain scoped to exactly this intent. */
export async function enqueueRssFetch(workspaceId: string, subscriptionId: string): Promise<string> {
  const payload: RssFetchPayload = { workspaceId, subscriptionId };
  return enqueueEffect({ workspaceId, kind: RSS_FETCH_KIND, dedupKey: `rss_fetch:${subscriptionId}`, payload });
}

export type SourceOptions = {
  /** Already normalised by feedUrl(). */
  url: string;
  title: string;
  /** The space it lives in (sourceSpace.ts / services/spaces.ts newNoteSpace). */
  spaceId: string;
  fetchIntervalMinutes?: number;
  autoTag?: string;
  embed?: boolean;
  autoDismissDays?: number;
  /** The source's own save default, already checked (destination.ts
   *  assertDestination). Left out: the source has no explicit default. */
  saveDefault?: Destination;
  /** Left out: 'media'. */
  voice?: SourceVoice;
};

/** Create a source (shared by subscribe + OPML import) and file its first
 *  fetch. Call inside the event lock, after `assertSourceWritable`-equivalent
 *  space write was established by newNoteSpace. */
export async function createSource(
  workspaceId: string, actor: ActorCtx, opts: SourceOptions,
): Promise<{ id: string; outboxId: string }> {
  const r = await q<{ id: string }>(
    `INSERT INTO rss_subscriptions
       (workspace_id, space_id, title, url, created_by_actor_id, fetch_interval_minutes, auto_tag_id, embed,
        auto_dismiss_days, default_tag_ids, default_parent_id, voice)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid[], $11, $12)
     RETURNING id`,
    [workspaceId, opts.spaceId, opts.title, opts.url, carriedActorId(actor), opts.fetchIntervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
      opts.autoTag ?? null, opts.embed ?? false, opts.autoDismissDays ?? null,
      opts.saveDefault?.tagIds ?? null, opts.saveDefault?.parentId ?? null, opts.voice ?? "media"],
  );
  const id = r.rows[0]!.id;
  // First fetch rides the outbox rail like every periodic one.
  return { id, outboxId: await enqueueRssFetch(workspaceId, id) };
}

/** Change a source's own settings: its save default (`null` clears it, so the
 *  feed falls back to the module default) and 總是載入全文. Call inside the
 *  event lock, after `assertSourceWritable`. */
export async function writeSourceSettings(
  workspaceId: string, id: string,
  change: { saveDefault?: Destination | null; alwaysFulltext?: boolean; voice?: SourceVoice; displayMode?: SourceDisplayMode },
): Promise<void> {
  if (change.saveDefault !== undefined) {
    await q(
      `UPDATE rss_subscriptions SET default_tag_ids = $3::uuid[], default_parent_id = $4 WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id, change.saveDefault?.tagIds ?? null, change.saveDefault?.parentId ?? null]);
  }
  if (change.alwaysFulltext !== undefined) {
    await q(`UPDATE rss_subscriptions SET always_fulltext = $3 WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id, change.alwaysFulltext]);
  }
  const columns = { ...(change.displayMode !== undefined && { display_mode: change.displayMode }), ...(change.voice !== undefined && { voice: change.voice }) };
  if (Object.keys(columns).length > 0) {
    await db.updateTable("rss_subscriptions").set(columns).where("workspace_id", "=", workspaceId).where("id", "=", id).execute();
  }
}

/** Stop following a feed: the row goes, and its stream buffer with it (the
 *  foreign key cascades; saved articles are notes and stay). Call inside the
 *  event lock, after `assertSourceWritable`. */
export async function removeSource(workspaceId: string, id: string): Promise<void> {
  await q(`DELETE FROM rss_subscriptions WHERE workspace_id = $1 AND id = $2`, [workspaceId, id]);
}

/** Put sources in another space (sourceSpace.ts changeSourceSpace, which has
 *  already decided which). Their articles follow: staging is read through the
 *  source. */
export async function moveSources(workspaceId: string, ids: readonly string[], spaceId: string): Promise<void> {
  if (ids.length === 0) return;
  await q(`UPDATE rss_subscriptions SET space_id = $3 WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
    [workspaceId, ids, spaceId]);
}

/** A fetch ended: stamp the feed's operational state. Bookkeeping a periodic
 *  fetch writes every hour, deliberately event-free (the same posture as
 *  node_positions: "a drag must not spam the log"). `ok` clears the last
 *  error; a failure records it and leaves the validators alone. */
export async function recordFetch(
  workspaceId: string, id: string,
  result: { ok: true; etag: string | null; lastModified: string | null } | { ok: false; error: string },
): Promise<void> {
  // The fetch state (etag, last fetch) belongs to the node that fetched (causal-stamps proposal §4.1); no person authors it.
  const reason = "rss fetch state belongs to the node that fetched it";
  if (result.ok) {
    await allowUnstampedWrite(reason, () => q(
      `UPDATE rss_subscriptions SET last_fetched_at = now(), etag = $3, last_modified = $4, last_error = NULL
        WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id, result.etag, result.lastModified]));
  } else {
    await allowUnstampedWrite(reason, () => q(`UPDATE rss_subscriptions SET last_error = $3 WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id, result.error]));
  }
}
