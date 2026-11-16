// The one shape a node row has on every read surface the client stores:
// bootstrap, the sync delta, sync/nodes and GET /api/nodes/:id. The client
// swaps these rows into its store as they are, so a field missing from one
// surface silently disappears from the node (an edit synced through the delta
// used to drop last_modified_at, breaking Bases "modified" filters).

import { holderViewsSql } from "./functionRefSql.js";
import { liveTagNodeSql } from "../spine/nodeSql.js";

/** Events about a note that are not a change to it: its saved views
 *  (services/noteViews.ts, COLLECTION_VIEW_* aimed at the note so only its
 *  readers see them). A view is presentation — it never makes the note
 *  "last modified" by someone. (A tag's views are aimed at the view,
 *  target_type 'collection_view', so they never counted.) */
export const NOT_A_NOTE_CHANGE_SQL = (alias: string) => `${alias}.event_type NOT LIKE 'COLLECTION\\_VIEW\\_%'`;

/** Event metadata per node, as the `em` relation the columns below read: the
 *  latest actor, the latest change time, and the actors of the last 30 days.
 *  Read from node_event_meta (one row per note and actor, kept current by a
 *  trigger on domain_events; migration 130) — never from the event log. */
export const NODE_EVENT_META_COLUMNS_SQL = `
  (array_agg(m.actor_id ORDER BY m.last_event_at DESC))[1] AS last_actor,
  to_char(max(m.last_event_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_modified_at,
  array_agg(DISTINCT m.actor_id)
    FILTER (WHERE m.last_event_at > now() - interval '30 days') AS recent_actors`;

/** Per-row event metadata for a handful of nodes (index on node_id). Bootstrap
 *  builds the same `em` relation once with a grouped CTE instead. */
export function nodeEventMetaJoinSql(alias: string): string {
  return `LEFT JOIN LATERAL (
    SELECT ${NODE_EVENT_META_COLUMNS_SQL}
      FROM node_event_meta m
     WHERE m.node_id = ${alias}.id::text
  ) em ON true`;
}

/** Every content_nodes column except markdown, in table order. A slim
 *  bootstrap names them so Postgres never reads the bodies (`n.*` then
 *  blanking markdown in JS sorted 20 MB of text on disk at 20k notes). A new
 *  column must be added here; bootstrapSlim.integration.test.ts compares this
 *  list with the table. */
export const NODE_COLUMNS_WITHOUT_MARKDOWN = [
  "id", "workspace_id", "source_type", "node_type", "title", "slug", "created_at", "updated_at",
  "parent_id", "hidden", "order_key", "order_stamp", "presentation", "deleted_at", "deleted_by_event_id",
  "tag_color", "tag_schema", "collection_views", "reserved_key", "anchor_form", "space_id",
] as const;

/** The select list: the node's columns, its class and label tag ids, its
 *  attributes, and the event metadata from `em`. `attrs: false` leaves the
 *  attribute map out (a lean bootstrap sends the typed rows once instead).
 *  `markdown: false` leaves the body out and sends `body_len` (its length in
 *  characters) in its place; the row's `markdown` is then "". */
export function nodeRowColumnsSql(alias: string, { attrs = true, markdown = true }: { attrs?: boolean; markdown?: boolean } = {}): string {
  // `collection_views` is composed from the node's saved-view references (functionRefs, B2): clients get the
  // same array they always had, and the column of that name (frozen since migration 188) is never sent.
  const columns = NODE_COLUMNS_WITHOUT_MARKDOWN.map((c) => c === "collection_views" ? `${holderViewsSql(alias)} AS collection_views` : `${alias}.${c}`);
  const own = markdown
    ? `${columns.join(", ")}, ${alias}.markdown`
    : `${columns.join(", ")}, '' AS markdown, char_length(${alias}.markdown) AS body_len`;
  return `${own},
    COALESCE(
      (SELECT array_agg(t.id)
         FROM node_tags nt JOIN content_nodes t ON t.id = nt.tag_id
          AND ${liveTagNodeSql("t")}
        WHERE nt.node_id = ${alias}.id AND t.tag_schema IS NOT NULL),
      ARRAY[]::uuid[]
    ) AS class_tag_ids,
    COALESCE(
      (SELECT array_agg(t.id)
         FROM node_tags nt JOIN content_nodes t ON t.id = nt.tag_id
          AND ${liveTagNodeSql("t")}
        WHERE nt.node_id = ${alias}.id AND t.tag_schema IS NULL),
      ARRAY[]::uuid[]
    ) AS label_tag_ids,
    ${attrs ? `COALESCE(
      (SELECT jsonb_object_agg(na.key, na.value)
         FROM node_attributes na WHERE na.node_id = ${alias}.id),
      '{}'::jsonb
    ) AS attrs,` : ""}
    em.last_actor AS last_actor,
    em.last_modified_at AS last_modified_at,
    COALESCE(em.recent_actors, ARRAY[]::text[]) AS recent_actors`;
}
