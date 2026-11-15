// Test setup for anything that mounts Puck under jsdom: it needs ResizeObserver
// and matchMedia at import time. Import this FIRST in the test file.
const g = globalThis as unknown as { ResizeObserver?: unknown };
g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
if (typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}
export {};
