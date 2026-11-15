// Reads rendered HTML or SVG the way a browser does and lists what must never
// be in sanitized output. Used by the fuzz tests of this package and of the
// backend (which imports it by path, as it does linearTiming.testing.ts);
// excluded from the package build (tsconfig.json).
//
// Parsing uses rehype-raw (parse5, the HTML5 tree builder), so an attribute or
// tag a browser would see is seen here too, whatever the source looked like.

import { unified } from "unified";
import rehypeRaw from "rehype-raw";
import { visit } from "unist-util-visit";
import type { Element, Root } from "hast";
import { isAllowedEmbedSrc } from "../mediaEmbed.js";

const FORBIDDEN_ELEMENTS = new Set(["script", "style", "base", "meta", "form", "object", "embed", "link", "applet", "frame", "frameset", "noscript"]);
const URL_ATTRIBUTES = new Set(["href", "src", "poster", "xlinkhref", "action", "formaction", "data", "background", "cite", "srcset", "ping", "manifest"]);
// What the URL standard drops from a URL: tab and newlines anywhere (leading controls and spaces are trimmed separately).
const IGNORED_IN_SCHEME = /[\t\n\r]/g;

// Event handler attributes a browser knows (an unknown `onfoo` does nothing).
const EVENT_HANDLER = /^on(?:load|error|click|dblclick|mouse\w+|key\w+|focus\w*|blur|begin|end|repeat|activate|animation\w+|toggle|wheel|pointer\w+|touch\w+|input|change|submit|reset|scroll|resize|unload|abort|copy|cut|paste|drag\w*|drop|select|show|message|hashchange|popstate|beforeunload|contextmenu|transition\w+|play|pause|ended|loadeddata|loadedmetadata|canplay|timeupdate|volumechange|invalid|search|auxclick|formdata|cancel|close|beforeinput|afterprint|beforeprint|online|offline|storage|pageshow|pagehide|readystatechange|waiting)$/;

const schemeText = (value: string) => value.replace(IGNORED_IN_SCHEME, "").replace(/^[\u0000-\u0020]+/, "");

const reparser = unified().use(rehypeRaw);

/** The tree a browser builds for `markup`. parse5 itself throws on two lone low
 *  surrogates in a row (RangeError: Invalid code point): not what is under test,
 *  so such text is checked by its raw-text rules only. */
function reparse(markup: string): Root | null {
  try { return reparser.runSync({ type: "root", children: [{ type: "raw", value: markup }] } as unknown as Root) as Root; } catch { return null; }
}

/** "embed-allowlist": src must pass isAllowedEmbedSrc (what a renderer shows).
 *  "ignore": the sanitize schema cannot gate iframe hosts (scheme only), so a
 *  profile whose renderers gate them is not checked here (see the findings in
 *  markdownPipeline.fuzz.test.ts). */
export type IframePolicy = "embed-allowlist" | "ignore";

/** Everything wrong with `html`, one line per problem; empty when clean.
 *  Besides the DOM check, the markup outside attribute values may not contain
 *  `<script` or `<style` at all (text is escaped, so a literal one is never
 *  legitimate; inside a quoted attribute, e.g. KaTeX's error `title`, a `<` is inert). */
