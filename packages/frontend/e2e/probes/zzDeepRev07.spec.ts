// Feature-audit deepening (2026-10-08): REV-07 — lecture → extract cards →
// grade → edit the lecture (change an answer, reword a question, add one) →
// re-extract → rename the lecture; plus a mid-way failure (tag PUT 500 on one
// card) and its recovery on the next run. Desktop 1280 and phone 390.
import { test, type Page } from "@playwright/test";
import { ready, H, psql as sql } from "../fullstack/helpers";
import { makeReviewCard } from "../fullstack/reviewFixtures";


for (const width of [1280, 390]) {
  test(`REV-07 journey @${width}`, async ({ page }) => {
    test.setTimeout(300_000);
    const stamp = Date.now();
    const out: Record<string, unknown> = { width };
    const req = page.request;
    await page.setViewportSize({ width, height: 820 });
    const tag = await (await req.post("/api/tags/import", { ...H, data: { name: `r07${width}x${stamp}`, fields: [] } })).json();
    const title = `R07 Lecture ${width} ${stamp}`;
    const v1 = ["# Week 1", "", "Q: What is a cache?", "A: A small fast store.", "", "Q: What is latency?", "A: Time to first byte.", "", "Q: Define throughput", "A: Work per unit time."].join("\n");
    const lec = (await (await req.post("/api/nodes", { ...H, data: { title, markdown: v1 } })).json()).id as string;
    await Promise.all([req.put(`/api/nodes/${lec}/tags/${tag.id}`, { ...H, data: {} }), makeReviewCard(req, lec)]);
    const children = () => sql(`select title || ' | ' || replace(left(markdown,60), E'\\n', ' ') || ' | tags=' || (select count(*) from node_tags t where t.node_id=n.id and t.tag_id='${tag.id}') || ' | st=' || coalesce((select (value::json->>'reps') from node_attributes a where a.node_id=n.id and a.key='_review_state'),'-') from content_nodes n where parent_id='${lec}' and deleted_at is null order by created_at, sort_order`).split("\n").filter(Boolean);
    const toasts = async (p: Page) => (await p.locator(".toast").allInnerTexts().catch(() => [])).map((s) => s.replace(/\s+/g, " ").slice(0, 100));
    const extract = async (p: Page) => {
      await p.keyboard.press("Escape").catch(() => {});
      await p.keyboard.press("Control+k");
      await p.locator(".palette-input-wrap input").fill(">Extract review");
      const item = p.locator(".palette-item", { hasText: "Extract review cards" }).first();
      const has = await item.count();
      if (!has) { await p.keyboard.press("Escape"); return "(no command)"; }
      await item.click();
      await p.waitForTimeout(2500);
      return (await toasts(p)).join(" / ");
    };

    await ready(page, `/?view=notes&node=${lec}`);
    out.extract1 = await extract(page);
    out.after1 = children();

    // Grade the first card through the API (UI grading is covered by REV-06).
    const first = sql(`select id from content_nodes where parent_id='${lec}' and title='What is a cache?' and deleted_at is null limit 1`);
    out.grade = first ? (await req.post(`/api/review/${first}/grade`, { ...H, data: { rating: 3 } })).status() : "no card";

    // Edit the lecture in the editor: change answer 2, reword Q3, add Q4.
    const v2 = v1.replace("Time to first byte.", "Delay before a transfer begins.").replace("Q: Define throughput", "Q: What is throughput?") + "\n\nQ: What is a CDN?\nA: Edge caches near users.";
    const cm = page.locator(".cm-content").first();
    await cm.click();
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText(v2);
    await page.waitForTimeout(2500);
    out.lectureSaved = sql(`select position('CDN' in markdown) > 0 from content_nodes where id='${lec}'`);

    // Mid-way failure: the tag PUT for the first new card fails.
    let failed = 0;
    await page.route("**/api/nodes/*/tags/*", async (route) => {
      if (route.request().method() === "PUT" && failed === 0) { failed++; return route.fulfill({ status: 500, body: "{\"error\":\"boom\"}", contentType: "application/json" }); }
      return route.continue();
    });
    out.extract2_failing = await extract(page);
    await page.unroute("**/api/nodes/*/tags/*");
    out.after2 = children();
    await page.waitForTimeout(4000);
    out.extract3_retry = await extract(page);
    out.after3 = children();
    out.extract4_again = await extract(page);

    // Rename the lecture; does the card back-link follow?
    const newTitle = `R07 Renamed ${width} ${stamp}`;
    out.rename = (await req.patch(`/api/nodes/${lec}`, { ...H, data: { title: newTitle } })).status();
    await page.waitForTimeout(1500);
    out.backlinks = sql(`select count(*) filter (where markdown like '%[[${newTitle}]]%') || ' new / ' || count(*) filter (where markdown like '%[[${title}]]%') || ' old' from content_nodes where parent_id='${lec}' and deleted_at is null`);

    // Review the deck: which cards come up, and does the edited answer show?
    await ready(page, `/?view=notes&node=${lec}`);
    await page.keyboard.press("Control+k");
    await page.locator(".palette-input-wrap input").fill(">Review cards");
    await page.locator(".palette-item", { hasText: "Review cards under this note" }).first().click();
    await page.locator(".review-panel").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(2500);
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      const t = (await page.locator(".review-card-title").innerText().catch(() => "")).trim();
      if (!t) break;
      await page.locator(".review-reveal").click();
      await page.waitForTimeout(400);
      seen.push(`${t} → ${(await page.locator(".review-card-body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 60)}`);
      await page.locator(".review-grades button").filter({ hasText: "Good" }).first().click();
      await page.waitForTimeout(900);
    }
    out.reviewed = seen;
    out.endPanel = (await page.locator(".review-panel").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
    out.overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2);
    const agenda = JSON.stringify(await (await req.get(`/api/tasks/agenda`)).json().catch(() => ({})));
    out.studyTasks = (agenda.match(new RegExp(`"[^"]*Study: R07 [^"]*${stamp}[^"]*"`, "g")) ?? []).slice(0, 4);
    console.log(`REV07@${width} ` + JSON.stringify(out, null, 2));
  });
}
