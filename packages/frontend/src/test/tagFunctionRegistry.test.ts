// @vitest-environment node
// The frontend tag-function cards must match the backend modules declaring
// `tagFunction: true` or `tagFunctions`: a card without a backend module is refused with 400, and
// a backend function without a card can never be switched on.
import { describe, expect, it } from "vitest";
import { TAG_FUNCTIONS, enabledTagFunctions } from "../modules";
import { MODULES as BACKEND_MODULES, moduleTagFunctionIds } from "../../../backend/src/modules/index";

const backendTagFunctionIds = () => BACKEND_MODULES.flatMap(moduleTagFunctionIds);

describe("tag function registry", () => {
  it("lists exactly the backend modules that declare tagFunction or tagFunctions", () => {
    expect(TAG_FUNCTIONS.map((fn) => fn.id).sort()).toEqual(backendTagFunctionIds().sort());
  });

  it("returns the enabled functions in registry order and ignores unknown stored ids", () => {
    const tag = { effective_modules: ["review", "skills", "gone"] }; // review: no tag function any more, so a stored id is ignored
    expect(enabledTagFunctions(tag).map((fn) => fn.id)).toEqual(["skills"]);
    expect(enabledTagFunctions({ effective_modules: [] })).toEqual([]);
  });
});
