import type { ComponentType, LazyExoticComponent } from "react";
import type { LucideIcon } from "lucide-react";
import type { ContentNode, Tag } from "./api";
import { nodeTagIds } from "./nodeTags";
import { isNote } from "@onden/markdown/contract";

/** A module id switchable per tag; registered ones are listed in modules/index.ts. */
export type TagModule = string;

/** How a tag function presents itself on tag pages. `title` and `description`
 *  are i18n keys, translated where they are rendered. */
export type TagFunctionSpec = {
  id: TagModule;
  /** The module that provides it, when that is not `id` (the tasks module
   *  gives a tag two functions of its own). The function acts only while that
   *  module is on. */
  module?: TagModule;
  /** The function has no module tag of its own: adding it needs no tag to point at. */
  switchOnly?: boolean;
  title: string;
  /** What the function does for the notes, as a result (not the mechanism). */
  description: string;
  Icon: LucideIcon;
  /** Offered on a block: writes the function's own tag into the block's
   *  `{…}` (block nodes, docs/architecture/block-nodes.md), so
   *  「加上 → 複習卡」 on a paragraph and the 「功能」 chip on a tag that
   *  already holds it are one registration. `label` is an i18n key. */
  blockAction?: { label: string; Icon: LucideIcon };
  /** A panel the tag page can open while the function is enabled (labels are
   *  i18n keys). */
  panel?: { openLabel: string; closeLabel: string; Component: LazyExoticComponent<ComponentType<TagPanelProps>> };
  /** The function's settings, shown under 「設定」 on its card. They belong to
   *  the tag the function comes from (the module tag, for a tag extending it). */
  settings?: LazyExoticComponent<ComponentType<TagSettingsProps>>;
};

export type TagSettingsProps = {
  /** The tag the settings are stored on. */
  tag: Tag;
  online: boolean;
  /** Only an administrator changes them; others read them. */
  canManage: boolean;
  onSaved?: () => void;
};

export type TagPanelProps = {
  tagId: string;
  tagName: string;
  online: boolean;
  onOpenNode: (id: string) => void;
  onChanged?: () => void;
};
export type TagModuleBehaviour = Record<string, unknown> & {
  modules?: Partial<Record<TagModule, { enabled: boolean }>>;
};

export type TagAbilities = Pick<Tag, "schema_module" | "effective_modules" | "functions"> & Partial<Pick<Tag, "schema_behaviour">>;

/** A tag's functions as the server sent them (function references). A catalog row from before they were
 *  sent (a copy kept on this device from the previous release, until the next sync replaces it) lists
 *  `effective_modules` and the per-tag switch instead, each counted as the tag's own. */
export function tagFunctions(tag: Pick<Tag, "id" | "effective_modules" | "functions"> & Partial<Pick<Tag, "schema_module" | "schema_behaviour">>): NonNullable<Tag["functions"]> {
  if (tag.functions) return tag.functions;
  const ids = new Set(tag.effective_modules ?? []);
  if (tag.schema_module) ids.add(tag.schema_module);
  for (const [id, value] of Object.entries(tag.schema_behaviour?.modules ?? {})) if (value?.enabled === true) ids.add(id);
  return [...ids].map((id) => ({ id, source_tag_id: tag.id, ref_id: null }));
}

/** Whether notes with this tag get `module`: the tag is the module's tag or has the function.
 *  Import status is the caller's filter. */
export function tagHasModule(tag: TagAbilities & Partial<Pick<Tag, "id">>, module: TagModule): boolean {
  if (Array.isArray(tag.effective_modules)) return tag.effective_modules.includes(module);
  return tag.schema_module === module || (tag.functions ?? []).some((fn) => fn.id === module) || tag.schema_behaviour?.modules?.[module]?.enabled === true;
}

/** The module a tag function belongs to: switching it on or off, and whether
 *  it acts, are the module's. */
export function functionModule(fn: Pick<TagFunctionSpec, "id" | "module">): TagModule {
  return fn.module ?? fn.id;
}

/** The module's tag (#複習 for review), if the workspace has one. */
export function moduleTagOf(tags: readonly Tag[], module: TagModule): Tag | null {
  return tags.find((tag) => tag.schema_module === module) ?? null;
}

/** The tag a tag's `module` settings live on: the tag its function reference names (the module's tag for
 *  a tag that added the function). Null when that tag is not visible here. */
export function abilitySource(tags: readonly Tag[], tagId: string, module: TagModule): Tag | null {
  const tag = tags.find((candidate) => candidate.id === tagId);
  if (!tag) return null;
  if (tag.schema_module === module) return tag;
  const source = tagFunctions(tag).find((fn) => fn.id === module)?.source_tag_id;
  return source ? tags.find((candidate) => candidate.id === source) ?? null : null;
}

/** The tags that extend `tagId` at any depth, not including it (what can no
 *  longer be inherited without a cycle). Membership is nodeTags.memberTagIds. */
export function tagsExtending(tags: readonly Pick<Tag, "id" | "schema_extends">[], tagId: string): string[] {
  const children = new Map<string, string[]>();
  for (const tag of tags) {
    for (const parent of tag.schema_extends ?? []) children.set(parent, [...(children.get(parent) ?? []), tag.id]);
  }
  const found = new Set<string>();
  for (const queue = [tagId]; queue.length;) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (child !== tagId && !found.has(child)) { found.add(child); queue.push(child); }
    }
  }
  return [...found];
}

/** Only direct tag membership grants this UI capability: a tag path's
 *  ancestors and text that resembles a hashtag are not membership (a tag that
 *  extends another is — the extending tag is on the note). Authorization
 *  stays server-side. */
export function tagsProvidingModule(node: ContentNode, tags: Tag[], module: TagModule): Tag[] {
  if (!isNote(node)) return [];
  const memberships = new Set(nodeTagIds(node));
  return tags.filter((tag) => memberships.has(tag.id) && tagHasModule(tag, module));
}

export function nodeHasTagModule(node: ContentNode, tags: Tag[], module: TagModule): boolean {
  return tagsProvidingModule(node, tags, module).length > 0;
}
