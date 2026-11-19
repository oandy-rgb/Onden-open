// The subscription surface behind the routes (moved from routes.ts, depth
// audit D53): subscribe, OPML import/export, and the subscription list the
// reader shows. Every source read and write goes through sources.ts; every
// feed URL through feedUrl.ts, so the form and an OPML file accept the same
// URLs and find the same duplicates. A change runs in one event transaction
// (the workspace event lock, the CURRENT actor, the space `edit` permission);
// a subscription is a setting, so it records no domain event (sources.ts).

import { assertAuthority, assertMayReachOut, personalDataOwnerId } from "../../spine/authority.js";
import { pool, q } from "../../db.js";
import type { ActorCtx } from "../../types.js";
import { drainOutbox } from "../../services/outbox.js";
import { newNoteSlugScope, newNoteSpace } from "../../services/spaces.js";
import { mutatePersonal } from "../../spine/mutate.js";
import { SafeFetchError } from "../../services/safeFetch.js";
import { sourceSpaceFor } from "./sourceSpace.js";
import { fetchAndParseFeed, FEED_MAX_BYTES } from "./fetch.js";
import {
  listSources, findSource, canReadSource, createSource, type SourceRow, type SourceVoice, type SourceDisplayMode, assertSourceWritable, writeSourceSettings, removeSource,
} from "./sources.js";
import { assertDestination, moduleDefault, saveDefaults, DestinationError, type Destination } from "./destination.js";
import { parseOpml, buildOpml } from "./opml.js";
import { guessVoice } from "./voice.js";
import { seenSql } from "./items.js";
import { notMutedSql } from "./mutes.js";
import { articlePrefixes } from "./sourcePrefix.js";
import { liveNodeSql, liveTagNodeSql, tagNodeSql } from "../../spine/nodeSql.js";


export type SubscribeInput = {
  /** Already normalised by feedUrl() at the boundary. */
  url: string;
  title?: string;
  fetchIntervalMinutes?: number;
  autoTag?: string;
  embed?: boolean;
  autoDismissDays?: number;
  /** The source's own save default (存到), chosen at subscribe time. */
  saveDefault?: Destination;
  /** Left out: guessed from the feed (voice.ts). */
  voice?: SourceVoice;
};

type Answer = { status: 200 | 201 | 404 | 409 | 422; body: Record<string, unknown> };

/** Where a new source would go, for the early duplicate answer made before the
 *  network fetch: the workspace's 訂閱放在 space when the subscriber can write
 *  there, else their own (sourceSpace.ts). Not authoritative — newSourceSpace
 *  decides under the event lock. */
async function preferredSpace(actor: ActorCtx, workspaceId: string): Promise<string | null> {
  const configured = await sourceSpaceFor(actor, workspaceId);
  if (configured) return configured;
  const target = await newNoteSlugScope(actor, workspaceId);
  return "spaceId" in target ? target.spaceId : null;
}

/** The space a new source goes to, the same rule as a new note at the top level
 *  (services/spaces.ts newNoteSpace) with 訂閱放在 as the named space; throws
 *  AuthorityError when the subscriber cannot write there. Call inside the
 *  event lock with the current actor. */
async function newSourceSpace(actor: ActorCtx, workspaceId: string): Promise<string> {
  return (await newNoteSpace(actor, workspaceId, { spaceId: await sourceSpaceFor(actor, workspaceId) }))!;
}

/** Subscribe: validate the feed once inline (single user-initiated fetch,
 *  the bookmark.ts posture), then create the source + first fetch intent in
 *  one transaction, and kick that one intent now. */
