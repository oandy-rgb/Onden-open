// 少看這種 — a person's own mutes in the reader (rss_mutes, migration 182).
//
// A mute hides articles from the caller's list for a while and deletes nothing:
//   * a keyword, matched against article TITLES only;
//   * a whole feed ("靜音一週").
// Every mute ends by itself (a week by default). Like rss_seen it is personal
// buffer state: no domain event, other readers of the feed are untouched, and a
// mute never hides an article that is opened on purpose (a link, a saved note).
// Reads put `notMutedSql` into their WHERE so paging and counts agree with the list.

import { sql } from "kysely";
import { db } from "../../dbKysely.js";
import { canReadSource } from "./sources.js";
import { mutatePersonal } from "../../spine/mutate.js";
import { personalDataOwnerId, isTemporarySessionActor } from "../../spine/authority.js";
import type { ActorCtx } from "../../types.js";
import { listSources } from "./sources.js";

export const MUTE_DEFAULT_DAYS = 7;
export const MUTE_MAX_DAYS = 30;
export const MUTE_KEYWORD_MAX_CHARS = 80;

export type Mute = {
  id: string;
  /** Set for a keyword mute. */
  keyword: string | null;
  /** Set for a feed mute, with the feed's title. */
  source_id: string | null;
  source_title: string | null;
  expires_at: string;
};

/** The SQL predicate "this staging row is not muted for the actor": use it
 *  in a query over `rss_staging`; `actorParam` is the placeholder holding the
 *  caller's actor id. Title matching is case-insensitive and literal (no
 *  LIKE patterns, so `%` in a keyword means itself). */
export function notMutedSql(actorParam: string): string {
  return `NOT EXISTS (SELECT 1 FROM rss_mutes m
     WHERE m.workspace_id = rss_staging.workspace_id AND m.actor_id = ${actorParam} AND m.expires_at > now()
       AND (m.subscription_id = rss_staging.subscription_id
            OR (m.keyword IS NOT NULL AND position(lower(m.keyword) in lower(rss_staging.title)) > 0)))`;
}

/** A keyword as stored: trimmed, inner whitespace collapsed; null when empty or too long. */
export function cleanKeyword(raw: string): string | null {
  const keyword = raw.replace(/\s+/g, " ").trim();
  return keyword.length > 0 && keyword.length <= MUTE_KEYWORD_MAX_CHARS ? keyword : null;
}

const expiry = (days: number) => sql<Date>`now() + make_interval(days => ${Math.min(Math.max(Math.trunc(days), 1), MUTE_MAX_DAYS)})`;

/** The caller's active mutes, newest first. Feed mutes of feeds the caller can no longer read are left out. A temporary session lists its person's
 *  FEED mutes only: the keywords are the person's own words (what they do not want to read) and the list exists for managing them, which a session
 *  cannot do; the keyword mutes still hide articles from its reads (notMutedSql), it just does not get to read them out. */
export async function listMutes(actor: ActorCtx, workspaceId: string): Promise<Mute[]> {
  const readable = new Map((await listSources(actor, workspaceId)).map((s) => [s.id, s.title]));
  const rows = await db.selectFrom("rss_mutes")
    .select(["id", "keyword", "subscription_id", "expires_at"])
    .where("workspace_id", "=", workspaceId).where("actor_id", "=", personalDataOwnerId(actor))
    .where("expires_at", ">", sql<Date>`now()`)
    .orderBy("created_at", "desc").orderBy("id").execute();
  return rows.flatMap((row) => {
    if (row.subscription_id && !readable.has(row.subscription_id)) return [];
    if (!row.subscription_id && isTemporarySessionActor(actor)) return [];
    return [{
      id: row.id, keyword: row.keyword, source_id: row.subscription_id,
      source_title: row.subscription_id ? readable.get(row.subscription_id)! : null,
      expires_at: new Date(row.expires_at).toISOString(),
    }];
  });
}

/** Mute a title keyword; the same keyword again only extends it. Returns the mute's id. */
export async function muteKeyword(actor: ActorCtx, workspaceId: string, keyword: string, days = MUTE_DEFAULT_DAYS): Promise<string> {
  return mutatePersonal({ actor, workspaceId, apply: ({ actor: current }) => writeKeywordMute(current, workspaceId, keyword, days) });
}

async function writeKeywordMute(actor: ActorCtx, workspaceId: string, keyword: string, days: number): Promise<string> {
  const existing = await db.updateTable("rss_mutes").set({ expires_at: expiry(days) })
    .where("workspace_id", "=", workspaceId).where("actor_id", "=", actor.id)
    .where(sql<boolean>`lower(keyword) = lower(${keyword})`).returning("id").executeTakeFirst();
  if (existing) return existing.id;
  const row = await db.insertInto("rss_mutes")
    .values({ workspace_id: workspaceId, actor_id: actor.id, keyword, expires_at: expiry(days) })
    .returning("id").executeTakeFirstOrThrow();
  return row.id;
}

/** Mute a whole feed the caller can read; null when they cannot (no existence leak). */
export async function muteSource(actor: ActorCtx, workspaceId: string, sourceId: string, days = MUTE_DEFAULT_DAYS): Promise<string | null> {
  if (!(await canReadSource(actor, workspaceId, sourceId))) return null;
  return mutatePersonal({ actor, workspaceId, apply: ({ actor: current }) => writeSourceMute(current, workspaceId, sourceId, days) });
}

async function writeSourceMute(actor: ActorCtx, workspaceId: string, sourceId: string, days: number): Promise<string> {
  const existing = await db.updateTable("rss_mutes").set({ expires_at: expiry(days) })
    .where("workspace_id", "=", workspaceId).where("actor_id", "=", actor.id).where("subscription_id", "=", sourceId)
    .returning("id").executeTakeFirst();
  if (existing) return existing.id;
  const row = await db.insertInto("rss_mutes")
    .values({ workspace_id: workspaceId, actor_id: actor.id, subscription_id: sourceId, expires_at: expiry(days) })
    .returning("id").executeTakeFirstOrThrow();
  return row.id;
}

/** End one of the caller's own mutes early; false when it is not theirs or is gone. */
export async function endMute(actor: ActorCtx, workspaceId: string, id: string): Promise<boolean> {
  return mutatePersonal({ actor, workspaceId, apply: async ({ actor: current }) => {
    const r = await db.deleteFrom("rss_mutes").where("id", "=", id).where("workspace_id", "=", workspaceId).where("actor_id", "=", current.id).executeTakeFirst();
    return Number(r.numDeletedRows) > 0;
  } });
}
