// SVG sanitation -- a pure string function, no DB, no fetch.
//
// Uploaded/published SVGs are served (routes/media.ts) and embedded (published
// sites) with Content-Type: image/svg+xml, which the browser treats as an
// active document: inline <script>, on* handlers, <foreignObject> (arbitrary
// HTML), SMIL <set>/<animate> retargeting an attribute at a javascript: URL,
// external <use>/<image> refs and CSS url() are all stored-XSS / data-exfil vectors.
//
// Default-deny: the text is tokenized once and *rebuilt* from what is allowed --
// elements from SVG_ELEMENTS, attributes that pass attributeValue(), text with
// its entities decoded and escaped again. Nothing of the original markup is
// echoed, so an HTML parser and an XML parser read the output the same way and
// the result is a fixed point (sanitizeSvg(sanitizeSvg(x)) === sanitizeSvg(x)).
// One pass, linear time.

/** Drawing elements that stay. Anything else (script, foreignObject, set, animate*, a prefixed
 *  name, meta/base, unknown) is dropped together with its content; names are case-sensitive, as in XML. */
const SVG_ELEMENTS = new Set([
  "svg", "g", "defs", "symbol", "use", "switch", "a", "view",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "image",
  "text", "tspan", "textPath", "title", "desc", "style",
  "linearGradient", "radialGradient", "stop", "pattern", "clipPath", "mask", "marker", "filter",
  "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix", "feDiffuseLighting",
  "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR",
  "feGaussianBlur", "feImage", "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight",
  "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence",
]);

/** Elements whose children are text only. An HTML parser reads title/desc as an HTML integration point,
 *  so a child element there would be parsed as HTML; a <style> holds CSS, checked as one piece. */
const TEXT_ONLY = new Set(["title", "desc", "style"]);

const VOID_FREE_NAME = /^[A-Za-z_][\w.:-]*$/;
const NAMESPACES: Record<string, string> = { xmlns: "http://www.w3.org/2000/svg", "xmlns:xlink": "http://www.w3.org/1999/xlink" };

/** Control characters XML does not allow (tab, LF, CR are fine). */
const XML_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g;
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** True if the text declares a DOCTYPE or an ENTITY. An internal entity can
 *  expand to `<script>` in an XML parser, so such a file is refused
 *  (services/media.ts) rather than cleaned. Case-insensitive, tolerant of
 *  whitespace and NUL/control padding inside the `<!`. */
export function hasXmlDeclarations(raw: string): boolean {
  return /<[\s\x00]*!\s*(?:doctype|entity)\b/i.test(raw);
}

/** `&amp; &lt; &gt; &quot; &apos;` and numeric references decoded; any other `&name;` stays literal text
 *  (an undefined entity is a parse error in XML and a character in HTML: not something to pass on). */
function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|([a-z]+));/gi, (whole, hex?: string, dec?: string, name?: string) => {
    if (name !== undefined) return NAMED_ENTITIES[name] ?? whole;
    const code = hex !== undefined ? parseInt(hex, 16) : parseInt(dec as string, 10);
    const ok = code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) && code !== 0xfffe && code !== 0xffff);
    return ok ? String.fromCodePoint(code) : "";
  });
}

const escapeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, "&quot;");

/** CSS with its escapes resolved, the way a CSS parser reads an identifier (`u\72l(` is `url(`). */
function cssUnescape(css: string): string {
  return css.replace(/\\(?:([0-9a-f]{1,6})[ \t\n\r\f]?|([\s\S]))/gi, (_m, hex?: string, ch?: string) => {
    if (ch !== undefined) return ch;
    const code = parseInt(hex as string, 16);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "�";
  });
}

/** Characters a CSS or URL parser skips, drops or reads as padding, so they must not decide what a reference is:
 *  controls, format characters (BOM, zero-width, bidi), and every Unicode space. */
const IGNORABLE = /[\p{Cc}\p{Cf}\p{Z}\ufeff\u180e]/gu;

/** The only form of `url(...)` that stays: optional ASCII blanks and one pair of quotes around `#id`, `id` drawn
 *  from a narrow set. Anything else inside the parentheses (a BOM, a path, `//host`) fails, instead of being skipped. */
