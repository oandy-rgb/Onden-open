// "載入全文": pick the article out of a page and leave the page's own furniture behind.
//
// Pure string functions (this also runs in the browser build): no DOM, no readability library. The one structural
// tool is `scanElements` — a single linear tag scanner that knows which close tag belongs to which open tag, so nested
// <div>s are matched by balance instead of "the first </div>" (what the old regexes did). Picking the container and
// dropping the furniture both work on the element list it returns and cut the page by index ranges.
//
// Posture: conservative. Every drop rule needs a clear signal (a tag, a class/id/role token, or "a short meta line in
// the lead of the article"); when in doubt the text stays. Nothing here may throw or go quadratic on a hostile page.

import { decodeHtmlEntities } from "@onden/markdown";

export interface El {
  /** Position in the list `scanElements` returned. */
  i: number;
  name: string;
  /** Raw attribute text of the open tag. */
  attrs: string;
  start: number;
  /** Index just after the open tag. */
  innerStart: number;
  /** Index of the close tag (== innerStart for void elements; == html.length when never closed). */
  innerEnd: number;
  /** Index just after the close tag. */
  end: number;
  parent: number;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title"]);
// A page this deep or this large in tags is not an article page; stop scanning rather than grow without bound.
const MAX_ELEMENTS = 400_000;

/** One pass over the page: every element with its matching close. Tolerates unbalanced markup (a stray close tag is
 *  ignored, an unclosed element ends where its parent closes) and never backtracks over the input. */
export function scanElements(html: string): El[] {
  const lower = html.toLowerCase();
  const els: El[] = [];
  const open: number[] = [];                       // stack of indices into els
  const openCount = new Map<string, number>();     // open elements per name: O(1) "is there anything to close?"
  const quoteGone = { '"': false, "'": false };    // a quote with no partner anywhere after: stop searching for it
  let i = 0;
  const n = html.length;
  /** Close every open element from stack position `to` up. Those above `to` were never closed (they end where
   *  their parent does); the one at `to` ends with its own close tag, `tagEnd`. */
  const closeTo = (to: number, at: number, tagEnd: number) => {
    while (open.length > to) {
      const el = els[open.pop()!];
      el.innerEnd = at;
      el.end = open.length === to ? tagEnd : at;
      openCount.set(el.name, (openCount.get(el.name) ?? 1) - 1);
    }
  };
  while (i < n && els.length < MAX_ELEMENTS) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      const e = html.indexOf("-->", lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    const c = html.charCodeAt(lt + 1);
    const closing = c === 47; // "/"
    const nameStart = lt + (closing ? 2 : 1);
    let j = nameStart;
    while (j < n && /[A-Za-z0-9:-]/.test(html[j])) j++;
    if (j === nameStart || !/[A-Za-z]/.test(html[nameStart])) { i = lt + 1; continue; }
    const name = lower.slice(nameStart, j);
    // Find the closing ">" while skipping quoted attribute values.
    let k = j;
    let found = false;
    while (k < n) {
      const ch = html[k];
      if (ch === ">") { found = true; break; }
      if ((ch === '"' || ch === "'") && !quoteGone[ch]) {
        const e = html.indexOf(ch, k + 1);
        if (e < 0) quoteGone[ch] = true; else { k = e + 1; continue; }
      }
      k++;
    }
    if (!found) break;
    const tagEnd = k + 1;
    if (closing) {
      if ((openCount.get(name) ?? 0) > 0) {
        let top = open.length - 1;
        while (els[open[top]].name !== name) top--;
        closeTo(top, lt, tagEnd);
      }
      i = tagEnd;
      continue;
    }
    const selfClosed = html[tagEnd - 2] === "/";
    const el: El = { i: els.length, name, attrs: html.slice(j, tagEnd - 1), start: lt, innerStart: tagEnd, innerEnd: tagEnd, end: tagEnd, parent: open.length ? open[open.length - 1] : -1 };
    els.push(el);
    i = tagEnd;
    if (VOID.has(name) || selfClosed) continue;
    if (RAW.has(name)) {
      const e = lower.indexOf(`</${name}`, tagEnd);
      if (e < 0) { el.innerEnd = n; el.end = n; i = n; continue; }
      const gt = html.indexOf(">", e);
      el.innerEnd = e;
      el.end = gt < 0 ? n : gt + 1;
      i = el.end;
      continue;
    }
    el.innerEnd = n;
    el.end = n;
    open.push(els.length - 1);
    openCount.set(name, (openCount.get(name) ?? 0) + 1);
  }
  return els;
}

// ── attributes ────────────────────────────────────────────────────────────

const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

export function attrsOf(el: El): Map<string, string> {
  const out = new Map<string, string>();
  if (el.attrs.length > 20_000) return out;
  for (const m of el.attrs.matchAll(ATTR)) {
    const key = m[1].toLowerCase();
    if (!out.has(key)) out.set(key, decodeHtmlEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return out;
}

/** class tokens and the id, lower-cased: what the name-based rules look at. */
function tokensOf(a: Map<string, string>): string[] {
  const tokens = (a.get("class") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const id = a.get("id")?.toLowerCase();
  if (id) tokens.push(id);
  return tokens;
}

// ── text ──────────────────────────────────────────────────────────────────

const SKIP_TEXT = new Set(["script", "style", "textarea", "title", "svg", "noscript", "template"]);

/** The page's visible text, built once: `plain` is the text with every tag (and script/style/svg body) removed,
 *  `at[p]` maps a position in the HTML to a position in `plain`. Any element's text is then a slice, with no
 *  re-scanning of the page. */
class TextIndex {
  readonly plain: string;
  private readonly at: Int32Array;
  private readonly solid: Int32Array;
  constructor(html: string, els: El[]) {
    const skip = new Uint8Array(html.length + 1);
    let until = 0;
    for (const el of els) {
      for (let p = el.start; p < el.innerStart; p++) skip[p] = 1;
      for (let p = el.innerEnd; p < el.end; p++) skip[p] = 1;
      if (SKIP_TEXT.has(el.name) && el.start >= until) { for (let p = el.innerStart; p < el.innerEnd; p++) skip[p] = 1; until = el.end; }
    }
    const out: string[] = [];
    this.at = new Int32Array(html.length + 1);
    let plainLen = 0;
    let gap = false;
    for (let p = 0; p < html.length; p++) {
      this.at[p] = plainLen;
      if (skip[p]) {
        if (!gap) { out.push(" "); plainLen++; gap = true; }
      } else { out.push(html[p]); plainLen++; gap = false; }
    }
    this.at[html.length] = plainLen;
    this.plain = out.join("");
    this.solid = new Int32Array(plainLen + 1);
    for (let p = 0; p < plainLen; p++) {
      const c = this.plain.charCodeAt(p);
      this.solid[p + 1] = this.solid[p] + (c === 32 || c === 10 || c === 13 || c === 9 || c === 160 ? 0 : 1);
    }
  }
  /** Non-space visible characters between two HTML positions. */
  length(from: number, to: number): number { return this.solid[this.at[to]] - this.solid[this.at[from]]; }
  /** Readable text between two HTML positions, entities decoded, white space collapsed. */
  text(from: number, to: number): string {
    return decodeHtmlEntities(this.plain.slice(this.at[from], this.at[to])).replace(/\s+/g, " ").trim();
  }
}

// ── known containers ──────────────────────────────────────────────────────

// Innermost "this is the article body" markers used by the common themes and generators. Exact class/id tokens.
const CONTENT = new Set([
  "post-content", "post-content-body", "post-body", "post__content", "post-text", "entry-content", "entry__content", "entry-body",
  "article-content", "article__content", "article-body", "article__body", "articlebody", "story-body", "story-content",
  "e-content", "markdown-body", "gh-content", "prose", "content-body", "blog-content", "blog-post-content", "single-content",
  "available-content", "body-markup", "theme-doc-markdown", "markdown", "rich-text", "c-article-body", "page-content-body",
]);

function contains(outer: El, inner: El): boolean { return inner.start >= outer.innerStart && inner.end <= outer.innerEnd && inner !== outer; }

// ── drop rules ────────────────────────────────────────────────────────────

const DROP_TAGS = new Set(["nav", "header", "footer", "aside", "form", "noscript", "svg", "script", "style", "template", "button", "dialog", "select", "input", "textarea", "iframe", "object", "embed"]);
const DROP_ROLES = new Set(["navigation", "banner", "complementary", "contentinfo", "search", "dialog", "alertdialog"]);

// Class/id tokens (whole token, lower-case) of page furniture. Each is a known theme/plugin name; anything
// that merely resembles one ("share-your-story") is kept.
const DROP_TOKEN = new RegExp("^(?:" + [
  // header block with the date / tags / reading time
  "post-header(?:-inline)?", "entry-header", "article-header", "post-head", "post-meta(?:data)?", "entry-meta", "article-meta", "post-info", "entry-info",
  "post-date", "entry-date", "post-categories", "entry-categories", "post-tags", "entry-tags", "post-taxonomies", "tags-links", "cat-links", "tag-links",
  "tags", "categories", "byline", "post-byline", "article-byline", "author-box", "author-bio", "author-info", "author-card", "post-author", "reading-time",
  "read-time", "post-reading-time", "post-stats",
  // share bars, reactions
  "share", "sharing", "share-buttons", "share-bar", "share-links", "social-share", "social-sharing", "social-links", "social-buttons", "post-share", "sharedaddy", "addtoany_share_save_container", "a2a_kit",
  "post-ufi", "like-button-container",
  // related, previous/next
  "related", "related-posts", "related-articles", "related-content", "yarpp-related", "jp-relatedposts", "more-posts", "read-next", "recommended", "recommended-posts",
  "post-navigation", "post-nav", "post-pagination", "pagination", "nav-links", "nav-previous", "nav-next", "prev-next", "next-prev", "post-nav-links",
  // comments
  "comments", "comments-area", "comment-list", "comment-respond", "comment-form", "respond", "disqus_thread", "giscus", "utterances", "post-comments", "giscus-frame",
  // subscribe boxes, paywall teasers
  "subscribe", "subscribe-widget", "subscription-widget", "subscription-widget-wrap", "subscribe-box", "newsletter", "newsletter-signup", "newsletter-form", "signup-form",
  "email-signup", "mc4wp-form", "captioned-button-wrap", "button-wrapper", "paywall",
  // site-wide banners, ads
  "announcement", "announcement-bar", "announcement-banner", "site-announcement", "site-banner", "promo", "promo-banner", "promotion", "promotional-banner", "event-banner",
  "notice-bar", "top-banner", "banner", "cta", "cta-box", "sponsor", "sponsored", "advert", "advertisement", "ad", "ads", "adsbygoogle", "ad-container",
  // table of contents
  "toc", "toc-container", "post-toc", "table-of-contents", "tableofcontents", "ez-toc-container", "lwptoc", "toc-wrapper",
  // copy buttons
  "copy-link", "copy-button", "clipboard-button", "code-copy",
  // accessibility skip links
  "skip-link", "skip-to-content", "screen-reader-shortcut",
].join("|") + ")$");

// Heading-anchor links. Only on inline elements: Docusaurus also gives the heading itself the class "anchor".
const ANCHOR_TOKEN = /^(?:anchor|header-anchor|heading-anchor|heading-link|hash-link|anchorjs-link|direct-link|permalink)$/;
const INLINE_ANCHORS = new Set(["a", "span", "i"]);

const META_LEAD = /^(?:published|posted|updated|last updated|last modified|date|written|filed under|posted in|categories|category|tags?|reading time|read time|by|發布|發佈|發表|更新|日期|作者|分類|分类|標籤|标签|閱讀時間)\b\s*[:：]?/i;
const META_TIME = /(?:\d[\d,.]*\s*(?:min(?:ute)?s?\b|分鐘|分钟)(?:\s*(?:read|reading|閱讀|阅读))?|(?:about|約|共)?\s*\d[\d,]*\s*(?:words?\b|characters?\b|字)|(?:read|reading) time)/i;
const DATE_TEXT = /(?:\d{4}[-/.年]\s?\d{1,2}[-/.月]\s?\d{1,2}日?|\d{1,2}\s+[A-Za-z]{3,9},?\s+\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})/;

/** A short line that is only about the page (date, reading time, filed-under, byline), not about the topic. */
export function isMetaLine(raw: string): boolean {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text || text.length > 160) return false;
  if (META_LEAD.test(text) && text.length <= 160) {
    // "By the way, …" is a sentence: a byline is a few words with no sentence punctuation.
    if (/^by\b/i.test(text)) return text.length <= 60 && !/[.!?。！？,，]/.test(text) && text.split(" ").length <= 6;
    return true;
  }
  if (META_TIME.test(text) && text.length <= 80) return true;
  const date = DATE_TEXT.exec(text);
  if (date) return text.replace(date[0], "").replace(/[\s·•|,，、:：/\-–—]+/g, " ").trim().length <= 12;
  return false;
}

function normalizeTitle(s: string): string {
  return decodeHtmlEntities(s).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, " ").trim();
}

/** Pieces of a title that may appear as the page's heading: the whole title and, for a page <title> like
 *  "Story | Site", each side of the separator. */
function titleForms(title: string | undefined): string[] {
  if (!title) return [];
  const forms = new Set([normalizeTitle(title)]);
  for (const part of title.split(/\s+[|\-–—·:]+\s+|\s*[|｜]\s*/)) {
    const norm = normalizeTitle(part);
    if (norm.length >= 4) forms.add(norm);
  }
  return [...forms].filter((f) => f.length >= 2);
}

const CAPTION_TOKEN = /^(?:caption|image-caption|img-caption|photo-caption|figure-caption|figcaption|wp-caption-text|caption-text|post-caption)$/;
const HEADING = /^h[1-6]$/;
const ANCHOR_TEXT = /^[#¶§🔗🔖∞]?$/u;

export interface ExtractOptions {
  /** The item's title: a heading that only repeats it is dropped. */
  title?: string;
  /** Visible text of what the reader already has (the feed's own description). The result is never shorter than it
   *  unless the page has nothing wider to offer. */
  floorText?: string;
  /** The page's address: links to its own site count as "more of this site" (end-of-article link lists). */
  pageUrl?: string;
}

interface Cut { from: number; to: number; with?: string }

// Candidate lists are capped: a page with thousands of <article>s is a listing, not an article.
const MAX_CANDIDATES = 40;

/** The article of a page as an HTML fragment (not yet sanitized: sanitation stays with the caller), or "" when
 *  the page has no text at all. */
export function pickArticleHtml(html: string, opts: ExtractOptions = {}): string {
  const els = scanElements(html);
  const text = new TextIndex(html, els);
  const children: number[][] = els.map(() => []);
  const prevSibling: number[] = els.map(() => -1);
  const lastChild = new Map<number, number>();
  for (const e of els) {
    if (e.parent < 0) continue;
    prevSibling[e.i] = lastChild.get(e.parent) ?? -1;
    if (e.name !== "br") lastChild.set(e.parent, e.i); // a <br> between an image and its caption is not "something else"
    children[e.parent].push(e.i);
  }
  const attrCache = new Map<number, Map<string, string>>();
  const attrsAt = (x: number) => { let a = attrCache.get(x); if (!a) { a = attrsOf(els[x]); attrCache.set(x, a); } return a; };
  // <head> is never article. A head with no </head> ends where <body> starts (as a browser would have it).
  const head = els.find((e) => e.name === "head");
  const bodyStart = els.find((e) => e.name === "body")?.start;
  const headEnd = !head ? 0 : head.innerEnd < html.length ? head.end : bodyStart ?? head.innerStart;
  const live = (e: El) => !head || !(e.start >= head.start && e.start < headEnd);

  // Paragraph text under an element (memoised): what a reader calls "the article's text". An element with no <p>
  // counts all its text (some pages write paragraphs as <div>s).
  const paraMemo = new Map<number, number>();
  const paragraphText = (x: number): number => {
    const known = paraMemo.get(x);
    if (known !== undefined) return known;
    let sum = 0;
    const stack = [x];
    while (stack.length) for (const c of children[stack.pop()!]) {
      const e = els[c];
      if (e.name === "p") sum += text.length(e.innerStart, e.innerEnd); else stack.push(c);
    }
    if (sum === 0) sum = text.length(els[x].innerStart, els[x].innerEnd);
    paraMemo.set(x, sum);
    return sum;
  };

  // 1. candidates: the page's own content marker, then <article>, <main>/role=main, then <body>.
  const marked: number[] = [];
  const articles: number[] = [];
  const mains: number[] = [];
  let body = -1;
  for (const e of els) {
    if (!live(e)) continue;
    if (e.name === "body" && body < 0) body = e.i;
    if (e.name === "article") { if (articles.length < MAX_CANDIDATES) articles.push(e.i); continue; }
    const a = attrsAt(e.i);
    if (e.name === "main" || a.get("role")?.toLowerCase() === "main") { if (mains.length < MAX_CANDIDATES) mains.push(e.i); }
    if ((tokensOf(a).some((t) => CONTENT.has(t)) || a.get("itemprop")?.toLowerCase() === "articlebody") && marked.length < MAX_CANDIDATES) marked.push(e.i);
  }
  const best = (list: number[]): number => {
    let top = -1; let topLen = 0;
    for (const x of list) { const len = paragraphText(x); if (len > topLen) { top = x; topLen = len; } }
    return top;
  };
  // Of nested markers prefer the inner one — unless it holds clearly less of the text.
  const innermost = marked.filter((x) => !marked.some((y) => y !== x && contains(els[x], els[y]) && paragraphText(y) >= 0.8 * paragraphText(x)));
  const wide = best(articles) >= 0 ? best(articles) : best(mains);
  let narrow = best(innermost);
  // A marker class on a small box inside the article (a callout called "prose") must not replace the article.
  if (narrow >= 0 && wide >= 0 && contains(els[wide], els[narrow]) && paragraphText(narrow) < 0.4 * paragraphText(wide)) narrow = -1;
  const ladder: number[] = [];
  for (const x of [narrow, wide, body]) if (x >= 0 && !ladder.includes(x)) ladder.push(x);
  if (!ladder.length) ladder.push(-1);

  // 2. the narrowest pick that is not shorter than what the reader already has; else the one with most text.
  const floor = opts.floorText ? opts.floorText.replace(/\s+/g, "").length : 0;
  const forms = titleForms(opts.title);
  let widest: { html: string; len: number } | null = null;
  for (const x of ladder) {
    const out = clean(x);
    const len = out.replace(/<[^>]*>/g, "").replace(/\s+/g, "").length;
    if (len === 0 && !/<(?:img|picture|video|audio)\b/i.test(out)) continue; // a picture-only article is still an article
    if (len >= floor) return out;
    if (!widest || len > widest.len) widest = { html: out, len };
  }
  return widest?.html ?? "";

  /** The inner HTML of element `root` (or the whole page for -1) with the furniture cut out. */
  function clean(root: number): string {
    const from = root >= 0 ? els[root].innerStart : 0;
    const to = root >= 0 ? els[root].innerEnd : html.length;
    const members = els.filter((e) => e.i !== root && e.start >= from && e.end <= to && live(e));
    // The lead of the article: everything before its first paragraph long enough to be body text.
    const firstBody = members.find((e) => e.name === "p" && text.length(e.innerStart, e.innerEnd) >= 40);
    // No such paragraph: the page is too short to tell lead from body, so nothing counts as lead.
    const leadEnd = firstBody ? firstBody.start : from;
    const cuts: Cut[] = [];
    let titleDropped = false;
    let skipUntil = -1;
    for (const e of members) {
      if (e.start < skipUntil) continue;
      const a = attrsAt(e.i);
      const tokens = tokensOf(a);
      const parentName = e.parent >= 0 ? els[e.parent].name : "";
      const cut = (replacement?: string) => { cuts.push({ from: e.start, to: e.end, with: replacement }); skipUntil = e.end; };
      if (DROP_TAGS.has(e.name) || a.has("hidden") || /display\s*:\s*none/i.test(a.get("style") ?? "") || DROP_ROLES.has(a.get("role")?.toLowerCase() ?? "")) { cut(); continue; }
      // A link is only furniture beside a heading ("copy link"); elsewhere a class like "share" on <a> is still a share link.
      if (tokens.some((t) => DROP_TOKEN.test(t) || (INLINE_ANCHORS.has(e.name) && ANCHOR_TOKEN.test(t)))) { cut(); continue; }
      if (e.name === "a" && HEADING.test(parentName) && (a.get("href") ?? "").startsWith("#")
        && ANCHOR_TEXT.test(text.text(e.innerStart, e.innerEnd).replace(/[\u200b-\u200d\ufeff]/g, ""))) { cut(); continue; }
      if (e.start < leadEnd) {
        if (!titleDropped && HEADING.test(e.name) && forms.includes(normalizeTitle(text.text(e.innerStart, e.innerEnd)))) { titleDropped = true; cut(); continue; }
        if (LEAD_BLOCKS.has(e.name) && e.end - e.start < 6000) {
          const t = text.text(e.innerStart, e.innerEnd);
          if (isMetaLine(t)) { cut(); continue; }
          if (PROMO_BLOCKS.has(e.name) && t.length > 0 && t.length < 300 && linkShare(e.i) >= 0.6 && !hasHeadingOrMedia(e.i)) { cut(); continue; }
        }
      }
      if (e.name === "figcaption" || (tokens.some((t) => CAPTION_TOKEN.test(t)) && followsImage(e))) {
        const flat = flatCaption(html.slice(e.innerStart, e.innerEnd));
        cut(flat ? `<figcaption>${flat}</figcaption>` : "");
      }
    }
    cutTailLinks(root, cuts);
    return applyCuts(html, from, to, cuts).trim();
  }

  /** The end of an article is often "previous / next post", "you may also like" and a list of the site's own links.
   *  Walking back from the last block: a block that is almost all links to this site goes, and so does a short
   *  heading (or a "…:" line) right above such blocks. The first block that is real text — or whose links go to
   *  other sites, like a reference list — stops the walk. */
  function cutTailLinks(root: number, cuts: Cut[]): void {
    const merged = mergeCuts(cuts);
    const covered = (e: El) => { // inside an already-cut range?
      let lo = 0; let hi = merged.length - 1;
      while (lo <= hi) { const m = (lo + hi) >> 1; const c = merged[m]; if (e.start < c.from) hi = m - 1; else if (e.start >= c.to) lo = m + 1; else return e.end <= c.to; }
      return false;
    };
    // Step into a lone wrapper (<div class="post-content"><div>…</div></div>) so the walk sees the real blocks.
    let kids = root >= 0 ? children[root] : els.filter((e) => e.parent < 0).map((e) => e.i);
    for (let depth = 0; depth < 8; depth++) {
      const live2 = kids.filter((k) => !covered(els[k]) && (text.length(els[k].start, els[k].end) > 0 || MEDIA.has(els[k].name)));
      if (live2.length !== 1 || MEDIA.has(els[live2[0]].name) || children[live2[0]].length === 0) break;
      kids = children[live2[0]];
    }
    let cutAny = false;
    let headingCut = false;
    for (let x = kids.length - 1; x >= 0; x--) {
      const e = els[kids[x]];
      if (covered(e)) continue;
      const total = text.length(e.start, e.end);
      if (total === 0 && !MEDIA.has(e.name)) continue; // empty wrapper / spacer
      const t = text.text(e.innerStart, e.innerEnd);
      if (isSiteLinkBlock(e.i, t)) { cuts.push({ from: e.start, to: e.end }); cutAny = true; headingCut = false; continue; }
      // a short heading right above cut link blocks ("You may also like…") goes too, then the walk goes on
      if (cutAny && !headingCut && t.length <= 60 && (HEADING.test(e.name) || /[…:：]$|\.{3}$/.test(t))) { cuts.push({ from: e.start, to: e.end }); headingCut = true; continue; }
      break;
    }
  }

  /** A short block whose text is (almost) all links, most of them to this site; or a bare "» Home" breadcrumb. */
  function isSiteLinkBlock(x: number, t: string): boolean {
    if (/^[>»›<«‹←→\s]*(?:home|首頁|上一篇|下一篇|previous post|next post)\b/i.test(t) && t.length < 80) return true;
    if (t.length === 0 || t.length > 800 || linkShare(x) < 0.8) return false;
    let internal = 0; let links = 0;
    const stack = [...children[x]];
    while (stack.length) {
      const c = els[stack.pop()!];
      if (c.name === "a") { links++; if (isSiteHref(attrsAt(c.i).get("href") ?? "")) internal++; } else stack.push(...children[c.i]);
    }
    return links > 0 && internal * 2 >= links;
  }

  function isSiteHref(href: string): boolean {
    if (!href || href.startsWith("#") || href.startsWith("/")) return !href.startsWith("//");
    if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) return true;
    try {
      const host = (u: string) => new URL(u).hostname.replace(/^www\./, "");
      return !!opts.pageUrl && host(href) === host(opts.pageUrl);
    } catch { return false; }
  }

  /** Share of an element's visible text that sits inside links. */
  function linkShare(x: number): number {
    const total = text.length(els[x].innerStart, els[x].innerEnd);
    let linked = 0;
    const stack = [...children[x]];
    while (stack.length) {
      const e = els[stack.pop()!];
      if (e.name === "a") linked += text.length(e.innerStart, e.innerEnd); else stack.push(...children[e.i]);
    }
    return total > 0 ? linked / total : 0;
  }

  function hasHeadingOrMedia(x: number): boolean {
    const stack = [...children[x]];
    while (stack.length) {
      const e = els[stack.pop()!];
      if (HEADING.test(e.name) || MEDIA.has(e.name)) return true;
      stack.push(...children[e.i]);
    }
    return false;
  }

  /** A caption-class element directly after an image (or after a block holding only an image). */
  function followsImage(e: El): boolean {
    const prev = prevSibling[e.i] >= 0 ? els[prevSibling[e.i]] : null;
    if (!prev || html.slice(prev.end, e.start).replace(/<br\s*\/?>/gi, "").trim() !== "") return false;
    if (prev.name === "img" || prev.name === "picture") return true;
    if (prev.name !== "a" && prev.name !== "p" && prev.name !== "div") return false;
    return text.length(prev.innerStart, prev.innerEnd) === 0 && children[prev.i].some((c) => els[c].name === "img" || els[c].name === "picture");
  }
}

const MEDIA = new Set(["figure", "img", "picture", "video", "audio"]);
const LEAD_BLOCKS = new Set(["div", "p", "span", "ul", "section", "small", "time", "li"]);
const PROMO_BLOCKS = new Set(["div", "section", "p"]);

/** A caption's inner HTML as one line: inline links and emphasis stay, paragraph/line breaks become spaces. */
function flatCaption(inner: string): string {
  if (inner.length > 5000) return inner.trim();
  return inner
    .replace(/<\/?(?:br|p|div)\b[^>]*>/gi, " ")
    .replace(/<\/?(?!(?:a|em|strong|b|i|code)\b)[a-z][a-z0-9-]*\b[^>]*>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cut ranges sorted and merged (nested or touching ones become one), for "is this inside a cut?" lookups. */
function mergeCuts(cuts: Cut[]): { from: number; to: number }[] {
  const sorted = cuts.map((c) => ({ from: c.from, to: c.to })).sort((a, b) => a.from - b.from || b.to - a.to);
  const out: { from: number; to: number }[] = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c.from < last.to) last.to = Math.max(last.to, c.to); else out.push(c);
  }
  return out;
}

/** `html.slice(from, to)` with the cut ranges removed or replaced. Cuts may nest: the outer one wins. */
function applyCuts(html: string, from: number, to: number, cuts: Cut[]): string {
  cuts.sort((a, b) => a.from - b.from || b.to - a.to);
  let out = "";
  let pos = from;
  for (const c of cuts) {
    if (c.from < pos) continue;
    out += html.slice(pos, c.from) + (c.with ?? "");
    pos = c.to;
  }
  return out + html.slice(pos, to);
}
