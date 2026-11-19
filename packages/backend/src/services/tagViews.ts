// Saved views on a tag (collection views): list, create, patch, delete and
// execute. A view is part of the global tag definition — writes need the
// principal admin and re-check, under the event lock, that the current actor
// still sees the live tag (a hidden tag answers like a missing one). A view is
// a function reference of the tag (services/functionRefs.ts, B2): storage is
// shared with a note's views; this file keeps the tag's rules and events.
// Routes (routes/tags.ts) only parse the request and shape the response.

import { randomUUID } from "node:crypto";
import { FILTER_OP_NAMES, VIEW_NAME_MAX } from "@onden/markdown";
import { z } from "zod";
import { q } from "../db.js";
import type { ActorCtx } from "../types.js";
import { mutate, type Authority } from "../spine/mutate.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { executeView, placementFields, type FilterClause, type SortClause } from "./collectionViewQuery.js";
import { canSeeTag, readableNodeIdSet } from "./readPolicy.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { libraryModuleIds, ModuleNotImportedError, workspaceHasModule } from "./workspaceModules.js";
import { effectiveFieldsOf } from "./tagFields.js";
import {
  insertView, patchView, removeView, touchViewHolder, viewNameTaken, viewRecordById, viewRecordsOfMany, type ViewRecord,
} from "./functionRefs.js";
import { isNoteOnlyViewLayout, isStoredViewLayout } from "./viewLayouts.js";
import { CodedStatusError } from "../statusError.js";
import { extendsIdsOf } from "./tagExtendsList.js";
import { liveNodeSql, liveTagNodeSql, tagNodeSql } from "../spine/nodeSql.js";

// The list layout was removed (user, 2026-10-18: 「拿掉列表，只留表格」; the
// table does all it did, grouping included). An older client or a stored
// event may still say "list": it is taken as "table" (migration 111 converted
// the stored views). Every layout is a view module (table included, imported
// by default) — assertLayoutImported below.
// The registered layouts are read when a view is parsed, not when this file loads.
const layoutSchema = z.string()
  .refine((layout) => layout === "list" || isStoredViewLayout(layout), { message: "unknown view layout" })
  .transform((layout) => layout === "list" ? "table" : layout);

const filterOpSchema = z.enum(FILTER_OP_NAMES);
// Any value is saved: the view builder autosaves while a date is still being
// typed ("2026-1"). A value a typed built-in column cannot take matches
// nothing when the view runs (services/filter appendFilterClauses), so a
// saved view never fails its cast.
const filterClauseSchema = z.object({
  field: z.string().min(1),
  op: filterOpSchema,
  value: z.string().optional(),
});
const sortClauseSchema = z.object({
  field: z.string().min(1),
  dir: z.enum(["asc", "desc"]).default("asc"),
});

const viewFieldsSchema = z.object({
  name: z.string().min(1).max(VIEW_NAME_MAX),
  layout: layoutSchema,
  filters: z.array(filterClauseSchema),
  sorts: z.array(sortClauseSchema),
  group_by: z.string().nullable().optional(),
  visible_fields: z.array(z.string()),
  layout_config: z.record(z.string(), z.unknown()),
  pin_order: z.number().int(),
});
export const viewCreateSchema = viewFieldsSchema.extend({
  layout: viewFieldsSchema.shape.layout.default("table"),
  filters: viewFieldsSchema.shape.filters.default([]),
  sorts: viewFieldsSchema.shape.sorts.default([]),
  visible_fields: viewFieldsSchema.shape.visible_fields.default([]),
  layout_config: viewFieldsSchema.shape.layout_config.default({}),
  pin_order: viewFieldsSchema.shape.pin_order.default(0),
});
// Defaults belong only to creation. Zod applies defaults even inside partial
// optional fields, which would reset the layout/columns on a filter-only PATCH.
// `layout_config_patch` is the per-key form of `layout_config` (@onden/contract LayoutConfigPatch): the named keys
// change, `null` removes one. The whole-object form stays for older clients; both in one request is ambiguous.
export const viewPatchSchema = viewFieldsSchema.partial().extend({
  layout_config_patch: z.record(z.string(), z.unknown()).optional(),
}).refine((v) => v.layout_config === undefined || v.layout_config_patch === undefined, {
  message: "send layout_config or layout_config_patch, not both",
});

