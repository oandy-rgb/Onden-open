import { PenTool } from "lucide-react";
import { t, tn } from "../../lib/i18n";
import { displayTitle } from "../../lib/noteLabel";
import type { NoteFunctionEnv, NoteFunctionRow } from "../types";

/** The 「白板」 row of the 「功能」 tab: the boards this note is a card on. Not on any board, no row. */
export default function canvasNoteFunctionRows({ node, canvasMemberships, nav }: NoteFunctionEnv): NoteFunctionRow[] {
  const boards = canvasMemberships.filter((m) => m.node_id === node.id);
  if (boards.length === 0) return [];
  return [{
    id: "canvas",
    Icon: PenTool,
    name: t("Canvas"),
    related: true,
    status: tn("On 1 whiteboard", "On {n} whiteboards", boards.length),
    details: boards.map((board) => displayTitle(board.canvas_title)),
    // Opens the board; the card is not selected on it yet.
    jump: { label: t("Open the whiteboard"), run: () => nav.openCanvas(boards[0]!.canvas_id) },
  }];
}
