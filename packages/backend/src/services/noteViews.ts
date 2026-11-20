// Saved views on a note: its children as rows (docs/architecture/views-as-modules.md
// 「檢視的來源」). The twin of services/tagViews.ts — same view shape, same
// layouts and view-module gate, same exec row shape — with two differences:
//   * the rows are the note's children, not a tag's members;
//   * who may change the views is whoever may edit the note (authority
//     `node` / `write_node`), not the tag administrator, and the events name
//     the note (target_type "node"), so only its readers see them.
// The views are function references of the note (services/functionRefs.ts, B2),
// the same storage as a tag's. Changing them does not touch the note's
// updated_at: a view is presentation, not content.
// Routes (routes/nodes.ts) only parse the request and shape the response.

import { attributeValues, encodeValues, isListValue, isUuid } from "@onden/markdown";
import { CONTENT_LAYOUT } from "@onden/markdown/contract";
import { CodedStatusError } from "../statusError.js";
import { randomUUID } from "node:crypto";
import { pool, q } from "../db.js";
import type { ActorCtx } from "../types.js";
import { mutate } from "../spine/mutate.js";
import { withEventTransaction } from "../spine/eventTransaction.js";
import { executeView, placementFields, type FilterClause, type SortClause } from "./collectionViewQuery.js";
import { canReadNode, readableNodeIdSet } from "./readPolicy.js";
import { resolveCurrentActor } from "../spine/currentActor.js";
import { effectiveTagFields, loadTagFieldRows } from "./tagFields.js";
import { assertLayoutImported, byPinThenName, TagViewNameConflictError, viewCreateSchema, type ViewCreate, type ViewPatch } from "./tagViews.js";
import { contentTabRemovable, insertView, patchView, removeView, viewNameTaken, viewRecordById, viewRecordsOf } from "./functionRefs.js";
import { liveNodeSql, notTagNodeSql } from "../spine/nodeSql.js";

/** A note that can own views: live and not a tag (a tag's views are its
 *  members', services/tagViews.ts). */
// Callers write `workspace_id = $1 AND ${OWNER_SQL}` inline, so the
// workspace-boundary guard (workspaceBoundary.test.ts) can see the filter.
const OWNER_SQL = `id = $2 AND ${notTagNodeSql()} AND ${liveNodeSql()}`;

/** The note's views by pin_order then name; null when the actor can't read
 *  the note (or it is a tag). The route sends `contentTabRemovable` beside it. */
