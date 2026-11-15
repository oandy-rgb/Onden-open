import { test, expect, type Page } from "@playwright/test";
import { renderSettled, defaultSpaceId, siteDesign, H, publishRequest } from "./helpers";

// CHAOS design review (PROBE=1): weird content + weird operations, screenshot
// everything. Run against a FRESH stack (publish needs the first/owner user).
const S = "/tmp/pw-output/shots";
const shot = async (page: Page, name: string) => {
  await renderSettled(page); // fonts + frames flushed — replaces the old fixed pre-shot sleeps
  await page.screenshot({ path: `${S}/${name}.png` });
};

test("chaos captures", async ({ page }) => {
  test.skip(!process.env.PROBE, "capture only");
  test.setTimeout(240_000);
  const stamp = Date.now();
  const mk = async (title: string, markdown: string, parent_id?: string) =>
    (await (await page.request.post("/api/nodes", { ...H, data: { space_id: await defaultSpaceId(page.request), title, markdown, parent_id } })).json());

  // ── Weird content ──
  const longTitle = "超長標題".repeat(25) + stamp; // ~100 chars, no break points
  const hub = await mk("混亂花園", "# 混亂花園\n\n入口。");
  const long = await mk(longTitle, `# 長\n\n${"很長的段落沒有斷點".repeat(40)}\n\n#超長`);
  const emoji = await mk("🌵🌵🌵", "# 🌵\n\n只有 emoji 的標題。 #🌵tag");
  const rtl = await mk("ملاحظة عربية", "# عنوان\n\nنص من اليمين إلى اليسار with mixed English.");
  const xss = await mk(`<script>alert(${stamp})</script>`, "# x\n\n<img src=x onerror=alert(1)> 內文也有。");
  const empty = await mk(`空筆記 ${stamp}`, "");
  const manyTags = await mk(`標籤海 ${stamp}`, "# 標籤海\n\n" + Array.from({ length: 50 }, (_, i) => `#tag${i}`).join(" "));
  // 6-level nesting chain under hub
  let parent = hub;
  const chain: Array<{ id: string; slug: string }> = [];
  for (let d = 1; d <= 6; d++) {
    parent = await mk(`第${d}層`, `# 第${d}層\n\n深度 ${d}。`, parent.id);
    chain.push(parent);
  }
  const all = [hub, long, emoji, rtl, xss, empty, manyTags, ...chain];
  for (const n of all) {
    await page.request.put(`/api/nodes/${n.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
  }
  const saved = await page.request.patch("/api/workspace/config", {
    ...H, data: { config: { brand: "混亂花園", tagline: "壓力測試" }, chrome: siteDesign({ homeNoteId: hub.id }) },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  const pub = await publishRequest(page.request, { title: `Chaos ${stamp}`, home_node_id: hub.id });
  expect(pub.status(), await pub.text()).toBe(201);
  const site = await (await page.request.get("/api/site")).json();
  const slugOf = (id: string) => (site.payload?.nodes ?? []).find((n: { id: string }) => n.id === id)?.slug;

  // ── Weird operations ──

  // c1: XSS title — must render as text, no dialog. Fail loudly if one opens.
  page.on("dialog", (d) => { throw new Error(`XSS dialog fired: ${d.message()}`); });
  await page.goto(`/site/${slugOf(xss.id)}`, { waitUntil: "networkidle" });
  await shot(page, "c-01-xss-title");

  // c2: long-title page on a tiny phone (320×568) — wrapping/overflow.
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(`/site/${slugOf(long.id)}`, { waitUntil: "networkidle" });
  await shot(page, "c-02-long-tiny");

  // c5: the reader's dark setting (the OS preference; the site has no toggle).
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`/site/${slugOf(emoji.id)}`, { waitUntil: "networkidle" });
  await shot(page, "c-05-dark");
  await page.emulateMedia({ colorScheme: "light" });

  // c6: weird searches — spaces, emoji, an XSS fragment. The search is
  // client-side; results/empty-state are the observable conditions.
  const search = page.locator(".s-search__input");
  await search.fill("   ");
  await expect(page.locator(".s-search__results")).toHaveCount(0); // a blank query shows nothing
  await search.fill("🌵");
  await page.locator(".s-search__hit, .s-search__empty").first().waitFor({ timeout: 10_000 });
  await shot(page, "c-06-search-emoji");
  await search.fill("<script>");
  await page.locator(".s-search__hit, .s-search__empty").first().waitFor({ timeout: 10_000 });
  await shot(page, "c-07-search-xss");
  await search.press("Escape");

  // c8: the deepest note: the left note tree is off by default, the page must still read well.
  await page.goto(`/site/${slugOf(chain[5].id)}`, { waitUntil: "networkidle" });
  await shot(page, "c-08-deep-note");

  // c10: the awkward 500px middle zone (below desktop, above nothing).
  await page.setViewportSize({ width: 500, height: 800 });
  await page.goto(`/site/${slugOf(manyTags.id)}`, { waitUntil: "networkidle" });
  await shot(page, "c-10-500px-tagflood");

  // c11: landscape phone.
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto(`/site/${slugOf(rtl.id)}`, { waitUntil: "networkidle" });
  await shot(page, "c-11-landscape-rtl");

  // c12: empty note page.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/site/${slugOf(empty.id)}`, { waitUntil: "networkidle" });
  await shot(page, "c-12-empty-note");

  // c13: the home page with the deep tree published under it.
  await page.goto("/site/", { waitUntil: "networkidle" });
  await shot(page, "c-13-home");
});
