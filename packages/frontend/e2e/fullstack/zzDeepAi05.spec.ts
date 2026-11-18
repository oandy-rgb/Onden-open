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

// The inbox is one per workspace and earlier specs leave things in it: agent changes nobody decided and captures nobody
// filed. This spec asserts the empty state and exact counts, so it first settles what is there — accepts the waiting
// agent changes as they are and files the captures (takes the inbox tag off; the notes stay) — instead of assuming
// it runs on a fresh workspace.
async function startFromAnEmptyInbox(page: Page) {
  for (let round = 0; round < 10; round++) {
    const queue = (await (await page.request.get("/api/inbox?limit=500")).json()).events as Array<{ id: string }>;
    if (queue.length === 0) break;
    const res = await page.request.post("/api/inbox/batch", { ...H, data: { decision: "approve", event_ids: queue.map((e) => e.id) } });
    expect(res.ok(), `accept ${queue.length} waiting changes: ${res.status()}`).toBe(true);
  }
  const tags = (await (await page.request.get("/api/tags")).json()) as Array<{ id: string; schema_module?: string | null }> | { tags: Array<{ id: string; schema_module?: string | null }> };
  const inboxTag = (Array.isArray(tags) ? tags : tags.tags).find((tag) => tag.schema_module === "capture");
  if (!inboxTag) return;
  const nodes = (await (await page.request.get("/api/bootstrap?bodies=none", H)).json()).nodes as Array<{ id: string; deleted_at?: string | null; class_tag_ids?: string[]; label_tag_ids?: string[] }>;
  for (const node of nodes.filter((n) => !n.deleted_at && [...(n.class_tag_ids ?? []), ...(n.label_tag_ids ?? [])].includes(inboxTag.id))) {
    const res = await page.request.delete(`/api/nodes/${node.id}/tags/${inboxTag.id}`, H);
    expect(res.ok(), `file capture ${node.id}: ${res.status()}`).toBe(true);
  }
}

test("AI-05: inbox decisions from several agents, empty, volume, failure and phone", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const shared = await defaultSpaceId(page.request); // an agent edits only where it is a member (the default space)
  const waiting = page.locator(".capture-decide");
  const rowFor = (title: string) => page.getByRole("button", { name: `Open “${title}” to decide`, exact: true });

  await startFromAnEmptyInbox(page);

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
  // One row per note (the spec's own header; DecideSection.tsx renders one row per note), not one per change.
  await expect(waiting.locator(".capture-decide-row")).toHaveCount(6);

  // Volume: 135 agent edits by three agents (three agents × 45 edits stays under the 60/min per-token limit).
  const crew = [await agent(page, `C1 ${stamp}`), await agent(page, `C2 ${stamp}`), await agent(page, `C3 ${stamp}`)];
  const many = await Promise.all(Array.from({ length: 135 }, (_, i) => page.request.post("/api/nodes", { ...H, data: { title: `Vol${i} ${stamp}`, markdown: "x", space_id: shared } }).then((r) => r.json())));
  const statuses: number[] = [];
  for (let i = 0; i < many.length; i += 9) await Promise.all(many.slice(i, i + 9).map((n, j) => crew[(i + j) % 3].post("/api/mcp/tools/updateNode", { data: { args: { id: n.id, markdown: `v${i + j}`, base_markdown: "x" } } }).then((r) => statuses.push(r.status()))));
  // Three agents x 45 edits stay under the 60-per-minute-per-token limit (services/agentTools/rateLimit.ts DEFAULT_LIMIT_PER_MINUTE):
  // every edit is accepted, none is rate limited.
  expect(statuses.filter((x) => x === 200), "all 135 agent edits are accepted").toHaveLength(135);
  expect(statuses.filter((x) => x === 429), "none is rate limited").toHaveLength(0);
  for (const c of crew) await c.dispose();
  await ready(page, "/?view=notes");
  await openInbox(page);
  const shownTotal = Number((await waiting.getByRole("heading").locator(".capture-decide-count").innerText()).trim());
  const shownRows = await waiting.locator(".capture-decide-row").count();
  // The queue answers one page of 100 events (routes/inbox.ts: parsePage default 100): with 141 notes waiting the pane
  // shows that page and says nothing about the other 41. The page size is written; whether the pane should say more is not.
  expect(shownTotal, "the heading never claims more than the queue page it was given").toBeLessThanOrEqual(100);
  expect(shownTotal, "the pane shows the first page of 100").toBe(100); // pinned: today's behaviour, no written rule
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
});
