// Hover preview: a small marker under a hovering pen tip (iPad Safari with an
// M2+ Pencil, Samsung Internet with an S Pen). A browser that sends no hover
// events (Chrome on the Galaxy Tab) simply never shows it. Only `pen` pointers
// count: a mouse already has its cursor, a finger does not hover.
//
// One absolutely positioned div, moved with a transform inside a
// requestAnimationFrame: it never touches the canvases, so it cannot slow a
// stroke down (and nothing is drawn while a pen is down).
//
// It hides when the pen touches the screen, leaves the element, or no hover
// event has arrived for PEN_HOVER_IDLE_MS (hover events keep coming, jitter
// included, while the pen is in range). The element it is appended to must be
// positioned (the ink stages are).

/** No hover event for this long: the pen left the digitizer's range. */
export const PEN_HOVER_IDLE_MS = 400;

export interface PenHoverLook {
  /** Marker diameter in CSS px. */
  diameter: number;
  /** Fill colour of the dot; null draws the eraser's outline ring. */
  color: string | null;
  opacity: number;
}

export class PenHoverPreview {
  private marker: HTMLDivElement | null = null;
  private readonly pensDown = new Set<number>();
  private clientX = 0;
  private clientY = 0;
  private lastMoveT = 0;
  private shown = false;
  private frame: number | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  /** `look` is asked on every frame; null = no preview for the current tool. */
  constructor(private readonly host: HTMLElement, private readonly look: () => PenHoverLook | null) {}

  pointerDown(kind: string, id: number): void {
    if (kind !== "pen") return;
    this.pensDown.add(id);
    this.hide();
  }

  pointerEnd(kind: string, id: number): void {
    if (kind !== "pen") return;
    this.pensDown.delete(id);
    this.hide(); // the next hover move brings it back
  }

  pointerMove(kind: string, clientX: number, clientY: number): void {
    if (kind !== "pen" || this.pensDown.size > 0) return;
    this.clientX = clientX;
    this.clientY = clientY;
    this.lastMoveT = Date.now();
    this.shown = true;
    this.armIdle(PEN_HOVER_IDLE_MS);
    if (this.frame === null) this.frame = schedule(() => this.paint());
  }

  /** The pen left the element. */
  pointerLeave(kind: string): void {
    if (kind === "pen") this.hide();
  }

  hide(): void {
    this.shown = false;
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.frame !== null) cancelSchedule(this.frame);
    this.frame = null;
    if (this.marker) this.marker.style.display = "none";
  }

  dispose(): void {
    this.hide();
    this.pensDown.clear();
    this.marker?.remove();
    this.marker = null;
  }

  private armIdle(ms: number): void {
    if (this.idleTimer !== null) return; // one timer; it re-arms itself for the remainder
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const left = PEN_HOVER_IDLE_MS - (Date.now() - this.lastMoveT);
      if (left > 0) this.armIdle(left);
      else this.hide();
    }, ms);
  }

  private paint(): void {
    this.frame = null;
    if (!this.shown) return;
    const look = this.look();
    if (!look) {
      if (this.marker) this.marker.style.display = "none";
      return;
    }
    const rect = this.host.getBoundingClientRect();
    const marker = this.ensureMarker();
    const d = Math.max(2, look.diameter);
    const style = marker.style;
    style.display = "block";
    style.width = style.height = `${d}px`;
    style.transform = `translate(${this.clientX - rect.left - d / 2}px, ${this.clientY - rect.top - d / 2}px)`;
    style.opacity = String(look.opacity);
    style.background = look.color ?? "transparent";
    style.border = look.color ? "none" : "1.5px solid currentColor";
    marker.dataset.penHover = look.color ? "dot" : "ring";
  }

  private ensureMarker(): HTMLDivElement {
    if (this.marker) return this.marker;
    const marker = document.createElement("div");
    marker.setAttribute("aria-hidden", "true");
    Object.assign(marker.style, {
      position: "absolute",
      left: "0",
      top: "0",
      pointerEvents: "none",
      borderRadius: "50%",
      boxSizing: "border-box",
      willChange: "transform",
      zIndex: "3",
      color: "#8a8a8a",
      display: "none",
    });
    this.host.append(marker);
    this.marker = marker;
    return marker;
  }
}

function schedule(cb: () => void): number {
  return typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(cb)
    : (setTimeout(cb, 16) as unknown as number);
}

function cancelSchedule(id: number): void {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
  else clearTimeout(id);
}