export type ViewCreate = z.infer<typeof viewCreateSchema>;
export type ViewPatch = z.infer<typeof viewPatchSchema>;

/** A view with this name already exists on the tag (409). */
export class TagViewNameConflictError extends Error {
  constructor(readonly viewName: string) {
    super(`view named "${viewName}" already exists for this tag`);
    this.name = "TagViewNameConflictError";
  }
}

/** The tags whose saved views `tagId` inherits (views-as-modules.md rule 5):
 *  its parent tags and legacy tag→tag `extends`, at any depth, nearest first
 *  (breadth-first, the parent before extended tags). A module tag (a
 *  function's, a view module's) passes on no views and is not walked through:
 *  functions are composition, not inheritance. Only tags the actor can see. */
async function viewAncestors(actor: ActorCtx, workspaceId: string, tagId: string): Promise<Array<{ id: string; title: string }>> {
  const rows = (await q<{ id: string; title: string; parent_id: string | null; extends: unknown; module: string | null }>(
    `SELECT id::text AS id, title, parent_id::text AS parent_id, tag_schema->'extends' AS extends, tag_schema->>'module' AS module
       FROM content_nodes WHERE workspace_id = $1 AND ${liveTagNodeSql()}`,
    [workspaceId],
  )).rows;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const result: Array<{ id: string; title: string }> = [];
  const seen = new Set([tagId]);
  const next = (id: string) => {
    const row = byId.get(id);
    return row ? [...(row.parent_id ? [row.parent_id] : []), ...extendsIdsOf(row.extends)] : [];
  };
  for (let level = next(tagId); level.length;) {
    const following: string[] = [];
    for (const id of level) {
      if (seen.has(id)) continue;
      seen.add(id);
      const row = byId.get(id);
      if (!row || row.module) continue;
      if (await canSeeTag(actor, id)) result.push({ id, title: row.title });
      following.push(...next(id));
    }
    level = following;
  }
  return result;
}

/** The one order of saved views (tag and note): pinned first, then by name. */
export const byPinThenName = (a: ViewRecord, b: ViewRecord) =>
  (Number(a.pin_order) || 0) - (Number(b.pin_order) || 0) || String(a.name ?? "").localeCompare(String(b.name ?? ""));

/** The tag's own views by pin_order then name, then the views it inherits
 *  (rule 5), nearest tag first, each marked `inherited_from` (the tag id) and
 *  `inherited_name`: they show the tag's own notes, read only — copying one
 *  makes it the tag's own. Null when the actor can't see the tag. */
export async function listTagViews(actor: ActorCtx, workspaceId: string, tagId: string): Promise<unknown[] | null> {
  if (!(await canSeeTag(actor, tagId))) return null;
  const ancestors = await viewAncestors(actor, workspaceId, tagId);
  // Writes append in creation order; sort here by pin_order then name.
  const views = await viewRecordsOfMany("tag", workspaceId, [tagId, ...ancestors.map((a) => a.id)]);
  const viewsOf = (id: string) => (views.get(id) ?? []).slice().sort(byPinThenName);
  return [
    ...viewsOf(tagId),
    ...ancestors.flatMap((a) => viewsOf(a.id).map((view) => ({ ...view, inherited_from: a.id, inherited_name: a.title }))),
  ];
}

/** Saved views are presentation on a tag the editor can see. Re-check, under
 *  the event lock, that the CURRENT actor can see this live tag: a hidden tag
 *  answers 404 on write exactly as it does on GET /:tagId/views. */
async function visibleTagUnderLock(identity: ActorCtx, workspaceId: string, tagId: string): Promise<boolean> {
  const actor = await resolveCurrentActor(identity, workspaceId);
  if (!(await canSeeTag(actor, tagId))) return false;
  const live = await q(
    `SELECT 1 FROM content_nodes
      WHERE workspace_id = $1 AND id = $2 AND ${liveTagNodeSql()}
      FOR UPDATE`,
    [workspaceId, tagId],
  );
  return live.rows.length > 0;
}

