// Test fixture: a saved view is a function reference of its node (services/functionRefs.ts,
// migration 188) — one function_refs row, instance = the view id. seedView mirrors what
// POST /api/tags/:tagId/views produces and returns the view id; seedViewElements stores
// elements in the pre-188 collection_views shape (what a test writes by hand).

import { randomUUID } from "node:crypto";
import { q, withTransaction } from "../../db.js";
import { insertView } from "../../services/functionRefs.js";


export type SeedViewOpts = {
  name: string;
  layout?: string;
  filters?: unknown[];
  sorts?: unknown[];
  group_by?: string | null;
  visible_fields?: string[];
  layout_config?: Record<string, unknown>;
  pin_order?: number;
};

export async function seedView(tagId: string, opts: SeedViewOpts): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const elem = {
    id, tag_id: tagId, name: opts.name, layout: opts.layout ?? "list",
    filters: opts.filters ?? [], sorts: opts.sorts ?? [],
    group_by: opts.group_by ?? null, visible_fields: opts.visible_fields ?? [],
    layout_config: opts.layout_config ?? {}, pin_order: opts.pin_order ?? 0,
    created_at: now, updated_at: now,
  };
  await seedViewElements(tagId, [elem]);
  return id;
}

/** Store `elements` (the old collection_views shape: id, layout, name, … ) as the node's saved views. */
export async function seedViewElements(nodeId: string, elements: ReadonlyArray<Record<string, unknown>>): Promise<void> {
  await withTransaction(async () => {
    const workspaceId = (await q<{ workspace_id: string }>(`SELECT workspace_id FROM content_nodes WHERE id = $1`, [nodeId])).rows[0]!.workspace_id;
    for (const element of elements) {
      await insertView({ workspaceId, holderId: nodeId, viewId: String(element.id), layout: String(element.layout), element });
    }
  });
}
