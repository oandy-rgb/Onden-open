import type { ModuleDefinition } from "../types.js";

// A view module like modules/calendar (docs/architecture/views-as-modules.md).
export const galleryViewModule: ModuleDefinition = {
  id: "gallery",
  registerRoutes: () => {},
  viewLayout: { siteViewKind: "cards" },
  // A library module of the workspace (on or off) that makes no tag: a view is a function reference of its tag or note.
  library: {},
};
