// A view module like modules/calendar (docs/architecture/views-as-modules.md):
// the table layout of a tag's saved views — the only one that asks nothing
// when added. Made a module at the user's request (2026-10-18, 「表格我想做標籤」):
// imported by default, removable in Settings › Modules. A tag page's 「全部」
// tab is its own member listing and stays without it.

import { Table } from "lucide-react";
import type { FrontendModule } from "../types";
import { lazyWithReload } from "../../lib/lazyWithReload";

// The layout loads when a view of it is drawn (components/collections/CollectionView shows it in a Suspense).
/** One loader for the lazy layout and the offline warm-up (modules/index loadOfflineModuleScreens). */
export const loadTableLayout = () => import("./TableLayout");
const TableLayout = lazyWithReload(loadTableLayout);

export const tableViewModule: FrontendModule = {
  id: "table",
  library: {
    title: "Table",
    description: "Show a tag's notes, or a note's sub-notes, as rows with a column per field; edit values in place and group rows by a field.",
    Icon: Table,
    manifest: {
      adds: [
        { kind: "view", text: "A Table layout for the views of a tag, and of a note with sub-notes." },
      ],
      notes: "Only the notes of tags, and the sub-notes of notes, you show as a table.",
      network: null,
    },
  },
  view: { Layout: TableLayout },
};
