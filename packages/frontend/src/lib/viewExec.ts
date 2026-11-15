import type { ExecRow } from "@onden/contract";
// What a saved view returns when it runs (POST …/exec): the shapes view layouts draw.

// Every layout is a view module (modules/index.ts VIEW_MODULES): the switch
// lists the imported ones in registry order, named by the module's library
// title. renderLayout below draws each with the module's own Layout. The
// type is the module id, so a new layout needs no edit here.
export type ViewLayoutType = string;

/** One page of a saved view (backend services/paging.ts Page) and its config.
 *  `total` counts every row the view matches; `next` is the offset of the
 *  next page, null once every row is here. */
export interface ExecResponse {
  rows: ExecRow[];
  total?: number;
  next: number | null;
  view: {
    layout: ViewLayoutType;
    group_by: string | null;
    /** Declared option order of the group field (select fields only); null
     *  when the field has no declared options. Layouts order columns by it. */
    group_field_options?: string[] | null;
    visible_fields: string[];
    layout_config: Record<string, unknown>;
    /** Per-field schema metadata for type-aware cells (e.g. rating → stars). */
    field_meta?: Record<string, { type: string; max?: number }>;
  };
}
