import type { ContentNode, Tag } from "../../lib/api";
import { draftFieldClashes, namesTakenAround, tagFields } from "../../lib/tagFields";
import type { FieldDef } from "../TagsPanel";
import { promotableProperties } from "./promotable";
import type { TagTreeModel } from "./tagTreeModel";

/** The fields of a tag page: the editable ones (`fields`, possibly newer than
 *  the catalog), the ones inherited, the same-name clashes and the properties
 *  notes could promote. Pure. */
export type FieldModel = ReturnType<typeof tagFieldModel>;

export function tagFieldModel(tag: Tag, fields: FieldDef[], tree: TagTreeModel, nodes: ContentNode[], canManage: boolean) {
  const { tagById, tagsWithSelf } = tree;
  // Fields this tag inherits (lib/tagFields.ts): the server's effective list
  // minus what its own fields — the editable ones, possibly newer than the
  // catalog — declare. Notes with the tag get both.
  const ownNames = new Set(fields.map((f) => f.name ?? f.key));
  const inheritedFields = tagFields(tag).filter((f) => f.inherited_from && !ownNames.has(f.name));
  const allFields = [...fields, ...inheritedFields];
  // Same-name fields (lib/tagFields.ts): the draft fields another tag already
  // has the name of — above, giving it, or below, declaring it. Only those are
  // kept back (marked in the editor); the rest of an edit saves. A legacy clash
  // already stored is not one of them and stays editable.
  const clashesOf = (draft: FieldDef[]) => draftFieldClashes(tag, draft, tagsWithSelf);
  const fieldClashes = new Map([...clashesOf(fields)].map(([name, clash]) => {
    const other = tagById.get(clash.other);
    const field = other?.schema_fields?.find((f) => (f.name || f.key) === name);
    return [name, { tag: other?.name ?? "?", field: field?.label?.trim() || name, below: clash.below }];
  }));
  const takenNames = namesTakenAround(tag, tagsWithSelf);
  // 「升級成欄位」 does not offer a field the tag already gets from its parent
  // or a function (tagFields: server effective_fields), nor a name the same-name
  // rule keeps back: the server would refuse it (409 field_name_inherited).
  const promotable = canManage ? promotableProperties(nodes, tag.id, [...fields, ...tagFields(tag)], tagById)
    .filter(({ key }) => !takenNames.includes(key)) : [];
  // Schema field identifiers — seed a new view's default visible columns and
  // the kanban group-by options. The backend normalizes to `name`; tolerate
  // stale `key` on read.
  const schemaFieldKeys = allFields
    .map((f) => f.name ?? f.key)
    .filter((k): k is string => !!k);
  return { inheritedFields, allFields, clashesOf, fieldClashes, takenNames, promotable, schemaFieldKeys };
}
