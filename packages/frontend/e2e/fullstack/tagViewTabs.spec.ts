import { test, expect } from "@playwright/test";
import { ready, requireAdmin, openSavedViewTab, H } from "./helpers";

// JOURNEY [tag-view-tabs] — the tag page's view tabs, the row above its title (docs/architecture/views-as-modules.md, V1).
//
//   1) the tag page opens on its first tab 「列表」 (List): its members, with no saved view needed;
//   2) a saved view is a tab after it; opening it runs the view (a calendar);
//   3) the open tab survives a reload;
//   4) 「＋」 adds a tab, which can be renamed and deleted from its menu,
//      falling back to 「列表」.
const SHOTS = "/tmp/pw-output/shots";

test("tag page: 「內容」 first, saved views as tabs, remembered, renamed and deleted", async ({ page }) => {
  const stamp = Date.now();
  const tag = await (await page.request.post("/api/tags/import", {
    ...H, data: { name: `Books${stamp}`, color: "#2e5a7a", fields: [{ key: "finished", type: "date", label: "Finished" }] },
  })).json();
  requireAdmin(!!tag.id, "tag import failed (needs the owner; reset the stack)");

  const view = await (await page.request.post(`/api/tags/${tag.id}/views`, {
    ...H, data: { name: `Reading ${stamp}`, layout: "calendar", visible_fields: ["title", "finished"] },
  })).json();
  expect(view.id).toBeTruthy();

  const title = `Dune ${stamp}`;
  const node = await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: "" } })).json();
  expect((await page.request.put(`/api/nodes/${node.id}/tags/${tag.id}`, { ...H })).ok()).toBeTruthy();
  const now = new Date();
  const finished = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-15`;
  expect((await page.request.put(`/api/nodes/${node.id}/attributes/finished`, {
    ...H, data: { value: finished, value_type: "date" },
  })).ok()).toBeTruthy();

  await ready(page, `/?view=notes&node=${tag.id}`);
  const tabs = page.getByRole("tablist", { name: new RegExp(`Books${stamp}`) });

  // 1) The first tab is open: the members table, no saved view involved. A tag has no 「內容」: its first
  //    tab is 「列表」 (List), the list of its tagged notes (viewTabs/useAddView useOwnerTabs).
  await expect(tabs.getByRole("tab").first()).toHaveText("List");
  await expect(tabs.getByRole("tab", { name: "List" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".tag-member-table")).toContainText(title);
  await expect(page.locator(".cv-cal")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/tag-view-tabs-all.png` });

  // 2) The saved view is the next tab; it runs as a calendar.
  await tabs.getByRole("tab", { name: new RegExp(`Reading ${stamp}`) }).click();
  await expect(page.locator(".cv-cal-chip", { hasText: title })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/tag-view-tabs-calendar.png` });

  // 3) Remembered across a reload.
  await ready(page, `/?view=notes&node=${tag.id}`);
  await expect(tabs.getByRole("tab", { name: new RegExp(`Reading ${stamp}`) })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".cv-cal-chip", { hasText: title })).toBeVisible();

  // 4) Add a tab, rename it, delete it.
  // 「＋」 lists the layouts; a table is added at once.
  await page.getByRole("button", { name: "Add a view" }).click();
  await page.getByRole("dialog", { name: "Add a view" }).getByRole("button", { name: "Table", exact: true }).click();
  const added = tabs.getByRole("tab", { name: /^Table/ });
  await expect(added).toHaveAttribute("aria-selected", "true");
  await added.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const nameField = page.getByRole("textbox", { name: "View name" });
  await nameField.fill(`Five stars ${stamp}`);
  await nameField.press("Enter");
  await expect(tabs.getByRole("tab", { name: new RegExp(`Five stars ${stamp}`) })).toBeVisible();

  await tabs.getByRole("tab", { name: new RegExp(`Five stars ${stamp}`) }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete view" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(tabs.getByRole("tab", { name: new RegExp(`Five stars ${stamp}`) })).toHaveCount(0);
  await expect(tabs.getByRole("tab", { name: "List" })).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: `${SHOTS}/tag-view-tabs-after-delete.png` });
});

// V2 (view modules): 「＋」 adds a calendar by the date field picked;
// the calendar module cannot be removed (view modules are always on), so the view stays.
test("tag page: a calendar added from 「＋」 uses the date field picked; the module cannot be removed", async ({ page }) => {
  const stamp = Date.now();
  const tag = await (await page.request.post("/api/tags/import", {
    ...H, data: { name: `Exams${stamp}`, color: "#2e5a7a", fields: [{ key: "exam", type: "date", label: "Exam day" }] },
  })).json();
  requireAdmin(!!tag.id, "tag import failed (needs the owner; reset the stack)");
  const title = `Algebra ${stamp}`;
  const node = await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: "" } })).json();
  expect((await page.request.put(`/api/nodes/${node.id}/tags/${tag.id}`, { ...H })).ok()).toBeTruthy();
  const now = new Date();
  const exam = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-15`;
  expect((await page.request.put(`/api/nodes/${node.id}/attributes/exam`, { ...H, data: { value: exam, value_type: "date" } })).ok()).toBeTruthy();
  const setCalendar = (imported: boolean) => page.request.patch("/api/workspace/modules", { ...H, data: { module: "calendar", imported } });

  try {
    await ready(page, `/?view=notes&node=${tag.id}`);
    // "exam" has no date-like name: the old guess would have used updated_at.
    await page.getByRole("button", { name: "Add a view" }).click();
    const panel = page.getByRole("dialog", { name: "Add a view" });
    // The calendar is made at once with the tag's date field (no question first, #1848): the note lands on the 15th, the
    // day in "exam", not today's updated_at.
    await panel.getByRole("button", { name: "Calendar", exact: true }).click();
    const cell = page.locator(".cv-cal-cell", { has: page.locator(".cv-cal-chip", { hasText: title }) });
    await expect(cell.locator(".cv-cal-daynum")).toHaveText("15");
    await page.screenshot({ path: `${SHOTS}/view-modules-calendar.png` });

    // View modules (table, calendar, board, gallery) carry no data of their own, so they are always on
    // (2026-10-28): the owner cannot remove the calendar, and the view stays.
    const removal = await setCalendar(false);
    expect(removal.status(), "the calendar module cannot be turned off").toBe(400);
    await ready(page, `/?view=notes&node=${tag.id}`);
    await expect(page.locator(".cv-cal-chip", { hasText: title })).toBeVisible();
    await expect(page.getByText(/“Calendar” is not imported/)).toHaveCount(0);
  } finally {
    await setCalendar(true);
  }
});

