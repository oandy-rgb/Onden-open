// Playwright loader, the viewports, and "open the browser app with fixed data" — shared by run.mjs and selftest.mjs.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "../browser-app/serve.mjs";
import { seedFixedData } from "./seed.mjs";
import { INPAGE_SOURCE } from "./inpage.mjs";

export const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
export const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();

/** The widths of the audit. `mobile` uses Playwright's Pixel 5 (touch, device pixel ratio, mobile viewport). */
export const VIEWPORTS = [
  { id: "1280", label: "桌面 1280×800", width: 1280, height: 800 },
  { id: "1440", label: "桌面 1440×900", width: 1440, height: 900 },
  { id: "1920", label: "桌面 1920×1080", width: 1920, height: 1080 },
  { id: "1100", label: "窄桌面 1100×800", width: 1100, height: 800 },
  { id: "900", label: "平板 900×1200", width: 900, height: 1200 },
  { id: "pixel5", label: "手機 Pixel 5", device: "Pixel 5", mobile: true },
  { id: "1440-dark", label: "桌面 1440×900 深色", width: 1440, height: 900, dark: true },
];

export const READY_TEXT = "歡迎來到 Onden 試用版";

export async function launch() {
  return playwright.chromium.launch();
}

export function contextOptions(vp) {
  const base = { locale: "zh-TW", timezoneId: "UTC", colorScheme: vp.dark ? "dark" : "light", reducedMotion: vp.motion ?? "reduce" };
  if (vp.mobile) return { ...playwright.devices[vp.device], ...base };
  // `touch`: a touch screen of any width (a tablet): the page sees (pointer: coarse), as on the real device.
  return { ...base, viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1, ...(vp.touch ? { isMobile: true, hasTouch: true } : {}) };
}

export function startSite(dir = "dist-browser") {
  return serve(resolve(here, "../..", dir));
}

/** Open the app in a fresh browser context (its own empty database), put the fixed data in, reload so the app shows it. */
export async function openApp(browser, site, vp, { seed = true, extraSeed = null, beforeLoad = null } = {}) {
  const context = await browser.newContext(contextOptions(vp));
  if (beforeLoad) await beforeLoad(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await page.goto(site.base);
  await page.getByText(READY_TEXT).first().waitFor({ state: "attached", timeout: 120_000 });
  if (seed) {
    await seedFixedData(page);
    if (extraSeed) await extraSeed(page); // data only the style census uses; the layout audit's own data stays as it was
    await waitSaved(page);
    await page.goto(site.base);
    await page.getByText(READY_TEXT).first().waitFor({ state: "attached", timeout: 120_000 });
  }
    await installHelpers(page);
  return { context, page, errors };
}

/** The in-page helpers survive client-side navigation but not a reload. */
export async function installHelpers(page) {
  await page.evaluate(INPAGE_SOURCE);
  // The browser app's own 「試用版」 pill floats over the corner of every screen; the real app has no such thing,
  // so it is taken out of the picture (it would "cover" whatever list sits under it). The same for the floating
  // 「這次更新」 card, which comes and goes on its own timing and would make the result depend on when it appeared.
  await page.addStyleTag({ content: ".trial-notice, .trial-notice-button, [class*='trial-notice'], .device-notices--whats-new { display: none !important; }" }).catch(() => {});
}

/** Wait until the worker says the browser's storage has the latest copy (a reload before that loses the last writes). */
export async function waitSaved(page, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await page.evaluate(async () => (await fetch("/api/browser-app/state")).json());
    if (!s.unsaved && s.lastSavedAt !== null) return;
    await page.waitForTimeout(300);
  }
  throw new Error("the browser app did not save in time");
}
