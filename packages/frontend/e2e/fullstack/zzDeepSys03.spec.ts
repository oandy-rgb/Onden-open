// Feature-audit deepening (2026-10-09, tick 21): SYS-03 — offline queue replay
// with dependent writes.
// A. offline: capture A and B, then edit A's body (PATCH depends on A's POST).
//    On replay A's POST is refused (403): what happens to A's PATCH, does B
//    still land (failure isolation), what does the user see?
// B. offline capture C; on replay the POST commits but the response is lost →
//    same-key retry → exactly one C on the server.
// C. offline body edit of an existing note; on replay PATCH gets 401 (session
//    expired): the write must stay pending (not "rejected"), then drain.
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { ready, openQuickCapture, BASE, H, psql as db, expectOffline, pendingCount } from "./helpers";


async function goOffline(page: Page, context: BrowserContext) {
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expectOffline(page);
}
async function goOnline(page: Page, context: BrowserContext) {
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
}
async function capture(page: Page, text: string) {
  await openQuickCapture(page);
  await page.locator(".quick-capture-textarea").fill(text);
  await page.locator(".quick-capture-save").click();
  await expect(page.locator(".quick-capture-overlay")).toHaveCount(0);
}
const pending = async (page: Page) => String(await pendingCount(page));
const recovery = async (page: Page) => (await page.locator(".failed-write-recovery, [class*=recovery]").filter({ visible: true }).allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, " ").slice(0, 260));

