// The STATIC view: what the sources say (declarations in .css, `size={n}` in .tsx), per kind of value. It is the other
// half of the census: the computed view (run.mjs) says what is on screen, this says where the numbers are written.
// Also builds the index "selector text → source file:line" that turns a stylesheet rule seen in the page into a file.
import { createRequire } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const postcss = require("postcss");
export const SRC = resolve(here, "../../src");
const REPO = resolve(here, "../../../..");

const walk = (dir, ext) => readdirSync(dir).flatMap((n) => {
  const f = join(dir, n);
  if (statSync(f).isDirectory()) return n === "test" || n === "node_modules" ? [] : walk(f, ext);
  return ext.some((e) => n.endsWith(e)) && !/\.test\.[tj]sx?$/.test(n) ? [f] : [];
});
export const cssFiles = () => walk(SRC, [".css"]);
export const tsxFiles = () => walk(SRC, [".tsx"]);
const rel = (f) => relative(REPO, f);

const VAR = /var\(\s*--[\w-]+\s*(?:,[^()]*(?:\([^)]*\)[^()]*)*)?\)/g;
const NUM = /(-?\d*\.?\d+)(px|rem|em|%|ms|s|vw|vh)?/g;
const COLOR_LITERAL = /(^|[^-\w])(#[0-9a-f]{3,8}\b|(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\()/i;
const NAMED = /\b(white|black|red|green|blue|gray|grey|silver|yellow|orange|purple|pink|brown|cyan|magenta|navy|teal|lime|maroon|olive|aqua|fuchsia|gold|coral|crimson|indigo|violet|tomato|salmon|khaki|ivory|beige|tan|plum)\b/i;

/** property → kind. A property that belongs to two kinds (border: width and colour) lists both. */
const PROP_KINDS = [
  [/^(color|background|background-color|border(-(top|right|bottom|left|block|inline)(-\w+)?)?(-color)?|outline(-color)?|fill|stroke|text-decoration(-color)?|caret-color|accent-color|column-rule(-color)?|-webkit-tap-highlight-color)$/, "colour"],
  [/^font-size$/, "font-size"],
  [/^font-weight$/, "font-weight"],
  [/^line-height$/, "line-height"],
  [/^letter-spacing$/, "letter-spacing"],
  [/^font-family$/, "font-family"],
  [/^(padding|margin)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$|^(gap|row-gap|column-gap)$/, "spacing"],
  [/^border(-(top|right|bottom|left|start|end|[a-z-]+))?-radius$/, "radius"],
  [/^border(-(top|right|bottom|left|inline|block)(-\w+)?)?(-width)?$|^outline-width$/, "border-width"],
  [/^border(-(top|right|bottom|left))?-style$|^outline-style$/, "border-style"],
  [/^box-shadow$/, "shadow"],
  [/^(height|min-height|block-size|min-block-size)$/, "control-height"],
  [/^z-index$/, "z-index"],
  [/^(max-width|max-inline-size)$/, "max-width"],
  [/^opacity$/, "opacity"],
  [/^(transition|transition-duration|animation|animation-duration)$/, "transition-ms"],
  [/^(outline|outline-offset)$/, "focus-ring"],
];

function rawNumbers(kind, prop, value) {
  const v = value.replace(/!important/i, "").replace(VAR, " ");
  if (kind === "colour") return COLOR_LITERAL.test(v) || (!prop.startsWith("--") && NAMED.test(v)) ? [v.trim().slice(0, 40)] : [];
  if (kind === "font-family") return v.trim() && !/^(inherit|initial|unset|revert)$/.test(v.trim()) ? [v.trim().split(",")[0].replace(/["']/g, "").trim()] : [];
  if (kind === "border-style") return /\b(solid|dashed|dotted|double|groove|ridge|inset|outset)\b/.test(value) && !VAR.test(value) ? [value.match(/\b(solid|dashed|dotted|double|groove|ridge|inset|outset)\b/)[0]] : [];
  if (kind === "shadow") return v.trim() && v.trim() !== "none" ? [v.trim().replace(/\s+/g, " ").slice(0, 60)] : [];
  const out = [];
  let body = v;
  if (kind === "border-width") { // `1px solid` → 1px; colours and styles are not widths
    body = body.replace(/#[0-9a-f]{3,8}\b/gi, " ").replace(/(rgb|rgba|hsl|hsla)\([^)]*\)/gi, " ").replace(/color-mix\([^)]*\)/gi, " ");
  }
  if (kind === "transition-ms") body = body.replace(/cubic-bezier\([^)]*\)/g, " ");
  for (const m of body.matchAll(NUM)) {
    const n = Number(m[1]); const unit = m[2] ?? "";
    if (n === 0) continue;
    if (kind === "font-weight" || kind === "z-index" || kind === "opacity" || kind === "line-height") { out.push(String(n) + unit); continue; }
    if (kind === "transition-ms" && !/^(ms|s)$/.test(unit)) continue;
    if (kind === "transition-ms") { out.push(`${unit === "s" ? n * 1000 : n}ms`); continue; }
    if (unit === "") continue;
    out.push(n + unit);
  }
  return out;
}

export function scanCss() {
  const kinds = {};
  const slot = (k) => (kinds[k] ||= { tokenDecls: 0, rawDecls: 0, raw: {}, byFile: {} });
  const media = {};
  const mediaOther = {};
  const index = new Map(); // normalised selector → [{ file, line }]
  const byClass = new Map(); // ".name" → { file, line }
  let declarations = 0;
  const norm = (s) => s.replace(/\s+/g, " ").replace(/\s*([>+~,])\s*/g, "$1").trim();
  for (const file of cssFiles()) {
    const root = postcss.parse(readFileSync(file, "utf8"), { from: file });
    const f = rel(file);
    root.walkAtRules("media", (a) => {
      for (const m of a.params.matchAll(/\((?:min-|max-)?(width|height)\s*:\s*([\d.]+)(px|em|rem)\)|\(([^)]*>=?[^)]*)\)/g)) {
        const key = m[1] ? `${m[0]}` : m[0];
        media[key] = (media[key] || 0) + 1;
      }
      for (const m of a.params.matchAll(/\((prefers-[\w-]+|hover|pointer|orientation|any-hover|any-pointer|forced-colors|print)[^)]*\)|\b(print)\b/g)) mediaOther[m[0]] = (mediaOther[m[0]] || 0) + 1;
    });
    root.walkRules((r) => {
      if (r.parent?.type === "atrule" && /keyframes$/i.test(r.parent.name)) return;
      const line = r.source?.start?.line ?? 0;
      for (const part of r.selector.split(",")) {
        const n = norm(part);
        if (!index.has(n)) index.set(n, []);
        index.get(n).push({ file: f, line });
        for (const c of n.matchAll(/\.([A-Za-z_][\w-]*)/g)) if (!byClass.has(c[1])) byClass.set(c[1], { file: f, line });
      }
    });
    root.walkDecls((d) => {
      declarations++;
      const prop = d.prop.toLowerCase();
      if (prop.startsWith("--")) return;
      for (const [re, kind] of PROP_KINDS) {
        if (!re.test(prop)) continue;
        // `border: 1px solid var(--ac-line)` is a width, a style AND a colour: each kind reads the parts it owns.
        if ((kind === "border-width" || kind === "border-style") && prop === "outline") continue;
        if (kind === "focus-ring" && prop !== "outline" && prop !== "outline-offset") continue;
        const k = slot(kind);
        const raws = rawNumbers(kind, prop, d.value);
        const usesToken = VAR.test(d.value); VAR.lastIndex = 0;
        if (raws.length) {
          k.rawDecls++;
          k.byFile[f] = (k.byFile[f] || 0) + 1;
          for (const r of raws) k.raw[r] = (k.raw[r] || 0) + 1;
        } else if (usesToken) k.tokenDecls++;
      }
    });
  }
  return { kinds, media, mediaOther, declarations, index, byClass };
}

/** Icons and inline styles in .tsx: `size={n}`, `strokeWidth={n}`, `style={{ padding: n }}`. */
export function scanTsx() {
  const iconSize = {}, stroke = {}, inline = {};
  let files = 0, sizeUses = 0;
  for (const file of tsxFiles()) {
    const text = readFileSync(file, "utf8");
    files++;
    for (const m of text.matchAll(/<([A-Z][A-Za-z0-9]*)\b[^<>]*?\bsize=\{(\d+)\}/g)) {
      // Only icon components: Lucide-style names; skip other components that take a `size`.
      if (/^(Button|Avatar|Spinner|Text|Heading|Badge|Chip|Switch|Select|Input)$/.test(m[1])) continue;
      iconSize[m[2] + "px"] = (iconSize[m[2] + "px"] || 0) + 1; sizeUses++;
    }
    for (const m of text.matchAll(/\bstrokeWidth=\{([\d.]+)\}/g)) stroke[m[1]] = (stroke[m[1]] || 0) + 1;
    // `style={{ ... }}`: a line that only sets custom properties (`"--x": v`) is a data hook for CSS; a look property is a look written in TSX.
    for (const m of text.matchAll(/style=\{\{([^\n]*)/g)) {
      inline.total = (inline.total || 0) + 1;
      if (/\b(padding|margin|gap|fontSize|fontWeight|borderRadius|zIndex|opacity|boxShadow|color|background|height|width)\w*\s*:/.test(m[1])) inline.directLook = (inline.directLook || 0) + 1;
    }
  }
  return { files, iconSize, stroke, inline, sizeUses };
}

/** A rule seen in the page → where it is written. Exact selector first, then each comma part, then its last class. */
export function sourceOfRule(css, selectorText) {
  const norm = (s) => s.replace(/\s+/g, " ").replace(/\s*([>+~,])\s*/g, "$1").trim();
  const parts = [norm(selectorText), ...selectorText.split(",").map(norm)];
  for (const p of parts) { const hit = css.index.get(p); if (hit?.length) return { ...hit[0], exact: true }; }
  const last = norm(selectorText).split(",")[0].match(/\.([A-Za-z_][\w-]*)[^.]*$/);
  if (last && css.byClass.has(last[1])) return { ...css.byClass.get(last[1]), exact: false };
  return null;
}
