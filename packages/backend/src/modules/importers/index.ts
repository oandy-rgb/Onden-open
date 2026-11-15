import type { ModuleDefinition, ModuleApp } from "../types.js";
import router from "./routes.js";

// Importers — a built-in module (docs/agents/decisions-modules.md): its code has
// the module's boundary (one entry, one place to mount) but it is always
// available. No `library`, so there is no switch, no import step and no write
// gate: importing notes is part of owning a workspace, not a feature a tag
// brings in.
//
//   • POST /api/import/obsidian takes a folder's files (Markdown, CSV, Notion
//     exports, task lists, images) and writes them through the same spine
//     operations as any other edit; GET /api/import/sources lists the sources
//     already imported;
//   • shared/ holds what the sources have in common (identity of an imported
//     note, image links, relation resolution). services/importRefusal.ts stays
//     out because other modules apply the same rule;
//   • backup restore and export do not use this module, so the core never
//     depends on it.

export const importersModule: ModuleDefinition = {
  id: "importers",
  routePrefixes: ["/api/import"],
  registerRoutes: (app: ModuleApp) => {
    app.route("/api/import", router);
  },
};
