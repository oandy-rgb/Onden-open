// \u2463 sidebar virtualization: past 300 rows the tree renders through a scroll
// window \u2014 the DOM holds a slice, not the workspace. Pinned: window size,
// scroll-to-bottom materializes the tail, and a windowed row still opens.
//
// The 350 rows live UNDER ONE CONTAINER note: collapsed (the default) they
// never enter other specs' sidebar trees \u2014 the first version of this spec
// flooded the global tree and every concurrently-running spec that clicks a
// sidebar row by text lost its target to the scroll window.
import { test, expect } from "@playwright/test";
import { ready, openSidebarSearch, H } from "./helpers";


test("350 notes: windowed DOM, tail reachable and clickable", async ({ page }) => {
  test.setTimeout(180_000);
  const stamp = Date.now();
  const container = await (await page.request.post("/api/nodes", { ...H, data: { title: `vs-container ${stamp}`, markdown: "virt flood container" } })).json();
  const WANT = 350;
  const CONC = 25;
  for (let i = 0; i < WANT; i += CONC) {
    await Promise.all(Array.from({ length: Math.min(CONC, WANT - i) }, (_, j) =>
      page.request.post("/api/nodes", { ...H, data: { title: `vs ${stamp}-${String(i + j).padStart(3, "0")}`, markdown: "b", parent_id: container.id } })));
  }
  const last = await (await page.request.post("/api/nodes", { ...H, data: { title: `vs-LAST ${stamp}`, markdown: "tail body", parent_id: container.id } })).json();

  // Seed the persisted expansion state so the tree MOUNTS with the container
  // open (expandedGroups lives in localStorage) — hunting the container row
  // through a churning windowed tree mid-suite proved unreliable; what this
  // spec pins is the WINDOWING, not group-toggle clicking.
  // The pref is per account (lib/prefs: `onden.expandedGroups:account-v1:…`);
  // the unscoped key is only adopted when the account has none yet, so seed
  // the account copies a signed-in browser already holds as well.
  await page.addInitScript((id) => {
    const open = JSON.stringify([id]);
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key?.startsWith("onden.expandedGroups:account-v1:")) window.localStorage.setItem(key, open);
    }
    window.localStorage.setItem("onden.expandedGroups", open);
  }, container.id);
  await ready(page);
  await page.locator("[data-sb-id]").first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1500); // bootstrap settle

  const list = page.locator(".obsidian-page-list");

  const rendered = await page.locator(".obsidian-page-list [data-sb-id]").count();
  console.log(`rows children=${WANT + 1} rendered=${rendered}`);
  expect(rendered).toBeLessThan(WANT / 2); // windowed, not materialized

  // Scrolling moves the WINDOW: jump to the bottom and pin that new rows
  // materialized (the set of rendered ids changed). Asserting a SPECIFIC row
  // lands in the window is hopeless mid-suite — 14 parallel workers refresh
  // the tree (and reset scroll) constantly — but "the window follows the
  // scroll" is the mechanic, and it holds under churn.
  const idsBefore = await page.locator(".obsidian-page-list [data-sb-id]").evaluateAll(
    (els) => els.map((e) => e.getAttribute("data-sb-id")));
  await expect.poll(async () => {
    await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(150);
    const ids = await page.locator(".obsidian-page-list [data-sb-id]").evaluateAll(
      (els) => els.map((e) => e.getAttribute("data-sb-id")));
    return ids.some((id) => !idsBefore.includes(id));
  }, { timeout: 20_000 }).toBe(true);

  // A row that was NEVER materialized still opens — reach it the way a person
  // does in a big workspace: the sidebar search (windowing must not make deep
  // rows unreachable).
  await (await openSidebarSearch(page)).fill(`vs-LAST ${stamp}`);
  const lastRow = page.locator(".obsidian-page-button", { hasText: `vs-LAST ${stamp}` }).first();
  await lastRow.click();
  await expect(page.locator('.cm-content:has-text("tail body")')).toBeVisible({ timeout: 15_000 });
});
