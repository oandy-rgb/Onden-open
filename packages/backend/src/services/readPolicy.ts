// Centralized READ authorization (docs/architecture/spaces.md). Every note
// lives in one space; you can read it if you belong to that space (a token:
// and the space is in its read scope and lets external AI in). Tag
// definitions are global and readable by every member. Tags never carry
// permission. Endpoints that return node data go through here instead of
// re-deriving the rule; spine/spaceScope.ts holds the rule itself.

import type { ActorCtx } from "../types.js";
import { q } from "../db.js";
import { taskHostLiveSql } from "../spine/taskIdentity.js";
import { publishableSpaceNodeIds, spaceCanRead, spaceReadableNodeIds, spaceScopeSql } from "../spine/spaceScope.js";
import { readableSpaceIdsSql } from "../spine/spaceAccess.js";
import { liveNodeSql } from "../spine/nodeSql.js";

/** Live node ids the PUBLIC site may serve: notes in spaces whose `publish`
 *  switch is on (a note kept off by its own `_published` 'false' is left out by
 *  the publishing code). */
export async function publiclyReadableNodeIds(workspaceId: string): Promise<Set<string>> {
  return publishableSpaceNodeIds(workspaceId);
}

/** Live node ids `actor` may read. */
export async function readableNodeIdSet(actor: ActorCtx | null, workspaceId: string): Promise<Set<string>> {
  return spaceReadableNodeIds(actor, workspaceId, "live");
}

/** Deleted (trashed) node ids `actor` may read: sync tombstones and History's
 *  "Deleted" view. */
export async function readableTrashedNodeIds(actor: ActorCtx | null, workspaceId: string): Promise<Set<string>> {
  return spaceReadableNodeIds(actor, workspaceId, "trashed");
}

/** The read rule as a push-down SQL predicate on `<alias>` (appends its
 *  params), so authorization happens inside the query — LIMIT/OFFSET land on
 *  already-authorized rows. Equivalent to readableNodeIdSet: live rows only,
 *  and a task only while its host is live. */
export function readableScopeSql(actor: ActorCtx | null, alias: string, params: unknown[]): string {
  return `(${liveNodeSql(alias)} AND ${taskHostLiveSql(alias)} AND ${spaceScopeSql(actor, alias, params)})`;
}

/** The subset of `ids` that are live nodes `actor` may read, checked in one
 *  query (readableScopeSql) instead of loading every readable id. */
export async function readableAmong(actor: ActorCtx, workspaceId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const params: unknown[] = [workspaceId, ids];
  const scope = readableScopeSql(actor, "n", params);
  const r = await q<{ id: string }>(
    `SELECT n.id FROM content_nodes n WHERE n.workspace_id = $1 AND n.id = ANY($2::uuid[]) AND ${scope}`,
    params,
  );
  return new Set(r.rows.map((row) => row.id));
}

/** The same space rule for a row that is not a note but lives in a space (its
 *  own `space_id` column), e.g. an RSS subscription (modules/rss/sources.ts):
 *  readable ⇔ its space is one `actor` may read. A row in a deleted space is
 *  not readable. Appends its params, like readableScopeSql. */
export function readableSpaceScopeSql(actor: ActorCtx | null, alias: string, params: unknown[]): string {
  return `${alias}.space_id IN (${readableSpaceIdsSql(actor, params)})`;
}

/** Drop rows whose node id is outside `allowed` (null = keep all). */
export function restrictRowsToScope<T>(
  rows: T[],
  getId: (row: T) => string,
  allowed: Set<string> | null,
): T[] {
  return allowed === null ? rows : rows.filter((r) => allowed.has(getId(r)));
}

/** Single live node. */
export async function canReadNode(actor: ActorCtx, nodeId: string): Promise<boolean> {
  return spaceCanRead(actor, nodeId, "live");
}

/** A retained (live or trashed) node, for history and restore. Missing or
 *  purged rows are denied. */
export async function canReadRetainedNode(actor: ActorCtx, nodeId: string): Promise<boolean> {
  return spaceCanRead(actor, nodeId, "retained");
}

/** A tag definition: global, readable by every member of any space. Callers
 *  map false to 404. */
export async function canSeeTag(actor: ActorCtx, tagId: string): Promise<boolean> {
  return spaceCanRead(actor, tagId, "live");
}

