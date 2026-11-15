// The same-name field rule (docs/architecture/module-library.md, 「同名欄位禁止」):
// a tag may not declare a field one of the tags it inherits from — its parent
// tags (上層), the module tags of its functions and legacy tag→tag `extends`,
// at any depth — already gives. The server refuses a write that creates such a
// clash (backend services/tagFields.ts); the app's field editor marks the
// field before it is sent. Both ask this one function, over the same rows the
// tag catalog carries, so they cannot disagree on what clashes.
//
// Only the field `name` counts: it is the storage key (node_attributes.key).
// A label is what a field is shown as; two fields may share one ("作者" on
// `author` and on `writer`) and both stay readable.
//
// Data that already clashes (written before the rule, or restored) keeps
// working — the nearest declaration wins — so a write is judged by the clashes
// it adds (`newFieldNameClashes`), never by ones it finds.

/** A tag as the rule reads it. `fields` and `extends` are as stored (anything
 *  not a list counts as empty); a field without a string `name` is ignored. */
export type FieldClashRow = {
  id: string;
  parent_id?: string | null;
  extends?: unknown;
  fields?: unknown;
};

/** `tag` declares `field`, which `from` — a tag it inherits from — gives too. */
export type FieldClash = { tag: string; field: string; from: string };

function fieldNames(value: unknown): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(value)) return names;
  for (const field of value) {
    const name = field && typeof field === "object" ? (field as { name?: unknown }).name : undefined;
    if (typeof name === "string" && name !== "") names.add(name);
  }
  return names;
}

function inheritsFrom(row: FieldClashRow): string[] {
  const ids = Array.isArray(row.extends) ? row.extends.filter((id): id is string => typeof id === "string") : [];
  return row.parent_id ? [row.parent_id, ...ids] : ids;
}

/** Every clash among `rows`: one per (tag, field), naming the nearest tag it
 *  inherits that name from (breadth-first, the parent first at each step).
 *  Missing tags and cycles add nothing. */
export function fieldNameClashes(rows: readonly FieldClashRow[]): FieldClash[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const clashes: FieldClash[] = [];
  for (const row of rows) {
    const own = fieldNames(row.fields);
    if (!own.size) continue;
    const reported = new Set<string>();
    const seen = new Set([row.id]);
    for (let level = inheritsFrom(row); level.length;) {
      const next: string[] = [];
      for (const id of level) {
        if (seen.has(id)) continue;
        seen.add(id);
        const tag = byId.get(id);
        if (!tag) continue;
        for (const name of fieldNames(tag.fields)) {
          if (own.has(name) && !reported.has(name)) {
            reported.add(name);
            clashes.push({ tag: row.id, field: name, from: id });
          }
        }
        next.push(...inheritsFrom(tag));
      }
      level = next;
    }
  }
  return clashes;
}

/** The clashes `after` has that `before` did not: what a write from `before`
 *  to `after` would create. A (tag, field) pair that already clashed stays
 *  tolerated, whichever tag it clashes with now. A tag missing from `before`
 *  is one the write creates. */
export function newFieldNameClashes(before: readonly FieldClashRow[], after: readonly FieldClashRow[]): FieldClash[] {
  const key = (c: FieldClash) => `${c.tag}\u0000${c.field}`;
  const tolerated = new Set(fieldNameClashes(before).map(key));
  return fieldNameClashes(after).filter((c) => !tolerated.has(key(c)));
}
