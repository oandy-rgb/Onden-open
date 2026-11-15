// Per-node UI state for BuilderApp.
//
// Extracted from BuilderApp.tsx during Day 4 hook refactor. Bundles:
//   - canvasNavStack — back-button stack for nested canvas drill-down
//   - nodeMenu / ctxMenu — per-node context menus
//   - renamingNodeId / renameDraft — rename-in-place state
//
// selectedId moved to lib/appStore (H4): selection is app-wide state that
// components subscribe to via selectors; setSelectedId is a stable store
// action importable anywhere.

import { useState, useCallback } from "react";
import type { CtxMenu } from "../lib/ctxMenu";

export function useNodeSelection() {
  const [canvasNavStack, setCanvasNavStack] = useState<string[]>([]);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const [renamingNodeId, setRenamingNodeId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const pushCanvas = useCallback((nodeId: string) => {
    setCanvasNavStack(stack => [...stack, nodeId]);
  }, []);

  const popCanvas = useCallback(() => {
    setCanvasNavStack(stack => stack.slice(0, -1));
    return undefined;
  }, []);

  const closeMenus = useCallback(() => {
    setCtxMenu(null);
  }, []);

  return {
    canvasNavStack,
    setCanvasNavStack,
    pushCanvas,
    popCanvas,
    ctxMenu,
    setCtxMenu,
    closeMenus,
    renamingNodeId,
    setRenamingNodeId,
    renameDraft,
    setRenameDraft,
  };
}
