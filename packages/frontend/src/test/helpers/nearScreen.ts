import { vi } from "vitest";

/** Every ink page counts as on the screen at once, as it does in a browser whose
 *  IntersectionObserver has reported (the page book only builds an engine for a page near the
 *  screen, and this test environment's IntersectionObserver never reports). Call in `beforeEach`;
 *  undo with `vi.unstubAllGlobals()`. */
export function stubPagesNearScreen(): void {
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private readonly onChange: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void) {}
    observe(target: Element) { this.onChange([{ isIntersecting: true, target }]); }
    disconnect() {}
    unobserve() {}
  });
}
