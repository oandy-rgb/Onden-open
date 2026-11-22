// What a workspace move carries besides the notes: `.onden/extras.json`
// (format 2). The notes, tags and attachments are the sidecars'; this file is the
// person's own state and the workspace's settings that no note holds.
//
//   always written, for the person who made the backup:
//     review      spaced-repetition progress on notes (review_states)
//     focus       focus-timer records, each pointing at a task
//     rss         the subscriptions of the spaces they belong to
//     prefs       personal settings that follow them between devices (actor_prefs)
//     moduleSettings   their per-tag module settings (actor_module_settings)
//   written for the workspace, for the notes, tags and spaces the backup holds:
//     functionRefs     the functions a tag or space provides (function_refs rows with no view id). NOT the saved views (a
//                      note's or tag's `views`), a task's own reference or a card's review reference: their carriers
//                      restore those. A backup made before this was written has none; restoring it is as before.
//   written only for the workspace owner (workspace-level):
//     modules     which built-in modules are on or off
//     site        the latest publish snapshot (the published site as it was)
//
// An ordinary restore ignores the file. A workspace move (backupWorkspaceMove.ts)
// writes it into the new workspace, with note and space ids mapped. NOT in it, and
// told to the person after a move: version history and the operation log,
// AI keys (encrypted with the source server's secret), push subscriptions,
// reading progress of feeds (rss_seen) and block-level review progress.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "../dbKysely.js";
import { carriedActorId } from "../spine/authority.js";
import type { ActorCtx } from "../types.js";
import { isPrefKey, parsePref } from "./actorPrefs.js";

export const EXTRAS_VERSION = 1;

export type BackupExtras = {
  version: number;
  review: Array<{ node_id: string; state: string; previous_state: string | null; updated_at: string }>;
  focus: Array<{ task_id: string | null; started_at: string; ended_at: string | null; note: string }>;
  rss: Array<{
    id: string; space_id: string; title: string; url: string; fetch_interval_minutes: number; embed: boolean; always_fulltext: boolean;
    auto_dismiss_days: number | null; auto_tag_id: string | null; default_tag_ids: string[] | null; default_parent_id: string | null;
  }>;
  prefs: Array<{ key: string; value: unknown }>;
  moduleSettings: Array<{ tag_id: string; settings: unknown }>;
  functionRefs: Array<{ holder_node_id: string | null; holder_space_id: string | null; function_id: string; config: Record<string, unknown> }>;
  modules: { modules: string[] | null; modules_off: string[]; modules_confirmed: string[] | null } | null;
  site: { title: string; home_node_id: string | null; payload: unknown; artifact_ref: string | null; created_at: string } | null;
};

const iso = (value: Date | string): string => new Date(value).toISOString();
/** The references a note's own restore carries already: a task's (`tasks`) and a card's (`review`). */
const CARRIED_BY_THE_NOTE = ["tasks", "review"];
const strings = (value: unknown): string[] | null => (Array.isArray(value) && value.every((v) => typeof v === "string") ? value as string[] : null);

/** `actorId`'s own state, and the workspace's when `owner`. `inBackup` is the set of
 *  note ids the backup holds: a row naming any other is left out. */
