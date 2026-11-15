// Feature-audit deepening (2026-10-08): RSS-01 + RSS-02 against a fixture feed
// server running inside the backend container (http://backend:8080, see
// .acceptance/feature-loop-2026-10-07/tick7/fixture/server.mjs).
// RSS-01: subscribe on a 390 px phone through the UI; malformed feed, HTML page,
// 500, auto-discovery page, duplicate URL, a viewer, offline subscribe → replay
// creates exactly one source. RSS-02: slow and failing refresh, duplicate items
// in a feed, unseen counts vs item list, and how a source is stopped.
import { test, expect, type Page } from "@playwright/test";
import { ready, BASE, H } from "../fullstack/helpers";

const FX = "http://backend:8080";
type Src = { id: string; url?: string; title: string; unseen: number; last_error?: string | null; [k: string]: unknown };

test("RSS-01/02: subscribe edge cases and source refresh", async ({ page, browser }) => {
  test.setTimeout(420_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const req = page.request;
  const sources = async (r = req): Promise<Src[]> => { const j = await (await r.get("/api/rss/sources")).json(); return (j.sources ?? j) as Src[]; };
  const mine = async (r = req) => (await sources(r)).filter((s) => JSON.stringify(s).includes(String(stamp)));
  const notice = async (p: Page) => (await p.locator(".rss-notice").allInnerTexts().catch(() => [])).join(" / ").replace(/\s+/g, " ").slice(0, 160);

  // ---- RSS-01 via UI on a phone ----
  await page.setViewportSize({ width: 390, height: 800 });
  const g0 = Date.now();
  await ready(page, "/?view=rss");
  await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  out.gateMs = Date.now() - g0;
  await page.locator(".rss-sources-open").click();
  const sub = async (url: string) => {
    const t0 = Date.now();
    await page.locator(".rss-subscribe-input").fill(url);
    await page.waitForTimeout(300);
    const valBefore = await page.locator(".rss-subscribe-input").inputValue();
    const clicked = await page.locator(".rss-subscribe-btn").click({ timeout: 5000 }).then(() => "ok").catch(() => "DISABLED");
    console.log(`SUB ${url.slice(22, 60)} valAfterFill=${valBefore === url} click=${clicked} t=${Date.now() - t0}`);
    await page.waitForTimeout(2500);
    const n = await notice(page);
    const panels = (await page.locator(".fwr-card").allInnerTexts().catch(() => [])).map((x) => x.replace(/\s+/g, " ").slice(0, 120));
    // Record the recovery panel, then remove the copies so the next case can run.
    for (let i = 0; i < 5 && (await page.locator(".fwr-dismiss").count()); i++) await page.locator(".fwr-dismiss").first().click().catch(() => {});
    const r = panels.length ? `${n} || PANEL: ${panels.join(" | ")}` : n;
    console.log(`  -> ${r}`);
    return r;
  };
  out.phoneAddFeedVisible = await page.locator(".rss-subscribe-input").isVisible();
  out.ui_good = await sub(`${FX}/good.xml?run=${stamp}`);
  out.ui_dup = await sub(`${FX}/good.xml?run=${stamp}`);
  out.ui_bad = await sub(`${FX}/bad.xml?run=${stamp}`);
  out.ui_html = await sub(`${FX}/page.html?run=${stamp}`);
  out.ui_500 = await sub(`${FX}/500.xml?run=${stamp}`);
  out.ui_autodiscover = await sub(`${FX}/autodiscover.html?run=${stamp}`);
  out.ui_notUrl = await sub(`not a url ${stamp}`);
  out.phoneOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2);
  out.sourcesAfterUi = (await mine()).map((s) => `${s.title} unseen=${s.unseen}`);
  await page.screenshot({ path: `${process.env.SHOT_DIR ?? "/tmp"}/rss01-phone.png` }).catch(() => {});

  // Viewer cannot subscribe.
  const ctx = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const su = await (await ctx.request.post("/api/auth/sign-up/email", { ...H, data: { name: `RS ${stamp}`, email: `rs-${stamp}@example.com`, password: `pw-${stamp}-x` } })).json();
  await req.post("/api/actors", { ...H, data: { name: `RS ${stamp}`, type: "human", external_id: su.user.id } });
  const v = await ctx.request.post("/api/rss/subscribe", { ...H, data: { url: `${FX}/good.xml?run=${stamp}v` } });
  out.viewerSubscribe = `${v.status()} ${(await v.text()).slice(0, 100)}`;
  await ctx.close();

  // Offline subscribe → reconnect → exactly one source; reload doesn't replay again.
  await page.setViewportSize({ width: 1280, height: 800 });
  await ready(page, "/?view=rss");
  await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  await page.locator(".rss-sources-open").click();
  await page.context().setOffline(true);
  out.offline_notice = await sub(`${FX}/good.xml?run=${stamp}off&n=2`);
  await page.context().setOffline(false);
  await page.waitForTimeout(8000);
  out.offline_sourcesAfterReconnect = (await mine()).filter((s) => JSON.stringify(s).includes(`${stamp}off`)).length;
  await page.reload();
  await page.waitForTimeout(5000);
  out.offline_sourcesAfterReload = (await mine()).filter((s) => JSON.stringify(s).includes(`${stamp}off`)).length;

  // ---- RSS-02 ----
  // Duplicate items in a feed (guid repeated).
  const dup = await (await req.post("/api/rss/subscribe", { ...H, data: { url: `${FX}/dup.xml?run=${stamp}` } })).json();
  await page.waitForTimeout(4000);
  const itemsFor = async (src: string) => ((await (await req.get(`/api/rss/items?source=${src}&limit=200`)).json()).items ?? []) as Array<{ title: string; seen: boolean }>;
  out.dupItems = (await itemsFor(dup.id)).map((i) => i.title);
  // Refresh twice → still no duplicates.
  await req.post(`/api/rss/sources/${dup.id}/refresh`, { ...H, data: {} });
  await req.post(`/api/rss/sources/${dup.id}/refresh`, { ...H, data: {} });
  await page.waitForTimeout(4000);
  out.dupItemsAfter2Refresh = (await itemsFor(dup.id)).length;
  out.dupUnseen = (await mine()).find((s) => s.id === dup.id)?.unseen;

  // Count consistency: sources.unseen vs items(unseen=1) for the good feed.
  const good = (await mine()).find((s) => JSON.stringify(s).includes(`good.xml?run=${stamp}`) && !JSON.stringify(s).includes("off"));
  if (good) {
    const unseenItems = ((await (await req.get(`/api/rss/items?source=${good.id}&limit=200`)).json()).items ?? []).filter((i: { seen: boolean }) => !i.seen).length;
    out.goodCounts = `sources.unseen=${good.unseen} items(unseen)=${unseenItems}`;
    // UI badge
    await ready(page, "/?view=rss");
    out.goodUiBadge = (await page.locator(".ui-filter-chip", { hasText: `FX Good ${stamp}` }).first().innerText().catch(() => "(not in list)")).replace(/\s+/g, " ");
  }

  // Slow feed (40 s, longer than the 10 s fetch timeout) and a feed that later fails.
  const slowT0 = Date.now();
  const slow = await req.post("/api/rss/subscribe", { ...H, data: { url: `${FX}/slow.xml?run=${stamp}&ms=15000` }, timeout: 60_000 });
  out.slowSubscribe = `${slow.status()} ${(await slow.text()).slice(0, 100)} after ${Date.now() - slowT0} ms`;
  // A feed subscribed while healthy, then the source starts failing: do we see it?
  const flaky = await (await req.post("/api/rss/subscribe", { ...H, data: { url: `${FX}/good.xml?run=${stamp}flaky` } })).json();
  await page.waitForTimeout(3000);
  // Point the source at a failing URL by editing its url attribute (sources are notes).
  const srcNode = await (await req.get(`/api/nodes/${flaky.id}`)).json();
  out.sourceNodeKeys = Object.keys(srcNode).slice(0, 20).join(",");
  const attrs = JSON.stringify(srcNode.attributes ?? srcNode.attrs ?? {}).slice(0, 300);
  out.sourceAttrs = attrs;

  // Stop a source: what entry exists? Delete the source note and refresh.
  const del = await req.delete(`/api/nodes/${flaky.id}`, H);
  out.deleteSource = del.status();
  const ref = await req.post(`/api/rss/sources/${flaky.id}/refresh`, { ...H, data: {} });
  out.refreshDeleted = `${ref.status()} ${(await ref.text()).slice(0, 80)}`;
  out.deletedStillListed = (await sources()).some((s) => s.id === flaky.id);
  out.deletedItemsVisible = (await (await req.get(`/api/rss/items?limit=200`)).json()).items?.filter((i: { title: string }) => i.title.includes(`${stamp}flaky`)).length;
  const fxHits = await (await req.get("/api/rss/sources")).ok(); void fxHits;
  console.log("RSS0102 " + JSON.stringify(out, null, 2));
});
