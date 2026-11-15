// Custom CSS tools: the brace check, the scoping of a design's CSS under
// `.site-scope`, and the one sanitiser for owner CSS going into a `<style>`
// (`sanitizeSiteCss`: every `<` becomes `\3c `, so no input can rebuild
// `</style`, `@import` is dropped, at most SITE_CSS_MAX characters): the
// design's CSS and the old site's `custom_css` both go through it.
import { cutToUnits } from "@onden/markdown";
import type { PuckData } from "./design.js";
import { walkHome } from "./walk.js";

export const SITE_CSS_MAX = 50_000;
export const SITE_SCOPE = ".site-scope";
/** Ids that may sit in an attribute selector without escaping. */
const NODE_ID = /^[A-Za-z0-9_-]+$/;

/** Whether every `{` has its `}` and no `}` comes early. Braces inside strings
 *  and comments do not count; a backslash escapes the next character. */
export function bracesBalanced(css: string): boolean {
  let depth = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i]!;
    if (c === "\\") i++;
    else if (c === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end < 0) return false;
      i = end + 1;
    } else if (c === '"' || c === "'") {
      i++;
      while (i < css.length && css[i] !== c) {
        if (css[i] === "\\") i++;
        else if (css[i] === "\n") return false;
        i++;
      }
      if (i >= css.length) return false;
    } else if (c === "{") depth++;
    else if (c === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

// An at-keyword written with CSS escapes (`@im\70ort`) is the same keyword to a browser.
const AT_KEYWORD = /@(?:[\w-]|\\(?:[0-9a-f]{1,6}[ \t\n\f]?|[^\n0-9a-f]))+/gi;
const CSS_ESCAPE = /\\(?:([0-9a-f]{1,6})[ \t\n\f]?|([^\n]))/gi;

function unescapeAtKeywords(css: string): string {
  return css.replace(AT_KEYWORD, (keyword) => keyword.replace(CSS_ESCAPE, (_, hex?: string, char?: string) => {
    // An escaped backslash stays escaped: unescaping it would leave a bare `\` that joins what follows (`\<` -> `\\3c `).
    if (char !== undefined) return char === "\\" ? `\\${char}` : char;
    const code = parseInt(hex!, 16);
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? "\ufffd" : String.fromCodePoint(code);
  }));
}

/** Removes `@import` rules until none is left: one pass can join what is left around a removal
 *  into a new one (`@i@import;mport url(x)`, `@@import;import url(x)`); each pass only shrinks the text. */
function dropImports(css: string): string {
  let clean = css;
  for (let previous = ""; previous !== clean;) {
    previous = clean;
    clean = clean.replace(/@\s*\\/g, "").replace(/@import\b[^;{}\n]*;?/gi, "");
  }
  return clean;
}

/** CSS safe to put in a raw-text `<style>`: no `@import` (a site never loads
 *  another origin's CSS; `@\69mport` and `@im\70ort` are dropped too), no `<`
 *  (so nothing can rebuild `</style`; to the CSS parser `\3c ` is the same
 *  character), and capped so a runaway paste can't bloat every page. The author
 *  owns the site: beyond that, what CSS they write is theirs. "" for none. */
export function sanitizeSiteCss(css: string | null | undefined): string {
  if (!css) return "";
  // One pass is not a fixed point: the `\3c ` it writes can end up next to an `@` (`@ <` -> `@ \3c `), which the
  // next pass reads as an escaped at-keyword and removes. So repeat until nothing changes (each pass only shrinks
  // what is left or re-escapes the same `<`), so storing the result and sanitising it again changes nothing.
  let clean = cutToUnits(css, SITE_CSS_MAX);
  for (let pass = 0; pass < 8; pass++) {
    const next = dropImports(unescapeAtKeywords(clean)).replace(/</g, "\\3c ");
    if (next === clean) break;
    clean = next;
  }
  return clean;
}

/** Whether `css` has an `@import` that sanitizeSiteCss drops: the one the site studio warns about. */
export function usesImport(css: string | null | undefined): boolean {
  const unescaped = unescapeAtKeywords(css ?? "");
  return dropImports(unescaped) !== unescaped;
}

/** The design's CSS as one string: the site-wide CSS on `.site-scope`, each
 *  part of the Puck home page (when one is drawn) on `.site-scope [data-node="<id>"]`.
 *  Each block is `@scope (<root>) { :scope<attr> { <css> } }`: inside the
 *  `:scope` rule it is native CSS nesting, so bare declarations, `&` and nested
 *  rules mean what they did as `<root> { <css> }`, and the specificity is the
 *  same (`:scope` counts as the class it replaces, `[data-node]` stays). The
 *  `@scope` is what keeps it inside: plain nesting let `:root:has(&) x`,
 *  `:not(&) x` or `& ~ x` style the studio around a preview (GAP-246); a
 *  scoped rule only matches elements inside its root. A block whose braces
 *  do not balance is left out whole. */
export function scopedCss(siteCss: string, home: PuckData | null = null): string {
  const blocks: string[] = [];
  const add = (root: string, attr: string, css: unknown) => {
    if (typeof css !== "string" || css.trim() === "" || !bracesBalanced(css)) return;
    blocks.push(`@scope (${root}${attr}) {\n:scope${attr} {\n${sanitizeSiteCss(css)}\n}\n}`);
  };
  add(SITE_SCOPE, "", siteCss);
  if (home) walkHome(home, (component) => {
    const id = component.props.id;
    if (typeof id === "string" && NODE_ID.test(id)) add(`${SITE_SCOPE} `, `[data-node="${id}"]`, component.props.css);
  });
  return blocks.join("\n");
}
