// System machinery rows that must stay OUT of user-facing lists: the reserved
// workspace-config tag node and any source_type='system' node (e.g. the Site
// Config note the backend maintains). They are infrastructure, not notes — a
// brand-new user's first sidebar/inbox should never ask them to care.
import { RESERVED_TAGS, TASKS_MODULE_ID, type ReservedTagKey } from "@onden/markdown";
import type { Tag } from "./api";
import { isTag } from "@onden/markdown/contract";


/** The workspace-config tag's reserved key. */
export const SYSTEM_TAG_KEY = RESERVED_TAGS.config;

type TagIdentity = Pick<Tag, "reserved_key" | "schema_module">;

/** Whether `tag` is a reserved tag — the one with role `key`, or any reserved
 *  tag when `key` is omitted. By reserved_key only (T5), as the server
 *  decides it (reservedTagPredicate): a renamed #task is still the task
 *  tag, and a user's #reading/task is an ordinary tag. The
 *  catalog carries the key (GET /api/tags, bootstrap since T3); a local copy
 *  saved before that has none and shows the tag as ordinary until the next
 *  refresh replaces it. */
export function isReservedTag(tag: TagIdentity, key?: ReservedTagKey): boolean {
  if (!tag.reserved_key) return false;
  return key === undefined || tag.reserved_key === key;
}

/** The workspace-config tag, whatever it is titled. */
export function isSystemTag(tag: TagIdentity): boolean {
  return isReservedTag(tag, SYSTEM_TAG_KEY);
}

/** Tags by id, for isSystemNode. */
export function tagsById(tags: readonly Tag[] | undefined): ReadonlyMap<string, TagIdentity> {
  return new Map((tags ?? []).map((tag) => [tag.id, tag]));
}

/** Node rows don't carry the reserved key, so a tag node is looked up in the
 *  tag catalog by id; a tag node missing from it is not known to be the
 *  config tag (its title proves nothing). */
export function isSystemNode(
  n: { id?: string; node_type?: string; source_type?: string },
  tags?: ReadonlyMap<string, TagIdentity>,
): boolean {
  if (n.source_type === "system") return true;
  if (!isTag(n)) return false;
  const tag = n.id ? tags?.get(n.id) : undefined;
  return tag ? isSystemTag(tag) : false;
}

/** Whether the server will refuse to delete or merge `tag` away (409 reserved_tag / module_tag): a reserved tag, the tasks
 *  module's tag, and the own tag of any other module while that module is on (`isImported`: hooks/useModuleFilter, which
 *  counts built-in modules like capture as on). A view module's leftover tag is not (nothing reads it). The one rule
 *  behind every Delete / Merge entry — the tag page ⋯ menu, the sidebar tag tree, a note's action list — mirroring backend
 *  services/reservedTags.ts assertTagDefinitionChange. Offer neither for a locked tag; renaming stays. */
export function isTagDefinitionLocked(
  tag: Pick<Tag, "reserved_key" | "schema_module"> & Partial<Pick<Tag, "view_module">>, isImported: (moduleId: string) => boolean,
): boolean {
  if (tag.reserved_key) return true;
  const module = tag.schema_module;
  if (!module || tag.view_module) return false;
  return module === TASKS_MODULE_ID || isImported(module);
}

/** Ids of the reserved tags (#task, #page, #workspace-config —
 *  any tag with a reserved_key). The server finds them by role, so it refuses
 *  to merge or delete them (409 reserved_tag); they can still be renamed.
 *  Surfaces that offer Delete or Merge leave these out. */
export function reservedTagIds(tags: readonly Pick<Tag, "id" | "reserved_key">[] | undefined): ReadonlySet<string> {
  return new Set((tags ?? []).filter((tag) => !!tag.reserved_key).map((tag) => tag.id));
}
