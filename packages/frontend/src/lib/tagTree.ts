import type { Tag } from "./api";
import { isNoteSwitchTag, isTagShown, tagKind } from "./nodeTags";
import { ALL_MODULES, type ModuleFilter } from "../modules";
import { containsTitle } from "./noteSearch";
import { tagQuery } from "./hashtags";

// The tag tree (T12: separate from the note tree): the tags people file
// notes with, nested by `parent_id`. The Tags page lists it as one list and
// the tag page shows it beside the notes on a wide screen. Left out: the
// system and reserved tags (workspace-config, #task, #page — found by role,
// lib/systemNodes), a view module's tag (#看板, #月曆…), which never has
// notes of its own (views-as-modules.md V4), and a tag the owner hid
// (lib/nodeTags isTagShown — the Tags page lists those in 「已隱藏」).

type TreeTag = Pick<Tag, "id" | "name" | "parent_id" | "reserved_key" | "schema_module"> & Partial<Pick<Tag, "hidden" | "schema_extends">>;

/** One row of the tree: the tag and how deep it sits (0 = top level). */
export type TagTreeRow<T extends TreeTag = Tag> = { tag: T; depth: number; childCount: number };

/** Whether `tag` is listed in the tag tree. */
export function listsInTagTree(tag: TreeTag): boolean {
  return tagKind(tag) !== "system" && isTagShown(tag);
}

const byName = (a: TreeTag, b: TreeTag) => a.name.localeCompare(b.name);

/** The listed tags in tree order: each tag followed by its children, siblings
 *  by name. A tag whose parent is not listed (or missing) is at the top
 *  level; a parent loop is cut where it repeats. */
export function tagTreeRows<T extends TreeTag>(tags: readonly T[], compare: (a: T, b: T) => number = byName): Array<TagTreeRow<T>> {
  const listed = tags.filter(listsInTagTree);
  const ids = new Set(listed.map((tag) => tag.id));
  const children = new Map<string | null, T[]>();
  for (const tag of listed) {
    const parent = tag.parent_id && ids.has(tag.parent_id) && tag.parent_id !== tag.id ? tag.parent_id : null;
    children.set(parent, [...(children.get(parent) ?? []), tag]);
  }
  const rows: Array<TagTreeRow<T>> = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const tag of [...(children.get(parent) ?? [])].sort(compare)) {
      if (seen.has(tag.id)) continue;
      seen.add(tag.id);
      rows.push({ tag, depth, childCount: children.get(tag.id)?.length ?? 0 });
      walk(tag.id, depth + 1);
    }
  };
  walk(null, 0);
  // A loop with no way in from the top (a → b → a): list its tags at the top.
  for (const tag of [...listed].sort(compare)) {
    if (!seen.has(tag.id)) { seen.add(tag.id); rows.push({ tag, depth: 0, childCount: 0 }); }
  }
  return rows;
}

/** The phone's tag order, for siblings at every level: pinned tags first (in
 *  pin order), then the rest by direct note count (most first), ties by name. */
export function pinnedThenUsed<T extends TreeTag>(pinnedIds: readonly string[], usage: ReadonlyMap<string, number>): (a: T, b: T) => number {
  const pinAt = (tag: T) => { const at = pinnedIds.indexOf(tag.id); return at < 0 ? Infinity : at; };
  return (a, b) => {
    const pa = pinAt(a), pb = pinAt(b);
    if (pa !== pb) return pa < pb ? -1 : 1;
    return (usage.get(b.id) ?? 0) - (usage.get(a.id) ?? 0) || byName(a, b);
  };
}

/** How the 標籤 tab orders each level (after the pinned tags). */
export const TAG_SORT_KEYS = ["count", "name"] as const;
export type TagSort = (typeof TAG_SORT_KEYS)[number];

/** Pinned tags first (in pin order), then by name: the 標籤 tab's 名稱 order. */
export function pinnedThenName<T extends TreeTag>(pinnedIds: readonly string[]): (a: T, b: T) => number {
  const pinAt = (tag: T) => { const at = pinnedIds.indexOf(tag.id); return at < 0 ? Infinity : at; };
  return (a, b) => {
    const pa = pinAt(a), pb = pinAt(b);
    return pa !== pb ? (pa < pb ? -1 : 1) : byName(a, b);
  };
}

