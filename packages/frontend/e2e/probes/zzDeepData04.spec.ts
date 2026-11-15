// Feature-audit deepening (2026-10-09, tick 45): DATA-04 — local SQLite backup.
// A. Offline round trip: offline edit v2 (queued) → download backup → offline
//    edit v3 → restore the backup (confirm says it replaces queued changes) →
//    reconnect: which version reaches the server, and is v3 dropped knowingly?
// B. Empty profile: a fresh browser profile of the same account restores the
//    backup → app loads; does the backup's already-sent queue replay twice?
import { test, type Page, type BrowserContext } from "@playwright/test";
import { ready, showAdvancedSettings, BASE, H, pendingCount } from "../fullstack/helpers";

async function off(c: BrowserContext, p: Page, v: boolean) { await c.setOffline(v); await p.evaluate((x) => window.dispatchEvent(new Event(x ? "offline" : "online")), v); }
async function append(p: Page, text: string) { await p.locator(".cm-content").first().click({ force: true }); await p.keyboard.press("Control+End"); await p.keyboard.type(text); }
async function openBackup(p: Page) {
  await p.locator("button[title*=Settings i], button[aria-label*=Settings i]").filter({ visible: true }).first().click();
  await p.waitForTimeout(600);
  await p.getByRole("button", { name: /^Your Data$/ }).or(p.getByRole("tab", { name: /^Your Data$/ })).first().click();
  await p.waitForTimeout(600);
  await showAdvancedSettings(p);
}
const pending = (p: Page) => pendingCount(p).then(String);

test("DATA-04: offline backup round trip and empty profile restore", async ({ page, context, browser }) => {
  test.setTimeout(400_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  const note = await (await req.post("/api/nodes", { ...H, data: { title: `D04 ${s}`, markdown: `v1-${s}` } })).json();
  const md = async () => (await (await req.get(`/api/nodes/${note.id}`)).json()).markdown as string;
  const patches: string[] = []; page.on("request", (r) => { if (r.method() === "PATCH" && r.url().includes(note.id)) patches.push((r.postData() ?? "").slice(0, 80)); });
  const backupPath = test.info().outputPath("backup.sqlite3");
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await ready(page, `/?view=notes&node=${note.id}`);
    await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(3000);
    // Load the Settings chunk while online (GAP-263: opening it first offline crashes the app).
    await openBackup(page);
    await page.getByRole("group", { name: "Download this device's copy" }).getByRole("button").waitFor({ timeout: 10_000 }).catch(() => {});
    await page.locator(".settings-overlay").click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press("Escape"); await page.waitForTimeout(800);
    if (await page.locator(".settings-overlay").isVisible().catch(() => false)) await page.locator(".settings-overlay button").filter({ has: page.locator("svg") }).first().click().catch(() => {});
    await page.waitForTimeout(500);
    // A.
    await off(context, page, true);
    await append(page, ` v2-${s}`); await page.waitForTimeout(3000);
    out.pendingV2 = await pending(page);
    await openBackup(page);
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 20_000 }).catch(() => null), page.getByRole("group", { name: "Download this device's copy" }).getByRole("button").click()]);
    if (dl) await dl.saveAs(backupPath);
    out.backupDownloaded = !!dl;
    await page.locator(".settings-overlay").click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(500);
    await append(page, ` v3-${s}`); await page.waitForTimeout(3000);
    out.pendingV3 = await pending(page);
    await openBackup(page);
    page.once("dialog", (d) => void d.accept());
    await page.locator("input[accept='.sqlite3,.sqlite,.db']").setInputFiles(backupPath).catch((e) => { out.restoreErr = String(e).slice(0, 80); });
    await page.waitForTimeout(1000);
    out.confirmText = (await page.locator("[role=dialog], [role=alertdialog]").filter({ hasText: /Replace this device/ }).first().innerText().catch(() => null))?.replace(/\s+/g, " ").slice(0, 200);
    const navs: string[] = []; page.on("framenavigated", (f) => { if (f === page.mainFrame()) navs.push(f.url().slice(-40)); });
    const cons: string[] = []; page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") cons.push(m.text().slice(0, 160)); });
    await page.getByRole("button", { name: /Overwrite & import/ }).click().catch((e) => { out.overwriteClickErr = String(e).slice(0, 80); });
    await page.waitForTimeout(1500);
    out.restoreFeedback = { settingsError: await page.locator(".settings-storage-error").innerText().catch(() => null), toasts: await page.locator(".toast-message").allInnerTexts(), navigations: [...navs], console: cons.slice(0, 5) };
    await page.waitForTimeout(4500);
    out.afterRestoreOffline = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 120);
    await off(context, page, false).catch(() => {});
    await page.getByRole("button", { name: /Retry connection/i }).click().catch(() => {});
    await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(8000);
    await page.getByRole("button", { name: /Sync now/i }).filter({ visible: true }).first().click().catch(() => {});
    await page.waitForTimeout(6000);
    const m = await md();
    out.A_server = { v2: m.includes(`v2-${s}`), v3: m.includes(`v3-${s}`), pending: await pending(page), patches: patches.length, editor: (await page.locator(".cm-content").first().innerText().catch(() => "")).slice(-60) };

    // B. Empty profile, same account.
    const ctx2 = await browser.newContext({ baseURL: BASE, storageState: test.info().project.use.storageState as string, viewport: { width: 1280, height: 800 } });
    const p2 = await ctx2.newPage();
    const p2patches: string[] = []; p2.on("request", (r) => { if (r.method() === "PATCH" && r.url().includes(note.id)) p2patches.push((r.postData() ?? "").slice(0, 80)); });
    await p2.goto(`${BASE}/?view=notes&node=${note.id}`);
    await p2.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await p2.waitForTimeout(4000);
    await openBackup(p2);
    await p2.locator("input[accept='.sqlite3,.sqlite,.db']").setInputFiles(backupPath).catch(() => {});
    await p2.waitForTimeout(800);
    await p2.getByRole("button", { name: /Overwrite & import/ }).click().catch(() => {});
    await p2.waitForTimeout(3000);
    await p2.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await p2.waitForTimeout(8000);
    out.B = { patchesFromRestoredQueue: p2patches.length, pending: await pending(p2), serverOccurrencesV2: (await md()).split(`v2-${s}`).length - 1, error: await p2.locator(".settings-storage-error").innerText().catch(() => null), editor: (await p2.locator(".cm-content").first().innerText().catch(() => "")).slice(-60) };
    await ctx2.close();
  } finally {
    await off(context, page, false).catch(() => {});
    await req.delete(`/api/nodes/${note.id}`, H).catch(() => {});
    console.log("DATA04 " + JSON.stringify(out, null, 2));
  }
});