export async function subscribe(actor: ActorCtx, workspaceId: string, input: SubscribeInput): Promise<Answer> {
  // Authority before the feed is fetched (mutatePersonal and the space are asked again below, under the lock): a subscriber who may not
  // subscribe, or not in that space, makes no request leave this server; a temporary session never does.
  assertMayReachOut(actor);
  await assertAuthority(actor, { kind: "own_personal" });
  await newSourceSpace(actor, workspaceId);
  const early = await preferredSpace(actor, workspaceId);
  const dup = early ? await findSource(workspaceId, { url: input.url, spaceId: early }) : null;
  if (dup) return { status: 409, body: { error: "already_subscribed", id: dup.id } };
  const refused = await destinationRefusal(workspaceId, input.saveDefault);
  if (refused) return refused;

  let feedTitle: string | null = null;
  let guessedVoice: SourceVoice = "media";
  try {
    const feed = await fetchAndParseFeed(input.url);
    feedTitle = feed.title;
    guessedVoice = guessVoice(input.url, feed.items);
  } catch (err) {
    if (err instanceof SafeFetchError && err.code === "too_large") {
      return { status: 422, body: { error: "feed_too_large", detail: `The feed is larger than ${FEED_MAX_BYTES / 1024 / 1024} MB.` } };
    }
    return { status: 422, body: { error: `Failed to fetch feed: ${(err as Error).message}` } };
  }
  const title = input.title?.trim() || feedTitle || new URL(input.url).hostname;

  // The tag is stored by id: titles repeat under different parents and can
  // be renamed.
  let autoTag: string | undefined;
  if (input.autoTag) {
    const tags = await pool.query<{ id: string }>(
      `SELECT id FROM content_nodes WHERE workspace_id = $1 AND ${tagNodeSql()}
        AND ${liveNodeSql()} AND title = $2`,
      [workspaceId, input.autoTag],
    );
    if (tags.rows.length !== 1) {
      return { status: 422, body: { error: tags.rows.length ? "auto_tag_ambiguous" : "auto_tag_unknown" } };
    }
    autoTag = tags.rows[0]!.id;
  }
  const made = await mutatePersonal({ actor, workspaceId, apply: async ({ actor: current }): Promise<Answer & { outboxId?: string }> => {
    const spaceId = await newSourceSpace(current, workspaceId);
    const existing = await findSource(workspaceId, { url: input.url, spaceId });
    if (existing) return { status: 409, body: { error: "already_subscribed", id: existing.id } };
    const { id, outboxId } = await createSource(workspaceId, current, {
      spaceId,
      url: input.url,
      title,
      fetchIntervalMinutes: input.fetchIntervalMinutes,
      autoTag,
      embed: input.embed,
      autoDismissDays: input.autoDismissDays,
      // An auto tag is where articles from this feed are filed: the feed's own
      // save default, unless a destination was chosen.
      saveDefault: input.saveDefault ?? (autoTag ? { tagIds: [autoTag], parentId: null } : undefined),
      voice: input.voice ?? guessedVoice,
    });
    return { status: 201, body: { id, title, url: input.url }, outboxId };
  } });
  // Responsiveness: perform the first fetch now — scoped to THIS intent
  // (same posture as the inbox approve's immediate kick); failures fall
  // back to the reconciler's retry loop.
  if (made.outboxId) void drainOutbox({ id: made.outboxId }).catch(() => null);
  return { status: made.status, body: made.body };
}

/** 422 for a destination that names an unknown tag or a parent that is not
 *  a live note; null when it is fine (or absent). */
async function destinationRefusal(workspaceId: string, dest: Destination | null | undefined): Promise<Answer | null> {
  if (!dest) return null;
  try {
    await assertDestination(workspaceId, dest);
    return null;
  } catch (error) {
    if (error instanceof DestinationError) return { status: 422, body: { error: error.code, detail: error.message } };
    throw error;
  }
}

/** Run `change` on a source the caller may change: 404 when they cannot read
 *  it (or it is gone), 403 (AuthorityError) when they may only view its space,
 *  all under the workspace event lock with the current actor, so a change
 *  cannot ride an earlier permission. */
export async function changeSource(
  actor: ActorCtx, workspaceId: string, sourceId: string,
  change: (source: SourceRow, current: ActorCtx) => Promise<Answer>,
): Promise<Answer> {
  if (!(await canReadSource(actor, workspaceId, sourceId))) return { status: 404, body: { error: "source not found" } };
  return mutatePersonal({ actor, workspaceId, apply: async ({ actor: current }): Promise<Answer> => {
    const source = await findSource(workspaceId, { id: sourceId });
    if (!source) return { status: 404, body: { error: "source not found" } };
    await assertSourceWritable(current, source);
    return change(source, current);
  } });
}

