// The phone's bottom sheet is one component (components/ui/Sheet.tsx, or Menu/Popover `sheet`).
// A component that docks its own card to the bottom edge gets its own corners, safe-area padding and
// keyboard handling wrong; the "Move to…" sheet's top edge once jumped while typing for that reason.
// A failure names the file: put the content in <Sheet> (cardClassName is the card) instead of adding it here.
// docs/agents/decisions-ui.md › 手機底部 sheet.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== "test" && name !== "node_modules") walk(path, out); }
    else if (name.endsWith(".css")) out.push(path);
  }
  return out;
}

const CSS = walk(SRC)
  .map((path) => ({ path: relative(SRC, path).split(sep).join("/"), text: readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "") }))
  .filter((f) => f.path !== "components/ui/ui.css");

// A layer that bottom-aligns its card when open, and top-only rounded px corners: the two marks of a hand-made sheet.
const DOCKS_ITS_OWN_CARD = /\[open\][^{}]*\{[^{}]*align-items:\s*flex-end/;
const ROUNDS_ITS_OWN_TOP = /border-radius:\s*\d+px\s+\d+px\s+0\s+0/;
// The other way to dock a card: pushed to the bottom by an auto top margin, or both bottom corners squared.
const PUSHED_TO_THE_BOTTOM = /margin:\s*auto\s+auto\s+0\b/;
const SQUARES_BOTH_BOTTOM_CORNERS = (rule: string) => /border-bottom-left-radius:\s*0\b/.test(rule) && /border-bottom-right-radius:\s*0\b/.test(rule);
const rules = (text: string) => text.split("}");
// Only shrinks: everything is on <Sheet> now.
const NOT_YET_ON_SHEET = new Set<string>();

describe("bottom sheets", () => {
  it("no stylesheet outside ui/ docks its own card to the bottom edge", () => {
    expect(CSS.filter((f) => DOCKS_ITS_OWN_CARD.test(f.text)).map((f) => f.path)).toEqual([]);
  });
  it("no stylesheet outside ui/ draws its own sheet corners", () => {
    expect(CSS.filter((f) => ROUNDS_ITS_OWN_TOP.test(f.text)).map((f) => f.path)).toEqual([]);
  });
  it("no stylesheet outside ui/ pushes its own card to the bottom edge", () => {
    const docked = CSS.filter((f) => PUSHED_TO_THE_BOTTOM.test(f.text) || rules(f.text).some(SQUARES_BOTH_BOTTOM_CORNERS)).map((f) => f.path);
    expect(docked.filter((path) => !NOT_YET_ON_SHEET.has(path))).toEqual([]);
    // The exceptions only shrink: one that no longer docks a card is taken off the list.
    expect([...NOT_YET_ON_SHEET].filter((path) => !docked.includes(path))).toEqual([]);
  });
  it("the patterns catch a hand-made sheet", () => {
    expect(DOCKS_ITS_OWN_CARD.test(".x[open] { align-items: flex-end; }")).toBe(true);
    expect(ROUNDS_ITS_OWN_TOP.test(".x { border-radius: 16px 16px 0 0; }")).toBe(true);
    expect(PUSHED_TO_THE_BOTTOM.test(".x { margin: auto auto 0; }")).toBe(true);
    expect(rules(".x { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }").some(SQUARES_BOTH_BOTTOM_CORNERS)).toBe(true);
    expect(rules(".split { border-top-right-radius: 0; border-bottom-right-radius: 0; }").some(SQUARES_BOTH_BOTTOM_CORNERS)).toBe(false);
  });
});