export async function collectExtras(workspaceId: string, actorId: string, owner: boolean, inBackup: Set<string>, spaceIds: string[]): Promise<BackupExtras> {
  // Notes' cards only: a block's (block_id) is not carried by a move (see the header).
  const review = (await db.selectFrom("review_states").select(["node_id", "state", "previous_state", "updated_at"])
    .where("workspace_id", "=", workspaceId).where("actor_id", "=", actorId).where("node_id", "is not", null).execute())
    .flatMap((r) => (r.node_id !== null && inBackup.has(r.node_id) ? [{ ...r, node_id: r.node_id, updated_at: iso(r.updated_at as Date) }] : []));
  const focus = (await db.selectFrom("focus_sessions").select(["task_id", "started_at", "ended_at", "note"])
    .where("workspace_id", "=", workspaceId).where("actor_id", "=", actorId).orderBy("started_at").execute())
    .map((r) => ({ task_id: r.task_id && inBackup.has(r.task_id) ? r.task_id : null, note: r.note, started_at: iso(r.started_at as Date), ended_at: r.ended_at ? iso(r.ended_at as Date) : null }));
  const rss = spaceIds.length ? (await db.selectFrom("rss_subscriptions")
    .select(["id", "space_id", "title", "url", "fetch_interval_minutes", "embed", "always_fulltext", "auto_dismiss_days", "auto_tag_id", "default_tag_ids", "default_parent_id"])
    .where("workspace_id", "=", workspaceId).where("space_id", "in", spaceIds).orderBy("created_at").execute()) : [];
  const prefs = (await db.selectFrom("actor_prefs").select(["key", "value"]).where("actor_id", "=", actorId).orderBy("key").execute())
    .map((r) => ({ key: r.key, value: r.value }));
  const moduleSettings = (await db.selectFrom("actor_module_settings").select(["tag_id", "settings"]).where("actor_id", "=", actorId).execute())
    .map((r) => ({ tag_id: r.tag_id, settings: r.settings }));

  const functionRefs = (await db.selectFrom("function_refs").select(["holder_node_id", "holder_space_id", "function_id", "config"])
    .where("workspace_id", "=", workspaceId).where("instance", "=", "").where("function_id", "not in", CARRIED_BY_THE_NOTE)
    .orderBy("created_at").orderBy("id").execute())
    .flatMap((r) => ((r.holder_node_id && inBackup.has(r.holder_node_id)) || (r.holder_space_id && spaceIds.includes(r.holder_space_id))
      ? [{ holder_node_id: r.holder_node_id, holder_space_id: r.holder_space_id, function_id: r.function_id, config: r.config as Record<string, unknown> }] : []));

  let modules: BackupExtras["modules"] = null;
  let site: BackupExtras["site"] = null;
  if (owner) {
    const row = await db.selectFrom("workspaces").select(["modules", "modules_off", "modules_confirmed"]).where("id", "=", workspaceId).executeTakeFirst();
    if (row) modules = { modules: strings(row.modules), modules_off: strings(row.modules_off) ?? [], modules_confirmed: strings(row.modules_confirmed) };
    const snap = await db.selectFrom("publish_snapshots").select(["title", "home_node_id", "payload", "artifact_ref", "created_at"])
      .where("workspace_id", "=", workspaceId).orderBy("created_at", "desc").limit(1).executeTakeFirst();
    if (snap) site = { title: snap.title, home_node_id: snap.home_node_id, payload: snap.payload, artifact_ref: snap.artifact_ref, created_at: iso(snap.created_at as Date) };
  }
  return { version: EXTRAS_VERSION, review, focus, rss, prefs, moduleSettings, functionRefs, modules, site };
}

const rowsOf = <T extends z.ZodType>(shape: T) => z.array(shape).max(200_000).catch([]);
const extrasSchema = z.object({
  version: z.number(),
  review: rowsOf(z.object({ node_id: z.string(), state: z.string(), previous_state: z.string().nullable(), updated_at: z.string() })),
  focus: rowsOf(z.object({ task_id: z.string().nullable(), started_at: z.string(), ended_at: z.string().nullable(), note: z.string().max(500) })),
  rss: rowsOf(z.object({
    id: z.string(), space_id: z.string(), title: z.string(), url: z.string(), fetch_interval_minutes: z.number().int().min(1), embed: z.boolean(), always_fulltext: z.boolean(),
    auto_dismiss_days: z.number().int().min(1).nullable(), auto_tag_id: z.string().nullable(), default_tag_ids: z.array(z.string()).nullable(), default_parent_id: z.string().nullable(),
  })),
  prefs: rowsOf(z.object({ key: z.string(), value: z.unknown() })),
  moduleSettings: rowsOf(z.object({ tag_id: z.string(), settings: z.unknown() })),
  functionRefs: rowsOf(z.object({
    holder_node_id: z.string().nullable(), holder_space_id: z.string().nullable(), function_id: z.string().min(1).max(64),
    config: z.record(z.string(), z.unknown()).catch({}),
  })),
  modules: z.object({ modules: z.array(z.string()).nullable(), modules_off: z.array(z.string()), modules_confirmed: z.array(z.string()).nullable() }).nullable().catch(null),
  site: z.object({ title: z.string(), home_node_id: z.string().nullable(), payload: z.unknown(), artifact_ref: z.string().nullable(), created_at: z.string() }).nullable().catch(null),
});

