// The page book: pages stacked top to bottom in one native scroll container, each with its own
// ink surface. It knows the page envelope (@onden/markdown/ink InkPages) and nothing about what is
// behind a page — a blank sheet, a PDF page, later a slide: that is the `background` slot — and it
// reaches nothing of the app: saving, translation, device settings and the layers over a page
// (text boxes, pictures) come in as props from the shell that mounts it (eslint.boundaries.config.js).
//
//   <PageBook
//     pages={pages}                      // InkPages; pages top to bottom are inkPageOrder(pages)
//     session={session}                  // InkPageSession: the engines' edits, applied by the shell
//     background={(page, { box, near }) => <PdfPage …/>} // optional; the page box is its parent
//     layers={(page, host, { box, near }) => <Layers/>}  // optional; `host` is the page's ink surface
//     tool={tool}                        // null: no ink surface on any page (text selection, reading)
//     pen={pen} penSize="screen" penDraws stylusOnly onPenSeen onPenShortcut
//     reloadKey={epoch}                  // another version of the drawing arrived: engines rebuild
//     onAddPage={addPage}                // omitted: no "+ Add page" button
//     onReady={(api) => …}               // zoom, scroll to a page, find a page's element and box
//     t={t}
//   />
//
// The slots are what the book knows of a page's content, and they are all it knows: `background`
// is under the ink (a PDF page's canvas, text layer and links), `layers` over it (text boxes,
// highlights). Both get the page's box (CSS px at the current zoom) and whether the page is on or
// near the screen, so a heavy background draws only where it is seen and lets go of its pixels
// elsewhere. A background can be wider than its page's ink (a PDF page is 1000 × 1000·h/w units: the
// shell hands the book the real ratio, so the sheet is the page's own shape before it is drawn).
// The sheet (`[data-page-key]`) has no border and no padding: its box IS the page's box, so a
// position measured against it (a PDF highlight, lib/pdf/coords.ts) needs no correction.
//
// When a page's size in `pages` changes (a PDF's pages are measured one by one after it opens), the
// book keeps the page point at the top of the view where it was.
//
// Camera: the browser scrolls the container natively. Zoom is the pages' CSS width (1 = fit width,
// PAGE_ZOOM_MIN–PAGE_ZOOM_MAX); a zoom keeps the point under the cursor or fingers where it was.
// Two fingers zoom with a live preview (lib/ink/touchSplit.ts), ⌘ / Ctrl + wheel zooms around the
// cursor, and a pen or mouse drag with the Hand tool scrolls (the engines' `gestures`, with the
// glide of lib/ink/glide.ts). Pages are fixed sheets: a drawing never makes one longer.

import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { inkPageOrder, type InkPageRecord, type InkPages } from "@onden/markdown/ink";
import {
  PAGE_ZOOM_MAX, PAGE_ZOOM_MIN, deviceHasTouch, installTouchSplit, observeSize, startGlide, useNearScreen,
  type InkActiveTool, type InkGestureHost, type InkShapeFill, type InkShapeKind, type PageSurfaceSession, type PinchHost,
} from "../lib/ink";
import { Pressable } from "../components/ui";
import { PageInkSurface } from "./PageInkSurface";
import { PageInkSvg } from "./PageInkSvg";
import { useLivePages } from "./useLivePages";
import "./PageBook.css";

/** Space around and between the sheets (CSS px). */
const GUTTER = 12;
const SCROLLER_CLASS = "pagebook-scroll";

export interface PageBookPen {
  color: string;
  /** Stroke width in page units. */
  size: number;
  shapeKind: InkShapeKind;
  shapeFill: InkShapeFill;
  autoShape: boolean;
}

/** What the shell can ask of the book. */
export interface PageBookApi {
  /** Zoom by `factor` around the middle of the view. */
  zoomBy(factor: number): void;
  /** Back to fit width, keeping the middle of the view. */
  fitWidth(): void;
  /** Scroll so the top of page `key` is at the top of the view (once it is on the screen, so a page
   *  added a moment ago works). */
  scrollToPage(key: string): void;
  /** The page with the most of the view over it, with the client rects `visiblePageBand` takes. */
  mainVisiblePage(): { key: string; view: { top: number; bottom: number }; page: { top: number; bottom: number; width: number } } | null;
  /** Scroll so page unit `y` of page `key` is a little below the top of the view (a quoted area to show). */
  scrollToUnit(key: string, y: number): void;
  /** The scrolling element (what listeners for the whole book attach to). */
  scroller(): HTMLElement | null;
  /** The sheet under a client point. */
  pageAt(clientX: number, clientY: number): { key: string; element: HTMLElement } | null;
  /** Every laid-out sheet's client rect, top to bottom (one query: a shell that maps a text
   *  selection to pages needs them all). */
  pageRects(): Array<{ key: string; rect: DOMRect }>;
  /** A page's box in CSS px at the current zoom (what its sheet is laid out at), without measuring
   *  the DOM; null for a key that is not a page. */
  pageBox(key: string): { width: number; height: number } | null;
}

