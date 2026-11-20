// The server-rendered bodies of the published pages: the home page, the article
// frame and the tag frame, plus the header and the foot. Each page is a set of
// boxes (@onden/site boxes.ts) filled with widgets (SiteWidgets.tsx); the old
// free-form Puck home page is drawn only while the design says so
// (`usesLegacyHome`). Plain React with no hooks and no `client:` directive:
// Astro renders it to HTML.
import type { ReactNode } from "react";
import { Render } from "@puckeditor/core/rsc";
import { bodyAfterTitle, fencedLines, noteSummary } from "@onden/markdown";
import { createPuckConfig, type SiteNote, type SiteRenderMeta } from "@onden/site/react";
import { picksOf, usesLegacyHome, withImplicitStacks, type SiteTagPage } from "@onden/site";
import { formatSiteDay, makeT, resolveMediaSrc, resolveNavItem, type PublishedNode } from "../templates";
import { sitePathFor } from "@onden/markdown";
import { makeSiteMarkdown } from "./siteMarkdown";
import { Img, Link, Pressable, TextField } from "../ui";
import "./siteFrame.css";
import "./siteReading.css";
import {
  coverOf, folderTrail, hasBody, isoDay, notesUnder, notePath, PATH_SEPARATOR, pagePreviews, previewsScriptText, previewTargetsOf, backlinksOf, type SiteData,
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
        {/* Hidden until SiteSearch.astro's script runs: without script the button would do nothing. */}
        <Pressable className="s-search__open" data-s-search-open hidden>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="m10.5 10.5 3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          <span className="s-search__open-label">{t("searchOpen")}</span>
          <kbd className="s-search__key" aria-hidden="true">Ctrl K</kbd>
        </Pressable>
        <div className="s-search" role="search" popover="auto" data-s-search aria-label={t("searchOpen")}
          data-no-results={t("noResults")} data-building={t("searchBuilding")} data-more={t("searchMore")}>
          <div className="s-search__bar">
            <TextField className="s-search__input" type="search" aria-label={t("searchOpen")} placeholder={t("search")} autoComplete="off" />
            <Pressable className="s-search__close" data-s-search-close aria-label={t("searchClose")}>×</Pressable>
          </div>
          <div className="s-search__results" />
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

/** The notes under a folder-like note: its page when it has no text, the list after its text when it has. A note made to
 *  hold others (a course, a folder) is a page of its own on the site, not an empty article. */
function ChildNotes({ data, node, notes, titled }: { data: SiteData; node: PublishedNode; notes: PublishedNode[]; titled: boolean }): ReactNode {
  const t = makeT(localeOf(data));
  const locale = localeOf(data);
  return (
    <section className="s-children" aria-label={t("childNotes")} data-pagefind-ignore="" data-folder={node.id}>
      {titled ? <h2 className="s-frame-label">{t("childNotes")}</h2> : null}
      <ul className="s-list s-list--notes s-children__list">
        {notes.map((child) => (
          <li key={child.id}>
            <Link href={notePath(data.nodes, child.slug)}>{child.title}</Link>
            {child.updated_at ? <time className="s-date">{formatSiteDay(isoDay(child.updated_at, data.timeZone, data.dayStartHour), locale)}</time> : null}
            {hasBody(child) ? <p className="s-row__summary">{noteSummary(child.markdown, { title: child.title, maxLen: 80 })}</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ArticleFrame({ data, node, editing }: { data: SiteData; node: PublishedNode; editing?: BoxContext["editing"] }) {
  const { design, nodes } = data;
  const ctx = boxContext(data, { node }, editing);
  const renderMarkdown = makeSiteMarkdown(nodes, { locale: localeOf(data), diagrams: data.diagrams });
  const image = design.reading.cover ? coverOf(node.markdown) : undefined;
  const body = splitCover(bodyAfterTitle(node.markdown, node.title), image);
  const t = makeT(localeOf(data));
  const trail = folderTrail(node, nodes);
  const children = notesUnder(node, nodes);
  const hasText = hasBody(node);
  // The cards of the notes this page links to, and only those (no site-wide index).
  const previews = design.reading.preview
    ? pagePreviews(previewTargetsOf(node, nodes, backlinksOf(node, nodes, data.edges)), localeOf(data), data.timeZone, data.dayStartHour)
    : null;

  return (
    <div className="s-article-layout" data-frame="article">
      <Box id="note.left" ctx={ctx} as="aside" />
      <article className="s-article" data-pagefind-body="" data-pagefind-meta={trail.length > 0 ? `path:${trail.map((a) => a.title).join(PATH_SEPARATOR)}` : undefined}>
        {trail.length > 0 ? (
          <nav className="s-breadcrumb" aria-label={t("breadcrumb")} data-pagefind-ignore="">
            <ol>{trail.map((a) => <li key={a.id}><Link href={notePath(nodes, a.slug)}>{a.title}</Link></li>)}</ol>
          </nav>
        ) : null}
        {image ? <Img loading="eager" decoding="auto" className="s-article__cover" src={resolveMediaSrc(image)} alt="" /> : null}
        <header className="s-article__head">
          <h1 className="s-article__title">{node.title}</h1>
          <Box id="note.meta" ctx={ctx} className="s-article__meta-box" />
        </header>
        {hasText ? <div className="s-article__body">{renderMarkdown(body, node.id)}</div> : null}
        {children.length > 0 ? <ChildNotes data={data} node={node} notes={children} titled={hasText} /> : null}
        {!hasText && children.length === 0 ? <p className="s-article__empty">{t("noText")}</p> : null}
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
