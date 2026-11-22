// What a tag page shows about one tag: its definition, and what deleting it
// would affect. Both answer null for a tag the reader cannot see (canSeeTag),
// the same as for a missing one — no existence oracle. routes/tags.ts parses,
// calls these and answers.

import { pool } from "../db.js";
import { isWorkspaceOwner } from "../spine/authority.js";
import type { ActorCtx } from "../types.js";
import { trashSubtreeIds } from "./nodeTrash.js";
import { canSeeTag, readableScopeSql } from "./readPolicy.js";
import { liveTagNodeSql, notTagNodeSql, tagNodeSql } from "../spine/nodeSql.js";
import { tagBlocks } from "./blockNodes.js";

/** Tag `id`'s definition (A1.4: a class_tag IS a node, so name, color, schema
 *  parts, markdown and times all come off its content_nodes row), or null. */
export async function readTagDetail(actor: ActorCtx, workspaceId: string, id: string) {
  if (!(await canSeeTag(actor, id))) return null;
  const result = await pool.query(
    `SELECT n.id, n.title AS name, n.tag_color AS color, CASE WHEN n.tag_schema IS NOT NULL THEN n.id ELSE NULL END AS schema_id,
            n.markdown, n.created_at, n.updated_at,
            n.tag_schema->'fields'    AS fields,
            n.tag_schema->'views'     AS views,
            n.tag_schema->'behaviour' AS behaviour,
            n.tag_schema->>'slug'     AS slug,
            n.tag_schema->>'module'   AS module,
            COALESCE(n.tag_schema->'extends', '[]'::jsonb) AS extends
     FROM content_nodes n
     WHERE n.workspace_id = $1 AND n.id = $2
       AND ${liveTagNodeSql("n")}`,
    [workspaceId, id],
  );
  return result.rows[0] ?? null;
}

/** P2 safe-delete: what deleting tag `tagId` would AFFECT, in plain numbers —
 *  members (notes and paragraphs) losing the tag, schema fields whose values stay behind as free-form
 *  attrs, and the function references that disappear. The delete itself is the
 *  node soft-delete (tag = node; junction rows survive, so undelete restores
 *  everything). Null when the tag is missing or not visible to `actor`.
 *
 *  Member rows are readable-scoped, but the preview also exposes the tag's
 *  title, fields and view count — so the tag itself is gated first. */
