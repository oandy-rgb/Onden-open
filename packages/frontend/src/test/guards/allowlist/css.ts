// CSS detectors for the allowlist guards: what a stylesheet may say is a short list,
// everything else is a violation counted per file. postcss does the parsing (vite already
// depends on it); there is no stylelint because the rules here are per-file owners plus a
// ratchet, which stylelint cannot express without a second baseline mechanism.
import postcss, { type AtRule, type Declaration } from "postcss";
// The detector for the look kinds added 2026-11-17 (spacing … focus ring) is shared with the style census (e2e/style-census/static.mjs).
import { CSS_LOOK_RULES, declarationContext, declarationLooks, exemptedRules } from "../../../../scripts/appearanceLook.mjs";

export const CSS_RULES = [
  "css-color", "css-radius", "css-shadow", "css-z-index", "css-font-size", "css-media-width", "css-position-fixed",
  "css-spacing", "css-line-height", "css-font-weight", "css-letter-spacing", "css-font-family", "css-border-width", "css-opacity",
  "css-duration", "css-easing", "css-control-height", "css-max-width", "css-focus-ring",
] as const;
export type CssRule = (typeof CSS_RULES)[number];
/** Look rules of the shared detector that must all be listed in CSS_RULES (checked by allowlistRules.guard.test.ts). */
export const SHARED_LOOK_CSS_RULES: readonly string[] = CSS_LOOK_RULES;

/** The widths a layout may switch at (owner decision): phone / tablet / desktop. */
export const MEDIA_WIDTHS_PX = [600, 900, 1280] as const;

const COLOR_FUNCTION = /(^|[^-\w])(#[0-9a-f]{3,8}\b|(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\()/i;
const NAMED_COLOR = /\b(white|black|red|green|blue|gray|grey|silver|yellow|orange|purple|pink|brown|cyan|magenta|navy|teal|lime|maroon|olive|aqua|fuchsia|gold|coral|crimson|indigo|violet|tomato|salmon|khaki|ivory|beige|tan|plum)\b/i;
const COLOR_PROPERTY = /^(color|background|background-color|background-image|border|border-(top|right|bottom|left|block|inline)(-\w+)?-color|border-(top|right|bottom|left|block|inline)|border-color|outline|outline-color|fill|stroke|box-shadow|text-shadow|text-decoration|text-decoration-color|caret-color|accent-color|column-rule|column-rule-color|scrollbar-color|-webkit-text-fill-color|-webkit-tap-highlight-color)$/;
/** Words that mean "no value of my own": they add no new look. */
const NEUTRAL = new Set(["0", "none", "inherit", "initial", "unset", "revert", "auto", "normal", "/"]);

const RELATIVE_SIZE = /^\d*\.?\d+(em|%)$/;

/** A value made only of var(--token) references and neutral words. */
function tokenOnly(value: string): boolean {
  const rest = value.replace(/var\(\s*--[\w-]+\s*(,[^)]*)?\)/g, " ").trim();
  return rest.split(/\s+/).filter(Boolean).every((word) => NEUTRAL.has(word));
}

function declarationRule(decl: Declaration): CssRule | null {
  const prop = decl.prop.toLowerCase();
  const value = decl.value.replace(/\s*!important\s*$/i, "");
  if (/^(border(-\w+)*-radius)$/.test(prop)) return tokenOnly(value) ? null : "css-radius";
  if (prop === "box-shadow") return tokenOnly(value) ? null : "css-shadow";
  if (prop === "z-index") return tokenOnly(value) ? null : "css-z-index";
  // em/% sizes are relative to the surrounding text (inline code, sub/superscript), so they add no absolute size.
  if (prop === "font-size") return tokenOnly(value) || RELATIVE_SIZE.test(value.trim()) ? null : "css-font-size";
  if (prop === "position" && /^fixed$/i.test(value.trim())) return "css-position-fixed";
  const colorful = prop.startsWith("--") || COLOR_PROPERTY.test(prop);
  if (colorful) {
    // A literal color anywhere outside a var() fallback-free reference. `var(--x, #fff)` hides one in the fallback.
    if (COLOR_FUNCTION.test(value)) return "css-color";
    if (!prop.startsWith("--") && NAMED_COLOR.test(value.replace(/var\([^)]*\)/g, " "))) return "css-color";
  }
  return null;
}

