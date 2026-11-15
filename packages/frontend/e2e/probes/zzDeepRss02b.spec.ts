// Feature-audit deepening (2026-10-08): RSS-02 follow-up — a source that was
// healthy starts failing (HTTP 500, then a 15 s response past the 10 s fetch
// timeout): does the source list show it, keep old items, and recover?
import { test } from "@playwright/test";
import { ready, H, psql as sql } from "../fullstack/helpers";


const FX = "http://backend:8080";

test("RSS-02b: failing source visibility and recovery", async ({ page }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const req = page.request;
  const src = await (await req.post("/api/rss/subscribe", { ...H, data: { url: `${FX}/good.xml?run=${stamp}` } })).json();
  await page.waitForTimeout(4000);
  const state = async () => {
    const j = await (await req.get("/api/rss/sources")).json();
    const s = ((j.sources ?? j) as Array<{ id: string; unseen: number; last_error: string | null }>).find((x) => x.id === src.id);
    return `unseen=${s?.unseen} last_error=${JSON.stringify(s?.last_error)}`;
  };
  out.healthy = await state();
  // Reserved attribute: the API refuses it (400), so move the feed in the isolated e2e DB.
  const setUrl = async (u: string) => sql(`update node_attributes set value='${u}' where node_id='${src.id}' and key='_rss_url' returning key`);
  const refresh = async (wait = 4000) => { const r = await req.post(`/api/rss/sources/${src.id}/refresh`, { ...H, data: {} }); await page.waitForTimeout(wait); return r.status(); };
  out.setUrl500 = await setUrl(`${FX}/500.xml?run=${stamp}`);
  out.refresh500 = await refresh();
  out.after500 = await state();
  await ready(page, "/?view=rss");
  await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  const row = page.locator(".ui-filter-chip", { hasText: `FX Good ${stamp}` }).last();
  out.uiRowText = (await row.innerText().catch(() => "(missing)")).replace(/\s+/g, " ");
  out.uiRowTitleAttr = await page.locator(`[title^="Last fetch failed"]`).first().getAttribute("title").catch(() => null);
  // Touch users: is the reason reachable without hover? Click the source.
  await row.click().catch(() => {});
  await page.waitForTimeout(1500);
  out.uiAfterClick = (await page.locator(".rss-notice, .rss-empty").allInnerTexts().catch(() => [])).join(" / ").slice(0, 160);
  out.oldItemsStill = (await (await req.get(`/api/rss/items?source=${src.id}&limit=50`)).json()).items?.length;
  out.setUrlSlow = await setUrl(`${FX}/slow.xml?run=${stamp}&ms=15000`);
  out.refreshSlow = await refresh(20_000);
  out.afterSlow = await state();
  out.setUrlBack = await setUrl(`${FX}/good.xml?run=${stamp}&n=5`);
  out.refreshBack = await refresh(5000);
  out.recovered = await state();
  console.log("RSS02B " + JSON.stringify(out, null, 2));
});
