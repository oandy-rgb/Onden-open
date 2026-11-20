import { randomUUID } from "node:crypto";
import { pool, q, requireTransaction } from "../db.js";
import { readableScopeSql } from "./readPolicy.js";
import { spaceScopeSql } from "../spine/spaceScope.js";
import { insertView } from "./functionRefs.js";
import { WHITEBOARD_LAYOUT } from "./viewLayouts.js";
import { sql } from "kysely";
import { db } from "../dbKysely.js";
import type { BoardCardPatch } from "@onden/contract";
import type { ActorCtx } from "../types.js";
import { liveNodeSql } from "../spine/nodeSql.js";
import { isTag } from "@onden/markdown/contract";

// Board layout storage — the one writer of each piece (W23):
//   • node_positions: a node's placement per surface (the note or tag whose
//     board it is, or 'graph' for the global force-graph). setNodePosition is the only upsert
//     (routes/boards.ts for board cards, PUT /nodes/:id/position for 'graph').
//   • a board's section frames, in the board node's '_canvas_sections'
//     attribute: readSections / writeSections.
// Reads of placements are filtered to what the actor can read, so a hidden
// card's id and position never leave. Positions are UI/layout state, not
// semantic — they emit no domain events of their own (a drag must not spam
// the event log); the board write that carries them does.

export type Position = {
  x: number;
  y: number;
  width?: number | null;
  height?: number | null;
  color?: string | null;
  folded?: boolean;
  subCanvasId?: string | null;
};

export type SurfacePosition = Position & { nodeId: string };

/** Upsert one node's position on a surface. */
export async function setNodePosition(
  workspaceId: string,
  nodeId: string,
  surface: string,
  pos: Position,
): Promise<void> {
  await q(
    `INSERT INTO node_positions
       (node_id, surface, x, y, width, height, color, folded, sub_canvas_id, workspace_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (node_id, surface) DO UPDATE
       SET x = EXCLUDED.x, y = EXCLUDED.y, width = EXCLUDED.width, height = EXCLUDED.height,
           color = EXCLUDED.color, folded = EXCLUDED.folded, sub_canvas_id = EXCLUDED.sub_canvas_id,
           updated_at = now()`,
    [nodeId, surface, pos.x, pos.y, pos.width ?? null, pos.height ?? null,
     pos.color ?? null, pos.folded ?? false, pos.subCanvasId ?? null, workspaceId],
  );
}

/** Apply a card's changed fields on a board: absent fields stay as stored, `null` clears. A card
 *  with no stored placement is created only when the patch has both x and y (never a card without
 *  a place); otherwise there is nothing to change and nothing is written. */
export async function patchNodePosition(
  workspaceId: string, nodeId: string, surface: string, patch: BoardCardPatch,
): Promise<void> {
  const changed = {
    ...(patch.x !== undefined ? { x: patch.x } : {}),
    ...(patch.y !== undefined ? { y: patch.y } : {}),
    ...(patch.width !== undefined ? { width: patch.width } : {}),
    ...(patch.height !== undefined ? { height: patch.height } : {}),
    ...(patch.color !== undefined ? { color: patch.color } : {}),
    ...(patch.folded !== undefined ? { folded: patch.folded } : {}),
    ...(patch.subCanvasId !== undefined ? { sub_canvas_id: patch.subCanvasId } : {}),
  };
  if (Object.keys(changed).length === 0) return;
  const update = { ...changed, updated_at: sql<Date>`now()` };
  if (patch.x === undefined || patch.y === undefined) {
    await db.updateTable("node_positions").set(update).where("node_id", "=", nodeId).where("surface", "=", surface).execute();
    return;
  }
  await db.insertInto("node_positions")
    .values({
      node_id: nodeId, surface, x: patch.x, y: patch.y, width: patch.width ?? null, height: patch.height ?? null,
      color: patch.color ?? null, folded: patch.folded ?? false, sub_canvas_id: patch.subCanvasId ?? null,
      workspace_id: workspaceId, updated_at: sql<Date>`now()`,
    })
    .onConflict((oc) => oc.columns(["node_id", "surface"]).doUpdateSet(update))
    .execute();
}

/** A surface's placements the actor may read (the global graph on bootstrap,
 *  a board's cards through readCards). */
