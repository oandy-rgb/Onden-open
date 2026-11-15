import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Regression guard for [designer-cold-first-paint]: the pre-React loading
 * screen (#app-initial-loading) painted a cold #0f1117 fill, flashing a dark
 * blue-grey before the warm Gallery body background took over. It must reuse
 * the warm paper token so the first paint already reads as paper.
 */
// vitest runs from the frontend package root (process.cwd()).
const cssPath = resolve(process.cwd(), "src/styles/global.css");
const css = readFileSync(cssPath, "utf8");

function ruleBlock(selector: string): string {
  const start = css.indexOf(selector + " {");
  expect(start, `selector ${selector} not found`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

describe("first-paint background", () => {
  const block = ruleBlock("#app-initial-loading");

  it("does not use the cold pre-theme hex", () => {
    expect(block.toLowerCase()).not.toContain("#0f1117");
  });

  it("uses the warm Gallery paper background token", () => {
    expect(block).toMatch(/background:\s*var\(--ac-bg\)/);
  });

  it("matches the warm theme-color meta intent (no cold hardcoded hex)", () => {
    // No raw hex background at all in the loading screen — must go through a token.
    expect(block).not.toMatch(/background:\s*#[0-9a-fA-F]{3,8}/);
  });
});
