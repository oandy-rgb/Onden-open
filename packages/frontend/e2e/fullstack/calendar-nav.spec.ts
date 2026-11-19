import { test, expect } from "@playwright/test";
import { ready, requireAdmin, openSavedViewTab, H } from "./helpers";

// JOURNEY [calendar-nav] — the Calendar layout of a collection view through the
// REAL UI (a class_tag's page shows its saved views as tabs; this view's
// stored layout is Calendar, so date-bearing rows land on a month grid).
//
//   1) a row carrying a date appears on its OWN day cell, and
//   2) the prev / next month chevrons actually move the visible month.
//
// Setup is done via the API (create the class_tag with a `due` date field,
// mint a calendar view that surfaces that field, tag a node + stamp its due
// date), then we DRIVE the rendered calendar: assert the chip lands on the
// right cell, page back a month (chip gone), page forward (chip back).
//
// TZ-robustness: the calendar buckets a row by `dayKey(new Date(Date.parse(v)))`
// in BROWSER-LOCAL time. A bare YYYY-MM-DD parses as UTC midnight and would
// shift a day under a negative-offset runner, so the due value is a LOCAL-noon
// datetime (no Z / offset) — Date.parse reads it as local time, so the day key
// is stable in any timezone. The expected day number is the 15th, always
// genuinely in-month (never a leading/trailing adjacent-month duplicate).
//
// Idempotent against the shared onden_test DB: every fixture title/tag name
// carries a per-test stamp, so exactly one row matches and strict-mode locators
// + "count 0" assertions stay honest under parallel-worker churn.
const SHOTS = "/tmp/pw-output/shots";

// A date in the CURRENT month that is always genuinely in-month (never a
// leading/trailing duplicate from an adjacent month, and never the 1st/last
// which can collide with grid edges). The 15th is safe in every month.
function dueOnThe15thLocalNoon(): { iso: string; expectedDay: number } {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  // Local-noon datetime (no timezone suffix) → parsed as local time, so the
  // day never rolls across a TZ boundary the way bare-date UTC-midnight does.
  return { iso: `${y}-${m}-15T12:00:00`, expectedDay: 15 };
}

