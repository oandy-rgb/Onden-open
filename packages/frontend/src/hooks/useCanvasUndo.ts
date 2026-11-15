// 卡片位置的復原項目：一次手勢擁有所有選取的卡片／群組與原本的群組成員，
// 經同一次版面寫入還原。項目登記在白板唯一的復原紀錄（useBoardHistory），
// 與手寫、移除卡片、連線依時間順序一起退回；這裡只負責「位置」這種項目怎麼退回。
// 項目只在伺服器或離線佇列接受後才移出；不是跨工作階段的歷史，也不管新增／縮放。
// 重做只在卡片仍停在復原留下的位置時成立。復原只退回仍停在手勢留下位置的卡片或群組：
// 之後被移動過的（例如另一台裝置）保留較新的位置（GAP-180）。

import { useCallback, useEffect, useRef } from "react";
import type { CardPosition, CanvasPositions } from "../lib/sectionCarry";
import type { CanvasData, GraphPosition } from "../lib/api";
import { useBoardHistory } from "./useBoardHistory";

/** One gesture: where it moved things from, and (once known) to. */
type Entry = CanvasPositions & { after?: CanvasPositions };

const samePlace = (a: { x: number; y: number } | undefined, b: { x: number; y: number }) =>
  !!a && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;

function positionsIn(layout: CanvasData, of: CanvasPositions): CanvasPositions {
  const cards = new Map(layout.nodes.map((n) => [n.nodeId, n]));
  const sections = new Map((layout.sections ?? []).map((s) => [s.id, s]));
  return {
    nodes: of.nodes.flatMap((p) => { const n = cards.get(p.nodeId); return n ? [{ nodeId: p.nodeId, x: n.x, y: n.y }] : []; }),
    sections: of.sections.flatMap((p) => { const s = sections.get(p.id); return s ? [{ id: p.id, x: s.x, y: s.y }] : []; }),
  };
}

export function useCanvasUndo({ canvasId, layout, onRestorePositions, onSkipped }: {
  canvasId: string | null;
  /** The board as currently shown. Without it, undo restores unconditionally. */
  layout?: CanvasData;
  /** Called with how many cards/groups undo left alone because they moved since. */
  onSkipped?: (count: number) => void;
  onRestorePositions: (nodes: GraphPosition[], sections: CardPosition[]) => Promise<unknown> | void;
}) {
  const history = useBoardHistory({ canvasId });
  const { push } = history;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const onSkippedRef = useRef(onSkipped);
  onSkippedRef.current = onSkipped;
  const onRestoreRef = useRef(onRestorePositions);
  onRestoreRef.current = onRestorePositions;
  // Entries whose destination is not known yet; the next layout supplies it.
  const waiting = useRef<Entry[]>([]);
  useEffect(() => { waiting.current = []; }, [canvasId]);

  useEffect(() => {
    if (!layout) return;
    for (const entry of waiting.current) entry.after = positionsIn(layout, entry);
    waiting.current = [];
  }, [layout]);

  // Put the gesture's cards back where it found them (undo) or where it left
  // them (redo); each only for cards still where the other side put them.
  const move = useCallback(async (entry: Entry, undoing: boolean): Promise<boolean> => {
    const before = { nodes: entry.nodes, sections: entry.sections };
    const from = undoing ? entry.after : before;
    const to = undoing ? before : entry.after;
    let nodes = to?.nodes ?? entry.nodes;
    let sections = to?.sections ?? entry.sections;
    const current = layoutRef.current;
    if (current && from && to) {
      const now = positionsIn(current, entry);
      const nodeNow = new Map(now.nodes.map((p) => [p.nodeId, p]));
      const sectionNow = new Map(now.sections.map((p) => [p.id, p]));
      const nodeFrom = new Map(from.nodes.map((p) => [p.nodeId, p]));
      const sectionFrom = new Map(from.sections.map((p) => [p.id, p]));
      nodes = to.nodes.filter((p) => { const at = nodeFrom.get(p.nodeId); return !!at && samePlace(nodeNow.get(p.nodeId), at); });
      sections = to.sections.filter((p) => { const at = sectionFrom.get(p.id); return !!at && samePlace(sectionNow.get(p.id), at); });
      const skipped = to.nodes.length + to.sections.length - nodes.length - sections.length;
      if (skipped > 0) onSkippedRef.current?.(skipped);
      if (!nodes.length && !sections.length) return false;
    } else if (!to) {
      // Redo needs to know where the gesture left things; a tidy undone before the next layout
      // supplied that never will have it.
      return false;
    }
    await onRestoreRef.current(nodes, sections);
    return true;
  }, []);

  // `after` is where the gesture puts things; when the caller cannot say
  // (an arrangement computed elsewhere), it is read from the next layout.
  const recordPositions = useCallback((nodes: GraphPosition[], sections: CardPosition[] = [], after?: CanvasPositions) => {
    if (!nodes.length && !sections.length) return;
    const entry: Entry = {
      nodes: nodes.map(p => ({ ...p })),
      sections: sections.map(p => ({ ...p })),
      ...(after ? { after: { nodes: after.nodes.map(p => ({ ...p })), sections: after.sections.map(p => ({ ...p })) } } : {}),
    };
    if (!entry.after) waiting.current.push(entry);
    push({ undo: () => move(entry, true), redo: () => move(entry, false) });
  }, [push, move]);

  return { recordPositions, undo: history.undo, canUndo: history.canUndo, redo: history.redo, canRedo: history.canRedo, history };
}