export async function readPositionsForSurface(actor: ActorCtx | null, workspaceId: string, surface: string): Promise<SurfacePosition[]> {
  const params: unknown[] = [workspaceId, surface];
  const scope = readableScopeSql(actor, "n", params);
  const r = await q<{ node_id: string; x: number; y: number; width: number | null; height: number | null; color: string | null; folded: boolean; sub_canvas_id: string | null }>(
    `SELECT np.node_id, np.x, np.y, np.width, np.height, np.color, np.folded, np.sub_canvas_id
       FROM node_positions np
       JOIN content_nodes n ON n.id = np.node_id
      WHERE np.workspace_id = $1 AND np.surface = $2 AND ${scope}`,
    params,
  );
  return r.rows.map((row) => ({
    nodeId: row.node_id, x: row.x, y: row.y, width: row.width, height: row.height,
    color: row.color, folded: row.folded, subCanvasId: row.sub_canvas_id,
  }));
}

/** Drop all placements on a surface (e.g. when a canvas is deleted). Uses q()
 *  so it joins an open transaction (the canvas-delete mutate) when present. */
export async function clearSurface(workspaceId: string, surface: string): Promise<void> {
  requireTransaction("clearSurface");
  await q(`DELETE FROM node_positions WHERE workspace_id = $1 AND surface = $2`, [workspaceId, surface]);
}

export type BoardCard = {
  nodeId: string;
  x: number;
  y: number;
  width?: number | null;
  height?: number | null;
  color?: string | null;
  folded?: boolean;
  subCanvasId?: string | null;
};

export type BoardSection = {
  id: string;
  title?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string | null;
  [extra: string]: unknown;
};

/** The whiteboard is a view of a note (migration 138): any live note can hold
 *  a board, keyed by its own id; a tag's board is keyed by the tag. 'canvas'
 *  is the retired node kind, still read from a database not yet migrated. */
export type BoardNode = { id: string; node_type: "content" | "canvas" | "class_tag" };

/** A tag's board is a shared arrangement of its members; every other board
 *  belongs to a note and is written as an edit of that note. */
export const isNoteBoard = (board: Pick<BoardNode, "node_type">) => !isTag(board);

export async function findBoardNode(workspaceId: string, id: string): Promise<BoardNode | null> {
  const r = await pool.query<BoardNode>(
    `SELECT id, node_type FROM content_nodes
      WHERE id = $1 AND workspace_id = $2 AND ${liveNodeSql()}
        AND node_type IN ('content', 'canvas', 'class_tag')`,
    [id, workspaceId],
  );
  return r.rows[0] ?? null;
}

/** `alias` is a note that has a whiteboard tab (a saved view of layout
 *  "canvas", shown or hidden) or is still the retired 'canvas' kind: the notes
 *  the /api/canvases list and its single-board routes speak of. The board's
 *  cards are node_positions with this note as surface, whether or not the tab
 *  record exists. */
export const whiteboardNoteSql = (alias: string) => `(
  ${alias}.node_type = 'canvas'
  OR (${alias}.node_type = 'content' AND EXISTS (
        SELECT 1 FROM function_refs wr
         WHERE wr.holder_node_id = ${alias}.id AND wr.instance <> '' AND wr.function_id = '${WHITEBOARD_LAYOUT}')))`;

/** The note still shows its 白板 (the same rule as the page's tabs,
 *  frontend lib/viewTabs buildViewTabs): its whiteboard record is not marked
 *  hidden. Removing the tab only sets `layout_config.hidden` on the record
 *  (a note with cards and no record shows the tab too), so the placements stay
 *  and showing the tab again brings them back. A hidden board lists none of
 *  its notes under "Appears on canvases" (services/canvasMemberships). */
export const whiteboardShownSql = (alias: string) => `NOT COALESCE((
  SELECT wr.config->'layout_config'->>'hidden' = 'true'
    FROM function_refs wr
   WHERE wr.holder_node_id = ${alias}.id AND wr.instance <> '' AND wr.function_id = '${WHITEBOARD_LAYOUT}'
   ORDER BY wr.created_at, wr.id LIMIT 1), false)`;

/** Whether a note's saved views (as the wire row carries them) include its whiteboard tab. */
export const hasWhiteboardTab = (views: unknown): boolean =>
  Array.isArray(views) && views.some((v) => !!v && typeof v === "object" && (v as { layout?: unknown }).layout === "canvas");

/** Give note `nodeId` a whiteboard tab, stored as a saved view of layout
 *  "canvas" (services/noteViews.ts). `opens_first` makes it the tab the note
 *  opens on until the person chooses another. For a note being created (or
 *  restored) in the caller's transaction: the tab is part of the creation, so
 *  it is not an event of its own. Uses q() to join that transaction. */
export async function addWhiteboardTab(
  nodeId: string,
  { name = "Canvas", opensFirst = true, layoutConfig }: { name?: string; opensFirst?: boolean; layoutConfig?: Record<string, unknown> } = {},
): Promise<void> {
  await addNoteLayoutTab(nodeId, WHITEBOARD_LAYOUT, { name, layoutConfig: layoutConfig ?? (opensFirst ? { opens_first: true } : {}) });
}

