import { randomUUID } from "../../lib/uuid";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { ExternalLink, PenLine, Quote, Rss } from "lucide-react";
import { dayNotes, latestOnly, reads, sendOrQueue, sendWrite, writeErrors } from "../../lib/data";
import { addToast, getNode, useTagRows, useAllNodes } from "../../lib/appStore";
import { ReaderArticle } from "../../components/markdownSurfaces";
import { markRssVisited, useRssUnread, type RssDestination, type RssSource } from "./useRssUnread";
import { useRssCounts } from "./rssCounts";
import { readingPosition, rememberPosition, swipeIntent, viewKey, type TouchPoint } from "./readingPosition";
import RssSourceSheet from "./RssSourceSheet";
import { unmute, muteWords, muteWordOf } from "./rssMutes";
import RssWeekCard from "./RssWeekCard";
import RssItemList from "./RssItemList";
import RssSourceBar, { VOICES_VIEW } from "./RssSourceBar";
import RssSourcesSheet from "./RssSourcesSheet";
import RssSaveSheet from "./RssSaveSheet";
import RssSaveControl from "./RssSaveControl";
import RssNotePickSheet from "./RssNotePickSheet";
import RssLinkedPage, { type LinkedPage } from "./RssLinkedPage";
import { appendQuote, appendToNote, defaultQuoteTarget, draftBlock, excerptEmbed, knownExcerpt, loadPageExcerpts, rememberQuoteTarget, startDraft, type AppendResult, type KnownExcerpt, type Passage, type QuoteSource } from "./rssQuote";
import { destinationLabel } from "./RssDestinationFields";
import { looksLikeSummary } from "./fullText";
import { useT, tn } from "../../lib/i18n";
import { dateLabel } from "../../lib/timeLabels";
import "./RssReaderPanel.css";
import { Button, ColumnResizer, keepFocus, Link, Pressable, layerClass } from "../../components/ui";
import { useColumnWidth, type PaneColumn } from "../../lib/paneWidths";
import { PREFS } from "../../lib/prefs";
import PanelHeader from "../../components/PanelHeader";

import { ellipsize, excerptContext, withinPrefix } from "@onden/markdown";
import { findDayNode } from "../../lib/dayNode";
import { useToday } from "../../hooks/useToday";
import { displayTitle } from "../../lib/noteLabel";
import EmptyState from "../../components/EmptyState";
import { clearSelection, createRange, currentSelection, onSelectionChange, queryElement, selectionText } from "../../lib/documentAccess";
import { useHistoryEntry } from "../../hooks/useHistoryEntry";
import { useDismiss } from "../../hooks/useEscapeKey";
// The reading surface (modules/rss). Left: sources (numbers only with
// 「顯示未讀數字」, rssCounts) + the item list; right: the article, rendered
// through MarkdownRenderer's html-enabled (raw + sanitize) path.
//
// A reading position, not read/unread (readingPosition.ts): each view (All
// feeds, each feed) remembers the article you were on, and opening the view
// again resumes there. LEAVING an article marks it SEEN — moving to another
// one (list, swipe, the cards at its end) or leaving the reader; "seen", not
// "read": skimming past is a non-event, not a debt. Nothing is marked on
// scroll. A thin bar shows how far along the list you are. 全部略過 marks the
// view seen and can be undone from its toast.
//
// Quote, don't hoard (rssQuote.ts). Selecting text offers where to put it:
// 「放進今天的日記」 (leads; not offered with the 日記 module off), 「放進〈上次用的
// 筆記〉」 (the last one chosen, else the feed's default parent note), and
// 「別篇筆記…」. The selection is written as an EXCERPT — a quote with its source
// link and a hidden id (@onden/markdown excerpt.ts, docs/architecture/
// excerpts.md); one toast with 復原. A passage this device already holds an
// excerpt of is not written twice: the bar says where it is and offers to open
// that note or to embed it in another. The end of an article leads with
// 「寫點什麼」: a new draft, or added to an existing note, carrying embeds of
// this session's excerpts (their ids kept in memory only) or the article's link.
//
// The stream/library split ([[rss-rebuild]] revision): an article is a
// rss_staging row — NOT a node — until 存 (save) materializes it. Saving the
// whole article (RssSaveControl) is the secondary action at the end: tap
// saves at the feed's default, ▾ opens the 「存到」 sheet (POST
// /items/:id/save, THE node-creating moment, spine, authored by you). Full
// text loads by itself when the feed's text looks like a summary or the feed
// is set to 總是載入全文 (POST /items/:id/fulltext, the buffer body replaced);
// a small 載入全文 link stays at the end when that failed or did not run.

type ItemRow = {
  id: string;
  title: string;
  source_id: string;
  url: string | null;
  published_at: string | null;
  fetched_at: string;
  seen: boolean;
  saved_node_id: string | null;
  /** A line of plain-text summary and the first image, for the list. */
  excerpt?: string;
  image?: string | null;
};

type Article = ItemRow & { body: string };

type Props = {
  online: boolean;
  /** Drawer close — omitted when the reader is a full page (its own mode). */
  onClose?: () => void;
  onOpenNode: (id: string) => void;
  /** Refresh the host's bootstrap data (after a save). */
  onRefresh?: () => void;
  /** Deep-link: open this article immediately. */
  initialItemId?: string | null;
  /** Deep-link: land on one source's list (the inbox strip's 讀 action). */
  initialSourceId?: string | null;
  /** Reading-immersion signal: true while an article is open. The host uses
   *  it (mobile) to drop app chrome — reading is the next navigation layer,
   *  the list layer's UI must leave the screen entirely. */
  onArticleOpenChange?: (open: boolean) => void;
};

const PAGE = 20;

/** A relative image in a feed body is the ARTICLE's (minified pages write
 *  `src=/assets/a.png`), never ours: resolve it against the article's url.
 *  Bodies stored before the backend absolutized unquoted values need this. */
