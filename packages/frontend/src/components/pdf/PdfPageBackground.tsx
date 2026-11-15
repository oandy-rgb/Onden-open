// One PDF page as the page book's background: pdf.js draws the page into a canvas, its text into a
// selectable layer, and its links into a layer of anchors. It is the shell's side of the book's
// `background` slot (pagebook/PageBook.tsx) — the book knows nothing of PDF.
//
// Only a page near the screen draws (`near`): the canvas, the text layer and the links exist while
// it is, and go (canvas pixels released) when it is not, so a long PDF costs what is on the screen.
//
// Zoom: the picture is CSS-stretched to the page box, so a zoom shows the old pixels at once and
// the page is drawn again at the new resolution once the zoom has settled (REDRAW_DELAY_MS), the new
// canvas swapped in only when it is finished — no white flash. The text layer and the links are laid
// out in percent and by the `--pdf-scale` custom property, so a zoom needs no redraw of them.
// Canvas pixels per CSS px follow cappedPixelRatio (the same cap the ink canvases use).
//
// GEOMETRY: this fills the page sheet exactly (inset 0 of a sheet with no border or padding), the
// frame that stored highlights are measured against (lib/pdf/coords.ts).

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { cappedPixelRatio, pixelRatio } from "../../lib/ink";
import { createElement } from "../../lib/documentAccess";
import { onDocument, onWindow } from "../../lib/globalEvents";
import { Link } from "../ui";
import { pageLinkBoxes, type PdfLinkBox } from "./pageLinks";
import type { LoadedPdf, PdfPage } from "./usePdfDocument";
import "./PdfPageBackground.css";

/** A zoom burst (a wheel, a pinch) redraws once, this long after it stops. */
const REDRAW_DELAY_MS = 120;
/** A canvas within this fraction of the wanted pixel width is kept. */
const REDRAW_TOLERANCE = 0.05;
/** The text layer's glyph widths are measured at a scale; re-measure this long after a zoom settles. */
const TEXT_REMEASURE_DELAY_MS = 250;

export interface PdfPageBackgroundProps {
  pdf: LoadedPdf;
  pageNumber: number;
  /** The page's box in CSS px at the current zoom (PageContext.box). */
  box: { width: number; height: number };
  /** On or near the screen (PageContext.near). */
  near: boolean;
  /** A link inside the document was followed. */
  onGoToPage: (pageNumber: number) => void;
}

/** While a text selection is being made the layer's `.endOfContent` covers the layer, so a drag
 *  across blank space keeps selecting instead of jumping (pdf.js's TextLayerBuilder does the same). */
function bindSelecting(container: HTMLElement, end: HTMLElement): () => void {
  const reset = () => {
    container.append(end);
    container.classList.remove("selecting");
  };
  const begin = () => container.classList.add("selecting");
  container.addEventListener("pointerdown", begin);
  const stops = [onDocument("pointerup", reset), onWindow("blur", reset), onDocument("keyup", reset)];
  return () => {
    container.removeEventListener("pointerdown", begin);
    for (const stop of stops) stop();
  };
}

type TextLayerHandle = InstanceType<LoadedPdf["core"]["TextLayer"]>;
type RenderTask = ReturnType<PdfPage["render"]>;

