import type { Tag } from "../../lib/api";
import { functionModule, tagHasModule } from "../../lib/tagModules";
import { functionsOfTag, type FunctionRoute } from "../../hooks/useFunctions";
import { TAG_FUNCTIONS, type ModuleFilter } from "../../modules";

export type { FunctionRoute };

/** What a tag's functions are, given the modules that are on. Pure. */
export type FunctionModel = ReturnType<typeof tagFunctionModel>;

export function tagFunctionModel(tag: Tag, isImported: ModuleFilter) {
  const importedFunctions = TAG_FUNCTIONS.filter((fn) => isImported(functionModule(fn)));
  const ownModule = TAG_FUNCTIONS.find((fn) => fn.id === tag.schema_module && isImported(functionModule(fn))) ?? null;
  // Functions: what notes with this tag get (imported modules only).
  const abilities = importedFunctions.filter((fn) => tagHasModule(tag, fn.id));
  const held = functionsOfTag(tag);
  const routeOf = (id: string): FunctionRoute => held.find((fn) => fn.id === id)?.route ?? "inherited";
  // Functions this tag asks for whose module is not imported (nothing happens until it is).
  const dormant = TAG_FUNCTIONS.filter((fn) => {
    if (isImported(functionModule(fn))) return false;
    return tag.schema_module === fn.id || held.some((held) => held.id === fn.id);
  });
  return { importedFunctions, ownModule, abilities, dormant, routeOf };
}