/** The tags that have a sub-tag in `tags`: what 全部展開 opens. */
export function tagParentIds(tags: readonly Pick<Tag, "id" | "parent_id">[]): string[] {
  const ids = new Set(tags.map((tag) => tag.id));
  return [...new Set(tags.flatMap((tag) => tag.parent_id && tag.parent_id !== tag.id && ids.has(tag.parent_id) ? [tag.parent_id] : []))];
}

/** Whether `tag` may be moved under `parent`: a tag has one parent, so this
 *  MOVES it. Refused: itself, its own descendant (a cycle), and the parent it
 *  already has (nothing to move), and any move that touches a function (a
 *  module tag is not moved and is not a parent). The server refuses the same moves. */
export function canMoveTagUnder(tags: readonly (Pick<Tag, "id" | "parent_id"> & Partial<Pick<Tag, "schema_module">>)[], tagId: string, parentId: string): boolean {
  if (tagId === parentId) return false;
  const byId = new Map(tags.map((tag) => [tag.id, tag]));
  // A function (module tag) is no part of the tag tree: not moved, not a parent.
  if (byId.get(tagId)?.schema_module || byId.get(parentId)?.schema_module) return false;
  if ((byId.get(tagId)?.parent_id ?? null) === parentId) return false;
  const seen = new Set<string>();
  for (let id: string | null | undefined = parentId; id && !seen.has(id); id = byId.get(id)?.parent_id) {
    if (id === tagId) return false;
    seen.add(id);
  }
  return true;
}

/** Whether `sourceId` may be merged into `targetId`: not itself, not one of its own sub-tags (they would become their own
 *  parent once the sub-tags move under the target), not a module tag (a function's tag collects no notes), not a system tag.
 *  The server refuses the same targets (services/tagMerge.ts assertMergeTarget), so the picker never offers one. */
export function canMergeTagInto(
  tags: readonly (Pick<Tag, "id" | "parent_id"> & Partial<Pick<Tag, "schema_module" | "reserved_key">>)[], sourceId: string, targetId: string,
): boolean {
  const target = tags.find((tag) => tag.id === targetId);
  if (!target || target.schema_module || target.reserved_key) return false;
  return !withDescendants(tags, new Set([sourceId])).has(targetId);
}

/** The ids of the tags in `tags` that are `hiddenIds` or sit under one: a
 *  hidden tag takes its sub-tags out of a list with it. */
export function withDescendants(tags: readonly Pick<Tag, "id" | "parent_id">[], hiddenIds: ReadonlySet<string>): Set<string> {
  const byId = new Map(tags.map((tag) => [tag.id, tag]));
  const out = new Set<string>();
  for (const tag of tags) {
    const seen = new Set<string>();
    for (let id: string | null | undefined = tag.id; id && !seen.has(id); id = byId.get(id)?.parent_id) {
      if (hiddenIds.has(id)) { out.add(tag.id); break; }
      seen.add(id);
    }
  }
  return out;
}

/** The rows whose name contains `query` (any case), with their ancestors so
 *  each match keeps its place in the tree. An empty query keeps every row. */
export function filterTagTree<T extends TreeTag>(rows: ReadonlyArray<TagTreeRow<T>>, query: string): Array<TagTreeRow<T>> {
  const q = tagQuery(query);
  if (!q) return [...rows];
  const parentOf = new Map(rows.map((row) => [row.tag.id, row.tag.parent_id ?? null]));
  const keep = new Set<string>();
  for (const row of rows) {
    if (!containsTitle(q, row.tag.name)) continue;
    for (let id: string | null = row.tag.id; id && !keep.has(id); id = parentOf.get(id) ?? null) keep.add(id);
  }
  return rows.filter((row) => keep.has(row.tag.id));
}

/** A name folded for 「名稱相近」: width and case folded, spaces and
 *  separators dropped, a plural -s dropped. */
