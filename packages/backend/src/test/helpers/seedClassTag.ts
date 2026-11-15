// Shared test fixture for "a class tag that owns a schema" — a single class_tag
// content_node with the schema folded onto it (content_nodes.tag_schema jsonb),
// exactly as a real schema write produces post-P4.1-CONTRACT. There is
// no collection_schemas row and no tag_schema_id; the collection id IS the node id.
//
// Why a helper: ~30 integration tests hand-roll this with slightly different
// column lists. Routing them through one function meant the CONTRACT (DROP
// collection_schemas, write tag_schema on the node) changed this single seam
// instead of touching 30 files.
//
// Callers pass their own `slug`/`nodeSlug` so per-test cleanup prefixes (e.g.
// `DELETE ... WHERE slug LIKE 'rs-%'`) keep matching the seeded rows.

import { q } from "../../db.js";
import { buildTagSchema } from "../../services/tagWrites.js";
import { seedQ } from "./seedQ.js";

export type SeedClassTagOpts = {
  /** Schema name (collection_schemas.name) and default node title. */
  name: string;
  /** Schema slug (collection_schemas.slug). Defaults to a slugified `name`. */
  slug?: string;
  fields?: unknown[];
  views?: Record<string, unknown>;
  behaviour?: Record<string, unknown>;
  policy?: Record<string, unknown>;
  description?: string;
  version?: string;
  dependencies?: string[];
  templateChildren?: unknown[];
  blockTemplate?: unknown[];
  /** class_tag node title. Defaults to `name`. */
  title?: string;
  /** class_tag node slug. Defaults to `tag-${slug}`. */
  nodeSlug?: string;
  /** content_nodes.tag_color. */
  color?: string;
  /** content_nodes.markdown. Defaults to ''. */
  markdown?: string;
};

/** Give a tag a function the way the server stores it (a function_refs row), without an event.
 *  `source` is the tag its settings come from (the module tag); omitted means the tag itself. */
export async function giveFunction(workspaceId: string, tagId: string, functionId: string, source?: string): Promise<void> {
  await q(
    `INSERT INTO function_refs (workspace_id, function_id, holder_node_id, config) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING`,
    [workspaceId, functionId, tagId, JSON.stringify(source && source !== tagId ? { source_tag_id: source } : {})],
  );
}

function defaultSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}-]/gu, "") || "collection";
}

/**
 * Insert the class_tag node that IS a collection, with its schema folded onto the
 * node (content_nodes.tag_schema). P4.1 CONTRACT: there is no collection_schemas
 * row and the collection id IS the node id, so `schemaId` and `tagId` are equal —
 * both returned for call-sites that historically distinguished them.
 */
export async function seedClassTag(
  workspaceId: string,
  opts: SeedClassTagOpts,
): Promise<{ schemaId: string; tagId: string }> {
  const slug = opts.slug ?? defaultSlug(opts.name);
  const tagSchema = buildTagSchema({
    name: opts.name,
    slug,
    fields: opts.fields,
    views: opts.views,
    behaviour: opts.behaviour,
    policy: opts.policy,
    description: opts.description,
    version: opts.version,
    dependencies: opts.dependencies,
    templateChildren: opts.templateChildren,
    blockTemplate: opts.blockTemplate,
  });
  const tag = await seedQ<{ id: string }>(
    `INSERT INTO content_nodes
       (workspace_id, source_type, node_type, title, slug, markdown, tag_color, tag_schema)
     VALUES ($1, 'manual', 'class_tag', $2, $3, $4, $5, $6::jsonb)
     RETURNING id`,
    [
      workspaceId,
      opts.title ?? opts.name,
      opts.nodeSlug ?? `tag-${slug}`,
      opts.markdown ?? "",
      opts.color ?? null,
      JSON.stringify(tagSchema),
    ],
  );
  const id = tag.rows[0]!.id;
  // The old per-tag switch (`behaviour.modules.<id>.enabled`) is the seed shorthand for "this tag has the
  // function": it becomes the function reference the server reads (migration 166 does the same to old data).
  const switches = (opts.behaviour?.modules ?? {}) as Record<string, { enabled?: unknown }>;
  for (const [functionId, value] of Object.entries(switches)) {
    if (value?.enabled === true) await giveFunction(workspaceId, id, functionId);
  }
  return { schemaId: id, tagId: id };
}
