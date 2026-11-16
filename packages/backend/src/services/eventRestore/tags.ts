import { isDeepStrictEqual } from "node:util";
import { writeTagSchema } from "../tagWrites.js";
import { q } from "../../db.js";
import { isTagNameShape } from "@onden/markdown/contract";
import { tagNameTaken } from "../tagHierarchy.js";
import { applyTagIdentity, type TagIdentityColumns } from "../tagIdentity.js";
import type { ActorCtx } from "../../types.js";
import type { EventRow, RestoreError, RestoreResult } from "../restoreContract.js";
import { recordRestore, requireRestoreTransaction } from "./record.js";
import { historyIncomplete, stateConflict } from "./refusals.js";
import { loadExtendsGraph, wouldCreateExtendsCycle } from "../functionRefs.js";
import { extendsIdsOf } from "../tagExtendsList.js";
import { fieldShapeProblems } from "../fieldSchema.js";
import { liveNodeSql, liveTagNodeSql } from "../../spine/nodeSql.js";

export type TagUpdatePreview = {
  kind: "tag_update" | "tag_schema_update";
  changes: Array<{ field: string; current: unknown; restored: unknown }>;
  can_apply_cleanly: boolean;
  force_available: false;
  reason?: string;
  conflict_code?: "state_conflict" | "history_incomplete" | "already_in_state";
};

type Refusal = Extract<RestoreError, { code: "state_conflict" | "history_incomplete" | "already_in_state" }>;
type Inspection = {
  kind: TagUpdatePreview["kind"];
  current: Record<string, unknown>;
  previous: Record<string, unknown>;
  changed: string[];
  restoreFields: string[];
  refusal?: Refusal;
};

// The tag node's own identity; applyTagIdentity (tagIdentity.ts) maps each to its column.
const identityFields = ["name", "slug", "color"];
// `extends` and `module` (module library) are schema values like the others,
// and so are the schema's own `name`/`slug`; they are not the tag node's
// identity.
// `policy` is not: tag access policies ended with spaces (migration 094), so an
// old event's policy change is not restored.
const schemaFields = ["name", "slug", "fields", "views", "behaviour", "extends", "module"];
const own = (record: Record<string, unknown>, key: string): boolean => Object.hasOwn(record, key);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function validIdentityValue(field: string, value: unknown): boolean {
  return typeof value === "string" || (field === "color" && value === null);
}

/** A schema field is one value; a policy's individual rules are not independently
 * reversible. Rename fields changed by the event form one identity group. The
 * row lock is for apply; preview uses the same interpretation without locking.
 */
