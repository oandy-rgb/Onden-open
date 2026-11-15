// Feature-audit deepening (2026-10-07): AI-05 — inbox list with several agents,
// facet filters, empty states, volume beyond the default page, load failure,
// and phone viewport.
import { test, expect, request as pwRequest, type Page } from "@playwright/test";
import { ready, BASE, H } from "./helpers";


async function openInbox(page: Page) {
  const tab = page.locator(".obsidian-sidebar").getByText("Inbox", { exact: true }).filter({ visible: true }).first();
  await tab.click();
}
async function agent(page: Page, name: string) {
  const a = await (await page.request.post("/api/actors", { ...H, data: { name, type: "agent" } })).json();
  const t = await (await page.request.post(`/api/actors/${a.id}/tokens`, { ...H, data: { template: "organizer" } })).json();
  return pwRequest.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { origin: BASE, authorization: `Bearer ${t.token}` } });
}

test("AI-05: inbox facets, empty, volume, failure and phone", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, string> = {};

  // Failure on the very first load.
  await page.route("**/api/inbox?*", (r) => r.fulfill({ status: 503, body: "{\"error\":\"unavailable\"}" }));
  await page.route("**/api/inbox", (r) => r.fulfill({ status: 503, body: "{\"error\":\"unavailable\"}" }));
  await ready(page, "/?view=notes");
  await openInbox(page);
  await page.waitForTimeout(1500);
  out.firstLoad503 = JSON.stringify((await page.locator(".obsidian-sidebar").innerText()).replace(/\s+/g, " ").slice(0, 160));
  await page.unroute("**/api/inbox?*"); await page.unroute("**/api/inbox");

  await ready(page, "/?view=notes");
  await openInbox(page);
  out.emptyState = String(await page.getByText("Nothing waiting for your review").count());

  const ann = await agent(page, `Ann ${stamp}`), bob = await agent(page, `Bob ${stamp}`);
  const notes = await Promise.all(Array.from({ length: 6 }, (_, i) => page.request.post("/api/nodes", { ...H, data: { title: `Inb${i} ${stamp}`, markdown: "x" } }).then((r) => r.json())));
  for (const [i, n] of notes.entries()) await (i < 4 ? ann : bob).post("/api/mcp/tools/updateNode", { data: { args: { id: n.id, markdown: `edit ${i}`, base_markdown: "x" } } });
  await ready(page, "/?view=notes");
  await openInbox(page);
  const chips = page.locator(".inbox-filter-chip");
  await expect(chips.first()).toBeVisible({ timeout: 15_000 });
  out.chips = JSON.stringify(await chips.allInnerTexts());
  await chips.filter({ hasText: `Bob ${stamp}` }).click();
  await page.waitForTimeout(1000);
  out.bobFiltered = `${await page.locator(".inbox-review-item, .inbox-ev").count()} items, text has Ann=${(await page.locator(".obsidian-sidebar").innerText()).includes(`Inb0 ${stamp}`)}`;
  const typeSel = page.locator(".inbox-filter-type");
  if (await typeSel.count()) {
    const opts = await typeSel.locator("option").allInnerTexts();
    out.typeOptions = JSON.stringify(opts);
  }
  await page.locator(".inbox-filter-clear").click();
  await page.waitForTimeout(800);
  out.afterClear = String(await page.locator(".inbox-filter-chip.active").count());

  // Volume: 120 agent edits → does the UI show all, page, or cap silently?
  // Three agents × 45 edits stays under the 60/min per-token limit.
  const crew = [await agent(page, `C1 ${stamp}`), await agent(page, `C2 ${stamp}`), await agent(page, `C3 ${stamp}`)];
  const many = await Promise.all(Array.from({ length: 135 }, (_, i) => page.request.post("/api/nodes", { ...H, data: { title: `Vol${i} ${stamp}`, markdown: "x" } }).then((r) => r.json())));
  const statuses: number[] = [];
  for (let i = 0; i < many.length; i += 9) await Promise.all(many.slice(i, i + 9).map((n, j) => crew[(i + j) % 3].post("/api/mcp/tools/updateNode", { data: { args: { id: n.id, markdown: `v${i + j}`, base_markdown: "x" } } }).then((r) => statuses.push(r.status()))));
  out.volumeWrites = `ok=${statuses.filter((x) => x === 200).length} limited=${statuses.filter((x) => x === 429).length}`;
  for (const c of crew) await c.dispose();
  const apiCount = (await (await page.request.get("/api/inbox", H)).json()).events.length;
  await ready(page, "/?view=notes");
  await openInbox(page);
  await page.waitForTimeout(2000);
  const chipTexts = await page.locator(".inbox-filter-chip").allInnerTexts();
  const rendered = await page.locator(".inbox-review-item").count();
  out.volume = `apiDefault=${apiCount} chips=${JSON.stringify(chipTexts)} renderedItems=${rendered} loadMore=${await page.getByText(/Load more|Show more|更多/).count()}`;

  // Phone.
  const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const pp = await phone.newPage();
  await ready(pp, "/?view=notes");
  await pp.getByText("‹ Notes").filter({ visible: true }).first().click().catch(() => {});
  await pp.getByRole("button", { name: /^Inbox/ }).filter({ visible: true }).first().click().catch(() => {});
  await pp.waitForTimeout(1500);
  out.phone = `chips=${await pp.locator(".inbox-filter-chip").filter({ visible: true }).count()} items=${await pp.locator(".inbox-review-item").filter({ visible: true }).count()} docWidth=${await pp.evaluate(() => document.documentElement.scrollWidth)}`;
  await pp.screenshot({ path: "/tmp/pw-output/ai05-phone.png" });
  await phone.close(); await ann.dispose(); await bob.dispose();
  console.log(`AUDIT AI-05 ${JSON.stringify(out)}`);
});
