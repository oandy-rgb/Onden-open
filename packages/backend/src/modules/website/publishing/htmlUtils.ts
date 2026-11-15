// HTML escape, the published-artifact CSP, and md2html: a note's Markdown as
// the HTML the exports ship (single-note export, the zip / static pages).
//
// md2html renders with the ONE Markdown pipeline (@onden/markdown, W38c) in
// its "published" profile — the same plugins and sanitize schema the site
// renders with in the browser — so an export looks like the site: inline HTML
// in a note stays visible text, callouts / KaTeX math / highlighting render.
// What is particular to static HTML lives here (rehypeExportElements): the
// media, embeds and mermaid blocks the app draws with React components.

import { unified } from "unified";
import type { VFile } from "vfile";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { visit } from "unist-util-visit";
import { createHash } from "node:crypto";
import {
  TRUSTED_EMBED_HOSTS, EMBED_IFRAME_ATTRS, EMBED_DEFAULT_TITLE, rehypeMediaSvgLinks, isSafeLinkHref, classifyMedia, toEmbedUrl, liteEmbedOf, liteEmbedHast, audioSpeedLabel, AUDIO_SPEED_CLASS, AUDIO_SPEED_ATTR, ga4InlineScript, isGa4Id, escapeHtml,
  servedBlockTarget, servedPartLink, splitWikilink, sitePathFor, headingFragment, expandSteps, frozenQueryBlock, isQueryBlockLang,
  diagramSvgTree, diagramHast, type DiagramLayout,
  type FrozenQueryBlock, type FrozenQueryRow, type BlockServedPage, type WikilinkTarget,
} from "@onden/markdown";
import { ondenMarkdown } from "@onden/markdown/full";
import { siteWords } from "./siteWords.js";

/** The one HTML escape (`@onden/markdown`), under the name the publishing
 *  builders use. */
export const esc = escapeHtml;

/** A link or image address from a block's props, safe to put in href/src:
 *  relative paths, fragments and the schemes @onden/markdown allows on a link
 *  (LINK_SCHEMES: http, https, mailto, tel) are kept; any other scheme
 *  (javascript:, data:, vbscript: …) becomes "#". The zip's CSP blocks
 *  scripts too; this keeps the page from carrying them at all. Escape the
 *  result with esc(). */
export function safeUrl(url: string): string {
  const u = url.trim();
  return isSafeLinkHref(u) ? u : "#";
}

