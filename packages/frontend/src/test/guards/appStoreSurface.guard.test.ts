// Guard: how many different app-wide event names the screens send each other over `window` only shrinks
// (proposal: docs/architecture/proposals/markdown-surface-and-app-store-2026-11-14.md, part B).
// The per-file store rules (fe-store-inline-selector, fe-store-write, fe-literal-api-write) are allowlist rules
// in allowlist/fileRules.ts; this is the one count that has no single owner file: the names themselves.
// A name is a `…EVENT` constant or a literal given to emitWindowEvent / onWindow / CustomEvent / addEventListener
// (allowlist/detect.ts windowEventNames). Moving them behind one typed registry (name → payload) lowers the number
// of places that spell a name, not the number of events; when the registry lands this guard counts its entries instead.
import { describe, expect, it } from "vitest";
import { checkSurface } from "../../../../../scripts/surfaceLib.mjs";
import { windowEventNames } from "./allowlist/detect";
import { readSource, sourceFiles } from "./sources";

describe("app events on window", () => {
  const names = new Map<string, Set<string>>();
  for (const file of sourceFiles(".")) {
    const text = readSource(file);
    if (!text.includes("onden")) continue;
    for (const name of windowEventNames(file, text)) names.set(name, (names.get(name) ?? new Set()).add(file));
  }

  it("the detector still finds the known ones", () => {
    expect([...names.keys()]).toContain("onden:open-settings");
    expect([...names.keys()]).toContain("onden-find-in-note");
  });

  it("frontend-window-event-names", () => {
    const result = checkSurface("frontend-window-event-names", names.size, "app 內互相溝通的 window 事件名稱");
    for (const note of result.notes) console.info(note);
    expect(result.errors.join("\n")).toBe("");
  });
});
