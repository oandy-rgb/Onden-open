import type { ContentNode, Tag } from "../../lib/api";
import { t } from "../../lib/i18n";
import { setNoteSwitch } from "../../lib/noteSwitch";
import { functionCatalog } from "../../lib/tagFunctions";
import { functionModule, nodeHasTagModule } from "../../lib/tagModules";
import { MODULES, type ModuleFilter, type NoteFunctionRow } from "../../modules";

/** 「還能用在這則」 from the function catalog (lib/tagFunctions): each function the
 *  note does not have yet, with the catalog's one sentence and a button that
 *  puts the function's tag on this note. Left out: a module that already has a
 *  row of its own above (`withRows`), one with its own switch (技能), the task
 *  switches (they belong to a tag), and a module that is not imported. Loaded
 *  with the rest of the panel's wording, so it is not in the first load. */
export function catalogRows(node: ContentNode, tags: readonly Tag[], isImported: ModuleFilter, withRows: ReadonlySet<string>): NoteFunctionRow[] {
  return functionCatalog().flatMap((fn): NoteFunctionRow[] => {
    const moduleId = functionModule(fn);
    const mod = MODULES.find((m) => m.id === moduleId);
    if (fn.switchOnly || !mod || mod.noteSwitch || !isImported(moduleId) || withRows.has(moduleId) || nodeHasTagModule(node, [...tags], fn.id)) return [];
    return [{
      id: `function:${fn.id}`, Icon: fn.Icon, name: t(fn.title), related: false, status: t(fn.description),
      action: { label: t("Put it on"), run: () => { void setNoteSwitch(node, moduleId, true, tags); } },
    }];
  });
}
