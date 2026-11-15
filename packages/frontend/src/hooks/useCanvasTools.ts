import { useEffect, useState } from "react";
import type { InkActiveTool } from "../lib/ink/types";
import { BOARD_TOOL_KEYS } from "../lib/shortcuts";
import { useDismiss } from "./useEscapeKey";

/** select: pick and drag; hand: drag pans the board; card / section: the next
 *  pane click places one, then back to select; pen: draw ink on the board. */
export type CanvasTool = "select" | "hand" | "card" | "section" | "pen";

function typingInto(target: EventTarget | null): boolean {
  const el = target as HTMLElement;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA";
}

/**
 * The whiteboard's active tool and its keyboard: V/Esc select, C card,
 * S section, P pen, E eraser (bare keys, ignored while typing). Ink needs a
 * named board to store strokes on, so pen and eraser are unavailable without
 * one, and leaving the board while drawing returns to select.
 *
 * The pen's own state (which pen tool, colour, size) is the shared useInkPen's;
 * `onPenTool` hands it the tool a key picks.
 *
 * While the pen is active, holding Space hands the drag to the board's pan
 * (`spaceHeld`); the ink layer turns pointer-transparent meanwhile.
 */
export function useCanvasTools({ boardId, inkEnabled, onPenTool }: { boardId: string | null; inkEnabled: boolean; onPenTool: (tool: InkActiveTool) => void }) {
  const [tool, setTool] = useState<CanvasTool>("select");
  const [spaceHeld, setSpaceHeld] = useState(false);
  const canDraw = !!boardId && inkEnabled;

  /** Start drawing with a pen tool; does nothing without a board to draw on. */
  const startPen = (kind: InkActiveTool = "pen") => {
    if (!canDraw) return;
    setTool("pen");
    onPenTool(kind);
  };

  // Esc and Back leave a tool (pen, card, section) for select; typing into a field keeps its own Esc.
  useDismiss((via) => {
    if (via !== "back" && typingInto(via.target)) return false;
    setTool("select");
  }, tool !== "select");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return; // bare-letter modes only
      if (typingInto(e.target)) return;
      // The letters live in lib/shortcuts (BOARD_TOOL_KEYS), which also keeps
      // them out of the shortcuts a person can assign.
      const pick = e.key.length === 1 ? BOARD_TOOL_KEYS[e.key.toLowerCase() as keyof typeof BOARD_TOOL_KEYS] : undefined;
      if (pick === "select" || pick === "card" || pick === "section") setTool(pick);
      else if (pick) startPen(pick);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- startPen reads canDraw, which these determine
  }, [boardId, inkEnabled]);

  // Spacebar-pan while in pen mode: hold space → the ink layer goes
  // pointer-transparent and React Flow pans on left-drag; release → draw.
  useEffect(() => {
    if (tool !== "pen") {
      setSpaceHeld(false);
      return;
    }
    function down(e: KeyboardEvent) {
      if (e.key !== " ") return;
      if (typingInto(e.target)) return;
      e.preventDefault(); // no page scroll while panning
      setSpaceHeld(true);
    }
    function up(e: KeyboardEvent) {
      if (e.key === " ") setSpaceHeld(false);
    }
    const blur = () => setSpaceHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [tool]);

  // Nothing to draw on any more — no board, or one that holds no ink (a tag's) —
  // while the pen is in hand: drop back to select.
  useEffect(() => {
    if (!canDraw) setTool((m) => (m === "pen" ? "select" : m));
  }, [canDraw]);

  return { tool, setTool, startPen, spaceHeld };
}
