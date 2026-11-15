// View modules (frontend) — calendar, board and cards: layouts a tag's saved
// views can take (docs/architecture/views-as-modules.md). They are not
// functions with a card; a view of the layout is a tab on the tag page,
// added from 「＋ 檢視」, which asks for the one field the layout needs.
// Imported by default — every collection had them before the library — and
// removable in Settings › Modules, which hides their views and keeps them.
// The module id is the layout name (backend modules/views).

import { CalendarDays } from "lucide-react";
import type { FrontendModule } from "../types";
import { lazyWithReload } from "../../lib/lazyWithReload";

// The layout loads when a view of it is drawn (components/collections/CollectionView shows it in a Suspense).
/** One loader for the lazy layout and the offline warm-up (modules/index loadOfflineModuleScreens). */
export const loadCalendarLayout = () => import("./CalendarLayout");
const CalendarLayout = lazyWithReload(loadCalendarLayout);

export const calendarViewModule: FrontendModule = {
  id: "calendar",
  library: {
    title: "Calendar",
    description: "Show a tag's notes, or a note's sub-notes, on a month calendar by one of their date fields.",
    Icon: CalendarDays,
    manifest: {
      adds: [
        { kind: "view", text: "A Calendar layout for the views of a tag, and of a note with sub-notes, by a date field." },
      ],
      notes: "Only the notes of tags, and the sub-notes of notes, you show on a calendar.",
      network: null,
    },
  },
  view: {
    Layout: CalendarLayout,
    param: {
      key: "date_field", label: "Date field", types: ["date"], onlyTypes: true,
      builtIns: [{ key: "created_at", label: "Created date" }, { key: "updated_at", label: "Last edited date" }],
    },
  },
};
