// Where a whiteboard's camera starts on a TOUCH screen when it is opened without a remembered viewport.
//
// "Fit everything" is right for a handful of cards and wrong on a touch screen's narrow board: a grid of 260px cards
// fitted into a tablet's column came out at 40%, with the text too small to read (2026-11-17, a Galaxy Tab S9).
// So the first view never goes below READABLE_ZOOM and is not blown up past OPEN_ZOOM_MAX: when everything does not
// fit at that scale the camera starts at the top-left of the content, where reading starts, and 「顯示全部」 (the
// button) still shows all of it. A mouse keeps React Flow's own fit of everything (useBoardCamera decides which; owner
// decision 2026-11-19). The numbers are px, so any board width works.

const READABLE_ZOOM = 0.75;
const OPEN_ZOOM_MAX = 1;

type FitBox = { x: number; y: number; width: number; height: number };
export type FitPadding = { top: number; right: number; bottom: number; left: number };

/** The viewport (React Flow's: pan in screen px, zoom) a board opens at. `bounds`: its cards in board coordinates. */
export function openViewport(bounds: FitBox, size: { width: number; height: number }, pad: FitPadding): { x: number; y: number; zoom: number } {
  const roomW = Math.max(1, size.width - pad.left - pad.right);
  const roomH = Math.max(1, size.height - pad.top - pad.bottom);
  const fits = Math.min(roomW / Math.max(1, bounds.width), roomH / Math.max(1, bounds.height));
  const zoom = Math.min(OPEN_ZOOM_MAX, Math.max(READABLE_ZOOM, fits));
  // Left over after the content is placed: centred when it all fits, otherwise it starts at the top-left corner.
  const spareW = Math.max(0, roomW - bounds.width * zoom);
  const spareH = Math.max(0, roomH - bounds.height * zoom);
  return { zoom, x: pad.left + spareW / 2 - bounds.x * zoom, y: pad.top + spareH / 2 - bounds.y * zoom };
}