export function PdfPageBackground({ pdf, pageNumber, box, near, onGoToPage }: PdfPageBackgroundProps) {
  const [page, setPage] = useState<PdfPage | null>(null);
  const [links, setLinks] = useState<PdfLinkBox[]>([]);
  const canvasHost = useRef<HTMLDivElement | null>(null);
  const textHost = useRef<HTMLDivElement | null>(null);
  const shownCanvas = useRef<HTMLCanvasElement | null>(null);
  const textLayer = useRef<TextLayerHandle | null>(null);
  const base = useMemo(() => page?.getViewport({ scale: 1 }) ?? null, [page]);
  /** CSS px per PDF unit now. */
  const scale = base ? box.width / base.width : 0;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  // The page object, once the page is first near.
  useEffect(() => {
    if (!near || page) return;
    let off = false;
    pdf.doc.getPage(pageNumber).then((p) => { if (!off) setPage(p); }, () => {});
    return () => { off = true; };
  }, [near, page, pdf.doc, pageNumber]);

  // The picture. A zoom redraws it at the new resolution when the zoom has settled.
  useEffect(() => {
    const host = canvasHost.current;
    if (!near || !page || !base || !host) return;
    const ratio = cappedPixelRatio(box.width, box.height, pixelRatio());
    const width = Math.max(1, Math.round(box.width * ratio));
    const shown = shownCanvas.current;
    if (shown && Math.abs(shown.width / width - 1) <= REDRAW_TOLERANCE) return;
    let cancelled = false;
    let task: RenderTask | null = null;
    const timer = setTimeout(() => {
      const canvas = createElement("canvas");
      canvas.width = width;
      canvas.height = Math.max(1, Math.round(box.height * ratio));
      const context = canvas.getContext("2d");
      if (!context) return;
      task = page.render({ canvasContext: context, canvas, viewport: page.getViewport({ scale: width / base.width }) });
      task.promise.then(() => {
        if (cancelled) return;
        host.append(canvas);
        const old = shownCanvas.current;
        shownCanvas.current = canvas;
        if (old) { old.remove(); old.width = 0; old.height = 0; }
      }, () => { /* cancelled by the next zoom, or a page pdf.js cannot draw: the old picture stays */ });
    }, shown ? REDRAW_DELAY_MS : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      task?.cancel();
    };
  }, [near, page, base, box.width, box.height]);

  // Far from the screen: let go of the pixels.
  useEffect(() => {
    if (near) return;
    const shown = shownCanvas.current;
    if (shown) { shown.remove(); shown.width = 0; shown.height = 0; shownCanvas.current = null; }
    page?.cleanup();
  }, [near, page]);
  useEffect(() => () => {
    const shown = shownCanvas.current;
    if (shown) { shown.width = 0; shown.height = 0; }
  }, []);

  // The text, selectable, drawn once while the page is near.
  useEffect(() => {
    const container = textHost.current;
    if (!near || !page || !container) return;
    let cancelled = false;
    let unbind = () => {};
    const layer = new pdf.core.TextLayer({
      textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
      container,
      viewport: page.getViewport({ scale: Math.max(0.1, scaleRef.current) }),
    });
    textLayer.current = layer;
    layer.render().then(() => {
      if (cancelled) return;
      const end = createElement("div");
      end.className = "endOfContent";
      container.append(end);
      unbind = bindSelecting(container, end);
    }, () => {});
    return () => {
      cancelled = true;
      unbind();
      layer.cancel();
      textLayer.current = null;
      container.replaceChildren();
      container.removeAttribute("style");
      container.removeAttribute("data-main-rotation");
      container.classList.remove("selecting");
    };
  }, [near, page, pdf.core]);
  useEffect(() => {
    const layer = textLayer.current;
    if (!layer || !page || !scale) return;
    const timer = setTimeout(() => layer.update({ viewport: page.getViewport({ scale }) }), TEXT_REMEASURE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [page, scale]);

  // The links, in percent of the page.
  useEffect(() => {
    if (!near || !page || !base) {
      if (!near) setLinks((cur) => (cur.length === 0 ? cur : []));
      return;
    }
    let off = false;
    page.getAnnotations({ intent: "display" }).then((annotations) => {
      if (off) return;
      setLinks(pageLinkBoxes(
        annotations,
        base,
        (rect) => [...base.convertToViewportPoint(rect[0]!, rect[1]!), ...base.convertToViewportPoint(rect[2]!, rect[3]!)],
        (url) => pdf.core.createValidAbsoluteUrl(url, undefined, { addDefaultProtocol: true })?.href ?? null,
      ));
    }, () => {});
    return () => { off = true; };
  }, [near, page, base, pdf.core]);

  const goTo = async (dest: unknown) => {
    try {
      const explicit = typeof dest === "string" ? await pdf.doc.getDestination(dest) : dest;
      const target: unknown = Array.isArray(explicit) ? explicit[0] : null;
      const index = typeof target === "number" ? target : target && typeof target === "object" ? await pdf.doc.getPageIndex(target as Parameters<typeof pdf.doc.getPageIndex>[0]) : null;
      if (index !== null) onGoToPage(index + 1);
    } catch {
      // A destination that does not resolve goes nowhere.
    }
  };

  return (
    <div className="pdf-page-bg" data-pdf-page={pageNumber} style={{ "--pdf-scale": String(scale || 1) } as CSSProperties}>
      <div ref={canvasHost} className="pdf-page-canvas" />
      <div ref={textHost} className="pdf-text-layer" />
      {links.length > 0 && (
        <div className="pdf-link-layer">
          {links.map((link, i) => (
            <Link
              key={i}
              className="pdf-link"
              style={{ "--pdf-link-left": `${link.left}%`, "--pdf-link-top": `${link.top}%`, "--pdf-link-width": `${link.width}%`, "--pdf-link-height": `${link.height}%` } as CSSProperties}
              {...(link.href
                ? { href: link.href, target: "_blank", rel: "noopener noreferrer" }
                : { href: "#", onClick: (e: { preventDefault(): void }) => { e.preventDefault(); void goTo(link.dest); } })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
