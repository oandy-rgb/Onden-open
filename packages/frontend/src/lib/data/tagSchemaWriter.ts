import type { Tag } from "../api";
import { optimisticFields } from "./optimisticFields";
import { makeWriteLifecycle, reconcileFields } from "./writeLifecycle";
import type { WriteResult } from "./writeQueue";
import type { DataCtx } from "./types";

/** The schema slices of a class tag that a save may carry. */
export type TagSchemaPatch = Partial<{ fields: unknown[]; behaviour: unknown }>;

/** A field row with no name yet (just added in the editor, or its label not
 *  committed) is not a field: saved, it would show up as a nameless column.
 *  Dropped here, the one place every tag-fields save passes through; the
 *  editor keeps the row on screen, and it is saved once it has a name. */
export function namedFields(fields: unknown[]): unknown[] {
  return fields.filter((f) => {
    const { name, key } = (f ?? {}) as { name?: unknown; key?: unknown };
    return [name, key].some((k) => typeof k === "string" && k.trim() !== "");
  });
}

/** Saving a class tag's schema settings (fields, behaviour).
 *  Each save REPLACES the slices it carries — the whole `fields` array, the
 *  whole behaviour — so build a slice from the latest copy you have: a `fields`
 *  array built from a stale copy drops a field another device added meanwhile
 *  (GAP-132, needs field-level saves on the server). The latest copy includes
 *  this device's own saves still waiting (offline, queued, in flight): each save
 *  writes its slices into `data.tags` before it is sent, so the next one, built
 *  from the store, carries the previous one. A refusal puts back the value
 *  before it (journal: optimisticFields.ts), leaving a later save's value alone.
 *  Saves are accepted by the server or durably queued (offline / transient
 *  failure) and replayed in order per tag; a refusal is reported once and rethrown. */
export function makeTagSchemaWriter(ctx: DataCtx) {
  const commit = makeWriteLifecycle(ctx);
  type Slices = Pick<Tag, "schema_fields" | "schema_behaviour">;
  const setSlices = (tagId: string, slices: Partial<Slices>, only?: Partial<Slices>) => ctx.setData((state) => ({
    ...state,
    tags: state.tags?.map((tag) => tag.id === tagId ? (only ? reconcileFields(tag, only, slices) : { ...tag, ...slices }) : tag),
  }));
  function update(tagId: string, patch: TagSchemaPatch): Promise<WriteResult<unknown>> {
    // The tag's row journal: the store's one door (storeOps.keepUnanswered, a tag in the tag list is `node:<tag>`)
    // keeps these fields over a server copy until this save is answered. The write lane stays `tag-schema:`.
    const resource = `node:${tagId}`;
    const sent = patch.fields ? { ...patch, fields: namedFields(patch.fields) } : patch;
    const changes: Partial<Slices> = {
      ...(sent.fields ? { schema_fields: sent.fields as Tag["schema_fields"] } : {}),
      ...(sent.behaviour !== undefined ? { schema_behaviour: sent.behaviour as Tag["schema_behaviour"] } : {}),
    };
    const row = ctx.data.tags?.find((tag) => tag.id === tagId);
    // A tag not in the store (a lens mounted alone) has nothing to show or put back.
    const settle = row ? optimisticFields<Slices>(resource, row, changes) : null;
    if (row) setSlices(tagId, changes);
    const finish = (accepted: boolean) => {
      if (!settle) return;
      const { expected, replacement } = settle(accepted);
      setSlices(tagId, replacement, expected);
    };
    return commit(`tag-schema:${tagId}`, { method: "PATCH", path: `/api/tags/${tagId}/schema`, body: JSON.stringify(sent) }, {
      accepted: () => finish(true), rejected: () => finish(false), unconfirmed: () => finish(true),
    });
  }
  return { update };
}
