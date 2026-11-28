import { NODE_TYPE } from "@onden/markdown/contract";

/** SQL predicates over `content_nodes` that were written out in hundreds of queries. `alias` is a trusted
 *  table alias from the calling query, never request input; omit it when the query has no alias.
 *  Each returns the exact text the queries used to spell, so a query's plan and its partial-index match
 *  do not change. (`spaces` has its own `deleted_at`; this is not for it.) */
const column = (alias: string | undefined, name: string): string => (alias ? `${alias}.${name}` : name);

/** The node is not in the trash. */
export function liveNodeSql(alias?: string): string {
  return `${column(alias, "deleted_at")} IS NULL`;
}
/** The node is a tag definition. */
export function tagNodeSql(alias?: string): string {
  return `${column(alias, "node_type")} = '${NODE_TYPE.tag}'`;
}
/** The node is not a tag definition (a note or a canvas). */
export function notTagNodeSql(alias?: string): string {
  return `${column(alias, "node_type")} <> '${NODE_TYPE.tag}'`;
}
/** The node is a tag definition that is not in the trash (the pair most tag reads start from). */
export function liveTagNodeSql(alias?: string): string {
  return `${tagNodeSql(alias)} AND ${liveNodeSql(alias)}`;
}

/** The space a node without one counts as in the unique slug index (migration 099 content_nodes_space_slug_uq keys `COALESCE(space_id, NO_SPACE)`; a tag has
 *  no space: content_nodes_derive_space). A query spells that expression with this constant to be answered by the index (spine/noteSlugs.ts freeSlug,
 *  services/wikilinkEdges.ts linkCandidatesSql; issue #2021: as `space_id IS NOT DISTINCT FROM $n` it read every live note of the workspace). */
export const NO_SPACE = "00000000-0000-0000-0000-000000000000";
