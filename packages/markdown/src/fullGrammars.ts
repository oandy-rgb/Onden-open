// The grammars `@onden/markdown/full` registers: all of highlight.js's.
// A module of its own so the browser app's worker bundle (scripts/build-browser.mjs)
// can swap it for browser-shims/fullGrammars.ts — there, a published page is
// coloured with the common grammars only, instead of the worker carrying every
// grammar for a feature the browser app rarely runs.
// A function, not a re-export, for the reason in lowlightCore.ts.
import { all } from "lowlight";

export function fullGrammars() {
  return all;
}
