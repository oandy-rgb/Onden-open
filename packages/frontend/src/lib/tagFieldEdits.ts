import { inferFieldType } from "@onden/markdown";
import type { FieldDef } from "./api";

// Edits to a tag's OWN field list (its schema_fields), as pure functions: the
// caller saves the result with tagSchemaWriter.update(tag.id, { fields }),
// which replaces the whole list (build it from the newest copy you have —
// GAP-132). Defining fields is the tag owner's (lib/capabilities.ts: a
// class_tag is edited by the owner alone); notes fill values only.
//
// Used by the tag page's 「升級成欄位」 (promote a property notes already use)
// and by a note's select field, where the owner may add a new option inline.

/** `fields` plus `key` as a new field whose type is inferred from a value
 *  notes already hold (schema-from-instances: the user declared a fact, the
 *  tag generalizes it). Null when the tag already has a field of that name. */
export function withPromotedField<F extends Pick<FieldDef, "name" | "key">>(
  fields: readonly F[], key: string, sampleValue: string,
): Array<F | FieldDef> | null {
  if (fields.some((field) => (field.name ?? field.key) === key)) return null;
  return [...fields, { name: key, type: inferFieldType(sampleValue) }];
}

/** `fields` with `option` appended to the select field `fieldName`. Null when
 *  there is no such select field, the option is blank, or it already exists. */
export function withSelectOption<F extends Pick<FieldDef, "name" | "key" | "type" | "options">>(
  fields: readonly F[], fieldName: string, option: string,
): F[] | null {
  const value = option.trim();
  const index = fields.findIndex((field) => (field.name ?? field.key) === fieldName && field.type === "select");
  if (!value || index < 0 || (fields[index].options ?? []).includes(value)) return null;
  return fields.map((field, i) => i === index ? { ...field, options: [...(field.options ?? []), value] } : field);
}