export function articleImageSrc(src: string, articleUrl: string | null | undefined): string {
  if (!src || !articleUrl || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) return src;
  try { return new URL(src, articleUrl).href; } catch { return src; }
}

/** The list column; the stylesheet's default is `fallback` (RssReaderPanel.css). */
const LIST_COLUMN: PaneColumn = { min: 180, max: 560, fallback: 240, pref: PREFS.readerListWidth };

export default function RssReaderPanel({ online, onClose, onOpenNode, onRefresh, initialItemId, initialSourceId, onArticleOpenChange }: Props) {
  const t = useT();
  const { sources, moduleDefault, latestUnseenAt, refresh: refreshSources } = useRssUnread(30_000);
  const counts = useRssCounts();
  // The reader is open: what has arrived so far is no longer new for the nav dot.
  useEffect(() => { markRssVisited(); }, [latestUnseenAt]);
  const storeTags = useTagRows();
  const [activeSource, setActiveSource] = useState<string | null>(initialSourceId ?? null);
  const [listWidth, setListWidth] = useColumnWidth(LIST_COLUMN);
  const [items, setItems] = useState<ItemRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [article, setArticle] = useState<Article | null>(null);
  // A page of the same source opened from a link in the article: shown over it, the article kept (and its place) below.
  const [linked, setLinked] = useState<LinkedPage | null>(null);
  // The article a link was followed from, while what it opened is shown: 「‹ 回到…」 goes back to it.
  const [linkedFrom, setLinkedFrom] = useState<{ id: string; title: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The 「來源」 sheet (add / fetch / edit feeds) is open.
  const [sourcesOpen, setSourcesOpen] = useState(false);
  // The feed whose settings sheet is open (⋯ beside it).
  const [sheetSource, setSheetSource] = useState<RssSource | null>(null);
  // The article whose 「存到」 sheet is open.
  const [saving, setSaving] = useState<Article | null>(null);
  // The live selection in the article, with the words around it (the quote bar while set).
  const [quote, setQuote] = useState<Passage | null>(null);
  // The excerpt this device already holds of the selection (the bar offers it instead of a copy).
  const [known, setKnown] = useState<{ noteId: string; words: string } | null>(null);
  // The note picker: for a quote (its passage kept, since focusing the picker
  // clears the selection), for embedding a known excerpt, or for 「寫點什麼」 › 加到現有筆記….
  const [picking, setPicking] = useState<{ kind: "quote"; passage: Passage } | { kind: "embed"; noteId: string; words: string } | { kind: "write" } | null>(null);
  // 「寫點什麼」's choice (新草稿 / 加到現有筆記…) is open.
  const [writeOpen, setWriteOpen] = useState(false);
  // Back and Esc fold the choice away first, then Back goes on to leave the article.
  useDismiss(() => setWriteOpen(false), writeOpen);
  // This reading session's excerpts, per article (the note holding it and its id) — memory only, never stored.
  const sessionQuotes = useRef(new Map<string, Array<{ noteId: string; words: string }>>());
  const writing = useRef(false);
  // The excerpts of the open article's page this device already holds: worked
  // out in the background when it opens (a click only reads what is there; before
  // it arrives a passage is simply written), plus this session's own.
  const pageExcerpts = useRef<KnownExcerpt[]>([]);
  const storeNodes = useAllNodes();
  const articleRef = useRef<HTMLDivElement>(null);
  const openedInitial = useRef(false);
  // The open article's automatic full text: running, loaded, failed, or not
  // attempted ("skipped": the text looked complete, offline, no link).
  const [fullText, setFullText] = useState<{ id: string; status: "loading" | "done" | "failed" | "skipped" } | null>(null);
  // Latest values for callbacks that outlive a render (leaving on unmount,
  // the full-text decision after the article arrives).
  const current = useRef<Article | null>(null);
  current.current = article;
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const activeSourceRef = useRef(activeSource);
  activeSourceRef.current = activeSource;
  // The view whose position was last resumed (once per visit to a view), and
  // which way the article came in (the slide, skipped for reduced motion).
  const resumedView = useRef<string | null>(initialItemId ? viewKey(initialSourceId ?? null) : null);
  // The article this view was last on when it opened: the 「你讀到這裡」 line (not moved while you read).
  const [lastReadId, setLastReadId] = useState<string | null>(null);
  const [enterFrom, setEnterFrom] = useState<"next" | "prev" | null>(null);

  // Only the newest list request may show its answer: switching feeds quickly must not end on the earlier feed's articles.
  const itemsRead = useRef(latestOnly());
  const loadItems = useCallback(async (cursor?: string | null) => {
    const isCurrent = itemsRead.current.begin();
    try {
      const qs = new URLSearchParams();
      if (activeSource === VOICES_VIEW) qs.set("voice", "person");
      else if (activeSource) qs.set("source", activeSource);
      qs.set("limit", String(PAGE));
      if (cursor) qs.set("cursor", cursor);
      const r = await reads.modules.rss.items<{ items: ItemRow[]; next_cursor: string | null }>(qs);
      if (!isCurrent()) return;
      setItems((prev) => (cursor ? [...(prev ?? []), ...r.items] : r.items));
      setNextCursor(r.next_cursor);
      if (!cursor) resumeRef.current(viewKey(activeSource), r.items);
    } catch (e) {
      if (!isCurrent()) return;
      if (!cursor) setItems([]);
      setNotice(writeErrors.requestMessage(e, t("Could not load articles")));
    }
  }, [activeSource, t]);

  useEffect(() => { void loadItems(); }, [loadItems]);

  /** The article being left becomes seen (moving on, or leaving the
   *  reader); reflected locally without a refetch. */
  const markLeft = useCallback((a: Article | null) => {
    if (!a || a.seen) return;
    setItems((prev) => prev?.map((it) => it.id === a.id ? { ...it, seen: true } : it) ?? prev);
    void sendWrite("POST", `/api/rss/items/${a.id}/seen`, "{}").then(() => refreshSources()).catch(() => null);
  }, [refreshSources]);

  /** Back to the list (or another feed): the open article is left. */
  const closeArticle = useCallback(() => {
    markLeft(current.current);
    setArticle(null);
    setLinked(null);
    setLinkedFrom(null);
  }, [markLeft]);

  /** 「‹ 列表」: the place stays on this article, but the view reopens on
   *  the list next time. */
  function backToList() {
    const a = current.current;
    if (a) rememberPosition(viewKey(activeSourceRef.current), { id: a.id, open: false });
    closeArticle();
  }
  // An open article is a page of its own: Back returns to the list (previous / next keep the one entry).
  const articleEntry = useHistoryEntry(article !== null, backToList, "ondenArticle");

  // Leaving the reader (unmount) leaves the open article too.
  const markLeftRef = useRef(markLeft);
  markLeftRef.current = markLeft;
  useEffect(() => () => markLeftRef.current(current.current), []);

  /** Load the full article in place of the feed's text (載入全文): `auto`
   *  when the reader decided to, so a failure is quiet (the link offers it). */
  const loadFulltext = useCallback(async (a: Article, auto: boolean) => {
    setFullText({ id: a.id, status: "loading" });
    if (!auto) setNotice(null);
    try {
      const r = await sendWrite<{ body?: string }>("POST", `/api/rss/items/${a.id}/fulltext`, "{}");
      // Only a real article replaces the feed's text.
      if (typeof r?.body !== "string" || !r.body.trim()) throw new Error(t("Could not load the full article"));
      const body = r.body;
      setArticle((prev) => prev && prev.id === a.id ? { ...prev, body } : prev);
      setFullText((prev) => prev?.id === a.id ? { id: a.id, status: "done" } : prev);
    } catch (e) {
      setFullText((prev) => prev?.id === a.id ? { id: a.id, status: "failed" } : prev);
      if (!auto) setNotice(writeErrors.requestMessage(e, t("Could not load the full article")));
    }
  }, [t]);

  /** Open an article: the one before is left (seen), and this view's place
   *  moves here. `resume` (reopening the view) fails quietly and forgets a
   *  place that is gone; `from` slides the article in from that side. */
  const openItem = useCallback(async (id: string, opts: { resume?: boolean; from?: "next" | "prev"; viaLink?: boolean } = {}) => {
    setQuote(null);
    setWriteOpen(false);
    setNotice(null);
    setLinked(null);
    if (!opts.viaLink) setLinkedFrom(null);
    if (current.current && current.current.id !== id) markLeft(current.current);
    const view = viewKey(activeSourceRef.current);
    try {
      const a = await reads.modules.rss.item<Article>(id);
      setEnterFrom(opts.from ?? null);
      setArticle(a);
      rememberPosition(view, { id: a.id, open: true });
      // Full text by itself when the feed gives a summary, or always for a
      // feed set so; never for a saved article (the note owns its text).
      const feed = sourcesRef.current?.find((s) => s.id === a.source_id);
      const wanted = !!feed?.always_fulltext || looksLikeSummary(a.body ?? "");
      if (wanted && !a.saved_node_id && a.url && online) void loadFulltext(a, true);
      else setFullText({ id: a.id, status: "skipped" });
    } catch (e) {
      if (opts.resume) return;
      setNotice(writeErrors.requestMessage(e, t("Could not open the article")));
    }
  }, [online, markLeft, loadFulltext, t]);

  /** A link clicked inside the article. Another article of the same feed is read here: one the reader already
   *  holds opens like 下一篇, any other page under the feed's own address is fetched once and shown over the article.
   *  Everything else (「原文」 above the article and a link to the article itself too), and a modified click, is the
 *  browser's as before (decided now, so the new tab is not blocked). */
  const onArticleClickCapture = (e: React.MouseEvent) => {
    const from = current.current;
    if (!from || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const anchor = (e.target as Element).closest?.("a[href]");
    if (!(anchor instanceof HTMLAnchorElement) || (anchor.getAttribute("href") ?? "").startsWith("#")) return;
    const url = anchor.href;
    // 「原文」 and a link to this very article are the way out to the site: reading the article over itself is no answer.
    if (!anchor.closest(".rss-article-body") || (from.url && url.split("#")[0] === from.url.split("#")[0])) return;
    const held = items?.find((it) => it.url && it.url.split("#")[0] === url.split("#")[0] && it.id !== from.id);
    const prefix = sourcesRef.current?.find((x) => x.id === from.source_id)?.article_prefix ?? null;
    if (!held && !(online && withinPrefix(url, prefix))) return;
    e.preventDefault();
    setLinkedFrom({ id: from.id, title: from.title });
    if (held) { void openItem(held.id, { viaLink: true }); return; }
    setLinked({ url, status: "loading" });
    void (async () => {
      try {
        const answer = await reads.modules.rss.link<{ kind: "item"; id: string } | { kind: "page"; url: string; title: string; body: string } | { kind: "outside" | "failed" }>(from.id, url);
        if (answer.kind === "item") void openItem(answer.id, { viaLink: true });
        else if (answer.kind === "page") setLinked((now) => now?.url === url ? { url: answer.url, status: "page", title: answer.title, body: answer.body } : now);
        else setLinked((now) => now?.url === url ? { url, status: "failed" } : now);
      } catch {
        setLinked((now) => now?.url === url ? { url, status: "failed" } : now);
      }
    })();
  };
  /** 「‹ 回到…」: the page shown over the article closes; an article opened by the link gives way to the one before. */
  const backFromLink = () => {
    const from = linkedFrom;
    setLinkedFrom(null);
    if (linked) { setLinked(null); return; }
    if (from) void openItem(from.id);
  };
  const linkEntry = useHistoryEntry(linkedFrom !== null, backFromLink, "ondenRssLink");

  /** A view's list arrived: the first time per visit, go back to its place —
   *  the article itself when it was open, else the list scrolled to it. */
  const resumeRef = useRef<(view: string, rows: ItemRow[]) => void>(() => {});
  resumeRef.current = (view, rows) => {
    if (resumedView.current === view) return;
    resumedView.current = view;
    setLastReadId(readingPosition(view)?.id ?? null);
    if (current.current) return;
    const pos = readingPosition(view);
    if (!pos) return;
    if (pos.open) { void openItem(pos.id, { resume: true }); return; }
    if (rows.some((it) => it.id === pos.id)) {
      requestAnimationFrame(() => {
        queryElement(`.rss-item[data-item-id="${pos.id}"]`)?.scrollIntoView?.({ block: "center" });
      });
    }
  };

  // Deep-link (home line / inbox strip).
  useEffect(() => {
    if (initialItemId && !openedInitial.current) {
      openedInitial.current = true;
      void openItem(initialItemId);
    }
  }, [initialItemId, openItem]);
  useEffect(() => {
    if (initialSourceId) { setActiveSource(initialSourceId); closeArticle(); }
  }, [initialSourceId, closeArticle]);

  // Immersion signal: article open/closed (and closed again on unmount).
  useEffect(() => {
    onArticleOpenChange?.(article !== null);
  }, [article, onArticleOpenChange]);
  useEffect(() => () => onArticleOpenChange?.(false), [onArticleOpenChange]);

  // Touch: swipe left = the next article, swipe right = the previous one —
  // the cards at the article's end sit the same way round. swipeIntent takes
  // only quick, clearly horizontal flicks, so vertical scrolling and text
  // selection (long-press, handles) are never hijacked; horizontally
  // scrollable pre/table/media and two-finger gestures are left alone.
  const touchStart = useRef<TouchPoint | null>(null);
  function onArticleTouchStart(e: React.TouchEvent) {
    const t0 = e.touches[0];
    const el = e.target as Element;
    touchStart.current = !t0 || e.touches.length > 1 || el.closest("pre, table, audio, video, input, textarea")
      ? null : { x: t0.clientX, y: t0.clientY, t: e.timeStamp || Date.now() };
  }
  function onArticleTouchEnd(e: React.TouchEvent) {
    const start = touchStart.current;
    touchStart.current = null;
    const t0 = e.changedTouches[0];
    if (!start || !t0) return;
    const selecting = selectionText().trim().length > 0;
    const intent = swipeIntent(start, { x: t0.clientX, y: t0.clientY, t: e.timeStamp || Date.now() }, { selecting });
    if (intent === "next" && nextItem) void openItem(nextItem.id, { from: "next" });
    else if (intent === "prev" && prevItem) void openItem(prevItem.id, { from: "prev" });
  }

  /** 「少看這種」: the selected words, matched against titles only, for a week. */
  async function seeLess(passage: Passage) {
    const word = muteWordOf(passage.text);
    if (!word) return;
    try {
      const id = await muteWords(word);
      setQuote(null);
      clearSelection();
      void refreshSources();
      void loadItems();
      addToast(t("Fewer titles with “{word}” for a week.", { word: ellipsize(word, 24) }), "success", {
        label: t("Undo"),
        onClick: () => void unmute(id).then(() => { void refreshSources(); void loadItems(); }).catch((e) => writeErrors.report(e, addToast)),
      });
    } catch (e) {
      writeErrors.report(e, addToast);
    }
  }

  /** A feed left this list (unsubscribed, or muted for a week): say so, and drop what depended on it. */
  function feedLeft(source: RssSource, message: string) {
    setSheetSource(null);
    setNotice(message);
    if (activeSource === source.id) setActiveSource(null);
    if (article?.source_id === source.id) closeArticle();
    void refreshSources();
    void loadItems();
  }
  const unsubscribed = (source: RssSource) => feedLeft(source, t("Unsubscribed from “{title}”. Articles you saved stay.", { title: source.title }));
  const mutedFeed = (source: RssSource) => feedLeft(source, t("Muted “{title}” for a week. Bring it back from the Sources panel.", { title: source.title }));

  /** 留 — save: THE node-creating moment. Idempotent on the server; a
   *  client-minted id keeps offline replays converging on one node. Returns
   *  the note's id (existing one if the article was already saved) and whether
   *  the save is only queued — not whether the browser happens to be online. */
  const saveArticle = useCallback(async (a: Article, destination?: RssDestination): Promise<{ nodeId: string; queued: boolean }> => {
    if (a.saved_node_id) return { nodeId: a.saved_node_id, queued: false };
    const minted = randomUUID();
    // No destination: the server files it at the feed's save default.
    const body = destination
      ? { node_id: minted, destination: { tag_ids: destination.tagIds, parent_id: destination.parentId } }
      : { node_id: minted };
    const res = await sendOrQueue("POST", `/api/rss/items/${a.id}/save`, JSON.stringify(body), undefined, minted);
    const nodeId = res === undefined ? minted : ((res as { node_id?: string }).node_id ?? minted);
    setArticle((prev) => prev && prev.id === a.id ? { ...prev, saved_node_id: nodeId, seen: true } : prev);
    setItems((prev) => prev?.map((it) => it.id === a.id ? { ...it, saved_node_id: nodeId, seen: true } : it) ?? prev);
    return { nodeId, queued: res === undefined };
  }, []);

  /** 存 — save at `destination`, or at the feed's default. Throws (after
   *  saying why) so a sheet that asked can stay open. */
  async function keepArticle(a: Article, destination?: RssDestination) {
    if (busy) return;
    setBusy(true);
    try {
      const { queued } = await saveArticle(a, destination);
      setNotice(queued ? writeErrors.queuedMessage() : t("Saved — it's a regular note now."));
      setSaving(null);
      onRefresh?.();
    } catch (e) {
      setNotice(writeErrors.message(e));
      throw e;
    } finally { setBusy(false); }
  }

  /** The feed's save default, as the server resolved it. */
  function defaultFor(sourceId: string): RssDestination {
    const d = (sources ?? []).find((s) => s.id === sourceId)?.save_default;
    return d ? { tagIds: d.tag_ids, parentId: d.parent_id } : { tagIds: [], parentId: null };
  }
  // One-tap extra tags in the sheet: the folders the other feeds and the
  // module default already use.
  const quickTagIds = [...new Set([...(sources ?? []).flatMap((s) => s.save_default?.tag_ids ?? []), ...(moduleDefault?.tag_ids ?? [])])];

  // Double-tap a paragraph = quote the whole block (Readwise Reader's mobile
  // shortcut — dragging selection handles on a phone is the painful path).
  function onArticleDoubleClick(e: React.MouseEvent) {
    const block = (e.target as Element).closest("p, li, blockquote");
    const text = cleanQuote(block?.textContent ?? "");
    if (text.length >= 2 && block && articleRef.current) {
      const range = createRange();
      range.selectNodeContents(block);
      setQuote({ text, ...contextAround(articleRef.current, range) });
    }
  }

  // The selection inside the article → the quote bar. `selectionchange`
  // covers touch (long-press and handles: the article is plain HTML, not
  // CodeMirror, so the editor's touch toolbar does not apply), the keyboard
  // and the mouse; mouseup stays for browsers that fire it first. A
  // selection that collapses closes the bar, except while a finger or the
  // mouse is down on the bar itself.
  const onBar = useRef(false);
  const readSelection = useCallback(() => {
    const sel = currentSelection();
    const text = cleanQuote(sel?.toString() ?? "");
    if (text.length >= 2 && articleRef.current && sel && sel.rangeCount > 0 && articleRef.current.contains(sel.anchorNode)) {
      setQuote({ text, ...contextAround(articleRef.current, sel.getRangeAt(0)) });
    } else if (!onBar.current) setQuote(null);
  }, []);
  useEffect(() => {
    if (!article) return;
    return onSelectionChange(readSelection);
  }, [article, readSelection]);

  const articleUrl = article?.url ?? null;
  useEffect(() => {
    const mine: KnownExcerpt[] = [];
    pageExcerpts.current = mine;
    let live = true;
    void loadPageExcerpts(articleUrl).then((found) => { if (live) mine.push(...found); });
    return () => { live = false; };
  }, [article?.id, articleUrl]);

  // A different selection is a different question: forget what was found for the last one.
  useEffect(() => { setKnown(null); }, [quote?.text]);

  const sourceOf = (a: Article): QuoteSource => ({ title: a.title, url: a.url, feed: sourceTitle(a.source_id) });
  // Read at call time: a note started a moment ago (today's) is not in this render's `storeNodes` yet.
  const noteTitle = (id: string) => displayTitle(getNode(id)?.title);

  /** One append (a quote, or 寫點什麼's text) went through: say where, offer
   *  復原 — one undo step that removes exactly that text. */
  function appended(r: AppendResult, targetId: string, onUndone?: () => void) {
    const title = noteTitle(targetId);
    // Queued names the note it will land in, and does not look like a success.
    addToast(r.status === "queued"
      ? t("Added to “{title}” on this device — it will sync when the server is reachable.", { title })
      : t("Added to “{title}”.", { title }), r.status === "queued" ? "info" : "success", {
      label: t("Undo"),
      onClick: () => void r.undo().then((done) => {
        if (done) onUndone?.();
        else addToast(t("That text was edited since, so it was left in place."), "info");
      }).catch((e) => writeErrors.report(e, addToast)),
    });
  }

  /** Put the selection into `targetId` as an excerpt (the default, or picked). */
  async function quoteInto(targetId: string, passage: Passage) {
    if (!article || writing.current) return;
    writing.current = true;
    try { await writeQuote(article, targetId, passage); } finally { writing.current = false; }
  }

  async function writeQuote(article: Article, targetId: string, passage: Passage) {
    const articleId = article.id;
    try {
      const source = sourceOf(article);
      const r = await appendQuote(targetId, { passage, source });
      rememberQuoteTarget(targetId);
      const list = sessionQuotes.current.get(articleId) ?? [];
      sessionQuotes.current.set(articleId, [...list, { noteId: targetId, words: r.words }]);
      if (article.url) pageExcerpts.current.push({ noteId: targetId, excerpt: { id: "" /* the server anchors it later */, exact: passage.text, prefix: passage.prefix, suffix: passage.suffix, url: article.url, title: source.title, feed: source.feed } });
      setQuote(null);
      clearSelection();
      appended(r, targetId, () => {
        const now = sessionQuotes.current.get(articleId) ?? [];
        sessionQuotes.current.set(articleId, now.filter((q) => q.words !== r.words));
      });
    } catch (e) {
      writeErrors.report(e, addToast);
    }
  }

  /** 「放進今天的日記」: today's note, started when there is none. Holds the
   *  write lock from the tap, so a second tap while today's note opens writes nothing. */
  async function quoteIntoToday(passage: Passage) {
    if (!article || writing.current) return;
    writing.current = true;
    try {
      const today = await dayNotes.openToday();
      if (today) await writeQuote(article, today.node.id, passage);
    } catch (e) {
      writeErrors.report(e, addToast);
    } finally { writing.current = false; }
  }

  /** The default note for quotes from this article's feed, if any. */
  const quoteTarget = article ? defaultQuoteTarget(defaultFor(article.source_id).parentId) : null;
  const today = useToday();

  // New articles arrived since the list was loaded (the poll's newest arrival is
  // later than the newest row we hold). Each arrival is answered once, so one that
  // never shows in this list (muted, another feed) cannot keep the hint up.
  const newestArrival = activeSource ? sources?.find((x) => x.id === activeSource)?.latest_unseen_at ?? null : latestUnseenAt;
  const newestLoaded = (items ?? []).reduce((m, it) => Math.max(m, Date.parse(it.fetched_at) || 0), 0);
  const [answeredArrival, setAnsweredArrival] = useState<string | null>(null);
  const hasNewer = items !== null && !!newestArrival && newestArrival !== answeredArrival && Date.parse(newestArrival) > newestLoaded;
  const showNewer = useCallback(() => {
    setAnsweredArrival(newestArrival);
    void loadItems();
  }, [newestArrival, loadItems]);
  const todayNoteId = dayNotes.enabled() ? findDayNode(storeNodes, today)?.id ?? null : null;

  /** A tap on one of the bar's choices. A passage this device already holds an
   *  excerpt of is not written again: `known` swaps the bar's choices for
   *  where it is. Only what the background lookup has found is read, so a tap
   *  never waits; nothing found (or not worked out yet) = write it. */
  function choose(passage: Passage, put: () => void) {
    if (!article || writing.current) return;
    const found = knownExcerpt(pageExcerpts.current, article.url, passage.text);
    if (found) setKnown({ noteId: found.noteId, words: found.excerpt.exact });
    else put();
  }

  /** 「寫點什麼」's embeds of this session's excerpts. */
  const sessionEmbeds = (articleId: string) => (sessionQuotes.current.get(articleId) ?? []).map((q) => excerptEmbed(noteTitle(q.noteId), q.words));

  /** 「寫點什麼」: this session's quotes from the article (or its link). */
  async function writeDraft() {
    if (!article || writing.current) return;
    writing.current = true;
    try {
      const { nodeId, status } = await startDraft({
        embeds: sessionEmbeds(article.id), source: sourceOf(article), destination: defaultFor(article.source_id),
      });
      setWriteOpen(false);
      if (status === "queued") addToast(writeErrors.queuedMessage(), "info");
      onOpenNode(nodeId);
      onClose?.();
    } catch (e) {
      writeErrors.report(e, addToast);
    } finally { writing.current = false; }
  }

  /** 「引用它到別篇筆記…」: embed an excerpt already held, not a second copy. */
  async function embedInto(targetId: string, excerpt: { noteId: string; words: string }) {
    if (!article || writing.current) return;
    writing.current = true;
    try {
      const r = await appendToNote(targetId, excerptEmbed(noteTitle(excerpt.noteId), excerpt.words));
      rememberQuoteTarget(targetId);
      setQuote(null);
      clearSelection();
      appended(r, targetId);
    } catch (e) {
      writeErrors.report(e, addToast);
    } finally { writing.current = false; }
  }

  async function writeInto(targetId: string) {
    if (!article || writing.current) return;
    writing.current = true;
    try {
      const r = await appendToNote(targetId, draftBlock(sessionEmbeds(article.id), sourceOf(article)));
      setWriteOpen(false);
      appended(r, targetId);
    } catch (e) {
      writeErrors.report(e, addToast);
    } finally { writing.current = false; }
  }

  /** Where 存 puts an article from feed `sourceId`, in one short line. */
  const saveLabel = (sourceId: string) => {
    const d = (sources ?? []).find((s) => s.id === sourceId)?.save_default;
    return destinationLabel({ tagIds: d?.tag_ids ?? [], parentId: d?.parent_id ?? null, parentTitle: d?.parent_title }, storeTags ?? [], t);
  };

  const sourceTitle = (id: string | null) =>
    (sources ?? []).find((s) => s.id === id)?.title ?? "";

  // Previous / next follow the list order, so they match what the list shows.
  // An article opened from elsewhere (not in the list) continues with the
  // first unseen one.
  const listIndex = article ? (items ?? []).findIndex((it) => it.id === article.id) : -1;
  const prevItem = listIndex > 0 ? items![listIndex - 1]! : null;
  const nextItem = listIndex >= 0
    ? items![listIndex + 1] ?? null
    : (items ?? []).find((it) => it.id !== article?.id && !it.seen) ?? null;
  // Reading near the end of the loaded page fetches the next one, so 下一篇 is
  // there when the article ends; 「都看完了」 only when the feed has no more
  // (it used to show on the 20th article of a longer list, 2026-11-02).
  const nearPageEnd = listIndex >= 0 && listIndex >= (items?.length ?? 0) - 2;
  // Each page is asked for once: a failed fetch leaves the cursor, and the
  // list's own 「載入更多」 is the retry.
  const prefetchedCursor = useRef<string | null>(null);
  useEffect(() => {
    if (!nearPageEnd || !nextCursor || loadingMore || prefetchedCursor.current === nextCursor) return;
    prefetchedCursor.current = nextCursor;
    setLoadingMore(true);
    void loadItems(nextCursor).finally(() => setLoadingMore(false));
  }, [nearPageEnd, nextCursor, loadingMore, loadItems]);
  // 載入全文 by hand: only when the automatic load failed or did not run.
  const showFulltextLink = !!article && !article.saved_node_id && !!article.url
    && fullText?.id === article.id && (fullText.status === "failed" || fullText.status === "skipped");

  /** 存成筆記, the whole article: the secondary action at the end. */
  const saveControl = article && (
    <RssSaveControl savedNodeId={article.saved_node_id} busy={busy}
      destination={saveLabel(article.source_id)}
      onSave={() => void keepArticle(article).catch(() => null)}
      onChoose={() => setSaving(article)}
      onOpen={() => { onOpenNode(article.saved_node_id!); onClose?.(); }} />
  );

  return (
    <div className="rss-reader" data-reading={article ? "1" : "0"}>
      {onClose && (
        <PanelHeader icon={<Rss size={16} />} title={t("Reader")} onClose={onClose} />
      )}

      {notice && <p className="rss-notice">{notice}</p>}

      {saving && (
        <RssSaveSheet
          title={saving.title}
          defaultDestination={defaultFor(saving.source_id)}
          quickTagIds={quickTagIds}
          onSave={(destination) => keepArticle(saving, destination)}
          onClose={() => setSaving(null)}
        />
      )}

      {picking && article && (
        <RssNotePickSheet
          title={picking.kind === "write" ? t("Add to a note…") : t("Put it in…")}
          subtitle={picking.kind === "quote" ? `“${ellipsize(picking.passage.text, 80)}”` : article.title}
          onPick={(id) => {
            const p = picking;
            setPicking(null);
            if (p.kind === "quote") void quoteInto(id, p.passage);
            else if (p.kind === "embed") void embedInto(id, p);
            else void writeInto(id);
          }}
          onClose={() => setPicking(null)} />
      )}

      {sourcesOpen && (
        <RssSourcesSheet sources={sources ?? []} tags={storeTags ?? []} online={online} quickTagIds={quickTagIds}
          onClose={() => setSourcesOpen(false)}
          onEdit={(s) => { setSourcesOpen(false); setSheetSource(s); }}
          onNotice={setNotice}
          onChangedFeeds={() => setTimeout(() => { void refreshSources(); void loadItems(); }, 1500)} />
      )}

      {sheetSource && (
        <RssSourceSheet source={sheetSource} online={online} onClose={() => setSheetSource(null)} onUnsubscribed={unsubscribed}
          onChanged={() => void refreshSources()} onMuted={mutedFeed} quickTagIds={quickTagIds} />
      )}

      <div className="rss-reader-body" data-has-article={article ? "1" : "0"}
        style={listWidth === null ? undefined : { "--rss-list-width": `${listWidth}px` } as CSSProperties}>
        <aside className="rss-left">
          <ColumnResizer column={LIST_COLUMN} width={listWidth} onResize={setListWidth} label={t("Resize list")} />
          <RssSourceBar sources={sources} active={activeSource} counts={counts}
            onPick={(id) => { setActiveSource(id); closeArticle(); }} onOpenSources={() => setSourcesOpen(true)} />

          <RssWeekCard today={today} destination={{ tagIds: moduleDefault?.tag_ids ?? [], parentId: moduleDefault?.parent_id ?? null }}
            onOpenDraft={(id) => { onOpenNode(id); onClose?.(); }} />
          <RssItemList items={items} today={today} lastReadId={lastReadId} activeId={article?.id ?? null}
            singleSource={activeSource !== null && activeSource !== VOICES_VIEW} sourceTitle={sourceTitle}
            displayModeOf={(id) => sources?.find((x) => x.id === id)?.display_mode ?? "text"} hasNewer={hasNewer}
            nextCursor={nextCursor} loadingMore={loadingMore} onOpen={(id) => void openItem(id)}
            onLoadMore={() => { setLoadingMore(true); void loadItems(nextCursor).finally(() => setLoadingMore(false)); }}
            onShowNewer={showNewer} />
        </aside>

        <section className="rss-right" onTouchStart={onArticleTouchStart} onTouchEnd={onArticleTouchEnd}>
          {article ? (
            <>
              {/* Mobile single-pane drill: back to the list (hidden on desktop's
                  two-pane layout via CSS). */}
              {/* A slim toolbar stays put; the title scrolls away with the text. */}
              {/* Phone: the way back to the list. Desktop has the list beside. */}
              <div className="rss-article-toolbar">
                <Pressable className="rss-article-back" onClick={() => { articleEntry.leave(); backToList(); }} aria-label={t("Back to list")}>‹ {t("List")}</Pressable>
                {linkedFrom && (
                  <Pressable className="rss-article-back rss-link-back" onClick={() => { linkEntry.leave(); backFromLink(); }}
                    aria-label={t("Back to the article")}>‹ {ellipsize(linkedFrom.title, 28)}</Pressable>
                )}
              </div>
              {/* How far along the list: a thin bar, not a 「1 / 20」 tally. */}
              {listIndex >= 0 && (items?.length ?? 0) > 1 && (
                <div className="rss-article-progress" role="progressbar" aria-label={t("Place in the list")}
                  aria-valuemin={1} aria-valuemax={items!.length} aria-valuenow={listIndex + 1}>
                  <span style={{ "--rss-progress": `${((listIndex + 1) / items!.length) * 100}%` } as React.CSSProperties} />
                </div>
              )}
              {linked && <RssLinkedPage page={linked} sourceTitle={sourceTitle(article.source_id)} resolveImage={articleImageSrc} />}
              <div className="rss-article-scroll" key={article.id} data-enter={enterFrom ?? undefined} hidden={linked !== null}
                onClickCapture={onArticleClickCapture}>
                <div className="rss-article-head">
                  <div className="rss-article-head-row">
                    <h3 className="rss-article-title">{article.title}</h3>
                  </div>
                  <div className="rss-article-meta">
                    <span>{sourceTitle(article.source_id)}</span>
                    {article.published_at && <span>{dateLabel(article.published_at, "short")}</span>}
                    {article.url && (
                      <Link href={article.url} target="_blank" rel="noreferrer noopener" className="rss-article-link">
                        <ExternalLink size={11} /> {t("original")}
                      </Link>
                    )}
                  </div>
                </div>
                <div className="rss-article-body" ref={articleRef} onMouseUp={readSelection} onDoubleClick={onArticleDoubleClick}>
                  {/* raw: feed bodies are HTML — rehype-raw + rehype-sanitize
                      (the renderer's existing html path) keep it safe. */}
                  <ReaderArticle resolveImage={(src) => articleImageSrc(src, article.url)}>{article.body || t("*This article has no content — try “Load full text”.*")}</ReaderArticle>
                </div>
                {showFulltextLink && (
                  <p className="rss-fulltext-fallback">
                    <Pressable type="button" className="rss-fulltext-link" disabled={!online || fullText?.status === "loading"}
                      onClick={() => void loadFulltext(article, false)}>
                      {t("Load full text")}
                    </Pressable>
                  </p>
                )}
                {fullText?.id === article.id && fullText.status === "loading" && (
                  <p className="rss-fulltext-fallback" role="status">{t("Loading the full article…")}</p>
                )}
                {/* The end of an article leads on: 上一篇 on the left, 下一篇 on
                    the right, the way a swipe goes. */}
                <div className="rss-article-end">
                  {/* 寫點什麼 leads; keeping the whole article is the quiet second,
                      on the same row. Its choices open below the row. */}
                  <div className="rss-end-actions">
                    <Button type="button" variant="primary" size="sm" className="rss-end-btn" aria-expanded={writeOpen}
                      onClick={() => setWriteOpen((v) => !v)}>
                      <PenLine size={14} aria-hidden /> {t("Write something")}
                    </Button>
                    {saveControl}
                    {writeOpen && (
                      <div className="rss-write-choice" role="group" aria-label={t("Write something")}>
                        <Button type="button" variant="secondary" size="sm" onClick={() => void writeDraft()}>{t("New draft")}</Button>
                        <Button type="button" variant="secondary" size="sm" onClick={() => setPicking({ kind: "write" })}>{t("Add to a note…")}</Button>
                        <p className="rss-write-hint">
                          {(sessionQuotes.current.get(article.id)?.length ?? 0) > 0
                            ? tn("With your 1 quote from this article and its link.", "With your {n} quotes from this article and its link.", sessionQuotes.current.get(article.id)!.length)
                            : t("With the article's title and link.")}
                        </p>
                      </div>
                    )}
                  </div>
                  <nav className="rss-article-nav" aria-label={t("Previous and next article")}>
                    {prevItem ? (
                      <Pressable className="rss-next-btn rss-prev-btn" onClick={() => void openItem(prevItem.id, { from: "prev" })}>
                        <span className="rss-next-label">‹ {t("Previous article")}</span>
                        <span className="rss-next-title">{prevItem.title}</span>
                      </Pressable>
                    ) : <span className="rss-nav-empty" />}
                    {nextItem ? (
                      <Pressable className="rss-next-btn" onClick={() => void openItem(nextItem.id, { from: "next" })}>
                        <span className="rss-next-label">{t("Next article")} ›</span>
                        <span className="rss-next-title">{nextItem.title}</span>
                      </Pressable>
                    ) : <span className="rss-nav-empty" />}
                  </nav>
                  {!nextItem && !nextCursor && <p className="rss-end-note">{t("You're all caught up.")}</p>}
                </div>
              </div>
              {quote && (
                <div className={`${layerClass.narrow} rss-quote-bar`} role="toolbar" aria-label={t("Selected text")}
                  onPointerDown={() => { onBar.current = true; }} onPointerUp={() => { onBar.current = false; }}
                  onPointerCancel={() => { onBar.current = false; }}
                  // Keep the selection while a button is pressed.
                  onMouseDown={keepFocus}>
                  <span className="rss-quote-preview">“{ellipsize(quote.text, 80)}”</span>
                  {known ? (
                    <span className="rss-quote-options">
                      <span className="rss-quote-known">{t("Already in “{title}”", { title: noteTitle(known.noteId) })}</span>
                      <Pressable type="button" className="rss-quote-main"
                        onClick={() => { onOpenNode(known.noteId); onClose?.(); }}>
                        {t("Open “{title}”", { title: noteTitle(known.noteId) })}
                      </Pressable>
                      <Pressable type="button" onClick={() => setPicking({ kind: "embed", ...known })}>{t("Quote it in another note…")}</Pressable>
                    </span>
                  ) : (
                    <span className="rss-quote-options">
                      {dayNotes.enabled() && (
                        <Pressable type="button" className="rss-quote-main" onClick={() => choose(quote, () => void quoteIntoToday(quote))}>
                          <Quote size={14} aria-hidden /> {t("Put in today's note")}
                        </Pressable>
                      )}
                      {quoteTarget && quoteTarget !== todayNoteId && (
                        <Pressable type="button" className={dayNotes.enabled() ? undefined : "rss-quote-main"}
                          onClick={() => choose(quote, () => void quoteInto(quoteTarget, quote))}>
                          {t("Put in “{title}”", { title: ellipsize(noteTitle(quoteTarget), 24) })}
                        </Pressable>
                      )}
                      <Pressable type="button" className={!dayNotes.enabled() && !quoteTarget ? "rss-quote-main" : undefined}
                        onClick={() => choose(quote, () => setPicking({ kind: "quote", passage: quote }))}>
                        {t("Another note…")}
                      </Pressable>
                      {muteWordOf(quote.text) && online && (
                        <Pressable type="button" onClick={() => void seeLess(quote)}>{t("See less like this")}</Pressable>
                      )}
                    </span>
                  )}
                </div>
              )}
            </>
          ) : (
            <EmptyState size="inline" className="rss-empty-article" title={t("Pick an article to read.")} />
          )}
        </section>
      </div>
    </div>
  );
}

/** Selected text as a quote: spaces collapsed within lines, paragraph
 *  breaks kept (they become separate quote lines). */
function cleanQuote(raw: string): string {
  return raw.replace(/[ \t\u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const TEXT_BLOCK = "p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, td, th, figcaption, dd, dt";

/** The words just before and after `range` in the article, as an excerpt's
 *  prefix and suffix: only those in the same paragraph as each end of the
 *  selection (a Text Fragment's context does not cross blocks). */
function contextAround(root: HTMLElement, range: Range): { prefix: string; suffix: string } {
  const blockOf = (node: Node): Element => {
    const found = (node instanceof Element ? node : node.parentElement)?.closest(TEXT_BLOCK);
    return found && root.contains(found) ? found : root;
  };
  const before = createRange();
  before.selectNodeContents(blockOf(range.startContainer));
  before.setEnd(range.startContainer, range.startOffset);
  const after = createRange();
  after.selectNodeContents(blockOf(range.endContainer));
  after.setStart(range.endContainer, range.endOffset);
  return excerptContext(before.toString(), after.toString());
}
