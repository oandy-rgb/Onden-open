// Tick 20: UX-01 / ACC-08 — a cold page whose first /api/bootstrap fails shows
// "1 change(s) waiting to sync". What is that write, and what happens when it drains?
import { test } from "@playwright/test";
import { BASE, psql as db } from "../fullstack/helpers";
test("bootstrap failure pending write", async ({ browser }) => {
  test.setTimeout(240_000);
  const out: Record<string, unknown> = {};
  const ctx = await browser.newContext({ baseURL: BASE, storageState: test.info().project.use.storageState as string, viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const writes: string[] = [];
  p.on("request", (r) => { if (r.method() !== "GET" && r.url().includes("/api/") && !r.url().includes("/api/sync")) writes.push(`${r.method()} ${r.url().replace(BASE, "")} ${(r.postData() ?? "").slice(0, 160)}`); });
  out.dailyBefore = db("select count(*) from content_nodes where title='2026-10-09' and deleted_at is null");
  out.maxEvent = db("select max(id) from domain_events");
  await p.route("**/api/bootstrap*", (r) => r.fulfill({ status: 500, contentType: "application/json", body: "{\"error\":\"boom\"}" }));
  await p.goto(`${BASE}/?view=notes`);
  await p.waitForTimeout(6000);
  out.pendingText = (await p.locator("body").innerText()).match(/\d+ change\(s\) waiting to sync/)?.[0] ?? null;
  out.writesWhileFailing = [...writes];
  out.today = await p.evaluate(() => new Date().toString());
  await p.unroute("**/api/bootstrap*");
  await p.getByRole("button", { name: /Sync now/i }).filter({ visible: true }).first().click().catch(() => {});
  await p.waitForTimeout(6000);
  out.writesAfter = writes.slice((out.writesWhileFailing as string[]).length);
  out.syncButtons = await p.locator("button").filter({ hasText: /sync/i }).allInnerTexts();
  await p.reload(); await p.waitForTimeout(8000);
  out.writesAfterReload = writes.slice((out.writesWhileFailing as string[]).length);
  out.pendingAfter = (await p.locator("body").innerText()).match(/\d+ change\(s\) waiting to sync/)?.[0] ?? null;
  out.dailyAfter = db("select count(*) from content_nodes where title='2026-10-09' and deleted_at is null");
  out.newEvents = db(`select id||' '||event_type||' '||coalesce(payload->>'title','')||' '||coalesce(tx_meta->>'ui_context','') from domain_events where id>${out.maxEvent} order by id`).split("\n").slice(0, 10);
  await ctx.close();
  console.log("UX01B " + JSON.stringify(out, null, 2));
});
