// Importers — a built-in module (docs/agents/decisions-modules.md): the
// folder import has a module's boundary and registry entry, but it is always
// available, so it has no `library` card, no switch and no "off" state, and
// Settings › Modules does not list it. The backend twin is
// backend/src/modules/importers (POST /api/import/obsidian).
//
// Its one setting stays where people look for it, Your Data › Import.

import type { BuiltInModule } from "../types";
import { lazyWithReload } from "../../lib/lazyWithReload";

// Loaded when Your Data › Import is shown; only the registration is in the boot chunk.
const FolderImportSetting = lazyWithReload(() => import("./FolderImportSetting"));

export const importersModule: BuiltInModule = {
  id: "importers",
  settings: [{
    id: "data.import_markdown_folder",
    tab: "data",
    section: "Import",
    label: "",
    keywords: ["import a folder", "import", "Markdown", "Obsidian", "folder", "CSV", "匯入", "資料夾"],
    type: "custom",
    component: FolderImportSetting,
  }],
};
