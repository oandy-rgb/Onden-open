import { getAppState } from "./appStore";
import { changeModuleImport } from "./moduleLibrary";
import { moduleTagOf } from "./tagModules";

/** The id of a module's tag, asking the server to (re)make it when the
 *  workspace lacks it or the module was turned off (the same write turning the
 *  module on makes). Null when that failed. */
export async function ensureModuleTagId(moduleId: string): Promise<string | null> {
  const state = getAppState();
  // A workspace's list of modules that are on (absent: every module).
  const modules = state.data.workspace?.modules;
  const on = !Array.isArray(modules) || modules.includes(moduleId);
  const tag = on ? moduleTagOf(state.data.tags ?? [], moduleId) : null;
  return tag?.id ?? (await changeModuleImport(moduleId, true, state.online).catch(() => ({ moduleTagId: null }))).moduleTagId;
}