/** The current saved view, read under the lock (for tx_meta restore). */
const lockedView = (workspaceId: string, tagId: string, viewId: string): Promise<ViewRecord | null> => viewRecordById("tag", workspaceId, tagId, viewId);

/** A layout that is a library module needs the module on, else throws
 *  ModuleNotImportedError (409 module_not_imported). The view modules (table,
 *  calendar, kanban, gallery) are always on (workspaceModules alwaysOn), so only
 *  the whiteboard can be refused. */
export async function assertLayoutImported(workspaceId: string, layout: string | undefined): Promise<void> {
  if (!layout || !libraryModuleIds().includes(layout)) return;
  if (!(await workspaceHasModule(workspaceId, layout))) throw new ModuleNotImportedError(layout);
}

/** A tag's views take no layout that belongs to a note's tab row (the slides' 「簡報」 draws one note's own text, a
 *  tag has none): refused 422 `view_layout_not_for_tags` before anything is written — the client hides the choice
 *  (useAddView), but the server does not rely on that. */
export function assertLayoutForTag(layout: string | undefined): void {
  if (isNoteOnlyViewLayout(layout)) throw new CodedStatusError(422, "view_layout_not_for_tags", `the "${layout}" view belongs to a note, not a tag`);
}

/** Append a view; null when the tag is missing or hidden. Throws
 *  TagViewNameConflictError for a name the tag already has, and
 *  ModuleNotImportedError for a layout whose view module is not imported. */
export async function createTagView(actor: ActorCtx, workspaceId: string, tagId: string, v: ViewCreate): Promise<{ id: string } | null> {
  return withEventTransaction(workspaceId, async () => {
    if (!(await visibleTagUnderLock(actor, workspaceId, tagId))) return null;
    return appendTagView(actor, workspaceId, tagId, v, {
      authority: { kind: "principal_admin" }, // a view is part of the global tag definition
      uiContext: "tag.view.create",
    });
  });
}

/** The one writer that adds a saved view to a tag (createTagView, the Notion
 *  import): the view-module gate, the stored element and the
 *  COLLECTION_VIEW_CREATED event. Runs inside the caller's event transaction
 *  (withEventTransaction); the caller decides who may write (`authority`).
 *  Throws ModuleNotImportedError for a layout whose view module is not
 *  imported — nothing is written. A name the tag already has throws
 *  TagViewNameConflictError, or with `skipNameClash` returns null and writes
 *  no view and no event. */
export async function appendTagView(
  actor: ActorCtx,
  workspaceId: string,
  tagId: string,
  v: ViewCreate,
  opts: { authority: Authority; uiContext: string; skipNameClash?: boolean },
): Promise<{ id: string } | null> {
  assertLayoutForTag(v.layout);
  await assertLayoutImported(workspaceId, v.layout);
  // The tag row is locked (FOR UPDATE), so the name check and the insert below see the same names.
  const tag = (await q(
    `SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND id = $2 AND ${liveTagNodeSql()} FOR UPDATE`,
    [workspaceId, tagId],
  )).rows[0];
  if (opts.skipNameClash && tag && await viewNameTaken(workspaceId, tagId, v.name)) return null;
  return mutate<{ id: string }>({
    actor,
    workspaceId,
    authority: opts.authority,
    timing: "after", // view id is app-generated
    event: {
      type: "COLLECTION_VIEW_CREATED",
      targetType: "collection_view",
      targetId: (r) => r.id,
      payload: { tag_id: tagId, name: v.name, layout: v.layout },
      txMeta: { inverse_op: "collection_view.deleted", ui_context: opts.uiContext },
    },
    apply: async () => {
      if (!tag) throw new Error("tag not found");
      if (await viewNameTaken(workspaceId, tagId, v.name)) throw new TagViewNameConflictError(v.name);
      const viewId = randomUUID();
      const now = new Date().toISOString();
      await insertView({
        workspaceId, holderId: tagId, viewId, layout: v.layout, createdBy: actor.id,
        element: {
          name: v.name, filters: v.filters, sorts: v.sorts, group_by: v.group_by ?? null,
          visible_fields: v.visible_fields, layout_config: v.layout_config,
          pin_order: v.pin_order, created_at: now, updated_at: now,
        },
      });
      await touchViewHolder(tagId);
      return { id: viewId };
    },
  });
}