/** What a slot learns of its page. */
export interface PageContext {
  /** The page's box in CSS px at the current zoom. */
  box: { width: number; height: number };
  /** On the screen or within about half a screen of it (an observer reported it; always true
   *  where there is no IntersectionObserver). */
  near: boolean;
}

export interface PageBookProps {
  pages: InkPages;
  /** The app is dark (strokes are drawn with inverted lightness). */
  dark?: boolean;
  background?: (page: InkPageRecord, context: PageContext) => ReactNode;
  layers?: (page: InkPageRecord, host: HTMLElement | null, context: PageContext) => ReactNode;
  session: PageSurfaceSession;
  /** The ink tool whose surface every page mounts; null mounts none (the shell is reading or
   *  selecting text: a surface would take the pointer). Fingers then only scroll and pinch. */
  tool: InkActiveTool | null;
  pen: PageBookPen;
  /** Whether `pen.size` is px on screen (a PDF: the same at any zoom) or page units (a notebook:
   *  strokes scale with the paper). */
  penSize?: "screen" | "page";
  /** Changes when another version of the drawing arrives: every page's engine is rebuilt from `pages`. */
  reloadKey?: number | string;
  penDraws: boolean;
  stylusOnly: boolean;
  onPenSeen: () => void;
  onPenShortcut: () => void;
  onAddPage?: () => void;
  onReady?: (api: PageBookApi) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const clampZoom = (zoom: number) => (Number.isFinite(zoom) ? Math.min(PAGE_ZOOM_MAX, Math.max(PAGE_ZOOM_MIN, zoom)) : 1);

/** A point on a page, as fractions of its box: what a zoom keeps where it was. */
interface Anchor { key: string; fx: number; fy: number }
/** A point on a page, as page units down from its top: what a change of page sizes keeps where it was
 *  (a page that grows keeps the same content at the top of the view, not the same fraction). */
interface UnitAnchor { key: string; y: number }

/** The page's CSS width and height for a given fit width and zoom. */
const boxOf = (record: InkPageRecord, fit: number, zoom: number) => {
  const width = (fit * zoom * record.size.width) / 1000;
  return { width, height: (width * record.size.height) / record.size.width };
};

/** One sheet: its element, and whether it is near the screen (one observer per page, shared by the
 *  slots). The ink surface keeps its own observer on the same rule. */
function Sheet({ pageKey, box, children }: { pageKey: string; box: { width: number; height: number }; children: (near: boolean) => ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const near = useNearScreen(ref, `.${SCROLLER_CLASS}`);
  return (
    <div ref={ref} className="pagebook-page" data-page-key={pageKey} style={{ "--pagebook-w": `${box.width}px`, "--pagebook-h": `${box.height}px` } as CSSProperties}>
      {children(near)}
    </div>
  );
}

export function PageBook({
  pages, dark = false, background, layers, session, tool, pen, penSize = "page", reloadKey, penDraws, stylusOnly, onPenSeen, onPenShortcut, onAddPage, onReady, t,
}: PageBookProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const pagesDocRef = useRef(pages);
  pagesDocRef.current = pages;
  const [zoom, setZoomState] = useState(1);
  const zoomRef = useRef(1);
  const [viewWidth, setViewWidth] = useState(0);
  const { live, onLiveChange } = useLivePages();
  const [hosts, setHosts] = useState<Readonly<Record<string, HTMLElement | null>>>({});
  const hostSetters = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const pendingScroll = useRef<string | null>(null);
  const stopGlide = useRef<() => void>(() => {});
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const viewWidthRef = useRef(0);
  const sizeSnapshot = useRef<Map<string, string>>(new Map());
  const sizeAnchor = useRef<UnitAnchor | null>(null);

  const order = inkPageOrder(pages);
  const fit = Math.max(1, (viewWidth || 1000) - 2 * GUTTER);
  const fitRef = useRef(fit);
  fitRef.current = fit;


  const hostSetter = (key: string) => {
    let set = hostSetters.current.get(key);
    if (!set) {
      set = (el) => setHosts((cur) => (cur[key] === el || (el === null && !(key in cur)) ? cur : { ...cur, [key]: el }));
      hostSetters.current.set(key, set);
    }
    return set;
  };

  // The view's width is the fit width; the vertical scrollbar's gutter is reserved, so the page
  // height never changes it.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const measure = () => { viewWidthRef.current = scroller.clientWidth; setViewWidth(scroller.clientWidth); };
    measure();
    return observeSize(scroller, measure);
  }, []);

