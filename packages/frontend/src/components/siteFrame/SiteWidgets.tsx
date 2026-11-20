// The drawing of the boxes and of every built-in widget — the one drawing the
// live /site, the static copy, the exports, the publish preview and the
// website screen share (docs/architecture/proposals/site-boxes-2026-11-01.md §5).
// Plain React with no hooks: Astro renders it to HTML. A widget returns null
// when it has nothing to show; a box with nothing to show is not drawn (unless
// `editing`, which keeps the box and says why it is empty).
import type { ElementType, ReactNode } from "react";
import { bodyAfterTitle, compareText, noteSummary } from "@onden/markdown";
import {
  BOX_SPECS, WIDGETS, isListBox, picksOf, widgetReady, type BoxId, type BoxPick, type SiteBoxes, type SiteTagPage, type WidgetFacts, type WidgetRegistry,
} from "@onden/site";
import { RowsView, firstParagraph, type SiteRenderMeta } from "@onden/site/react";
import { Link, Pressable } from "../ui";
import { extractTOC, makeT, type PublishedNode } from "../templates";
import {
  articlesOf, byUpdated, featuredOf, firstOf, firstSentence, footnotesOf, groupByYear, introNoteOf, maturityOf, metaPieces, recentOf, topicsOf, WIDGET_LIST_MAX, yearOfDay,
} from "./siteWidgetData";
import {
  adjacentNotes, backlinksOf, linkedNotes, noteTree, notePath, tagPageByName, tagPath, isoDay, type Backlink, type SiteData, type TreeItem,
} from "./siteModel";
import { nodeOf } from "../../lib/nodeIndex";

type T = ReturnType<typeof makeT>;

/** Everything a widget may read: the site, the page being drawn, and how to draw. */
export type BoxContext = {
  data: SiteData;
  t: T;
  meta: SiteRenderMeta;
  facts: WidgetFacts;
  node?: PublishedNode;
  tag?: { id: string; page: SiteTagPage };
  /** The website screen: an empty box or a widget with nothing to show stays, with a line saying why. */
  editing?: {
    emptyLabel: string;
    /** The label of 「＋加一格」 at the end of a list box that has room. */ addLabel?: string;
    /** A registry word (a widget's name or need, written in Chinese by @onden/site) in the app's language. */ word?: (registryWord: string) => string;
  };
  registry?: WidgetRegistry;
  /** Drawings of widgets a feature module added (the built-in ones are below). */
  renderers?: Record<string, WidgetRenderer>;
};
export type WidgetRenderer = (variant: string, ctx: BoxContext) => ReactNode;

const cx = (...names: (string | false | undefined | null)[]) => names.filter(Boolean).join(" ");
const href = (ctx: BoxContext, note: PublishedNode) => notePath(ctx.data.nodes, note.slug);
const updatedText = (ctx: BoxContext, note: PublishedNode) =>
  note.updated_at ? ctx.t("updated").replace("{date}", isoDay(note.updated_at, ctx.data.timeZone, ctx.data.dayStartHour)) : "";
const Title = ({ children }: { children: ReactNode }) => <h2 className="s-w__title">{children}</h2>;

function NoteRows({ notes, ctx, summary }: { notes: readonly PublishedNode[]; ctx: BoxContext; summary?: boolean }) {
  return (
    <ul className="s-list s-list--notes">
      {notes.map((n) => (
        <li key={n.id}>
          <Link href={href(ctx, n)}>{n.title}</Link>
          <time className="s-date">{updatedText(ctx, n)}</time>
          {summary ? <p className="s-row__summary">{noteSummary(n.markdown, { title: n.title, maxLen: 80 })}</p> : null}
        </li>
      ))}
    </ul>
  );
}

const MATURITY_KEY = { 1: "maturity1", 2: "maturity2", 3: "maturity3" } as const;
function Maturity({ node, t }: { node: PublishedNode; t: T }) {
  const level = maturityOf(node);
  return level ? <span className="s-maturity" data-level={level}>{t(MATURITY_KEY[level])}</span> : null;
}

/** Whether `item` is the active note or has it somewhere below: its folder is open on that page. */
const holds = (item: TreeItem, activeId: string): boolean => item.node.id === activeId || item.children.some((c) => holds(c, activeId));