/** The file as an upload gave it, or null when it is not an extras file. A row
 *  of a shape this code does not know is dropped, not the whole file. */
export function parseExtras(raw: unknown): BackupExtras | null {
  const parsed = extrasSchema.safeParse(raw);
  return parsed.success ? parsed.data as BackupExtras : null;
}

export type ExtrasImport = { review: number; focus: number; rss: number; prefs: number; moduleSettings: number; modules: boolean; site: boolean; /** Functions of tags or spaces that did not come across. */ functionsLeftOut: number };

/** Write the functions a backup's tags (and, in a move, spaces) provided. `ids` maps a backup tag id to its id here, `spaces`
 *  a backup space id to the new one; `only` limits it to holders the restore just made (an ordinary restore never touches a
 *  tag that was already here). A function whose settings name the tag they come from (`source_tag_id`) follows that tag to
 *  its new id, or, when it was not restored, becomes the holder's own. A row whose holder did not come across is counted in
 *  `left_out`, so the restore can say so instead of dropping it. */
export async function importFunctionRefs(
  workspaceId: string, by: ActorCtx, refs: BackupExtras["functionRefs"], ids: Map<string, string>, spaces: Map<string, string>, only?: ReadonlySet<string>,
): Promise<{ written: number; left_out: number }> {
  const result = { written: 0, left_out: 0 };
  for (const r of refs) {
    if (only && !(r.holder_node_id && only.has(r.holder_node_id))) continue;
    const holderNode = r.holder_node_id ? ids.get(r.holder_node_id) ?? null : null;
    const holderSpace = r.holder_space_id ? spaces.get(r.holder_space_id) ?? null : null;
    if ((holderNode === null) === (holderSpace === null)) { result.left_out++; continue; } // exactly one holder, and it came across
    // The tag a function takes its settings from is one of the restored ones, else the function has its own.
    const { source_tag_id: source, ...rest } = r.config;
    const sourceHere = typeof source === "string" ? ids.get(source) ?? null : null;
    const config = sourceHere ? { ...rest, source_tag_id: sourceHere } : rest;
    // A reference the restore already made for this holder (a tag's own module function) is kept as it is.
    await db.insertInto("function_refs").values({
      workspace_id: workspaceId, function_id: r.function_id, holder_node_id: holderNode, holder_space_id: holderSpace,
      config: JSON.stringify(config), created_by: carriedActorId(by),
    }).onConflict((c) => c.doNothing()).execute();
    result.written++;
  }
  return result;
}

/** The id each of the backup's subscriptions has in the new workspace: its own when no subscription here holds it, else a new one
 *  (on the server it came from it is always held, by the subscription that was left behind). Only subscriptions whose space came
 *  across are listed. Decided before the notes are written, because a note saved from a feed names it in `_rss_source`. */
export async function planRssIds(extras: BackupExtras, spaces: ReadonlyMap<string, string>): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const r of extras.rss) {
    if (!spaces.has(r.space_id)) continue;
    const taken = await db.selectFrom("rss_subscriptions").select("id").where("id", "=", r.id).executeTakeFirst();
    ids.set(r.id, taken ? randomUUID() : r.id);
  }
  return ids;
}

/** Write `extras` into the workspace of `by` (a move into a new workspace,
 *  inside the restore's transaction). `ids` maps a backup note id to its id here,
 *  `spaces` a backup space id to the new one; a row naming one that was not
 *  restored is skipped. */
