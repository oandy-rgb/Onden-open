// The saved-view layouts come from the view modules (ModuleDefinition.viewLayout),
// not from a list in core: a new layout is a module directory plus its line in
// modules/index.ts. No database.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { MODULES, registerModuleEffects } from "../modules/index.js";
import { isViewLayout, viewLayouts, siteViewKindOf } from "../services/viewLayouts.js";
import { registerShippedModules } from "./helpers/registerShippedModules.js";

// A layout the test registers; tests run in any order, so the others leave it out.
const EXTRA = "timeline_test_layout";
const shipped = () => viewLayouts().filter((id) => id !== EXTRA);

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "test" || name === "modules" ? [] : files(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

/** Lines of `text` that quote at least three of `ids` — a list of layouts. */
const layoutLists = (text: string, ids: string[]) =>
  text.split("\n").filter((line) => ids.filter((id) => new RegExp(`["'\`]${id}["'\`]`).test(line)).length >= 3);

describe("view layout registry", () => {
  it("is the view modules, in registry order", () => {
    registerShippedModules();
    const declared = MODULES.filter((m) => m.viewLayout).map((m) => m.id);
    expect(declared).toEqual(["table", "calendar", "kanban", "gallery"]);
    expect(shipped()).toEqual(declared);
    expect(isViewLayout("kanban")).toBe(true);
    expect(isViewLayout("review")).toBe(false);
    expect(isViewLayout("list")).toBe(false);
  });

  it("takes a new layout from one module definition", () => {
    registerModuleEffects({ id: EXTRA, registerRoutes: () => {}, viewLayout: { siteViewKind: "cards" } });
    expect(isViewLayout(EXTRA)).toBe(true);
    expect(siteViewKindOf(EXTRA)).toBe("cards");
  });

  it("knows how a site draws each layout", () => {
    registerShippedModules();
    expect(["table", "calendar", "kanban", "gallery"].map(siteViewKindOf)).toEqual(["table", undefined, undefined, "cards"]);
  });

  it("is not listed again in core", () => {
    registerShippedModules();
    const ids = shipped();
    // The detector sees a list (this guards the scan below)…
    expect(layoutLists('const all = ["table", "kanban", "calendar", "gallery"];', ids)).toHaveLength(1);
    expect(layoutLists('make("Board", "kanban", field); make("Table", "table", null);', ids)).toHaveLength(0);
    // …and core has none.
    const offenders = files(SRC).flatMap((file) =>
      layoutLists(readFileSync(file, "utf8"), ids).map((line) => `${relative(SRC, file)}: ${line.trim()}`));
    expect(offenders).toEqual([]);
  });
});
