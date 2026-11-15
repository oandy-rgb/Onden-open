import { MousePointer2 } from "lucide-react";
import { useTransientFlag } from "../hooks/useTransientFlag";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useDismiss } from "../hooks/useEscapeKey";
import { useExpandedPane } from "../hooks/useExpandedPane";
import ExpandPaneButton from "./ExpandPaneButton";
import "./PdfNodeView.css";

// PDF reader + annotation surface for a node whose presentation.editor is
// 'pdf'. This component owns the editing UI; persistence is the parent's:
//
//   onChange fires once per edit (a drawing, shape, highlight or clear) with
//   the whole ink_data envelope — per-page strokes AND every highlight record
//   (lib/pdf/pdfAdapter InkMultiPageDoc). One edit, one save, one event, so
//   undoing or refusing it never leaves half a drawing behind.
//
// The view is a thin shell over the page book (src/pagebook): one book page per PDF page (key
// `pdf:<n>`, 1000 × 1000·h/w units), the page's picture drawn by PdfPageBackground (pdfjs-dist 6
// legacy build, lib/pdf/pdfjs.ts), the book owning scroll, zoom, fingers and the ink surfaces.
// What is PDF's own stays here: reading the PDF, highlights, text selection, area select, the card
// from a selection, the toolbar and the save. The highlight record format is frozen in lib/pdf/coords.ts —
// identical to what the retired react-pdf-highlighter-plus persisted. Records
// saved in the old pdf_annotations attribute are folded in on load
// (lib/pdf decodePdfInk).

import InkToolbar, { INK_COLORS, type InkToolEntry } from "./InkToolbar";
import { INK_SIZES } from "../lib/inkSizes";
import { useInkPen } from "../hooks/useInkPen";
import { confirmDialog } from "./ConfirmDialog";
import PageMoreMenu from "./PageMoreMenu";
import { PdfPageBackground, PdfPageHighlights, usePdfDocument, usePdfPageShapes } from "./pdf";
import { PageBook, type PageBookApi } from "../pagebook";
import { TextBoxLayer, TEXT_TOOL, type TextBoxMode } from "./page";
import { usePageTextController, type PageTextSource } from "../lib/pageText";
import { pdfPageKey } from "@onden/markdown/page-text";
import {
  boundingRectOf,
  type PdfHighlightRecord,
} from "../lib/pdf/coords";
import { pdfPageOfKey, pdfPageRecord, type InkPages } from "@onden/markdown/ink";
import {
  areaRecord,
  clientRectsToPageRects,
  mergeLineRects,
  textSelectionPosition,
  type PageRef,
} from "../lib/pdf/capture";
import { createPdfDrawSession } from "../lib/pdf/drawSession";
import {
  emptyMultiPageDoc,
  emptyPageDoc,
  withUnits,
  type InkMultiPageDoc,
} from "../lib/pdf";
import type { InkSaveOptions } from "../lib/data";
import { useStableCallback } from "../hooks/useStableCallback";
import { useInkInputPrefs } from "../hooks/useInkInputPrefs";
import { usePenShortcutTool, type InkActiveTool } from "../lib/ink";
import { t } from "../lib/i18n";
import { inkReadOnlyMessage, isInkReadOnly } from "../lib/ink";
import { onPageHide } from "../lib/pageHide";
import { clearSelection, currentSelection, onSelectionChange } from "../lib/documentAccess";
import { onDocument, onWindow } from "../lib/globalEvents";
import { Pressable, keepFocus, layerClass } from "./ui";

/** The one toolbar's tools: Select (text, Mark, → Card, Alt+drag areas), Text
 *  (boxes on the page) and the ink engine's five (pen, highlighter, eraser,
 *  hand, shape). Only the ink five mount an engine, and the engine takes the
 *  touch for all of them alike; Text lets a finger scroll like Select does. */
type PdfTool = "select" | "text" | InkActiveTool;
type PdfExtraTool = "select" | "text";
const isInkTool = (tool: PdfTool): tool is InkActiveTool => tool !== "select" && tool !== "text";
/** A PDF page is 1000 page units wide (its height follows the page's ratio). */
const PDF_PAGE_UNITS = 1000;

/** A page with nothing drawn on it (one shared document: the page's picture memoizes on it). */
const EMPTY_PAGE_DOC = emptyPageDoc();

