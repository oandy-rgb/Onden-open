import { test, expect } from "@playwright/test";
import { ready, H } from "./helpers";

// JOURNEY [note-view-tabs] — the row of view tabs above a note's title.
//
//   1) a plain note has 「內容」 and 「＋」 only;
//   2) 「＋」 → table adds a tab that shows the sub-notes as a table, full width;
//   3) the tab is in the URL (?tab=), survives a reload, and 內容 is one click back;
//   4) the tab can be renamed and deleted from its menu; the sub-notes stay;
//   5) on a phone the row is one line above the title (since 2026-11-07, #1331), with 44px targets.
const SHOTS = "/tmp/pw-output/shots";

test("note: 內容 and ＋, a table tab in the URL, renamed and deleted", async ({ page }) => {
  const stamp = Date.now();
  const parent = await (await page.request.post("/api/nodes", { ...H, data: { title: `Shelf ${stamp}`, markdown: "" } })).json();
  for (const n of [1, 2]) await page.request.post("/api/nodes", { ...H, data: { title: `Book ${n} ${stamp}`, markdown: "", parent_id: parent.id } });

  await ready(page, `/?view=notes&node=${parent.id}`);
  const tabs = page.getByRole("tablist", { name: new RegExp(`Shelf ${stamp}`) });
  // 「＋」 is a button beside the tab list, not a tab in it (ViewTabs.css): both are in the one .view-tabs row.
  const row = page.locator(".view-tabs").filter({ has: tabs });
  await expect(tabs.getByRole("tab")).toHaveText(["Content"]);
  await expect(row.getByRole("button", { name: "Add a view" })).toBeVisible();
  // The sub-notes under the text have no view menu of their own.
  await expect(page.getByRole("button", { name: "New view" })).toHaveCount(0);

  await row.getByRole("button", { name: "Add a view" }).click();
  await page.getByRole("dialog", { name: "Add a view" }).getByRole("button", { name: "Table", exact: true }).click();
  const table = tabs.getByRole("tab", { name: /^Table/ });
  await expect(table).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/tab=/);
  await expect(page.locator(".cv-table-title", { hasText: `Book 1 ${stamp}` })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/note-view-tabs-table.png` });

  await ready(page, `/?view=notes&node=${parent.id}`);
  await expect(tabs.getByRole("tab", { name: /^Table/ })).toHaveAttribute("aria-selected", "true");

  await tabs.getByRole("tab", { name: "Content" }).click();
  await expect(page).not.toHaveURL(/tab=/);
  await expect(page.locator(".obsidian-title-input").first()).toHaveValue(`Shelf ${stamp}`);

  await tabs.getByRole("tab", { name: /^Table/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const field = page.getByRole("textbox", { name: "View name" });
  await field.fill(`Reading ${stamp}`);
  await field.press("Enter");
  await expect(tabs.getByRole("tab", { name: new RegExp(`Reading ${stamp}`) })).toBeVisible();

  await tabs.getByRole("tab", { name: new RegExp(`Reading ${stamp}`) }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete view" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(tabs.getByRole("tab")).toHaveText(["Content"]);
  // Only the tab went: the sub-notes are still there.
  await expect(page.getByRole("button", { name: `Book 1 ${stamp}` })).toBeVisible();
});

test("phone: the tab row is one scrolling line with 44px targets", async ({ page }) => {
  const stamp = Date.now();
  const parent = await (await page.request.post("/api/nodes", { ...H, data: { title: `Phone ${stamp}`, markdown: "" } })).json();
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page, `/?view=notes&node=${parent.id}`);
  const row = page.locator(".view-tabs");
  await expect(row).toBeVisible();
  const box = await row.evaluate((el) => ({ wrap: getComputedStyle(el).flexWrap, overflowX: getComputedStyle(el).overflowX }));
  expect(box).toEqual({ wrap: "nowrap", overflowX: "auto" });
  // Each target answers a touch over 44px of height: since #1331 the phone's tabs are drawn 40px tall and an
  // invisible ::before grows the hit area 2px above and below (ViewTabs.css .phone-view-tabs). So measure what a
  // touch reaches: scan down the target's middle and keep the span of points that land on it (its ::before included).
  const targets = await row.locator("[role=tab], .view-tab--add").evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const hit: number[] = [];
    for (let y = r.top - 6; y <= r.bottom + 6; y += 0.25) {
      const at = document.elementFromPoint(x, y);
      if (at && (at === el || el.contains(at))) hit.push(y);
    }
    const reach = hit.length ? hit[hit.length - 1]! - hit[0]! + 0.25 : 0;
    return { name: el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "", drawn: Math.round(r.height), reach };
  }));
  expect(targets.length).toBeGreaterThanOrEqual(2); // 內容 and ＋
  for (const target of targets) expect(target.reach, `${target.name}: a 44px touch target (drawn ${target.drawn}px)`).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: `${SHOTS}/note-view-tabs-phone.png` });
});
