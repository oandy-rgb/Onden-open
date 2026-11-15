import type { ModuleDefinition } from "../types.js";

// A view module like modules/calendar (docs/architecture/views-as-modules.md).
export const kanbanViewModule: ModuleDefinition = {
  id: "kanban",
  registerRoutes: () => {},
  viewLayout: {},
  // A library module of the workspace (on or off) that makes no tag: a view is a function reference of its tag or note.
  library: {},
};
