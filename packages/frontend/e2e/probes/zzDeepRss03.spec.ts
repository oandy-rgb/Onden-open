// Feature-audit deepening (2026-10-08): RSS-03 — the reader against the fixture
// feed (http://backend:8080): summary HTML safety (script/onclick/missing image),
// outbound links, full text success / failure, a slow full-text or item response
// that lands after the reader moved to another article, and a long article on
// a 390 px phone.
import { test, type Page } from "@playwright/test";
import { ready, H } from "../fullstack/helpers";

const FX = "http://backend:8080";

test("RSS-03: reader safety, full text, late responses, phone", async ({ page }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const req = page.request;
  const src = await (await req.post("/api/rss/subscribe", { ...H, data: { url: `${FX}/good.xml?run=${stamp}&n=4` } })).json();
  await page.waitForTimeout(4000);
  const items = ((await (await req.get(`/api/rss/items?source=${src.id}&limit=50`)).json()).items ?? []) as Array<{ id: string; title: string }>;
  const byIdx = (i: number) => items.find((x) => x.title.startsWith(`FX item ${i} `))!;
  out.items = items.length;
  const title = async (p: Page) => (await p.locator(".rss-article-title").innerText().catch(() => "(none)")).trim();
  const body = async (p: Page) => (await p.locator(".rss-article-body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 80);
  const open = async (p: Page, i: number) => {
    await p.locator(".rss-item-title", { hasText: `FX item ${i} (${stamp})` }).first().click();
    await p.waitForTimeout(1200);
  };

  await ready(page, `/?view=rss`);
  await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  await page.locator(".ui-filter-chip", { hasText: `FX Good ${stamp}` }).first().click();
  await page.waitForTimeout(1500);

  // 1. Summary safety.
  await open(page, 0);
  out.summary = await page.locator(".rss-article-body").evaluate((el) => ({
    scripts: el.querySelectorAll("script").length,
    onclick: el.querySelectorAll("[onclick]").length,
    pwned: (window as unknown as { __pwned?: number }).__pwned ?? null,
    links: Array.from(el.querySelectorAll("a")).map((a) => `${a.getAttribute("href")} target=${a.getAttribute("target")} rel=${a.getAttribute("rel")}`),
    imgs: Array.from(el.querySelectorAll("img")).map((i) => `${(i.getAttribute("src") ?? "").slice(0, 40)} ok=${(i as HTMLImageElement).naturalWidth > 0} visible=${(i as HTMLElement).offsetHeight > 0}`),
  }));
  out.headerLink = await page.locator(".rss-article-link").first().evaluate((a) => `${a.getAttribute("href")} target=${a.getAttribute("target")} rel=${a.getAttribute("rel")}`).catch(() => "(none)");

  // 2. Full text success.
  await page.locator(".rss-act-fulltext").click();
  await page.waitForTimeout(2500);
  out.full0 = { body: await body(page), pwned2: await page.evaluate(() => (window as unknown as { __pwned2?: number }).__pwned2 ?? null), scripts: await page.locator(".rss-article-body script").count(), notice: await page.locator(".rss-notice").innerText().catch(() => "") };

  // 3. Full text failure (article/2 answers 500).
  await page.locator(".rss-article-back").click().catch(() => {});
  await open(page, 2);
  await page.locator(".rss-act-fulltext").click();
  await page.waitForTimeout(2500);
  out.full2fail = { notice: await page.locator(".rss-notice").innerText().catch(() => "(no notice)"), bodyKept: await body(page), btnEnabled: await page.locator(".rss-act-fulltext").isEnabled() };

  // 4. Late full-text: item 1's full text is slow; meanwhile open item 3.
  await page.route(`**/api/rss/items/${byIdx(1).id}/fulltext`, async (r) => { await new Promise((x) => setTimeout(x, 5000)); await r.continue(); });
  await page.locator(".rss-article-back").click().catch(() => {});
  await open(page, 1);
  await page.locator(".rss-act-fulltext").click();
  await page.waitForTimeout(300);
  await page.locator(".rss-article-back").click().catch(() => {});
  await open(page, 3);
  out.lateFull_before = `${await title(page)} :: ${await body(page)}`;
  await page.waitForTimeout(6500);
  out.lateFull_after = `${await title(page)} :: ${await body(page)}`;
  await page.unroute(`**/api/rss/items/${byIdx(1).id}/fulltext`);

  // 5. Late item open: GET item 0 slow; click item 0 then item 3.
  await page.route(`**/api/rss/items/${byIdx(0).id}`, async (r) => { if (r.request().method() === "GET") await new Promise((x) => setTimeout(x, 4000)); await r.continue(); });
  await page.locator(".rss-article-back").click().catch(() => {});
  await page.locator(".rss-item-title", { hasText: `FX item 0 (${stamp})` }).first().click();
  await page.waitForTimeout(300);
  await page.locator(".rss-article-back").click().catch(() => {});
  await page.locator(".rss-item-title", { hasText: `FX item 3 (${stamp})` }).first().click().catch(() => {});
  await page.waitForTimeout(1000);
  out.lateOpen_before = await title(page);
  await page.waitForTimeout(4500);
  out.lateOpen_after = await title(page);
  await page.unroute(`**/api/rss/items/${byIdx(0).id}`);

  console.log("RSS03-part1 " + JSON.stringify(out, null, 2));
  // 6. Phone long article.
  await page.setViewportSize({ width: 390, height: 800 });
  await ready(page, `/?view=rss`);
  await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  await page.locator(".ui-filter-chip", { hasText: `FX Good ${stamp}` }).first().click();
  await page.waitForTimeout(1500);
  await open(page, 1);
  out.phone = await page.evaluate(() => {
    const b = document.querySelector(".rss-article-body") as HTMLElement | null;
    const pre = b?.querySelector("pre") as HTMLElement | null;
    return {
      font: b ? getComputedStyle(b).fontSize : null, lineHeight: b ? getComputedStyle(b).lineHeight : null,
      bodyWidth: b?.clientWidth, pageOverflow: document.documentElement.scrollWidth > innerWidth + 2,
      pre: pre ? `${pre.scrollWidth}/${pre.clientWidth} ox=${getComputedStyle(pre).overflowX}` : "(no pre)",
      paragraphs: b?.querySelectorAll("p").length,
    };
  });
  // Scroll to the end: is the end-of-article area reachable above the bottom nav?
  await page.locator(".rss-article-end, .rss-end-note").first().scrollIntoViewIfNeeded().catch(() => {});
  out.phoneEnd = await page.evaluate(() => {
    const e = document.querySelector(".rss-article-end, .rss-end-note") as HTMLElement | null;
    const nav = document.querySelector(".mobile-tab-bar, nav[class*='bottom'], .mobile-nav") as HTMLElement | null;
    const r = e?.getBoundingClientRect(); const n = nav?.getBoundingClientRect();
    return r ? `endBottom=${Math.round(r.bottom)} navTop=${n ? Math.round(n.top) : "?"} vh=${innerHeight}` : "(no end element)";
  });
  await page.screenshot({ path: `${process.env.SHOT_DIR ?? "/tmp"}/rss03-phone-end.png` }).catch(() => {});
  console.log("RSS03 " + JSON.stringify(out, null, 2));
});
