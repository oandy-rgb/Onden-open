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

/** The tag-definition branch of the read rule, as a predicate on tag alias `alias`.
 *
 *  A tag definition belongs to no space, so for a member it is simply readable: tag names are the workspace's shared vocabulary. A TEMPORARY SESSION
 *  (type 'session') must not learn that other spaces exist, and a tag named only by notes of another space says so: its name is "teach-biology" and
 *  the only notes that carry it are in a space the session was not given. So for a session a tag is reachable unless it is IN USE and not in a space
 *  it reaches: in use = it, or a tag nested under it, is on a live note (a nested tag's path names its parents). A tag nobody uses names nothing (the
 *  session can make and use its own); a reserved tag (task, page…) is the product's own word, not a person's. A tag that is only INHERITED
 *  (`extends`) is not followed: that needs the old schema fields, which only functionRefs.ts reads (guards/functionRefs.guard.test.ts). */
function tagScopeSql(actor: ActorCtx | null, alias: string, params: unknown[]): string {
  if (actor?.type !== "session") return tagNodeSql(alias);
  // Two sets, each computed ONCE per query (not per tag): the tags in use on live notes (everywhere / in the spaces the session reaches), each with every tag above it
  // in the tree. A set of ids read by `IN`, so the cost is two passes over node_tags, not one per tag.
  const inUse = (scope: string) => `(WITH RECURSIVE u(id) AS (
        SELECT nt.tag_id FROM node_tags nt JOIN content_nodes n ON n.id = nt.node_id WHERE ${liveNodeSql("n")}${scope}
        UNION
        SELECT c.parent_id FROM content_nodes c JOIN u ON c.id = u.id WHERE c.parent_id IS NOT NULL AND ${tagNodeSql("c")})
      SELECT id FROM u)`;
  return `(${tagNodeSql(alias)} AND (${alias}.reserved_key IS NOT NULL
      OR ${alias}.id NOT IN ${inUse("")} OR ${alias}.id IN ${inUse(` AND n.space_id IN (${readableSpaceIdsSql(actor, params)})`)}))`;
}

/** The tag definitions (live or in the trash) `actor` is not told about: none for anyone but a temporary session (tagScopeSql). */
export async function hiddenTagIds(actor: ActorCtx, workspaceId: string): Promise<ReadonlySet<string>> {
  if (actor.type !== "session") return new Set();
  const reachable = await spaceReadableNodeIds(actor, workspaceId, "any"); // for a tag definition (it has no space) this is the tag branch alone
  const tags = await db.selectFrom("content_nodes").select("id").where("workspace_id", "=", workspaceId).where(sql<boolean>`${sql.raw(tagNodeSql())}`).execute();
  return new Set(tags.map((row) => row.id).filter((id) => !reachable.has(id)));
}

/** The space read rule as a predicate on node alias `alias`. */
export function spaceScopeSql(actor: ActorCtx | null, alias: string, params: unknown[]): string {
  return `(${tagScopeSql(actor, alias, params)} OR ${alias}.space_id IN (${readableSpaceIdsSql(actor, params)}))`;
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

/** The joins SITE_OWNED_SPACE_SQL reads, for the content_nodes row `n`: its live
 *  space `s`, the workspace `w` and the space's owner `o`. */
export const SITE_SPACE_JOIN = (n: string): string => `JOIN spaces s ON s.id = ${n}.space_id AND s.deleted_at IS NULL
       JOIN workspaces w ON w.id = ${n}.workspace_id
       LEFT JOIN actors o ON o.id = s.owner_actor_id`;

/** A space whose content the site may ever carry: the site is the workspace
 *  owner's (owner 2026-11-14), so a personal space of anyone else never
 *  qualifies. One rule for the pages
 *  (publishableSpaceNodeIds) and for the drawings a published note embeds
 *  (publishing/publishedSet.ts pictureSourceIds). Over SITE_SPACE_JOIN. */
export const SITE_OWNED_SPACE_SQL = `(s.kind <> 'personal' OR (o.id IS NOT NULL AND ${workspaceOwnerSql("o", "w")}))`;

/** Live node ids that may go on the public site under the space rule: in a
 *  space whose `publish` switch is on (a note kept off by its own `_published` 'false' is left out by
 *  the publishing code itself). The site is the workspace owner's (owner
 *  2026-11-14): a personal space of anyone else never qualifies, even with the
 *  switch already on, so no data fix is needed for switches set before. */
export async function publishableSpaceNodeIds(workspaceId: string): Promise<Set<string>> {
  const r = await q<{ id: string }>(
    `SELECT n.id FROM content_nodes n ${SITE_SPACE_JOIN("n")}
      WHERE n.workspace_id = $1 AND ${liveNodeSql("n")} AND s.capabilities->>'publish' = 'true'
        AND ${SITE_OWNED_SPACE_SQL}`,
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
