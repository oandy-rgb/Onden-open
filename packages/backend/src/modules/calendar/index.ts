import type { ModuleDefinition } from "../types.js";

// View modules (docs/architecture/views-as-modules.md): calendar, board and
// cards are layouts a tag's saved view can use, listed in the module library
// like any module. They own no routes and no data — the views live on the tag
// (services/tagViews.ts), which refuses a layout whose module the workspace
// has not imported; list and table are built in. Every collection had them
// before the library, so they are imported by default (migration 109 adds them
// to workspaces that already record a list). Removing one hides its views on
// every tag page and keeps them. The module id is the layout name.
export const calendarViewModule: ModuleDefinition = {
  id: "calendar",
  registerRoutes: () => {},
  viewLayout: {},
  // A library module of the workspace (on or off) that makes no tag: a view is a function reference of its tag or note.
  library: {},
};
