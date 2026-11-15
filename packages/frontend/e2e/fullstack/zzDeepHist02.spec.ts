// Feature-audit deepening (2026-10-07): HIST-02 — workspace event log on a
// phone: each filter, and a failed reload of the same query keeps the rows.
import { test, expect, request as pwRequest } from "@playwright/test";
import { ready, BASE, H } from "./helpers";


test("HIST-02: phone filters and same-query failure", async ({ browser, page: base }) => {
  test.setTimeout(120_000);
  const s = Date.now(); const out: Record<string, string> = {};
  const n = await (await base.request.post("/api/nodes", { ...H, data: { title: `H02 ${s}`, markdown: "x" } })).json();
  await base.request.patch(`/api/nodes/${n.id}`, { ...H, data: { markdown: "y" } });
  const actor = await (await base.request.post("/api/actors", { ...H, data: { name: `H02agent ${s}`, type: "agent" } })).json();
  const tok = await (await base.request.post(`/api/actors/${actor.id}/tokens`, { ...H, data: { template: "organizer" } })).json();
  const agent = await pwRequest.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { origin: BASE, authorization: `Bearer ${tok.token}` } });
  await agent.post("/api/mcp/tools/updateNode", { data: { args: { id: n.id, markdown: "agent edit", base_markdown: "y" } } });
  await agent.dispose();

  const ctx = await browser.newContext({ storageState: await base.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const page = await ctx.newPage();
  await ready(page, "/?view=timeline");
  await page.locator(".tl-tab", { hasText: "Events" }).filter({ visible: true }).first().click();
  const rows = page.locator(".ov-event-row, .tl-item").filter({ visible: true });
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });
  const actorSel = page.getByLabel("Actor filter"), typeSel = page.getByLabel("Event type filter");
  out.controls = `actorVisible=${await actorSel.isVisible()} typeVisible=${await typeSel.isVisible()} actorOpts=${JSON.stringify((await actorSel.locator("option").allInnerTexts()).slice(0, 5))} typeOpts=${(await typeSel.locator("option").count())}`;
  const total = await rows.count();
  for (const v of ["ai_agent", "user", "system"]) {
    const has = await actorSel.locator(`option[value="${v}"]`).count();
    if (!has) continue;
    await actorSel.selectOption(v); await page.waitForTimeout(1200);
    out[`actor=${v}`] = `rows=${await rows.count()} empty=${JSON.stringify(await page.locator(".timeline-empty").filter({ visible: true }).innerText().catch(() => ""))}`;
  }
  await actorSel.selectOption({ index: 0 }); await page.waitForTimeout(800);
  for (const v of ["NODE_UPDATED", "NODE_CREATED", "TAG_MERGED"]) {
    const has = await typeSel.locator(`option[value="${v}"]`).count();
    if (!has) { out[`type=${v}`] = "no option"; continue; }
    await typeSel.selectOption(v); await page.waitForTimeout(1200);
    out[`type=${v}`] = `rows=${await rows.count()} empty=${JSON.stringify(await page.locator(".timeline-empty").filter({ visible: true }).innerText().catch(() => ""))}`;
  }
  await typeSel.selectOption({ index: 0 }); await page.waitForTimeout(800);
  out.total = String(total);

  // Same query, reload fails: rows must stay and the error must be visible.
  const before = await rows.count();
  await page.route("**/api/events*", (r) => r.fulfill({ status: 503, body: "{\"error\":\"unavailable\"}" }));
  const reloadBtn = page.getByRole("button", { name: /Reload|Refresh|重新整理/ }).filter({ visible: true }).first();
  if (await reloadBtn.count()) await reloadBtn.click(); else { await actorSel.selectOption({ index: 0 }); }
  await page.waitForTimeout(2000);
  out.failedReload = `rowsBefore=${before} rowsAfter=${await rows.count()} error=${JSON.stringify(await page.locator(".timeline-empty").filter({ visible: true }).innerText().catch(() => ""))} viaButton=${await reloadBtn.count() > 0}`;
  // Changing the filter while failing: does the old list leak under the new filter?
  if (await actorSel.locator('option[value="ai_agent"]').count()) {
    await actorSel.selectOption("ai_agent"); await page.waitForTimeout(2000);
    out.failedNewQuery = `rows=${await rows.count()} error=${JSON.stringify(await page.locator(".timeline-empty").filter({ visible: true }).innerText().catch(() => ""))} filterShown=${await actorSel.inputValue()}`;
  }
  await page.unroute("**/api/events*");
  out.docWidth = String(await page.evaluate(() => document.documentElement.scrollWidth));
  await page.screenshot({ path: "/tmp/pw-output/hist02-phone.png", fullPage: true });
  await ctx.close();
  console.log(`AUDIT HIST-02 ${JSON.stringify(out)}`);
});