const PDF_TOOL_ATTR = "data-pdf-tool";
const SELECT_TOOLS: Array<InkToolEntry<PdfExtraTool>> = [{
  id: "select", label: "Select", dataAttr: PDF_TOOL_ATTR, icon: <MousePointer2 size={15} />,
  hint: "Select text, then Mark it or → Card saves it as a note · Alt+drag selects an area",
}];

const TEXT_TOOLS: Array<InkToolEntry<"text">> = [TEXT_TOOL];

/** The pen starts oxblood, fine — the toolbar changes it. */
const DEFAULT_COLOR = INK_COLORS[1].value;
const DEFAULT_SIZE_ID = INK_SIZES[0].id;

type Props = {
  pdfUrl: string;
  /** The note this PDF belongs to: its enlarged state is remembered per note. */
  nodeId?: string;
  /** The note's envelope as loaded (strokes + highlight records). */
  initialDoc?: InkMultiPageDoc | null;
  /** Fired once per edit with the whole envelope — save it as ink_data now
   *  (drawings arrive settled: the ink engine debounces). `keepalive` when the
   *  page is going away: the save must outlive it. */
  onChange?: (doc: InkMultiPageDoc, options?: InkSaveOptions) => void;
  /** Made with a newer version (isInkReadOnly): shown, never edited or saved. */
  readOnly?: boolean;
  /** Why it is read-only when it is not the drawing's newer version (the person may not change this note). */
  readOnlyNotice?: string;
  /** Heptabase-style "highlight becomes a card": fired once per text
   *  selection. Parent is expected to POST /api/nodes (title from the quote)
   *  + POST /api/edges with edge_type='highlight_source'. Resolves true once
   *  the card exists; the local annotation is added regardless, so the PDF
   *  visual is unaffected if the spawn fails (the parent reports why). */
  onTextHighlightCreated?: (params: { text: string; page: number }) => Promise<boolean> | void;
  /** The note's text boxes (lib/pageText): their own attribute, saved apart
   *  from the drawing and its highlights. */
  pageText?: PageTextSource;
};

