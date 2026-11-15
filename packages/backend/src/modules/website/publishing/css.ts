// The stylesheet of the single-note HTML export (singleNoteHtml.ts): reading
// typography, KaTeX, the Markdown elements md2html draws, and the owner's
// accent / font / paper tone / custom CSS from the site settings. The site's
// own pages are styled on the frontend (@onden/site); this is not theirs.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DIAGRAM_CSS, normalizeHexColor } from "@onden/markdown";
import type { Manifest } from "./types.js";
import { esc } from "./htmlUtils.js";
import { sanitizeSiteCss } from "@onden/site";

// KaTeX stylesheet, inlined into the published <head> so math renders the same
// as in-app (where styles/global.css imports katex.min.css). Read once at
// module load from the installed `katex` package.
//
// Privacy default ([[product-thesis]] local-first; a published Onden site must
// NOT phone home by default): the @font-face `url(fonts/...)` rules are STRIPPED
// so the published CSS makes no third-party (jsdelivr) request that would leak
// the visitor's IP. Layout/positioning rules are all inline, so math still
// renders legibly with the document's own fonts; only the dedicated math glyphs
// degrade. An owner who wants the exact glyphs can opt in to the font CDN
// (manifest tokens.webfonts), which selects the CDN variant below.
function loadKatexCss(rewriteFontsToCdn: boolean): string {
  try {
    const require = createRequire(import.meta.url);
    const cssPath = require.resolve("katex/dist/katex.min.css");
    const version = (require("katex/package.json") as { version: string }).version;
    const raw = readFileSync(cssPath, "utf8");
    if (rewriteFontsToCdn) {
      const cdnBase = `https://cdn.jsdelivr.net/npm/katex@${version}/dist/fonts/`;
      return raw.replace(/url\(fonts\//g, `url(${cdnBase}`);
    }
    // Default: drop the @font-face blocks entirely so no outbound font request
    // is emitted. Every layout/positioning rule is preserved.
    return raw.replace(/@font-face\s*\{[^}]*\}/g, "");
  } catch {
    // KaTeX not resolvable (shouldn't happen — it's a workspace dep): publish
    // without math styles rather than failing the whole build.
    return "";
  }
}

// Both variants computed once at module load; the per-build choice (opt-in CDN
// vs privacy default) just selects between them.
const KATEX_CSS_LOCAL = loadKatexCss(false);
const KATEX_CSS_CDN = loadKatexCss(true);

/** The KaTeX stylesheet for the published <head>. Exported for tests.
 *  Defaults to the no-egress variant; pass {webfonts:true} to use the CDN. */
export function buildKatexCss(opts?: { webfonts?: boolean }): string {
  return opts?.webfonts ? KATEX_CSS_CDN : KATEX_CSS_LOCAL;
}

// The settled Onden type system ([[design-collab-style]]): Fraunces editorial
// display serif × IBM Plex Sans body × IBM Plex Mono code. CDN-pinned the same
// way the katex math fonts are (the static export bundles no asset directory and
// pages live nested under site/<slug>/, so a vendored woff2 path can't resolve);
// font-display:swap means first paint never blocks on the fetch and a 404 simply
// falls through to the system serif/sans tail of each var. Applied only when the
// owner hasn't chosen an explicit font (tokens.font unset/empty) so picking a
// font in the publish UI still wins — AND only when the owner has opted in to
// web fonts (manifest tokens.webfonts). By default this @import is omitted so a
// published Onden site does not phone home to Google ([[product-thesis]]
// local-first): the font-family stacks below all carry system fallbacks, so the
// site stays legible without any third-party request.
const ONDEN_FONTS_IMPORT =
  "@import url('https://fonts.googleapis.com/css2?" +
  "family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700;1,9..144,400&" +
  "family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&" +
  "family=IBM+Plex+Mono:wght@400;500&display=swap');";

const ONDEN_FONT_SERIF =
  '"Fraunces","Iowan Old Style","Apple Garamond",Georgia,"Times New Roman",serif';
const ONDEN_FONT_SANS =
  '"IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
const ONDEN_FONT_MONO =
  '"IBM Plex Mono",ui-monospace,"Cascadia Code","Fira Code",monospace';

/** Styles for what md2html draws beyond plain Markdown (@onden/markdown
 *  callouts, embeds, media players, mermaid source) — the static twin of the
 *  app's MarkdownRenderer.css. Shared by every export head. */
export const MARKDOWN_ELEMENTS_CSS = `
.callout{border-left:3px solid;border-radius:0 6px 6px 0;padding:10px 14px;margin:12px 0}
details.callout>summary{cursor:pointer}
.callout .callout-title{font-weight:600;font-size:.85em;margin:0 0 6px;text-transform:uppercase;letter-spacing:.04em}
.callout p{margin:4px 0 0}
.callout-note,.callout-info,.callout-todo{border-color:#2563eb;background:#2563eb14}
.callout-abstract,.callout-tip{border-color:#0d9488;background:#0d948814}
.callout-success{border-color:#16a34a;background:#16a34a14}
.callout-question,.callout-warning{border-color:#b45309;background:#b4530914}
.callout-failure,.callout-danger,.callout-bug{border-color:#dc2626;background:#dc262614}
.callout-example{border-color:#8b5cf6;background:#8b5cf614}
.callout-quote{border-color:#6b7280;background:#6b728014}
.md-embed-iframe{display:block;position:relative;width:100%;aspect-ratio:16/9;margin:.75rem 0;border-radius:6px;overflow:hidden;background:#0001}
.md-embed-iframe iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.md-embed-lite{display:block;position:relative;width:100%;aspect-ratio:16/9;margin:.75rem 0;border-radius:6px;overflow:hidden;background:#0001}
.md-lite-link{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:inherit;opacity:.9;text-decoration:none}
.md-lite-thumb{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.md-lite-host{position:absolute;left:.75rem;bottom:.5rem;font-size:.85em}
.md-lite-play{position:relative;width:3.5rem;height:3.5rem;border-radius:50%;background:#000c}
.md-lite-play::after{content:"";position:absolute;left:50%;top:50%;transform:translate(-35%,-50%);border-style:solid;border-width:.55rem 0 .55rem .9rem;border-color:transparent transparent transparent #fff}
.md-audio-speed{display:block;margin:0 0 .5rem auto;padding:.125rem .625rem;border:1px solid currentColor;border-radius:999px;background:transparent;color:inherit;font-size:.85em;opacity:.7;cursor:pointer}
.md-audio-speed[hidden]{display:none}
.md-checkbox{display:inline-block;width:14px;height:14px;border:1.5px solid currentColor;border-radius:3px;position:relative;top:2px;opacity:.7}
.md-checkbox.checked{background:var(--accent,#2f6f5e);border-color:var(--accent,#2f6f5e);opacity:1}
.md-checkbox.checked::after{content:"";position:absolute;left:3px;top:1px;width:6px;height:9px;border:2px solid #fff;border-top:none;border-left:none;transform:rotate(45deg)}
.md-video{display:block;max-width:100%;border-radius:6px;margin:.5rem 0;background:var(--line)}
.md-audio{display:block;width:100%;margin:.5rem 0}
pre.mermaid{white-space:pre;overflow-x:auto;font-size:.86em}
${DIAGRAM_CSS}
.onden-query-frozen{margin:12px 0;overflow-x:auto}
.onden-query-frozen-in{margin-left:.5em;opacity:.7;font-size:.9em}
.onden-query-frozen-more,.onden-query-frozen-empty,.onden-query-frozen-note,.onden-query-frozen-problem{opacity:.7;font-size:.9em}
`.trim();

export function buildNoteExportCss(manifest: Manifest): string {
  const tokens = manifest.tokens ?? {};
  const accent = tokens.accent ?? "#2f6f5e";
  // The owner-chosen font wins; only when none is set do we apply the settled
  // Onden stack (so the default publish gives the real Onden type system, not
  // the system fallback). `serif`/`mono` keyword choices keep their own stacks.
  const ownerFont = typeof tokens.font === "string" ? tokens.font.trim() : "";
  const useOndenFonts = ownerFont === "";
  const bodyFont = useOndenFonts ? ONDEN_FONT_SANS : ownerFont;
  // Privacy default: external web fonts (Google Fonts @import + KaTeX jsdelivr
  // glyphs) are emitted ONLY when the owner opts in. Off by default so the
  // published site makes no third-party request that leaks a visitor's IP.
  const webfonts = tokens.webfonts === true;
  const emitFontImport = useOndenFonts && webfonts;
  // ⑩ paper tone: override --bg (and the surface) AFTER the base rules so
  // the chosen page background wins. A #rgb, #rgba, #rrggbb or #rrggbbaa is
  // accepted (older sites saved the short and alpha forms); anything else is ignored.
  const siteBg = (typeof manifest.site_bg === "string" && normalizeHexColor(manifest.site_bg)) || "";
  const paperBlock = siteBg ? `\n\n/* ── Paper tone (site owner) ── */\n:root{--bg:${siteBg};--sur:${siteBg}}\n` : "";
  // ⑩ custom appearance: owner CSS wins by coming LAST (later rules override
  // the theme). Sanitised so it can't break out of the <style> block.
  const custom = sanitizeSiteCss(manifest.custom_css);
  const customBlock = (paperBlock) + (custom ? `\n\n/* ── Custom CSS (site owner) ── */\n${custom}\n` : "");
  // KaTeX styles first so the theme's `code`/`a`/colour rules still win where
  // they overlap; owner custom CSS stays last. Without this, math renders as
  // unstyled/overlapping glyphs on the published site (it worked in-app only
  // because the app bundles katex.min.css globally). Uses the no-egress variant
  // unless the owner opted in to web fonts.
  const katexCss = buildKatexCss({ webfonts });
  const katexBlock = katexCss ? `\n\n/* ── KaTeX (math) ── */\n${katexCss}\n` : "";

  // The font @import (when opted in) MUST come first: CSS ignores an @import
  // preceded by any style rule, and the KaTeX block carries rules. Putting it
  // ahead of katexBlock keeps it valid.
  const fontImport = emitFontImport ? `${ONDEN_FONTS_IMPORT}\n` : "";

  return (fontImport + katexBlock + `\n${MARKDOWN_ELEMENTS_CSS}\n` + `
/* ── Reset ── */
*{box-sizing:border-box;margin:0;padding:0}

/* ── Design tokens ── */
:root{
  --accent:${esc(accent)};
  --bg:#f7f7f4;
  --sur:#fff;
  --txt:#20231f;
  --mut:#687064;
  --line:#d9ded5;
  --radius:6px;
  /* Onden type system (settled Fraunces × Plex stack). */
  --font-display:${ONDEN_FONT_SERIF};
  --font-body:${ONDEN_FONT_SANS};
  --font-mono:${ONDEN_FONT_MONO};
}

/* ── Base layout ── */
body{
  background:var(--bg);
  color:var(--txt);
  min-height:100vh;
  font-family:${bodyFont};
  font-size:${tokens.density === "compact" ? "14px" : tokens.density === "spacious" ? "17px" : "15px"};
  line-height:1.6;
}

/* ── Typography ── */
${useOndenFonts ? "h1,h2,h3,h4{font-family:var(--font-display)}\n" : ""}h1{font-size:1.85rem;font-weight:700;margin-bottom:.75rem;line-height:1.25}
h2{font-size:1.3rem;font-weight:600;margin:2rem 0 .6rem;line-height:1.3}
h3{font-size:1.1rem;font-weight:600;margin:1.5rem 0 .5rem}
h4{font-size:1rem;font-weight:600;margin:1.2rem 0 .4rem}
p{line-height:1.75;margin-bottom:1rem}
ul,ol{margin:0 0 1rem 1.5rem}
li{margin-bottom:.35rem;line-height:1.65}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
code{background:var(--bg);border-radius:3px;padding:1px 5px;font-size:.88em;font-family:${useOndenFonts ? "var(--font-mono)" : "monospace"}}
pre{background:var(--bg);border-radius:8px;padding:16px;overflow-x:auto;margin-bottom:1rem;border:1px solid var(--line)}
pre code{background:none;padding:0;font-size:.86em}
blockquote{border-left:3px solid var(--line);padding-left:14px;color:var(--mut);margin-bottom:1rem}
img{max-width:100%;border-radius:var(--radius);display:block;margin:1rem 0}
table{border-collapse:collapse;width:100%;margin-bottom:1rem}
th,td{border:1px solid var(--line);padding:7px 11px;text-align:left}
th{background:var(--bg);font-weight:600}
hr{border:none;border-top:1px solid var(--line);margin:2rem 0}

/* ── The note ── */
.note-export{max-width:720px;margin:0 auto;padding:48px 32px}
@media(max-width:768px){.note-export{padding:24px 20px}}
`.trim() + customBlock);
}