function foldName(name: string): string {
  const folded = name.normalize("NFKC").toLowerCase().replace(/[\s_\-./·・]+/g, "");
  return folded.length > 3 ? folded.replace(/s$/, "") : folded;
}

/** Edit distance up to 1 (one character added, removed or changed). */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** 「整理」: what the owner may want to tidy, never acted on by itself.
 *  `unused` — listed tags no note carries directly and with no child tag
 *  (a module's own tag is the module's, so not counted); `similar` — pairs
 *  whose names differ only in case, width, separators or a plural, or by
 *  one character in a name of four or more. Two tags with the very same
 *  name under different parents (#draft, #proj/draft) are deliberate. */
export function tagTidyReport<T extends TreeTag>(rows: ReadonlyArray<TagTreeRow<T>>, usage: ReadonlyMap<string, number>): {
  unused: T[];
  similar: Array<[T, T]>;
} {
  const unused = rows.filter((row) => (usage.get(row.tag.id) ?? 0) === 0 && row.childCount === 0 && !row.tag.schema_module).map((row) => row.tag);
  const similar: Array<[T, T]> = [];
  const folded = rows.map((row) => ({ tag: row.tag, key: foldName(row.tag.name) }));
  for (let i = 0; i < folded.length; i++) {
    for (let j = i + 1; j < folded.length; j++) {
      const a = folded[i]!, b = folded[j]!;
      if (a.tag.name === b.tag.name || !a.key || !b.key) continue;
      if (a.key === b.key || (Math.min(a.key.length, b.key.length) >= 4 && withinOneEdit(a.key, b.key))) similar.push([a.tag, b.tag]);
    }
  }
  return { unused, similar };
}

// ── 全部標籤's two sections ───────────────────────────────────────────────
// A module ships its own tag (#複習, #論文): importing the
// module creates it on the server with `schema_module` set to the module id
// (FrontendModule.library.moduleTag, services/tagCatalog). That field is the
// one mark of a module tag; a tag the person made has none, whatever it is
// called and whatever functions it composes (its `schema_extends` /
// `effective_modules`). So a module tag stays under 「功能」 however many
// notes carry it, and #讀書 + 複習 stays the person's.

/** Whether `tag` is a module's own tag (listed under 「功能」). */
export function isModuleShippedTag(tag: Pick<Tag, "schema_module">): boolean {
  return Boolean(tag.schema_module);
}

/** Whether `tag` is a module's own tag whose module is not imported now: the
 *  module was removed (Settings › 模組) and, as removing keeps the data, its
 *  tag and the notes on it stayed. */
export function isRemovedModuleTag(tag: Pick<Tag, "schema_module">, isImported: ModuleFilter = ALL_MODULES): boolean {
  return Boolean(tag.schema_module) && !isImported(tag.schema_module!);
}

/** The listed tags split into the person's own, the tags of the imported
 *  modules (「功能」), the tags left by removed modules (`removed`, listed
 *  under 「整理」, never deleted for the person) and the ones the owner hid
 *  (D104, lib/nodeTags isTagShown — listsInTagTree leaves them out of the
 *  others). Hidden wins: a hidden module tag, of an imported module or a
 *  removed one, is only under `hidden`, so no tag is listed twice. Reserved
 *  and view module tags are in none. */
export function splitTagSections<T extends TreeTag>(tags: readonly T[], isImported: ModuleFilter = ALL_MODULES): {
  own: T[]; fromModules: T[]; removed: T[]; hidden: T[];
} {
  const listed = tags.filter(listsInTagTree);
  const hidden = tags.filter((tag) => !isTagShown(tag) && !isNoteSwitchTag(tag) && tagKind(tag) !== "system").sort(byName);
  const moduleTags = listed.filter(isModuleShippedTag);
  return {
    own: listed.filter((tag) => !isModuleShippedTag(tag)),
    fromModules: moduleTags.filter((tag) => !isRemovedModuleTag(tag, isImported)),
    removed: moduleTags.filter((tag) => isRemovedModuleTag(tag, isImported)).sort(byName),
    hidden,
  };
}