test("calendar layout: a dated row lands on its day cell; prev/next month navigates", async ({ page }) => {
  const stamp = Date.now();
  const { iso, expectedDay } = dueOnThe15thLocalNoon();

  // 1) A class_tag (collection class) with a `due` date field. The field name
  //    is named by the view's date_field below.
  const tag = await (await page.request.post("/api/tags/import", {
    ...H,
    data: {
      name: `CalEvents${stamp}`,
      color: "#7a2e33",
      fields: [{ key: "due", type: "date", label: "Due date" }],
    },
  })).json();
  // Importing a class_tag requires the owner/admin (governance gate) — on a
  // stale stack this precondition is missing; skip locally, fail loud in CI.
  requireAdmin(!!tag.id, "tag import failed (needs the owner; reset the stack)");

  // 2) A calendar VIEW for the tag that surfaces `due`. visible_fields must
  //    include `due` for the exec query to hydrate the attribute AND for the
  //    layout to consider it a candidate date field.
  const view = await (await page.request.post(`/api/tags/${tag.id}/views`, {
    ...H,
    data: {
      name: `Calendar ${stamp}`,
      layout: "calendar",
      visible_fields: ["title", "due"],
      // The calendar places rows only by the field the view declares (changes/2026-11-12-calendar-date-field.md);
      // without it the view falls back to updated_at and the row lands on today, not on the 15th.
      layout_config: { date_field: "due" },
    },
  })).json();
  expect(view.id).toBeTruthy();

  // 3) A node tagged with the class, with its `due` attribute stamped to the
  //    15th of the current month — this is the row that must land on the grid.
  const eventTitle = `Launch ${stamp}`;
  const node = await (await page.request.post("/api/nodes", {
    ...H, data: { title: eventTitle, markdown: "" },
  })).json();
  const tagApplied = await page.request.put(`/api/nodes/${node.id}/tags/${tag.id}`, { ...H });
  expect(tagApplied.ok()).toBeTruthy();
  const attrSet = await page.request.put(`/api/nodes/${node.id}/attributes/due`, {
    ...H, data: { value: iso, value_type: "date" },
  });
  expect(attrSet.ok()).toBeTruthy();

  // Server truth: the calendar view's exec already places this row by `due`.
  const exec = await (await page.request.get(`/api/tags/${tag.id}/views/${view.id}/exec`)).json();
  const execRow = (exec.rows as Array<{ title: string; attributes: Record<string, string> }>)
    .find((r) => r.title === eventTitle);
  expect(execRow, "the tagged+dated node should appear in the calendar view exec").toBeTruthy();
  expect(execRow!.attributes.due).toContain("-15T"); // the due field hydrated

  // 4) DRIVE the UI: the tag's page lists its saved views as tabs; the
  //    view's stored layout is calendar, so its tab renders the month grid.
  await ready(page, `/?view=notes&node=${tag.id}`);
  await openSavedViewTab(page, new RegExp(`Calendar ${stamp}`));

  const cal = page.locator(".cv-cal");
  await expect(cal).toBeVisible(); // calendar layout mounted (not table/list)
  await expect(cal.locator(".cv-cal-grid")).toBeVisible();

  // The chip for our event is present...
  const chip = cal.locator(".cv-cal-chip", { hasText: eventTitle });
  await expect(chip).toBeVisible();

  // ...and it sits inside the cell whose day number is the 15th. (The chip is
  // in the current month, so the only matching cell is the in-month 15th.)
  const cell = cal.locator(".cv-cal-cell", { has: page.locator(".cv-cal-chip", { hasText: eventTitle }) });
  await expect(cell.locator(".cv-cal-daynum")).toHaveText(String(expectedDay));
  // And it is an in-month cell (the placement month is "now"), never a faded
  // adjacent-month duplicate.
  await expect(cell).not.toHaveClass(/cv-cal-cell--out/);
  await page.screenshot({ path: `${SHOTS}/calendar-nav-placed.png`, fullPage: false });

  // Capture the current month label so navigation can be asserted by change,
  // not by hard-coding a month name (robust across whatever "now" is).
  const titleLoc = cal.locator(".cv-cal-title");
  const monthNow = (await titleLoc.textContent())?.trim();
  expect(monthNow).toBeTruthy();

  // 5) PREV month → the label changes AND the chip leaves the grid (its date
  //    is in the current month, not the previous one).
  await cal.locator(".cv-cal-navbtn[aria-label='Previous month']").click();
  await expect(titleLoc).not.toHaveText(monthNow!);
  await expect(cal.locator(".cv-cal-chip", { hasText: eventTitle })).toHaveCount(0);

  // 6) NEXT month → back to the current month: label restored AND the chip
  //    returns to its (still in-month) day cell.
  await cal.locator(".cv-cal-navbtn[aria-label='Next month']").click();
  await expect(titleLoc).toHaveText(monthNow!);
  const chipBack = cal.locator(".cv-cal-chip", { hasText: eventTitle });
  await expect(chipBack).toBeVisible();
  await expect(cal.locator(".cv-cal-cell", { has: page.locator(".cv-cal-chip", { hasText: eventTitle }) }).locator(".cv-cal-daynum"))
    .toHaveText(String(expectedDay));

  // 7) NEXT again leaves the current month → chip gone (symmetry check: the
  //    grid really is month-scoped, not showing all rows everywhere).
  await cal.locator(".cv-cal-navbtn[aria-label='Next month']").click();
  await expect(titleLoc).not.toHaveText(monthNow!);
  await expect(cal.locator(".cv-cal-chip", { hasText: eventTitle })).toHaveCount(0);

  // 8) The "Today" button jumps straight back to the placement month.
  await cal.locator(".cv-cal-today").click();
  await expect(titleLoc).toHaveText(monthNow!);
  await expect(cal.locator(".cv-cal-chip", { hasText: eventTitle })).toBeVisible();
});