  // ── Camera ────────────────────────────────────────────────────────────────

  const pageElements = useCallback(() => Array.from(pagesRef.current?.querySelectorAll<HTMLElement>("[data-page-key]") ?? []), []);

  /** The page under (or nearest to) a client point, and where on it. */
  const anchorAt = (x: number, y: number): Anchor | null => {
    let best: (Anchor & { gap: number }) | null = null;
    for (const el of pageElements()) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const gap = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (!best || gap < best.gap) best = { key: el.dataset.pageKey!, fx: (x - r.left) / r.width, fy: (y - r.top) / r.height, gap };
      if (gap === 0) break;
    }
    return best;
  };

  /** Put the anchored point back under client (x, y), after the pages changed size. */
  const restoreAnchor = (anchor: Anchor | null, x: number, y: number) => {
    const scroller = scrollRef.current;
    const el = anchor && pageElements().find((e) => e.dataset.pageKey === anchor.key);
    if (!scroller || !anchor || !el) return;
    const r = el.getBoundingClientRect();
    scroller.scrollLeft += r.left + anchor.fx * r.width - x;
    scroller.scrollTop += r.top + anchor.fy * r.height - y;
  };

  /** The page point at the top of the view, in page units from its page's top. */
  const unitAnchorAtViewTop = (): UnitAnchor | null => {
    const view = scrollRef.current?.getBoundingClientRect();
    if (!view) return null;
    const anchor = anchorAt(view.left + 1, view.top);
    const el = anchor && pageElements().find((e) => e.dataset.pageKey === anchor.key);
    if (!anchor || !el) return null;
    const r = el.getBoundingClientRect();
    return { key: anchor.key, y: ((view.top - r.top) * 1000) / r.width };
  };
  const restoreUnitAnchor = (anchor: UnitAnchor) => {
    const scroller = scrollRef.current;
    const el = pageElements().find((e) => e.dataset.pageKey === anchor.key);
    if (!scroller || !el) return;
    const r = el.getBoundingClientRect();
    scroller.scrollTop += r.top + (anchor.y * r.width) / 1000 - scroller.getBoundingClientRect().top;
  };

  // Pages that changed size (in units): remember the page point at the top of the view NOW, while the
  // DOM still has the old layout; the layout effect below puts it back. Read in render on purpose.
  const sizes = new Map(order.map((key) => [key, `${pages.pages[key]!.size.width}x${pages.pages[key]!.size.height}`] as const));
  const prevSizes = sizeSnapshot.current;
  if (prevSizes.size > 0 && order.some((key) => prevSizes.has(key) && prevSizes.get(key) !== sizes.get(key))) {
    sizeAnchor.current = unitAnchorAtViewTop();
  }
  sizeSnapshot.current = sizes;

  /** Zoom to `next`, keeping `anchor` under client (x, y). Laid out at once, so a burst of wheel
   *  events each measures the pages as the one before left them. */
  const zoomTo = (next: number, anchor: Anchor | null, x: number, y: number) => {
    const clamped = clampZoom(next);
    if (clamped === zoomRef.current) return;
    zoomRef.current = clamped;
    flushSync(() => setZoomState(clamped));
    restoreAnchor(anchor, x, y);
  };
  const zoomAt = (factor: number, x: number, y: number) => {
    stopGlide.current();
    zoomTo(zoomRef.current * factor, anchorAt(x, y), x, y);
  };
  const viewCenter = (): [number, number] => {
    const r = scrollRef.current?.getBoundingClientRect();
    return r ? [r.left + r.width / 2, r.top + r.height / 2] : [0, 0];
  };

  const pinchRef = useRef<{ anchor: Anchor | null; x0: number; y0: number; scale: number; x: number; y: number } | null>(null);
  const pinch: PinchHost = {
    start: (x, y) => {
      const el = pagesRef.current;
      if (!el) return;
      stopGlide.current();
      const r = el.getBoundingClientRect();
      el.style.transformOrigin = `${x - r.left}px ${y - r.top}px`;
      el.classList.add("is-pinching");
      pinchRef.current = { anchor: anchorAt(x, y), x0: x, y0: y, scale: 1, x, y };
    },
    move: (scale, x, y) => {
      const p = pinchRef.current;
      const el = pagesRef.current;
      if (!p || !el) return;
      p.scale = Math.min(PAGE_ZOOM_MAX / zoomRef.current, Math.max(PAGE_ZOOM_MIN / zoomRef.current, scale));
      p.x = x;
      p.y = y;
      el.style.transform = `translate(${x - p.x0}px, ${y - p.y0}px) scale(${p.scale})`;
    },
    end: () => {
      const p = pinchRef.current;
      const el = pagesRef.current;
      pinchRef.current = null;
      if (el) {
        el.style.transform = "";
        el.style.transformOrigin = "";
        el.classList.remove("is-pinching");
      }
      if (!p) return;
      if (Math.abs(p.scale - 1) > 0.01) zoomTo(zoomRef.current * p.scale, p.anchor, p.x, p.y);
      else restoreAnchor(p.anchor, p.x0, p.y0);
    },
  };

  const gestures: InkGestureHost = {
    pan: (dx, dy) => {
      stopGlide.current();
      const scroller = scrollRef.current;
      if (!scroller) return;
      scroller.scrollLeft -= dx;
      scroller.scrollTop -= dy;
    },
    zoom: (factor, x, y) => zoomAt(factor, x, y),
    fling: (vx, vy) => {
      stopGlide.current();
      stopGlide.current = startGlide(vx, vy, (dx, dy) => {
        const scroller = scrollRef.current;
        if (!scroller) return false;
        const before = [scroller.scrollLeft, scroller.scrollTop];
        scroller.scrollLeft += dx;
        scroller.scrollTop += dy;
        return before[0] !== scroller.scrollLeft || before[1] !== scroller.scrollTop;
      });
    },
  };
  // The surfaces and the listeners below are built once: they read the camera through here.
  const cameraRef = useRef({ gestures, pinch, zoomAt });
  cameraRef.current = { gestures, pinch, zoomAt };
  const stableGestures = useMemo<InkGestureHost>(() => ({
    pan: (dx, dy) => cameraRef.current.gestures.pan(dx, dy),
    zoom: (factor, x, y) => cameraRef.current.gestures.zoom(factor, x, y),
    fling: (vx, vy) => cameraRef.current.gestures.fling?.(vx, vy),
  }), []);

  // The page asked for is scrolled to as soon as it is laid out: at once if it is, otherwise (a page
  // added a moment ago) when the pages next change.
  const flushScroll = useCallback(() => {
    const key = pendingScroll.current;
    const scroller = scrollRef.current;
    const el = key && pageElements().find((e) => e.dataset.pageKey === key);
    if (!key || !scroller || !el) return;
    pendingScroll.current = null;
    scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - GUTTER;
  }, [pageElements]);
  const api = useMemo<PageBookApi>(() => ({
    scroller: () => scrollRef.current,
    pageRects: () => pageElements().map((element) => ({ key: element.dataset.pageKey!, rect: element.getBoundingClientRect() })),
    pageAt: (x, y) => {
      for (const element of pageElements()) {
        const r = element.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { key: element.dataset.pageKey!, element };
      }
      return null;
    },
    pageBox: (key) => {
      const record = pagesDocRef.current.pages[key];
      return record ? boxOf(record, fitRef.current, zoomRef.current) : null;
    },
    zoomBy: (factor) => { const [x, y] = viewCenter(); cameraRef.current.zoomAt(factor, x, y); },
    fitWidth: () => { const [x, y] = viewCenter(); cameraRef.current.zoomAt(1 / zoomRef.current, x, y); },
    scrollToPage: (key) => { pendingScroll.current = key; flushScroll(); },
    scrollToUnit: (key, y) => {
      const scroller = scrollRef.current;
      const record = pagesDocRef.current.pages[key];
      const el = pageElements().find((e) => e.dataset.pageKey === key);
      if (!scroller || !record || !el) return;
      const rect = el.getBoundingClientRect();
      const at = rect.top + (Math.max(0, y) / record.size.height) * rect.height;
      scroller.scrollTop += at - scroller.getBoundingClientRect().top - Math.min(120, scroller.clientHeight * 0.25);
    },
    mainVisiblePage: () => {
      const view = scrollRef.current?.getBoundingClientRect();
      if (!view) return null;
      let best: { key: string; overlap: number; rect: DOMRect } | null = null;
      for (const el of pageElements()) {
        const rect = el.getBoundingClientRect();
        const overlap = Math.min(rect.bottom, view.bottom) - Math.max(rect.top, view.top);
        if (!best || overlap > best.overlap) best = { key: el.dataset.pageKey!, overlap, rect };
      }
      return best ? { key: best.key, view: { top: view.top, bottom: view.bottom }, page: { top: best.rect.top, bottom: best.rect.bottom, width: best.rect.width } } : null;
    },
  }), [pageElements, flushScroll]);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  useEffect(() => { onReadyRef.current?.(api); }, [api]);

  useLayoutEffect(flushScroll, [pages, flushScroll]);

  // Pages changed size: the point that was at the top of the view goes back to the top of the view.
  useLayoutEffect(() => {
    const anchor = sizeAnchor.current;
    sizeAnchor.current = null;
    if (anchor) restoreUnitAnchor(anchor);
  });

  // Fingers: one scrolls natively, two zoom, and while the pen owns the surface a resting palm
  // never scrolls (touchSplit). ⌘ / Ctrl + wheel (and Chrome's trackpad pinch) zooms around the
  // cursor; Safari's trackpad pinch arrives as gesture events.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const stopSplit = installTouchSplit(scroller, { penOwned: () => toolRef.current !== null, pinch: { start: (x, y) => cameraRef.current.pinch.start(x, y), move: (s, x, y) => cameraRef.current.pinch.move(s, x, y), end: () => cameraRef.current.pinch.end() } });
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      cameraRef.current.zoomAt(Math.pow(2, -e.deltaY * 0.01), e.clientX, e.clientY);
    };
    let gestureScale = 1;
    const touchDevice = deviceHasTouch();
    const onGestureStart = (e: Event) => { e.preventDefault(); gestureScale = 1; };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale?: number; clientX?: number; clientY?: number };
      if (touchDevice || !g.scale) return;
      cameraRef.current.zoomAt(g.scale / gestureScale, g.clientX ?? 0, g.clientY ?? 0);
      gestureScale = g.scale;
    };
    const onGestureEnd = (e: Event) => e.preventDefault();
    const onDown = () => stopGlide.current();
    scroller.addEventListener("wheel", onWheel, { passive: false });
    scroller.addEventListener("gesturestart", onGestureStart);
    scroller.addEventListener("gesturechange", onGestureChange);
    scroller.addEventListener("gestureend", onGestureEnd);
    scroller.addEventListener("pointerdown", onDown);
    return () => {
      stopSplit();
      stopGlide.current();
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("gesturestart", onGestureStart);
      scroller.removeEventListener("gesturechange", onGestureChange);
      scroller.removeEventListener("gestureend", onGestureEnd);
      scroller.removeEventListener("pointerdown", onDown);
    };
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  const percent = Math.round(zoom * 100);
  const zoomLabel = t("Zoom {percent}% — tap to fit width", { percent });
  return (
    <div className="pagebook" data-pagebook-zoom={zoom}>
      <div ref={scrollRef} className={SCROLLER_CLASS}>
        <div ref={pagesRef} className="pagebook-pages" style={{ "--pagebook-gutter": `${GUTTER}px` } as CSSProperties}>
          {order.map((key) => {
            const record = pages.pages[key]!;
            const box = boxOf(record, fit, zoom);
            return (
              <Sheet key={key} pageKey={key} box={box}>
                {(near) => {
                  const context: PageContext = { box, near };
                  return (
                    <>
                      {background?.(record, context)}
                      {!live.has(key) && <PageInkSvg doc={record.doc} heightUnits={record.size.height} />}
                      {layers?.(record, hosts[key] ?? null, context)}
                      {tool !== null && (
                        <PageInkSurface
                          key={reloadKey}
                          pageKey={key}
                          box={box}
                          session={session}
                          getDoc={() => pagesDocRef.current.pages[key]?.doc ?? null}
                          scrollerSelector={`.${SCROLLER_CLASS}`}
                          tool={tool}
                          color={pen.color}
                          size={pen.size}
                          penSize={penSize}
                          shapeKind={pen.shapeKind}
                          shapeFill={pen.shapeFill}
                          autoShape={pen.autoShape}
                          dark={dark}
                          stylusOnly={stylusOnly}
                          penDraws={penDraws}
                          onPenSeen={onPenSeen}
                          onPenShortcut={onPenShortcut}
                          gestures={stableGestures}
                          onLiveChange={onLiveChange}
                          onHost={hostSetter(key)}
                        />
                      )}
                    </>
                  );
                }}
              </Sheet>
            );
          })}
          {onAddPage && (
            <Pressable type="button" className="pagebook-add" onClick={onAddPage}>{t("+ Add page")}</Pressable>
          )}
        </div>
      </div>
      <Pressable type="button" className="pagebook-zoom" onClick={() => api.fitWidth()} title={zoomLabel} aria-label={zoomLabel}>{percent}%</Pressable>
    </div>
  );
}