async function inspectTag(row: EventRow, lock: boolean): Promise<Inspection | RestoreError> {
  const schema = row.event_type === "TAG_SCHEMA_UPDATED";
  if (row.target_type !== "tag" || (!schema && row.event_type !== "TAG_UPDATED")) {
    return historyIncomplete("tag history has no valid target or operation");
  }
  const previous = row.tx_meta?.prev_field_values;
  if (schema && previous === null) {
    return { code: "unsupported", status: 422, detail: "initial tag schema creation cannot be reversed" };
  }
  if (!record(previous)) return historyIncomplete("tag history has no previous field values");
  const allowed = schema ? schemaFields : identityFields;
  const changed = row.payload?.changed;
  if (!Array.isArray(changed) || !changed.length ||
      changed.some((key) => typeof key !== "string" || !allowed.includes(key)) ||
      new Set(changed).size !== changed.length) {
    return historyIncomplete("tag history does not identify the fields it changed");
  }
  if (changed.some((key: string) => !own(previous, key) || previous[key] === undefined ||
      (!schema && !validIdentityValue(key, previous[key])))) {
    return historyIncomplete("tag history is missing a previous value for a changed field");
  }

  const found = await q<{ name: string; slug: string; color: string | null; parent_id: string | null; tag_schema: Record<string, unknown> | null }>(
    `SELECT title AS name, slug, tag_color AS color, parent_id, tag_schema
       FROM content_nodes
      WHERE workspace_id = $1 AND id = $2 AND ${liveTagNodeSql()}${lock ? " FOR UPDATE" : ""}`,
    [row.workspace_id, row.target_id],
  );
  const tag = found.rows[0];
  if (!tag || (schema && !tag.tag_schema)) {
    return { code: "target_gone", status: 410, detail: schema ? "tag schema no longer exists" : "tag no longer exists" };
  }
  const current = schema
    ? Object.fromEntries(schemaFields.map((key) => [key, tag.tag_schema![key] ?? null]))
    : { name: tag.name, slug: tag.slug, color: tag.color };
  const inspection: Inspection = { kind: schema ? "tag_schema_update" : "tag_update", current, previous, changed, restoreFields: [] };
  if (changed.every((key: string) => isDeepStrictEqual(current[key], previous[key]))) {
    return { ...inspection, refusal: { code: "already_in_state", status: 409, detail: "these tag fields are already restored" } };
  }
  const next = row.payload?.next_field_values;
  if (!record(next) || changed.some((key: string) => !own(next, key) || next[key] === undefined ||
      (!schema && !validIdentityValue(key, next[key])))) {
    return { ...inspection, refusal: historyIncomplete("tag history has no complete resulting values; later edits cannot be checked safely") };
  }

  const identity = changed.filter((key: string) => key === "name" || key === "slug");
  const groups: string[][] = schema
    ? changed.map((key: string) => [key])
    : [...(identity.length ? [identity] : []), ...(changed.includes("color") ? [["color"]] : [])];
  for (const group of groups) {
    if (group.every((key) => isDeepStrictEqual(current[key], previous[key]))) continue;
    if (!group.every((key) => isDeepStrictEqual(current[key], next[key]))) {
      return { ...inspection, refusal: stateConflict(`tag ${group.join("/")} changed after this event; its current values were preserved`) };
    }
    inspection.restoreFields.push(...group.filter((key) => !isDeepStrictEqual(current[key], previous[key])));
  }
  if (!inspection.restoreFields.length) {
    return { ...inspection, refusal: { code: "already_in_state", status: 409, detail: "these tag fields are already restored" } };
  }
  // Tags may have come to extend this one since: bringing back an older
  // extends list must not make tags extend each other.
  if (schema && inspection.restoreFields.includes("extends") &&
      wouldCreateExtendsCycle(await loadExtendsGraph(row.workspace_id), row.target_id, extendsIdsOf(previous.extends))) {
    return { ...inspection, refusal: stateConflict("restoring this would make tags extend each other") };
  }
  // A tag's functions are function references now (FUNCTION_REF_* events). Bringing back an old
  // behaviour.modules switch would change nothing a reader looks at, so it is not offered.
  if (schema && inspection.restoreFields.includes("behaviour") &&
      !isDeepStrictEqual(record(previous.behaviour) ? previous.behaviour.modules : undefined, record(current.behaviour) ? current.behaviour.modules : undefined)) {
    return { ...inspection, refusal: stateConflict("tag functions are managed as function references now; add or remove the function instead of undoing this change") };
  }
  // A field without the field shape (one saved before that check,
  // since edited): writeTagSchema keeps only the fields stored now unjudged.
  if (schema && inspection.restoreFields.includes("fields")) {
    const problems = fieldShapeProblems(previous.fields, current.fields);
    if (problems.length) {
      return { ...inspection, refusal: stateConflict(`restoring this would bring back a field that is not valid: ${problems.join("; ")}`) };
    }
  }

  // Restore the historical identity exactly. Choosing a new suffix would claim
  // to undo a rename while silently creating a different identity.
  if (!schema && inspection.restoreFields.some((key) => key === "name" || key === "slug")) {
    // Undoing a rename names the tag again: the same shape rule as a rename,
    // so a name from before the rule is not brought back.
    if (inspection.restoreFields.includes("name") && typeof previous.name === "string" && !isTagNameShape(previous.name)) {
      return { ...inspection, refusal: stateConflict("the previous tag name is not a valid tag name any more; rename the tag instead") };
    }
    const slugCollision = inspection.restoreFields.includes("slug") && (await q(
      `SELECT 1 FROM content_nodes
        WHERE workspace_id = $1 AND id <> $2 AND ${liveNodeSql()} AND slug = $3 LIMIT 1`,
      [row.workspace_id, row.target_id, previous.slug],
    )).rows.length > 0;
    const nameCollision = inspection.restoreFields.includes("name") && typeof previous.name === "string"
      && await tagNameTaken(row.workspace_id, tag.parent_id, previous.name, { exceptId: row.target_id });
    if (slugCollision || nameCollision) return { ...inspection, refusal: stateConflict("the previous tag name or slug is now used by another live node") };
  }
  return inspection;
}

/** Undo only this event's changed fields under restoreEvent's authorization and
 * transaction. Later edits to those fields conflict; unrelated fields survive.
 * Schema restoration changes definitions only: defaults and behaviours do not
 * run again, and schema.name/slug are independent from the tag node's identity.
 */
export async function restoreTagUpdate(row: EventRow, actorContext: ActorCtx): Promise<RestoreResult | RestoreError> {
  requireRestoreTransaction();
  const inspection = await inspectTag(row, true);
  if ("code" in inspection) return inspection;
  if (inspection.refusal) return inspection.refusal;
  const { current, previous, restoreFields } = inspection;
  const restored = Object.fromEntries(restoreFields.map((key) => [key, previous[key]]));
  const before = Object.fromEntries(restoreFields.map((key) => [key, current[key]]));
  if (inspection.kind === "tag_schema_update") {
    // Undoing a module switch (setTagModules) brings the old switches back.
    // A same-name field it brings back is not judged: restore puts back what
    // the tag had, and nearest-wins keeps it working (module-library.md).
    await writeTagSchema(row.workspace_id, row.target_id!, { merge: restored }, { restoring: true });
  } else {
    await applyTagIdentity(row.workspace_id, row.target_id!, restored as TagIdentityColumns);
  }
  return recordRestore(row, actorContext, {
    eventType: row.event_type,
    payload: { changed: restoreFields, next_field_values: restored, ...(inspection.kind === "tag_schema_update" ? { created: false } : {}) },
    inverseOp: inspection.kind === "tag_schema_update" ? "tag_schema.updated" : "tag.updated",
    previous: before,
  });
}

export async function previewTagUpdate(row: EventRow): Promise<TagUpdatePreview | RestoreError> {
  const inspection = await inspectTag(row, false);
  if ("code" in inspection) return inspection;
  return {
    kind: inspection.kind,
    changes: inspection.changed.map((field) => ({ field, current: inspection.current[field], restored: inspection.previous[field] })),
    can_apply_cleanly: !inspection.refusal,
    force_available: false,
    ...(inspection.refusal ? { reason: inspection.refusal.detail, conflict_code: inspection.refusal.code } : {}),
  };
}
