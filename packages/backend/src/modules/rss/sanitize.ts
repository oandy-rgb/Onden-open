// Feed-content sanitation — pure string functions, no DB, no fetch.
//
// Feed item bodies arrive as untrusted HTML. The stored markdown may carry
// inline HTML (the reader renders it through MarkdownRenderer's raw path,
// which ALSO runs rehype-sanitize — defense in depth), but we strip the
// actively dangerous constructs server-side so the stored body is never a
// payload: <script>/<style>/<iframe> blocks, HTML comments, on* attribute
// handlers and javascript: URLs. Same aggressive-regex posture as the SVG
// sanitizer in routes/media.ts — false positives lose decoration, false
// negatives execute code.

import { pickArticleHtml, type ExtractOptions } from "./articleExtract.js";
import { cutToUnits, decodeHtmlEntities, toEmbedUrl, urlScheme } from "@onden/markdown";

export function sanitizeFeedHtml(html: string): string {
  let out = keepVideoEmbeds(endWithoutUnfinishedTag(html));
  // <script …>…</script> and the like go whole; one with no closing tag stays (its closing tag is looked for once per name).
  out = replaceTagBlocks(out, /<\s*(script|style|iframe|object|embed|form)/gi, "closed", () => "");
  // <script … /> and the like.
  out = replaceTagBlocks(out, /<\s*(script|iframe|object|embed)/gi, "self-closed", () => "");
  return withoutComments(out)
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*javascript\s*:[^"']*\2/gi, "")
    .replace(/javascript\s*:/gi, "")
    // Again at the end: a rule above that removed the page's last tags can leave a "<" after the new last ">" (cleaning a
    // cleaned body would then change it, and a stored body ending in "<…" makes htmlToText scan to the end per "<").
    .replace(/[\s\S]*/, endWithoutUnfinishedTag)
    .trim();
}

// Linear time on unfinished markup (2026-11-24, rssSanitize.property.test.ts): written as regular expressions, each rule below
// scanned from every opening "<tag" to the end of the page looking for a ">" or a closing tag, so 100 KB of "<script " or
// "<img " took seconds on the server. Two things make every rule one pass:
//  - endWithoutUnfinishedTag: after the page's last ">" no "<" can start a tag that ends;
//  - replaceTagBlocks: openers that share one ">" find it once, and a closing tag that is not there is looked for once.

/** After the page's last ">", no "<" can start a tag that ends: a browser drops such a tag at the end of the page. Done once at
 *  the entry: an unfinished comment there goes (it hides the rest of the page in a browser too), any other "<" there becomes
 *  the text "&lt;". */
export function endWithoutUnfinishedTag(html: string): string {
  const last = html.lastIndexOf(">");
  let tail = html.slice(last + 1);
  if (!tail.includes("<")) return html;
  const comment = tail.indexOf("<!--");
  if (comment >= 0) tail = tail.slice(0, comment);
  return html.slice(0, last + 1) + tail.replace(/</g, "&lt;");
}

/**
 * Each `opener` match ("<script", "<iframe"…, group 1 = the name), up to the first ">" after it, is one opening tag; `replace`
 * gets the whole block and the tag's attributes.
 *  - "closed": the block runs to the first matching closing tag (`< / name >`); with none, nothing is replaced.
 *  - "closed-or-alone": the same, and with no closing tag the opening tag alone is the block.
 *  - "self-closed": only a tag ending in "/>" is a block, the tag alone.
 * The same blocks the regular expression `<\s*(name)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>` (and its two variants) finds, in one pass.
 */
function replaceTagBlocks(html: string, opener: RegExp, kind: "closed" | "closed-or-alone" | "self-closed",
  replace: (whole: string, attrs: string) => string): string {
  let gtFrom = -1;
  let gtAt = -1;
  /** The first ">" at or after `at`; openers that share one ">" do not each search for it. */
  const nextGt = (at: number) => {
    if (gtFrom < 0 || at < gtFrom || (gtAt >= 0 && at > gtAt)) { gtFrom = at; gtAt = html.indexOf(">", at); }
    return gtAt;
  };
  const noCloseFrom = new Map<string, number>(); // a closing tag looked for from here on was not there
  const closeAfter = (name: string, at: number): [number, number] | null => {
    const none = noCloseFrom.get(name);
    if (none !== undefined && at >= none) return null;
    const re = new RegExp(`<\\s*\\/\\s*${name}\\s*>`, "gi");
    re.lastIndex = at;
    const m = re.exec(html);
    if (!m) { noCloseFrom.set(name, at); return null; }
    return [m.index, m.index + m[0].length];
  };
  let out = "";
  let done = 0;
  opener.lastIndex = 0;
  for (let m = opener.exec(html); m; m = opener.exec(html)) {
    const nameEnd = m.index + m[0].length;
    const gt = nextGt(nameEnd);
    if (gt < 0) break; // no ">" after this opener, nor after any later one
    let end = -1;
    if (kind === "self-closed") {
      let k = gt - 1;
      while (k >= nameEnd && /\s/.test(html[k])) k--;
      if (k >= nameEnd && html[k] === "/") end = gt + 1;
    } else {
      const close = closeAfter(m[1].toLowerCase(), gt + 1);
      end = close ? close[1] : kind === "closed-or-alone" ? gt + 1 : -1;
    }
    if (end < 0) { opener.lastIndex = m.index + 1; continue; }
    out += html.slice(done, m.index) + replace(html.slice(m.index, end), html.slice(nameEnd, gt));
    done = end;
    opener.lastIndex = end;
  }
  return out + html.slice(done);
}

/** HTML comments go. Only up to the page's last "-->": after it no "<!--" can end, and a search from each one would run to the
 *  end of the page; such a "<!--" is left as it is. */
function withoutComments(html: string): string {
  const last = html.lastIndexOf("-->");
  if (last < 0) return html;
  return html.slice(0, last + 3).replace(/<!--[\s\S]*?-->/g, "") + html.slice(last + 3);
}

/** A YouTube / Vimeo player (<iframe>) would be stripped with every other
 *  iframe below: keep it as a bare link to the player instead. The reader
 *  and a saved note both show a bare YouTube/Vimeo link as the video
 *  (sandboxed, trusted hosts only — MarkdownRenderer); any other iframe
 *  still goes. */
function keepVideoEmbeds(html: string): string {
  return replaceTagBlocks(html, /<\s*(iframe)\b/gi, "closed-or-alone", (whole, attrs) => {
    const src = /(?<![-\w])(?:data-)?src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(attrs);
    const embed = toEmbedUrl(decodeHtmlEntities(src?.[1] ?? src?.[2] ?? src?.[3] ?? ""));
    return embed ? `<p><a href="${embed}">${embed}</a></p>` : whole;
  });
}

// An attribute value: "double", 'single' or unquoted — minified pages
// (Docusaurus, Astro…) write `src=/assets/a.png` with no quotes at all.
const VALUE = `("([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`;

// "載入全文" — heuristic readability extraction without pulling jsdom/Readability as dependencies (same trade-off
// bookmark.ts documents for its OG-tag regexes; articleExtract.ts is the pure string scanner and the rules). A
// dependency would have to be pure JS, run in the browser build and fit the bundle guards — the scanner is ~300
// lines and the page furniture rules need site-specific class names no readability library knows either.
// Anything weirder yields a shorter article, which is still useful.
//   title     — the item's title: a heading that only repeats it is dropped.
//   floorText — what the reader already has (the feed's own text): the result is never shorter than it, unless the
//               page has nothing wider.
export function extractArticleHtml(html: string, pageUrl?: string, opts: ExtractOptions = {}): string {
  let body = endWithoutUnfinishedTag(pickArticleHtml(html, { ...opts, pageUrl }));

  // Lazy-loaded images: promote data-src to src when the tag has no real src
  // (or only a placeholder) — the page's JS would have done this, but the
  // reader renders static HTML.
  body = body.replace(/<img\b[^>]*>/gi, (tag) => {
    const dataSrc = new RegExp(`\\bdata-(?:src|lazy-src|original)\\s*=\\s*${VALUE}`, "i").exec(tag);
    if (!dataSrc) return tag;
    const lazy = dataSrc[2] ?? dataSrc[3] ?? dataSrc[4] ?? "";
    // (?<![-\w]) — "data-src" must not read as "src" (a dash IS a \b).
    const src = new RegExp(`(?<![-\\w])src\\s*=\\s*${VALUE}`, "i").exec(tag);
    const current = src?.[2] ?? src?.[3] ?? src?.[4] ?? "";
    // A real src wins; a missing one — or a 1px/data-URI placeholder — loses.
    const placeholder = current === "" || current.startsWith("data:image/gif") || /1x1|blank|placeholder|spacer/i.test(current);
    if (!placeholder || !lazy) return tag;
    return src ? tag.replace(src[0], `src="${lazy}"`) : tag.replace(/<img\b/i, `<img src="${lazy}"`);
  });

  body = absolutizeUrls(body, pageUrl);

  return sanitizeFeedHtml(body);
}

/** Relative media/link URLs (`src`, `href`, `srcset`) resolved against the
 *  ARTICLE's address, not ours: rendered inside the reader they would load
 *  from Onden's own host and fail (a podcast's `<audio src="/assets/…mp3">`
 *  played 0:00). No `pageUrl` → unchanged. */
export function absolutizeUrls(body: string, pageUrl?: string | null): string {
  if (!pageUrl) return body;
  body = body.replace(
    new RegExp(`(?<![-\\w])(src|href)\\s*=\\s*${VALUE}`, "gi"),
    (whole, attr: string, _q: string, dq?: string, sq?: string, bare?: string) => {
      const value = dq ?? sq ?? bare ?? "";
      if (!value || value.startsWith("#") || urlScheme(value) !== undefined) return whole;
      try {
        return `${attr}="${new URL(value, pageUrl).href}"`;
      } catch {
        return whole;
      }
    },
  );
  // srcset carries comma-separated "url descriptor" pairs.
  return body.replace(new RegExp(`(?<![-\\w])srcset\\s*=\\s*${VALUE}`, "gi"), (whole, _q: string, dq?: string, sq?: string, bare?: string) => {
    const value = dq ?? sq ?? bare ?? "";
    if (!value) return whole;
    const rewritten = value.split(",").map((part) => {
      const [u, ...desc] = part.trim().split(/\s+/);
      if (!u || urlScheme(u) !== undefined) return part.trim();
      try {
        return [new URL(u, pageUrl).href, ...desc].join(" ");
      } catch {
        return part.trim();
      }
    }).join(", ");
    return `srcset="${rewritten}"`;
  });
}

/** Plain-text preview of an HTML fragment (titles, sample lines). */
export function htmlToText(html: string, max = 300): string {
  const text = decodeHtmlEntities(endWithoutUnfinishedTag(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return cutToUnits(text, max);
}
