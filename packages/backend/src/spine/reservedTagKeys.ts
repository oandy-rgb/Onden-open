// Pure half of services/reservedTags.ts (no imports), so SQL builders that
// the authority layer loads can use it without an import cycle.

import { RESERVED_TAGS, type ReservedTagKey } from "@onden/markdown";
import { liveNodeSql, tagNodeSql } from "./nodeSql.js";
export { RESERVED_TAGS, type ReservedTagKey };

/** Which rows of the reserved tag a predicate matches. `live`: the tag in
 *  use (what tasks, pages and site settings read). `any`: the trashed
 *  tag too — for guards, since restoring or purging the config tag is as
 *  sensitive as editing it. The key survives the trash (the unique index
 *  covers live rows only), so a trashed reserved tag is still found by it. */
export type ReservedTagLifecycle = "live" | "any";

/** THE answer to "is content_nodes `alias` the reserved tag `key`?" (T5): by
 *  its reserved_key only — never by title, so a renamed #page is still the
 *  page tag and a member's own #reading/page is an ordinary tag. (#task was
 *  reserved until migration 135; it is the tasks module's tag now, found by
 *  taskIdentity.hasTaskRefSql. RSS used a
 *  reserved #subscription tag until migration 114; a source is now marked by
 *  `_rss_kind`, modules/rss/sources.ts.) Migration 100 keyed every live reserved tag and the trashed root
 *  config tags; a tag without the key is ordinary until adoptReservedTag
 *  (reservedTags.ts) gives it the role. `alias` and `key` are trusted
 *  constants, never request input; the result has no parameters. */
export function reservedTagPredicate(
  alias: string, key: ReservedTagKey, { lifecycle }: { lifecycle: ReservedTagLifecycle },
): string {
  const live = lifecycle === "live" ? ` AND ${liveNodeSql(alias)}` : "";
  return `(${tagNodeSql(alias)}${live} AND ${alias}.reserved_key = '${key}')`;
}
