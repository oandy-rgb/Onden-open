import type { ModuleDefinition } from "../types.js";

// A view module like modules/calendar (docs/architecture/views-as-modules.md):
// the table layout of a tag's saved views. The user made it a module too
// (2026-10-18, 「表格我想做標籤」), so it is imported by default and can be
// removed; a tag page's 「全部」 tab is its own member listing and stays.
export const tableViewModule: ModuleDefinition = {
  id: "table",
  registerRoutes: () => {},
  viewLayout: { siteViewKind: "table" },
  // A library module of the workspace (on or off) that makes no tag: a view is a function reference of its tag or note.
  library: {},
};
