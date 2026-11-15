// @vitest-environment node
// The frontend and backend module registries describe the same modules twice
// (a FrontendModule for the shell, a ModuleDefinition for the server). Both are
// imported here, so a rename or a new module that lands on one side only
// fails: ids, module tag names and tag functions must agree.
import { describe, expect, it } from "vitest";
import { MODULES as FRONTEND, BUILT_IN_MODULES } from "../modules";
import { MODULES as BACKEND, moduleTagFunctionIds } from "../../../backend/src/modules/index";

const frontendOf = new Map(FRONTEND.map((m) => [m.id, m]));
const backendOf = new Map(BACKEND.map((m) => [m.id, m]));

// A frontend-only built-in module (the graph) has no backend twin.
const withBackend = BUILT_IN_MODULES.filter((m) => !m.frontendOnly);

describe("frontend and backend module definitions", () => {
  it("list the same module ids", () => {
    expect([...frontendOf.keys(), ...withBackend.map((m) => m.id)].sort()).toEqual([...backendOf.keys()].sort());
  });

  it("make a module built in on both sides: a backend module without a library card", () => {
    // Built-in modules are always on (no switch, not in Settings › Modules); a
    // library module is listed there and can be turned off.
    expect(withBackend.map((m) => m.id).sort())
      .toEqual(BACKEND.filter((m) => !m.library).map((m) => m.id).sort());
    for (const mod of BUILT_IN_MODULES) expect(frontendOf.has(mod.id), mod.id).toBe(false);
  });

  it("agree on which tag functions each module gives", () => {
    // A module is a tag function itself (`tagFunction`) and/or gives tags
    // functions of its own (`tagFunctions`).
    const frontendIds = (id: string) => [frontendOf.get(id)?.tagFunction ?? []].flat().map((fn) => fn.id).sort();
    for (const [id, mod] of backendOf) expect(frontendIds(id), id).toEqual(moduleTagFunctionIds(mod).sort());
  });

  it("name a module's tag the same where both sides name it", () => {
    // A view module's tag (#表格, #月曆…) is the server's: the shell never
    // creates it, so only the frontend modules that declare one are compared.
    for (const [id, mod] of frontendOf) {
      const name = mod.library.moduleTag?.name;
      if (name === undefined) continue;
      expect(backendOf.get(id)?.library?.moduleTag?.name, id).toBe(name);
    }
  });

  it("give every backend module tag a frontend card unless it is a view module", () => {
    for (const [id, mod] of backendOf) {
      if (!mod.library?.moduleTag || mod.viewLayout) continue;
      expect(frontendOf.get(id)?.library.moduleTag?.name, id).toBeDefined();
    }
  });

  it("make every view module a layout on both sides", () => {
    const frontendViews = FRONTEND.filter((m) => m.view).map((m) => m.id).sort();
    const backendViews = BACKEND.filter((m) => m.viewLayout).map((m) => m.id).sort();
    expect(frontendViews).toEqual(backendViews);
  });
});
