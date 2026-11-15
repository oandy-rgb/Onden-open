import type { ContentNode, Tag } from "./api";
import { isTag } from "@onden/markdown/contract";

/** Project an already read-filtered tag node for UI and the offline mirror.
 * This does not grant access or infer capabilities from a tag's name. */
export function tagFromNode(node: ContentNode): Tag {
  const schema = node.tag_schema as {
    fields?: Tag["schema_fields"]; behaviour?: Tag["schema_behaviour"];
    slug?: string;
    module?: unknown; extends?: unknown;
  } | null;
  return {
    id: node.id, name: node.title, color: node.tag_color ?? "#888888",
    schema_id: schema ? node.id : null,
    schema_fields: schema?.fields ?? null,
    schema_behaviour: schema?.behaviour ?? null,
    schema_slug: schema?.slug ?? null,
    // Module library: the tag's own module and what it extends. Without the
    // catalog there is no effective list (it needs every tag), so abilities
    // fall back to the tag's own module and legacy switches.
    schema_module: typeof schema?.module === "string" ? schema.module : null,
    schema_extends: Array.isArray(schema?.extends) ? schema.extends.filter((id): id is string => typeof id === "string") : [],
    parent_id: node.parent_id, markdown: node.markdown,
    created_at: node.created_at, updated_at: node.updated_at,
  };
}

/** A catalog snapshot is authoritative independently of readable node rows.
 * In particular [] clears revoked metadata and must not be rebuilt from nodes.
 * Omitted snapshots retain compatibility with old node-only sync responses. */
export function applyTagCatalog(
  current: Tag[] | undefined,
  delta: { tags?: Tag[]; nodes: { upsert: ContentNode[]; delete: string[] } },
): Tag[] | undefined {
  if (delta.tags !== undefined) return delta.tags;
  const upserts = delta.nodes.upsert.filter(node => isTag(node));
  if (current === undefined && !upserts.length) return undefined;
  const deleted = new Set(delta.nodes.delete);
  const result = new Map((current ?? []).filter(tag => !deleted.has(tag.id)).map(tag => [tag.id, tag]));
  for (const node of upserts) result.set(node.id, tagFromNode(node));
  return [...result.values()];
}

/** Missing metadata means an older local snapshot; only that case derives a
 * fallback from node rows. A persisted empty catalog remains empty. */
export function restoreTagCatalog(stored: string | undefined, nodes: ContentNode[]): Tag[] {
  if (stored === undefined) return nodes.filter(node => isTag(node)).map(tagFromNode);
  const parsed: unknown = JSON.parse(stored);
  if (!Array.isArray(parsed)) throw new Error("invalid cached tag catalog");
  return parsed as Tag[];
}