export default function PdfNodeView({
  pdfUrl,
  nodeId,
  initialDoc = null,
  onChange,
  readOnly: readOnlyProp = false,
  readOnlyNotice,
  onTextHighlightCreated,
  pageText,
}: Props) {
  const readOnly = readOnlyProp || isInkReadOnly(initialDoc);
  const { controller: texts, doc: textDoc } = usePageTextController(pageText, readOnly);
  // The envelope being edited, with its pages in page units. A ref: the
  // overlays render from `highlights` (its records) and `pagesView` (its pages);
  // the engines read the pages when they mount.
  const [firstDoc] = useState(() => withUnits(initialDoc ?? emptyMultiPageDoc()));
  const docRef = useRef<InkMultiPageDoc>(firstDoc);
  const [highlights, setHighlights] = useState<PdfHighlightRecord[]>(docRef.current.annotations ?? []);
  // The pages' drawings, in page units: what the book draws and its engines load.
  const [pagesView, setPagesView] = useState(docRef.current.units!.pages);
  // Bumped when another version of the envelope arrives: the page surfaces
  // reload from it.
  const [docEpoch, setDocEpoch] = useState(0);
  const lastEmittedRef = useRef<InkMultiPageDoc | null>(null);
  const input = useInkInputPrefs();
  // Stylus mode on (fingers only scroll anyway): open with the pen, ready to
  // write. Otherwise Select, so a finger or the mouse can select text.
  const [activeTool, setActiveTool] = useState<PdfTool>(() => (!readOnly && input.stylusOnly ? "pen" : "select"));
  const inkTool = isInkTool(activeTool) ? activeTool : null;
  const [book, setBook] = useState<PageBookApi | null>(null);
  const { pdf, error: pdfError } = usePdfDocument(pdfUrl);
  const shapes = usePdfPageShapes(pdf?.doc ?? null);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  const onHighlightRef = useRef(onTextHighlightCreated);
  useEffect(() => { onHighlightRef.current = onTextHighlightCreated; }, [onTextHighlightCreated]);

  // Take a newly loaded envelope; the echo of our own last save is not one.
  useEffect(() => {
    if (!initialDoc || initialDoc === lastEmittedRef.current || initialDoc === docRef.current) return;
    docRef.current = withUnits(initialDoc);
    setHighlights(docRef.current.annotations ?? []);
    setPagesView(docRef.current.units!.pages);
    setDocEpoch((n) => n + 1);
  }, [initialDoc]);

  /** Apply one edit to the envelope and save it — once (never inside a state
   *  updater, which StrictMode runs twice). */
  const commit = useCallback((change: (doc: InkMultiPageDoc) => InkMultiPageDoc, options?: InkSaveOptions) => {
    if (isInkReadOnly(docRef.current)) return; // made with a newer version: never changed or saved
    const next = withUnits(change(docRef.current));
    docRef.current = next;
    lastEmittedRef.current = next;
    setHighlights(next.annotations ?? []);
    setPagesView(next.units!.pages);
    if (options) onChangeRef.current?.(next, options);
    else onChangeRef.current?.(next);
  }, []);
  const withRecords = (doc: InkMultiPageDoc, records: PdfHighlightRecord[]): InkMultiPageDoc =>
    ({ ...doc, annotations: [...(doc.annotations ?? []), ...records] });

  const addHighlight = useCallback((h: PdfHighlightRecord) => {
    commit((doc) => withRecords(doc, [h]));
  }, [commit]);

  // ── Selection tip ("→ Card") ──────────────────────────────────────────────

  // The most recent committed text highlight, cached for the selectionTip
  // button: by the time the user clicks "→ Card" the browser selection may
  // already be gone, so we never re-derive from the live selection.
  const latestTextRef = useRef<{ text: string; page: number } | null>(null);
  // The selection's highlight, written only when the tip is pressed (R4: a
  // drag that merely selects text used to mint a highlight on every
  // pointerup). Null once committed.
  const pendingHighlightRef = useRef<PdfHighlightRecord | null>(null);
  // Tip anchor as fractions of the page, so it stays on its text through a zoom;
  // rendered inside that page's layers so it scrolls with the page.
  const [tip, setTip] = useState<{ page: number; fx: number; fy: number } | null>(null);
  const [spawnFlash, flashSpawn] = useTransientFlag(1400);

  /** 「劃線」: write the pending selection as a highlight. */
  const commitPendingHighlight = useCallback(() => {
    const pending = pendingHighlightRef.current;
    if (!pending) return;
    pendingHighlightRef.current = null;
    addHighlight(pending);
  }, [addHighlight]);

  const handleHighlight = useCallback(() => {
    commitPendingHighlight();
    clearSelection();
    setTip(null);
  }, [commitPendingHighlight]);

  const handleSpawnCard = useCallback(() => {
    const latest = latestTextRef.current;
    // 「→ 卡片」 marks the text too: the card's source is a highlight.
    commitPendingHighlight();
    if (!latest) return;
    // Visual confirmation (item #1 from the design discussion): the user
    // clicks → Card while looking at the PDF, the new node lives in sidebar
    // which they may not see, so flash a "✓" badge in the toolbar — only once
    // the card actually exists.
    void Promise.resolve(onHighlightRef.current?.(latest)).then((created) => {
      if (created === false) return;
      flashSpawn();
    });
  }, [commitPendingHighlight, flashSpawn]);

  // ── Mode bookkeeping (refs so DOM listeners never re-attach) ─────────────

  const modeRef = useRef({ drawing: false, areaDrag: false });
  useEffect(() => {
    modeRef.current.drawing = inkTool !== null;
  }, [inkTool]);

  // ── Text selection → highlight + tip ─────────────────────────────────────

  // Commit-once guard: clicking the tip keeps the selection alive (its
  // pointerdown is prevented), so pointerup would re-commit the identical
  // selection without this signature check.
  const lastSelectionSigRef = useRef<string | null>(null);

  useEffect(() => {
    if (!book) return;
    const container = book.scroller();
    if (!container) return;
    const onPointerUp = () => {
      if (modeRef.current.drawing || modeRef.current.areaDrag) return;
      // Selection finalizes after pointerup — measure on the next task.
      setTimeout(() => {
        const sel = currentSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
          return;
        }
        const range = sel.getRangeAt(0);
        const anc = range.commonAncestorContainer;
        const ancEl = anc instanceof Element ? anc : anc.parentElement;
        if (!ancEl || !container.contains(ancEl)) return;
        const pages: PageRef[] = [];
        for (const { key, rect } of book.pageRects()) {
          const number = pdfPageOfKey(key);
          if (number !== null && rect.width > 0 && rect.height > 0) pages.push({ number, rect });
        }
        const pageRects = mergeLineRects(
          clientRectsToPageRects(Array.from(range.getClientRects()), pages),
        );
        if (pageRects.length === 0) return;
        const page = pageRects[0].pageNumber;
        const viewport = book.pageBox(pdfPageKey(page));
        if (!viewport) return;
        const position = textSelectionPosition(pageRects, viewport);
        if (!position) return;
        const text = sel.toString().split("\n").join(" ").trim();
        const b = position.boundingRect;
        const sig = `${page}:${text}:${b.x1.toFixed(1)},${b.y1.toFixed(1)},${b.x2.toFixed(1)},${b.y2.toFixed(1)}`;
        if (sig === lastSelectionSigRef.current) return;
        lastSelectionSigRef.current = sig;
        // Nothing is written yet: the tip offers 「劃線」 and 「→ 卡片」.
        pendingHighlightRef.current = { id: String(Date.now()), type: "text", position, content: { text } };
        latestTextRef.current = text ? { text, page } : null;
        const anchor = boundingRectOf(pageRects.filter((r) => r.pageNumber === page));
        const frame = pages.find((p) => p.number === page)!.rect;
        setTip({ page, fx: (anchor.left + anchor.width / 2) / frame.width, fy: anchor.top / frame.height });
      }, 0);
    };
    const handleSelectionChange = () => {
      const s = currentSelection();
      if (!s || s.isCollapsed) {
        setTip(null);
        pendingHighlightRef.current = null;
        lastSelectionSigRef.current = null;
      }
    };
    container.addEventListener("pointerup", onPointerUp);
    const stopSelection = onSelectionChange(handleSelectionChange);
    return () => {
      container.removeEventListener("pointerup", onPointerUp);
      stopSelection();
    };
  }, [book]);

  // ── Area select (Alt+drag, old hint preserved) ───────────────────────────

  const [areaPreview, setAreaPreview] = useState<
    { page: number; left: number; top: number; width: number; height: number } | null
  >(null);

  useEffect(() => {
    if (!book) return;
    const container = book.scroller();
    if (!container) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!e.altKey || e.button !== 0) return;
      if (modeRef.current.drawing) return;
      const found = book.pageAt(e.clientX, e.clientY);
      const pageNumber = found ? pdfPageOfKey(found.key) : null;
      if (!found || pageNumber === null) return;
      const hit = { pageNumber, element: found.element };
      // Cancelling pointerdown suppresses the compatibility mousedown's
      // default action — i.e. no text selection starts under the drag.
      e.preventDefault();
      modeRef.current.areaDrag = true;
      const pageRect = hit.element.getBoundingClientRect();
      const start = { x: e.clientX - pageRect.left, y: e.clientY - pageRect.top };
      const rectFrom = (ev: PointerEvent) => {
        const cur = { x: ev.clientX - pageRect.left, y: ev.clientY - pageRect.top };
        return {
          page: hit.pageNumber,
          left: Math.min(start.x, cur.x),
          top: Math.min(start.y, cur.y),
          width: Math.abs(cur.x - start.x),
          height: Math.abs(cur.y - start.y),
        };
      };
      const onMove = (ev: PointerEvent) => setAreaPreview(rectFrom(ev));
      const onUp = (ev: PointerEvent) => {
        stopMove();
        stopUp();
        modeRef.current.areaDrag = false;
        setAreaPreview(null);
        const rect = rectFrom(ev);
        const viewport = book.pageBox(pdfPageKey(hit.pageNumber));
        if (!viewport) return;
        const rec = areaRecord(String(Date.now()), hit.pageNumber, rect, viewport);
        if (rec) addHighlight(rec);
      };
      const stopMove = onWindow("pointermove", onMove);
      const stopUp = onWindow("pointerup", onUp);
    };
    container.addEventListener("pointerdown", onPointerDown);
    return () => container.removeEventListener("pointerdown", onPointerDown);
  }, [book, addHighlight]);

  // ── Freehand drawing (own ink engine, one surface per rendered page) ─────

  const [session] = useState(createPdfDrawSession);

  /** Write what the page surfaces changed — strokes drawn, spans erased, an
   *  erase undone — as ONE envelope edit. Nothing changed = no save. */
  const commitDrawSession = useStableCallback((options?: InkSaveOptions) => {
    if (readOnly) return;
    const next = session.apply(docRef.current);
    if (next !== docRef.current) commit(() => next, options);
  });

  // ── Ink tools (the handwriting note's toolbar and input rules) ───────────

  const pen = useInkPen({ color: DEFAULT_COLOR, sizeId: DEFAULT_SIZE_ID });
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });

  // Undo / redo follow what the person is working on (see InkNodeView): the
  // text tool undoes the text boxes, Hand does while they have something to
  // undo, every ink tool undoes the drawing.
  const textUndo = texts !== null && !readOnly && (activeTool === "text" || (activeTool === "hand" && (texts.canUndo || texts.canRedo)));
  const undo = () => { if (textUndo) texts.undo(); else session.undo(); };
  const redo = () => { if (textUndo) texts.redo(); else session.redo(); };
  const toolbarHistory = textUndo ? { canUndo: texts.canUndo, canRedo: texts.canRedo } : history;
  const textMode: TextBoxMode = readOnly ? "view" : activeTool === "text" ? "text" : activeTool === "hand" ? "select" : "view";

  const onPenShortcut = usePenShortcutTool(inkTool ?? "pen", (next) => { if (!readOnly) setActiveTool(next); }, inkTool !== null && !readOnly);

  useEffect(() => {
    session.onHistoryChange = (canUndo, canRedo) => setHistory({ canUndo, canRedo });
    return () => { session.onHistoryChange = null; };
  }, [session]);

  // Save without leaving drawing mode: commit about a second after the pen
  // lifts, and once more when the view goes away (layout cleanup, so the
  // editor's flush-on-unmount still sees the save it schedules).
  useEffect(() => {
    session.onSettled = () => commitDrawSession();
    return () => { session.onSettled = null; };
  }, [session, commitDrawSession]);
  useLayoutEffect(() => () => commitDrawSession(), [commitDrawSession]);
  // The page going away (close, navigate, a phone switching apps) must not
  // take strokes still waiting for the pen-up debounce: write them now, as a
  // save that outlives the page. visibilitychange covers the app switch where
  // pagehide may never fire.
  useEffect(() => {
    return onPageHide(() => commitDrawSession({ keepalive: true }));
  }, [commitDrawSession]);

  /** The one way to change tool. Leaving the ink tools saves what was drawn
   *  before the engine goes away (side effects stay out of state updaters —
   *  StrictMode double-invokes them). */
  const selectTool = useCallback((next: PdfTool) => {
    if (readOnly && next !== "select" && next !== "hand") return;
    if (next === "text" && !texts) return;
    if (modeRef.current.drawing && !isInkTool(next)) commitDrawSession();
    setActiveTool(next);
  }, [readOnly, commitDrawSession, texts]);

  // Esc and Back go back to Select and keep what was drawn (remove strokes with
  // undo or Clear, never by leaving the tool). It is the newest Esc owner, so
  // it also keeps the same press from shrinking the enlarged PDF.
  useDismiss(() => { selectTool("select"); }, activeTool !== "select");
  // Undo / redo keys follow the ink tools' history.
  useEffect(() => {
    if (activeTool === "select") return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        if ((inkTool === null && activeTool !== "text") || target?.closest("input, textarea, [contenteditable='true']")) return;
        e.preventDefault();
        if (activeTool === "text") { if (e.shiftKey) texts?.redo(); else texts?.undo(); return; }
        if (e.shiftKey) session.redo();
        else session.undo();
        return;
      }
    };
    return onDocument("keydown", onKey);
  }, [activeTool, inkTool, session, texts]);

  const handleClear = useCallback(() => {
    if (readOnly) return;
    session.reset(); // the page surfaces start over empty, not resurrect it
    commit(() => emptyMultiPageDoc());
    setTip(null);
  }, [commit, session, readOnly]);

  const clearAll = useCallback(async () => {
    const confirmed = await confirmDialog(t("Remove all annotations and drawings from this PDF?"), {
      danger: true,
      confirmLabel: t("Clear all"),
    });
    if (confirmed) handleClear();
  }, [handleClear]);

  // ── The book's pages ──────────────────────────────────────────────────────

  // One book page per PDF page, laid out at its real shape before it is drawn (usePdfPageShapes).
  const pages = useMemo<InkPages>(() => {
    const records: InkPages["pages"] = {};
    for (let n = 1; shapes && n <= shapes.count; n++) {
      records[pdfPageKey(n)] = pdfPageRecord(n, pagesView[pdfPageKey(n)]?.doc ?? EMPTY_PAGE_DOC, shapes.ratio(n));
    }
    return { version: 1, pages: records };
  }, [shapes, pagesView]);

  const goToPage = useCallback((pageNumber: number) => book?.scrollToPage(pdfPageKey(pageNumber)), [book]);

  /** What goes over a page's picture and under its ink surface: highlights, the Alt+drag preview,
   *  text boxes, the selection tip. Only for a page near the screen. */
  const pageLayers = (record: { key: string }, _host: HTMLElement | null, { box, near }: { box: { width: number; height: number }; near: boolean }) => {
    const pageNumber = pdfPageOfKey(record.key);
    if (pageNumber === null || !near) return null;
    return (
      <>
        <PdfPageHighlights highlights={highlights} pageNumber={pageNumber} viewport={box} />
        {areaPreview?.page === pageNumber && (
          <div
            className="pdf-area-preview pdf-hl-rect"
            style={{
              "--pdf-hl-left": `${areaPreview.left}px`,
              "--pdf-hl-top": `${areaPreview.top}px`,
              "--pdf-hl-width": `${areaPreview.width}px`,
              "--pdf-hl-height": `${areaPreview.height}px`,
            } as CSSProperties}
          />
        )}
        {texts && textDoc && (
          <TextBoxLayer
            controller={texts}
            doc={textDoc}
            pageKey={record.key}
            pageWidth={PDF_PAGE_UNITS}
            mode={textMode}
          />
        )}
        {tip?.page === pageNumber && (
          <div
            className="pdf-node-selection-tips"
            style={{ "--pdf-tip-x": tip.fx, "--pdf-tip-y": tip.fy } as CSSProperties}
            // preventDefault keeps the browser selection alive through the
            // click — otherwise mousedown collapses it and the tip unmounts
            // before onClick can fire.
            onMouseDown={keepFocus}
          >
            <Pressable type="button" className="pdf-node-selection-mark" onClick={handleHighlight}>{t("Mark")}</Pressable>
            <Pressable type="button" className="pdf-node-selection-tip" onClick={handleSpawnCard}>→ {t("Card")}</Pressable>
          </div>
        )}
      </>
    );
  };

  const pane = useExpandedPane(nodeId);

  return (
    <div className={pane.expanded ? `pdf-node pane--expanded ${layerClass.fill}` : "pdf-node"}>
      <div className="pdf-node-bar">
        <InkToolbar
          className="pdf-node-ink-toolbar"
          tool={activeTool}
          onToolChange={selectTool}
          leadingTools={SELECT_TOOLS}
          trailingTools={readOnly ? undefined : TEXT_TOOLS}
          readOnly={readOnly}
          {...pen.toolbar}
          canUndo={toolbarHistory.canUndo}
          canRedo={toolbarHistory.canRedo}
          onUndo={undo}
          onRedo={redo}
          trailing={<>
            <PageMoreMenu
              fingerDraws={!input.stylusOnly}
              onToggleFingerDraws={input.toggleFingerDraws}
              onZoomIn={() => book?.zoomBy(1.2)}
              onZoomOut={() => book?.zoomBy(1 / 1.2)}
              onFitWidth={() => book?.fitWidth()}
              onClearAll={readOnly ? undefined : () => { void clearAll(); }}
            />
            <ExpandPaneButton {...pane} />
          </>}
        />
      </div>
      {readOnly && <div className="pdf-node-notice" role="status">{isInkReadOnly(initialDoc) ? inkReadOnlyMessage() : (readOnlyNotice ?? inkReadOnlyMessage())}</div>}

      <div className="pdf-node-content">
        {spawnFlash && <span className="pdf-node-spawn-flash" role="status">{t("✓ Card created")}</span>}
        {pdfError ? (
          <div className="pdf-node-error">
            {t("Failed to load this PDF.")}
          </div>
        ) : (
          <PageBook
            key={pdfUrl}
            pages={pages}
            session={session}
            tool={inkTool}
            pen={pen}
            penSize="screen"
            penDraws={input.penDraws}
            stylusOnly={input.stylusOnly}
            onPenSeen={input.onPenSeen}
            onPenShortcut={onPenShortcut}
            reloadKey={docEpoch}
            onReady={setBook}
            t={t}
            background={(record, { box, near }) => {
              const pageNumber = pdfPageOfKey(record.key);
              return pdf && pageNumber !== null ? <PdfPageBackground pdf={pdf} pageNumber={pageNumber} box={box} near={near} onGoToPage={goToPage} /> : null;
            }}
            layers={pageLayers}
          />
        )}
      </div>
    </div>
  );
}
