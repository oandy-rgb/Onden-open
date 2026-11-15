// A note's pin and colour as two operations the sidebar menu, the ⌘K palette
// and the note's own menus share, so none of them composes the attribute
// writes itself. Both ride the reserved attributes of lib/noteMarks.

import type { ContentNode } from "../api";
import { COLOR_ATTR, PINNED_ATTR, isPinned } from "../noteMarks";
import { runBackgroundWrite } from "./backgroundWrite";
import { propertyWriter } from "./domainWriters";

export const noteMarkActions = {
  /** Pin the note, or unpin it when it is pinned. */
  togglePin(node: Pick<ContentNode, "id" | "attrs">): void {
    runBackgroundWrite(isPinned(node)
      ? propertyWriter.remove(node.id, PINNED_ATTR)
      : propertyWriter.set(node.id, PINNED_ATTR, "true", { value_type: "bool", is_inheritable: false }));
  },
  /** Colour the note (#rrggbb); null clears it. */
  setColor(nodeId: string, color: string | null): void {
    runBackgroundWrite(color === null
      ? propertyWriter.remove(nodeId, COLOR_ATTR)
      : propertyWriter.set(nodeId, COLOR_ATTR, color, { value_type: "text", is_inheritable: false }));
  },
};
