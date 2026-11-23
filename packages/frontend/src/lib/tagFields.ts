import { cutToGraphemes, fieldNameClashes, isAttributeKey, newFieldNameClashes, normalizeText, WORD_CHARS, type FieldClashRow } from "@onden/markdown";
import type { SchemaField, Tag } from "./api";

// Field inheritance (docs/architecture/module-library.md rule 2): the fields
// notes with a tag get are its own plus those of every tag it extends, the
// nearest declaration winning — computed by the server (backend services/
// tagFields.ts) and shipped in the catalog as `effective_fields`. Read a tag's
// fields through here whenever the question is "what does a note with this
// tag get"; its own `schema_fields` are only for editing its schema.

export type TagField = SchemaField & { inherited_from?: string };

/** The fields notes with `tag` get (its own when the server sent nothing more). */
export function tagFields(tag: Pick<Tag, "schema_fields" | "effective_fields">): TagField[] {
  return tag.effective_fields ?? tag.schema_fields ?? [];
}

// Same-name fields: a tag may not declare a field name a tag it inherits from
// already gives (the server refuses it: 409 field_name_inherited). The rule is
// @onden/markdown's fieldNameClashes — the one the server applies — read over
// the tag catalog. Only the name (the storage key) counts, not the label.

type CatalogTag = Pick<Tag, "id" | "parent_id" | "schema_extends" | "schema_fields">;
type DraftField = Pick<SchemaField, "name" | "key">;

/** A draft field the editor keeps back: `other` is the tag it clashes with —
 *  one above that gives the name, or (`below`) one under it that declares it. */
export type FieldNameClash = { other: string; below: boolean };

const keyOf = (field: DraftField) => field.name || field.key || "";
const asRow = (tag: CatalogTag, fields: readonly DraftField[] | null | undefined): FieldClashRow => ({
  id: tag.id, parent_id: tag.parent_id ?? null, extends: tag.schema_extends ?? [],
  fields: (fields ?? []).map((field) => ({ name: keyOf(field) })),
});

/** The fields of `draft` — the own fields of `tag` being edited — that may not
 *  be saved, by name. Only clashes the draft creates count: one the catalog
 *  already holds (legacy data) stays saveable, as the server tolerates it. */
export function draftFieldClashes(tag: CatalogTag, draft: readonly DraftField[], catalog: readonly CatalogTag[]): Map<string, FieldNameClash> {
  const others = catalog.filter((other) => other.id !== tag.id);
  const before = [asRow(tag, catalog.find((other) => other.id === tag.id)?.schema_fields ?? tag.schema_fields), ...others.map((other) => asRow(other, other.schema_fields))];
  const after = [asRow(tag, draft), ...before.slice(1)];
  const clashes = new Map<string, FieldNameClash>();
  for (const clash of newFieldNameClashes(before, after)) {
    if (clash.tag === tag.id) clashes.set(clash.field, { other: clash.from, below: false });
    else if (clash.from === tag.id && !clashes.has(clash.field)) clashes.set(clash.field, { other: clash.tag, below: true });
  }
  return clashes;
}

/** Every name `tag` may not take for a new field: the names the tags it
 *  inherits from give and those the tags under it declare. A new field's key
 *  is derived around them. */
export function namesTakenAround(tag: CatalogTag, catalog: readonly CatalogTag[]): string[] {
  // Ask the one rule: give the tag every name in the catalog and see which clash.
  const all = [...new Set(catalog.flatMap((other) => (other.schema_fields ?? []).map(keyOf)))].filter(Boolean);
  const rows = [asRow(tag, all.map((name) => ({ name }))), ...catalog.filter((other) => other.id !== tag.id).map((other) => asRow(other, other.schema_fields))];
  return [...new Set(fieldNameClashes(rows).filter((c) => c.tag === tag.id || c.from === tag.id).map((c) => c.field))];
}

/** A select field's new option list, with its default kept only while it is still one of the options
 *  (the server refuses a default the field does not accept, and a stale one would seed a value no option offers). */
export function selectOptionsPatch(field: { default?: string }, options: string[]): { options: string[]; default: string | undefined } {
  return { options, default: field.default !== undefined && options.includes(field.default) ? field.default : undefined };
}

/** What a number field's default input becomes for typed text: a plain number or nothing
 *  (`1e3` is a number to the browser's number box but not to the server's rule). */
export function numberDefaultFrom(raw: string): string | undefined {
  return /^-?\d+(\.\d+)?$/.test(raw) ? raw : undefined;
}

const NON_KEY_RUN = new RegExp(`[^${WORD_CHARS}]+`, "gu");
export function fieldKeyFrom(label: string): string {
  const words = normalizeText(label).trim().toLowerCase().replace(NON_KEY_RUN, "_").replace(/^_+|_+$/g, "");
  const key = cutToGraphemes(words, 40).replace(/_+$/, "");
  if (!key) return "field";
  return isAttributeKey(key) ? key : `f_${key}`;
}

/** `base`, or `base_2`, `base_3`… — the first key not in `taken` (the tag's other fields and the names around it). */
export function uniqueFieldKey(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let key = base, n = 2;
  while (used.has(key)) key = `${base}_${n++}`;
  return key;
}
