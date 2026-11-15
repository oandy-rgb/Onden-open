// One slide, drawn: the 1920×1080 canvas scaled to its box (docs/architecture/
// proposals/slides-2026-10-31.md §5). The view's big picture, its thumbnails and
// the full-screen player all draw this component, so what is seen on the page is
// what is played. The words come from the page; `render` draws Markdown (the
// caller decides which notes its [[links]] resolve to).

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { DECK_CANVAS, DECK_MIN_BODY_PX } from "@onden/site/look";
import { observeSize } from "../../lib/observeSize";
import { growLevel, hasTable, splitStat, splitStep, itemsOf, sidesOf } from "./layouts";
import type { LayoutId, Page } from "./pages";
import { emLength, isFigure, type SlideBlock } from "./analyze";
import "./slideView.css";

export type SlideFit = {
  /** The body went one level smaller to fit (step one). */
  shrunk: boolean;
  /** It does not fit even then. */
  overflow: boolean;
};

type Props = {
  page: Page;
  layout: LayoutId;
  /** The theme's CSS variables (useDeckLook). */
  vars: Record<string, string>;
  render: (markdown: string) => ReactNode;
  /** Said once the slide has been measured (the picker shows the hints). */
  onFit?: (fit: SlideFit) => void;
  className?: string;
};

/** A table cell this short never wraps (a Chinese word is never one character a line); only a long sentence does. */
const SHORT_CELL_EM = 16;
/** The size ladder's lowest level: -1 is one level smaller (step one of 放不下); a table may go one more, down to the deck's smallest readable body size. */
const lowestLevel = (table: boolean) => (table ? -2 : -1);

type Relax = 0 | 1 | 2;
/** True when the element's content runs past its width. */
const overflowsWide = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 1;

const joined = (blocks: readonly SlideBlock[]) => blocks.map((block) => block.markdown).join("\n\n");

function Title({ page, tag: Tag = "h2" }: { page: Page; tag?: "h1" | "h2" }) {
  return page.parts.heading ? <Tag className="sv-title">{page.parts.heading}</Tag> : null;
}

