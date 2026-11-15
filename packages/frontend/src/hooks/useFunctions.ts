import { useState } from "react";
import type { Tag } from "../lib/api";
import { addToast, getAppState, useAppSelector } from "../lib/appStore";
import { t } from "../lib/i18n";
import { changeModuleImport } from "../lib/moduleLibrary";
import { tagConfigWriter } from "../lib/data";
import { MODULES, TAG_FUNCTIONS, moduleFilterFor, moduleStatusFor } from "../modules";
import { functionModule, moduleTagOf, tagFunctions } from "../lib/tagModules";

/** Who holds functions. Only tags for now (the server's function references; spaces come later). */
export type FunctionHolder = { kind: "node"; id: string };

/** How a holder has a function: it is the module's own tag; it has it itself (a reference it added);
 *  or only through the catalog's effective list (a view, or an older server's row). */
export type FunctionRoute = "own" | "direct" | "inherited";

export type FunctionOfHolder = { id: string; route: FunctionRoute; sourceTagId: string };

/** A holder's functions from the tag catalog the client already holds. Pure. */
export function functionsOfTag(tag: Tag): FunctionOfHolder[] {
  return tagFunctions(tag).map((fn) => ({
    id: fn.id,
    route: tag.schema_module === fn.id ? "own" : fn.ref_id ? "direct" : "inherited",
    sourceTagId: fn.source_tag_id,
  }));
}

/** The one place the tag page (which only shows and takes off) and the structure editor read and change a tag's
 *  functions (docs/architecture/proposals/function-references-2026-11-02.md).
 *
 *  `functions` are the holder's functions; `add` / `remove` write through the server's function
 *  references (online owner decisions; the server checks). A function that waits for the owner's
 *  one-time yes (semantic search, RSS, website) needs `confirmed` on add — the caller asked the person
 *  (components/ModuleImportConfirm) — and then the toast offers one Undo that takes the function off
 *  again and turns the module off; without it that function is refused with a pointer to Settings ›
 *  Modules. A module that was off is turned on by adding its function. Failures are reported once, by
 *  the writer; add / remove resolve with whether the change was saved.
 *
 *    const fns = useFunctions({ kind: "node", id: tag.id }, { online, onChanged: refresh });
 *    await fns.add("review");   // #課程 now has 複習
 *    await fns.add("rss", { confirmed: true, tagName: "課程" }); // after the confirmation */
export function useFunctions(holder: FunctionHolder, { online, onChanged }: { online: boolean; onChanged?: () => void | Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const tag = useAppSelector((state) => (state.data.tags ?? []).find((candidate) => candidate.id === holder.id));
  const functions = tag ? functionsOfTag(tag) : [];

  async function settle(): Promise<void> {
    try { await onChanged?.(); } catch { /* the next sync brings the catalog */ }
  }

  async function add(moduleId: string, { confirmed = false, tagName }: { confirmed?: boolean; tagName?: string } = {}): Promise<boolean> {
    const spec = TAG_FUNCTIONS.find((fn) => fn.id === moduleId);
    const mod = MODULES.find((m) => m.id === functionModule(spec ?? { id: moduleId }));
    // A function without a module tag is only a reference; the others need their module (and tag) on.
    if (!spec?.switchOnly && !mod?.library.moduleTag) return false;
    setBusy(moduleId);
    try {
      const { data } = getAppState();
      const providerId = functionModule(spec ?? { id: moduleId });
      const status = moduleStatusFor(data.workspace?.modules, data.workspace?.modules_to_confirm)(providerId);
      if (status === "ask" && !confirmed) {
        addToast(t("Turn on “{name}” in Settings › Modules first.", { name: t(mod?.library.title ?? moduleId) }), "info");
        return false;
      }
      const wasOn = moduleFilterFor(data.workspace?.modules)(providerId);
      // Off or waiting for its yes (confirmed by the caller), or on but its module tag is not made yet
      // (the first time it is needed): turning it on makes the tag, as the library's 「建立 #…」 does.
      if (!wasOn || (mod?.library.moduleTag && !moduleTagOf(data.tags ?? [], moduleId))) await changeModuleImport(providerId, true, online);
      await tagConfigWriter.addFunction(holder.id, moduleId, online);
      const name = spec ? t(spec.title) : t(mod?.library.title ?? moduleId);
      if (wasOn) addToast(t("Added “{function}”", { function: name }), "success");
      else {
        addToast(t("Turned on “{name}” and added it to #{tag}", { name, tag: tagName ?? "" }), "success", {
          label: t("Undo"),
          onClick: () => void (async () => {
            try {
              await tagConfigWriter.removeFunction(holder.id, moduleId, online);
              await changeModuleImport(providerId, false, online);
              addToast(t("Turned off “{name}”; its data is kept", { name }), "success");
            } catch { /* the writer reported it */ }
            await settle();
          })(),
        });
      }
      await settle();
      return true;
    } catch {
      return false; // the writer reported it
    } finally { setBusy(null); }
  }

  /** Take a function off the holder: only the reference it holds itself (a module's own tag keeps its own). */
  async function remove(moduleId: string): Promise<boolean> {
    const spec = TAG_FUNCTIONS.find((fn) => fn.id === moduleId);
    setBusy(moduleId);
    try {
      await tagConfigWriter.removeFunction(holder.id, moduleId, online);
      addToast(t("Removed “{function}”", { function: spec ? t(spec.title) : moduleId }), "success");
      await settle();
      return true;
    } catch {
      return false; // the writer reported it
    } finally { setBusy(null); }
  }

  return { functions, busy, add, remove };
}
