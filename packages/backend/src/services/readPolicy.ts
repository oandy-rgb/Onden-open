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
import { isWorkspaceOwner } from "../spine/authority.js";
import type { Scope } from "../spine/snapshotTables.js";

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

/** The same read rule for a stamped snapshot (spine/snapshotTables.ts): the notes of spaces `actor` may read, live or in the
 *  trash (a tag definition is readable by every member), the readable spaces, and the actor's own personal rows. `$1` is the
 *  workspace id; each use appends its own params. */
export function snapshotScope(actor: ActorCtx, params: unknown[], ownerSeesSystem = false): Scope {
  const nodeRow = (alias: string) => ownerSeesSystem
    ? `(${spaceScopeSql(actor, alias, params)} OR ${alias}.space_id IN (${SYSTEM_SPACES_SQL}))`
    : spaceScopeSql(actor, alias, params);
  const space = (col: string) => ownerSeesSystem
    ? `(${col} IN (${readableSpaceIdsSql(actor, params)}) OR ${col} IN (${SYSTEM_SPACES_SQL}))`
    : `${col} IN (${readableSpaceIdsSql(actor, params)})`;
  return {
    nodeRow,
    node: (col) => `${col} IN (SELECT x.id FROM content_nodes x WHERE x.workspace_id = $1 AND ${nodeRow("x")})`,
    space,
    person: (col) => `(${col})::text = $${params.push(actor.id)}`,
  };
}

/** The `system` space of the workspace (`$1`): it holds the Site Config note, which no member reads as a note (spine/spaceAccess.ts).
 *  The workspace owner's copy carries it: the settings are the owner's own, and a copy without them is not the same workspace. */
const SYSTEM_SPACES_SQL = `SELECT x.id FROM spaces x WHERE x.workspace_id = $1 AND x.kind = 'system'`;

/** snapshotScope for `actor`, with the system space when `actor` is the workspace owner. Call it inside the read snapshot: it reads
 *  who the owner is at that moment. */
export async function snapshotScopeFor(actor: ActorCtx): Promise<(params: unknown[]) => Scope> {
  const ownerSeesSystem = await isWorkspaceOwner(actor);
  return (params) => snapshotScope(actor, params, ownerSeesSystem);
}

/**
 * The read rule of a change bundle (services/stampedBundle.ts): the snapshot's (snapshotScopeFor), and also the spaces `actor` is a member of that are deleted, with
 * their members and their notes. A snapshot leaves a deleted space out (a new node need not hold it), but a bundle goes to a node that may hold that space: its
 * deletion must reach it (PR "fix/merge-space-follows-parent"; before, a deleted space was outside the reader's scope and the bundle sent nothing of it).
 */
export async function bundleScopeFor(actor: ActorCtx): Promise<(params: unknown[]) => Scope> {
  const base = await snapshotScopeFor(actor);
  return (params) => {
    const s = base(params);
    const deleted = () => `SELECT ds.id FROM spaces ds JOIN space_members dm ON dm.space_id = ds.id AND dm.actor_id::text = $${params.push(actor.id)}
                            WHERE ds.workspace_id = $1 AND ds.deleted_at IS NOT NULL`;
    const nodeRow = (alias: string) => `(${s.nodeRow(alias)} OR ${alias}.space_id IN (${deleted()}))`;
    return {
      ...s,
      nodeRow,
      node: (col) => `${col} IN (SELECT x.id FROM content_nodes x WHERE x.workspace_id = $1 AND ${nodeRow("x")})`,
      space: (col) => `(${s.space(col)} OR ${col} IN (${deleted()}))`,
    };
  };
}