export function htmlHazards(html: string, iframe: IframePolicy): string[] {
  const found: string[] = [];
  const lower = html.replace(/="[^"]*"/g, '=""').toLowerCase();
  for (const tag of ["script", "style"]) if (new RegExp(`<${tag}(?=[\\s/>])[^>]*>`).test(lower)) found.push(`raw text contains <${tag}`);

  const tree = reparse(html);
  if (!tree) return found;
  visit(tree, "element", (el: Element) => {
    const tag = el.tagName.toLowerCase();
    if (FORBIDDEN_ELEMENTS.has(tag)) found.push(`<${tag}> element`);
    for (const [name, raw] of Object.entries(el.properties ?? {})) {
      const key = name.toLowerCase();
      if (EVENT_HANDLER.test(key)) found.push(`<${tag}> ${name} handler`);
      if (!URL_ATTRIBUTES.has(key)) continue;
      for (const value of Array.isArray(raw) ? raw : [raw]) {
        if (typeof value !== "string") continue;
        const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(schemeText(value))?.[1]?.toLowerCase();
        if (scheme === "javascript" || scheme === "vbscript") found.push(`<${tag}> ${name} ${scheme}: URL`);
        if (scheme === "data" && !/^data:(?:image|audio|video)\//i.test(schemeText(value))) found.push(`<${tag}> ${name} non-media data: URL`);
      }
    }
    if (tag === "iframe") {
      const src = el.properties?.src;
      // No src (the sanitizer dropped an invalid one) is an empty frame; srcdoc is never allowed.
      if (el.properties?.srcDoc !== undefined || el.properties?.srcdoc !== undefined) found.push("<iframe> srcdoc");
      if (iframe === "ignore" || typeof src !== "string" || src.trim() === "") return;
      if (!isAllowedEmbedSrc(src)) found.push("<iframe> src outside the embed allowlist");
    }
  });
  return found;
}

// ── SVG ─────────────────────────────────────────────────────────────────────

const SVG_FORBIDDEN_ELEMENTS = new Set([
  "script", "foreignobject", "set", "animate", "animatemotion", "animatetransform", "handler", "listener",
]);
// Attributes whose value is an address the browser may fetch or follow.
const REFERENCE_ATTRIBUTES = new Set(["href", "xlinkhref", "src"]);
const EXTERNAL_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)(?!\s*$)/i;
const CSS_REFERENCE_ATTRIBUTES = new Set(["style", "fill", "stroke", "filter", "clip-path", "mask", "marker-start", "marker-mid", "marker-end", "cursor"]);
const EXTERNAL_CSS_URL = /\burl\(\s*["']?(?!#)/i;

/** What an SVG that will be served as image/svg+xml (or inlined) must not
 *  hold: script and scripting elements, event handlers, references to
 *  anything outside the document, and a DOCTYPE/ENTITY declaration (an entity
 *  can rebuild any of the rest after a text filter has looked). `xmlns*`
 *  attributes name a namespace and fetch nothing. */
export function svgHazards(svg: string): string[] {
  const found: string[] = [];
  const lower = svg.toLowerCase();
  for (const needle of ["<!doctype", "<!entity", "<!element", "<!attlist"]) {
    if (lower.includes(needle)) found.push(`text contains ${needle}`);
  }
  if (/<script(?=[\s/>])[^>]*>/.test(lower)) found.push("text contains <script");
  const tree = reparse(svg);
  if (!tree) return found;
  visit(tree, "element", (el: Element) => {
    // `prefix:script` is the script element when the prefix names the SVG namespace; a name that is not a
    // well-formed prefixed name (`<::script>`, `<a=b:script>`) is not an element an XML parser would accept.
    const tag = (/^(?:[a-z_][\w.-]*:)?([a-z]+)$/i.exec(el.tagName)?.[1] ?? el.tagName).toLowerCase();
    if (SVG_FORBIDDEN_ELEMENTS.has(tag)) found.push(`<${tag}> element`);
    if (tag === "style") {
      const css = (el.children ?? []).map((c) => ("value" in c ? String(c.value) : "")).join("");
      if (/@import/i.test(css) || EXTERNAL_CSS_URL.test(css)) found.push("<style> with an external reference");
    }
    for (const [name, raw] of Object.entries(el.properties ?? {})) {
      const key = name.toLowerCase();
      if (EVENT_HANDLER.test(key) && String(raw ?? "").trim() !== "") found.push(`<${tag}> ${name} handler`);
      if (key.includes("xmlns")) continue; // a namespace declaration names a namespace, it fetches nothing
      for (const value of Array.isArray(raw) ? raw : [raw]) {
        if (typeof value !== "string") continue;
        const text = schemeText(value);
        if (REFERENCE_ATTRIBUTES.has(key)) {
          if (EXTERNAL_URL.test(text)) found.push(`<${tag}> ${name} external reference`);
          if (/^(?:javascript|vbscript|data):/i.test(text)) found.push(`<${tag}> ${name} script/data URL`);
        } else if (CSS_REFERENCE_ATTRIBUTES.has(key) && EXTERNAL_CSS_URL.test(text)) found.push(`<${tag}> ${name} external reference`);
      }
    }
  });
  return found;
}
