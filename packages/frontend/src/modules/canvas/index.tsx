// Whiteboard module (frontend) — the registration of the whiteboard (白板):
// canvases, a note's or a tag's board lens, the boards a note appears on. The
// whiteboard itself is core code (KnowledgeWorkspace, the board lens in
// BuilderApp, canvas writers): its surfaces are woven into the notes screen
// rather than one module screen, so the shell asks for the "whiteboard" shell
// feature (lib/shellFeatures). It is always on, like the view modules: no
// switch in Settings, whatever a workspace's stored list says
// (docs/architecture/module-library.md, 「白板」).

import { PenTool } from "lucide-react";
import type { FrontendModule } from "../types";
import { isWhiteboardNote } from "../../lib/whiteboardNote";

export const canvasModule: FrontendModule = {
  id: "canvas",
  shellFeature: "whiteboard",
  noteFunctionRows: () => import("./noteFunctionRows"),
  library: {
    // A board exists: a note with a whiteboard tab (or still of the retired kind).
    inUse: ({ nodes }) => nodes.some((n) => isWhiteboardNote(n) && !n.deleted_at),
    title: "Canvas",
    description: "Lay notes out as cards on a board: arrange and connect them, draw on it, and give a tag a board of its notes.",
    Icon: PenTool,
    // Chosen with 「＋」 like the other ways of seeing, never switched (owner, 2026-10-28/30).
    alwaysOn: true,
    manifest: {
      adds: [
        { kind: "page", text: "Boards under Notes: notes as cards, with connections and drawing." },
      ],
      notes: "Only the notes you put on a board.",
      network: null,
    },
  },
};
