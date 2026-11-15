// Feature-audit deepening (2026-10-08): RSS-03 follow-up — confirm the slow
// full-text request really fired and completed while another article was open.
import { test } from "@playwright/test";
import { ready, H } from "../fullstack/helpers";

const FX = "http://backend:8080";

test("RSS-03b: late full-text response", async ({ page }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const log: string[] = [];
  const t0 = Date.now();
  const src = await (await page.request.post("/api/rss/subscribe", { ...H, data: { url: `${FX}/good.xml?run=${stamp}&n=4` } })).json();
  await page.waitForTimeout(4000);
  const items = ((await (await page.request.get(`/api/rss/items?source=${src.id}&limit=50`)).json()).items ?? []) as Array<{ id: string; title: string }>;
  const one = items.find((x) => x.title.startsWith("FX item 1 "))!;
  page.on("request", (r) => { if (r.url().includes("/fulltext")) log.push(`${Date.now() - t0}ms req ${r.url().slice(-50)}`); });
  page.on("response", (r) => { if (r.url().includes("/fulltext")) log.push(`${Date.now() - t0}ms res ${r.status()}`); });
  await page.route(`**/api/rss/items/${one.id}/fulltext`, async (r) => { await new Promise((x) => setTimeout(x, 5000)); await r.continue(); });
  await ready(page, `/?view=rss`);
  await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  await page.locator(".ui-filter-chip", { hasText: `FX Good ${stamp}` }).first().click();
  await page.waitForTimeout(1500);
  await page.locator(".rss-item-title", { hasText: `FX item 1 (${stamp})` }).first().click();
  await page.waitForTimeout(1200);
  out.opened = await page.locator(".rss-article-title").innerText();
  out.backVisible = await page.locator(".rss-article-back").isVisible();
  await page.locator(".rss-act-fulltext").click();
  log.push(`${Date.now() - t0}ms clicked fulltext`);
  await page.waitForTimeout(400);
  out.listClickable = await page.locator(".rss-item-title", { hasText: `FX item 3 (${stamp})` }).first().isVisible();
  await page.locator(".rss-item-title", { hasText: `FX item 3 (${stamp})` }).first().click();
  log.push(`${Date.now() - t0}ms opened item 3`);
  await page.waitForTimeout(1000);
  out.before = `${await page.locator(".rss-article-title").innerText()} :: ${(await page.locator(".rss-article-body").innerText()).slice(0, 60)}`;
  await page.waitForTimeout(7000);
  out.after = `${await page.locator(".rss-article-title").innerText()} :: ${(await page.locator(".rss-article-body").innerText()).slice(0, 60)}`;
  out.log = log;
  console.log("RSS03B " + JSON.stringify(out, null, 2));
});
