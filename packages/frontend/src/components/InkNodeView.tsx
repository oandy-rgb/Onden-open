import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PageImagesDoc } from "@onden/markdown/page-images";
import type { PageTextDoc } from "@onden/markdown/page-text";
import { INK_PAGE_UNITS, INK_NOTE_MIN_HEIGHT, emptyInkPages, withPageAppended, withPageDoc, type InkPageRecord, type InkPages } from "@onden/markdown/ink";
import { emptyInkDocument, InkPageSession, usePenShortcutTool, type InkActiveTool } from "../lib/ink";
import type { InkSaveOptions } from "../lib/data";
import InkToolbar, { INK_COLORS } from "./InkToolbar";
import { INK_SIZES } from "../lib/inkSizes";
import { useInkPen } from "../hooks/useInkPen";
import { inkReadOnlyMessage } from "../lib/ink";
import { useInkInputPrefs } from "../hooks/useInkInputPrefs";
import { usePageTextController, type PageTextSource } from "../lib/pageText";
import { centeredIn, insertedSize, undoTarget, usePageImagesController, visiblePageBand, type PageImagesSource } from "../lib/pageImages";
import { useImageUpload } from "../hooks/useImageUpload";
import { InkRegionLayer, PageImageLayer, QUOTE_TOOL, TextBoxLayer, TEXT_TOOL, type CopyNotice } from "./page";
import { inkRegionEmbedText, titleNamesNote } from "../lib/inkRegionQuote";
import { onInkRegionFocus, takeInkRegionFocus } from "../lib/inkRegionFocus";
import { copyText } from "../lib/clipboard";
import { useAutoReset } from "../hooks/useTransientFlag";
import type { InkRegion } from "@onden/markdown/ink";
import type { WikilinkNode } from "../lib/wikilinks";
import { useT } from "../lib/i18n";
import PageMoreMenu from "./PageMoreMenu";
import { useExpandedPane } from "../hooks/useExpandedPane";
import ExpandPaneButton from "./ExpandPaneButton";
import { useStableCallback } from "../hooks/useStableCallback";
import { classNames } from "../lib/utils";
import { randomUUID } from "../lib/uuid";
import "./InkNodeView.css";
import { onPageHide } from "../lib/pageHide";
import { layerClass } from "./ui";
import { PageBook, type PageBookApi } from "../pagebook";

// Handwriting surface for a node that opted in via the `ink_data` attribute — a notebook: a thin
// shell over the page book (src/pagebook). The parent (OverviewEditor) owns persistence; this
// component reads the toolbar and the device's settings, hands the book its text-box and picture
// layers, and turns what the pages' engines changed into one InkPages to save.
//
// The drawing is an InkPages (@onden/markdown/ink): the same page envelope a PDF note's pages are
// in. Its first page, key `page`, is what the note stores as its `ink_data`; further pages ride in
// that document's `morePages` (noteDoc / notePages, done by the parent's save). Pages are fixed
// sheets, 1000 units wide: the first one as tall as its ink was when the note was opened (at
// least INK_NOTE_MIN_HEIGHT), a new one INK_NOTE_MIN_HEIGHT; "+ Add page" adds one below the last.
// Who draws and who scrolls — pen vs finger vs mouse — is the engine's input policy
// (lib/ink/inputPolicy.ts); the camera is the book's.

type Props = {
  initialPages?: InkPages | null;
  /** Already debounced inside the session (~1s after the pen lifts, saved at once on unmount and
   *  when the page goes away) — the parent can persist immediately on every call. `keepalive` when
   *  the page is going away: the save must outlive it. */
  onPagesChange?: (pages: InkPages, options?: InkSaveOptions) => void;
  /** Made with a newer version (isInkReadOnly): shown, not editable. No page takes a stroke, and
   *  this swaps the toolbar for the notice. Scroll and zoom still work. */
  readOnly?: boolean;
  /** Why a read-only surface is read-only, when it is not the drawing's newer version: the person may not change this
   *  note. Shown instead of the update notice (which would send them to update an app that is up to date). */
  readOnlyNotice?: string;
  /** The note's text boxes (lib/pageText): saved as their own attribute,
   *  beside the drawing, never inside it. */
  pageText?: PageTextSource;
  /** Remembers 「放大畫面」 per note (hooks/useExpandedPane). */
  nodeId?: string;
  /** The note's pictures (lib/pageImages): their own attribute too, under the
   *  strokes and over the paper. */
  pageImages?: PageImagesSource;
  /** What the 「引用」 tool names the note by (its title, and whether another note has the same one). Absent: no 「引用」 tool. */
  quoteAs?: { title: string; nodes: readonly WikilinkNode[] };
};