/** Change a source's settings. `saveDefault`: the source's own save default
 *  (存到) — a destination makes it explicit, `null` clears it so the source
 *  falls back to the module default (destination.ts).
 *  `alwaysFulltext`: 總是載入全文 for this feed. Needs the `edit` permission in
 *  the source's space. 404 for a source the caller cannot see, 422 for a bad
 *  destination. Answers the source's resolved default afterwards. */
export async function updateSource(
  actor: ActorCtx, workspaceId: string, sourceId: string,
  change: { saveDefault?: Destination | null; alwaysFulltext?: boolean; voice?: SourceVoice; displayMode?: SourceDisplayMode },
): Promise<Answer> {
  const refused = await destinationRefusal(workspaceId, change.saveDefault);
  if (refused) return refused;
  return changeSource(actor, workspaceId, sourceId, async (_source, current) => {
    await writeSourceSettings(workspaceId, sourceId, change);
    const updated = (await findSource(workspaceId, { id: sourceId }))!;
    const resolved = (await saveDefaults(current, workspaceId, [updated])).get(sourceId)!;
    return {
      status: 200,
      body: { id: sourceId, save_default: defaultJson(resolved, new Map()), always_fulltext: updated.always_fulltext, voice: updated.voice, display_mode: updated.display_mode },
    };
  });
}

function defaultJson(d: { tagIds: string[]; parentId: string | null; origin: string }, titles: Map<string, string>) {
  return { tag_ids: d.tagIds, parent_id: d.parentId, parent_title: d.parentId ? titles.get(d.parentId) ?? null : null, origin: d.origin };
}

/** Unsubscribe: stop following a feed, keep everything already saved.
 *
 *  The subscription row is deleted (needs the `edit` permission in its space);
 *  its saved articles are ordinary notes and are not touched. The articles
 *  that were only in the stream go with the row (their buffer is the feed's).
 *  Subscribing again later starts a new stream. Answers the number of saved
 *  articles kept and unsaved ones cleared. 404 for a source the caller cannot
 *  read. */
export async function unsubscribe(actor: ActorCtx, workspaceId: string, sourceId: string): Promise<Answer> {
  return changeSource(actor, workspaceId, sourceId, async (source) => {
    const counts = (await q<{ kept: string; cleared: string }>(
      `SELECT count(*) FILTER (WHERE live) AS kept, count(*) FILTER (WHERE NOT live AND tombstoned_at IS NULL) AS cleared
         FROM (SELECT s.tombstoned_at,
                      EXISTS (SELECT 1 FROM content_nodes sn WHERE sn.id = s.saved_node_id AND ${liveNodeSql("sn")}) AS live
                 FROM rss_staging s WHERE s.workspace_id = $1 AND s.subscription_id = $2) x`,
      [workspaceId, sourceId])).rows[0]!;
    await removeSource(workspaceId, sourceId);
    return {
      status: 200,
      body: { id: sourceId, title: source.title, unsubscribed: true, kept: Number(counts.kept), cleared: Number(counts.cleared) },
    };
  });
}

/** OPML import: a source per new feed (no inline validation for bulk — the
 *  first fetch on the outbox rail validates, and a broken feed surfaces as
 *  `last_error` on its source). */
export async function importOpml(actor: ActorCtx, workspaceId: string, xml: string): Promise<Answer> {
  const entries = parseOpml(xml);
  if (entries.length === 0) return { status: 422, body: { error: "no feeds found in the OPML" } };

  const done = await mutatePersonal({ actor, workspaceId, apply: async ({ actor: current }) => {
    const spaceId = await newSourceSpace(current, workspaceId);
    const outboxIds: string[] = [];
    let skipped = 0;
    for (const entry of entries) {
      if (await findSource(workspaceId, { url: entry.url, spaceId })) { skipped++; continue; }
      outboxIds.push((await createSource(workspaceId, current, { url: entry.url, title: entry.title, spaceId })).outboxId);
    }
    return { outboxIds, skipped };
  } });
  for (const oid of done.outboxIds) void drainOutbox({ id: oid }).catch(() => null);
  return { status: 200, body: { imported: done.outboxIds.length, skipped: done.skipped } };
}

