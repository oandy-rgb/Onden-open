import { ImageOff, Trash2 } from "lucide-react";
import {
  useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent,
} from "react";
import { mediaSrc } from "@onden/markdown";
import type { PageImage, PageImagesDoc } from "@onden/markdown/page-images";
import { getApiBase } from "../../lib/api";
import { isEscapeKey, isImeComposing } from "../../lib/keys";
import { useT } from "../../lib/i18n";
import { classNames } from "../../lib/utils";
import { moved, resizedFromCorner, type Corner, type PageImagesController, type Rect } from "../../lib/pageImages";
import { isPrimaryPress } from "../../lib/pageText";
import "./PageImageLayer.css";
import { capturePointer, DRAG_SLOP_PX } from "../../lib/pointerDrag";
import { observeSize } from "../../lib/observeSize";
import { Img, Pressable } from "../ui";

// The pictures of one page. The page supplies only: its key, how wide it is in
// page units, and where to put the layer. Pictures are stored in page units
// (@onden/markdown/page-images) and drawn at the page's current size.
//
// A picture lies UNDER the pen strokes (the ink canvases sit over the paper),
// but its handles must be reachable, so the layer comes in two parts that read
// the same controller:
//   part="art"       the pictures themselves, inside the paper, under the ink;
//   part="controls"  an invisible box over each picture, its outline, four
//                    corner handles and the delete button, over the ink — only
//                    while the Hand (select) tool is on (`mode="select"`).
// A press on a picture moves it (pen, finger or mouse alike); a corner resizes
// it and keeps its proportions; Delete removes it; Esc lets go. Saving and the
// undo stack are the controller's.

export type PageImageMode = "view" | "select";

type Props = {
  controller: PageImagesController;
  /** The controller's document (usePageImagesController): re-renders on change. */
  doc: PageImagesDoc;
  pageKey: string;
  /** Page units across the page's full width. */
  pageWidth: number;
  part: "art" | "controls";
  mode?: PageImageMode;
  /** CSS px per page unit, when it cannot be measured (tests). */
  scale?: number;
};

const px = (n: number) => `${n}px`;
const NUDGE = 10;
const CORNERS: readonly Corner[] = ["nw", "ne", "sw", "se"];

/** CSS px per page unit of the layer's own box (it fills the page), and how
 *  long the page is so far in page units (Infinity when it cannot be measured). */
function useScale(rootRef: React.RefObject<HTMLElement | null>, pageWidth: number, fixed: number | undefined): { scale: number; pageHeight: number } {
  const [measured, setMeasured] = useState({ scale: 1, pageHeight: Infinity });
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || fixed !== undefined) return;
    const measure = () => {
      if (root.clientWidth <= 0) return;
      const scale = root.clientWidth / pageWidth;
      setMeasured({ scale, pageHeight: root.clientHeight > 0 ? root.clientHeight / scale : Infinity });
    };
    measure();
    return observeSize(root, measure);
  }, [rootRef, pageWidth, fixed]);
  return fixed === undefined ? measured : { scale: fixed, pageHeight: Infinity };
}

export default function PageImageLayer({ controller, doc, pageKey, pageWidth, part, mode = "view", scale: scaleProp }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { scale, pageHeight } = useScale(rootRef, pageWidth, scaleProp);
  const images = doc.pages[pageKey]?.images ?? [];
  const interactive = part === "controls" && mode === "select" && !controller.readOnly;
  const selection = useSyncExternalStore(controller.subscribe, controller.getSelection);

  // Leaving the Hand tool lets go of the picture.
  useEffect(() => { if (part === "controls" && !interactive) controller.clearSelection(); }, [part, interactive, controller]);

  if (images.length === 0) return <div ref={rootRef} className={`page-image-layer page-image-layer--${part}`} aria-hidden="true" />;
  return (
    <div ref={rootRef} className={`page-image-layer page-image-layer--${part}`} data-page-images-page={pageKey} data-page-images-part={part}>
      {part === "art"
        ? images.map((image) => <PictureView key={image.id} image={image} scale={scale} />)
        : interactive && images.map((image) => (
          <PictureHandles
            key={image.id}
            image={image}
            pageKey={pageKey}
            pageWidth={pageWidth}
            pageHeight={pageHeight}
            scale={scale}
            selected={selection?.pageKey === pageKey && selection.id === image.id}
            controller={controller}
          />
        ))}
    </div>
  );
}

