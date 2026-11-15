// NAV-01 follow-up (2026-10-08): the Reading and Review screens when their
// first GET fails, and what a freshly signed-up (non-member) account sees.
import { test } from "@playwright/test";
import { ready, BASE, H } from "../fullstack/helpers";


test("NAV-01b: failure screens and fresh account", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const out: Record<string, unknown> = {};
  const reqs: string[] = [];
  page.on("request", (r) => { if (/\/api\/(rss|read|review)/.test(r.url()) && r.method() === "GET") reqs.push(r.url().replace(BASE, "").slice(0, 50)); });
  await ready(page, "/?view=rss"); await page.waitForTimeout(2000);
  out.readingReqs = [...new Set(reqs)];
  out.readingOk = (await page.locator(".rss-reader, main").last().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
  await page.route(/\/api\/rss\//, (r) => r.request().method() === "GET" ? r.fulfill({ status: 503, body: "{}" }) : r.continue());
  await page.reload(); await page.waitForTimeout(3000);
  await page.screenshot({ path: test.info().outputPath("reading-503.png") });
  out.reading503 = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 400);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.route(/\/api\/review\//, (r) => r.request().method() === "GET" ? r.fulfill({ status: 503, body: "{}" }) : r.continue());
  await ready(page, "/?view=review"); await page.waitForTimeout(2500);
  await page.screenshot({ path: test.info().outputPath("review-503.png") });
  out.review503 = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(-200);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const fresh = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] } });
  const fp = await fresh.newPage();
  await fp.request.post("/api/auth/sign-up/email", { ...H, data: { name: `Fresh2 ${Date.now()}`, email: `fresh2-${Date.now()}@example.com`, password: `pw-${Date.now()}-x` } });
  await fp.goto(`${BASE}/`); await fp.waitForTimeout(5000);
  await fp.screenshot({ path: test.info().outputPath("fresh.png") });
  out.fresh = (await fp.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300);
  out.freshBootstrap = (await fp.request.get("/api/bootstrap?slim=1")).status();
  await fresh.close();
  console.log("NAV01B " + JSON.stringify(out, null, 2));
});
