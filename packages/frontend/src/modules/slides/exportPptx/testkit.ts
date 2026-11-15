import { vi } from "vitest";

/** jsdom lays nothing out: gives every element a place, in drawing order (the canvas the full 1920 × 1080). For tests of reading a slide. */
export function placeElements(): void {
  let n = 0;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const full = this.classList.contains("sv-canvas");
    const y = full ? 0 : 60 * ++n;
    return { x: full ? 0 : 100, y, left: full ? 0 : 100, top: y, width: full ? 1920 : 800, height: full ? 1080 : 50, right: 900, bottom: y + 50, toJSON() {} } as DOMRect;
  });
}
