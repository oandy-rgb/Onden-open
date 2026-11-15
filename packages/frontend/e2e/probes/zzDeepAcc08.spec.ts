// Feature-audit deepening (2026-10-09, tick 37): ACC-08 — bootstrap edge cases.
// A. Fully offline cold start: load online (cache filled), go offline, reload.
//    Does the shell load (service worker?), what does LoginGate show, can a
//    cached note be opened, does the cached content survive going back online?
// B. A committed edit + a slow bootstrap on reload (8 s): the editor must end on
//    the committed text, not an older snapshot.
import { test, type Page } from "@playwright/test";
import { ready, H } from "../fullstack/helpers";


test("ACC-08: offline cold start and slow bootstrap after a committed edit", async ({ page, context }) => {
  test.setTimeout(300_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  const note = await (await req.post("/api/nodes", { ...H, data: { title: `Acc08 ${s}`, markdown: `cached body ${s}` } })).json();
  const settle = async (p: Page) => { await p.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await p.waitForTimeout(3000); };
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    // ── A ──
    await ready(page, `/?view=notes&node=${note.id}`); await settle(page);
    out.A_online = (await page.locator(".cm-content").innerText().catch(() => "")).includes(`cached body ${s}`);
    out.A_serviceWorker = await page.evaluate(async () => (navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).map((r) => r.active?.scriptURL ?? "pending") : "unsupported"));
    await context.setOffline(true);
    const nav = await page.reload({ timeout: 20_000 }).then(() => "loaded").catch((e) => `failed: ${String(e).slice(0, 80)}`);
    await page.waitForTimeout(6000);
    out.A_offlineReload = { nav, text: (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 220), editorHasBody: (await page.locator(".cm-content").innerText().catch(() => "")).includes(`cached body ${s}`), buttons: await page.locator("button").filter({ visible: true }).allInnerTexts().then((b) => b.slice(0, 6)).catch(() => []) };
    await page.screenshot({ path: test.info().outputPath("offline-cold.png") });
    await context.setOffline(false);
    const retry = page.getByRole("button", { name: /Try again|Retry|Check again/i }).first();
    if (await retry.isVisible().catch(() => false)) await retry.click();
    else await page.reload().catch(() => {});
    await settle(page);
    out.A_backOnline = (await page.locator(".cm-content").innerText().catch(() => "")).includes(`cached body ${s}`);

    // ── B ──
    await page.locator(".cm-content").click({ force: true }); await page.keyboard.press("Control+End"); await page.keyboard.type(` committed-${s}`);
    for (let i = 0; i < 30; i++) { const md = (await (await req.get(`/api/nodes/${note.id}`)).json()).markdown as string; if (md.includes(`committed-${s}`)) break; await page.waitForTimeout(500); }
    out.B_serverHasEdit = ((await (await req.get(`/api/nodes/${note.id}`)).json()).markdown as string).includes(`committed-${s}`);
    await page.route("**/api/bootstrap*", async (r) => { await new Promise((x) => setTimeout(x, 8000)); await r.continue(); });
    await page.reload();
    await page.waitForTimeout(2000);
    out.B_duringSlow = { editorHasEdit: (await page.locator(".cm-content").innerText().catch(() => "")).includes(`committed-${s}`), text: (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 120) };
    await page.waitForTimeout(12_000);
    out.B_afterSlow = { editorHasEdit: (await page.locator(".cm-content").innerText().catch(() => "")).includes(`committed-${s}`), serverStill: ((await (await req.get(`/api/nodes/${note.id}`)).json()).markdown as string).includes(`committed-${s}`) };
    await page.unroute("**/api/bootstrap*");
  } finally {
    await context.setOffline(false);
    await req.delete(`/api/nodes/${note.id}`, H).catch(() => {});
    console.log("ACC08 " + JSON.stringify(out, null, 2));
  }
});