// Content-Security-Policy for published artifacts, delivered as a <meta>
// http-equiv tag because the primary deploy target (GitHub Pages) cannot set
// response headers. This is the second, independent XSS belt behind
// rehype-sanitize: even if a script survives the sanitizer, a static page
// allows no script source at all, and the SPA shell allows only 'self'
// modules plus the owner's opted-in analytics host. meta-CSP cannot carry
// frame-ancestors — the SSR /site pages set a real header for that half.
//
// frame-src mirrors TRUSTED_EMBED_HOSTS (both the apex and its subdomains):
// the sanitizer already drops non-trusted iframes, so CSP agreeing with it
// costs nothing and catches a sanitizer bypass.
export function publishedCspContent(opts: {
  /** "static" — pure markdown pages, no scripts ever.
   *  "spa"    — the Vite bundle shell: 'self' modules + opt-in analytics. */
  variant: "static" | "spa";
  analytics?: { provider?: string; id?: string };
  /** manifest tokens.webfonts — Google Fonts @import + KaTeX jsdelivr fonts. */
  webfonts?: boolean;
  /** Inline scripts the page carries (their text), allowed by hash — the
   *  static copy's pages hold a few lines of their own (copy button). */
  inlineScripts?: readonly string[];
}): string {
  const script: string[] = [];
  const connect: string[] = ["'self'"];
  const style: string[] = ["'self'", "'unsafe-inline'"]; // inline <style> + KaTeX style attrs
  const font: string[] = ["'self'", "data:"];
  // 'wasm-unsafe-eval' lets the search (Pagefind) compile its WebAssembly
  // module; it does not allow eval() or inline script. Its worker and index
  // files are 'self' (worker-src and connect-src fall back to these).
  if (opts.variant === "spa") script.push("'self'", "'wasm-unsafe-eval'");
  if (opts.webfonts) {
    style.push("https://fonts.googleapis.com");
    font.push("https://fonts.gstatic.com", "https://cdn.jsdelivr.net");
  }
  const provider = opts.analytics?.provider ?? "";
  if (opts.analytics?.id) {
    if (provider === "plausible") {
      script.push("https://plausible.io");
      connect.push("https://plausible.io");
    } else if (provider === "umami") {
      script.push("https://cloud.umami.is");
      connect.push("https://cloud.umami.is");
    } else if (provider === "ga4" && isGa4Id(opts.analytics.id)) {
      // The gtag bootstrap is an inline <script>; allow exactly that text via
      // its hash (varies with the measurement id) rather than 'unsafe-inline'.
      script.push(
        "https://www.googletagmanager.com",
        `'sha256-${createHash("sha256").update(ga4InlineScript(opts.analytics.id)).digest("base64")}'`,
      );
      connect.push(
        "https://www.googletagmanager.com",
        "https://*.google-analytics.com",
        "https://*.analytics.google.com",
      );
    }
  }
  for (const text of opts.inlineScripts ?? []) {
    script.push(`'sha256-${createHash("sha256").update(text).digest("base64")}'`);
  }
  const frame = TRUSTED_EMBED_HOSTS.flatMap((h) => [`https://${h}`, `https://*.${h}`]);
  return [
    "default-src 'none'",
    `script-src ${script.length ? script.join(" ") : "'none'"}`,
    `style-src ${style.join(" ")}`,
    "img-src 'self' data: https:",
    `font-src ${font.join(" ")}`,
    "media-src 'self' https:",
    `frame-src ${frame.join(" ")}`,
    `connect-src ${connect.join(" ")}`,
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

export function publishedCspMetaTag(opts: Parameters<typeof publishedCspContent>[0]): string {
  return `<meta http-equiv="Content-Security-Policy" content="${publishedCspContent(opts)}">`;
}

/** The ga4 inline bootstrap siteHead() emits — the CSP hash above is computed
 *  over the same function's output, so the two stay one. */
export { ga4InlineScript };

type HastElement = { type: "element"; tagName: string; properties: Record<string, unknown>; children: HastChild[] };
type HastChild = HastElement | { type: "text"; value: string } | { type: string; children?: HastChild[]; value?: string };

const textOf = (node: HastChild): string =>
  node.type === "text" ? (node as { value: string }).value : ((node as { children?: HastChild[] }).children ?? []).map(textOf).join("");

const embedFrame = (src: string, title: string): HastElement => {
  // Click to load, as on the site (liteEmbed.ts); without script the thumbnail
  // is a link to the video. A span (styled as a block): the embed sits where
  // the link was, inside its paragraph, where a div is not allowed.
  const lite = liteEmbedOf(src);
  if (lite) return liteEmbedHast(lite, title) as HastElement;
  return {
    type: "element", tagName: "span", properties: { className: ["md-embed", "md-embed-iframe"] },
    children: [{ type: "element", tagName: "iframe", children: [], properties: { src, title, ...EMBED_IFRAME_ATTRS } }],
  };
};

/** The audio speed button, `hidden` until a script shows it (mediaEnhance.ts). */
const speedButton = (label: string): HastElement => ({
  type: "element", tagName: "button", children: [{ type: "text", value: audioSpeedLabel(1) }],
  properties: { type: "button", className: [AUDIO_SPEED_CLASS], [AUDIO_SPEED_ATTR]: "", hidden: true, ariaLabel: label, title: label },
});

/** Draws, in static HTML, what the app's MarkdownRenderer draws with
 *  components (after sanitize, from trusted code): `![](clip.mp4)` as a
 *  player, a trusted YouTube/Vimeo URL — as an image or a bare link — as a
 *  sandboxed embed, and ```mermaid as `<pre class="mermaid">`: the diagram's
 *  source, since the exports load no script and don't bundle mermaid (the
 *  live site, a React app, draws it). */
function rehypeExportElements() {
  return (tree: { type: string; children: HastChild[] }, file: VFile) => {
    const words = siteWords(file.data.siteExport?.links?.locale);
    const untitled = words.embedTitle;
    visit(tree as never, "element", (node: HastElement, index: number | undefined, parent: HastElement | undefined) => {
      if (!parent || index === undefined) return;
      const src = typeof node.properties.src === "string" ? node.properties.src : "";
      // A task checkbox as the site draws it (an inert md-checkbox, no form
      // control in a static page); styled by MARKDOWN_ELEMENTS_CSS.
      if (node.tagName === "input" && node.properties.type === "checkbox") {
        const checked = node.properties.checked === true;
        parent.children[index] = { type: "element", tagName: "span", children: [], properties: {
          className: checked ? ["md-checkbox", "checked"] : ["md-checkbox"], role: "checkbox", ariaChecked: String(checked), ariaReadOnly: "true",
        } };
        return;
      }
      if (node.tagName === "img") {
        const kind = classifyMedia(src);
        if (kind === "video" || kind === "audio") {
          const player: HastElement = { type: "element", tagName: kind, children: [],
            properties: kind === "video"
              ? { src, controls: true, preload: "metadata", className: ["md-video"] }
              : { src, controls: true, preload: "metadata", className: ["md-audio"] } };
          if (kind === "audio") {
            parent.children.splice(index, 1, player, speedButton(words.playbackSpeed));
            return index + 2;
          }
          parent.children[index] = player;
        } else if (kind === "iframe") {
          const embed = toEmbedUrl(src);
          if (embed) parent.children[index] = embedFrame(embed, String(node.properties.alt ?? "") || untitled);
        }
        return;
      }
      if (node.tagName === "a") {
        const href = typeof node.properties.href === "string" ? node.properties.href : "";
        // A [[link]] to no page of the site reads as its label, as on the
        // live site (a disabled link there), never as a link that 404s.
        if (href.endsWith(UNRESOLVED_HREF)) { parent.children.splice(index, 1, ...node.children); return index; }
        const text = textOf(node);
        const embed = toEmbedUrl(href);
        if (embed && (text === href || text === "")) parent.children[index] = embedFrame(embed, text || untitled);
        return;
      }
      if (node.tagName === "pre") {
        const code = node.children.find((c): c is HastElement => c.type === "element" && (c as HastElement).tagName === "code");
        const cls = code?.properties.className;
        const lang = Array.isArray(cls) ? String(cls.find((c) => String(c).startsWith("language-")) ?? "").slice(9) : "";
        if (code && isQueryBlockLang(lang)) {
          // onden-query / onden-base: the result frozen when the note was
          // published or exported (D113), never the query's source.
          const links = file.data.siteExport?.links;
          const blocks = links?.queryBlocks ?? links?.pages.find((p) => p.id === links.from)?.query_blocks;
          parent.children[index] = frozenQueryHast(frozenQueryBlock(blocks, lang, textOf(code)), links);
          return;
        }
        if (code && Array.isArray(cls) && cls.includes("language-mermaid")) {
          const source = textOf(code).replace(/\n$/, "");
          // A diagram laid out at publish time (diagrams.ts) is drawn from the
          // server's own template; one without stays readable source.
          const layout = file.data.siteExport?.links?.diagrams?.get(source);
          if (layout) {
            parent.children[index] = el("div", "md-mermaid", [diagramHast(diagramSvgTree(layout)) as HastElement]);
            return;
          }
          parent.children[index] = { type: "element", tagName: "pre", properties: { className: ["mermaid"] },
            children: [{ type: "text", value: textOf(code).replace(/\n$/, "") }] };
        }
      }
    });
  };
}

/** Where md2html's [[links]] point. `pages`: the served site (the snapshot
 *  minus takedowns, servedSite.ts) — a link opens the page it names there
 *  (servedBlockTarget) at the page's served address (sitePathFor), and a link
 *  naming no page of it is plain text. `[[Page#Heading]]` adds the heading's
 *  anchor on that page (headingFragment, read from the page's markdown); a
 *  same-page `[[#Heading]]` is the anchor alone. `from`: the page being rendered (its
 *  own title is the last match). `relative`: address pages as siblings,
 *  `../<slug>/`, for the zip, whose pages sit at site/<slug>/index.html and
 *  may be hosted under any base path (a GitHub Pages project site serves it
 *  under /<repo>/); otherwise the site path `/site/<slug>`. */
export type SiteLinks = {
  pages: readonly BlockServedPage[]; from?: string | null; relative?: boolean;
  /** The rendered note's frozen query blocks (D113); omitted, the page
   *  `from` names carries them (a page of the served site). */
  queryBlocks?: readonly FrozenQueryBlock[];
  /** Precompiled diagrams by block text (diagrams.ts): a ```mermaid block with
   *  the same text is drawn, any other stays source. */
  diagrams?: ReadonlyMap<string, DiagramLayout>;
  /** The site's language (`SiteLocale`), for the few words md2html itself
   *  writes (an embed's default title). Omitted: English. */
  locale?: string;
};

const el = (tagName: string, className: string | null, children: HastChild[], properties: Record<string, unknown> = {}): HastElement =>
  ({ type: "element", tagName, properties: className ? { ...properties, className: [className] } : properties, children });
const txt = (value: string): HastChild => ({ type: "text", value });

/** A frozen query block in static HTML — the same rule as the site's
 *  MarkdownRenderer (FrozenQueryResult): a list of titles, or a table when
 *  the block shows columns, each title linking to its page when the export
 *  has it, and `+N more` past the frozen rows. No block (a snapshot from
 *  before D113): a note that the results are not included. */
function frozenQueryHast(block: FrozenQueryBlock | null, links: SiteLinks | undefined): HastElement {
  const wrap = (children: HastChild[]) => el("div", "onden-query-frozen", children);
  if (!block) return wrap([el("p", "onden-query-frozen-note", [txt("This query's results are not included.")])]);
  if (block.problem) return wrap([el("p", "onden-query-frozen-problem", [txt(block.problem)])]);
  if (block.rows.length === 0) return wrap([el("p", "onden-query-frozen-empty", [txt("No matches")])]);
  const title = (row: FrozenQueryRow): HastChild => {
    const page = links?.pages.find((p) => p.id === row.id);
    if (!links || !page) return txt(row.title);
    return el("a", null, [txt(row.title)], { href: links.relative ? `../${page.slug}/` : sitePathFor(page.id, links.pages)! });
  };
  const list = block.columns.length === 0
    ? el("ul", "onden-query-frozen-list", block.rows.map((row) => el("li", null, [
      title(row), ...(row.note ? [el("span", "onden-query-frozen-in", [txt(row.note)])] : []),
    ])))
    : el("table", "onden-query-frozen-table", [
      el("thead", null, [el("tr", null, [el("th", null, [txt("Title")]), ...block.columns.map((c) => el("th", null, [txt(c)]))])]),
      el("tbody", null, block.rows.map((row) => el("tr", null, [
        el("td", null, [title(row)]), ...block.columns.map((_, i) => el("td", null, [txt(row.values?.[i] ?? "")])),
      ]))),
    ]);
  return wrap([list, ...(block.more > 0 ? [el("p", "onden-query-frozen-more", [txt(`+${block.more} more`)])] : [])]);
}

const UNRESOLVED_HREF = "#onden-unresolved-wikilink";

function siteHref({ links, markdown }: SiteExport, { target, blockId, heading }: WikilinkTarget): string {
  // `[[#Heading]]`: on the page being rendered. (A `[[#^id]]` has no id in
  // static HTML to point at — data-block-id is not one — so it stays text.)
  if (!target) return (heading && headingFragment(markdown, heading)) || UNRESOLVED_HREF;
  // `[[筆記/段落開頭]]`: the page it names, at the heading when the part is one (partLink: the site has no anchors).
  const part = links ? partLink(target, links) : null;
  if (part) return (links!.relative ? `../${part.page.slug}/` : sitePathFor(part.page.id, links!.pages)!) + (part.heading && typeof part.page.markdown === "string" ? headingFragment(part.page.markdown, part.heading) ?? "" : "");
  const body = blockId ? `${target}#^${blockId}` : target;
  // `[[Note#^id]]` whose note no longer holds the block opens the published
  // note that does (servedBlockTarget); only served pages are looked in.
  const page = links ? servedBlockTarget(body, links.pages, links.from)?.page ?? null : null;
  if (!page) return UNRESOLVED_HREF;
  const fragment = heading && typeof page.markdown === "string" ? headingFragment(page.markdown, heading) ?? "" : "";
  return (links!.relative ? `../${page.slug}/` : sitePathFor(page.id, links!.pages)!) + fragment;
}

const partLink = (target: string, links: SiteLinks) => servedPartLink(target, links.pages, links.from);

/** What one md2html call tells the shared processor: its links, and its text
 *  (for same-page headings). Carried on the call's file (VFile.data), not in
 *  a variable of the module: a nested or later-async call cannot read another
 *  call's links. */
type SiteExport = { links: SiteLinks | undefined; markdown: string };
declare module "vfile" {
  interface DataMap { siteExport: SiteExport }
}

// Exports are the site's offline copy: the published profile. The one
// processor is built once (with its highlighter) and reused for every block.
const exportMarkdown = ondenMarkdown({
  profile: "published",
  wikilinkHref: (link, file) => siteHref(file.data.siteExport!, link),
  // 「筆記 › 開頭」, as the app reads the same link (the words come from @onden/markdown servedPartLink).
  wikilinkLabel: (body, file) => {
    const links = file.data.siteExport?.links;
    return links ? partLink(splitWikilink(body).target, links)?.words ?? null : null;
  },
});
const mdProcessor = unified()
  .use(remarkParse)
  .use(exportMarkdown.remarkPlugins)
  .use(remarkRehype, exportMarkdown.remarkRehypeOptions)
  .use(exportMarkdown.rehypePlugins)
  .use(rehypeMediaSvgLinks)
  .use(rehypeExportElements)
  .use(rehypeStringify);

/** A note's Markdown as the exports' HTML (see the file header). A ```steps
 *  figure is written out as its steps in order (expandSteps): the file runs no
 *  player. Without
 *  `links` no site is known and every [[link]] is plain text. */
export function md2html(md: string, links?: SiteLinks): string {
  const siteExport: SiteExport = { links, markdown: md };
  return String(mdProcessor.processSync({ value: exportMarkdown.prepare(expandSteps(md)), data: { siteExport } }));
}
