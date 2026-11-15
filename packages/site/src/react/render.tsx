// Server-renderable site components: no hooks, no browser APIs. They draw what
// `puck.metadata` (SiteRenderMeta) holds; the design stores ids only. Every
// root element carries `data-node="<component id>"`, which per-part CSS
// (scopedCss) and the studio's click-to-select read.
import { Fragment, type ReactNode } from "react";
import { bodyAfterTitle, compareTitles, extractBlock, firstImage, noteSummary } from "@onden/markdown";
import { partTypeOf, usedSlots, type PartType } from "../registry.js";
import { EMPTY_META, type SiteNote, type SiteRenderMeta } from "./meta.js";
import type { SiteRow } from "../rows.js";

type SlotRender = (props?: { className?: string }) => ReactNode;
// Puck's props for one component, as far as these renderers read them.
export type RenderProps = { id: string; puck?: { metadata?: unknown }; [prop: string]: unknown };

export const metaOf = (props: RenderProps): SiteRenderMeta => ({ ...EMPTY_META, ...((props.puck?.metadata as Partial<SiteRenderMeta> | undefined) ?? {}) });
const text = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
const cx = (...names: (string | false | undefined | null)[]) => names.filter(Boolean).join(" ");

// ── Parts ───────────────────────────────────────────────────────────────

