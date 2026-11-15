// P2 tag-schema upgrade: field validation + defaults.
//
// Posture (surface-no-programmer-ui): schema fields ASSIST, they don't
// imprison — a key that matches no schema field on the node's tags is
// free-form and always allowed. Only when a key IS a declared field do its
// declared constraints bite (type shape, select options, required-on-delete).

import { governingField } from "@onden/markdown";
import { effectiveTagFields, loadTagFieldRows } from "./tagFields.js";
import { q } from "../db.js";
import { liveTagNodeSql } from "../spine/nodeSql.js";

/** A field definition as stored (jsonb) and read by the validators: lenient about `type`, since stored rows are not
 *  re-validated here. The shape the server SENDS is @onden/contract FieldDef. */
export type StoredFieldDef = {
  name: string;
  type?: string;
  required?: boolean;
  options?: string[];
  default?: string;
  /** rating fields: the top of the scale (number of stars). Default 5. */
  max?: number;
  /** "many": a list, each element checked against the field
   *  (@onden/markdown fieldViolation, D117). */
  cardinality?: "one" | "many";
};

/** The schema field that governs `key` on this node, by the attribute value
 *  rule (@onden/markdown governingField): of the fields its schema tags
 *  declare under that name (`name` is the single identifier convention, mig
 *  056), the first in tag order — or null when they disagree on the storage
 *  type, so the key is free-form (no field validation, the writer's type).
 *  Free-form means none of those fields' checks apply either: a `required`
 *  or a select's `options` on one of the disagreeing fields is not enforced
 *  (and the required-on-delete check sees no field) until the tags agree.
 *  Migration 105 repaired stored rows by the same rule. */
export async function fieldForKey(workspaceId: string, nodeId: string, key: string): Promise<StoredFieldDef | null> {
  // The note's tags, in a stable order (a label tag too: it inherits from its
  // parent tag); each gives its effective
  // fields — its own and those it inherits through extends (services/
  // tagFields.ts). `q` joins the caller's transaction, so tags applied earlier
  // in the same operation (a note created with its tags and values) are seen.
  const tags = await q<{ id: string }>(
    `SELECT t.id
       FROM node_tags nt
       JOIN content_nodes t ON t.id = nt.tag_id
        AND ${liveTagNodeSql("t")}
      WHERE nt.node_id = $1 AND t.workspace_id = $2
      ORDER BY t.created_at, t.id`,
    [nodeId, workspaceId],
  );
  if (tags.rows.length === 0) return null;
  const effective = effectiveTagFields(await loadTagFieldRows(workspaceId));
  return governingField(tags.rows.flatMap(({ id }) => (effective.get(id) ?? []).filter((field) => field.name === key)));
}

// The value check itself (type shape, select options, required) and the
// storage type a field's values get live in @onden/markdown attributeValue —
// one rule for the server and the app.
