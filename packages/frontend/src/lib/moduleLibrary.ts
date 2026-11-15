// The module library's actions: turn a module on / off, install a tag pack,
// switch a tag function on or off. They read the module registry
// (modules/index.ts) and write through the data layer; they live outside
// lib/data so the data layer never depends on the registry (A2: importing
// lib/data must not load every module's components).
import { useState } from "react";
import type { Tag } from "./api";
import { addToast, getAppState } from "./appStore";
import { t, useT } from "./i18n";
import { MODULES, isViewModuleTag, moduleFilterFor, type ModuleStatusOf } from "../modules";
import type { TagItem } from "./editorCompletion";
import { isSystemTag } from "./systemNodes";
import { isNoteSwitchTag, isTagShown, tagKind } from "./nodeTags";
import { onlineOperation, workspaceWriter } from "./data";

// ── moduleImport (moved from lib/data) ──
/** Turn a module on or off: the one write both Settings › Modules and the
 *  one-time confirmations (components/ModuleImportConfirm) use. Sends the module
 *  tag's name in the interface language. Resolves the module tag's id (null
 *  for a module without one); rejects when it failed, reported by the writer.
 *  The server takes the decision (principal admin: the workspace owner). */
export async function changeModuleImport(id: string, imported: boolean, online: boolean): Promise<{ moduleTagId: string | null }> {
  const mod = MODULES.find((m) => m.id === id);
  const tagName = imported && mod?.library.moduleTag ? t(mod.library.moduleTag.name) : undefined;
  const { moduleTagId } = await workspaceWriter.setModuleImported(id, imported, online, tagName);
  return { moduleTagId };
}

/** Turn a module on or off, with the shell's feedback: a toast, a catalog
 *  refresh after turning on. Settings › Modules manages modules through here;
 *  the places a module is started turn it on through changeModuleImport after
 *  the person confirmed. Resolves whether it took. */
export function useModuleImport(online: boolean, onChanged?: () => void | Promise<void>) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);

  async function setImported(id: string, imported: boolean, { quiet = false } = {}): Promise<boolean> {
    const mod = MODULES.find((m) => m.id === id);
    setBusy(id);
    try {
      await changeModuleImport(id, imported, online);
      const name = mod ? t(mod.library.title) : id;
      if (!quiet) addToast(imported ? t("Turned on “{name}”", { name }) : t("Turned off “{name}”; its data is kept", { name }), "success");
      if (imported) await onChanged?.();
      return true;
    } catch {
      return false; // reported by the writer (setModuleImported)
    } finally {
      setBusy(null);
    }
  }

  return { busy, setImported };
}

// ── tagPackInstall (moved from lib/data) ──
export type TagPackInstallResult = {
  id?: string; name?: string; missing_modules?: string[];
  /** Modules the pack declares that this Onden ships but are off here: the
   *  tag works fully once they are on (Settings › Modules). */
  modules_to_import?: string[];
};

/** Install a TagPack (POST /api/tags/import) as one online operation: a retry
 *  reuses its key, and a failure is reported there, once, then rejects. A
 *  replayed install answers without a body (the tag arrives with the sync).
 *  A pack that declares modules (the Review starter declares review) depends
 *  on them; installing it never turns one on, it says which to turn on in
 *  Settings › Modules. */
export async function installTagPack(pack: unknown, online?: boolean): Promise<TagPackInstallResult> {
  const body = typeof pack === "string" ? pack : JSON.stringify(pack);
  const reply = await onlineOperation("tag-packs", t("Connect to install a tag pack."),
    (submit) => submit<TagPackInstallResult>("/api/tags/import", body), online);
  const result: TagPackInstallResult = "deduped" in reply ? {} : reply;
  const isImported = moduleFilterFor(getAppState().data.workspace?.modules);
  const toImport = MODULES.filter((m) => packModules(body).includes(m.id) && !isImported(m.id));
  if (toImport.length > 0) {
    addToast(t("This tag needs {modules}. Turn it on in Settings › Modules.", {
      modules: toImport.map((m) => `「${t(m.library.title)}」`).join("、"),
    }), "info");
  }
  return { ...result, modules_to_import: toImport.map((m) => m.id) };
}

/** The module ids a pack declares (`modules: ["review"]`). */
function packModules(body: string): string[] {
  try {
    const modules = (JSON.parse(body) as { modules?: unknown }).modules;
    return Array.isArray(modules) ? modules.filter((m): m is string => typeof m === "string") : [];
  } catch { return []; }
}

// ── hashtag suggestions ──
/** The editor's `{` menu tags (lib/editorCompletion TagItem), in three kinds:
 *  the person's own tags; module tags of modules that are on (複習 from
 *  Review), marked with their module; and the tags of modules whose tag is not
 *  made yet or that are off — the live tag a turned-off module left, or the
 *  one turning it on creates (`virtual`, id `module:<id>`, named in the
 *  interface language). Those are `needs-import` for someone who may decide
 *  (`canImport`: the owner, online): choosing one makes the tag, turning the
 *  module on first, and asks once only for a module that waits for the owner's
 *  yes; for anyone else `not-imported`, written as a name only, and a virtual one
 *  is left out. View module tags (#表格…) and system tags describe tags, not
 *  notes, and are left out. (The state names are the editor's; `needs-import`
 *  reads "choosing it first turns the function on".) */
export function hashtagSuggestionTags(tags: readonly Tag[], status: ModuleStatusOf, { canImport }: { canImport: boolean }): TagItem[] {
  const items: TagItem[] = [];
  const names = new Set<string>();
  for (const tag of tags) {
    if (isSystemTag(tag) || isViewModuleTag(tag) || isNoteSwitchTag(tag)) continue;
    names.add(tag.name.toLowerCase());
    const mod = tag.schema_module ? MODULES.find((m) => m.id === tag.schema_module) : undefined;
    // A hidden tag (D104) is carried as such: offered only for its full name
    // (lib/tagSuggestions offersTag in lib/editorCompletion).
    const item: TagItem = { id: tag.id, name: tag.name, color: tag.color, kind: tagKind(tag), ...(isTagShown(tag) ? {} : { hidden: true }) };
    if (mod) item.module = { id: mod.id, title: mod.library.title, state: status(mod.id) === "on" ? "imported" : canImport ? "needs-import" : "not-imported" };
    items.push(item);
  }
  if (!canImport) return items;
  for (const mod of MODULES) {
    if (!mod.library.moduleTag || mod.view || mod.noteSwitch || tags.some((tag) => tag.schema_module === mod.id)) continue;
    const name = t(mod.library.moduleTag.name);
    // Turning it on adopts a top-level tag of that name; it is listed as it is.
    if (names.has(name.toLowerCase())) continue;
    items.push({ id: `module:${mod.id}`, name, kind: "function", virtual: true, module: { id: mod.id, title: mod.library.title, state: "needs-import" } });
  }
  return items;
}
