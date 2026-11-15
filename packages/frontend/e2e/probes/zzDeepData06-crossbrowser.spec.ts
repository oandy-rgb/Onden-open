// Feature-audit deepening (2026-10-09, tick 43): DATA-06 — local database
// lifecycle on Chromium, Firefox and WebKit (file name matches CROSS_ENGINE).
// 1. load + edit + reload; 2. IndexedDB wiped while the app is open, then
// edit + reload; 3. wiped while an offline edit is pending; 4. first load
// interrupted (page closed 1 s in) then reopened.
import { test, type Page, type BrowserContext } from "@playwright/test";
import { ready, BASE, H, pendingCount } from "../fullstack/helpers";

const settle = async (p: Page) => { await p.locator(".membership-gate").waitFor({ state: "hidden", timeout: 120_000 }).catch(() => {}); await p.waitForTimeout(4000); };
const wipeIdb = (p: Page) => p.evaluate(async () => { const dbs = (indexedDB as unknown as { databases?: () => Promise<Array<{ name?: string }>> }).databases ? await (indexedDB as unknown as { databases: () => Promise<Array<{ name?: string }>> }).databases() : []; const names = dbs.map((d) => d.name).filter(Boolean) as string[]; await Promise.all(names.map((n) => new Promise((r) => { const q = indexedDB.deleteDatabase(n); q.onsuccess = q.onerror = q.onblocked = () => r(null); }))); return names; });
async function type(p: Page, text: string) { await p.locator(".cm-content").click({ force: true }); await p.keyboard.press("Control+End"); await p.keyboard.type(text); }
async function off(c: BrowserContext, p: Page, v: boolean) { await c.setOffline(v); await p.evaluate((x) => window.dispatchEvent(new Event(x ? "offline" : "online")), v); }

test("DATA-06: local DB lifecycle", async ({ page, context, browserName }) => {
  test.setTimeout(500_000);
  const out: Record<string, unknown> = { browser: browserName }; const s = Date.now(); const req = page.request;
  const note = await (await req.post("/api/nodes", { ...H, data: { title: `D06 ${browserName} ${s}`, markdown: "start" } })).json();
  const server = async (m: string) => ((await (await req.get(`/api/nodes/${note.id}`)).json()).markdown as string).includes(m);
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(String(e).slice(0, 120)));
  try {
    // 1.
    await ready(page, `/?view=notes&node=${note.id}`); await settle(page);
    await type(page, ` one-${s}`); await page.waitForTimeout(3500);
    await page.reload(); await settle(page);
    out.basic = { server: await server(`one-${s}`), editor: (await page.locator(".cm-content").innerText().catch(() => "")).includes(`one-${s}`) };
    // 2.
    out.wiped = await wipeIdb(page);
    await type(page, ` two-${s}`); await page.waitForTimeout(3500);
    out.afterWipeEdit = { server: await server(`two-${s}`), toasts: await page.locator(".toast-message").allInnerTexts() };
    await page.reload(); await settle(page);
    out.afterWipeReload = { editor: (await page.locator(".cm-content").innerText().catch(() => "")).includes(`two-${s}`), title: await page.locator(".obsidian-title-input").inputValue().catch(() => null) };
    // 3.
    await off(context, page, true);
    await type(page, ` three-${s}`); await page.waitForTimeout(2500);
    out.pendingBeforeWipe = String(await pendingCount(page));
    out.wiped2 = await wipeIdb(page);
    await off(context, page, false);
    await page.waitForTimeout(6000);
    out.afterWipeOnline = { server: await server(`three-${s}`), pending: String(await pendingCount(page)) };
    await page.reload(); await settle(page);
    out.afterWipeOnlineReload = { server: await server(`three-${s}`), editor: (await page.locator(".cm-content").innerText().catch(() => "")).includes(`three-${s}`), recovery: (await page.locator(".failed-write-recovery").filter({ visible: true }).allInnerTexts().catch(() => [])).length };
    // 4.
    const p2 = await context.newPage();
    await p2.goto(`${BASE}/?view=notes&node=${note.id}`).catch(() => {});
    await p2.waitForTimeout(1000); await p2.close();
    const p3 = await context.newPage();
    await p3.goto(`${BASE}/?view=notes&node=${note.id}`); await settle(p3);
    out.afterInterrupted = { title: await p3.locator(".obsidian-title-input").inputValue().catch(() => null), editor: (await p3.locator(".cm-content").innerText().catch(() => "")).includes(`two-${s}`) };
    await p3.close();
    out.pageErrors = [...new Set(errors)].slice(0, 5);
  } finally {
    await off(context, page, false).catch(() => {});
    await req.delete(`/api/nodes/${note.id}`, H).catch(() => {});
    console.log("DATA06 " + JSON.stringify(out));
  }
});
