// Feature-audit deepening (2026-10-09, tick 38): ACC-04 — server URL in the web
// build (Settings → Server → Backend URL). Saving an unreachable URL (is it
// checked first?), what the user then sees and whether they can get back
// through the UI (empty + Save, which the hint suggests), a pending offline
// edit across the switch, and data isolation when pointing back.
import { test, type Page } from "@playwright/test";
import { ready, showAdvancedSettings, H, pendingCount } from "../fullstack/helpers";


async function openServerSettings(p: Page) {
  await p.locator("button[title*=Settings i], button[aria-label*=Settings i]").filter({ visible: true }).first().click();
  await p.waitForTimeout(800);
  await p.getByRole("button", { name: /^Server$/ }).or(p.getByRole("tab", { name: /^Server$/ })).first().click().catch(() => {});
  await p.waitForTimeout(600);
  await showAdvancedSettings(p);
}
const urlField = (p: Page) => p.locator("input[placeholder='http://localhost:8787']").filter({ visible: true }).first();
const urlSave = (p: Page) => urlField(p).locator("xpath=following::button[normalize-space()='Save'][1]");

test("ACC-04: Backend URL setting", async ({ page, context }) => {
  test.setTimeout(300_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  const note = await (await req.post("/api/nodes", { ...H, data: { title: `Acc04 ${s}`, markdown: "start" } })).json();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await ready(page, `/?view=notes&node=${note.id}`);
    await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(2500);
    // Pending offline edit before switching.
    await context.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await page.locator(".cm-content").click({ force: true }); await page.keyboard.press("Control+End"); await page.keyboard.type(` pending-${s}`);
    await page.waitForTimeout(2500);
    out.pendingBefore = String(await pendingCount(page));
    await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event("online")));
    // Block the drain so the edit is still pending when the server changes.
    await page.route(`**/api/nodes/${note.id}`, (r) => r.request().method() === "PATCH" ? r.abort("failed") : r.continue());
    await openServerSettings(page);
    out.fieldVisible = await urlField(page).isVisible().catch(() => false);
    out.fieldValueBefore = await urlField(page).inputValue().catch(() => null);
    const reqsToBad: string[] = []; page.on("request", (r) => { if (r.url().startsWith("http://127.0.0.1:9")) reqsToBad.push(r.url().slice(0, 60)); });
    await urlField(page).fill("http://127.0.0.1:9");
    await urlSave(page).click();
    await page.waitForTimeout(8000);
    out.afterBadSave = { localStorage: await page.evaluate(() => localStorage.getItem("onden_api_base")), text: (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 200), requestsToBad: reqsToBad.length };
    await page.reload(); await page.waitForTimeout(8000);
    out.afterReload = { text: (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 200), buttons: await page.locator("button").filter({ visible: true }).allInnerTexts().then((b) => b.slice(0, 8)) };
    await page.screenshot({ path: test.info().outputPath("bad-server.png") });
    // Can the user get back through the UI? Try Settings if reachable; else note.
    const settingsReachable = await page.locator("button[title*=Settings i], button[aria-label*=Settings i]").filter({ visible: true }).count();
    out.settingsReachable = settingsReachable;
    if (settingsReachable) {
      await openServerSettings(page);
      await urlField(page).fill("");
      await urlSave(page).click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(2000);
      out.emptySave = await page.evaluate(() => localStorage.getItem("onden_api_base"));
    }
    // Recover manually (what a user cannot do without devtools), check the pending edit.
    await page.evaluate(() => localStorage.removeItem("onden_api_base"));
    await page.unroute(`**/api/nodes/${note.id}`);
    await page.reload(); await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(6000);
    await page.getByRole("button", { name: /Sync now/i }).filter({ visible: true }).first().click().catch(() => {});
    await page.waitForTimeout(6000);
    out.afterRecovery = { pending: String(await pendingCount(page)), serverHasPendingEdit: ((await (await req.get(`/api/nodes/${note.id}`)).json()).markdown as string).includes(`pending-${s}`), recovery: (await page.locator(".failed-write-recovery").filter({ visible: true }).allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, " ").slice(0, 160)) };
  } finally {
    await page.evaluate(() => localStorage.removeItem("onden_api_base")).catch(() => {});
    await req.delete(`/api/nodes/${note.id}`, H).catch(() => {});
    console.log("ACC04 " + JSON.stringify(out, null, 2));
  }
});
