import { useMemo } from "react";
import { useAppSelector, useSelectedId, useAllNodes } from "../lib/appStore";

/**
 * Which lenses the focused node earns, beyond its content.
 *
 * - Canvas: a node that already has a board to reopen, has children to lay
 *   out, or is a tag (its members as a board). Only with the whiteboard module
 *   imported. Showing the tab never silently creates a board.
 */
export function useLensAvailability({ isTag, canvasImported }: { isTag: boolean; canvasImported: boolean }) {
  const selectedId = useSelectedId();
  const nodes = useAllNodes();
  const memberships = useAppSelector((s) => s.data.canvas_memberships);
  // Scanned when the node list, the boards or the selection change — not on
  // every store update.
  const hasChildren = useMemo(
    () => !!selectedId && nodes.some((n) => n.parent_id === selectedId && !n.hidden),
    [nodes, selectedId],
  );
  const hasBoard = useMemo(
    () => !!selectedId && (memberships ?? []).some((m) => m.node_id === selectedId),
    [memberships, selectedId],
  );
  return {
    hasChildren,
    hasBoard,
    canvas: canvasImported && (hasChildren || hasBoard || isTag),
  };
}
