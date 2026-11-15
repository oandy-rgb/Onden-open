// Feature-audit deepening (2026-10-09, tick 44): DATA-07 — a full local disk.
// Chromium CDP Storage.overrideQuotaForOrigin shrinks the origin quota so the
// worker's IndexedDB snapshot write really fails (QuotaExceededError). Then:
// an offline edit (only the local queue can hold it — must NOT look saved),
// an online edit, desktop and 390 px; finally restore the quota and reconnect.
import { test, type Page, type BrowserContext } from "@playwright/test";
import { ready, BASE, H, pendingCount } from "../fullstack/helpers";

async function off(c: BrowserContext, p: Page, v: boolean) { await c.setOffline(v); await p.evaluate((x) => window.dispatchEvent(new Event(x ? "offline" : "online")), v); }
async function type(p: Page, text: string) { await p.locator(".cm-content").click({ force: true }); await p.keyboard.press("Control+End"); await p.keyboard.type(text); }
const status = async (p: Page) => ({
  pending: String(await pendingCount(p)),
  saveLabel: (await p.locator(".obsidian-save-button, [class*=save-status], [class*=saveState]").filter({ visible: true }).allInnerTexts().catch(() => [])).slice(0, 3),
  toasts: await p.locator(".toast-message").allInnerTexts(),
  recovery: (await p.locator(".failed-write-recovery").filter({ visible: true }).allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, " ").slice(0, 160)),
});

// Tick 44 follow-up: the dangerous case — full disk, offline edit, reload while
// still offline (the queue only lived in memory), then reconnect.
test("DATA-07: full disk + offline edit + offline reload", async ({ page, context }) => {
  test.setTimeout(300_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  const note = await (await req.post("/api/nodes", { ...H, data: { title: `D07r ${s}`, markdown: "start" } })).json();
  const server = async (m: string) => ((await (await req.get(`/api/nodes/${note.id}`)).json()).markdown as string).includes(m);
  const cdp = await context.newCDPSession(page);
  const consoleErr: string[] = []; page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") consoleErr.push(m.text().slice(0, 140)); });
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await ready(page, `/?view=notes&node=${note.id}`);
    await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(3000);
    await cdp.send("Storage.overrideQuotaForOrigin", { origin: BASE, quotaSize: 4096 });
    await off(context, page, true);
    await type(page, ` lost-${s}`); await page.waitForTimeout(5000);
    out.beforeReload = await status(page);
    out.consoleDuringFull = [...new Set(consoleErr)].slice(0, 5);
    await page.reload().catch(() => {}); await page.waitForTimeout(6000);
    out.offlineReload = { text: (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160), ...(await status(page)) };
    await cdp.send("Storage.overrideQuotaForOrigin", { origin: BASE });
    await off(context, page, false);
    await page.getByRole("button", { name: /Retry connection/i }).click().catch(() => {});
    await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(8000);
    out.afterReconnect = { ...(await status(page)), serverHasEdit: await server(`lost-${s}`), editorHasEdit: (await page.locator(".cm-content").first().innerText().catch(() => "")).includes(`lost-${s}`) };
  } finally {
    await cdp.send("Storage.overrideQuotaForOrigin", { origin: BASE }).catch(() => {});
    await req.delete(`/api/nodes/${note.id}`, H).catch(() => {});
    console.log("DATA07R " + JSON.stringify(out, null, 1));
  }
});

for (const vp of [{ name: "desktop", width: 1280, height: 800 }, { name: "phone", width: 390, height: 780 }]) {
  test.skip(`DATA-07: quota exceeded (${vp.name}) (tick 44 first run)`, async ({ page, context }) => {
    test.setTimeout(300_000);
    const out: Record<string, unknown> = { vp: vp.name }; const s = Date.now(); const req = page.request;
    const note = await (await req.post("/api/nodes", { ...H, data: { title: `D07 ${vp.name} ${s}`, markdown: "start" } })).json();
    const server = async (m: string) => ((await (await req.get(`/api/nodes/${note.id}`)).json()).markdown as string).includes(m);
    const cdp = await context.newCDPSession(page);
    try {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await ready(page, `/?view=notes&node=${note.id}`);
      await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(3000);
      if (vp.name === "phone") await page.locator(".cm-content").first().waitFor({ timeout: 20_000 }).catch(() => {});
      out.usageBefore = await page.evaluate(async () => { const e = await navigator.storage.estimate(); return { usage: e.usage, quota: e.quota }; });
      await cdp.send("Storage.overrideQuotaForOrigin", { origin: BASE, quotaSize: 4096 });
      out.quotaNow = await page.evaluate(async () => (await navigator.storage.estimate()).quota);
      // Offline edit: only the local queue can hold it.
      await off(context, page, true);
      await type(page, ` offline-${s}`); await page.waitForTimeout(4000);
      out.offlineEdit = await status(page);
      // Online edit while the disk is still "full".
      await off(context, page, false); await page.waitForTimeout(5000);
      out.afterReconnectFullDisk = { ...(await status(page)), serverHasOffline: await server(`offline-${s}`) };
      await type(page, ` online-${s}`); await page.waitForTimeout(4000);
      out.onlineEditFullDisk = { ...(await status(page)), serverHasOnline: await server(`online-${s}`) };
      await page.screenshot({ path: test.info().outputPath(`full-disk-${vp.name}.png`) });
      // Restore quota, reload: what survived?
      await cdp.send("Storage.overrideQuotaForOrigin", { origin: BASE });
      await page.reload(); await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(5000);
      out.afterRestore = { ...(await status(page)), serverHasOffline: await server(`offline-${s}`), serverHasOnline: await server(`online-${s}`), editor: (await page.locator(".cm-content").first().innerText().catch(() => "")).slice(-80) };
    } finally {
      await cdp.send("Storage.overrideQuotaForOrigin", { origin: BASE }).catch(() => {});
      await off(context, page, false).catch(() => {});
      await req.delete(`/api/nodes/${note.id}`, H).catch(() => {});
      console.log("DATA07 " + JSON.stringify(out, null, 1));
    }
  });
}
