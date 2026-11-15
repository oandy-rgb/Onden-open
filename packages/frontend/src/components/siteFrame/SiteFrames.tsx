// The server-rendered bodies of the published pages: the home page, the article
// frame and the tag frame, plus the header and the foot. Each page is a set of
// boxes (@onden/site boxes.ts) filled with widgets (SiteWidgets.tsx); the old
// free-form Puck home page is drawn only while the design says so
// (`usesLegacyHome`). Plain React with no hooks and no `client:` directive:
// Astro renders it to HTML.
import type { ReactNode } from "react";
import { Render } from "@puckeditor/core/rsc";
import { bodyAfterTitle, fencedLines } from "@onden/markdown";
import { createPuckConfig, type SiteNote, type SiteRenderMeta } from "@onden/site/react";
import { picksOf, usesLegacyHome, withImplicitStacks, type SiteTagPage } from "@onden/site";
import { makeT, resolveMediaSrc, resolveNavItem, type PublishedNode } from "../templates";
import { sitePathFor } from "@onden/markdown";
import { makeSiteMarkdown } from "./siteMarkdown";
import { Img, Link, TextField } from "../ui";
import "./siteFrame.css";
import "./siteReading.css";
import {
  coverImage, notePath, pagePreviews, previewsScriptText, previewTargetsOf, backlinksOf, type SiteData,
} from "./siteModel";
import { articleFacts, siteFacts, tagFacts } from "./siteWidgetData";
import { Box, type BoxContext } from "./SiteWidgets";

const puckConfig = createPuckConfig();

const localeOf = (data: SiteData): string | undefined => (typeof data.site.locale === "string" ? data.site.locale : undefined);

/** What the home components read (`puck.metadata`) and what every widget reads to draw
 *  text: the published notes by id, the rows fixed at publish, tag names, and the two page-level functions. */
export function siteRenderMeta(data: SiteData): SiteRenderMeta {
  const renderMarkdown = makeSiteMarkdown(data.nodes, { locale: localeOf(data), diagrams: data.diagrams });
  const notes: Record<string, SiteNote> = Object.fromEntries(data.nodes.map((n) => [n.id, n]));
  return {
    notes,
    resolved: data.design.resolved,
    tagNames: data.design.tag_names,
    renderMarkdown: (markdown) => renderMarkdown(markdown),
    hrefFor: (slug) => notePath(data.nodes, slug),
  };
}

type PageKind = { node?: PublishedNode; tag?: { id: string; page: SiteTagPage } };

/** The context the boxes of one page draw with. `editing` is the website screen's. */
export function boxContext(data: SiteData, page: PageKind = {}, editing?: BoxContext["editing"]): BoxContext {
  return {
    data,
    t: makeT(localeOf(data)),
    meta: siteRenderMeta(data),
    facts: page.node ? articleFacts(data, page.node) : page.tag ? tagFacts(data, page.tag.id) : siteFacts(data),
    ...page,
    ...(editing && { editing }),
  };
}

export function HomeBody({ data, editing }: { data: SiteData; editing?: BoxContext["editing"] }) {
  if (usesLegacyHome(data.design)) {
    return (
      <div className="s-home">
        <Render config={puckConfig} data={withImplicitStacks(data.design.legacy_home!) as never} metadata={siteRenderMeta(data)} />
      </div>
    );
  }
  const ctx = boxContext(data, {}, editing);
  return (
    <div className="s-home s-home--boxes" data-frame="home">
      <Box id="home.hero" ctx={ctx} />
      <Box id="home.list" ctx={ctx} />
    </div>
  );
}

// ── Header and foot ─────────────────────────────────────────────────────

