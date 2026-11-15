import { useCallback, useEffect, useRef } from "react";
import { onPenShortcutEvent } from "../penShortcutBridge";
import { penShortcutTool } from "./penShortcut";
import type { InkActiveTool } from "./types";

/** Host side of the pen shortcut (penShortcut.ts): a stable `onPenShortcut`
 *  for InkEngine that flips the host's tool pen ↔ eraser through the host's
 *  own `setTool`, so the toolbar follows. Remembers the last non-eraser tool
 *  (pen, highlighter or hand) to come back to, whoever selected the eraser.
 *  The same flip answers a native shell's `onden:pen-shortcut` while `enabled`
 *  (the host is showing an editable drawing). */
export function usePenShortcutTool(
  tool: InkActiveTool,
  setTool: (tool: InkActiveTool) => void,
  enabled = true,
): () => void {
  const toolRef = useRef(tool);
  const setToolRef = useRef(setTool);
  const enabledRef = useRef(enabled);
  const lastNonEraser = useRef<InkActiveTool | null>(null);
  toolRef.current = tool;
  setToolRef.current = setTool;
  enabledRef.current = enabled;
  useEffect(() => {
    if (tool !== "eraser") lastNonEraser.current = tool;
  }, [tool]);
  const toggle = useCallback(() => {
    setToolRef.current(penShortcutTool(toolRef.current, lastNonEraser.current));
  }, []);
  useEffect(() => onPenShortcutEvent(() => {
    if (!enabledRef.current) return false;
    toggle();
    return true;
  }), [toggle]);
  return toggle;
}
