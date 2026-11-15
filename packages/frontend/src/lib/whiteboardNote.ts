// The whiteboard is a view of a note, not a kind of note (migration 138). A
// note "has a whiteboard" when its saved views include one of layout "canvas"
// (the whiteboard tab, shown or hidden); its cards are placements keyed by the
// note's own id. A note of the retired node kind 'canvas' is the same thing
// before the server converted it — a stale local copy, or a server not yet
// migrated — so both read as one.

import type { ContentNode } from "./api";
import { isCanvas } from "@onden/markdown/contract";

type NodeViews = Pick<ContentNode, "node_type" | "collection_views">;

/** The view is the whiteboard tab (shown or hidden). */
export const isWhiteboardLayout = (view: { layout?: string } | null | undefined): boolean => view?.layout === "canvas";

/** The whiteboard tab among an owner's views, if any. The one place that
 *  finds it, whichever cache the views came from. */
export function whiteboardTabIn<V extends { layout?: string }>(views: readonly (V | null | undefined)[] | null | undefined): V | null {
  return (views ?? []).find((view): view is V => isWhiteboardLayout(view)) ?? null;
}

/** The note's stored whiteboard tab, if any. */
export function whiteboardTabOf(node: Pick<ContentNode, "collection_views">) {
  return whiteboardTabIn(Array.isArray(node.collection_views) ? node.collection_views : []);
}

/** The note is still of the retired node kind 'canvas'. Only for decisions about
 *  that kind itself; "does it hold a whiteboard" is isWhiteboardNote / ownsBoard. */
export const isRetiredBoardKind = (node: Pick<ContentNode, "node_type">): boolean => isCanvas(node);

/** The note has a whiteboard of its own: the tab (as stored on the note, or as
 *  read from its views), cards on its board, or the retired kind. */
export function ownsBoard(
  node: NodeViews & Pick<ContentNode, "id">,
  memberships: readonly { canvas_id: string }[] | null | undefined,
  views?: readonly { layout?: string }[],
): boolean {
  return isWhiteboardNote(node)
    || whiteboardTabIn(views) !== null
    || (memberships ?? []).some((m) => m.canvas_id === node.id);
}

/** The note has been a whiteboard since the tab said so: it opens there. */
export const opensOnWhiteboardView = (view: { layout_config?: Record<string, unknown> | null } | null | undefined) =>
  !!view && view.layout_config?.opens_first === true && view.layout_config?.hidden !== true;

/** The note holds a whiteboard: it has the tab (even hidden) or is still of the retired kind. */
export function isWhiteboardNote(node: NodeViews): boolean {
  return isRetiredBoardKind(node) || whiteboardTabOf(node) !== null;
}

/** The note opens on its whiteboard until the person chooses another tab. */
export function opensOnWhiteboard(node: NodeViews): boolean {
  if (isRetiredBoardKind(node)) return true;
  return opensOnWhiteboardView(whiteboardTabOf(node));
}
