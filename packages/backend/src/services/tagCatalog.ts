import { q } from "../db.js";
import type { ActorCtx } from "../types.js";
import { functionIndex, type FunctionIndex } from "./functionRefs.js";
import { extendsIdsOf } from "./tagExtendsList.js";
import { spaceScopeSql } from "../spine/spaceScope.js";
import { effectiveTagFields, type EffectiveField } from "./tagFields.js";
import { isViewLayout } from "./viewLayouts.js";
import { liveNodeSql, liveTagNodeSql } from "../spine/nodeSql.js";

type AbilityColumns = { id: string; parent_id?: string | null; schema_module?: unknown; schema_extends?: unknown; schema_behaviour?: unknown; schema_fields?: unknown };

/** Every live tag row, then the catalog read gate. Adds what the client needs
 * for abilities: the module a tag is the tag of, the tags it extends (only ids
 * this actor can see), its effective modules — computed with every tag, so
 * a module tag the actor cannot see still gives its ability — and its
 * effective fields: its own plus those it inherits from its parent tags and
 * the tags it extends (tagFields.ts). */
/** A tag's function as the client reads it: which function, the tag its settings come from, and its reference row
 *  (null for a view, which is not a reference yet). */
export type CatalogFunction = { id: string; source_tag_id: string; ref_id: string | null };

/** The module a module tag is the tag of (the catalog's `schema_module`); anything else is null. */
function schemaModuleOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null;
}

function withTagAbilities<T extends AbilityColumns>(
  rows: T[], index: FunctionIndex,
): Array<T & { schema_module: string | null; schema_extends: string[]; effective_modules: string[]; functions: CatalogFunction[]; effective_fields: EffectiveField[]; view_module: boolean }> {
  const fields = effectiveTagFields(rows.map((row) => ({ id: row.id, parent_id: row.parent_id, extends: row.schema_extends, fields: row.schema_fields })));
  const visible = rows; // tag definitions are global (docs/architecture/spaces.md)
  const ids = new Set(visible.map((row) => row.id));
  return visible.map((row) => ({
    ...row,
    schema_module: schemaModuleOf(row.schema_module),
    schema_extends: extendsIdsOf(row.schema_extends).filter((id) => ids.has(id)),
    effective_modules: index.idsOf(row.id),
    functions: (index.byTag.get(row.id) ?? []).map((use) => ({ id: use.functionId, source_tag_id: use.sourceTagId, ref_id: use.refId })),
    effective_fields: fields.get(row.id) ?? [],
    // A view module tag (#月曆… left over from before views were function references, migration 188) has no members.
    view_module: isViewLayout(schemaModuleOf(row.schema_module)),
  }));
}

/** The tag catalog: every tag definition (global), with usage counted over the
 * notes the caller can read. The one tag list the client receives: GET
 * /api/tags, the bootstrap payload and the sync delta/membership pages all send
 * these rows, and the client's offline catalog is replaced by whichever
 * bootstrap or delta list arrives, so every sender must ship the same shape. Call
 * within the actor read snapshot when composing with sync/version data. */
export async function readTagCatalog(actor: ActorCtx | null, workspaceId: string) {
  const params: unknown[] = [workspaceId];
  const countScope = spaceScopeSql(actor, "m", params);
  const tagScope = spaceScopeSql(actor, "n", params); // for a tag definition (no space) this is the tag branch alone: a temporary session is not told the names of tags used only in spaces it does not reach
  const result = await q(
    `SELECT n.id, n.title AS name, n.reserved_key, n.tag_color AS color,
            -- Hidden by the owner (「隱藏標籤」, D104): still applied and working,
            -- only left out of tag lists, chips, suggestions and the site.
            n.hidden,
            CASE WHEN n.tag_schema IS NOT NULL THEN n.id ELSE NULL END AS schema_id,
            n.parent_id::text AS parent_id, n.markdown, n.created_at, n.updated_at,
            -- The collection name Website › Collections shows and renames
            -- (one made there keeps its slug as the title).
            n.tag_schema->>'name' AS schema_name,
            n.tag_schema->'fields' AS schema_fields,
            n.tag_schema->'views' AS schema_views,
            n.tag_schema->'behaviour' AS schema_behaviour,
            n.tag_schema->>'slug' AS schema_slug,
            n.tag_schema->>'description' AS schema_description,
            n.tag_schema->>'version' AS schema_version,
            n.tag_schema->'dependencies' AS schema_dependencies,
            n.tag_schema->>'module' AS schema_module,
            n.tag_schema->'extends' AS schema_extends,
            -- The child notes applying this tag creates (templateExpander):
            -- a note template applying the tag leaves that scaffold to it (D69).
            n.tag_schema->'template_children' AS schema_template_children,
            -- usage_count = live notes the caller can read that carry this
            -- tag DIRECTLY (any node type): usage, not membership — child
            -- tags and extenders are not added (members are
            -- tagHierarchy.memberTagIds; the frontend's direct figure is
            -- lib/nodeTags.ts directTagUsage). Only readable notes count: a
            -- tag is global, so an unfiltered count would reveal how many
            -- private notes use it.
            COALESCE(uc.usage_count, 0)::int AS usage_count
       FROM content_nodes n
       -- One aggregate over the readable notes' tag rows, joined once; a
       -- per-tag correlated subquery rescanned node_tags for each of 300 tags.
       LEFT JOIN (
         SELECT nt.tag_id, COUNT(*) AS usage_count
           FROM node_tags nt JOIN content_nodes m ON m.id = nt.node_id AND ${liveNodeSql("m")}
          WHERE ${countScope}
          GROUP BY nt.tag_id
       ) uc ON uc.tag_id = n.id
      WHERE n.workspace_id=$1 AND ${liveTagNodeSql("n")} AND ${tagScope}
      ORDER BY n.title`, params,
  );
  return withTagAbilities(result.rows as Array<AbilityColumns>, await functionIndex(actor, workspaceId));
}
