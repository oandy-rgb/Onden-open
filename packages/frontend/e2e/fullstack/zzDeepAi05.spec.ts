// Feature-audit deepening (2026-10-07): AI-05 — the inbox with several agents changing notes,
// empty state, volume beyond the default page, load failure, and phone viewport.
import { test, expect, request as pwRequest, type Page } from "@playwright/test";
import { ready, createAgent, defaultSpaceId, BASE, H } from "./helpers";


async function openInbox(page: Page) {
  // The tab's name carries its count ("Inbox 1 waiting in the inbox"), so match the tab, not the bare word.
  await page.locator(".obsidian-sidebar .sidebar-tab").filter({ hasText: /^(Inbox|收件匣)/ }).filter({ visible: true }).first().click();
}
// An AI role that edits directly: its changes land and come to the inbox for the person to decide (a new agent
// only suggests, 2026-10-30), and it needs a space to reach any note (createAgent adds it to the default one).
async function agent(page: Page, name: string) {
  const made = await createAgent(page.request, name, { access: "write", reviewRule: "apply" });
  return pwRequest.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { origin: BASE, authorization: `Bearer ${made.token}` } });
}

test("AI-05: inbox decisions from several agents, empty, volume, failure and phone", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, string> = {};
  const shared = await defaultSpaceId(page.request); // an agent edits only where it is a member (the default space)
  const waiting = page.locator(".capture-decide");
  const rowFor = (title: string) => page.getByRole("button", { name: `Open “${title}” to decide`, exact: true });

  // Failure on the very first load: the pane says so and offers a retry, instead of looking empty.
  await page.route("**/api/inbox?*", (r) => r.fulfill({ status: 503, body: "{\"error\":\"unavailable\"}" }));
  await page.route("**/api/inbox", (r) => r.fulfill({ status: 503, body: "{\"error\":\"unavailable\"}" }));
  await ready(page, "/?view=notes");
  await openInbox(page);
  await expect(page.getByText("Couldn't load the changes waiting for review.")).toBeVisible({ timeout: 15_000 });
  await page.unroute("**/api/inbox?*"); await page.unroute("**/api/inbox");

  await ready(page, "/?view=notes");
  await openInbox(page);
  await expect(page.getByText("Nothing waiting. What you jot down without a place lands here.")).toBeVisible();
  await expect(waiting).toHaveCount(0);

  // Two agents change six notes: one row per note, each saying whose changes wait there. (A change to a note is
  // decided in that note since 2026-10-30; the filter chips only remain for events that belong to no note.)
  const ann = await agent(page, `Ann ${stamp}`), bob = await agent(page, `Bob ${stamp}`);
  const notes = await Promise.all(Array.from({ length: 6 }, (_, i) => page.request.post("/api/nodes", { ...H, data: { title: `Inb${i} ${stamp}`, markdown: "x", space_id: shared } }).then((r) => r.json())));
  for (const [i, n] of notes.entries()) {
    const res = await (i < 4 ? ann : bob).post("/api/mcp/tools/updateNode", { data: { args: { id: n.id, markdown: `edit ${i}`, base_markdown: "x" } } });
    expect(res.status(), `agent edit ${i}`).toBe(200);
  }
  await ready(page, "/?view=notes");
  await openInbox(page);
  await expect(waiting.getByRole("heading")).toContainText("6", { timeout: 15_000 });
  for (const [i] of notes.entries()) await expect(rowFor(`Inb${i} ${stamp}`)).toBeVisible();
  out.rows = String(await waiting.locator(".capture-decide-row").count());

  // Volume: 135 agent edits by three agents (three agents × 45 edits stays under the 60/min per-token limit).
  const crew = [await agent(page, `C1 ${stamp}`), await agent(page, `C2 ${stamp}`), await agent(page, `C3 ${stamp}`)];
  const many = await Promise.all(Array.from({ length: 135 }, (_, i) => page.request.post("/api/nodes", { ...H, data: { title: `Vol${i} ${stamp}`, markdown: "x", space_id: shared } }).then((r) => r.json())));
  const statuses: number[] = [];
  for (let i = 0; i < many.length; i += 9) await Promise.all(many.slice(i, i + 9).map((n, j) => crew[(i + j) % 3].post("/api/mcp/tools/updateNode", { data: { args: { id: n.id, markdown: `v${i + j}`, base_markdown: "x" } } }).then((r) => statuses.push(r.status()))));
  out.volumeWrites = `ok=${statuses.filter((x) => x === 200).length} limited=${statuses.filter((x) => x === 429).length}`;
  for (const c of crew) await c.dispose();
  await ready(page, "/?view=notes");
  await openInbox(page);
  const shownTotal = Number((await waiting.getByRole("heading").locator(".capture-decide-count").innerText()).trim());
  const shownRows = await waiting.locator(".capture-decide-row").count();
  out.volume = `heading=${shownTotal} rows=${shownRows}`;
  // The queue answers one page of 100 events (GET /api/inbox, limit default 100): with 141 notes waiting the pane
  // shows 100 and says nothing about the other 41. That is today's behaviour, recorded here as the audit's answer
  // to "does it show all, page, or cap silently?" — the heading and the rows at least agree with each other.
  expect(shownTotal, "the heading never claims more than the queue page it was given").toBeLessThanOrEqual(100);
  expect(shownRows, "every counted note has its row").toBe(shownTotal);

  // Phone: the same list in the notes tab, no sideways scroll.
  const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const pp = await phone.newPage();
  await ready(pp, "/?view=notes");
  await pp.locator(".omt-back").click().catch(() => {});
  await pp.locator(".obsidian-sidebar .sidebar-tab").filter({ hasText: /^(Inbox|收件匣)/ }).filter({ visible: true }).first().click();
  await expect(pp.locator(".capture-decide").filter({ visible: true }).locator(".capture-decide-row").first()).toBeVisible({ timeout: 15_000 });
  expect(await pp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scroll on the phone").toBe(true);
  await pp.screenshot({ path: "/tmp/pw-output/ai05-phone.png" });
  await phone.close(); await ann.dispose(); await bob.dispose();
  console.log(`AUDIT AI-05 ${JSON.stringify(out)}`);
});