/** The first paragraph of a note's body (under its title): the first block that is prose. */
export function firstParagraph(note: Pick<SiteNote, "markdown" | "title">): string {
  const blocks = bodyAfterTitle(note.markdown, note.title).split(/\n[ \t]*\n/);
  return blocks.map((b) => b.trim()).find((b) => b !== "" && !/^(#{1,6}\s|!\[|---|\|)/.test(b)) ?? "";
}

export function renderPart(type: PartType, props: RenderProps): ReactNode {
  const used = usedSlots(type, props);
  const slot = (name: string, className: string) => {
    const Items = props[name] as SlotRender | undefined;
    return Items ? <Items className={cx("s-slot", className)} /> : null;
  };
  const shell = (modifier: string, children: ReactNode) => (
    <div
      data-node={props.id}
      data-heading={text(props.heading, "auto")}
      className={cx("s-part", `s-${type}`, modifier, props.bg === "tint" && "s-tint", text(props.cls))}
    >
      {children}
    </div>
  );
  switch (type) {
    case "stack":
      return shell("", slot("items", "s-stack__items"));
    case "sidebar":
      return shell(
        cx(props.side === "right" && "s-sidebar--right", props.width === "m" && "s-sidebar--m"),
        <>{slot("aside", "s-sidebar__aside")}{slot("main", "s-sidebar__main")}</>,
      );
    case "switcher":
      return shell("", <>{used.map((name) => <Fragment key={name}>{slot(name, "s-switcher__item")}</Fragment>)}</>);
    case "cards":
      return shell(props.size === "l" ? "s-cards--l" : "", slot("items", "s-cards__items"));
    case "cover":
      return shell(props.height === "l" ? "s-cover--l" : "", slot("items", "s-cover__items"));
    case "center":
      return shell(props.width === "l" ? "s-center--l" : "", slot("items", "s-center__items"));
  }
}

/** Render function of a part or a pattern (which draws as the part it expands to). */
export function renderPartOrPattern(type: string, props: RenderProps): ReactNode {
  const part = partTypeOf(type);
  if (!part) return null;
  // A pattern keeps its own props but the root part's slots and classes.
  return renderPart(part, props);
}

// ── Content ─────────────────────────────────────────────────────────────

function missing(id: string, label: string, meta: SiteRenderMeta): ReactNode {
  return meta.editing ? <div data-node={id} className="s-missing">{label}</div> : null;
}

export function NoteView(props: RenderProps): ReactNode {
  const meta = metaOf(props);
  const noteId = text(props.noteId);
  const note = meta.notes[noteId];
  if (!note) {
    const draft = meta.drafts?.[noteId];
    if (meta.editing && draft) {
      return (
        <div data-node={props.id} className="s-draft">
          <span className="s-draft__title">{draft.title || "未命名"}</span>
          <span className="s-badge">未發布</span>
        </div>
      );
    }
    return missing(props.id, noteId === "" ? "選擇一篇筆記" : "未發布", meta);
  }
  const blockId = text(props.blockId);
  const display = text(props.display, "full");

  if (blockId !== "") {
    const block = extractBlock(note.markdown, blockId, note.part_anchors ?? []);
    if (block === null) return missing(props.id, "找不到這個段落", meta);
    return (
      <figure data-node={props.id} className="s-quote">
        <blockquote>{meta.renderMarkdown(block)}</blockquote>
        <figcaption className="s-quote__source">
          出自<a href={meta.hrefFor(note.slug)}>{`〈${note.title}〉`}</a>
        </figcaption>
      </figure>
    );
  }
  if (display === "card") return <NoteCard id={props.id} note={note} meta={meta} />;
  if (display === "title") {
    return <h3 data-node={props.id} className="s-note__title"><a href={meta.hrefFor(note.slug)}>{note.title}</a></h3>;
  }
  const body = display === "first" ? firstParagraph(note) : note.markdown;
  if (body === "") return missing(props.id, "這篇筆記沒有內文", meta);
  return <article data-node={props.id} className="s-note"><div className="s-note__body">{meta.renderMarkdown(body)}</div></article>;
}

function NoteCard({ id, note, meta }: { id: string; note: SiteNote; meta: SiteRenderMeta }) {
  return (
    <Card
      id={id}
      row={{ id: note.id, title: note.title, slug: note.slug, date: "", fields: {}, image: firstImage(note.markdown) ?? "", excerpt: noteSummary(note.markdown, { title: note.title, maxLen: 80 }) }}
      meta={meta}
    />
  );
}

function Card({ id, row, meta }: { id?: string; row: SiteRow; meta: SiteRenderMeta }) {
  return (
    <a data-node={id} className="s-card" href={meta.hrefFor(row.slug)}>
      {row.image ? <img className="s-card__image" src={row.image} alt="" loading="lazy" /> : null}
      <div className="s-card__body">
        <h3 className="s-card__title">{row.title}</h3>
        {row.excerpt ? <p className="s-card__excerpt">{row.excerpt}</p> : null}
      </div>
    </a>
  );
}

function rowsOf(props: RenderProps, meta: SiteRenderMeta): SiteRow[] {
  const rows = meta.resolved[props.id] ?? [];
  const sorted = props.sort === "title" ? [...rows].sort((a, b) => compareTitles(a.title, b.title)) : rows;
  return sorted.slice(0, typeof props.limit === "number" ? props.limit : 6);
}

const Heading = ({ meta, tagId }: { meta: SiteRenderMeta; tagId: string }) =>
  meta.tagNames[tagId] ? <h3 className="s-view__heading">{meta.tagNames[tagId]}</h3> : null;

const DateText = ({ date }: { date?: string }) => (date ? <time className="s-date" dateTime={date}>{date}</time> : null);

/** The rows of a tag view in one of its three looks. The home page's `tag_view`
 *  and the tag page frame both draw rows through this, so a tag looks the same
 *  in both places. Links are real anchors (`meta.hrefFor`). */
export function RowsView({ kind, rows, meta }: { kind: string; rows: SiteRow[]; meta: SiteRenderMeta }): ReactNode {
  if (kind === "cards") {
    return <ul className="s-cardgrid">{rows.map((r) => <li key={r.id}><Card row={r} meta={meta} /></li>)}</ul>;
  }
  if (kind === "table") {
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r.fields ?? {})))];
    const hasDate = rows.some((r) => r.date);
    return (
      <table className="s-table">
        <thead><tr><th>標題</th>{columns.map((c) => <th key={c}>{c}</th>)}{hasDate ? <th>日期</th> : null}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td><a href={meta.hrefFor(r.slug)}>{r.title}</a></td>
              {columns.map((c) => <td key={c}>{r.fields?.[c] ?? ""}</td>)}
              {hasDate ? <td><DateText date={r.date} /></td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <ul className="s-list">
      {rows.map((r) => <li key={r.id}><a href={meta.hrefFor(r.slug)}>{r.title}</a><DateText date={r.date} /></li>)}
    </ul>
  );
}

export function TagView(props: RenderProps): ReactNode {
  const meta = metaOf(props);
  const rows = rowsOf(props, meta);
  const tagId = text(props.tagId);
  if (rows.length === 0) return missing(props.id, "這個標籤還沒有已發布的筆記", meta);
  const kind = text(props.viewKind, "list");
  return (
    <section data-node={props.id} className={cx("s-view", `s-view--${kind}`)}>
      <Heading meta={meta} tagId={tagId} />
      <RowsView kind={kind} rows={rows} meta={meta} />
    </section>
  );
}

export function Timeline(props: RenderProps): ReactNode {
  const meta = metaOf(props);
  const rows = rowsOf(props, meta);
  if (rows.length === 0) return missing(props.id, "這個標籤還沒有已發布的筆記", meta);
  return (
    <section data-node={props.id} className="s-view s-view--timeline">
      <Heading meta={meta} tagId={text(props.tagId)} />
      <ol className="s-timeline">
        {rows.map((r) => <li key={r.id}><DateText date={r.date} /><a href={meta.hrefFor(r.slug)}>{r.title}</a></li>)}
      </ol>
    </section>
  );
}

