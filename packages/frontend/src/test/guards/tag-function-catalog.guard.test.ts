// @vitest-environment node
// Guard: the function catalog stays whole (lib/tagFunctions.ts). A module that
// ships a tag of its own (#複習, #論文, #技能…) must register a `tagFunction`,
// or the tag page's 「功能」 row, the paragraph's 「試試功能」 and the info panel's 「還能用在這則」 could
// never offer it. The block action (「把這段做成複習卡」) belongs to the function, not
// to a second field on the module.
import { describe, expect, it } from "vitest";
import { MODULES } from "../../modules";
import { FUNCTION_EXAMPLES } from "../../components/functionCatalog/examples";

// Modules whose module tag is still made but that no longer give tags a function. Only shrinks (ratchet).
// tasks: tasks are not tags any more (function-refs batch 3, migration 191); its tag node goes in that batch's last PR.
// ratchet:list tagFunctionlessModuleTags
const TAG_WITHOUT_FUNCTION = ["tasks"];

describe("tag function catalog", () => {
  it("every module with a module tag registers a tagFunction, except view layouts and the listed leftovers", () => {
    const missing = MODULES.filter((mod) => mod.library.moduleTag && !mod.view && !mod.tagFunction && !TAG_WITHOUT_FUNCTION.includes(mod.id)).map((mod) => mod.id);
    expect(missing, `Register a tagFunction (modules/<id>/tagFunction.ts) for: ${missing.join(", ")}`).toEqual([]);
  });

  it("no module keeps a separate blockAction", () => {
    expect(MODULES.filter((mod) => "blockAction" in mod).map((mod) => mod.id)).toEqual([]);
  });

  it("every function has an example for the preview card, and no example is left without a function", () => {
    const ids = MODULES.flatMap((mod) => [...[mod.tagFunction ?? []].flat().map((fn) => fn.id), ...(mod.library.paragraphAction ? [mod.library.paragraphAction.id] : [])]);
    for (const id of ids) {
      const example = FUNCTION_EXAMPLES[id];
      expect(example?.result && example.sampleTitle && example.sampleDetail, id).toBeTruthy();
    }
    expect(Object.keys(FUNCTION_EXAMPLES).sort()).toEqual([...ids].sort());
  });
});
