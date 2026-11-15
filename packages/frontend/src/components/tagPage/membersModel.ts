import type { ContentNode, Tag } from "../../lib/api";
import { memberTagIds, tagMembers } from "../../lib/nodeTags";
import { tagsExtending } from "../../lib/tagModules";
import type { TagTreeModel } from "./tagTreeModel";

/** Members: the one rule (lib/nodeTags.ts tagMembers) — this tag, its child
 *  tags and the tags extending it, as the tag's saved views and the sidebar
 *  chip that opens this page count them. A #name written in a note's text
 *  is not membership (T10). */
export function tagMembersModel(tag: Tag, allTags: Tag[], tree: TagTreeModel, nodes: ContentNode[]) {
  const extenderIds = tagsExtending(allTags, tag.id);
  const extenders = new Set(extenderIds);
  const childTagIds = memberTagIds(tree.tagsWithSelf, tag.id).filter((id) => id !== tag.id && !extenders.has(id));
  const instances = tagMembers(tree.tagsWithSelf, nodes, tag.id)
    .sort((a, b) => a.title.localeCompare(b.title));
  return { extenderIds, childTagIds, instances };
}
