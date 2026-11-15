import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

// Guard: every `var(--x)` in the frontend has a definition.
//
// A custom property nobody defines renders its var() fallback, or, with no
// fallback, drops the whole declaration. Either way the colour is no longer
// set by a token file, so a palette change misses it. This test scans the
// CSS, TS/TSX and Astro sources for var() references and fails on any name
// that no stylesheet, inline style or setProperty() call defines.
//
// It also keeps the published site on its own tokens (styles/site-tokens.css):
// a published stylesheet may not read a name that only the app's token files
// define, or re-theming the app would restyle published sites again.

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, "..");
const require = createRequire(import.meta.url);

/** Names defined outside this repo's sources, or on purpose left for an owner
 *  to set. Keep this list short and say why each entry is here. */
const ALLOWED_PREFIXES = [
  "--tw-", // Tailwind's internal utility variables
  "--xy-", // @xyflow/react theme variables
  "--puck-", // @puckeditor/core theme variables
  "--s-", // the site design's style variables, set inline from @onden/site styleVars (outside src/)
];
const ALLOWED_NAMES = new Set([
  // Published-site hooks: an owner's custom CSS (scoped under .site-root) may
  // set these; unset, the rule uses the site accent / surface by design.
  "--website-accent",
  "--docs-accent",
  "--docs-surface",
  "--docs-line",
  "--docs-text",
  "--docs-muted",
  // The side panes' widths: lib/paneWidths sets them on the page only once the
  // person has dragged a pane; unset, each grid uses its own default width.
  "--onden-sidebar-width",
  "--onden-inspector-width",
]);

/** The app's token files. The published site must not depend on them. */
const APP_TOKEN_FILES = ["styles/theme-tokens.css", "styles/tokens.css"];
const SITE_TOKEN_FILE = "styles/site-tokens.css";
/** Stylesheets the published site loads besides its own frame. */
const PUBLISHED_CSS = [
  "styles/published-site.css",
  "components/MarkdownRenderer.css",
  "components/StepsFigure.css", // the steps figure is drawn on the site too
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules" && name !== "test") walk(p, out);
    } else if (/\.(css|tsx?|astro)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

function stripComments(src: string, file: string): string {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, "");
  if (!file.endsWith(".css")) s = s.replace(/^\s*\/\/.*$/gm, "");
  return s;
}

function definitions(src: string): Set<string> {
  const out = new Set<string>();
  // CSS declarations `--x: …` (also matches an @theme block).
  for (const m of src.matchAll(/(?<![\w-])(--[a-zA-Z][\w-]*)\s*:/g)) out.add(m[1]);
  // Inline styles `{ "--x": … }` / `["--x" as string]` and setProperty("--x").
  for (const m of src.matchAll(/["'`](--[a-zA-Z][\w-]*)["'`]\s*(?:as\s+[\w.]+\s*)?[\]:]/g)) out.add(m[1]);
  for (const m of src.matchAll(/(?:setProperty|setRootStyle)\(\s*["'`](--[a-zA-Z][\w-]*)/g)) out.add(m[1]);
  return out;
}

function references(src: string): string[] {
  return [...src.matchAll(/var\(\s*(--[a-zA-Z][\w-]*)/g)].map((m) => m[1]);
}

function tailwindThemeNames(): Set<string> {
  // Tailwind emits its default theme (--font-mono, --color-*, …) into the
  // built CSS, so those names are defined at runtime.
  const theme = readFileSync(require.resolve("tailwindcss/theme.css"), "utf8");
  return definitions(theme);
}

const files = walk(srcDir);
const sources = new Map(files.map((f) => [f, stripComments(readFileSync(f, "utf8"), f)]));
const defined = tailwindThemeNames();
for (const src of sources.values()) for (const d of definitions(src)) defined.add(d);

const allowed = (name: string) =>
  ALLOWED_NAMES.has(name) || ALLOWED_PREFIXES.some((p) => name.startsWith(p));

describe("CSS custom properties are all defined", () => {
  it("finds no var(--x) whose name nothing defines", () => {
    const missing = new Map<string, Set<string>>();
    for (const [file, src] of sources) {
      for (const name of references(src)) {
        if (defined.has(name) || allowed(name)) continue;
        if (!missing.has(name)) missing.set(name, new Set());
        missing.get(name)!.add(relative(srcDir, file));
      }
    }
    const report = [...missing].map(([n, fs]) => `${n}  (${[...fs].join(", ")})`);
    expect(report, "Define these in a token file, or drop the var()").toEqual([]);
  });

  it("keeps the published site off the app's token files", () => {
    const appOnly = new Set<string>();
    for (const f of APP_TOKEN_FILES) {
      const p = resolve(srcDir, f);
      if (existsSync(p)) for (const d of definitions(sources.get(p) ?? "")) appOnly.add(d);
    }
    const site = definitions(sources.get(resolve(srcDir, SITE_TOKEN_FILE)) ?? "");
    expect(site.size).toBeGreaterThan(50);
    const leaks: string[] = [];
    for (const f of PUBLISHED_CSS) {
      for (const name of new Set(references(sources.get(resolve(srcDir, f)) ?? ""))) {
        if (appOnly.has(name) && !site.has(name)) leaks.push(`${name}  (${f})`);
      }
    }
    expect(leaks, "Published CSS reads an app token; add it to site-tokens.css").toEqual([]);
  });

  it("keeps the static export's CSS on its own tokens", () => {
    const css = readFileSync(resolve(srcDir, "../../backend/src/modules/website/publishing/css.ts"), "utf8");
    expect(css.match(/var\(--(onden|ac)-[\w-]*/g) ?? []).toEqual([]);
  });
});
