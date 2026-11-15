// The published site's home page, decided in ONE place (D116). The publish
// candidate (snapshot.ts), the served site (servedSite.applyTakedown: GET
// /api/site, share links, the zip export, the static host push) and so the
// static builders all read the home this returns; no client and no other
// server path picks one. Before, five places chose it with diverging rules: an
// approved agent publish fell back to the oldest published note (a #paper),
// and an unpublished first untagged note let the server open on a tagged one.

import { isUuid } from "@onden/markdown";
import { q } from "../../../db.js";
import { liveNodeSql, notTagNodeSql, tagNodeSql } from "../../../spine/nodeSql.js";

type SitePage = { id?: unknown; slug?: unknown };

/** $1 the workspace, $2 the ids of the pages on the site. Exported so a test can read its plan. */
export const HOME_SQL =
// Pages per space are counted once (a few rows), then looked up per candidate: counting inside the ORDER BY
// scanned the whole site for every candidate (quadratic: 6,000 pages took 8.5 s).
  `WITH pages_in_space AS (
       SELECT space_id, count(*) AS pages FROM content_nodes WHERE id = ANY($2::uuid[]) GROUP BY space_id)
     SELECT w.home_node_id::text AS home,
            (SELECT n.id::text FROM content_nodes n
              LEFT JOIN pages_in_space p ON p.space_id IS NOT DISTINCT FROM n.space_id
              WHERE n.workspace_id = w.id AND n.id = ANY($2::uuid[])
                AND n.hidden = false AND ${liveNodeSql("n")} AND ${notTagNodeSql("n")}
              ORDER BY p.pages DESC NULLS LAST,
                       (n.parent_id IS NULL OR n.parent_id <> ALL($2::uuid[])) DESC,
                       NOT EXISTS (
                         SELECT 1 FROM node_tags nt
                           JOIN content_nodes t ON t.id = nt.tag_id AND ${tagNodeSql("t")}
                            AND ${liveNodeSql("t")} AND t.tag_schema IS NOT NULL
                          WHERE nt.node_id = n.id) DESC,
                       n.slug = 'home' DESC,
                       array_position($2::uuid[], n.id)
              LIMIT 1) AS fallback
       FROM workspaces w WHERE w.id = $1`;

/** The home of a site showing `published` (in site order):
 *    1. `requested`, when it is on the site — an explicit override (the
 *       publish body's home_node_id, an agent's named home, or the home a
 *       snapshot froze, which the served site keeps while it is still shown);
 *    2. the workspace's home (workspaces.home_node_id), when it is on the site;
 *    3. else ONE fallback: the top note of the space that puts the most pages
 *       on the site (owner 2026-11-10: the site is a space, its home that
 *       space's root) — a page whose parent is not on the site, preferring an
 *       untagged one (no schema tag: a paper or a saved article never becomes
 *       the front page by being first), then the page with slug `home`, then
 *       site order.
 *  Null only for an empty site. */
export async function siteHomeFor(
  workspaceId: string,
  published: readonly SitePage[],
  requested?: string | null,
): Promise<string | null> {
  const ids = published.map((n) => n.id).filter((id): id is string => typeof id === "string");
  if (ids.length === 0) return null;
  const onSite = new Set(ids);
  if (requested && onSite.has(requested)) return requested;
  const known = ids.filter(isUuid);
  const r = await q<{ home: string | null; fallback: string | null }>(HOME_SQL,
    [workspaceId, known],
  );
  const row = r.rows[0];
  if (row?.home && onSite.has(row.home)) return row.home;
  return row?.fallback ?? ids[0];
}
