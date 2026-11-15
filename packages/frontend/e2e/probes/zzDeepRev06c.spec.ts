// Feature-audit deepening (2026-10-08): REV-06 grade failures — committed but
// response lost (retry must not double-grade), 503 then retry, a 409, and
// going offline mid-session then reconnecting.
import { test, type Page } from "@playwright/test";
import { ready, H, psql as sql } from "../fullstack/helpers";
import { makeReviewCard } from "../fullstack/reviewFixtures";



test("REV-06c: grade lost response / 503 / 409 / offline", async ({ page }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const req = page.request;
  const tag = await (await req.post("/api/tags/import", { ...H, data: { name: `r06c${stamp}`, fields: [] } })).json();
  const deck = (await (await req.post("/api/nodes", { ...H, data: { title: `R06c deck ${stamp}`, markdown: "d" } })).json()).id as string;
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const id = (await (await req.post("/api/nodes", { ...H, data: { title: `R06c ${i} ${stamp}`, markdown: `card ${i}`, parent_id: deck } })).json()).id as string;
    await Promise.all([req.put(`/api/nodes/${id}/tags/${tag.id}`, { ...H, data: {} }), makeReviewCard(req, id)]);
    ids.push(id);
  }
  const reps = async (id: string) => {
    const raw = sql(`select value from node_attributes where node_id='${id}' and key='_review_state'`);
    try { return JSON.parse(raw).reps; } catch { return raw || null; }
  };
  const panel = async (p: Page) => (await p.locator(".review-panel").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 220);
  const title = async (p: Page) => (await p.locator(".review-card-title").innerText().catch(() => "(none)")).trim();
  const good = (p: Page) => p.locator(".review-panel button.review-grade, .review-grades button").filter({ hasText: "Good" }).first();

  await ready(page, `/?view=notes&node=${deck}`);
  await page.keyboard.press("Control+k");
  await page.locator(".palette-input-wrap input").fill(">Review cards");
  await page.locator(".palette-item", { hasText: "Review cards under this note" }).first().click();
  await page.locator(".review-reveal").waitFor({ timeout: 10_000 });

  // 1. Committed, response lost.
  let grades = 0;
  const gradeLog: string[] = [];
  page.on("response", async (r) => { if (r.url().includes("/grade")) gradeLog.push(`${r.status()} ${(await r.text().catch(() => "")).slice(0, 90)}`); });
  page.on("requestfailed", (r) => { if (r.url().includes("/grade")) gradeLog.push(`failed ${r.failure()?.errorText} key=${r.headers()["idempotency-key"]?.slice(0, 8)}`); });
  page.on("request", (r) => { if (r.url().includes("/grade")) gradeLog.push(`req key=${r.headers()["idempotency-key"]?.slice(0, 8)} body=${r.postData()}`); });
  await page.route("**/api/review/*/grade", async (route) => {
    grades++;
    if (grades === 1) { const res = await route.fetch(); gradeLog.push(`server(1) ${res.status()} ${(await res.text()).slice(0, 60)}`); await route.abort("connectionreset"); return; }
    await route.continue();
  });
  const t1 = await title(page);
  await page.locator(".review-reveal").click();
  await good(page).click();
  await page.waitForTimeout(1500);
  out.lost_ui = await panel(page);
  out.lost_titleNow = await title(page);
  await good(page).click({ timeout: 5000 }).catch((e) => { out.lost_retryErr = String(e).split("\n")[0].slice(0, 100); });
  await page.waitForTimeout(1500);
  out.lost_afterRetry = await panel(page);
  const id1 = ids.find((_, i) => t1.startsWith(`R06c ${i} `));
  out.lost_reps = id1 ? await reps(id1) : `?(${t1})`;
  out.lost_requests = grades;
  out.lost_gradeLog = gradeLog.slice();
  out.lost_buttons = await page.locator(".review-panel button").allInnerTexts();
  console.log("REV06C-step1 " + JSON.stringify(out, null, 2));
  // Give a third retry, then a reload, to see whether it ever clears.
  await good(page).click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(2000);
  out.lost_afterRetry2 = await panel(page);
  out.lost_gradeLog2 = gradeLog.slice();
  await page.unroute("**/api/review/*/grade");
  await page.reload();
  await page.waitForTimeout(6000);
  out.lost_afterReload = await panel(page);
  console.log("REV06C-step1b " + JSON.stringify(out, null, 2));
  if (!(await page.locator(".review-reveal").count())) {
    await ready(page, `/?view=notes&node=${deck}`);
    await page.keyboard.press("Control+k");
    await page.locator(".palette-input-wrap input").fill(">Review cards");
    await page.locator(".palette-item", { hasText: "Review cards under this note" }).first().click();
    await page.locator(".review-reveal").waitFor({ timeout: 10_000 });
  }

  // 2. 503 then retry.
  let n503 = 0;
  await page.route("**/api/review/*/grade", async (route) => {
    n503++;
    if (n503 === 1) return route.fulfill({ status: 503, body: JSON.stringify({ error: "unavailable" }), contentType: "application/json" });
    return route.continue();
  });
  const t2 = await title(page);
  await page.locator(".review-reveal").click();
  await good(page).click();
  await page.waitForTimeout(1200);
  out.s503_ui = await panel(page);
  // Try a different grade first (should be refused while the Good attempt is pending).
  await page.locator(".review-grades button").filter({ hasText: "Easy" }).first().click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(600);
  out.s503_afterEasy = { title: await title(page), reqs: n503 };
  await good(page).click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);
  out.s503_afterRetry = await panel(page);
  const id2 = ids.find((_, i) => t2.startsWith(`R06c ${i} `));
  out.s503_reps = id2 ? await reps(id2) : `?(${t2})`;
  await page.unroute("**/api/review/*/grade");

  // 3. 409 (non-retryable).
  await page.route("**/api/review/*/grade", (route) => route.fulfill({ status: 409, body: JSON.stringify({ error: "note has no enabled review tag" }), contentType: "application/json" }));
  await page.locator(".review-reveal").click().catch(() => {});
  await good(page).click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);
  out.s409_ui = await panel(page);
  await page.unroute("**/api/review/*/grade");

  // 4. Offline mid-session.
  await page.context().setOffline(true);
  await page.waitForTimeout(1500);
  out.offline_ui = await panel(page);
  await page.locator(".review-reveal").click({ timeout: 3000 }).catch(() => {});
  out.offline_gradeDisabled = await good(page).isDisabled().catch(() => "(no button)");
  await good(page).click({ timeout: 2000 }).catch(() => {});
  await page.keyboard.press("3");
  await page.waitForTimeout(800);
  out.offline_afterTry = await panel(page);
  await page.context().setOffline(false);
  await page.waitForTimeout(4000);
  out.online_ui = await panel(page);
  out.finalReps = Object.fromEntries(await Promise.all(ids.map(async (id, i) => [i, await reps(id)])));
  console.log("REV06C " + JSON.stringify(out, null, 2));
});