// V3: 「+N more」 opens the day; the month is remembered across a reload; a
// change made elsewhere moves the note without a reload (GAP-158); a long
// title does not widen the grid on a phone.
test("tag page calendar: more opens the day, month remembered, live move, phone fits", async ({ page }) => {
  const stamp = Date.now();
  const tag = await (await page.request.post("/api/tags/import", {
    ...H, data: { name: `Deadlines${stamp}`, color: "#2e5a7a", fields: [{ key: "due", type: "date", label: "Due" }] },
  })).json();
  requireAdmin(!!tag.id, "tag import failed (needs the owner; reset the stack)");
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const view = await (await page.request.post(`/api/tags/${tag.id}/views`, {
    ...H, data: { name: `Due ${stamp}`, layout: "calendar", visible_fields: ["title", "due"], layout_config: { date_field: "due" } },
  })).json();
  const ids: string[] = [];
  for (const n of [1, 2, 3, 4, 5]) {
    const title = n === 5 ? `A very long deadline title that should never widen its day column ${stamp}` : `Due ${n} ${stamp}`;
    const node = await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: "" } })).json();
    await page.request.put(`/api/nodes/${node.id}/tags/${tag.id}`, { ...H });
    await page.request.put(`/api/nodes/${node.id}/attributes/due`, { ...H, data: { value: `${ym}-15`, value_type: "date" } });
    ids.push(node.id);
  }

  await ready(page, `/?view=notes&node=${tag.id}`);
  await openSavedViewTab(page, new RegExp(`Due ${stamp}`));
  const day15 = page.locator(".cv-cal-cell:not(.cv-cal-cell--out)", { has: page.locator(".cv-cal-daynum", { hasText: /^15$/ }) });
  await expect(day15.locator(".cv-cal-chip")).toHaveCount(3);
  await day15.getByRole("button", { name: "+2 more" }).click();
  await expect(day15.locator(".cv-cal-chip")).toHaveCount(5);

  // Someone else moves note 1 to the 20th: it moves without a reload.
  await page.request.put(`/api/nodes/${ids[0]}/attributes/due`, { ...H, data: { value: `${ym}-20`, value_type: "date" } });
  const day20 = page.locator(".cv-cal-cell:not(.cv-cal-cell--out)", { has: page.locator(".cv-cal-daynum", { hasText: /^20$/ }) });
  await expect(day20.locator(".cv-cal-chip", { hasText: `Due 1 ${stamp}` })).toBeVisible({ timeout: 10_000 });

  // The month moved to is remembered across a reload.
  const title = page.locator(".cv-cal-title");
  const thisMonth = await title.innerText();
  await page.getByLabel("Next month").click();
  const nextMonth = await title.innerText();
  expect(nextMonth).not.toBe(thisMonth);
  await ready(page, `/?view=notes&node=${tag.id}`);
  await expect(title).toHaveText(nextMonth);
  await page.locator(".cv-cal").getByRole("button", { name: "Today", exact: true }).click();
  await expect(title).toHaveText(thisMonth);

  // Phone: the grid stays within the screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page, `/?view=notes&node=${tag.id}`);
  await expect(page.locator(".cv-cal-grid")).toBeVisible();
  const widths = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, grid: document.querySelector(".cv-cal-grid")!.scrollWidth, box: document.querySelector(".cv-cal-grid")!.clientWidth }));
  expect(widths.doc).toBeLessThanOrEqual(391);
  expect(widths.grid).toBeLessThanOrEqual(widths.box + 1);
  await page.screenshot({ path: `${SHOTS}/calendar-v3-phone.png` });
  expect(view.id).toBeTruthy();
});