export async function tagDeletePreview(actor: ActorCtx, workspaceId: string, tagId: string) {
  if (!(await canSeeTag(actor, tagId))) return null;
  const tag = await pool.query<{ id: string; title: string; has_schema: boolean }>(
    `SELECT id, title, (tag_schema IS NOT NULL) AS has_schema FROM content_nodes
      WHERE id = $1 AND workspace_id = $2 AND ${liveTagNodeSql()}`,
    [tagId, workspaceId],
  );
  if (!tag.rows[0]) return null;

  const memberParams: unknown[] = [tagId];
  const memberScope = readableScopeSql(actor, "n", memberParams);
  const { rows: visibleMembers } = await pool.query<{ id: string; title: string }>(
    `SELECT n.id, n.title FROM node_tags nt
       JOIN content_nodes n ON n.id = nt.node_id
      WHERE nt.tag_id = $1 AND ${memberScope}
      ORDER BY n.updated_at DESC`,
    memberParams,
  );
  const visibleMemberIds = visibleMembers.map((m) => m.id);

  // T7: the delete trashes the tag's whole live subtree (nodeTrash), child
  // tags included — walk the same ids so preview and delete can't drift.
  // Sub-tag names are global (GET /tree lists them unfiltered); items filed
  // under the tag (notes, tasks) are read-scoped like the members above. The unreadable
  // remainder is a bare number, and only for the workspace owner, who is the
  // only one who can delete a tag and so is about to trash it anyway.
  const subtree = await trashSubtreeIds(workspaceId, tagId);
  const { rows: subTags } = await pool.query<{ id: string; name: string }>(
    `SELECT id::text, title AS name FROM content_nodes
      WHERE id = ANY($1::uuid[]) AND ${tagNodeSql()}
      ORDER BY array_position($1::uuid[], id)`,
    [subtree],
  );
  const subTagIds = subTags.map((t) => t.id);
  const notesParams: unknown[] = [subtree];
  const notesScope = readableScopeSql(actor, "n", notesParams);
  const readableItems = Number((await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM content_nodes n
      WHERE n.id = ANY($1::uuid[]) AND ${notTagNodeSql("n")} AND ${notesScope}`,
    notesParams,
  )).rows[0]?.n ?? 0);
  const hiddenDescendants = subtree.length - subTags.length - readableItems;
  // Counted once: a note already in `members` (it carries the tag itself) or
  // filed under the tag (it goes to the Trash) is not also "loses a sub-tag".
  const subMemberParams: unknown[] = [subTagIds, subtree, tagId];
  const subMemberScope = readableScopeSql(actor, "n", subMemberParams);
  const subTagMembers = subTagIds.length === 0 ? 0 : Number((await pool.query<{ n: string }>(
    `SELECT count(DISTINCT n.id)::text AS n FROM node_tags nt
       JOIN content_nodes n ON n.id = nt.node_id
      WHERE nt.tag_id = ANY($1::uuid[]) AND n.id <> ALL($2::uuid[])
        AND NOT EXISTS (SELECT 1 FROM node_tags own WHERE own.node_id = n.id AND own.tag_id = $3)
        AND ${subMemberScope}`,
    subMemberParams,
  )).rows[0]?.n ?? 0);

  let fields: Array<{ name: string; values_count: number }> = [];
  let views = 0;
  if (tag.rows[0].has_schema) {
    // P4.1 CONTRACT: read the schema off the class_tag node's own tag_schema.
    const schema = await pool.query<{ fields: Array<{ name?: string }> | null }>(
      `SELECT tag_schema->'fields' AS fields
         FROM content_nodes WHERE id = $1 AND ${tagNodeSql()} LIMIT 1`,
      [tag.rows[0].id],
    );
    const fieldNames = (schema.rows[0]?.fields ?? []).map((f) => f?.name).filter((n): n is string => !!n);
    if (fieldNames.length > 0 && visibleMemberIds.length > 0) {
      // Scope the value counts to the caller's READABLE members — an unscoped
      // count over all tag members leaks how many read-restricted nodes carry a
      // value (L3). sample_titles + the members count below are scoped the same.
      const counts = await pool.query<{ key: string; n: string }>(
        `SELECT na.key, count(*)::text AS n FROM node_attributes na
          WHERE na.key = ANY($1::text[]) AND na.node_id = ANY($2::uuid[])
          GROUP BY na.key`,
        [fieldNames, visibleMemberIds],
      );
      const byKey = new Map(counts.rows.map((r) => [r.key, Number(r.n)]));
      fields = fieldNames.map((name) => ({ name, values_count: byKey.get(name) ?? 0 }));
    } else {
      fields = fieldNames.map((name) => ({ name, values_count: 0 }));
    }
    const v = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM function_refs WHERE holder_node_id = $1 AND instance <> ''`,
      [tagId],
    );
    views = v.rows[0]?.n ?? 0;
  }

  // Paragraphs carrying the tag itself: the figure the tag page and the sidebar give (blockNodes.tagBlocks).
  const paragraphs = (await tagBlocks(actor, workspaceId, tagId, { limit: 1, offset: 0 }, { direct: true })).total ?? 0;

  const sampleSize = 5;
  return {
    tag: { id: tag.rows[0].id, name: tag.rows[0].title },
    members: visibleMembers.length,
    paragraphs,
    sample_titles: visibleMembers.slice(0, sampleSize).map((m) => m.title),
    fields,
    views,
    sub_tags: subTags,
    sub_tag_members: subTagMembers,
    descendant_items: readableItems,
    ...(await isWorkspaceOwner(actor) ? { hidden_descendants: hiddenDescendants } : {}),
    reversible: true, // node soft-delete; junction rows survive → undelete restores
  };
}