export async function listNoteViews(actor: ActorCtx, workspaceId: string, nodeId: string): Promise<unknown[] | null> {
  if (!(await canReadNode(actor, nodeId))) return null;
  const owner = await pool.query(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND ${OWNER_SQL}`, [workspaceId, nodeId]);
  if (!owner.rows[0]) return null;
  return (await viewRecordsOf("note", workspaceId, nodeId)).sort(byPinThenName);
}

export { contentTabRemovable };

/** Under the event lock: the CURRENT actor still reads this live note, and
 *  its row is locked for the write. A note it cannot read answers 404. */
async function readableNoteUnderLock(identity: ActorCtx, workspaceId: string, nodeId: string): Promise<boolean> {
  const actor = await resolveCurrentActor(identity, workspaceId);
  if (!(await canReadNode(actor, nodeId))) return false;
  const live = await q(`SELECT 1 FROM content_nodes WHERE workspace_id = $1 AND ${OWNER_SQL} FOR UPDATE`, [workspaceId, nodeId]);
  return live.rows.length > 0;
}

/** One view of a backup, as the writers take it: the stored fields run through the same schema a new view does (an
 *  unknown layout, a missing name, a filter the app cannot read → null); a view without a name takes its layout's. */
export function backedUpView(stored: unknown, ids?: ReadonlyMap<string, string>): (ViewCreate & { created_at: string; updated_at: string }) | null {
  if (!stored || typeof stored !== "object") return null;
  const v = stored as Record<string, unknown>;
  const parsed = viewCreateSchema.safeParse({ ...v, name: typeof v.name === "string" && v.name ? v.name : String(v.layout ?? "") });
  if (!parsed.success) return null;
  const now = new Date().toISOString();
  const when = (x: unknown) => (typeof x === "string" && Number.isFinite(Date.parse(x)) ? x : now);
  const view = { ...parsed.data, created_at: when(v.created_at), updated_at: when(v.updated_at) };
  return ids ? { ...view, filters: view.filters.map((f) => ({ ...f, ...(f.value === undefined ? {} : { value: withRestoredIds(f.value, ids) }) })), layout_config: withRestoredIds(view.layout_config, ids) } : view;
}

/** `value` with every note or tag id in it (a filter's value, the board tab's opened and closed branches, a list value) replaced by
 *  the id it has after a restore (`ids`: backup id → id here); an id the restore does not know stays as it is. */
export function withRestoredIds<T>(value: T, ids: ReadonlyMap<string, string>): T {
  if (typeof value === "string") {
    if (isUuid(value)) return (ids.get(value) ?? value) as T;
    return (isListValue(value) ? encodeValues(attributeValues(value).map((v) => ids.get(v) ?? v)) : value) as T;
  }
  if (Array.isArray(value)) return value.map((v) => withRestoredIds(v, ids)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withRestoredIds(v, ids)])) as T;
  return value;
}

/** Give note `nodeId` the saved views a backup held (every layout: table, kanban, calendar, gallery, the whiteboard and
 *  handwriting tabs, the slides…), for a note being created or restored inside the caller's transaction: like
 *  addNoteLayoutTab the views are part of the creation, not events of their own. Returns how many were written and how
 *  many were left out (not a view this version reads, or a name the note already has). A layout whose module is off here
 *  is still kept: the module gate is for adding a view by hand, the backup holds what the note had. */
export async function restoreNoteViews(workspaceId: string, nodeId: string, stored: readonly unknown[], ids?: ReadonlyMap<string, string>): Promise<{ written: number; leftOut: number }> {
  const result = { written: 0, leftOut: 0 };
  for (const element of stored) {
    const view = backedUpView(element, ids);
    if (!view || (view.layout !== CONTENT_LAYOUT && await viewNameTaken(workspaceId, nodeId, view.name))) { result.leftOut++; continue; }
    await insertView({ workspaceId, holderId: nodeId, viewId: randomUUID(), layout: view.layout, element: view });
    result.written++;
  }
  return result;
}

/** Changing a note's views is editing the note. */
const authorityFor = (nodeId: string) => ({ kind: "node" as const, nodeId, op: "write_node" as const });

/** Append a view; null when the note is missing or unreadable. Throws
 *  TagViewNameConflictError for a name the note's views already have,
 *  ModuleNotImportedError for a layout whose view module is not imported, and
 *  the authority refusal for a reader who may not edit the note. */
export async function createNoteView(actor: ActorCtx, workspaceId: string, nodeId: string, v: ViewCreate): Promise<{ id: string } | null> {
  return withEventTransaction(workspaceId, async () => {
    if (!(await readableNoteUnderLock(actor, workspaceId, nodeId))) return null;
    await assertLayoutImported(workspaceId, v.layout);
    // A note has one 「內容」 record: two devices removing the tab at once, or a retry, get the one already there.
    if (v.layout === CONTENT_LAYOUT) {
      const existing = (await viewRecordsOf("note", workspaceId, nodeId)).find((record) => record.layout === CONTENT_LAYOUT);
      if (existing) {
        // Asked again (a retry, or another device at once): what it asks for is applied, not dropped.
        if (typeof v.layout_config.hidden === "boolean") await patchView(workspaceId, nodeId, existing.id, { layout_config_patch: { hidden: v.layout_config.hidden || null } });
        return { id: existing.id };
      }
    }
    const viewId = randomUUID();
    await mutate({
      actor,
      workspaceId,
      authority: authorityFor(nodeId),
      event: {
        type: "COLLECTION_VIEW_CREATED",
        targetType: "node",
        targetId: nodeId,
        payload: { node_id: nodeId, view_id: viewId, name: v.name, layout: v.layout },
        txMeta: { inverse_op: "collection_view.deleted", ui_context: "node.view.create" },
      },
      apply: async () => {
        // The note's row is locked (readableNoteUnderLock), so this name check and the insert see the same names.
        if (v.layout !== CONTENT_LAYOUT && await viewNameTaken(workspaceId, nodeId, v.name)) throw new TagViewNameConflictError(v.name);
        const now = new Date().toISOString();
        await insertView({
          workspaceId, holderId: nodeId, viewId, layout: v.layout, by: actor,
          element: {
            name: v.name, filters: v.filters, sorts: v.sorts, group_by: v.group_by ?? null,
            visible_fields: v.visible_fields, layout_config: v.layout_config,
            pin_order: v.pin_order, created_at: now, updated_at: now,
          },
        });
      },
    });
    return { id: viewId };
  });
}

/** Merge the changed keys into a view; false when the note or view is missing. */
export async function updateNoteView(actor: ActorCtx, workspaceId: string, nodeId: string, viewId: string, updates: ViewPatch): Promise<boolean> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of Object.keys(updates) as Array<keyof typeof updates>) patch[k] = updates[k] ?? null;
  return withEventTransaction(workspaceId, async () => {
    if (!(await readableNoteUnderLock(actor, workspaceId, nodeId))) return false;
    const prev = await viewRecordById("note", workspaceId, nodeId, viewId);
    if (!prev) return false;
    // The 「內容」 record is made as one (createNoteView keeps it single); no other view turns into a second one.
    if (updates.layout === CONTENT_LAYOUT && prev.layout !== CONTENT_LAYOUT) {
      throw new CodedStatusError(422, "view_layout_not_changeable", `a view cannot become the "${CONTENT_LAYOUT}" tab`);
    }
    await assertLayoutImported(workspaceId, updates.layout);
    await mutate({
      actor,
      workspaceId,
      // Changing the view's settings (filters, sorts, grouping, fields, layout) overwrites them, and COLLECTION_VIEW_UPDATED has no inverse
      // (restoreContract.ts): never a temporary session's, like deleting one (round 4). Renaming it or moving it in the list stays a write.
      authority: Object.keys(updates).every((k) => k === "name" || k === "pin_order")
        ? authorityFor(nodeId)
        : { kind: "irreversible", of: authorityFor(nodeId) },
      event: {
        type: "COLLECTION_VIEW_UPDATED",
        targetType: "node",
        targetId: nodeId,
        payload: { node_id: nodeId, view_id: viewId, changed: Object.keys(updates) },
        txMeta: { inverse_op: "collection_view.updated", prev_field_values: prev, ui_context: "node.view.patch" },
      },
      apply: async () => {
        if (updates.name !== undefined && await viewNameTaken(workspaceId, nodeId, updates.name, viewId)) throw new TagViewNameConflictError(updates.name);
        await patchView(workspaceId, nodeId, viewId, patch);
      },
    });
    return true;
  });
}

/** Drop a view; false when the note or view is missing. */
export async function deleteNoteView(actor: ActorCtx, workspaceId: string, nodeId: string, viewId: string): Promise<boolean> {
  return withEventTransaction(workspaceId, async () => {
    if (!(await readableNoteUnderLock(actor, workspaceId, nodeId))) return false;
    const prev = await viewRecordById("note", workspaceId, nodeId, viewId);
    if (!prev) return false;
    await mutate({
      actor,
      workspaceId,
      authority: { kind: "irreversible", of: authorityFor(nodeId) }, // no inverse (restoreContract.ts)
      event: {
        type: "COLLECTION_VIEW_DELETED",
        targetType: "node",
        targetId: nodeId,
        payload: { node_id: nodeId, view_id: viewId, name: (prev as { name?: string }).name },
        txMeta: { inverse_op: "collection_view.created", prev_field_values: prev, ui_context: "node.view.delete" },
      },
      apply: async () => {
        await removeView(workspaceId, nodeId, viewId);
      },
    });
    return true;
  });
}

/** The fields of the tags the readable children carry (each tag's effective
 *  fields; the first tag giving a name wins): what types the columns and
 *  orders a board's columns. */
async function childFields(workspaceId: string, nodeId: string, readable: string[]) {
  const tags = (await pool.query<{ tag_id: string }>(
    `SELECT nt.tag_id::text AS tag_id, count(*) AS n
       FROM node_tags nt JOIN content_nodes c ON c.id = nt.node_id
      WHERE c.workspace_id = $1 AND c.parent_id = $2 AND ${liveNodeSql("c")} AND c.hidden = false
        AND c.id = ANY($3::uuid[])
      GROUP BY nt.tag_id ORDER BY n DESC, nt.tag_id`,
    [workspaceId, nodeId, readable],
  )).rows.map((r) => r.tag_id);
  if (tags.length === 0) return [];
  const effective = effectiveTagFields(await loadTagFieldRows(workspaceId));
  const byName = new Map<string, { name: string; type?: string; max?: number; options?: string[] }>();
  for (const tagId of tags) {
    for (const f of (effective.get(tagId) ?? []) as Array<{ name?: string; type?: string; max?: number; options?: string[] }>) {
      if (f?.name && !byName.has(f.name)) byName.set(f.name, { ...f, name: f.name });
    }
  }
  return [...byName.values()];
}

/** Run a note's saved view over its children: the same page and row shape as
 *  executeTagView, bounded by the actor's read set. Null when the note or the
 *  view is missing or unreadable. */
export async function executeNoteView(
  actor: ActorCtx, workspaceId: string, nodeId: string, viewId: string,
  page: { limit: number; offset: number },
) {
  if (!(await canReadNode(actor, nodeId))) return null;
  const viewRow = await pool.query<{
    layout: string; filters: FilterClause[]; sorts: SortClause[];
    group_by: string | null; visible_fields: string[]; layout_config: Record<string, unknown>;
  }>(
    `SELECT r.function_id AS layout, r.config->'filters' AS filters, r.config->'sorts' AS sorts, r.config->>'group_by' AS group_by,
            r.config->'visible_fields' AS visible_fields, r.config->'layout_config' AS layout_config
       FROM function_refs r JOIN content_nodes n ON n.id = r.holder_node_id
      WHERE n.workspace_id = $1 AND n.id = $2 AND ${notTagNodeSql("n")} AND ${liveNodeSql("n")} AND r.instance = $3`,
    [workspaceId, nodeId, viewId],
  );
  const view = viewRow.rows[0];
  if (!view) return null;
  const readable = [...await readableNodeIdSet(actor, workspaceId)];
  const fields = await childFields(workspaceId, nodeId, readable);
  const fieldMeta: Record<string, { type: string; max?: number }> = {};
  for (const f of fields) if (f.type) fieldMeta[f.name] = { type: f.type, ...(f.max ? { max: f.max } : {}) };
  const { rows, total, next } = await executeView({
    workspaceId, parentId: nodeId,
    filters: view.filters ?? [],
    sorts: view.sorts ?? [],
    visibleFields: view.visible_fields ?? [],
    placementFields: placementFields(view),
    limit: page.limit, offset: page.offset,
    readableIds: readable,
  });
  const group = view.group_by ? fields.find((f) => f.name === view.group_by) : undefined;
  const groupFieldOptions = group?.type === "select" && Array.isArray(group.options) && group.options.length > 0 ? group.options : null;
  const layout = view.layout === "list" ? "table" : view.layout;
  return {
    rows, total, next,
    view: {
      layout,
      group_by: view.group_by,
      group_field_options: groupFieldOptions,
      visible_fields: view.visible_fields,
      layout_config: view.layout_config,
      field_meta: fieldMeta,
    },
  };
}
