// Shared measurements for the zzDeepCol* saved-view specs (not a spec: nothing here runs on its own).
import type { Browser, BrowserContext, BrowserContextOptions, Locator, Page, test as playwrightTest } from "@playwright/test";
import { ready } from "./helpers";

/** What a finger can actually hit: how many px of the element's centre line, in each direction, resolve to the element
 *  (or something inside it, an `::after` that widens the target counts). Same measure as layout-audit rule R7, which
 *  asks 44px on a phone (`--ac-tap`); a bounding box alone would miss a target that is widened by a pseudo-element. */
export async function clickableSize(locator: Locator): Promise<{ w: number; h: number }> {
  await locator.scrollIntoViewIfNeeded(); // elementFromPoint only answers inside the viewport
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hits = (x: number, y: number) => { const at = document.elementFromPoint(x, y); return !!at && el.contains(at); };
    let w = 0;
    let h = 0;
    for (let x = Math.floor(r.left) - 30; x <= Math.ceil(r.right) + 30; x++) if (hits(x, cy)) w++;
    for (let y = Math.floor(r.top) - 30; y <= Math.ceil(r.bottom) + 30; y++) if (hits(cx, y)) h++;
    return { w, h };
  });
}

/** `browser.newContext` for the zzDeepCol* specs: whatever a test opens is closed when the test ends, passed or failed. A context left open
 *  (a `FINDING` test stops at its failing line, before the `close()` below it) keeps its app page syncing against the shared server for the
 *  rest of the run, and every spec after it gets slower (the 2026-11-18 polluted run: a 35 s spec took 8 minutes). Call once per file, at the top. */
export function contextsClosedAfterEach(test: typeof playwrightTest): (browser: Browser, options?: BrowserContextOptions) => Promise<BrowserContext> {
  const opened: BrowserContext[] = [];
  test.afterEach(async () => { await Promise.all(opened.splice(0).map((context) => context.close().catch(() => {}))); });
  return async (browser, options) => {
    const context = await browser.newContext(options);
    opened.push(context);
    return context;
  };
}

/** `ready` that also waits for the page's live stream (`GET /api/events/stream`) to be open. A change another client makes before that is
 *  only found by the slow fallback poll, so a spec that waits for a live update must not make the change earlier (the 2026-11-18
 *  polluted run: a reparent made right after the page loaded was not on screen 15 s later, three times out of three alone, once in a row). */
export async function readyLive(page: Page, url: string): Promise<void> {
  const open = page.waitForResponse((r) => r.url().endsWith("/api/events/stream"));
  await ready(page, url);
  await open;
}
