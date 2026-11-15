// Tick 21: SYS-03 — why does a replayed offline capture POST get 404? One capture, full request/response.
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { ready, openQuickCapture, H, psql as db, expectOffline } from "../fullstack/helpers";
test("offline capture replay detail", async ({ page, context }) => {
  test.setTimeout(240_000);
  const out: Record<string, unknown> = {}; const s = Date.now(); const log: unknown[] = [];
  page.on("response", async (r) => { if (r.url().endsWith("/api/nodes") && r.request().method() === "POST") log.push({ status: r.status(), req: r.request().postData()?.slice(0, 300), res: (await r.text().catch(() => "")).slice(0, 300) }); });
  await ready(page, "/?view=notes");
  await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  await page.waitForTimeout(2000);
  out.online1 = await (async () => { await openQuickCapture(page); await page.locator(".quick-capture-textarea").fill(`S03on ${s}`); await page.locator(".quick-capture-save").click(); await page.waitForTimeout(3000); return db(`select count(*) from content_nodes where title like 'S03on ${s}%'`); })();
  await context.setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expectOffline(page);
  await openQuickCapture(page); await page.locator(".quick-capture-textarea").fill(`S03off ${s}`); await page.locator(".quick-capture-save").click();
  await page.waitForTimeout(1500);
  await context.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(10_000);
  out.log = log;
  out.serverOff = db(`select count(*) from content_nodes where title like 'S03off ${s}%'`);
  const parent = (log.find((l) => String((l as { req?: string }).req).includes("S03off")) as { req?: string } | undefined)?.req;
  const pid = parent ? JSON.parse(parent).parent_id : null;
  out.parentId = pid; out.parentRow = pid ? db(`select title||' deleted='||(deleted_at is not null) from content_nodes where id='${pid}'`) : null;
  out.todayRows = db(`select id||' '||(deleted_at is not null) from content_nodes where title='2026-10-09'`);
  for (const t of ["S03on", "S03off"]) for (const id of db(`select id from content_nodes where title like '${t} ${s}%'`).split("\n").filter(Boolean)) await page.request.delete(`/api/nodes/${id}`, H).catch(() => {});
  console.log("SYS03B " + JSON.stringify(out, null, 2));
});
