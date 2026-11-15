import { useEffect, useMemo, useRef, useState } from "react";
import { Play } from "lucide-react";
import EmptyState from "../../components/EmptyState";
import { Img, Pressable } from "../../components/ui";
import { tn, useT } from "../../lib/i18n";
import { dateLabel } from "../../lib/timeLabels";
import { groupStories } from "./storyGroups";
import type { RssDisplayMode } from "./useRssUnread";
import { listRows, type DaySection } from "./rssSections";

// The article list: cut by day, a faint line where you left off last time,
// and — when something new arrived while you are further down — a small
// 「上面有新的」 that takes you to the top. At the top, new articles simply
// appear. No count and no 「mark all」: the list is a stream, not a pile.

export type RssListItem = {
  id: string;
  title: string;
  source_id: string;
  published_at: string | null;
  fetched_at: string;
  seen: boolean;
  /** A line of plain-text summary and the first image, for the list. */
  excerpt?: string;
  image?: string | null;
  /** What plays in it: a file (plays in the list) or a player link (the article shows it). */
  media?: { kind: "video" | "audio" | "embed"; url: string } | null;
};

type Props = {
  items: readonly RssListItem[] | null;
  today: string;
  /** The article this view was last on, read once when the view opened. */
  lastReadId: string | null;
  activeId: string | null;
  /** One feed is open: its name is left out of each row. */
  singleSource: boolean;
  sourceTitle: (id: string) => string;
  /** How a feed's articles look (the feed's 顯示方式). */
  displayModeOf?: (sourceId: string) => RssDisplayMode;
  hasNewer: boolean;
  nextCursor: string | null;
  loadingMore: boolean;
  onOpen: (id: string) => void;
  onLoadMore: () => void;
  /** Reload the top of the list (new articles arrived). */
  onShowNewer: () => void;
};

const SECTION_LABEL: Record<DaySection, string> = { today: "Today", yesterday: "Yesterday", earlier: "Earlier" };
/** Scrolled further than this from the top counts as 「not at the top」. */
const TOP_SLACK_PX = 48;

export default function RssItemList({ items, today, lastReadId, activeId, singleSource, sourceTitle, displayModeOf, hasNewer, nextCursor, loadingMore, onOpen, onLoadMore, onShowNewer }: Props) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [atTop, setAtTop] = useState(true);
  // At the top, new articles come in by themselves.
  useEffect(() => { if (hasNewer && atTop) onShowNewer(); }, [hasNewer, atTop, onShowNewer]);

  // The same story from several feeds is one row (storyGroups.ts); the others open under it.
  const stories = useMemo(() => groupStories(items ?? []), [items]);
  const storyOf = useMemo(() => new Map(stories.map((st) => [st.lead.id, st.others])), [stories]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const [playing, setPlaying] = useState<string | null>(null);

  function itemRow(it: RssListItem, sub = false) {
    const mode = displayModeOf?.(it.source_id) ?? "text";
    // Many feeds open the summary with the title again; skip that copy.
    const text = (it.excerpt ?? "").startsWith(it.title) ? (it.excerpt ?? "").slice(it.title.length).replace(/^[\s—–\-:：|·]+/, "") : it.excerpt ?? "";
    const cover = mode === "image" && it.image;
    return (
      <div key={it.id} className="rss-item-wrap">
        <Pressable data-item-id={it.id}
          className={["rss-item", mode !== "text" ? `rss-item--${mode}` : "", sub ? "rss-item-sub" : "", activeId === it.id ? "active" : "", it.seen ? "read" : ""].filter(Boolean).join(" ")}
          onClick={() => onOpen(it.id)}>
          {cover && <Img className="rss-item-cover" src={it.image!} alt="" loading="lazy" referrerPolicy="no-referrer" />}
          <span className="rss-item-text">
            <span className="rss-item-title">{it.title}</span>
            {text && !cover ? <span className="rss-item-excerpt">{text}</span> : null}
            <span className="rss-item-meta">
              {singleSource ? dateLabel(it.published_at, "short") : [sourceTitle(it.source_id), dateLabel(it.published_at, "short")].filter(Boolean).join(" · ")}
            </span>
          </span>
          {it.image && !cover && <Img className="rss-item-thumb" src={it.image} alt="" loading="lazy" referrerPolicy="no-referrer" />}
        </Pressable>
        {mode === "video" && it.media && (playing === it.id && it.media.kind !== "embed" ? (
          it.media.kind === "video"
            ? <video className="rss-item-player" src={it.media.url} controls autoPlay preload="none" />
            : <audio className="rss-item-player" src={it.media.url} controls autoPlay preload="none" />
        ) : (
          <Pressable className="rss-item-play" aria-label={t("Play {title}", { title: it.title })}
            onClick={() => (it.media!.kind === "embed" ? onOpen(it.id) : setPlaying(it.id))}>
            <Play size={14} aria-hidden /> {it.media.kind === "audio" ? t("Listen") : t("Play")}
          </Pressable>
        ))}
      </div>
    );
  }

  const showToTop = () => {
    box.current?.scrollTo?.({ top: 0 });
    onShowNewer();
  };

  return (
    <div className="rss-item-list" ref={box} onScroll={(e) => setAtTop(e.currentTarget.scrollTop <= TOP_SLACK_PX)}>
      {hasNewer && !atTop && (
        <Pressable className="rss-newer" onClick={showToTop}>{t("New above")}</Pressable>
      )}
      {items === null ? (
        <EmptyState size="inline" title={t("Loading…")} />
      ) : items.length === 0 ? (
        <EmptyState size="inline" title={t("Nothing here.")} />
      ) : listRows(stories.map((st) => st.lead), today, lastReadId).map((row) => {
        if (row.kind === "section") return <div key={`s-${row.key}`} className="rss-day" role="presentation">{t(SECTION_LABEL[row.key])}</div>;
        if (row.kind === "last-read") return <div key={`l-${row.key}`} className="rss-last-read" role="separator">{t("You left off here")}</div>;
        const others = storyOf.get(row.item.id) ?? [];
        const open = expanded.has(row.item.id);
        return (
          <div key={row.item.id} className="rss-story" data-story-size={others.length + 1}>
            {itemRow(row.item)}
            {others.length > 0 && (
              <Pressable className="rss-story-more" aria-expanded={open}
                onClick={() => setExpanded((prev) => { const next = new Set(prev); if (!next.delete(row.item.id)) next.add(row.item.id); return next; })}>
                {tn("1 more source", "{n} more sources", others.length)}
              </Pressable>
            )}
            {open && others.map((o) => itemRow(o, true))}
          </div>
        );
      })}
      {items !== null && nextCursor && (
        <Pressable className="rss-load-more" disabled={loadingMore} onClick={onLoadMore}>
          {loadingMore ? t("Loading…") : t("Load more")}
        </Pressable>
      )}
    </div>
  );
}
