// Feature-audit deepening (2026-10-08): NOTE-02 — saving at 390px (debounce,
// back to the list, page hidden), and the same triggers when the PATCH gets
// 503 (queued, lands later) or 403 (rejected: text kept, recovery shown).
import { test, type Page } from "@playwright/test";
import { ready, BASE, H, syncLabel } from "../fullstack/helpers";


test("NOTE-02: phone save triggers, 503 and 403 during save", async ({ browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const ctx = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const mk = async (t: string) => (await (await p.request.post("/api/nodes", { ...H, data: { title: t, markdown: `${t} start` } })).json()).id as string;
  const body = async (id: string) => (await (await p.request.get(`/api/nodes/${id}`)).json()).markdown as string;
  const typeIn = async (id: string, text: string) => {
    await ready(p, `/?view=notes&node=${id}&lens=editor`);
    const min = p.getByRole("button", { name: "Minimize recovery panel" });
    if (await min.isVisible().catch(() => false)) await min.click();
    await p.locator(".cm-content").first().click();
    await p.keyboard.press("Control+End");
    await p.keyboard.type(text);
  };
  const waitFor = async (id: string, needle: string, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await body(id)).includes(needle)) return Date.now() - t0; await p.waitForTimeout(200); } return -1; };
  try {
  const A = await mk(`P2A ${stamp}`), B = await mk(`P2B ${stamp}`), C = await mk(`P2C ${stamp}`);
  await typeIn(A, " debounce-typed");
  out.debounceMs = await waitFor(A, "debounce-typed");
  await typeIn(B, " back-typed");
  await p.getByRole("button", { name: "Back to notes list" }).click();
  out.backToListMs = await waitFor(B, "back-typed");
  await typeIn(C, " hidden-typed");
  await p.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  out.hiddenMs = await waitFor(C, "hidden-typed");

  // 503 on the save: queued, then lands.
  const D = await mk(`P2D ${stamp}`);
  await p.route(`**/api/nodes/${D}`, (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 503, body: "{}" }) : r.continue());
  await typeIn(D, " during-503");
  await p.waitForTimeout(3000);
  out.on503 = { server: (await body(D)).includes("during-503"), editor: (await p.locator(".cm-content").first().innerText()).includes("during-503"), sync: (await syncLabel(p)).replace(/\s+/g, " ").slice(0, 60), toast: (await p.locator(".toast").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").slice(-160) };
  await p.unroute(`**/api/nodes/${D}`);
  await ctx.setOffline(true); await p.waitForTimeout(800); await ctx.setOffline(false);
  out.after503Ms = await waitFor(D, "during-503", 20_000);

  // 403 on the save: rejected, text stays visible, recovery offered.
  const E = await mk(`P2E ${stamp}`);
  await p.route(`**/api/nodes/${E}`, (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden" }) }) : r.continue());
  await typeIn(E, " during-403");
  await p.waitForTimeout(3500);
  out.on403 = { server: (await body(E)).includes("during-403"), editor: (await p.locator(".cm-content").first().innerText()).includes("during-403"), recovery: (await p.locator(".failed-write-recovery").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 140), toast: (await p.locator(".toast").allInnerTexts().catch(() => [])).join(" | ").replace(/\s+/g, " ").slice(-140) };
  await p.unroute(`**/api/nodes/${E}`);
  await p.reload(); await p.waitForTimeout(3000);
  out.after403Reload = { server: (await body(E)).includes("during-403"), recoveryHasText: (await p.locator(".failed-write-recovery").innerText().catch(() => "")).includes("during-403") || (await p.locator(".failed-write-recovery textarea, .failed-write-recovery pre").allInnerTexts().catch(() => [])).join("").includes("during-403") };
  } finally {
    await ctx.setOffline(false).catch(() => {});
    console.log("NOTE02 " + JSON.stringify(out, null, 2));
    await ctx.close();
  }
});
