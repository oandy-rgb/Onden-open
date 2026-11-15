import { useEffect, useState } from "react";
import { getAppState, selectOverviewSelectedNode } from "../lib/appStore";
import { dialogEntryOf, moduleEntry, noteCommandModule, type ModuleTarget, type NoteCommand } from "../modules";
import { useStableCallback } from "./useStableCallback";
import { onFeatureRequest } from "../lib/featureRequest";

type Options = {
  setMode: (mode: string) => void;
  refresh: () => Promise<void>;
  openNote: (id: string) => void;
};

/**
 * Opening modules from the workspace shell. Importing one is Settings ›
 * Modules' alone (the module library).
 *
 * Module screens (modules/index MODULE_SCREENS) are full pages, i.e. modes. A
 * target deep-links one: an article or source in the reader, the cards under
 * one note in Review. Opening without a target clears it.
 */
export function useWorkspaceModules({ setMode, refresh, openNote }: Options) {
  const [moduleTarget, setModuleTarget] = useState<ModuleTarget | null>(null);
  // True while the open screen wants the whole viewport (an article on a
  // phone): the app chrome (topbar + bottom nav) steps aside.
  const [moduleImmersive, setModuleImmersive] = useState(false);
  const openModule = useStableCallback((id: string, target?: ModuleTarget) => {
    setModuleTarget(target ?? null);
    setMode(id);
  });
  /** Open a module's screen with no target (topbar, mobile nav, sidebar "+"). */
  const openModuleScreen = useStableCallback((id: string) => openModule(id));
  /** Open what an imported module adds (the top bar and the phone's 「更多」). */
  const openFeature = useStableCallback((id: string) => {
    const entry = moduleEntry(id);
    if (entry) openModule(entry.view);
  });
  // Settings › Modules asks to open a function's page (lib/featureRequest).
  useEffect(() => onFeatureRequest(openFeature), [openFeature]);
  // A module's action on the note in the editor (note menu and palette).
  const runNoteCommand = useStableCallback((command: NoteCommand) => {
    const node = getAppState().selectedId ? selectOverviewSelectedNode(getAppState()) : null;
    const moduleId = noteCommandModule(command);
    if (!node || !moduleId) return;
    void command.run({ node, open: (target) => openModule(moduleId, target), openNode: openNote, refresh });
  });

  // A module's add dialog (SKILL.md) from the palette; the tag page opens it directly.
  const openDialogEntry = useStableCallback((moduleId: string) => dialogEntryOf(moduleId)?.open({ onOpenNode: openNote }));

  return {
    moduleTarget, moduleImmersive, setModuleImmersive,
    openModule, openModuleScreen, openFeature, runNoteCommand, openDialogEntry,
  };
}
