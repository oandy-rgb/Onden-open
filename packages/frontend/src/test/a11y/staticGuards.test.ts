// Static accessibility guards over the source: they read files, render nothing.
//   1. an icon-only button has an accessible name (aria-label, not title);
//   2. a dialog is built on ui/Modal (the modals-through-ui-modal rule, run
//      with inline disables switched off so a "non-modal popover" is counted);
//   3. a small icon button (size="sm") is still 40px on a touch screen;
//   4. a control that :hover reveals (opacity 0 otherwise) is revealed on keyboard focus too.
// Known violations live in a11y/baseline.ts; see guardAgainstNewViolations.
import { describe, expect, it } from "vitest";
import { Linter } from "eslint";
import typescriptParser from "@typescript-eslint/parser";
import modalsThroughUiModal from "../../../eslint-rules/modals-through-ui-modal.js";
import { guardAgainstNewViolations, NOT_THROUGH_MODAL, HOVER_ONLY_REVEALS, SMALL_ICON_BUTTONS, UNNAMED_ICON_BUTTONS } from "./baseline";
import { allHoverOnlyReveals, hoverOnlyReveals } from "./hoverReveal";
import { unnamedIconButtons } from "./iconButtons";
import { readSource, sourceFiles } from "./sourceFiles";

const components = sourceFiles("components", [".tsx"]);

guardAgainstNewViolations(
  "every icon-only button in components/ has an accessible name",
  () => components.flatMap((path) => unnamedIconButtons(path, readSource(path))),
  UNNAMED_ICON_BUTTONS,
);

// components/ui is where Modal itself lives and is exempt in eslint.config.js.
function handMadeDialogs(): string[] {
  const linter = new Linter();
  const found: string[] = [];
  for (const path of components.filter((p) => !p.startsWith("components/ui/"))) {
    const messages = linter.verify(readSource(path), [{
      files: ["**/*.tsx"],
      languageOptions: { parser: typescriptParser, parserOptions: { ecmaFeatures: { jsx: true } } },
      linterOptions: { noInlineConfig: true },
      plugins: { onden: { rules: { "modals-through-ui-modal": modalsThroughUiModal } } },
      rules: { "onden/modals-through-ui-modal": "error" },
    }] as Linter.Config[], { filename: path });
    const seen = new Map<string, number>();
    // noInlineConfig also reports each ignored eslint-disable comment; those have no ruleId.
    for (const m of messages.filter((message) => message.ruleId === "onden/modals-through-ui-modal")) {
      const what = /^([^:]+):/.exec(m.message)?.[1] ?? m.message;
      const n = (seen.get(what) ?? 0) + 1;
      seen.set(what, n);
      found.push(`${path} ${what}${n > 1 ? ` #${n}` : ""}`);
    }
  }
  return found;
}

guardAgainstNewViolations("every dialog goes through ui/Modal", handMadeDialogs, NOT_THROUGH_MODAL);

// ── size="sm" icon buttons on a touch screen ────────────────────────────────

const MIN_TAP_PX = 40;

/** Declarations of every rule inside an `@media (pointer: coarse)` block, as selector → property → px. */
function coarsePointerSizes(css: string): Map<string, Record<string, number>> {
  const sizes = new Map<string, Record<string, number>>();
  const start = /@media[^{]*pointer\s*:\s*coarse[^{]*\{/g;
  for (let m = start.exec(css); m; m = start.exec(css)) {
    let depth = 1;
    let i = start.lastIndex;
    while (i < css.length && depth > 0) { if (css[i] === "{") depth++; else if (css[i] === "}") depth--; i++; }
    const block = css.slice(start.lastIndex, i - 1);
    for (const rule of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const props: Record<string, number> = {};
      for (const d of rule[2].matchAll(/(width|height|min-width|min-height)\s*:\s*(\d+(?:\.\d+)?)px/g)) props[d[1]] = Number(d[2]);
      for (const selector of rule[1].split(",").map((s) => s.trim())) sizes.set(selector, { ...sizes.get(selector), ...props });
    }
  }
  return sizes;
}

function smallIconButtonsBelowTapSize(): string[] {
  const sizes = coarsePointerSizes(readSource("components/ui/ui.css"));
  // The rule that sizes .ui-btn--icon.ui-btn--sm; the not-sm rules above it do not count.
  const reaches = [...sizes].some(([selector, p]) =>
    /\.ui-btn--sm(?!\w)/.test(selector) && !/:not\(\.ui-btn--sm\)/.test(selector)
    && (p.width ?? p["min-width"] ?? 0) >= MIN_TAP_PX && (p.height ?? p["min-height"] ?? 0) >= MIN_TAP_PX);
  return reaches ? [] : ["ui.css .ui-btn--icon.ui-btn--sm under @media (pointer: coarse)"];
}

guardAgainstNewViolations("size=sm icon buttons are 40px on coarse pointers", smallIconButtonsBelowTapSize, SMALL_ICON_BUTTONS);

guardAgainstNewViolations("a control shown on :hover is also shown on keyboard focus", allHoverOnlyReveals, HOVER_ONLY_REVEALS);

describe("the static guards themselves", () => {
  it("name an icon-only button only by aria-label or text", () => {
    const src = `import { X, Plus } from "lucide-react";
      export const a = () => <>
        <button><X size={16} /></button>
        <button title="Close"><X /></button>
        <button aria-label="Close"><X /></button>
        <button><X /> Close</button>
        <button {...rest}><X /></button>
        <Button variant="icon">{open ? <X /> : <Plus />}</Button>
        <button>{label}</button>
      </>;`;
    expect(unnamedIconButtons("components/A.tsx", src)).toEqual([
      "components/A.tsx <button> [X]",
      "components/A.tsx <button> [X] #2",
      "components/A.tsx <Button> [X|Plus]",
    ]);
  });

  it("find a control that only :hover reveals", () => {
    const css = `.del { opacity: 0; } .row:hover .del { opacity: 1; } .ok { opacity: 0; } .ok:hover, .ok:focus-visible { opacity: 1; }`;
    expect(hoverOnlyReveals("x.css", css)).toEqual(["x.css .del"]);
  });

  it("measure the coarse-pointer sizes of a stylesheet", () => {
    const css = "@media (pointer: coarse) { .a:not(.b) { min-height: 44px; } .a.b { width: 40px; height: 40px; } }";
    expect(coarsePointerSizes(css).get(".a.b")).toEqual({ width: 40, height: 40 });
  });
});