/** The explorer's tree: a note with notes under it is a folder (open on the path to the current page;
 *  the reader's other choices are kept on their device, SiteNavigation.astro), a note without is a link. */
function TreeList({ items, activeId, nodes }: { items: TreeItem[]; activeId: string; nodes: PublishedNode[] }) {
  return (
    <ul>
      {items.map((item) => {
        const { node, children } = item;
        const link = <Link href={notePath(nodes, node.slug)} aria-current={node.id === activeId ? "page" : undefined}>{node.title}</Link>;
        return (
          <li key={node.id}>
            {children.length > 0 ? (
              <details data-folder={node.id} open={holds(item, activeId) || undefined}>
                <summary>{link}</summary>
                <TreeList items={children} activeId={activeId} nodes={nodes} />
              </details>
            ) : link}
          </li>
        );
      })}
    </ul>
  );
}

/** One "Linked from" entry: the note, and the sentence(s) it links from. */
function BacklinkItem({ entry, nodes, t, quotes }: { entry: Backlink; nodes: PublishedNode[]; t: T; quotes: boolean }) {
  return (
    <li>
      <Link href={notePath(nodes, entry.node.slug)} data-note={entry.node.id}>{entry.node.title}</Link>
      {quotes ? entry.places.map((place, i) =>
        place.kind === "link" ? (
          <p key={i} className="s-backlinks__context">
            {place.pieces.map((piece, j) => (piece.mark ? <mark key={j}>{piece.text}</mark> : piece.text))}
          </p>
        ) : (
          <p key={i} className="s-backlinks__context s-backlinks__context--embed">
            {place.quote ? t("embedsPassage").replace("{text}", place.quote) : t("embedsPage")}
          </p>
        ),
      ) : null}
    </li>
  );
}

function MetaLine({ variant, ctx }: { variant: string; ctx: BoxContext }) {
  const node = ctx.node;
  if (!node) return null;
  const p = metaPieces(ctx.data, node);
  const when = p.date ?? (p.updated ? ctx.t("updated").replace("{date}", p.updated) : null);
  const date = when ? <time className="s-date" dateTime={p.date ?? p.updated ?? undefined}>{when}</time> : null;
  const reading = <span className="s-date s-reading" data-pagefind-ignore="">{ctx.t("readingTime").replace("{n}", String(p.minutes))}</span>;
  const tags = p.tags.length > 0 ? (
    <ul className="s-article__tags">
      {p.tags.map((name) => {
        const page = tagPageByName(ctx.data.design, name)?.page;
        return <li key={name}>{page ? <Link href={tagPath(page.slug)}>{name}</Link> : <span>{name}</span>}</li>;
      })}
    </ul>
  ) : null;
  const stage = <Maturity node={node} t={ctx.t} />;
  const inline = variant === "maturity-date" ? [stage, date]
    : variant === "date-tags" ? [date]
    : variant === "tags" ? []
    : variant === "reading" || variant === "reading-tags" ? [reading]
    : [date, reading];
  return (
    <>
      <p className="s-article__meta">{inline.map((x, i) => (x ? <span key={i} className="s-meta__piece">{x}</span> : null))}</p>
      {["date-tags", "all", "tags", "reading-tags"].includes(variant) ? tags : null}
    </>
  );
}

/** `MM-DD` of a `YYYY-MM-DD` day (the year is the group's heading). */
const monthDay = (day: string): string => day.replace(/^\d{4}-/, "");

