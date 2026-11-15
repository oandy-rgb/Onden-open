// Where a saved article goes: its tags (used like folders) and an optional
// parent note. The reader asks at save time (存下來 → 「存到」 sheet) and
// pre-fills the DEFAULT, which comes, in order, from
//
//   1. the source's own default — `default_tag_ids` and `default_parent_id` on
//      its rss_subscriptions row. `default_tag_ids` being non-null is what makes
//      the source default explicit (an empty list = explicitly no tags). A feed
//      subscribed with an `auto_tag` gets that tag as its explicit default at
//      subscribe time (subscriptions.ts), and migration 145 turned the older
//      "tags of the feed note, under the feed note" rule into an explicit one;
//   2. the RSS module's workspace default — `rss_default_tags` /
//      `rss_default_parent` in the workspace config (the Site Config note's
//      attributes, PATCH /api/workspace/config, owner only), set in
//      Settings › Modules › RSS;
//   3. neither: top level, no tags.
//
// The tree rule holds everywhere: a parent is a NOTE (node_type 'content'),
// never a tag. An explicit destination that breaks it is refused
// (DestinationError, 422); a stored default whose tag or parent is gone, is
// not a note, or that this reader cannot see, resolves without it, so a stale
// default never blocks a save.

import { isUuid } from "@onden/markdown";
import { q } from "../../db.js";
import type { ActorCtx } from "../../types.js";
import { readableScopeSql } from "../../services/readPolicy.js";
import { findConfigNodeId } from "../../services/siteConfig.js";
import type { SourceRow } from "./sources.js";
import { liveNodeSql, liveTagNodeSql } from "../../spine/nodeSql.js";
import { isNote } from "@onden/markdown/contract";

export type Destination = { tagIds: string[]; parentId: string | null };
export type DefaultOrigin = "source" | "module" | "none";
export type SaveDefault = Destination & { origin: DefaultOrigin };

/** The workspace config keys of the module default (Settings › Modules › RSS). */
export const MODULE_DEFAULT_KEYS = { tags: "rss_default_tags", parent: "rss_default_parent" } as const;


/** A stored id list ("a,b"), unknown entries dropped, order kept. */
function parseIdList(value: string | null | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((s) => s.trim()).filter((s) => isUuid(s)))];
}

/** A destination someone chose that cannot be used: an unknown tag, or a
 *  parent that is missing or not a note. */
export class DestinationError extends Error {
  readonly status = 422;
  constructor(readonly code: "unknown_tag" | "parent_not_found" | "parent_not_a_note") {
    super(code === "unknown_tag" ? "one of the tags does not exist"
      : code === "parent_not_a_note" ? "the parent must be a note, not a tag" : "the parent note does not exist");
  }
}

/** Refuse (DestinationError) a destination that names a tag that is not a
 *  live tag here, or a parent that is not a live note. Read access to the
 *  parent is checked by the save itself (services/noteCreate). */
export async function assertDestination(workspaceId: string, dest: Destination): Promise<void> {
  if (dest.tagIds.length) {
    const tags = await q<{ id: string }>(
      `SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[])
          AND ${liveTagNodeSql()}`, [workspaceId, dest.tagIds]);
    if (tags.rows.length !== new Set(dest.tagIds).size) throw new DestinationError("unknown_tag");
  }
  if (dest.parentId) {
    const parent = (await q<{ node_type: string }>(
      `SELECT node_type FROM content_nodes WHERE workspace_id = $1 AND id = $2 AND ${liveNodeSql()}`,
      [workspaceId, dest.parentId])).rows[0];
    if (!parent) throw new DestinationError("parent_not_found");
    if (!isNote(parent)) throw new DestinationError("parent_not_a_note");
  }
}

/** The module default as stored (Settings › Modules › RSS), or null when
 *  neither key is set. */
export async function moduleDefault(workspaceId: string): Promise<Destination | null> {
  const config = await findConfigNodeId(workspaceId);
  if (!config) return null;
  const rows = (await q<{ key: string; value: string }>(
    `SELECT key, value FROM node_attributes WHERE node_id = $1 AND key = ANY($2::text[])`,
    [config, [MODULE_DEFAULT_KEYS.tags, MODULE_DEFAULT_KEYS.parent]])).rows;
  if (rows.length === 0) return null;
  const value = new Map(rows.map((r) => [r.key, r.value]));
  return { tagIds: parseIdList(value.get(MODULE_DEFAULT_KEYS.tags)), parentId: parseIdList(value.get(MODULE_DEFAULT_KEYS.parent))[0] ?? null };
}

/** Each source's save default for `actor` (see the file comment for the
 *  order), with tags that are gone and parents that are gone, not notes, or
 *  not readable by `actor` left out. */
export async function saveDefaults(
  actor: ActorCtx | null, workspaceId: string, sources: SourceRow[],
): Promise<Map<string, SaveDefault>> {
  const workspace = await moduleDefault(workspaceId);

  const raw = new Map<string, SaveDefault>();
  for (const source of sources) {
    if (source.default_tag_ids !== null) {
      raw.set(source.id, { origin: "source", tagIds: source.default_tag_ids, parentId: source.default_parent_id });
    } else if (workspace) raw.set(source.id, { origin: "module", ...workspace });
    else raw.set(source.id, { origin: "none", tagIds: [], parentId: null });
  }

  // Keep only what still exists, and parents this reader can see.
  const tagIds = [...new Set([...raw.values()].flatMap((d) => d.tagIds))];
  const liveTags = new Set((await q<{ id: string }>(
    `SELECT id::text FROM content_nodes WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND ${liveTagNodeSql()}`,
    [workspaceId, tagIds])).rows.map((r) => r.id));
  const parentIds = [...new Set([...raw.values()].flatMap((d) => d.parentId ? [d.parentId] : []))];
  const params: unknown[] = [workspaceId, parentIds];
  const scope = readableScopeSql(actor, "n", params);
  const liveParents = new Set((await q<{ id: string }>(
    `SELECT n.id::text FROM content_nodes n WHERE n.workspace_id = $1 AND n.id = ANY($2::uuid[]) AND n.node_type = 'content' AND ${scope}`,
    params)).rows.map((r) => r.id));
  const out = new Map<string, SaveDefault>();
  for (const [id, d] of raw) {
    out.set(id, { origin: d.origin, tagIds: d.tagIds.filter((t) => liveTags.has(t)), parentId: d.parentId && liveParents.has(d.parentId) ? d.parentId : null });
  }
  return out;
}
