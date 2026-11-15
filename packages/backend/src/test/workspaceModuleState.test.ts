// The owner's decisions about the built-in functions (services/workspaceModules.ts):
// every shipped module is on unless turned off, and a confirm-once module (semantic
// search, RSS, website) is on only after the owner's one yes. DB-free: the state
// rules and the wire row clients get. The stored behaviour is in
// workspaceModules.integration.test.ts.
import { describe, expect, it } from "vitest";
import { MODULES, registerModuleEffects } from "../modules/index.js";
import { isConfirmOnceModule, isModuleImported, libraryModuleIds, modulesOn, modulesToConfirm, moduleStateOf, workspaceWireRow } from "../services/workspaceModules.js";

for (const mod of MODULES) registerModuleEffects(mod);
// ai too: a new workspace has AI off until the owner agrees once; skills need it, so they wait with it.
const CONFIRM_ONCE = ["ai", "rss", "semantic", "website"];
const NEEDS_AI = ["skills"];

describe("module state", () => {
  it("a fresh workspace (nothing decided) has every module on except the ones that wait for a yes (and those that need them)", () => {
    const fresh = moduleStateOf({ modules_off: [], modules_confirmed: [] });
    expect(libraryModuleIds().filter(isConfirmOnceModule).sort()).toEqual(CONFIRM_ONCE);
    expect(modulesOn(fresh)).toEqual(libraryModuleIds().filter((id) => !CONFIRM_ONCE.includes(id) && !NEEDS_AI.includes(id)));
    expect(modulesToConfirm(fresh).sort()).toEqual(CONFIRM_ONCE);
    // Nothing needs importing: the built-in ones the app always had, and the new ones.
    for (const id of ["calendar", "canvas", "gallery", "kanban", "table", "review", "slides", "daily"]) {
      expect(isModuleImported(modulesOn(fresh), id), id).toBe(true);
    }
  });

  it("a module the owner turned off stays off; one never chosen about is on", () => {
    const state = moduleStateOf({ modules_off: ["review"], modules_confirmed: [] });
    const on = modulesOn(state);
    expect(on).not.toContain("review");
    expect(on).toContain("kanban");
  });

  it("the whiteboard is always on: a workspace that turned it off earlier has it again", () => {
    const on = modulesOn(moduleStateOf({ modules_off: ["canvas", "review"], modules_confirmed: [] }));
    expect(on).toContain("canvas");
    expect(on).not.toContain("review");
  });

  it("the view modules are on whatever the stored decisions say", () => {
    const on = modulesOn(moduleStateOf({ modules_off: ["table", "calendar", "kanban", "gallery"], modules_confirmed: [] }));
    for (const id of ["table", "calendar", "kanban", "gallery"]) expect(on, id).toContain(id);
  });

  it("a confirm-once module is on after the yes, off again when turned off, and never asks twice", () => {
    expect(modulesOn(moduleStateOf({ modules_off: [], modules_confirmed: ["rss"] }))).toContain("rss");
    const off = moduleStateOf({ modules_off: ["rss"], modules_confirmed: ["rss"] });
    expect(modulesOn(off)).not.toContain("rss");
    expect(modulesToConfirm(off)).not.toContain("rss");
    expect(modulesToConfirm(moduleStateOf({ modules_off: [], modules_confirmed: [] }))).toContain("rss");
  });

  it("a module added in a later release is on without any stored change", () => {
    // The state only lists decisions, so a module nobody decided about is on.
    expect(modulesOn(moduleStateOf({ modules_off: ["review"], modules_confirmed: null }))).toContain("table");
  });

  it("the wire row carries what is on and what waits for a yes, not the stored decisions", () => {
    const wire = workspaceWireRow({ id: "w", name: "W", slug: "w", home_node_id: null, modules_off: ["review"], modules_confirmed: ["website"] });
    expect(wire.modules).not.toContain("review");
    expect(wire.modules).toContain("website");
    expect(wire.modules).not.toContain("rss");
    expect(wire.modules_to_confirm.sort()).toEqual(["ai", "rss", "semantic"]);
    expect(wire).not.toHaveProperty("modules_off");
    expect(wire).not.toHaveProperty("modules_confirmed");
    expect(wire).toMatchObject({ id: "w", name: "W", slug: "w", home_node_id: null });
  });
});
