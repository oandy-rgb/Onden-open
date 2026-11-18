// Feature-audit deepening (2026-10-07), rewritten 2026-11-17: HIST-02 — the workspace history on a
// phone. The old screen (Events tab with Actor / Event type selects and a Reload button) was
// replaced on 2026-10-24 by 「變更」｜「最近刪除」 (bebfa9d46, 70594a921; docs/architecture/history-api.md),
// so there are no selects to filter by. What it protects now: a person's edit and an agent's edit
// of the same note show on one row that names the agent, a failed load says so and offers
// 「Try again」 (the rows do not come back as stale data under a failed query), and the retry
// brings them back without the page growing sideways.
import { test, expect, request as pwRequest } from "@playwright/test";
import { ready, createAgent, defaultSpaceId, moveToSpace, BASE, H } from "./helpers";

test("HIST-02: phone shows who changed a note; a failed load can be retried", async ({ browser, page: base }) => {
  test.setTimeout(120_000);
  const s = Date.now();
  const title = `H02 ${s}`;
  const n = await (await base.request.post("/api/nodes", { ...H, data: { title, markdown: "x" } })).json();
  await moveToSpace(base.request, n.id, await defaultSpaceId(base.request)); // the agent is a member of the default space only
  await base.request.patch(`/api/nodes/${n.id}`, { ...H, data: { markdown: "y" } });
  const agentName = `H02agent ${s}`;
  const agent = await createAgent(base.request, agentName, { reviewRule: "apply" }); // edits directly, so its edit is history
  const edit = await pwRequest.newContext({ baseURL: BASE }).then((c) => c.post("/api/mcp/tools/updateNode", { headers: agent.headers, data: { args: { id: n.id, markdown: "agent edit", base_markdown: "y" } } }));
  expect(edit.ok(), await edit.text()).toBe(true);

  const ctx = await browser.newContext({ storageState: await base.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE });
  const page = await ctx.newPage();
  // First feed request fails, the retry goes through.
  let failFeed = true;
  await page.route("**/api/history/feed*", (r) => (failFeed ? r.fulfill({ status: 503, contentType: "application/json", body: "{\"error\":\"unavailable\"}" }) : r.continue()));
  await ready(page, "/?view=timeline");
  const rows = page.locator(".wh-note-link", { hasText: title });
  await expect(page.getByText("Couldn't load the history.")).toBeVisible({ timeout: 15_000 });
  await expect(rows).toHaveCount(0);

  failFeed = false;
  await page.getByRole("button", { name: "Try again" }).click();
  // The day shows the note once as a note row; the agent's run is its own card above it.
  const noteRow = page.locator(".wh-note-item .wh-note-link", { hasText: title });
  await expect(noteRow).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByText("Couldn't load the history.")).toHaveCount(0);
  // The person's edits and the agent's edit are one note row for the day that names both writers.
  await expect(noteRow).toContainText(agentName);
  await expect(noteRow).toContainText("You");
  expect(await page.evaluate(() => document.documentElement.scrollWidth), "no sideways scroll on a phone").toBeLessThanOrEqual(390);
  await ctx.close();
});