export async function importExtras(
  workspaceId: string, by: ActorCtx, extras: BackupExtras, ids: Map<string, string>, spaces: Map<string, string>, owner: boolean,
  rssIds?: ReadonlyMap<string, string>,
): Promise<ExtrasImport> {
  // `actorId` keys the restorer's own personal rows (whose they are); a carried "who did this" column records carriedActorId(by) (spine/authority.ts).
  const actorId = by.id;
  const done: ExtrasImport = { review: 0, focus: 0, rss: 0, prefs: 0, moduleSettings: 0, modules: false, site: false, functionsLeftOut: 0 };
  const mapped = (id: string | null) => (id ? ids.get(id) ?? null : null);

  for (const r of extras.review) {
    const nodeId = mapped(r.node_id);
    if (!nodeId || !Number.isFinite(Date.parse(r.updated_at))) continue;
    await db.insertInto("review_states").values({ workspace_id: workspaceId, node_id: nodeId, actor_id: actorId, state: r.state, previous_state: r.previous_state, updated_at: r.updated_at })
      .onConflict((c) => c.columns(["node_id", "actor_id"]).doUpdateSet({ state: r.state, previous_state: r.previous_state, updated_at: r.updated_at })).execute();
    done.review++;
  }
  for (const r of extras.focus) {
    if (!Number.isFinite(Date.parse(r.started_at)) || (r.ended_at && (!Number.isFinite(Date.parse(r.ended_at)) || Date.parse(r.ended_at) < Date.parse(r.started_at)))) continue;
    await db.insertInto("focus_sessions").values({ id: randomUUID(), workspace_id: workspaceId, actor_id: actorId, task_id: mapped(r.task_id), started_at: r.started_at, ended_at: r.ended_at, note: r.note }).execute();
    done.focus++;
  }
  const subscriptionIds = rssIds ?? await planRssIds(extras, spaces);
  for (const r of extras.rss) {
    const spaceId = spaces.get(r.space_id);
    const subscriptionId = subscriptionIds.get(r.id);
    if (!spaceId || !subscriptionId) continue;
    // The id was decided with the notes (planRssIds): the notes saved from this feed name it.
    await db.insertInto("rss_subscriptions").values({
      id: subscriptionId, workspace_id: workspaceId, space_id: spaceId, title: r.title, url: r.url, created_by_actor_id: carriedActorId(by),
      fetch_interval_minutes: r.fetch_interval_minutes, embed: r.embed, always_fulltext: r.always_fulltext, auto_dismiss_days: r.auto_dismiss_days,
      auto_tag_id: mapped(r.auto_tag_id), default_tag_ids: r.default_tag_ids ? r.default_tag_ids.map((t) => mapped(t)).filter((t): t is string => !!t) : null,
      default_parent_id: mapped(r.default_parent_id),
    }).execute();
    done.rss++;
  }
  for (const r of extras.prefs) {
    if (!isPrefKey(r.key)) continue;
    const checked = parsePref(r.key, r.value);
    if (!checked.ok) continue;
    const value = JSON.stringify(checked.value);
    await db.insertInto("actor_prefs").values({ actor_id: actorId, key: r.key, value, edited_at: new Date().toISOString() })
      .onConflict((c) => c.columns(["actor_id", "key"]).doUpdateSet({ value, updated_at: new Date().toISOString(), edited_at: new Date().toISOString() })).execute();
    done.prefs++;
  }
  for (const r of extras.moduleSettings) {
    const tagId = mapped(r.tag_id);
    if (!tagId || !r.settings || typeof r.settings !== "object") continue;
    const settings = JSON.stringify(r.settings);
    await db.insertInto("actor_module_settings").values({ actor_id: actorId, tag_id: tagId, settings })
      .onConflict((c) => c.columns(["actor_id", "tag_id"]).doUpdateSet({ settings, updated_at: new Date().toISOString() })).execute();
    done.moduleSettings++;
  }
  done.functionsLeftOut = (await importFunctionRefs(workspaceId, by, extras.functionRefs, ids, spaces)).left_out;
  if (owner && extras.modules) {
    await db.updateTable("workspaces").set({
      modules: extras.modules.modules ? JSON.stringify(extras.modules.modules) : null,
      modules_off: JSON.stringify(extras.modules.modules_off),
      modules_confirmed: extras.modules.modules_confirmed ? JSON.stringify(extras.modules.modules_confirmed) : null,
    }).where("id", "=", workspaceId).execute();
    done.modules = true;
  }
  if (owner && extras.site) {
    const cursor = (await db.selectFrom("domain_events").select(db.fn.max("id").as("last")).where("workspace_id", "=", workspaceId).executeTakeFirst())?.last ?? 0;
    await db.insertInto("publish_snapshots").values({
      workspace_id: workspaceId, title: extras.site.title, home_node_id: mapped(extras.site.home_node_id), event_cursor: String(cursor),
      payload: JSON.stringify(extras.site.payload ?? {}), artifact_ref: extras.site.artifact_ref, created_at: extras.site.created_at,
    }).execute();
    done.site = true;
  }
  return done;
}
