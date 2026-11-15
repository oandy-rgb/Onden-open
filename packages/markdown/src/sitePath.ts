// Where a note lives on the published site, and which page a [[link]] on it
// opens. The site is the served snapshot (backend servedSite.ts): its pages
// carry the slug the snapshot gave them, which is not always the note's live
// slug — a clash across spaces is renamed `slug-<id6>` (collections.ts
// uniquePublishedSlugs), and a note renamed after Publish keeps its old slug
// until the next Publish. So every site address is read off the served pages
// by node id here, never rebuilt from a title or the live slug (D42).

import { linkSlug } from "./slug.js";
import { linkNameKey, splitWikilink, wikilinkNames, wikilinkTarget } from "./text.js";
import { drawnWikilinks } from "./wikilinkSpans.js";
import type { FrozenQueryBlock } from "./queryBlocks.js";

/** A page of the served site, as the snapshot lists it. `aliases`: the
 *  note's `aliases` attribute, known only on the server while it builds the
 *  snapshot (aliasLinksBySlug) — the snapshot itself lists none, so an alias
 *  no published link uses stays private. `markdown`: the page's text, where
 *  a `[[Page#Heading]]` finds the heading (headingFragment); without it such
 *  a link opens the page's top. */
export type ServedPage = {
  id: string; title: string; slug: string; aliases?: readonly string[]; markdown?: string;
  /** The page's query blocks, frozen when it was published (queryBlocks.ts, D113). */
  query_blocks?: readonly FrozenQueryBlock[];
};

/** The address of a note on the published site — `/site/<served slug>`, the
 *  form the site's own navigation pushes — or null when the served site does
 *  not contain it (never published, taken down, or marked after the last
 *  Publish). */
export function sitePathFor(nodeId: string, served: readonly Pick<ServedPage, "id" | "slug">[]): string | null {
  const page = served.find((p) => p.id === nodeId);
  return page ? `/site/${page.slug}` : null;
}

/** The served page `[[body]]` written on page `fromId` opens: one named by
 *  title (case-insensitive), slug or alias — linkNamesNote, the server's edge
 *  rule, `[[x.excalidraw]]` included (wikilinkNames) — the first in `served` order, the linking page itself last. Null
 *  when the site has no such page (the link then reads as plain text) and
 *  for a same-page `[[#anchor]]`.
 *
 *  `served` is indexed on first use (a site renders every link of every page
 *  against the same list), so it must not change afterwards; pass a new
 *  array for a changed site. */
export function servedLinkTarget<P extends ServedPage>(
  body: string, served: readonly P[], fromId?: string | null,
): P | null {
  const target = wikilinkTarget(body).toLowerCase();
  if (!target) return null;
  const index = indexOf(served);
  // Every name the link reads as (wikilinkNames: `x.excalidraw` is also `x`).
  const candidates = wikilinkNames(target).flatMap((name) => [index.byName.get(name), index.bySlug.get(linkSlug(name))]);
  let best: number | null = null;
  let self: number | null = null;
  for (const positions of candidates) {
    for (const at of positions ?? []) {
      if (fromId != null && served[at]!.id === fromId) self ??= at;
      else if (best === null || at < best) best = at;
    }
  }
  const at = best ?? self;
  return at === null ? null : served[at]!;
}

type LinkIndex = { byName: Map<string, number[]>; bySlug: Map<string, number[]> };
const indexes = new WeakMap<readonly ServedPage[], LinkIndex>();

function indexOf(served: readonly ServedPage[]): LinkIndex {
  let index = indexes.get(served);
  if (index) return index;
  index = { byName: new Map(), bySlug: new Map() };
  const add = (map: Map<string, number[]>, key: string, at: number) => {
    const list = map.get(key);
    if (!list) map.set(key, [at]);
    else if (list[list.length - 1] !== at) list.push(at);
  };
  served.forEach((page, at) => {
    add(index!.byName, linkNameKey(page.title), at);
    for (const alias of page.aliases ?? []) add(index!.byName, linkNameKey(alias), at);
    add(index!.bySlug, page.slug, at);
  });
  indexes.set(served, index);
  return index;
}

/** Characters that would end or split a link body. */
const LINK_SYNTAX = /[[\]|#\n]/;

/** A rewriter of published bodies: in `markdown` (the text of page
 *  `fromId`), each [[link]] that opens a page of `served` only through one
 *  of the page's aliases names that page by its served slug instead, so the
 *  site, its GitHub Pages copy and the zip open it without the alias list.
 *  The reader sees what they saw: `[[alias]]` becomes `[[<slug>|alias]]`,
 *  an explicit `|label` is kept, and so is a `#Heading` or `#^block`
 *  fragment (`[[alias#^b]]` reads "alias", as the renderer labels it).
 *
 *  Only the links the renderer draws are touched (drawnWikilinks: none in
 *  code or math), and only one that resolves, on `served` with aliases, to a
 *  page it would not reach by title or slug; a link to no page of `served`
 *  is left for redaction. If the slug would name another page (a title
 *  spelled like it), the title is tried, else the link is left as written.
 *  `served` carries the aliases; it is indexed once, for every page. */
export function aliasLinksBySlug(served: readonly ServedPage[]): (markdown: string, fromId?: string | null) => string {
  const bare: ServedPage[] = served.map(({ aliases: _aliases, ...page }) => page);
  if (!served.some((page) => page.aliases?.length)) return (markdown) => markdown;
  return (markdown, fromId) => {
    if (typeof markdown !== "string" || !markdown.includes("[[")) return markdown;
    let out = "", last = 0;
    for (const link of drawnWikilinks(markdown)) {
      const page = servedLinkTarget(link.body, served, fromId);
      if (!page || servedLinkTarget(link.body, bare, fromId)?.id === page.id) continue;
      const { target, alias } = splitWikilink(link.body);
      const hash = target.indexOf("#");
      const fragment = hash === -1 ? "" : target.slice(hash);
      const shown = alias ?? (fragment.startsWith("#^") ? target.slice(0, hash) : link.body);
      const name = [page.slug, page.title].find((n) =>
        !LINK_SYNTAX.test(n) && servedLinkTarget(n + fragment, bare, fromId)?.id === page.id);
      if (name === undefined) continue;
      out += markdown.slice(last, link.start) + `[[${name}${fragment}|${shown}]]`;
      last = link.end;
    }
    return last === 0 ? markdown : out + markdown.slice(last);
  };
}
