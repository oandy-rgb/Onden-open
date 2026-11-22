import type { LucideIcon } from "lucide-react";
import type { Tag, Workspace } from "./api";
import { t } from "./i18n";
import { getPrefJson, setPrefJson, PREFS } from "./prefs";
import { functionModule, moduleTagOf, type TagFunctionSpec } from "./tagModules";
import { MODULES, TAG_FUNCTIONS, type ModuleStatusOf } from "../modules";

// The function catalog: every function a tag can have, from the modules'
// `tagFunction` registrations (modules/index.ts TAG_FUNCTIONS) — the one list
// behind the tag page's 「功能」 row, the 「試試功能」 group of a paragraph's 加標籤
// panel, the info panel's 「還能用在這則」 and the paragraph tools. Name, icon,
// one-line description and the example shown before a function is on are the
// spec's; nothing else keeps its own copy. Which tag is which kind (own /
// function / system) is lib/nodeTags `tagKind`.

/** Every function, in registry order. */
export function functionCatalog(): readonly TagFunctionSpec[] {
  return TAG_FUNCTIONS;
}

/** The functions a module's own tag stands for (#複習 → 複習). Empty for a tag that is not a module's. */
export function functionsOfModuleTag(tag: Pick<Tag, "schema_module">): TagFunctionSpec[] {
  return tag.schema_module ? TAG_FUNCTIONS.filter((fn) => functionModule(fn) === tag.schema_module) : [];
}

/** The name a person sees for a tag: a function's tag shows the function's
 *  name (never `paper`, `skill`, `task`…), any other tag its own name. */
export function tagDisplayName(tag: Pick<Tag, "name" | "schema_module">): string {
  if (!tag.schema_module) return tag.name;
  const fns = functionsOfModuleTag(tag);
  if (fns.length === 1) return t(fns[0].title);
  const mod = MODULES.find((m) => m.id === tag.schema_module);
  return mod ? t(mod.library.title) : t(tag.name);
}

/** A catalog function a paragraph can take (those with a `blockAction`): the
 *  rows of the paragraph panel's 「試試功能」. */
export type BlockFunction = {
  /** The function (or the module's own paragraph action): its id keys the example and the "used" memory. */
  fn: Pick<TagFunctionSpec, "id" | "module">;
  /** Row name (the module's) and its one line (the block action's words), already translated. */
  title: string;
  description: string;
  Icon: LucideIcon;
  /** The tag the paragraph gets. Not made yet when the function is off: turning it on makes it. */
  tagName: string;
  /** Not on yet: choosing it shows the catalog's example first. */
  off: boolean;
  /** This person may turn it on (the owner, online); without it the example is only shown. */
  canTurnOn: boolean;
};

/** The functions a paragraph can take, from the catalog (the one list): each
 *  function with a `blockAction`, once, on or off. A function writes its
 *  module's tag.
 *  Functions in `used` come last. Fields on a paragraph (papers) are not offered:
 *  a block has nowhere to keep them yet (docs/architecture/block-nodes.md). */
export function blockFunctions(
  tags: readonly Tag[], status: ModuleStatusOf, { canImport, used = [], lineWords }: { canImport: boolean; used?: readonly string[]; lineWords?: Workspace["line_words"] },
): BlockFunction[] {
  const rows = TAG_FUNCTIONS.flatMap((fn, order): Array<BlockFunction & { order: number }> => {
    const moduleId = functionModule(fn);
    const mod = MODULES.find((m) => m.id === moduleId);
    if (!fn.blockAction || !mod) return [];
    // A module whose tag is a reserved one (#task) is that tag, under whatever name the workspace gave it.
    const reserved = mod.library.moduleTag && tags.find((tag) => tag.reserved_key === mod.library.moduleTag!.name);
    const tagName = reserved?.name ?? moduleTagOf(tags, moduleId)?.name ?? (mod.library.moduleTag ? t(mod.library.moduleTag.name) : null);
    if (!tagName) return [];
    const off = status(moduleId) !== "on";
    return [{ fn, title: t(mod.library.title), description: t(fn.blockAction.label), Icon: fn.blockAction.Icon, tagName, off, canTurnOn: canImport, order }];
  });
  // A module's own paragraph action (tasks): not a tag function, so it needs no tag; it writes the module's word.
  const own = MODULES.flatMap((mod, at): Array<BlockFunction & { order: number }> => {
    const action = mod.library.paragraphAction;
    const word = action && lineWords?.[mod.id]?.words[0];
    if (!action || !word) return [];
    return [{ fn: { id: action.id, module: mod.id }, title: t(mod.library.title), description: t(action.label), Icon: action.Icon, tagName: word, off: status(mod.id) !== "on", canTurnOn: canImport, order: TAG_FUNCTIONS.length + at }];
  });
  rows.push(...own);
  return rows.sort((a, b) => Number(used.includes(a.fn.id)) - Number(used.includes(b.fn.id)) || a.order - b.order);
}

/** The functions (ids) this account has put on a paragraph, oldest first. */
export function usedBlockFunctions(): string[] {
  const value = getPrefJson(PREFS.paragraphFunctionsUsed);
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

export function rememberBlockFunction(id: string): void {
  const used = usedBlockFunctions();
  if (!used.includes(id)) setPrefJson(PREFS.paragraphFunctionsUsed, [...used, id]);
}
