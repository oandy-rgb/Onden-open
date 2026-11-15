// The shape of a schema field (tag_schema.fields[]) — one check for every
// door that writes one.
//
// Before this module the shape was checked three ways (depth audit round 13,
// D48): the collections route had its own zod object with nine types (no
// `rating`, so the Collections manager's "Rating (stars)" answered 400) that
// silently dropped keys it did not list (a rating's `max`); the agent's
// proposeTagPack allowed six types; the tag schema PATCH, the pack import and
// the module templates checked nothing, so a field typed "dat" was stored.
// Now:
//
//   * attributeFieldSchema — the field shape. The type list is
//     @onden/markdown ATTRIBUTE_FIELD_TYPES (its one owner); every documented
//     property is typed here and kept, and keys it does not know are kept too
//     (a newer client's property must not be dropped by a save).
//   * fieldShapeProblems / assertFieldShapes — judge a fields array against
//     the stored one. The schema writers (tagWrites insertTagRow and
//     writeTagSchema) are the gate; the routes, the pack import and the agent
//     tool reach tag_schema through them.
//
// A field the schema already stores, exactly as stored, is not judged again:
// a schema saved before this check (a legacy field with an odd type) stays
// saveable as a whole, like a field name from before the key grammar
// (newOffGrammarFieldNames below, D44). A new or changed field follows
// the shape.

import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { ATTRIBUTE_FIELD_TYPES, fieldViolation, isAttributeKey } from "@onden/markdown";

export const attributeFieldSchema = z.looseObject({
  /** The attribute key the field's values are stored under (its grammar is
   *  newOffGrammarFieldNames). */
  name: z.string().min(1),
  label: z.string().optional(),
  type: z.enum(ATTRIBUTE_FIELD_TYPES),
  required: z.boolean().optional(),
  // P2: declared default — seeded as a 'derived' attribute when the tag is
  // applied (services/fieldDefaults.ts); stored as text like every attr value.
  default: z.string().optional(),
  // select: the choices.
  options: z.array(z.string()).optional(),
  // rating: the top of the scale (default 5).
  max: z.number().int().positive().optional(),
  // Datomic-style single vs many. Storage stays one row per (node, key) —
  // for 'many' fields the value is a JSON array string the panel widget
  // parses / serialises. Absent is 'one'.
  cardinality: z.enum(["one", "many"]).optional(),
  // Synthesized attribute (Knuth bottom-up): computed from descendants rather
  // than stored (routes/nodes.ts /:id/rollup-attributes).
  rollup: z.object({
    op: z.enum(["count", "sum", "max", "min"]),
    tag: z.string().optional(),
    attr: z.string().optional(),
  }).optional(),
  // relation: optionally constrain targets to nodes carrying this class-tag
  // (by tag name). Legacy JSON key name kept to avoid a jsonb migration.
  relation_supertag: z.string().optional(),
});

export type AttributeFieldShape = z.infer<typeof attributeFieldSchema>;

/** A schema write whose fields do not have the field shape (400). */
export class InvalidFieldError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid schema fields: ${problems.join("; ")}`);
    this.name = "InvalidFieldError";
  }
}

/** Why `fields` is not a list of schema fields, one line per problem; empty
 *  when it is. Fields equal to one `stored` already holds are not judged.
 *  No list at all (undefined, or null as a schema without the key restores
 *  to) is no fields. */
export function fieldShapeProblems(fields: unknown, stored: unknown): string[] {
  if (fields === undefined || fields === null) return [];
  if (!Array.isArray(fields)) return ["fields must be a list"];
  const kept = Array.isArray(stored) ? stored : [];
  const problems: string[] = [];
  fields.forEach((field, index) => {
    if (kept.some((s) => isDeepStrictEqual(s, field))) return;
    const parsed = attributeFieldSchema.safeParse(field);
    if (parsed.success) {
      // A default is seeded as the value of every note that gets the tag, so it must be a value the field accepts.
      const { default: seeded } = parsed.data;
      const reason = seeded ? fieldViolation(parsed.data, seeded) : null;
      if (reason) problems.push(`field ${index} ${JSON.stringify(parsed.data.name)}: default: ${reason}`);
      return;
    }
    const name = field && typeof field === "object" && typeof (field as { name?: unknown }).name === "string"
      ? ` ${JSON.stringify((field as { name: string }).name)}` : "";
    for (const issue of parsed.error.issues) {
      const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
      problems.push(`field ${index}${name}: ${path}${issue.message}`);
    }
  });
  return problems;
}

/** Throw InvalidFieldError when fieldShapeProblems finds any. */
export function assertFieldShapes(fields: unknown, stored: unknown): void {
  const problems = fieldShapeProblems(fields, stored);
  if (problems.length) throw new InvalidFieldError(problems);
}

/** Field names in `fields` that `stored` (the fields the schema has now)
 *  lacks and that are outside the attribute key grammar (D44,
 *  @onden/markdown attributeKey.ts): new names whose values an export would
 *  drop. The schema writers (tagWrites) refuse them unless notes already
 *  store values under the name. A name the schema already has keeps it (one
 *  made before the grammar, a CSV column such as "Due Date"). */
export function newOffGrammarFieldNames(fields: unknown, stored: unknown): string[] {
  const nameOf = (f: unknown) => (f && typeof f === "object" && typeof (f as { name?: unknown }).name === "string" ? (f as { name: string }).name : null);
  const known = new Set(Array.isArray(stored) ? stored.map(nameOf) : []);
  return (Array.isArray(fields) ? fields : []).map(nameOf)
    .filter((name): name is string => name !== null && !known.has(name) && !isAttributeKey(name));
}
