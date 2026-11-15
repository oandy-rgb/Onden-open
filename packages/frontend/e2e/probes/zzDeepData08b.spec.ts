// Feature-audit deepening (2026-10-09, tick 42): DATA-08 — recovery list.
// Make an "unconfirmed" card (save in flight, page reloaded), then press
// "Try again" while the server answers 401 (session expired); then restore and
// sync. Also re-checks GAP-195 (duplicate cards; Try again not sending).
import { test, type Page } from "@playwright/test";
import { ready, H, pendingCount } from "../fullstack/helpers";

const cards = async (p: Page) => (await p.locator(".failed-write-recovery").filter({ visible: true }).allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, " ").slice(0, 220));

test("DATA-08: recovery card retry under 401", async ({ page }) => {
  test.setTimeout(300_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const req = page.request;
  const note = await (await req.post("/api/nodes", { ...H, data: { title: `D08 ${s}`, markdown: "start" } })).json();
  const server = async () => ((await (await req.get(`/api/nodes/${note.id}`)).json()).markdown as string).includes(`unsure-${s}`);
  const patches: string[] = [];
  page.on("request", (r) => { if (r.url().includes(`/api/nodes/${note.id}`) && r.method() === "PATCH") patches.push(`${Date.now() - s}`); });
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await ready(page, `/?view=notes&node=${note.id}`);
    await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(2500);
    // Save hangs → reload while it is in flight.
    await page.route(`**/api/nodes/${note.id}`, (r) => { if (r.request().method() === "PATCH") return new Promise(() => { /* never answer */ }); return r.continue(); });
    await page.locator(".cm-content").click({ force: true }); await page.keyboard.press("Control+End"); await page.keyboard.type(` unsure-${s}`);
    for (let i = 0; i < 30 && patches.length === 0; i++) await page.waitForTimeout(250);
    out.patchStarted = patches.length;
    await page.unroute(`**/api/nodes/${note.id}`);
    await page.reload(); await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(4000);
    out.cardsAfterReload = await cards(page);
    out.serverAfterReload = await server();
    // Try again while every PATCH gets 401.
    await page.route(`**/api/nodes/${note.id}`, (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 401, contentType: "application/json", body: "{\"error\":\"unauthorized\"}" }) : r.continue());
    const before = patches.length;
    await page.getByRole("button", { name: /Try again/i }).filter({ visible: true }).first().click().catch(() => {});
    await page.waitForTimeout(5000);
    out.afterTryAgain401 = { patchesSent: patches.length - before, cards: await cards(page), toasts: await page.locator(".toast-message").allInnerTexts(), pending: String(await pendingCount(page)), server: await server() };
    // Session back: sync.
    await page.unroute(`**/api/nodes/${note.id}`);
    const b2 = patches.length;
    await page.getByRole("button", { name: /Sync now/i }).filter({ visible: true }).first().click().catch(() => {});
    await page.waitForTimeout(8000);
    out.afterSync = { patchesSent: patches.length - b2, cards: await cards(page), pending: String(await pendingCount(page)), server: await server() };
    await page.reload(); await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(6000);
    out.afterReload2 = { cards: await cards(page), pending: String(await pendingCount(page)), server: await server() };
  } finally {
    await req.delete(`/api/nodes/${note.id}`, H).catch(() => {});
    console.log("DATA08 " + JSON.stringify(out, null, 2));
  }
});
