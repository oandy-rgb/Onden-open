// A note's full text as the feed carries it: the same HTML the article page
// draws from the same published note (the snapshot's text is already cut down
// to what the site shows), with the site-relative addresses made absolute —
// a feed reader has no page to resolve them against.
import { renderToStaticMarkup } from "react-dom/server";
import { bodyAfterTitle, withoutHandwritingPages } from "@onden/markdown";
import { makeSiteMarkdown } from "../../components/siteFrame";
import type { PublishedNode } from "../../components/templates";

/** `href="/site/x"` / `src="/api/media/y"` → `href="https://origin/site/x"`. */
export function absoluteLinks(html: string, origin: string): string {
  return html.replace(/\b(href|src|poster)="\/(?!\/)/g, `$1="${origin}/`);
}

/** The body of `node` for the feed. `nodes` is every published note (links and
 *  frozen query results resolve against them). A handwriting note carries its
 *  first page only: an item is a teaser, the link opens every page. Needs
 *  loadAllEnhancers() first. */
export function feedBodyHtml(nodes: PublishedNode[], node: PublishedNode, origin: string, locale?: string): string {
  const render = makeSiteMarkdown(nodes, { static: true, locale });
  const html = renderToStaticMarkup(render(withoutHandwritingPages(bodyAfterTitle(node.markdown, node.title), 1), node.id));
  return absoluteLinks(html, origin);
}

/** Text safe inside a CDATA section (`]]>` would end it early). */
export function cdata(text: string): string {
  return `<![CDATA[${text.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}
