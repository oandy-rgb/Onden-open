import type { Tag } from "../../lib/api";
import { tagPath } from "../../lib/data";
import { listsInTagTree } from "../../lib/tagTree";
import { ancestorsOf, indexById, isUnder } from "../../lib/treeWalk";

/** Where one tag sits among the workspace's tags: lookups, its path, the
 *  parent chain and the parents it may move under. Pure; the page computes it
 *  once per render and hands the parts that need it the whole object. */
export type TagTreeModel = ReturnType<typeof tagTreeModel>;

export function tagTreeModel(tag: Tag, allTags: Tag[]) {
  const tagById = indexById(allTags);
  const tagsWithSelf = tagById.has(tag.id) ? allTags : [tag, ...allTags];
  // Two tags can share a name under different parents (#draft, #proj/draft):
  // the heading and the merge menu show the path so they can be told apart.
  const pathOf = (id: string, name: string) => tagPath(tagsWithSelf, id) || name;
  const parentPath = pathOf(tag.id, tag.name).slice(0, -tag.name.length);
  const parentTag = tag.parent_id ? tagById.get(tag.parent_id) : undefined;
  // 全部標籤 › 書 › 小說: the parent chain, top first.
  const ancestors = ancestorsOf(tagById, tag);
  const ancestorIds = new Set(ancestors.map((above) => above.id));
  const withSelfById = indexById(tagsWithSelf);
  // 「上層」 choices: tags only (T12), not this tag or one under it, not a
  // reserved or view module tag, nor a function (a module tag takes no part
  // in the tag tree), nor a hidden one (lib/tagTree listsInTagTree) unless it
  // already is the parent.
  const parentChoices = allTags.filter((other) => other.id !== tag.id && !isUnder(withSelfById, other.id, tag.id)
    && ((listsInTagTree(other) && !other.schema_module) || other.id === tag.parent_id))
    .map((other) => ({ id: other.id, label: `#${pathOf(other.id, other.name)}` }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { tagById, tagsWithSelf, pathOf, parentPath, parentTag, ancestors, ancestorIds, parentChoices };
}