/** The toolbar's tools: the ink engine's, Text (boxes on the page) and Quote (a frame over an area to
 *  copy a reference to) — the engine then only pans, like Hand. */
type NoteTool = InkActiveTool | "text" | "quote";
const engineToolOf = (tool: NoteTool): InkActiveTool => (tool === "text" || tool === "quote" ? "hand" : tool);

/** A notebook always has its first page, `page`, even before anything is drawn. */
function withFirstPage(pages: InkPages | null | undefined): InkPages {
  const base = pages ?? emptyInkPages();
  if (base.pages.page) return base;
  const first: InkPageRecord = { key: "page", background: { kind: "blank" }, size: { width: INK_PAGE_UNITS, height: INK_NOTE_MIN_HEIGHT }, doc: emptyInkDocument() };
  return { ...base, pages: { page: first, ...base.pages } };
}

/** The pages as shown: each at least as tall as the text boxes and pictures on it reach. A page is as
 *  tall as its ink was when the note was opened, and a note made when pages grew with what was put
 *  on them has pictures lower than that; they stay on their page. (A text box stores no height:
 *  its first line is counted.) */
function pagesFittingLayers(pages: InkPages, textDoc: PageTextDoc | null, picDoc: PageImagesDoc | null): InkPages {
  let next = pages;
  for (const [key, record] of Object.entries(pages.pages)) {
    const bottom = Math.max(0,
      ...(picDoc?.pages[key]?.images ?? []).map((i) => i.y + i.h),
      ...(textDoc?.pages[key]?.boxes ?? []).map((b) => b.y + b.size));
    if (bottom <= record.size.height) continue;
    const height = Math.ceil(bottom);
    next = { ...next, pages: { ...next.pages, [key]: { ...record, size: { ...record.size, height } } } };
  }
  return next;
}

