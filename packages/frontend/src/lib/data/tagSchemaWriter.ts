import { makeWriteLifecycle } from "./writeLifecycle";
import type { WriteResult } from "./writeQueue";
import type { DataCtx } from "./types";

/** The schema slices of a class tag that a save may carry. */
export type TagSchemaPatch = Partial<{ fields: unknown[]; behaviour: unknown }>;

/** A field row with no name yet (just added in the editor, or its label not
 *  committed) is not a field: saved, it would show up as a nameless column.
 *  Dropped here, the one place every tag-fields save passes through; the
 *  editor keeps the row on screen, and it is saved once it has a name. */
function withoutUnnamedFields(fields: unknown[]): unknown[] {
  return fields.filter((f) => {
    const { name, key } = (f ?? {}) as { name?: unknown; key?: unknown };
    return [name, key].some((k) => typeof k === "string" && k.trim() !== "");
  });
}

/** Saving a class tag's schema settings (fields, behaviour).
 *  Each save REPLACES the slices it carries — the whole `fields` array, the
 *  whole behaviour — so build a slice from the latest copy you have: a `fields`
 *  array built from a stale copy drops a field another device added meanwhile
 *  (GAP-132, needs field-level saves on the server). Saves are accepted by the
 *  server or durably queued (offline / transient failure) and replayed in
 *  order per tag; a refusal is reported once and rethrown. */
export function makeTagSchemaWriter(ctx: DataCtx) {
  const commit = makeWriteLifecycle(ctx);
  function update(tagId: string, patch: TagSchemaPatch): Promise<WriteResult<unknown>> {
    return commit(`tag-schema:${tagId}`, { method: "PATCH", path: `/api/tags/${tagId}/schema`, body: JSON.stringify(patch.fields ? { ...patch, fields: withoutUnnamedFields(patch.fields) } : patch) });
  }
  return { update };
}
