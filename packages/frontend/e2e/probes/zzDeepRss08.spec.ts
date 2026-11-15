// Feature-audit deepening (2026-10-08): RSS-08 — web bookmark capture against fixture
// pages on http://backend:8081 (tick7/fixture/server2.mjs): fetch failure,
// timeout, duplicate URL, non-HTML, odd og: metadata, and the UI entry on a phone.
import { test } from "@playwright/test";
import { ready, BASE, H, psql as sql } from "../fullstack/helpers";

const FX = "http://backend:8081";

test("RSS-08: bookmarks", async ({ page }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const req = page.request;
  // ---- Bookmarks via API ----
  const bm = async (url: string) => {
    const t0 = Date.now();
    const r = await req.post("/api/bookmark", { ...H, data: { url }, timeout: 30_000 });
    const j = await r.json().catch(() => ({}));
    const md = j.id ? sql(`select replace(markdown, E'\\n', ' ⏎ ') from content_nodes where id='${j.id}'`) : "";
    return { status: r.status(), ms: Date.now() - t0, title: j.title, md: md.slice(0, 200), id: j.id };
  };
  const plain = await bm(`${FX}/plain.html?run=${stamp}`);
  out.bm_plain = plain;
  out.bm_dup = await bm(`${FX}/plain.html?run=${stamp}`);
  out.bm_dupCount = sql(`select count(*) from node_attributes where key='bookmark_url' and value='${FX}/plain.html?run=${stamp}'`);
  out.bm_500 = await bm(`${FX}/500.html?run=${stamp}`);
  out.bm_404 = await bm(`${FX}/nothing-here-${stamp}`);
  out.bm_slow = await bm(`${FX}/slow.html?run=${stamp}`);
  out.bm_pdf = await bm(`${FX}/doc.pdf?run=${stamp}`);
  const og = await bm(`${FX}/og.html?run=${stamp}`);
  out.bm_og = og;
  out.bm_notUrl = (await req.post("/api/bookmark", { ...H, data: { url: "not a url" } })).status();

  // Render the odd-og bookmark: any javascript: href/src, extra links?
  await ready(page, `/?view=notes&node=${og.id}`);
  await page.waitForTimeout(1500);
  const prev = page.locator("button", { hasText: /^Preview$/ }).first();
  if (await prev.count()) { await prev.click().catch(() => {}); await page.waitForTimeout(1000); }
  out.ogRender = await page.evaluate(() => {
    const root = document.querySelector(".obsidian-preview") as HTMLElement | null;
    return {
      root: root?.className ?? null,
      jsHrefs: Array.from(document.querySelectorAll("a[href^='javascript'], img[src^='javascript']")).length,
      text: root?.innerText.replace(/\s+/g, " ").slice(0, 200) ?? null,
    };
  });

  // ---- UI entry on a phone ----
  await page.setViewportSize({ width: 390, height: 800 });
  await ready(page, `/?view=notes`);
  await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  await page.locator('button[aria-label="Back to notes list"]').click().catch(() => {});
  await page.waitForTimeout(800);
  const plus = page.locator('button[aria-label="Create new node"]');
  out.phonePlusVisible = await plus.isVisible().catch(() => false);
  if (out.phonePlusVisible) {
    await plus.click();
    const item = page.locator(".sidebar-sort-menu-item", { hasText: "Bookmark" });
    out.phoneBookmarkItem = await item.count();
    page.once("dialog", (d) => { out.dialog = `${d.type()} "${d.message()}"`; void d.accept(`${FX}/500.html?run=${stamp}ui`); });
    if (await item.count()) { await item.click(); await page.waitForTimeout(4000); }
    out.phoneAfter = { url: page.url().replace(BASE, ""), toasts: (await page.locator(".toast").allInnerTexts().catch(() => [])).map((s) => s.slice(0, 100)) };
  }
  console.log("RSS08 " + JSON.stringify(out, null, 2));
});