export default function InkNodeView({ initialPages, onPagesChange, readOnly = false, readOnlyNotice, pageText, pageImages, nodeId, quoteAs }: Props) {
  const t = useT();
  const pane = useExpandedPane(nodeId);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const bookRef = useRef<PageBookApi | null>(null);
  const onPagesChangeRef = useRef(onPagesChange);
  useEffect(() => { onPagesChangeRef.current = onPagesChange; }, [onPagesChange]);
  // The pages as edited: read once on mount (the parent remounts via key on node change). A ref as
  // well as state: an engine leaving the screen hands its edits over and may come back before
  // React has rendered the state.
  const [pages, setPages] = useState(() => withFirstPage(initialPages));
  const pagesRef = useRef(pages);
  const [session] = useState(() => new InkPageSession<InkPages>((current, key, doc) => withPageDoc(current, key, doc)));

  const [tool, setToolState] = useState<NoteTool>("pen");
  const { controller: texts, doc: textDoc } = usePageTextController(pageText, readOnly);
  const { controller: pics, doc: picDoc, selection: picSelection } = usePageImagesController(pageImages, readOnly);
  const { upload, busy: uploading } = useImageUpload();
  const pen = useInkPen({ color: INK_COLORS[0].value, sizeId: INK_SIZES[1].id });
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const [spaceHeld, setSpaceHeld] = useState(false);

  const input = useInkInputPrefs();
  const shownPages = useMemo(() => pagesFittingLayers(pages, textDoc, picDoc), [pages, textDoc, picDoc]);

  const setTool = useCallback((next: NoteTool) => setToolState(next), []);

  // 「引用」: the frame on a page and what the copy button last said. Leaving the tool puts the frame away.
  const [quote, setQuote] = useState<InkRegion | null>(null);
  const [copyNotice, setCopyNotice] = useState<CopyNotice | null>(null);
  const [marked, setMarked] = useState<InkRegion | null>(null);
  const [markSerial, setMarkSerial] = useState(0); // a new request restarts the mark even for the same area
  const quoting = tool === "quote" && !readOnly;
  useEffect(() => { if (!quoting) { setQuote(null); setCopyNotice(null); } }, [quoting]);
  const changeQuote = useCallback((next: InkRegion | null) => { setQuote(next); setCopyNotice(null); }, []);
  const copyQuote = () => {
    if (!quote || !nodeId || !quoteAs) return;
    const text = inkRegionEmbedText({ id: nodeId, title: quoteAs.title, titleNamesNote: titleNamesNote({ id: nodeId, title: quoteAs.title }, quoteAs.nodes) }, quote);
    if (!text) return;
    // Started in the tap itself (iOS refuses a write begun later); when the browser refuses, the text is shown to copy by hand.
    void copyText(text, { what: "link", successToast: false }).then((copied) => setCopyNotice(copied ? { kind: "copied" } : { kind: "manual", text }));
  };

  // Arriving from a quoted embed — as the view opens, or while it is already open (a quote tapped in this very
  // note): scroll to the area and mark it for a moment.
  // Only the surface a quote can name listens (quoteAs): a note's 「手寫」 tab shows other strokes of the same note.
  const quotable = !!quoteAs;
  useEffect(() => {
    if (!nodeId || !quotable) return;
    let timers: number[] = [];
    const show = () => {
      const region = takeInkRegionFocus(nodeId);
      if (!region) return;
      setMarked(region);
      setMarkSerial((n) => n + 1);
      // The book lays its pages out a moment after mounting: ask again once it has.
      timers.forEach(clearTimeout);
      timers = [0, 120, 400].map((ms) => setTimeout(() => bookRef.current?.scrollToUnit(region.page, region.y), ms) as unknown as number);
    };
    show();
    const stop = onInkRegionFocus(nodeId, show);
    return () => { stop(); timers.forEach(clearTimeout); };
  }, [nodeId, quotable]);
  useAutoReset(marked, () => setMarked(null), 2600);
  // Stable, so the engines (built once per page) can hold it (S Pen side button).
  const onPenShortcut = usePenShortcutTool(engineToolOf(tool), setTool);
  // The text tool where the page has a text layer; the quote tool only on the surface a quote can name (quoteAs):
  // a note's 「手寫」 tab keeps its strokes elsewhere, and an area quoted from it could not be drawn.
  const trailingTools = [...(texts ? [TEXT_TOOL] : []), ...(quoteAs && nodeId ? [QUOTE_TOOL] : [])];

  /** Apply one edit to the pages and save it — once (never inside a state updater, which
   *  StrictMode runs twice). */
  const commit = useCallback((change: (current: InkPages) => InkPages, options?: InkSaveOptions) => {
    if (readOnly) return;
    const next = change(pagesRef.current);
    if (next === pagesRef.current) return;
    pagesRef.current = next;
    setPages(next);
    if (options) onPagesChangeRef.current?.(next, options);
    else onPagesChangeRef.current?.(next);
  }, [readOnly]);
  /** Write what the pages' engines changed — strokes drawn, spans erased, an erase undone — as ONE
   *  edit. Nothing changed = no save. */
  const commitDrawSession = useStableCallback((options?: InkSaveOptions) => commit((current) => session.apply(current), options));

  // Strokes are saved about a second after the pen lifts, once more when the view goes away
  // (layout cleanup, so the editor's flush-on-unmount still sees the save it schedules), and
  // when an engine leaves the screen (the session asks).
  useEffect(() => {
    session.onSettled = () => commitDrawSession();
    session.onHistoryChange = (canUndo, canRedo) => setHistory({ canUndo, canRedo });
    return () => { session.onSettled = null; session.onHistoryChange = null; };
  }, [session, commitDrawSession]);
  useLayoutEffect(() => () => commitDrawSession(), [commitDrawSession]);
  // The page going away (close, navigate, a phone switching apps) must not take strokes still
  // waiting for the debounce: save them now, as a save that outlives the page. visibilitychange
  // covers the app switch where pagehide may never fire.
  useEffect(() => onPageHide(() => commitDrawSession({ keepalive: true })), [commitDrawSession]);

  // Undo / redo follow what the person is working on, and each kind of edit has
  // its own stack (strokes, typing and pictures are different edits): see
  // lib/pageImages/undoTarget for which one a tool and a selected picture mean. Strokes are
  // undone on the page that was drawn on last (the session).
  const target = readOnly ? "drawing" : undoTarget({
    tool,
    text: texts && { canUndo: texts.canUndo, canRedo: texts.canRedo },
    images: pics && { canUndo: pics.canUndo, canRedo: pics.canRedo },
    imageSelected: picSelection !== null,
  });
  const stack = target === "text" ? texts : target === "images" ? pics : null;
  const undo = () => { if (stack) stack.undo(); else session.undo(); };
  const redo = () => { if (stack) stack.redo(); else session.redo(); };
  const toolbarHistory = stack ? { canUndo: stack.canUndo, canRedo: stack.canRedo } : history;

  const addPage = () => {
    const key = randomUUID();
    commit((current) => withPageAppended(current, key));
    bookRef.current?.scrollToPage(key);
  };

  // 「插入」: upload what was chosen (the same path `/` insert and drops take) and lay each picture
  // in the middle of what is on screen, on the page most of the view is over. The Hand tool comes
  // on with the last one selected, so it can be moved and sized at once.
  const insertImages = async (files: File[]) => {
    const uploaded = await upload(files);
    const main = bookRef.current?.mainVisiblePage();
    if (!pics || !main || uploaded.length === 0) return;
    const record = pagesRef.current.pages[main.key];
    if (!record) return;
    const { width: pageUnits, height: pageHeight } = record.size;
    const band = visiblePageBand(main.view, main.page, pageUnits);
    uploaded.forEach((picture, i) => {
      const size = insertedSize(picture.natural, pageUnits, Math.max(120, band.height * 0.8));
      const at = centeredIn(band, size, pageUnits, pageHeight);
      const shift = i * 30; // several at once fan out instead of stacking exactly
      pics.addImage(main.key, { ...size, x: Math.min(at.x + shift, Math.max(0, pageUnits - size.w)), y: Math.min(at.y + shift, Math.max(0, pageHeight - size.h)), src: picture.src, alt: picture.alt });
    });
    setTool("hand");
  };

  // ⌘Z / ⌘⇧Z while the handwriting surface is focused — in-session,
  // engine-stack undo (cross-session undo stays the app's event restore).
  // Space held: mouse / pen drags pan, like the whiteboard.
  const undoRef = useRef(undo);
  const redoRef = useRef(redo);
  undoRef.current = undo;
  redoRef.current = redo;
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === " " && e.target === wrapRef.current) {
      e.preventDefault(); // not a page scroll
      if (!e.repeat) { session.setSpaceHeld(true); setSpaceHeld(true); }
      return;
    }
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) redoRef.current();
    else undoRef.current();
  }, [session]);
  const releaseSpace = useCallback(() => {
    session.setSpaceHeld(false);
    setSpaceHeld(false);
  }, [session]);
  const onKeyUp = useCallback((e: React.KeyboardEvent) => {
    if (e.key === " ") releaseSpace();
  }, [releaseSpace]);

  return (
    <div
      ref={wrapRef}
      className={classNames("ink-note", `ink-note--${tool}`, spaceHeld && "ink-note--panning", readOnly && "ink-note--readonly", pane.expanded && `pane--expanded ${layerClass.fill}`)}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={releaseSpace}
      onPointerDown={(e) => {
        // A press inside a text box keeps the caret there.
        if (!(e.target as HTMLElement).closest(".page-text-layer, .page-image-layer")) wrapRef.current?.focus({ preventScroll: true });
      }}
    >
      {readOnly ? <div className="ink-note-readonly">
        <span role="status">{readOnlyNotice ?? inkReadOnlyMessage()}</span>
        <ExpandPaneButton {...pane} />
      </div> : <InkToolbar
        tool={tool}
        onToolChange={setTool}
        {...pen.toolbar}
        trailingTools={trailingTools.length > 0 ? trailingTools : undefined}
        insert={pics ? { onFiles: (files) => void insertImages(files), busy: uploading } : undefined}
        canUndo={toolbarHistory.canUndo}
        canRedo={toolbarHistory.canRedo}
        onUndo={undo}
        onRedo={redo}
        trailing={<>
          <PageMoreMenu
            fingerDraws={!input.stylusOnly}
            onToggleFingerDraws={input.toggleFingerDraws}
            onZoomIn={() => bookRef.current?.zoomBy(1.2)}
            onZoomOut={() => bookRef.current?.zoomBy(1 / 1.2)}
            onFitWidth={() => bookRef.current?.fitWidth()}
          />
          <ExpandPaneButton {...pane} />
        </>}
      />}
      <PageBook
        pages={shownPages}
        session={session}
        tool={readOnly ? null : engineToolOf(tool)}
        pen={pen}
        penDraws={input.penDraws}
        stylusOnly={input.stylusOnly}
        onPenSeen={input.onPenSeen}
        onPenShortcut={onPenShortcut}
        onAddPage={readOnly ? undefined : addPage}
        onReady={(api) => { bookRef.current = api; }}
        t={t}
        layers={(page, host) => (
          <>
            {pics && picDoc && (
              <PageImageLayer controller={pics} doc={picDoc} pageKey={page.key} pageWidth={page.size.width} part="art" />
            )}
            {pics && picDoc && (
              <PageImageLayer controller={pics} doc={picDoc} pageKey={page.key} pageWidth={page.size.width} part="controls" mode={readOnly ? "view" : tool === "hand" ? "select" : "view"} />
            )}
            {texts && textDoc && (
              <TextBoxLayer
                controller={texts}
                doc={textDoc}
                pageKey={page.key}
                pageWidth={page.size.width}
                mode={readOnly ? "view" : tool === "text" ? "text" : tool === "hand" ? "select" : "view"}
                tapTarget={host}
              />
            )}
            <InkRegionLayer
              pageKey={page.key}
              pageSize={page.size}
              active={quoting}
              stylusOnly={input.stylusOnly}
              region={quote}
              onRegionChange={changeQuote}
              onCopy={copyQuote}
              notice={copyNotice}
              marked={marked}
              markSerial={markSerial}
              onPenSeen={input.onPenSeen}
            />
          </>
        )}
      />
    </div>
  );
}