/** The header box: the site name (or logo), the tagline, the navigation links and the search. */
export function SiteHeader({ data, editing }: { data: SiteData; editing?: BoxContext["editing"] }): ReactNode {
  const [pick] = picksOf(data.design.boxes, "header");
  if (!pick) return editing ? <header className="s-frame-header s-box--empty" data-box="header">{editing.emptyLabel}</header> : null;
  const site = data.site;
  const brand = site.brand ?? data.title;
  const t = makeT(localeOf(data));
  const links = (site.nav ?? []).flatMap((item) => {
    const { label, node } = resolveNavItem(item, data.nodes);
    const path = node ? sitePathFor(node.id, data.nodes) : null;
    return path && label ? [{ label, href: path }] : [];
  });
  return (
    <header className={`s-frame-header s-frame-header--${pick.variant}`} data-box="header" data-widget="nav" data-variant={pick.variant} data-index={0}>
      <div className="s-frame-header__inner">
        <Link className="s-frame-brand" href="/site/">
          {typeof site.logo === "string" && site.logo !== ""
            ? <Img loading="eager" decoding="auto" className="s-frame-brand__logo" src={site.logo} alt={brand} />
            : <span className="s-frame-brand__name">{brand}</span>}
        </Link>
        {site.tagline && pick.variant !== "minimal" ? <p className="s-frame-tagline">{site.tagline}</p> : null}
        {links.length > 0 && pick.variant !== "minimal" ? (
          <nav className="s-frame-nav" aria-label={t("navigation")}>
            {links.map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>)}
          </nav>
        ) : null}
        <div className="s-search" role="search" data-s-search data-no-results={t("noResults")} hidden>
          <TextField className="s-search__input" type="search" aria-label={t("search").replace(/…$/, "")} placeholder={t("search")} autoComplete="off" />
          <div className="s-search__results" hidden />
        </div>
      </div>
    </header>
  );
}

/** The foot box: its widgets side by side. Not drawn when it is empty or nothing in it has anything to show. */
export function SiteFoot({ data, editing }: { data: SiteData; editing?: BoxContext["editing"] }): ReactNode {
  return <Box id="foot" ctx={boxContext(data, {}, editing)} as="footer" className="s-frame-footer" />;
}

// ── Article frame ───────────────────────────────────────────────────────

/** A standalone first-image paragraph is the cover; it leaves the body so the
 *  picture is not shown twice. An image inside text stays where it is. */
function splitCover(body: string, image: string | undefined): string {
  if (!image) return body;
  const lines = body.split("\n");
  const fenced = fencedLines(lines);
  const at = lines.findIndex((l, i) => !fenced[i] && l.trim().startsWith("![") && l.includes(`(${image}`) && /^!\[[^\]]*\]\([^)]*\)$/.test(l.trim()));
  if (at < 0 || fenced.slice(0, at).some(Boolean)) return body;
  return [...lines.slice(0, at), ...lines.slice(at + 1)].join("\n").replace(/^\s*\n/, "");
}

export function ArticleFrame({ data, node, editing }: { data: SiteData; node: PublishedNode; editing?: BoxContext["editing"] }) {
  const { design, nodes } = data;
  const ctx = boxContext(data, { node }, editing);
  const renderMarkdown = makeSiteMarkdown(nodes, { locale: localeOf(data), diagrams: data.diagrams });
  const image = design.reading.cover ? coverImage(node.markdown) : undefined;
  const body = splitCover(bodyAfterTitle(node.markdown, node.title), image);
  // The cards of the notes this page links to, and only those (no site-wide index).
  const previews = design.reading.preview
    ? pagePreviews(previewTargetsOf(node, nodes, backlinksOf(node, nodes, data.edges)), localeOf(data), data.timeZone, data.dayStartHour)
    : null;

  return (
    <div className="s-article-layout" data-frame="article">
      <Box id="note.left" ctx={ctx} as="aside" />
      <article className="s-article" data-pagefind-body="">
        {image ? <Img loading="eager" decoding="auto" className="s-article__cover" src={resolveMediaSrc(image)} alt="" /> : null}
        <header className="s-article__head">
          <h1 className="s-article__title">{node.title}</h1>
          <Box id="note.meta" ctx={ctx} className="s-article__meta-box" />
        </header>
        <div className="s-article__body">{renderMarkdown(body, node.id)}</div>
        <Box id="note.end" ctx={ctx} className="s-article__end" />
      </article>
      {previews && Object.keys(previews.notes).length > 0 ? (
        <script type="application/json" id="s-previews" dangerouslySetInnerHTML={{ __html: previewsScriptText(previews) }} />
      ) : null}
      <Box id="note.right" ctx={ctx} as="aside" />
    </div>
  );
}

// ── Tag frame ───────────────────────────────────────────────────────────

/** A tag page: its name, then its boxes — the description, the notes, and what follows the list. */
export function TagFrame({ data, tagId, page, editing }: { data: SiteData; tagId: string; page: SiteTagPage; editing?: BoxContext["editing"] }): ReactNode {
  const ctx = boxContext(data, { tag: { id: tagId, page } }, editing);
  return (
    <div className="s-tag" data-frame="tag">
      <header className="s-tag__head">
        <h1 className="s-tag__title">{page.name}</h1>
        <Box id="tag.desc" ctx={ctx} />
      </header>
      <Box id="tag.list" ctx={ctx} />
      <Box id="tag.end" ctx={ctx} />
    </div>
  );
}