/** The layout's content. Any layout takes any page: what a layout needs and the page lacks is made from what it has. */
function Layout({ page, layout, grow, render }: { page: Page; layout: LayoutId; grow: number; render: Props["render"] }) {
  const { parts } = page;
  const first = (kind: SlideBlock["kind"]) => parts.body.find((block) => block.kind === kind);
  // A picture or an embed (a drawing, a note, a task list): drawn as it is in the note.
  const firstFigure = () => parts.body.find(isFigure);
  const bigLine = parts.statement ?? parts.subtitle;
  // A slide with little on it grows its words and centres them (growLevel); 0 draws as before.
  const grown = grow > 0 ? ` sv-grow sv-grow-${grow}` : "";
  switch (layout) {
    case "cover":
      return <div className="sv-center sv-fit"><Title page={page} tag="h1" />{bigLine && <div className="sv-sub">{render(bigLine)}</div>}</div>;
    case "section":
      return (
        <div className="sv-center sv-fit">
          {parts.statement
            ? <>{parts.heading && <h2 className="sv-kicker">{parts.heading}</h2>}<div className="sv-statement">{render(parts.statement)}</div></>
            : <><Title page={page} tag="h1" />{parts.subtitle && <div className="sv-sub">{render(parts.subtitle)}</div>}</>}
        </div>
      );
    case "fullImage": {
      const image = firstFigure();
      return (
        <>
          {image && <div className="sv-bleed">{render(image.markdown)}</div>}
          <div className="sv-over"><Title page={page} tag="h1" />{!parts.heading && bigLine && <div className="sv-sub">{render(bigLine)}</div>}</div>
        </>
      );
    }
    case "media": {
      const image = firstFigure();
      const rest = parts.body.filter((block) => block !== image);
      const alone = !bigLine && rest.length === 0;
      return (
        <>
          <Title page={page} />
          <div className={`sv-media${alone ? " sv-media-alone" : ""}`}>
            {image && <figure className="sv-figure">{render(image.markdown)}</figure>}
            {!alone && <div className="sv-body sv-fit">{bigLine && render(bigLine)}{rest.length > 0 && render(joined(rest))}</div>}
          </div>
        </>
      );
    }
    case "quote": {
      const quote = first("quote");
      const rest = parts.body.filter((block) => block !== quote);
      return (
        <div className="sv-center sv-quote">
          {parts.heading && <h2 className="sv-kicker">{parts.heading}</h2>}
          <div className="sv-quote-text sv-fit">{render(quote?.markdown ?? (joined(parts.body) || bigLine || ""))}</div>
          {rest.length > 0 && <div className="sv-attribution">{render(joined(rest))}</div>}
        </div>
      );
    }
    case "compare": {
      const [left, right] = sidesOf(parts.body);
      return (
        <>
          <Title page={page} />
          <div className={`sv-cols sv-fit${grown}`}>
            <div className="sv-col">{render(joined(left))}</div>
            <div className="sv-col">{render(joined(right))}</div>
          </div>
        </>
      );
    }
    case "three": {
      const items = itemsOf(parts.body, 3);
      return (
        <>
          <Title page={page} />
          <div className={`sv-cards sv-fit${grown}`}>
            {items.map((item, i) => <div className="sv-card" key={i}><span className="sv-card-n">{i + 1}</span>{render(item)}</div>)}
          </div>
        </>
      );
    }
    case "stat": {
      const items = itemsOf(parts.body, 3);
      return (
        <>
          <Title page={page} />
          <div className="sv-stats sv-fit">
            {items.map((item, i) => {
              const { figure, caption } = splitStat(item);
              return <div className={`sv-stat${figure ? "" : " sv-stat-solo"}`} key={i}>{figure && <div className="sv-figure-big">{figure}</div>}<div className="sv-stat-caption">{caption}</div></div>;
            })}
          </div>
        </>
      );
    }
    case "timeline": {
      const steps = itemsOf(parts.body, 6);
      return (
        <>
          <Title page={page} />
          <ol className="sv-steps sv-fit">
            {steps.map((item, i) => {
              const { when, what } = splitStep(item);
              return <li key={i}><span className="sv-when">{when || i + 1}</span><span className="sv-what">{what}</span></li>;
            })}
          </ol>
        </>
      );
    }
    case "codeMath": {
      const main = parts.body.find((block) => block.kind === "code" || block.kind === "math") ?? parts.body[0];
      const caption = parts.body.filter((block) => block !== main);
      return (
        <>
          <Title page={page} />
          <div className="sv-code sv-fit">{main ? render(main.markdown) : bigLine && render(bigLine)}</div>
          {caption.length > 0 && <div className="sv-caption">{render(joined(caption))}</div>}
        </>
      );
    }
    case "bullets":
    case "text":
    default: {
      const table = hasTable(parts);
      // A table is never cut into two columns, and takes the slide's whole width, not a paragraph's line length.
      const long = layout === "bullets" && !table && itemsOf(parts.body).length > 6;
      // 條列 always shows its items as a list: a page of plain lines gets one bullet per line, its marks (bold, links) kept.
      const asList = layout === "bullets" && parts.body.length > 0 && parts.body.every((block) => block.kind === "paragraph");
      const bodyMarkdown = asList
        ? parts.body.flatMap((block) => block.markdown.split("\n")).map((line) => line.trim()).filter(Boolean).map((line) => `- ${line}`).join("\n")
        : joined(parts.body);
      return (
        <>
          <Title page={page} />
          <div className={`sv-body sv-fit${long ? " sv-two" : ""}${layout === "text" && !table ? " sv-measure" : ""}${table ? " sv-has-table" : ""}${grown}`}>
            {bigLine && render(bigLine)}{parts.body.length > 0 && render(bodyMarkdown)}
          </div>
        </>
      );
    }
  }
}