const LOCAL_URL = /url\([ \t\n\r\f]*(["']?)#[A-Za-z0-9_.:-]+\1[ \t\n\r\f]*\)/gi;

/** CSS (a style attribute or element, or a presentation attribute) may point only into the document: every
 *  `url(` is a local fragment, and no @import, other fetching function, `javascript:` or legacy script hook.
 *  Judged on the unescaped text (`u\72l(`, `\23`) with and without comments, and keywords on a text with
 *  ignorable characters removed, so none of them can hide a keyword or a reference. */
function cssIsInert(value: string): boolean {
  const unescaped = cssUnescape(value);
  for (const css of [unescaped, unescaped.replace(/\/\*[\s\S]*?\*\//g, "")]) {
    const bare = css.replace(IGNORABLE, "");
    if (/@import|image-set\(|image\(|src\(|element\(|expression\(|-moz-binding|behavior:|javascript:|vbscript:/i.test(bare)) return false;
    if (/url\(/i.test(css.replace(LOCAL_URL, "")) || /url\(/i.test(bare.replace(LOCAL_URL, ""))) return false;
  }
  return true;
}

/** The only references that stay: same document (`#id`) and root-relative (`/path`). Anything with a scheme,
 *  protocol-relative (`//host`, `/\host`, `\\host`) or merely relative is dropped. Ignorable characters
 *  (controls, BOM, zero-width, spaces) are removed first, as a URL parser does. */
function referenceIsInert(value: string): boolean {
  const url = value.replace(IGNORABLE, "").replace(/\\/g, "/");
  return url === "" || url.startsWith("#") || (url.startsWith("/") && !url.startsWith("//"));
}

/** The attribute as it is written out, or null when it is dropped. */
function attributeText(name: string, rawValue: string): string | null {
  if (!VOID_FREE_NAME.test(name)) return null;
  const lower = name.toLowerCase();
  if (lower in NAMESPACES) return decodeEntities(rawValue).trim() === NAMESPACES[lower] ? `${lower}="${NAMESPACES[lower]}"` : null;
  if (lower.startsWith("xmlns") || lower === "xml:base" || /^on/.test(lower)) return null;
  const value = decodeEntities(rawValue).replace(XML_CONTROL, "");
  const local = lower.slice(lower.lastIndexOf(":") + 1);
  if ((local === "href" || local === "src") && !referenceIsInert(value)) return null;
  if (!cssIsInert(value) || /javascript:/i.test(value.replace(IGNORABLE, ""))) return null;
  return `${name}="${escapeAttr(value)}"`;
}

interface OpenTag { name: string; selfClosing: boolean; attributes: string[]; end: number }

/** An attribute quote with no closing partner: nothing after it can be read as markup, so the rest is dropped
 *  (and the scan stays linear: it would otherwise be repeated from every later `<`). */
const UNTERMINATED = Symbol("unterminated");

/** The start tag at `i` (`s[i] === "<"`, a name start follows), or null when it is not well formed
 *  (junk after the name or no `>`): the caller drops the `<` and what it reads of it. */
function readOpenTag(s: string, i: number): OpenTag | typeof UNTERMINATED | null {
  let p = i + 1;
  const nameEnd = /[\s/>]/.exec(s.slice(p, p + 256));
  const nameLen = nameEnd ? nameEnd.index : Math.min(256, s.length - p);
  const name = s.slice(p, p + nameLen);
  if (!VOID_FREE_NAME.test(name) || !nameEnd) return null;
  p += nameLen;
  const attributes: string[] = [];
  const seen = new Set<string>();
  let selfClosing = false;
  while (p < s.length) {
    const c = s[p]!;
    if (c === ">") return { name, selfClosing, attributes, end: p + 1 };
    if (c === "/" ) { selfClosing = true; p++; continue; }
    if (/\s/.test(c)) { p++; continue; }
    selfClosing = false;
    let q = p;
    while (q < s.length && !/[\s/>=]/.test(s[q]!)) q++;
    if (q === p) { p++; continue; } // a stray `=`
    const attrName = s.slice(p, q);
    p = q;
    while (p < s.length && /\s/.test(s[p]!)) p++;
    let value = "";
    if (s[p] === "=") {
      p++;
      while (p < s.length && /\s/.test(s[p]!)) p++;
      const quote = s[p];
      if (quote === '"' || quote === "'") {
        const close = s.indexOf(quote, p + 1);
        if (close < 0) return UNTERMINATED;
        value = s.slice(p + 1, close);
        p = close + 1;
      } else {
        q = p;
        while (q < s.length && !/[\s>]/.test(s[q]!)) q++;
        value = s.slice(p, q);
        p = q;
      }
    }
    const key = attrName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const text = attributeText(attrName, value);
    if (text !== null) attributes.push(text);
  }
  return null;
}

/** The SVG rebuilt from its allowed parts; "" for a file that declares a DOCTYPE / ENTITY. */
export function sanitizeSvg(raw: string): string {
  if (hasXmlDeclarations(raw)) return "";
  const s = raw.replace(XML_CONTROL, "");
  const out: string[] = [];
  const open: string[] = []; // kept elements, innermost last
  let skipName: string | null = null; // inside a dropped element: its name and nesting depth
  let skipDepth = 0;
  let css = ""; // text of the <style> being read, checked whole when it closes

  const text = (t: string, literal: boolean) => {
    if (skipName !== null || t === "") return;
    const value = literal ? t : decodeEntities(t);
    if (open[open.length - 1] === "style") css += value; else out.push(escapeText(value));
  };
  const closeTop = () => {
    const name = open.pop()!;
    if (name === "style") {
      if (cssIsInert(css)) out.push(escapeText(css));
      css = "";
    }
    out.push(`</${name}>`);
  };

  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) { text(s.slice(i), false); break; }
    if (lt > i) text(s.slice(i, lt), false);
    i = lt;
    if (s.startsWith("<!--", i)) {
      const end = s.indexOf("-->", i + 4);
      i = end < 0 ? s.length : end + 3;
    } else if (s.startsWith("<![CDATA[", i)) {
      const end = s.indexOf("]]>", i + 9);
      text(s.slice(i + 9, end < 0 ? s.length : end), true);
      i = end < 0 ? s.length : end + 3;
    } else if (s[i + 1] === "!" || s[i + 1] === "?") {
      const end = s.indexOf(">", i);
      i = end < 0 ? s.length : end + 1;
    } else if (s[i + 1] === "/") {
      const end = s.indexOf(">", i);
      const name = end < 0 ? "" : s.slice(i + 2, end).trim();
      i = end < 0 ? s.length : end + 1;
      if (skipName !== null) {
        if (name === skipName && --skipDepth === 0) skipName = null;
      } else {
        const at = open.lastIndexOf(name);
        if (at >= 0) while (open.length > at) closeTop();
      }
    } else if (/[A-Za-z_]/.test(s[i + 1] ?? "")) {
      const tag = readOpenTag(s, i);
      if (tag === UNTERMINATED) break;
      if (tag === null) {
        const end = s.indexOf(">", i);
        i = end < 0 ? s.length : end + 1;
        continue;
      }
      i = tag.end;
      if (skipName !== null) {
        if (tag.name === skipName && !tag.selfClosing) skipDepth++;
      } else if (!SVG_ELEMENTS.has(tag.name) || TEXT_ONLY.has(open[open.length - 1] ?? "")) {
        // A kept element in a text-only one is not wanted either: only the element it sits in is rebuilt.
        if (!tag.selfClosing && !SVG_ELEMENTS.has(tag.name)) { skipName = tag.name; skipDepth = 1; }
      } else {
        out.push(`<${tag.name}${tag.attributes.map((a) => " " + a).join("")}${tag.selfClosing ? "/" : ""}>`);
        if (!tag.selfClosing) open.push(tag.name);
      }
    } else {
      text("<", true); // a lone `<`
      i++;
    }
  }
  while (open.length > 0) closeTop();
  return out.join("");
}