/** Give note `nodeId` a tab of a layout a module draws from the note itself (the handwriting module's 「手寫」), stored
 *  as a saved view like the whiteboard's. Like addWhiteboardTab, for a note being created or restored in the caller's
 *  transaction. The tab holds no data: the strokes are the note's own attribute and come back with its attributes. */
export async function addNoteLayoutTab(nodeId: string, layout: string, { name, layoutConfig, pinOrder = 0 }: { name: string; layoutConfig?: Record<string, unknown>; pinOrder?: number }): Promise<void> {
  requireTransaction("addNoteLayoutTab");
  const at = new Date().toISOString();
  const owner = (await q<{ workspace_id: string }>(`SELECT workspace_id FROM content_nodes WHERE id = $1`, [nodeId])).rows[0];
  if (!owner) return;
  await insertView({
    workspaceId: owner.workspace_id, holderId: nodeId, viewId: randomUUID(), layout,
    element: { name, filters: [], sorts: [], group_by: null, visible_fields: [], layout_config: layoutConfig ?? {}, pin_order: pinOrder, created_at: at, updated_at: at },
  });
}

export async function readSections(boardId: string): Promise<BoardSection[]> {
  const r = await q<{ value: string }>(
    `SELECT value FROM node_attributes WHERE node_id = $1 AND key = '_canvas_sections'`,
    [boardId],
  );
  if (!r.rows[0]) return [];
  try {
    const parsed: unknown = JSON.parse(r.rows[0].value);
    return Array.isArray(parsed) ? (parsed as BoardSection[]) : [];
  } catch {
    return [];
  }
}

export async function readCards(actor: ActorCtx, workspaceId: string, boardId: string): Promise<BoardCard[]> {
  const params: unknown[] = [workspaceId, boardId];
  const scope = readableScopeSql(actor, "n", params);
  const r = await q<{
    node_id: string; x: number; y: number; width: number | null; height: number | null;
    color: string | null; folded: boolean; sub_canvas_id: string | null;
  }>(
    `SELECT np.node_id, np.x, np.y, np.width, np.height, np.color, np.folded, np.sub_canvas_id
       FROM node_positions np
       JOIN content_nodes n ON n.id = np.node_id AND ${liveNodeSql("n")}
      WHERE np.workspace_id = $1 AND np.surface = $2 AND ${scope}`,
    params,
  );
  // Same wire shape GET /api/canvases/:id has always returned: optional
  // fields are omitted when unset.
  return r.rows.map((p) => ({
    nodeId: p.node_id, x: p.x, y: p.y,
    ...(p.width != null ? { width: p.width } : {}),
    ...(p.height != null ? { height: p.height } : {}),
    ...(p.color != null ? { color: p.color } : {}),
    ...(p.folded ? { folded: p.folded } : {}),
    ...(p.sub_canvas_id != null ? { subCanvasId: p.sub_canvas_id } : {}),
  }));
}

/** The subset of `ids` whose cards the actor may place or remove: live notes
 *  they can read, and trashed notes of a space they can read. A card of a
 *  trashed note is kept, not shown (listing joins live notes), so a removal
 *  or placement made meanwhile is still there once the note is restored. */
export async function boardCardNotesAmong(actor: ActorCtx, workspaceId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const params: unknown[] = [workspaceId, ids];
  const live = readableScopeSql(actor, "n", params);
  const trashed = spaceScopeSql(actor, "n", params);
  const r = await q<{ id: string }>(
    `SELECT n.id FROM content_nodes n
      WHERE n.workspace_id = $1 AND n.id = ANY($2::uuid[])
        AND ((${liveNodeSql("n")} AND ${live}) OR (n.deleted_at IS NOT NULL AND ${trashed}))`,
    params,
  );
  return new Set(r.rows.map((row) => row.id));
}

/** Store a board's section frames (an empty list removes the attribute). */
export async function writeSections(workspaceId: string, boardId: string, sections: readonly unknown[]): Promise<void> {
  requireTransaction("writeSections");
  if (sections.length === 0) {
    await q(`DELETE FROM node_attributes WHERE node_id = $1 AND key = '_canvas_sections'`, [boardId]);
    return;
  }
  await q(
    `INSERT INTO node_attributes (workspace_id, node_id, key, value, value_type, source)
     VALUES ($1, $2, '_canvas_sections', $3, 'text', 'ui')
     ON CONFLICT (node_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [workspaceId, boardId, JSON.stringify(sections)],
  );
}
