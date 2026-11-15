// Feature-audit deepening (2026-10-08): REV-06 follow-up — the review page
// showed "Loading…" 2–3 s after open on this workspace; measure how long the
// whole-workspace queue/stats take and whether the page ever leaves Loading.
import { test } from "@playwright/test";
import { ready } from "../fullstack/helpers";

test("REV-06b: review page load time", async ({ page }) => {
  test.setTimeout(180_000);
  const out: Record<string, unknown> = {};
  const net: string[] = [];
  const t0 = Date.now();
  page.on("response", (r) => { if (r.url().includes("/api/review/")) net.push(`${Date.now() - t0}ms ${r.status()} ${r.url().replace(/^.*\/api/, "/api").slice(0, 60)}`); });
  for (const w of [1280, 390]) {
    await page.setViewportSize({ width: w, height: 800 });
    const s = Date.now();
    await ready(page, `/?view=review`);
    let left = -1;
    for (let i = 0; i < 120; i++) {
      const txt = await page.locator(".review-panel").innerText().catch(() => "");
      if (txt && !/Loading…/.test(txt)) { left = Date.now() - s; break; }
      await page.waitForTimeout(250);
    }
    out[`w${w}`] = { leftLoadingMs: left, text: (await page.locator(".review-panel").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160) };
  }
  out.net = net.slice(0, 12);
  out.queueSize = ((await (await page.request.get("/api/review/queue")).json()) as { cards?: unknown[]; total?: number }).total;
  console.log("REV06B " + JSON.stringify(out, null, 2));
});