/** Merge the changed keys into a view; false when the tag or view is missing.
 *  Throws TagViewNameConflictError when a rename takes another view's name
 *  (nothing is changed); keeping the view's own name is not a conflict. */
export async function updateTagView(actor: ActorCtx, workspaceId: string, tagId: string, viewId: string, updates: ViewPatch): Promise<boolean> {
  // Only the changed keys (jsonb merge); group_by may be set to null.
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of Object.keys(updates) as Array<keyof typeof updates>) patch[k] = updates[k] ?? null;

  return withEventTransaction(workspaceId, async () => {
    if (!(await visibleTagUnderLock(actor, workspaceId, tagId))) return false;
    // Capture prev (the view element) for restore-via-tx_meta, under the lock.
    const prev = await lockedView(workspaceId, tagId, viewId);
    if (!prev) return false;
    assertLayoutForTag(updates.layout);
    await assertLayoutImported(workspaceId, updates.layout);
    await mutate({
      actor,
      workspaceId,
      authority: { kind: "principal_admin" }, // a view is part of the global tag definition
      event: {
        type: "COLLECTION_VIEW_UPDATED",
        targetType: "collection_view",
        targetId: viewId,
        payload: { tag_id: tagId, changed: Object.keys(updates) },
        txMeta: {
          inverse_op: "collection_view.updated",
          prev_field_values: prev,
          ui_context: "tag.view.patch",
        },
      },
      apply: async () => {
        // A rename goes through the same unique-name rule as create (the tag row is locked above).
        if (updates.name !== undefined && await viewNameTaken(workspaceId, tagId, updates.name, viewId)) throw new TagViewNameConflictError(updates.name);
        await patchView(workspaceId, tagId, viewId, patch);
        await touchViewHolder(tagId);
      },
    });
    return true;
  });
}

/** Drop a view; false when the tag or view is missing. */
export async function deleteTagView(actor: ActorCtx, workspaceId: string, tagId: string, viewId: string): Promise<boolean> {
  return withEventTransaction(workspaceId, async () => {
    if (!(await visibleTagUnderLock(actor, workspaceId, tagId))) return false;
    const prev = await lockedView(workspaceId, tagId, viewId);
    if (!prev) return false;
    const prevView = prev as { name?: string };
    await mutate({
      actor,
      workspaceId,
      authority: { kind: "principal_admin" }, // a view is part of the global tag definition
      event: {
        type: "COLLECTION_VIEW_DELETED",
        targetType: "collection_view",
        targetId: viewId,
        payload: { tag_id: tagId, name: prevView?.name },
        // Restoring a deleted view = re-INSERT from the captured prev fields.
        txMeta: {
          inverse_op: "collection_view.created",
          prev_field_values: prev,
          ui_context: "tag.view.delete",
        },
      },
      apply: async () => {
        await removeView(workspaceId, tagId, viewId);
        await touchViewHolder(tagId);
      },
    });
    return true;
  });
}

