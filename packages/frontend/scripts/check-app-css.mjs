// After `astro build`: every stylesheet the app uses must reach the app page.
// A sheet is reachable when dist/client/index.html links it or inlines it (Astro
// inlines small sheets as <style>), or when client JS loads it with a lazily
// imported chunk. A sheet shared with the public
// site's pages can otherwise land in a CSS chunk only those pages link, and
// the app renders unstyled with no error (the sidebar, 2026-10-14).
//
// Also fails when client JS names a stylesheet the build never emitted.
//
// Checks each src/**/*.css that some module imports, except the public site's
// own sheets: every class it styles must appear in some reachable CSS.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { bareHoverRules } from "./hoverWithPointer.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ASTRO = join(ROOT, "dist/client/_astro");
const SITE_ONLY = new Set(["published-site.css", "print.css", "print-export.css", "siteFrame.css", "sitePreview.css", "siteReading.css"]);

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
// Classes a sheet styles: comments, @import lines, url(...) and empty rules
// (the minifier drops those) don't count.
const classes = (css) => new Set([...css
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/@import[^;]*;/g, "").replace(/url\([^)]*\)/g, "")
  .replace(/[^{}]*\{\s*\}/g, "")
  .matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]));

const built = readdirSync(ASTRO);
const html = readFileSync(join(ROOT, "dist/client/index.html"), "utf8");
const js = built.filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(ASTRO, f), "utf8")).join("\n");
const reachable = built.filter((f) => f.endsWith(".css") && (html.includes(`/_astro/${f}`) || js.includes(f)));
const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
const have = new Set([...reachable.flatMap((f) => [...classes(readFileSync(join(ASTRO, f), "utf8"))]), ...classes(inline)]);

const problems = [];
// Every stylesheet a chunk's preload list names must exist. Astro drops the CSS
// of a chunk holding a hydrated island's own module, and a lazy import whose
// preload list still names it then fails ("Unable to preload CSS", 2026-10-14).
const named = new Set([...js.matchAll(/_astro\/([\w.-]+\.css)/g)].map((m) => m[1]));
const dangling = [...named].filter((f) => !built.includes(f));
if (dangling.length) {
  console.error("Client chunks preload stylesheets the build did not emit (an island's own module shares a chunk with the app?):\n  " + dangling.join("\n  "));
  process.exit(1);
}
// No built stylesheet may @import another host: when it is unreachable (offline,
// a blocked network) the lazy chunk fails and the screen it styles never opens
// (Puck's rsms.me font import broke the website screen, 2026-10-24).
const external = built.filter((f) => f.endsWith(".css") && /@import\s*(url\()?\s*["']?(https?:)?\/\//i.test(readFileSync(join(ASTRO, f), "utf8")));
if (external.length) {
  console.error("Stylesheets that @import another host (use a local copy, e.g. @puckeditor/core/no-external.css):\n  " + external.join("\n  "));
  process.exit(1);
}
const sources = walk(join(ROOT, "src")).filter((f) => /\.(tsx?|astro|css)$/.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
const imported = (file) => sources.includes(`/${basename(file)}"`) || sources.includes(`/${basename(file)}'`);
// src/browserApp is the browser app's own entry (vite.browser.config.ts): its sheets are not on the web build's page by design.
for (const file of walk(join(ROOT, "src")).filter((f) => f.endsWith(".css") && !SITE_ONLY.has(basename(f)) && !relative(ROOT, f).startsWith(join("src", "browserApp")) && imported(f))) {
  const missing = [...classes(readFileSync(file, "utf8"))].filter((c) => !have.has(c));
  if (missing.length) problems.push(`${relative(ROOT, file)}: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` (+${missing.length - 5})` : ""}`);
}
if (problems.length) {
  console.error("App stylesheets that do not reach the app page (import them in src/pages/index.astro):\n  " + problems.join("\n  "));
  process.exit(1);
}
// A hover tint must sit in @media (hover: hover), or it sticks to the last tap on a
// touch screen. scripts/hoverWithPointer.mjs moves every one there; a hit here means
// a stylesheet skipped that plugin (astro.config.mjs vite.css.postcss).
const stuck = [...built.filter((f) => f.endsWith(".css")).map((f) => [f, readFileSync(join(ASTRO, f), "utf8")]), ["index.html <style>", inline]]
  .flatMap(([f, css]) => bareHoverRules(postcss.parse(css)).map((rule) => `${f}: ${rule.selector.slice(0, 80)}`));
if (stuck.length) {
  console.error(`Hover tints outside @media (hover: hover) (${stuck.length}; is hoverWithPointer wired in astro.config.mjs?):\n  ` + stuck.slice(0, 10).join("\n  "));
  process.exit(1);
}
console.log(`check-app-css: ${reachable.length} reachable stylesheets cover the app's classes.`);
