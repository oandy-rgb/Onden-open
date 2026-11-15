// A view module like modules/calendar (docs/architecture/views-as-modules.md).

import { Kanban } from "lucide-react";
import type { FrontendModule } from "../types";
import { lazyWithReload } from "../../lib/lazyWithReload";

// The layout loads when a view of it is drawn (components/collections/CollectionView shows it in a Suspense).
/** One loader for the lazy layout and the offline warm-up (modules/index loadOfflineModuleScreens). */
export const loadKanbanLayout = () => import("./KanbanLayout");
const KanbanLayout = lazyWithReload(loadKanbanLayout);

export const kanbanViewModule: FrontendModule = {
  id: "kanban",
  library: {
    title: "Board",
    description: "Show a tag's notes, or a note's sub-notes, as cards in columns, one per value of a field, and drag them between columns.",
    Icon: Kanban,
    manifest: {
      adds: [
        { kind: "view", text: "A Board layout for the views of a tag, and of a note with sub-notes, one column per value of a field." },
      ],
      notes: "Only the notes of tags, and the sub-notes of notes, you show as a board; dragging a card changes that field.",
      network: null,
    },
  },
  view: { Layout: KanbanLayout, param: { key: "group_by", label: "Columns by", types: ["select"] } },
};