/** True when the element's content runs past its box (a canvas is laid out at full size, so the page's zoom does not matter). */
const overflows = (el: HTMLElement) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;

export default function SlideView({ page, layout, vars, render, onFit, className }: Props) {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.25);
  // False while the slide sits in something not drawn yet (the full-screen player's <dialog> opens after its content
  // mounts): nothing can be measured then, so the measuring below runs again once the frame has a size.
  const [shown, setShown] = useState(false);
  // The size ladder: a slide with little on it starts grown (growLevel: 2 or 1), and each time it measures too full it
  // steps one level down — through the body size to step one of 放不下 (-1, the body one level smaller). Reset
  // whenever what is drawn changes.
  const grow = growLevel(layout, page.parts);
  // The words themselves are in the key (not their count): a slide shrunk to fit grows back when text is cut.
  const drawn = `${page.key}|${layout}|${grow}|${joined(page.parts.body)}|${page.parts.heading}|${page.parts.statement}|${page.parts.subtitle}`;
  // `relax`, for a table still too WIDE at the smallest size: 1 lets its short cells wrap too, 2 lets a word with no
  // break point (an address) break anywhere. Too tall is never helped by either, so only a horizontal overflow takes them.
  const [sized, setSized] = useState<{ drawn: string; level: number; relax: Relax }>({ drawn, level: grow, relax: 0 });
  const level = sized.drawn === drawn ? sized.level : grow;
  const relax: Relax = sized.drawn === drawn ? sized.relax : 0;
  const shrunk = level < 0;
  const table = hasTable(page.parts);

  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const measure = () => { setShown(el.clientWidth > 0); if (el.clientWidth > 0) setScale(el.clientWidth / DECK_CANVAS.width); };
    measure();
    return observeSize(el, measure);
  }, []);

  // The theme's variables and the zoom are set on the canvas as properties (as SiteScope does), before it is measured.
  useLayoutEffect(() => {
    const host = canvas.current;
    if (!host) return;
    for (const [name, value] of Object.entries(vars)) host.style.setProperty(name, value);
    host.style.setProperty("--sv-scale", String(scale));
    host.style.setProperty("--sv-min-body", `${DECK_MIN_BODY_PX}px`);
  }, [vars, scale]);

  useLayoutEffect(() => {
    const host = canvas.current;
    if (!host) return;
    for (const cell of host.querySelectorAll<HTMLElement>("th, td")) cell.classList.toggle("sv-nowrap", relax === 0 && emLength(cell.textContent ?? "") <= SHORT_CELL_EM);
    const crowded = [...host.querySelectorAll<HTMLElement>(".sv-fit")].some(overflows);
    if (crowded && level > lowestLevel(table)) { setSized({ drawn, level: level - 1, relax }); return; }
    // At the smallest size and still too wide: wrapping the short cells may be what makes it fit (4 columns of 14
    // characters), then breaking an address (nothing else gives it a place to break).
    if (table && relax < 2 && [...host.querySelectorAll<HTMLElement>(".sv-fit")].some(overflowsWide)) { setSized({ drawn, level, relax: (relax + 1) as Relax }); return; }
    onFit?.({ shrunk, overflow: crowded });
  // render is a new function each time its caller renders; what is drawn is `drawn`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawn, level, relax, vars, shown]);

  return (
    <div ref={frame} className={`sv-frame${className ? ` ${className}` : ""}`}>
      <div ref={canvas} className={`sv-canvas sv-l-${layout}${shrunk ? " sv-shrunk" : ""}${level <= -2 ? " sv-shrunk-2" : ""}`} data-layout={layout} data-relax={relax || undefined}>
        <Layout page={page} layout={layout} grow={Math.max(level, 0)} render={render} />
      </div>
    </div>
  );
}