/** Widths used by width conditions of a media query that are not one of MEDIA_WIDTHS_PX. */
export function offStandardMediaWidths(params: string): string[] {
  const bad: string[] = [];
  // `(min-width: 600px)`, `(max-width: 40em)`, and range syntax `(width >= 600px)` / `(600px <= width)`.
  const conditions = params.match(/\((?:min-|max-)?width\s*(?::|[<>]=?)[^)]*\)|\([^)]*[<>]=?\s*width[^)]*\)/gi) ?? [];
  for (const cond of conditions) {
    for (const m of cond.matchAll(/(-?\d*\.?\d+)\s*(px|em|rem)/gi)) {
      const px = Number(m[1]) * (m[2]!.toLowerCase() === "px" ? 1 : 16);
      if (!MEDIA_WIDTHS_PX.includes(px as (typeof MEDIA_WIDTHS_PX)[number])) bad.push(`${m[1]}${m[2]}`);
    }
  }
  return bad;
}

/** Every violation in a stylesheet: `{ rule, line }`, one per declaration (or per off-standard media width). */
export function cssViolations(source: string, from = "style.css"): { rule: CssRule; line: number }[] {
  const out: { rule: CssRule; line: number }[] = [];
  const root = postcss.parse(source, { from });
  root.walkDecls((decl) => {
    const rule = declarationRule(decl);
    if (rule) out.push({ rule, line: decl.source?.start?.line ?? 0 });
    // One violation per declaration and rule, however many raw values it holds (`padding: 6px 10px` is one).
    const excused = exemptedRules(decl);
    for (const look of declarationLooks(decl.prop, decl.value, declarationContext(decl))) {
      if (look.raw.length && !excused.has(look.rule)) out.push({ rule: look.rule as CssRule, line: decl.source?.start?.line ?? 0 });
    }
  });
  root.walkAtRules("media", (at: AtRule) => {
    for (const _ of offStandardMediaWidths(at.params)) out.push({ rule: "css-media-width", line: at.source?.start?.line ?? 0 });
  });
  return out;
}

// ── css-legacy-token: app styles read colours only through --ac-* ─────────────────────────
// A var(--x) is allowed when --x is a token prefix listed in TOKEN_PREFIX_OWNERS (owners.ts), or a
// custom property some stylesheet / inline style defines outside the token files (a component's own
// --depth, --section-color …). Anything else is one of the older colour aliases (--accent, --muted,
// --onden-text-muted …) that used to fan out of theme-tokens.css.
const VAR_REFERENCE = /var\(\s*(--[A-Za-z][\w-]*)/g;
const COMMENTS = /\/\*[\s\S]*?\*\//g;

/** The `--x` names a source defines itself: `--x: …` declarations and inline-style / setProperty keys. */
export function definedProperties(source: string): Set<string> {
  const out = new Set<string>();
  const code = source.replace(COMMENTS, " ");
  for (const m of code.matchAll(/(?<![\w-])(--[A-Za-z][\w-]*)\s*:/g)) out.add(m[1]!);
  for (const m of code.matchAll(/["'`](--[A-Za-z][\w-]*)["'`]\s*(?:as\s+[\w.]+\s*)?[\]:]/g)) out.add(m[1]!);
  for (const m of code.matchAll(/setProperty\(\s*["'`](--[A-Za-z][\w-]*)/g)) out.add(m[1]!);
  return out;
}

/** Every `var(--x)` whose --x is neither an allowed token prefix nor defined by the app itself. */
export function legacyTokenUses(source: string, allowedPrefixes: readonly RegExp[], localNames: ReadonlySet<string>): string[] {
  const code = source.replace(COMMENTS, " ").replace(/^\s*\/\/.*$/gm, " ");
  const out: string[] = [];
  for (const m of code.matchAll(VAR_REFERENCE)) {
    const name = m[1]!;
    if (allowedPrefixes.some((p) => p.test(name)) || localNames.has(name)) continue;
    out.push(name);
  }
  return out;
}
