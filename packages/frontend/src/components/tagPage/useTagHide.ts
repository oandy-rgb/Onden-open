import type { Tag } from "../../lib/api";
import { runBackgroundWrite, tagWriter } from "../../lib/data";
import { isTagShown } from "../../lib/nodeTags";
import { isTagDefinitionLocked } from "../../lib/systemNodes";
import { useModuleFilter } from "../../hooks/useModuleFilter";

/** A reserved tag (#task, #page, …) is found by role, so the server refuses
 *  to merge it on either end or delete it (backend services/reservedTags.ts);
 *  the page offers neither. 「隱藏標籤」 (D104, the owner's): the tag keeps
 *  working, it only leaves lists, chips, suggestions and the site. A reserved
 *  tag is never listed anyway, so it has no such action (`canHide`). */
export function useTagHide(tag: Tag, canManage: boolean) {
  const reserved = !!tag.reserved_key;
  const isImported = useModuleFilter();
  return {
    reserved,
    /** Delete and Merge are not offered: the server refuses them (a module's own tag while the module is on, or reserved). */
    locked: isTagDefinitionLocked(tag, isImported),
    hidden: !isTagShown(tag),
    canHide: canManage && !reserved,
    setHidden: (value: boolean) => runBackgroundWrite(tagWriter.setHidden(tag.id, value)),
  };
}

export type TagHide = ReturnType<typeof useTagHide>;