test("SYS-03: dependent replay, refused create, lost response, 401", async ({ page, context }) => {
  test.setTimeout(400_000);
  const out: Record<string, unknown> = {};
  const s = Date.now();
  const reqLog: string[] = [];
  page.on("response", (r) => { const u = r.url(); if (u.includes("/api/nodes") && r.request().method() !== "GET") reqLog.push(`${r.request().method()} ${u.replace(BASE, "").slice(0, 60)} → ${r.status()}`); });
  page.on("requestfailed", (r) => { if (r.url().includes("/api/nodes")) reqLog.push(`${r.method()} ${r.url().replace(BASE, "").slice(0, 60)} ✗ ${r.failure()?.errorText}`); });
  try {
  await page.setViewportSize({ width: 1280, height: 800 });
  await ready(page, "/?view=notes");
  await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // ── A ──
  await goOffline(page, context);
  await capture(page, `S03A ${s}`);
  await capture(page, `S03B ${s}`);
  await page.getByText(`S03A ${s}`, { exact: true }).first().click({ timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(800);
  out.aOpened = await page.locator(".obsidian-title-input").inputValue().catch(() => null);
  await page.locator(".cm-content").click().catch(() => {});
  await page.keyboard.press("Control+End");
  await page.keyboard.type(` dependent-edit-${s}`);
  await page.waitForTimeout(2500);
  out.aPendingOffline = await pending(page);
  await page.route("**/api/nodes", async (r) => {
    if (r.request().method() === "POST" && (r.request().postData() ?? "").includes(`S03A ${s}`)) return r.fulfill({ status: 403, contentType: "application/json", body: "{\"error\":\"forbidden\"}" });
    return r.continue();
  });
  reqLog.length = 0;
  await goOnline(page, context);
  await page.waitForTimeout(15_000);
  out.A = {
    requests: [...reqLog],
    pending: await pending(page),
    recovery: await recovery(page),
    serverA: db(`select count(*) from content_nodes where title like 'S03A ${s}%'`),
    serverB: db(`select count(*) from content_nodes where title like 'S03B ${s}%'`),
    aStillListed: await page.getByText(`S03A ${s}`, { exact: true }).count(),
    toasts: await page.locator(".toast-message").allInnerTexts(),
  };
  await page.unroute("**/api/nodes");
  await page.reload(); await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {}); await page.waitForTimeout(4000);
  out.A_afterReload = { pending: await pending(page), recovery: await recovery(page), aStillListed: await page.getByText(`S03A ${s}`, { exact: true }).count(), serverA: db(`select count(*) from content_nodes where title like 'S03A ${s}%'`) };

  // ── B ── (focus an existing note so the capture's parent exists)
  for (const b of await page.locator(".fwr-dismiss").filter({ visible: true }).all()) await b.click().catch(() => {});
  const parentP = await (await page.request.post("/api/nodes", { ...H, data: { title: `S03P ${s}`, markdown: "parent" } })).json();
  await ready(page, `/?view=notes&node=${parentP.id}`);
  await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await goOffline(page, context);
  await capture(page, `S03C ${s}`);
  let dropped = 0;
  await page.route("**/api/nodes", async (r) => {
    if (r.request().method() === "POST" && (r.request().postData() ?? "").includes(`S03C ${s}`) && dropped === 0) {
      dropped++; await r.fetch().catch(() => null); return r.abort("connectionreset");
    }
    return r.continue();
  });
  reqLog.length = 0;
  await goOnline(page, context);
  await page.waitForTimeout(12_000);
  await page.unroute("**/api/nodes");
  await page.getByRole("button", { name: /Sync now/i }).filter({ visible: true }).first().click().catch(() => {});
  await page.waitForTimeout(6000);
  out.B = { parentOfC: db(`select coalesce(p.title,'none') from content_nodes c left join content_nodes p on p.id=c.parent_id where c.title like 'S03C ${s}%' limit 1`), dropped, requests: [...reqLog], pending: await pending(page), recovery: await recovery(page), serverC: db(`select count(*) from content_nodes where title like 'S03C ${s}%' and deleted_at is null`) };

  // ── C ──
  const existing = await (await page.request.post("/api/nodes", { ...H, data: { title: `S03E ${s}`, markdown: "start" } })).json();
  await ready(page, `/?view=notes&node=${existing.id}`);
  await page.locator(".membership-gate").waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {});
  await page.waitForTimeout(2500);
  for (const b of await page.locator(".fwr-dismiss").filter({ visible: true }).all()) await b.click().catch(() => {});
  await goOffline(page, context);
  for (const b of await page.locator(".fwr-dismiss, .fwr-minimize, [aria-label='Minimize recovery panel']").filter({ visible: true }).all()) await b.click().catch(() => {});
  await page.locator(".cm-content").click({ force: true });
  await page.keyboard.press("Control+End");
  await page.keyboard.type(` offline-401-${s}`);
  await page.waitForTimeout(2500);
  await page.route(`**/api/nodes/${existing.id}`, (r) => r.request().method() === "PATCH" ? r.fulfill({ status: 401, contentType: "application/json", body: "{\"error\":\"unauthorized\"}" }) : r.continue());
  reqLog.length = 0;
  await goOnline(page, context);
  await page.waitForTimeout(10_000);
  out.C_during401 = { requests: [...reqLog], pending: await pending(page), recovery: await recovery(page), toasts: await page.locator(".toast-message").allInnerTexts(), server: db(`select position('offline-401-${s}' in markdown) > 0 from content_nodes where id='${existing.id}'`) };
  await page.unroute(`**/api/nodes/${existing.id}`);
  await page.getByRole("button", { name: /Sync now/i }).filter({ visible: true }).first().click().catch(() => {});
  await page.waitForTimeout(8000);
  out.C_after = { pending: await pending(page), recovery: await recovery(page), server: db(`select position('offline-401-${s}' in markdown) > 0 from content_nodes where id='${existing.id}'`) };

  } finally {
  // cleanup
  for (const t of ["S03A", "S03B", "S03C", "S03E", "S03P"]) for (const id of db(`select id from content_nodes where title like '${t} ${s}%' and deleted_at is null`).split("\n").filter(Boolean)) await page.request.delete(`/api/nodes/${id}`, H).catch(() => {});
  console.log("SYS03 " + JSON.stringify(out, null, 2));
  }
});