function YearGroups({ notes, ctx }: { notes: readonly PublishedNode[]; ctx: BoxContext }) {
  return (
    <>
      {groupByYear(notes, ctx.data).map(({ year, notes: inYear }) => (
        <div key={year} className="s-year">
          {year ? <h3 className="s-year__label">{year}</h3> : null}
          <ul className="s-list s-list--notes">
            {inYear.map(({ node, day }) => (
              <li key={node.id}><Link href={href(ctx, node)}>{node.title}</Link><time className="s-date" dateTime={day}>{monthDay(day)}</time></li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

/** The built-in widgets' drawings, by widget id. */
export const WIDGET_RENDERERS: Record<string, WidgetRenderer> = {
  intro(variant, ctx) {
    const note = introNoteOf(ctx.data);
    if (!note) return null;
    const paragraph = firstParagraph(note);
    return <div className="s-prose s-intro" data-note={note.id}>{ctx.meta.renderMarkdown(variant === "sentence" ? firstSentence(paragraph) : paragraph)}</div>;
  },
  latest(variant, ctx) {
    const note = [...articlesOf(ctx.data)].sort((a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? "") || byUpdated(a, b))[0];
    if (!note) return null;
    return (
      <>
        <Title>{ctx.t("latestArticle")}</Title>
        <Link className="s-latest" href={href(ctx, note)}>
          <span className="s-latest__title">{note.title}</span>
          {variant === "card" ? <span className="s-latest__summary">{noteSummary(note.markdown, { title: note.title, maxLen: 120 })}</span> : null}
        </Link>
      </>
    );
  },
  recent(variant, ctx) {
    return (
      <>
        <Title>{ctx.t("recentlyUpdated")}</Title>
        <NoteRows notes={recentOf(ctx.data)} ctx={ctx} summary={variant === "summary"} />
      </>
    );
  },
  all(variant, ctx) {
    const notes = [...articlesOf(ctx.data)].sort(byUpdated);
    if (variant === "recent10") {
      return <><Title>{ctx.t("allArticles")}</Title><NoteRows notes={firstOf(notes, 10)} ctx={ctx} /></>;
    }
    if (variant === "maturity") {
      return (
        <>
          <Title>{ctx.t("allArticles")}</Title>
          <ul className="s-list s-list--notes">
            {firstOf(notes, WIDGET_LIST_MAX).map((n) => (
              <li key={n.id}><Link href={href(ctx, n)}>{n.title}</Link><Maturity node={n} t={ctx.t} /><time className="s-date">{updatedText(ctx, n)}</time></li>
            ))}
          </ul>
        </>
      );
    }
    return <><Title>{ctx.t("allArticles")}</Title><YearGroups notes={firstOf(notes, WIDGET_LIST_MAX)} ctx={ctx} /></>;
  },
  topics(variant, ctx) {
    return (
      <>
        <Title>{ctx.t("topics")}</Title>
        <ul className={cx("s-topics", variant === "chips" && "s-topics--row")}>
          {topicsOf(ctx.data).map((topic) => (
            <li key={topic.id}><Link href={tagPath(topic.slug)}>{topic.name}</Link><span className="s-count">{ctx.t("notesCount").replace("{n}", String(topic.count))}</span></li>
          ))}
        </ul>
      </>
    );
  },
  featured(variant, ctx) {
    const notes = featuredOf(ctx.data);
    return (
      <>
        <Title>{ctx.t("featured")}</Title>
        {variant === "cards" ? (
          <ul className="s-cardgrid">
            {notes.map((n) => (
              <li key={n.id}><Link className="s-card" href={href(ctx, n)}><div className="s-card__body"><h3 className="s-card__title">{n.title}</h3><p className="s-card__excerpt">{noteSummary(n.markdown, { title: n.title, maxLen: 80 })}</p></div></Link></li>
            ))}
          </ul>
        ) : <NoteRows notes={notes} ctx={ctx} />}
      </>
    );
  },
  subscribe(_variant, ctx) {
    return (
      <div className="s-subscribe">
        <Title>{ctx.t("subscribe")}</Title>
        <p>{ctx.t("subscribeLead")}</p>
        <Link className="s-button" href="/site/feed.xml">{ctx.t("feed")}</Link>
      </div>
    );
  },
  meta: (variant, ctx) => <MetaLine variant={variant} ctx={ctx} />,
  toc(_variant, ctx) {
    const toc = ctx.node ? extractTOC(ctx.node.markdown) : [];
    return (
      <nav className="s-toc" aria-label={ctx.t("onThisPage")} data-s-toc>
        <details className="s-toc__fold" open>
          <summary className="s-frame-label">{ctx.t("onThisPage")}</summary>
          <ul>{toc.map((e) => <li key={e.id} className={e.level === 3 ? "s-toc__sub" : undefined}><Link href={e.href} data-heading={e.id}>{e.text}</Link></li>)}</ul>
        </details>
      </nav>
    );
  },
  sidenotes(_variant, ctx) {
    const notes = ctx.node ? footnotesOf(ctx.node.markdown) : [];
    return (
      <div className="s-sidenotes" data-pagefind-ignore="">
        <h2 className="s-frame-label">{ctx.t("sideNotes")}</h2>
        <ol>{notes.map((n) => <li key={n.label}>{ctx.meta.renderMarkdown(n.text)}</li>)}</ol>
      </div>
    );
  },
  tree(_variant, ctx) {
    return (
      <nav className="s-tree s-explorer" aria-label={ctx.t("allNotes")} data-s-explorer>
        <Pressable className="s-explorer__toggle" aria-expanded="false" aria-controls="s-explorer-panel" data-s-explorer-toggle>{ctx.t("explorer")}</Pressable>
        <div className="s-explorer__panel" id="s-explorer-panel" data-pagefind-ignore="">
          <TreeList items={noteTree(ctx.data.nodes)} activeId={ctx.node?.id ?? ""} nodes={ctx.data.nodes} />
        </div>
      </nav>
    );
  },
  backlinks(variant, ctx) {
    const entries = ctx.node ? backlinksOf(ctx.node, ctx.data.nodes, ctx.data.edges) : [];
    return (
      <section className="s-backlinks" aria-label={ctx.t("backlinks")} data-pagefind-ignore="">
        <h2 className="s-frame-label">{ctx.t("backlinks")}</h2>
        <ul>{entries.map((entry) => <BacklinkItem key={entry.node.id} entry={entry} nodes={ctx.data.nodes} t={ctx.t} quotes={variant === "quote"} />)}</ul>
      </section>
    );
  },
  graph(_variant, ctx) {
    const node = ctx.node;
    if (!node) return null;
    const near = linkedNotes(node, ctx.data.nodes, ctx.data.edges);
    return (
      <section className="s-graph" aria-label={ctx.t("graph")} data-s-graph={node.id} data-pagefind-ignore="">
        <h2 className="s-frame-label">{ctx.t("graph")}</h2>
        <div className="s-graph__canvas" data-s-graph-canvas data-failed={ctx.t("graphUnavailable")} data-close={ctx.t("graphClose")} data-title={ctx.t("graph")} />
        <ul className="s-graph__list">
          {near.map((n) => <li key={n.id}><Link href={href(ctx, n)}>{n.title}</Link></li>)}
        </ul>
        <Pressable className="s-graph__open s-button s-button--quiet" data-s-graph-open>{ctx.t("graphFull")}</Pressable>
      </section>
    );
  },
  prevnext(_variant, ctx) {
    const { prev, next } = ctx.node ? adjacentNotes(ctx.node, ctx.data.nodes, ctx.data.design) : { prev: null, next: null };
    const nodes = ctx.data.nodes;
    return (
      <nav className="s-prevnext" data-pagefind-ignore="">
        {prev ? <Link className="s-prevnext__prev" rel="prev" href={notePath(nodes, prev.slug)}><span>{ctx.t("previous")}</span>{prev.title}</Link> : <span />}
        {next ? <Link className="s-prevnext__next" rel="next" href={notePath(nodes, next.slug)}><span>{ctx.t("next")}</span>{next.title}</Link> : null}
      </nav>
    );
  },
  tagdesc(_variant, ctx) {
    const note = ctx.tag ? nodeOf(ctx.data, ctx.tag!.id) : undefined;
    const body = note ? bodyAfterTitle(note.markdown, note.title) : "";
    return body.trim() === "" ? null : <div className="s-tag__description s-prose">{ctx.meta.renderMarkdown(body)}</div>;
  },
  tagnotes(variant, ctx) {
    const page = ctx.tag?.page;
    if (!page) return null;
    if (variant === "view") return <RowsView kind={page.viewKind} rows={page.rows} meta={ctx.meta} />;
    if (variant === "plain") return <RowsView kind="list" rows={page.rows} meta={ctx.meta} />;
    const years = new Map<string, typeof page.rows>();
    for (const row of page.rows) years.set(yearOfDay(row.date), [...(years.get(yearOfDay(row.date)) ?? []), row]);
    return (
      <>
        {[...years].sort((a, b) => compareText(b[0], a[0])).map(([year, rows]) => (
          <div key={year} className="s-year">
            {year ? <h3 className="s-year__label">{year}</h3> : null}
            <ul className="s-list s-list--notes">
              {[...rows].sort((a, b) => compareText(b.date, a.date)).map((r) => (
                <li key={r.id}>
                  <Link href={ctx.meta.hrefFor(r.slug)}>{r.title}</Link>
                  {r.date ? <time className="s-date" dateTime={r.date}>{r.date}</time> : null}
                  {variant === "summary" && r.excerpt ? <p className="s-row__summary">{r.excerpt}</p> : null}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </>
    );
  },
  tagfeed(_variant, ctx) {
    return ctx.tag ? <Link className="s-button s-button--quiet" href={`${tagPath(ctx.tag.page.slug)}feed.xml`}>{ctx.t("tagFeed")}</Link> : null;
  },
  copyright(_variant, ctx) {
    const brand = typeof ctx.data.site.brand === "string" && ctx.data.site.brand ? ctx.data.site.brand : ctx.data.title;
    const newest = [...ctx.data.nodes].map((n) => n.updated_at ?? n.created_at ?? "").sort().pop();
    const year = yearOfDay(newest ?? "");
    return <span>{year ? `© ${year} ${brand}` : `© ${brand}`}</span>;
  },
  rss: (_variant, ctx) => <Link href="/site/feed.xml">{ctx.t("feed")}</Link>,
  scheme: (_variant, ctx) => <Pressable className={cx("s-scheme", ctx.editing && "s-scheme--shown")} data-s-scheme aria-label={ctx.t("theme")} title={ctx.t("theme")}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" /></svg>
    </Pressable>,
};

function Missing({ pick, boxId, index, ctx }: { pick: BoxPick; boxId: BoxId; index: number; ctx: BoxContext }) {
  const widget = (ctx.registry ?? WIDGETS).get(pick.widget);
  const word = ctx.editing?.word ?? ((registryWord: string) => registryWord);
  return (
    <div className="s-w s-w--missing" data-widget={pick.widget} data-box={boxId} data-index={index}>
      <strong>{widget ? word(widget.label) : pick.widget}</strong>{widget?.needs ? `：${word(widget.needs)}` : ""}
    </div>
  );
}

/** One box with its widgets. `as` is the element it is; `children` lets a page add its own fixed content to it. */
export function Box({ id, ctx, as: Tag = "div", className, boxes }: { id: BoxId; ctx: BoxContext; as?: ElementType; className?: string; boxes?: SiteBoxes }): ReactNode {
  const registry = ctx.registry ?? WIDGETS;
  const renderers = { ...WIDGET_RENDERERS, ...ctx.renderers };
  const picks = picksOf(boxes ?? ctx.data.design.boxes, id);
  const spec = BOX_SPECS[id];
  const drawn = picks.flatMap((pick, index) => {
    const widget = registry.get(pick.widget);
    if (!widget) return [];
    const body = widgetReady(widget, ctx.facts) ? renderers[widget.id]?.(pick.variant, ctx) : null;
    if (!body) return ctx.editing ? [<Missing key={index} pick={pick} boxId={id} index={index} ctx={ctx} />] : [];
    const Wrapper: ElementType = ["hero", "section", "tagEnd"].includes(spec.accepts) ? "section" : "div";
    return [(
      <Wrapper
        key={index}
        className={cx("s-w", `s-w--${widget.id}`, `s-w--${pick.variant}`, widget.narrow === "hide" && "s-w--narrow-hide")}
        data-widget={widget.id} data-variant={pick.variant} data-box={id} data-index={index}
      >
        {body}
      </Wrapper>
    )];
  });
  if (drawn.length === 0 && !ctx.editing) return null;
  const canAdd = ctx.editing?.addLabel !== undefined && isListBox(id) && picks.length < spec.max;
  return (
    <Tag className={cx("s-box", `s-box--${id.replace(".", "-")}`, className, drawn.length === 0 && "s-box--empty")} data-box={id} data-fold={spec.narrow}>
      {drawn.length > 0 || isListBox(id) ? drawn : <div className="s-w s-w--empty" data-box={id} data-index={0}>{ctx.editing?.emptyLabel}</div>}
      {canAdd ? <Pressable className="s-w s-w--add" data-box={id} data-index={picks.length} data-add="">{ctx.editing?.addLabel}</Pressable> : null}
    </Tag>
  );
}
