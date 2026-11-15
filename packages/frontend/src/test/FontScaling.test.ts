import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Regression guard for [font-scaling-doesnt-reach-editor-ui]:
// the "Base font size" a11y setting only sets --onden-ui-font-size-base, so it
// can only reach the whole app if (a) the type-scale tokens are derived from
// that var and (b) no stylesheet pins UI text to a hardcoded px literal that
// ignores it. We also forbid sub-11px micro-text (a low-vision dealbreaker).

const here = dirname(fileURLToPath(import.meta.url));
const stylesDir = resolve(here, "../styles");
const tokenFile = readFileSync(resolve(stylesDir, "tokens.css"), "utf8");
const globalCss = readFileSync(resolve(stylesDir, "global.css"), "utf8");

describe("font scaling reaches the whole app", () => {
  it("anchors every --ac-fs-* size token to the base size", () => {
    const tokenLines = tokenFile
      .split("\n")
      .filter((l) => /^\s*--ac-fs-(xs|caption|small|ui|ui-touch|prose|lg|h3|title-sm|title):/.test(l));
    expect(tokenLines.length).toBe(10);
    for (const line of tokenLines) {
      // each step is either the base var itself or a calc() multiple of it
      expect(line).toMatch(/var\(--ac-fs-base\)/);
    }
  });

  it("leaves no hardcoded px font-size in global.css (must use scale tokens)", () => {
    const hardcoded = globalCss.match(/font-size:\s*[0-9]+(\.[0-9]+)?px/g) ?? [];
    expect(hardcoded).toEqual([]);
  });

  it("leaves no hardcoded px font-size in the app's stylesheets (the shell scales too, not only the editor)", () => {
    // Published-site stylesheets set their own scale (site-tokens.css); the rest of src/ is app chrome.
    const skip = new Set(["published-site.css", "site-tokens.css", "theme-tokens.css", "tokens.css", "fonts.css", "fonts-noto.css"]);
    const srcDir = resolve(here, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "published" && entry.name !== "node_modules") walk(path); continue; }
        if (!entry.name.endsWith(".css") || skip.has(entry.name)) continue;
        const found = readFileSync(path, "utf8").match(/font-size:\s*(?:[89]|[12][0-9]|3[0-9])(?:\.[0-9]+)?px/g);
        if (found) offenders.push(`${path.slice(srcDir.length + 1)}: ${found.length}`);
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });

  it("renders no sub-11px micro-text via the type scale", () => {
    // xs is the floor; at the 14px default base it must resolve to >= 11px.
    const xs = tokenFile.match(/--ac-fs-xs:\s*calc\(var\(--ac-fs-base\)\s*\*\s*([0-9.]+)(?:\s*\/\s*([0-9.]+))?\)/);
    expect(xs).not.toBeNull();
    const ratio = Number(xs![1]) / (xs![2] ? Number(xs![2]) : 1);
    expect(ratio * 14).toBeGreaterThanOrEqual(11);
  });

  it("scales the markdown editor content with the base size", () => {
    expect(globalCss).toMatch(
      /\.md-editor-cm \.cm-scroller \{\s*font-size:\s*var\(--ac-fs-ui\)/,
    );
  });
});