/** OPML export of the caller's readable subscriptions. */
export async function exportOpml(actor: ActorCtx | null, workspaceId: string): Promise<string> {
  const sources = await listSources(actor, workspaceId);
  return buildOpml(sources.map((s) => ({ url: s.url, title: s.title })));
}

/** The caller's readable source ids — the scope every rss_staging read in
 *  the routes is bounded by; `voice` narrows them to the feeds of that voice (「聲音」). */
export async function readableSourceIds(actor: ActorCtx | null, workspaceId: string, voice?: SourceVoice): Promise<string[]> {
  return (await listSources(actor, workspaceId)).filter((s) => !voice || s.voice === voice).map((s) => s.id);
}

/** The subscription list with per-source UNSEEN counts. IRON LAW: both the
 *  sources AND the staging rows counted are read-policy bounded, so an unseen
 *  badge can't leak a restricted article's existence. */
export async function subscriptionList(actor: ActorCtx | null, workspaceId: string) {
  const visible = await listSources(actor, workspaceId);

  // Unseen counts only for the sources listed above (already read-scoped).
  const counts = await pool.query<{ subscription_id: string; unseen: string; latest: Date | string | null }>(
    `SELECT subscription_id, count(*) AS unseen, max(fetched_at) AS latest
       FROM rss_staging
      WHERE workspace_id = $1 AND tombstoned_at IS NULL AND NOT ${seenSql("$2")} AND ${notMutedSql("$2")}
        AND subscription_id = ANY($3::uuid[])
      GROUP BY subscription_id`,
    [workspaceId, actor ? personalDataOwnerId(actor) : "", visible.map((row) => row.id)],
  );
  const unseen = new Map(counts.rows.map((row) => [row.subscription_id, Number(row.unseen)]));
  // When the newest unseen article arrived: the reader's nav dot compares it
  // with the newest arrival it has shown (server time on both sides).
  const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());
  const latestUnseen = new Map(counts.rows.map((row) => [row.subscription_id, iso(row.latest)]));
  const latestOverall = [...latestUnseen.values()].reduce<string | null>((a, b) => (b && (!a || b > a) ? b : a), null);
  // auto_tag is stored by id; show the title.
  const tagIds = visible.map((row) => row.auto_tag_id).filter((v): v is string => v !== null);
  const autoTagTitles = new Map((await pool.query<{ id: string; title: string }>(
    `SELECT id::text, title FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND ${liveTagNodeSql()}`,
    [workspaceId, tagIds],
  )).rows.map((t) => [t.id, t.title]));

  // Where 存 puts an article from each source (destination.ts), parents
  // already limited to ones this reader can see.
  const defaults = await saveDefaults(actor, workspaceId, visible);
  const parentIds = [...new Set([...defaults.values()].flatMap((d) => d.parentId ? [d.parentId] : []))];
  const parentTitles = new Map((await pool.query<{ id: string; title: string }>(
    `SELECT id::text, title FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
    [workspaceId, parentIds])).rows.map((r) => [r.id, r.title]));
  const workspaceDefault = await moduleDefault(workspaceId);
  // Where each source's own articles live: a link there opens in the reader (sourcePrefix.ts).
  const prefixes = await articlePrefixes(workspaceId, visible.map((row) => row.id));

  return {
    module_default: workspaceDefault ? { tag_ids: workspaceDefault.tagIds, parent_id: workspaceDefault.parentId } : null,
    sources: visible.map((row) => ({
      id: row.id,
      title: row.title,
      url: row.url,
      fetch_interval_minutes: row.fetch_interval_minutes,
      last_fetched_at: row.last_fetched_at,
      last_error: row.last_error,
      auto_tag: autoTagTitles.get(row.auto_tag_id ?? "") ?? null,
      embed: row.embed,
      always_fulltext: row.always_fulltext,
      article_prefix: prefixes.get(row.id) ?? null,
      voice: row.voice,
      display_mode: row.display_mode,
      unseen: unseen.get(row.id) ?? 0,
      latest_unseen_at: latestUnseen.get(row.id) ?? null,
      save_default: defaultJson(defaults.get(row.id)!, parentTitles),
      created_at: row.created_at,
    })),
    total_unseen: [...unseen.values()].reduce((a, b) => a + b, 0),
    latest_unseen_at: latestOverall,
  };
}