function PictureView({ image, scale }: { image: PageImage; scale: number }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const src = mediaSrc(image.src, { apiBase: getApiBase() });
  useEffect(() => { setFailed(false); }, [src]);
  return (
    <div className={classNames("page-image", failed && "page-image--missing")} style={{ "--pi-left": px(image.x * scale), "--pi-top": px(image.y * scale), "--pi-width": px(image.w * scale), "--pi-height": px(image.h * scale) } as CSSProperties} data-page-image={image.id}>
      {failed || !src
        ? <span className="page-image-missing"><ImageOff size={20} aria-hidden="true" /><span>{image.alt || t("Picture")}</span></span>
        : <Img src={src} alt={image.alt} draggable={false} onError={() => setFailed(true)} />}
    </div>
  );
}

type Press =
  | { kind: "move"; id: number; x: number; y: number; from: Rect; moved: boolean }
  | { kind: "resize"; id: number; x: number; y: number; from: Rect; corner: Corner; moved: boolean };

function PictureHandles({ image, pageKey, pageWidth, pageHeight, scale, selected, controller }: {
  image: PageImage; pageKey: string; pageWidth: number; pageHeight: number; scale: number; selected: boolean; controller: PageImagesController;
}) {
  const t = useT();
  const press = useRef<Press | null>(null);
  const rect: Rect = { x: image.x, y: image.y, w: image.w, h: image.h };

  const start = (e: ReactPointerEvent, next: Press) => {
    if (!isPrimaryPress(e)) return;
    e.stopPropagation(); // the page under it neither draws nor scrolls with this press
    e.preventDefault();
    press.current = next;
    capturePointer(e.currentTarget, e.pointerId);
  };
  const onBoxDown = (e: ReactPointerEvent) => start(e, { kind: "move", id: e.pointerId, x: e.clientX, y: e.clientY, from: rect, moved: false });
  const onCornerDown = (corner: Corner) => (e: ReactPointerEvent) =>
    start(e, { kind: "resize", id: e.pointerId, x: e.clientX, y: e.clientY, from: rect, corner, moved: false });
  const onMove = (e: ReactPointerEvent) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (!p.moved && Math.hypot(dx, dy) < DRAG_SLOP_PX) return;
    p.moved = true;
    controller.preview(pageKey, image.id, p.kind === "move"
      ? moved(p.from, dx / scale, dy / scale, pageWidth, pageHeight)
      : resizedFromCorner(p.from, p.corner, dx / scale, dy / scale, pageWidth, pageHeight));
  };
  const onUp = (e: ReactPointerEvent) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    if (p.moved) {
      const now = controller.image(pageKey, image.id);
      if (now) controller.setRect(pageKey, image.id, { x: now.x, y: now.y, w: now.w, h: now.h });
    }
    controller.select(pageKey, image.id);
  };
  const onCancel = () => { if (press.current?.moved) controller.cancelPreview(); press.current = null; };

  const onKey = (e: KeyboardEvent) => {
    if (isImeComposing(e)) return;
    const step = (e.shiftKey ? 5 : 1) * NUDGE;
    const nudge = e.key === "ArrowLeft" ? [-step, 0] : e.key === "ArrowRight" ? [step, 0] : e.key === "ArrowUp" ? [0, -step] : e.key === "ArrowDown" ? [0, step] : null;
    if (nudge) {
      e.preventDefault();
      controller.select(pageKey, image.id);
      const next = moved(rect, nudge[0]!, nudge[1]!, pageWidth, pageHeight);
      controller.setRect(pageKey, image.id, next);
    } else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); controller.removeImage(pageKey, image.id); }
    else if (isEscapeKey(e)) { e.preventDefault(); controller.clearSelection(); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); controller.select(pageKey, image.id); }
  };

  const label = image.alt || t("Picture");
  return (
    <div
      className={classNames("page-image-box", selected && "page-image-box--selected")}
      style={{ "--pi-left": px(image.x * scale), "--pi-top": px(image.y * scale), "--pi-width": px(image.w * scale), "--pi-height": px(image.h * scale) } as CSSProperties}
      data-page-image-box={image.id}
      role="group"
      tabIndex={0}
      aria-label={label}
      onPointerDown={onBoxDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancel}
      onKeyDown={onKey}
      onFocus={() => controller.select(pageKey, image.id)}
    >
      {selected && CORNERS.map((corner) => (
        <span
          key={corner}
          className={`page-image-handle page-image-handle--${corner}`}
          data-page-image-handle={corner}
          role="separator"
          aria-label={t("Resize picture")}
          onPointerDown={onCornerDown(corner)}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onCancel}
        />
      ))}
      {selected && (
        <Pressable
          type="button"
          className={classNames("page-image-delete", image.y * scale < 52 && "page-image-delete--inside")}
          aria-label={t("Delete picture")}
          title={t("Delete picture")}
          // The press must not start a move of the box under it.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => controller.removeImage(pageKey, image.id)}
        ><Trash2 size={16} /></Pressable>
      )}
    </div>
  );
}
