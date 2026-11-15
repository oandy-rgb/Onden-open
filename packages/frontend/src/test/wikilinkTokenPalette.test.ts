import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Regression guard for [designer-hardcoded-hex]: the wikilink token backgrounds
// were hardcoded light hexes (#f0f2ef / #eaf3ee) that did not flip in dark mode.
// They must resolve through the Gallery palette tokens so dark mode adapts.
// vitest runs with cwd = packages/frontend.
const globalCss = readFileSync(resolve("src/styles/global.css"), "utf8");
const obsidianCss = readFileSync(resolve("src/components/ObsidianImport.css"), "utf8");

/** Extract a single CSS rule block body by selector (first match). */
function ruleBody(css: string, selector: string): string {
  const idx = css.indexOf(selector);
  expect(idx, `selector ${selector} not found`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", idx);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("wikilink token palette", () => {
  it(".wikilink-token base background is a palette token, not a hardcoded hex", () => {
    const body = ruleBody(globalCss, ".wikilink-token {");
    const bg = /background:\s*([^;]+);/.exec(body)?.[1].trim();
    expect(bg).toBeDefined();
    expect(bg).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    expect(bg).toMatch(/var\(--(ac|onden)-/);
  });

  it(".wikilink-token.known background is a palette token, not a hardcoded hex", () => {
    const body = ruleBody(obsidianCss, ".wikilink-token.known {");
    const bg = /background:\s*([^;]+);/.exec(body)?.[1].trim();
    expect(bg).toBeDefined();
    expect(bg).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    expect(bg).toContain("var(--ac-");
  });

  it("the specific dark-mode-breaking hexes are gone", () => {
    expect(globalCss).not.toContain("#f0f2ef");
    expect(obsidianCss).not.toContain("#eaf3ee");
  });
});
