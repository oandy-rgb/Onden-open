// Node-level questions under the space rule (docs/architecture/spaces.md):
//
//   a node is readable ⇔ it is a global tag definition, or its space is readable
//   a node is writable ⇔ its space is writable; a tag definition is in no
//                        space — changing it is the workspace owner's
//                        (spine/authority.ts)
//
// What "a space is readable / writable" means — member roles, the token's
// lists, the external_ai switch — is spaceAccess.ts and nowhere else; this
// module only applies it to notes. No dependency on readPolicy.ts (which calls
// into this module).

import { sql } from "kysely";
import { q } from "../db.js";
import { db } from "../dbKysely.js";
import type { ActorCtx } from "../types.js";
import { readableSpaceIdsSql, spaceAccess, workspaceOwnerSql, writableSpaceIds, writableSpaceIdsSql } from "./spaceAccess.js";
import { taskHostLiveSql } from "./taskIdentity.js";
import { liveNodeSql, tagNodeSql } from "./nodeSql.js";

/** The space read rule as a predicate on node alias `alias`. */
export function spaceScopeSql(actor: ActorCtx | null, alias: string, params: unknown[]): string {
  return `(${tagNodeSql(alias)} OR ${alias}.space_id IN (${readableSpaceIdsSql(actor, params)}))`;
}

/** Node ids `actor` may read under the space rule (live by default). */
export async function spaceReadableNodeIds(
  actor: ActorCtx | null, workspaceId: string, lifecycle: "live" | "trashed" | "any" = "live",
): Promise<Set<string>> {
  const params: unknown[] = [workspaceId];
  const scope = spaceScopeSql(actor, "n", params);
  const life = lifecycle === "live" ? `AND ${liveNodeSql("n")} AND ${taskHostLiveSql("n")}` : lifecycle === "trashed" ? "AND n.deleted_at IS NOT NULL" : "";
  const r = await q<{ id: string }>(`SELECT n.id FROM content_nodes n WHERE n.workspace_id = $1 ${life} AND ${scope}`, params);
  return new Set(r.rows.map((row) => row.id));
}

/** Can `actor` read node `nodeId` under the space rule? */
export async function spaceCanRead(actor: ActorCtx | null, nodeId: string, lifecycle: "live" | "retained"): Promise<boolean> {
  const params: unknown[] = [nodeId];
  const scope = spaceScopeSql(actor, "n", params);
  const life = lifecycle === "live" ? `AND ${liveNodeSql("n")} AND ${taskHostLiveSql("n")}` : "";
  const r = await q(`SELECT 1 FROM content_nodes n WHERE n.id = $1 ${life} AND ${scope}`, params);
  return r.rows.length > 0;
}

/** Can `actor` write node `nodeId` (its space is writable by them)? Always
 *  false for a global tag definition, which belongs to no space. */
export async function spaceCanWrite(actor: ActorCtx, nodeId: string, lifecycle: "live" | "retained"): Promise<boolean> {
  const params: unknown[] = [nodeId];
  const life = lifecycle === "live" ? `AND ${liveNodeSql("n")} AND ${taskHostLiveSql("n")}` : "";
  const r = await q(
    `SELECT 1 FROM content_nodes n WHERE n.id = $1 ${life}
        AND n.space_id IN (${writableSpaceIdsSql(actor, params)}) LIMIT 1`,
    params,
  );
  return r.rows.length > 0;
}

/** Is `nodeId` a global tag definition (a class_tag, live or trashed)? It
 *  belongs to no space. */
export async function isTagDefinition(nodeId: string): Promise<boolean> {
  const r = await q(`SELECT 1 FROM content_nodes WHERE id = $1 AND ${tagNodeSql()}`, [nodeId]);
  return r.rows.length > 0;
}

/** Live node ids that may go on the public site under the space rule: in a
 *  space whose `publish` switch is on (a note kept off by its own `_published` 'false' is left out by
 *  the publishing code itself). The site is the workspace owner's (owner
 *  2026-11-14): a personal space of anyone else never qualifies, even with the
 *  switch already on, so no data fix is needed for switches set before. */
export async function publishableSpaceNodeIds(workspaceId: string): Promise<Set<string>> {
  const r = await q<{ id: string }>(
    `SELECT n.id FROM content_nodes n JOIN spaces s ON s.id = n.space_id AND s.deleted_at IS NULL
       JOIN workspaces w ON w.id = n.workspace_id
       LEFT JOIN actors o ON o.id = s.owner_actor_id
      WHERE n.workspace_id = $1 AND ${liveNodeSql("n")} AND s.capabilities->>'publish' = 'true'
        AND (s.kind <> 'personal' OR (o.id IS NOT NULL AND ${workspaceOwnerSql("o", "w")}))`,
    [workspaceId],
  );
  return new Set(r.rows.map((row) => row.id));
}

/** The subset of `ids` whose space allows `capability`. */
export async function filterByCapability(workspaceId: string, capability: "backup" | "external_ai", ids: Set<string>): Promise<Set<string>> {
  const r = await q<{ id: string }>(
    `SELECT n.id FROM content_nodes n JOIN spaces s ON s.id = n.space_id
      WHERE n.workspace_id = $1 AND (s.capabilities->>$2) = 'true'`, [workspaceId, capability]);
  const allowed = new Set(r.rows.map((row) => row.id));
  return new Set([...ids].filter((id) => allowed.has(id)));
}

/** The live shared spaces whose switch for `capability` is on (the spaces AI may read, for "external_ai").
 *  Spaces, not notes: filterByCapability is the note-level twin. */
export async function sharedSpaceIdsWithCapability(workspaceId: string, capability: "backup" | "external_ai"): Promise<string[]> {
  const rows = await db.selectFrom("spaces").select(sql<string>`id::text`.as("id"))
    .where("workspace_id", "=", workspaceId).where("kind", "=", "shared").where("deleted_at", "is", null)
    .where(sql<boolean>`(capabilities->>${capability}) = 'true'`).orderBy("id").execute();
  return rows.map((row) => row.id);
}

/** Can `actor` write in at least one space? Every person can (they manage
 *  their personal space); a token needs a space in its write scope with
 *  external_ai on. The bar for creating content before its space is chosen
 *  (spine `any_space_write`) and for writes not tied to one note yet. */
export async function canWriteSomewhere(actor: ActorCtx): Promise<boolean> {
  return (await writableSpaceIds(actor)).length > 0;
}

/** Can `actor` write into space `spaceId`? */
export async function spaceWritable(actor: ActorCtx, spaceId: string): Promise<boolean> {
  return (await spaceAccess(actor, spaceId))?.write === true;
}
