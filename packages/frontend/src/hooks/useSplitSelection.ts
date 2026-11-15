import { useEffect, useState } from "react";
import type { Side } from "../lib/splitView";

/** Selected text on one side of the window, and where to put the button that offers it to the other side. */
export type SplitSelection = { text: string; x: number; y: number; from: Side };

/** The current selection inside the left or the right side (`data-split-side`), placed
 *  relative to the split root (`.split-root`, position: relative) so the button can be absolute. */
export function useSplitSelection(active: boolean): SplitSelection | null {
  const [selection, setSelection] = useState<SplitSelection | null>(null);
  useEffect(() => {
    if (!active) { setSelection(null); return; }
    const onChange = () => {
      const current = window.getSelection();
      const text = current?.toString().trim() ?? "";
      const anchor = current?.anchorNode instanceof Element ? current.anchorNode : current?.anchorNode?.parentElement;
      const side = anchor?.closest<HTMLElement>("[data-split-side]")?.dataset.splitSide;
      if (!text || !current?.rangeCount || (side !== "left" && side !== "right")) { setSelection(null); return; }
      const box = current.getRangeAt(0).getBoundingClientRect();
      const root = document.querySelector(".split-root")?.getBoundingClientRect();
      setSelection({ text, x: box.left - (root?.left ?? 0), y: box.bottom - (root?.top ?? 0) + 6, from: side });
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, [active]);
  return selection;
}

