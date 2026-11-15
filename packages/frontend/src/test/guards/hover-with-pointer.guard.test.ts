// @vitest-environment node
// Guard: a hover tint only with a pointer that hovers (scripts/hoverWithPointer.mjs). On a touch screen
// :hover sticks to the last tap, so a tint written as plain :hover would stay on a row after the finger
// lifts. The plugin moves every such rule into @media (hover: hover) at build time; this file feeds it
// samples and checks the build uses it. scripts/check-app-css.mjs checks the built sheets.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { describe, expect, it } from "vitest";
import hoverWithPointer, { bareHoverRules, hovers } from "../../../scripts/hoverWithPointer.mjs";

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const tidy = (css: string) => css.replace(/\s+/g, " ").replace(/\s*([{};])\s*/g, "$1").trim();
const run = (css: string) => tidy(postcss([hoverWithPointer()]).process(css, { from: undefined }).css);

describe("hover tints wait for a pointer", () => {
  it("moves a hover tint into @media (hover: hover)", () => {
    expect(run(".a:hover { background: var(--x); }")).toBe("@media (hover: hover){.a:hover{background: var(--x);}}");
    expect(run("@media (max-width: 600px) { .a:hover .b { color: var(--x); } }")).toBe("@media (max-width: 600px){@media (hover: hover){.a:hover .b{color: var(--x);}}}");
  });

  it("keeps the other selectors of the rule where they were", () => {
    expect(run(".a:hover, .a:focus-visible { color: var(--x); }")).toBe(".a:focus-visible{color: var(--x);}@media (hover: hover){.a:hover{color: var(--x);}}");
  });

  it("leaves reveals, :not(:hover) and rules already asking about hover alone", () => {
    for (const css of [
      ".row:hover .del { opacity: 1; }",
      ".a:not(:hover) .x { color: var(--x); }",
      "@media (hover: hover) { .a:hover { color: var(--x); } }",
      "@media (hover: hover) and (pointer: fine) { :hover { scrollbar-color: var(--x) transparent; } }",
    ]) expect(run(css)).toBe(tidy(css));
  });

  it("reads :hover inside :is / :has as hovering, inside :not as not", () => {
    expect(hovers(".a:is(:hover, :focus)")).toBe(true);
    expect(hovers(".a:has(.b:hover)")).toBe(true);
    expect(hovers(".a:not(:hover, :focus-within)")).toBe(false);
    expect(hovers(".a:not(.b):hover")).toBe(true);
  });

  it("after the plugin nothing is left for the built-sheet check to find", () => {
    const css = ".a:hover { color: var(--x); } .b:hover, .c { background: var(--y); }";
    expect(bareHoverRules(postcss.parse(css))).toHaveLength(2);
    expect(bareHoverRules(postcss.parse(run(css)))).toHaveLength(0);
  });

  it("the build runs every stylesheet through it", () => {
    const config = readFileSync(join(FRONTEND, "astro.config.mjs"), "utf8");
    expect(config).toMatch(/import hoverWithPointer from "\.\/scripts\/hoverWithPointer\.mjs"/);
    expect(config).toMatch(/css:\s*\{\s*postcss:\s*\{\s*plugins:\s*\[[^\]]*hoverWithPointer\(\)/);
    expect(readFileSync(join(FRONTEND, "scripts/check-app-css.mjs"), "utf8")).toContain("bareHoverRules(");
  });
});