// M3.2: execute a saved view's query. Returns the same row shape that
// the layout renderer (table, kanban, calendar, gallery) consumes:
//   { rows: [{ id, title, slug, updated_at, attributes: {fieldKey: value} }],
//     total, next, view: {layout, ...} }
// — a Page (services/paging.ts): `total` counts every matching row, `next` is
// the offset of the next page or null.
//
// Read-only. Soft-deleted + hidden nodes excluded server-side.
//
// Page size: collectionViewQuery.VIEW_PAGE (200, at most 500).
export async function executeTagView(
  actor: ActorCtx, workspaceId: string, tagId: string, viewId: string,
  page: { limit: number; offset: number },
  /** Only these notes may be rows (the publish freeze lists published notes
   *  only): the actor's read set narrowed to them. */
  within?: readonly string[],
) {
  // Rows below are already scoped to readableNodeIdSet; this additionally
  // hides the view CONFIG (filters, fields, layout) of a hidden tag.
  if (!(await canSeeTag(actor, tagId))) return null;
  // The saved view by id — the tag's own, else one it inherits (rule 5), run on its own notes.
  const owners = [tagId, ...(await viewAncestors(actor, workspaceId, tagId)).map((a) => a.id)];
  const viewRow = await q<{
    id: string; layout: string; filters: FilterClause[]; sorts: SortClause[];
    group_by: string | null; visible_fields: string[];
    layout_config: Record<string, unknown>;
  }>(
    `SELECT r.instance AS id, r.function_id AS layout, r.config->'filters' AS filters,
            r.config->'sorts' AS sorts, r.config->>'group_by' AS group_by,
            r.config->'visible_fields' AS visible_fields, r.config->'layout_config' AS layout_config
       FROM function_refs r JOIN content_nodes n ON n.id = r.holder_node_id
      WHERE n.workspace_id = $1 AND r.holder_node_id = ANY($2::uuid[]) AND ${tagNodeSql("n")}
        AND ${liveNodeSql("n")} AND r.instance = $3
      ORDER BY array_position($2::uuid[], r.holder_node_id) LIMIT 1`,
    [workspaceId, owners, viewId],
  );
  const view = viewRow.rows[0];
  if (!view) return null;
  const narrowed = within ? new Set(within) : null;

  // Resolve the tag's schema field types so numeric/rating fields sort
  // numerically and the client can render type-aware cells (e.g. stars for
  // rating). Map keyed by field name; `max` carried for rating widgets.
  // The tag's effective fields — its own and those it inherits (tagFields.ts).
  const fieldMeta: Record<string, { type: string; max?: number }> = {};
  for (const f of await effectiveFieldsOf(workspaceId, tagId) as Array<{ name?: string; type?: string; max?: number }>) {
    if (!f?.name || !f.type) continue;
    fieldMeta[f.name] = { type: f.type, ...(f.max ? { max: f.max } : {}) };
  }

  const { rows, total, next } = await executeView({
    workspaceId, tagId,
    filters: view.filters ?? [],
    sorts: view.sorts ?? [],
    visibleFields: view.visible_fields ?? [],
    placementFields: placementFields(view),
    limit: page.limit, offset: page.offset,
    readableIds: [...await readableNodeIdSet(actor, workspaceId)].filter((id) => !narrowed || narrowed.has(id)),
  });

  // Surface the group field's declared option order so layouts (Kanban)
  // can lay out columns in the schema's sequence (e.g. Lead → Qualified →
  // Won) rather than first-seen row order. Only select-typed fields carry
  // a meaningful option list; anything else yields null and the layout
  // falls back to insertion order.
  const groupFieldOptions = await selectFieldOptions(workspaceId, tagId, view.group_by);

  return {
    rows, total, next,
    view: {
      layout: view.layout,
      group_by: view.group_by,
      group_field_options: groupFieldOptions,
      visible_fields: view.visible_fields,
      layout_config: view.layout_config,
      // Per-field metadata so layout renderers can show type-aware cells
      // (rating → stars) without a second schema roundtrip.
      field_meta: fieldMeta,
    },
  };
}

// Resolve the declared `options` of a select-typed schema field on the
// tag's collection schema. Returns null for non-select fields, missing
// fields, schemaless tags, or built-in fields (title/slug/...) — callers
// treat null/empty as "no declared order".
async function selectFieldOptions(
  workspaceId: string,
  tagId: string,
  fieldName: string | null,
): Promise<string[] | null> {
  if (!fieldName) return null;
  // Effective fields: an inherited select field groups by its options too.
  const field = (await effectiveFieldsOf(workspaceId, tagId) as Array<{ name?: string; type?: string; options?: string[] }>).find((f) => f?.name === fieldName);
  if (!field || field.type !== "select") return null;
  const opts = field.options;
  return Array.isArray(opts) && opts.length > 0 ? opts : null;
}
