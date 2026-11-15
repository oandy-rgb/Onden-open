import { isEditorStorageAttr, isSystemAttr } from "@onden/markdown";
import type { ContentNode, FieldDef, Tag } from "./api";
import { tagFields } from "./tagFields";

/** Whether an attribute key is a property a person reads: not system-reserved
 *  (`_` prefix) and not an editor's own storage (large JSON / URL payloads
 *  that drive the alternate views). The one test every property list and
 *  column asks. */
export function isShownPropertyKey(key: string): boolean {
  return !isSystemAttr(key) && !isEditorStorageAttr(key);
}

/** At most this many field columns: the list is an overview. */
const MAX_FIELDS = 8;

/**
 * The fields a set of sibling notes share (a note's sub-notes,
 * docs/architecture/views-as-modules.md 「檢視的來源」): the fields of their
 * tags and their own properties, each counted once per note, kept when at
 * least two of them have it (or the only one does). Tag fields come first, in
 * the tags' order, with their types; plain properties follow by name, as text.
 * None shared → [] (the list shows titles only, a new view title + updated).
 */
export function sharedChildFields(children: readonly ContentNode[], tags: readonly Tag[]): FieldDef[] {
  if (children.length === 0) return [];
  const tagById = new Map(tags.map((tag) => [tag.id, tag]));
  const schema = new Map<string, FieldDef>();
  const count = new Map<string, number>();
  for (const child of children) {
    const names = new Set<string>();
    for (const tagId of child.class_tag_ids ?? []) {
      const tag = tagById.get(tagId);
      if (!tag) continue;
      for (const field of tagFields(tag)) {
        const name = field.name ?? field.key;
        if (!name) continue;
        if (!schema.has(name)) schema.set(name, { ...field, name });
        names.add(name);
      }
    }
    for (const [key, value] of Object.entries(child.attrs ?? {})) {
      if (value != null && String(value).trim() !== "" && isShownPropertyKey(key)) names.add(key);
    }
    for (const name of names) count.set(name, (count.get(name) ?? 0) + 1);
  }
  const needed = Math.min(2, children.length);
  const shared = (name: string) => (count.get(name) ?? 0) >= needed;
  const fromTags = [...schema.values()].filter((field) => shared(field.name));
  const fromProps = [...count.keys()].filter((name) => !schema.has(name) && shared(name)).sort((a, b) => a.localeCompare(b))
    .map((name): FieldDef => ({ name, type: "text" }));
  return [...fromTags, ...fromProps].slice(0, MAX_FIELDS);
}
