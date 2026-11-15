// Playwright helpers for persona agents. ESM; import from scripts/persona/.
//   import { chromium } from "playwright";
//   import { newOwner, newMember, importAllModules, phone, BASE } from "./pw.mjs";
export const BASE = process.env.ONDEN_BASE || "http://localhost:5099";
const AUTH_HEADERS = { origin: BASE, "content-type": "application/json" };

// UI language follows the browser locale; zh-TW gives the Chinese UI (button 新筆記). ONDEN_LOCALE=en-US for English.
export const LOCALE = process.env.ONDEN_LOCALE || "zh-TW";
export const MODULES = ["review", "rss", "website", "daily"];

/** Context presets. phone(browser) => new context 390x844, isMobile, hasTouch. */
export function phoneOptions() {
  return { baseURL: BASE, locale: LOCALE, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
}
export async function phone(browser, extra = {}) {
  return browser.newContext({ ...phoneOptions(), ...extra });
}
export function desktopOptions() {
  return { baseURL: BASE, locale: LOCALE, viewport: { width: 1280, height: 800 } };
}

async function signUp(context, { email, password, name }) {
  const res = await context.request.post("/api/auth/sign-up/email", {
    data: { email, password, name: name || email.split("@")[0] },
    headers: AUTH_HEADERS,
  });
  if (!res.ok()) {
    // Already exists (re-run without reset) -> sign in instead.
    const si = await context.request.post("/api/auth/sign-in/email", { data: { email, password }, headers: AUTH_HEADERS });
    if (!si.ok()) throw new Error(`signup ${res.status()} ${await res.text()} / signin ${si.status()}`);
  }
}

async function openApp(context, page, { isPhone }) {
  await page.goto("/?view=notes", { waitUntil: "load" }); // NEVER networkidle: SSE keeps it busy
  const shell = isPhone
    ? page.locator(".mobile-bottom-nav").first()
    : page.locator(".app-topbar nav").first();
  const opfs = page.getByText("Use browser storage", { exact: false }).first();
  await shell.or(opfs).waitFor({ timeout: 30_000 });
  if (await opfs.isVisible().catch(() => false)) await opfs.click();
  await shell.waitFor({ state: "visible", timeout: 20_000 });
  await page.evaluate(() => localStorage.setItem("onden.welcomeDismissed", "1"));
}

/**
 * Sign up (FIRST user on a fresh DB becomes owner) and land in the app.
 * opts: {email,password,name, phone:true|false, contextOptions}. Returns {context,page}.
 */
export async function newOwner(browser, opts) {
  const isPhone = !!opts.phone;
  const context = await browser.newContext({ ...(isPhone ? phoneOptions() : desktopOptions()), ...(opts.contextOptions || {}) });
  await signUp(context, opts);
  const page = await context.newPage();
  await openApp(context, page, { isPhone });
  return { context, page };
}
/** Same flow for a later user (role = editor). */
export const newMember = newOwner;

/** Owner-only: import every shipped module into the workspace. */
export async function importAllModules(context) {
  for (const module of MODULES) {
    const res = await context.request.patch("/api/workspace/modules", { data: { module, imported: true }, headers: AUTH_HEADERS });
    if (!res.ok()) throw new Error(`import module ${module}: ${res.status()} ${await res.text()}`);
  }
}
