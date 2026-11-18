// Feature-audit deepening (2026-10-07): COL-06 — the saved-view Calendar:
// a real date change reaching an open calendar, year boundary navigation,
// rows without a date, crowded days ("+N more"), a date field whose name does
// not hint at a date, a negative-UTC timezone, reopening, and phone viewport.
//
// 2026-11-18: every observation the probe printed is a check now (owner's order 「都改成檢查」). The rules: CalendarLayout.tsx and
// calendarGrid.ts (the view's own `date_field`, a date-only value names its own day in any browser time zone — GAP-156, a day with more than
// three rows opens in place — GAP-157, the month is remembered per view on this device — V3), full-feature-audit.md COL-06. The probe
// assumed the calendar opens on the current month every time; since V3 it opens on the month this device last left it on, so the
// steps that depended on that now press 「Today」 first.
import { test, expect, type Page } from "@playwright/test";
import { ready, openSavedViewTab, BASE, H } from "./helpers";
import { contextsClosedAfterEach, clickableSize, readyLive } from "./viewChecks";

// Every extra browser context a test opens is closed when the test ends, also when it stops at a failing line (see viewChecks.ts).
const newContext = contextsClosedAfterEach(test);

const monthName = (year: number, monthIndex: number) =>
  new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, monthIndex, 1)));

async function setUp(page: Page) {
  const stamp = Date.now();
  // Dates are relative to today (the workspace's day: this stack's browser and server both run UTC), because the calendar opens on
  // the current month; fixed October 2026 dates only landed on it while it was October. The year boundary is the coming
  // 31 Dec / 1 Jan, however many months away.
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based
  const ym = `${year}-${String(month + 1).padStart(2, "0")}`;
  const monthsToDec = 11 - month;
  const tag = await (await page.request.post("/api/tags/import", { ...H, data: { name: `C06T${stamp}`, fields: [
    { name: "due", type: "date" },
    { name: "exam", type: "date" },
  ] } })).json();
  const mk = async (title: string, due?: string, exam?: string) => {
    const n = await (await page.request.post("/api/nodes", { ...H, data: { title, markdown: "x" } })).json();
    await page.request.put(`/api/nodes/${n.id}/tags/${tag.id}`, { ...H, data: {} });
    if (due) expect((await page.request.put(`/api/nodes/${n.id}/attributes/due`, { ...H, data: { value: due, value_type: "date" } })).status()).toBe(200);
    if (exam) await page.request.put(`/api/nodes/${n.id}/attributes/exam`, { ...H, data: { value: exam, value_type: "date" } });
    return n.id as string;
  };
  const idMid = await mk(`Mid15 ${stamp}`, `${ym}-15`, `${ym}-20`);
  await mk(`Dec31 ${stamp}`, `${year}-12-31`);
  await mk(`Jan01 ${stamp}`, `${year + 1}-01-01`);
  await mk(`Undated ${stamp}`);
  for (let i = 1; i <= 5; i++) await mk(`Crowd${i} ${stamp}`, `${ym}-22`);
  const view = await (await page.request.post(`/api/tags/${tag.id}/views`, { ...H, data: { name: "Cal", layout: "calendar", visible_fields: ["title", "due"], layout_config: { date_field: "due" } } })).json();
  const vPath = `/api/tags/${tag.id}/views/${view.id}`;

  const openCal = async (p: Page) => {
    await readyLive(p, `/?view=notes&node=${tag.id}`);
    await openSavedViewTab(p);
    await expect(p.locator(".cv-cal")).toBeVisible({ timeout: 15_000 }); // the grid is drawn once the view's rows have arrived
  };
  // Map of in-month day -> chip titles (first word; a crowded day also lists its 「+N more」 / 「Show less」 control).
  const grid = async (p: Page) => p.evaluate(() => {
    const res: Record<string, string[]> = {};
    for (const c of Array.from(document.querySelectorAll(".cv-cal-cell"))) {
      if (c.classList.contains("cv-cal-cell--out")) continue;
      const chips = Array.from(c.querySelectorAll(".cv-cal-chip")).map((b) => (b as HTMLElement).innerText.split(" ")[0]);
      const more = (c.querySelector(".cv-cal-more") as HTMLElement | null)?.innerText;
      if (chips.length || more) res[(c.querySelector(".cv-cal-daynum") as HTMLElement).innerText] = more ? [...chips, more] : chips;
    }
    return res;
  });
  const title = (p: Page) => p.locator(".cv-cal-title");
  const step = async (p: Page, label: "Next month" | "Previous month", n = 1) => { for (let i = 0; i < n; i++) await p.getByRole("button", { name: label }).click(); };
  const today = (p: Page) => p.locator(".cv-cal-today").click(); // the topbar has a 「Today」 of its own
  return { stamp, year, month, ym, monthsToDec, tag, idMid, vPath, openCal, grid, title, step, today };
}

test.describe("COL-06: saved-view calendar", () => {
  test.setTimeout(240_000);

  test("date change, year boundary, undated, crowded day, no-hint field, reopen, timezone, phone", async ({ page, browser }) => {
    const { stamp, year, month, ym, monthsToDec, tag, idMid, vPath, openCal, grid, title, step, today } = await setUp(page);
    await openCal(page);

    // The calendar opens on the workspace's current month (CalendarLayout.tsx: 「Open on the workspace's current month」), says which field
    // places the rows, and shows each row on its day.
    expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe("UTC");
    await expect(title(page)).toHaveText(monthName(year, month));
    await expect(page.locator(".cv-cal-field")).toHaveText("due");
    // A day with more than three rows shows three and 「+N more」 (MAX_CHIPS_PER_DAY; COL-06: 「5 筆顯示 3 筆＋『+2 more』」).
    expect(await grid(page)).toEqual({ "15": ["Mid15"], "22": ["Crowd1", "Crowd2", "Crowd3", "+2 more"] });
    // Rows with no date are counted, not hidden silently (COL-06: 「1 of 9 rows have no “due” date」).
    await expect(page.locator(".cv-cal-note")).toHaveText("1 of 9 rows have no “due” date and aren’t shown on the grid.");
    // 「+N more」 is a real button (GAP-157, fixed 2026-10-18) and opens the whole day in place.
    const more = page.locator(".cv-cal-more").first();
    expect(await more.evaluate((e) => e.tagName)).toBe("BUTTON");
    await more.click();
    expect((await grid(page))["22"]).toEqual(["Crowd1", "Crowd2", "Crowd3", "Crowd4", "Crowd5", "Show less"]);

    // Year boundary: this month → December → January → 「Today」 brings back the current month.
    await step(page, "Next month", monthsToDec);
    await expect(title(page)).toHaveText(monthName(year, 11));
    expect(await grid(page)).toEqual({ "31": ["Dec31"] });
    await step(page, "Next month");
    await expect(title(page)).toHaveText(monthName(year + 1, 0));
    expect(await grid(page)).toEqual({ "1": ["Jan01"] });
    await today(page);
    await expect(title(page)).toHaveText(monthName(year, month));

    // Real date change while the calendar is open (another client changes due): the open calendar follows without a reload
    // (GAP-158, fixed 2026-10-18: an open view reruns on the sync event).
    await page.request.put(`/api/nodes/${idMid}/attributes/due`, { ...H, data: { value: `${ym}-03`, value_type: "date" } });
    await expect.poll(async () => (await grid(page))["3"] ?? [], { timeout: 20_000 }).toEqual(["Mid15"]);
    expect((await grid(page))["15"]).toBeUndefined();
    // Change it in the UI: the Table layout of the same view, edit the due cell. The layout is switched in the view's 「View options」 menu
    // (a checked item per layout), not by toolbar buttons.
    const layout = async (name: "Table" | "Calendar") => {
      await page.getByRole("button", { name: "View options", exact: true }).click();
      await page.getByRole("menuitemradio", { name, exact: true }).click();
      // A layout that is placed by a field asks for it (the dialog's 「Change layout」); the calendar goes back to its date field.
      if (name === "Calendar") {
        const form = page.locator(".cv-add-view-form");
        await form.getByRole("combobox").selectOption("due");
        await form.getByRole("button", { name: "Change layout", exact: true }).click();
      }
    };
    await layout("Table");
    await expect(page.locator(".cv-table")).toBeVisible();
    await page.locator(".cv-table tr", { hasText: `Mid15 ${stamp}` }).locator("td").nth(1).locator("button").click();
    const inp = page.locator(".cv-table input").first();
    // pinned: today's behaviour, no written rule — the table edits a date in a plain text input, as it does every field type.
    expect(await inp.evaluate((el) => `${el.tagName} ${(el as HTMLInputElement).type}`)).toBe("INPUT text"); // pinned: today's behaviour, no written rule
    await inp.fill(`${ym}-09`);
    await inp.press("Enter");
    await expect.poll(async () => ((await (await page.request.get(`/api/nodes/${idMid}/attributes`)).json()) as Array<{ key: string; value: string }>).find((a) => a.key === "due")?.value).toBe(`${ym}-09`);
    await layout("Calendar");
    await expect(page.locator(".cv-cal")).toBeVisible();
    await expect.poll(async () => (await grid(page))["9"] ?? []).toEqual(["Mid15"]);
    expect((await grid(page))["3"]).toBeUndefined();
    // Click a chip → opens that note.
    await page.locator(".cv-cal-chip", { hasText: `Mid15 ${stamp}` }).click();
    await expect(page).toHaveURL(new RegExp(`node=${idMid}`));

    // Reopen: the month a view was left on is remembered per view on this device (CalendarLayout.tsx, V3), so after moving two months on and
    // reloading, the calendar opens there — not on the current month the probe expected.
    await openCal(page);
    await step(page, "Next month", 2);
    const twoOn = monthName(...((m) => [year + Math.floor(m / 12), m % 12] as [number, number])(month + 2));
    await expect(title(page)).toHaveText(twoOn);
    await openCal(page);
    await expect(title(page)).toHaveText(twoOn);

    // A date-typed field whose name has no date hint ("exam"): the view's own `date_field` decides, a name is never guessed at
    // (calendarGrid.ts calendarDateField; GAP-157, fixed 2026-10-18). Back on the current month, Mid15's exam date is on the 20th.
    expect((await page.request.patch(vPath, { ...H, data: { layout_config: { date_field: "exam" } } })).status()).toBe(200);
    await openCal(page);
    await expect(page.locator(".cv-cal-field")).toHaveText("exam");
    await today(page);
    await expect.poll(() => grid(page)).toEqual({ "20": ["Mid15"] });
    expect((await page.request.patch(vPath, { ...H, data: { layout_config: { date_field: "due" } } })).status()).toBe(200);

    // Negative-UTC browser time zone: a date-only value names its own day, whatever the browser's zone (calendarGrid.ts bucketRowsByDay;
    // GAP-156, fixed). The probe saw every date a day early in Los Angeles; none of that is left: 31 Dec stays 31 Dec and 1 Jan stays 1 Jan.
    const la = await newContext(browser, { storageState: await page.context().storageState(), baseURL: BASE, timezoneId: "America/Los_Angeles" });
    const lp = await la.newPage();
    await lp.addInitScript(() => localStorage.setItem("onden.welcomeDismissed", "1"));
    await openCal(lp);
    expect(await lp.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe("America/Los_Angeles");
    await today(lp);
    await expect(title(lp)).toHaveText(monthName(year, month)); // the workspace's current month, not the browser's
    await expect.poll(() => grid(lp)).toEqual({ "9": ["Mid15"], "22": ["Crowd1", "Crowd2", "Crowd3", "+2 more"] });
    await step(lp, "Next month", monthsToDec);
    await expect(title(lp)).toHaveText(monthName(year, 11));
    expect(await grid(lp)).toEqual({ "31": ["Dec31"] });
    await step(lp, "Next month");
    await expect(title(lp)).toHaveText(monthName(year + 1, 0));
    expect(await grid(lp)).toEqual({ "1": ["Jan01"] });
    await step(lp, "Previous month");
    expect(await grid(lp)).toEqual({ "31": ["Dec31"] });
    await la.close();

    // Phone: the page does not get wider and the grid fits its container (GAP-157, fixed: `minmax(0, 1fr)`, 390px 不撐寬);
    // a chip opens its note by touch.
    const phone = await newContext(browser, { storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE, hasTouch: true, isMobile: true });
    const pp = await phone.newPage();
    await openCal(pp);
    expect(await pp.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const geo = await pp.locator(".cv-cal-grid").evaluate((g) => ({ w: Math.round(g.getBoundingClientRect().width), scroll: g.scrollWidth }));
    expect(geo.scroll).toBeLessThanOrEqual(geo.w + 1);
    expect(geo.w).toBeLessThanOrEqual(390);
    await pp.locator(".cv-cal-today").click();
    const chip = pp.locator(".cv-cal-chip").first();
    await chip.scrollIntoViewIfNeeded();
    await chip.tap();
    await expect(pp).toHaveURL(/node=/);
    await phone.close();
    void tag;
  });

  // FINDING: layout-audit R7 / `--ac-tap` (44px) on a phone. What the app does instead: the month buttons are 26×26 and a day's chip is 21px
  // high (the probe's navBtn and chip), and nothing widens either target.
  test("FINDING: the calendar's month buttons are 44px targets on a phone", async ({ page, browser }) => {
    test.fail();
    const { openCal } = await setUp(page);
    const phone = await newContext(browser, { storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE, hasTouch: true, isMobile: true });
    const pp = await phone.newPage();
    await openCal(pp);
    const size = await clickableSize(pp.locator(".cv-cal-navbtn").first());
    expect(Math.min(size.w, size.h)).toBeGreaterThanOrEqual(44);
    await phone.close();
  });

  test("FINDING: a calendar chip is a 44px target on a phone", async ({ page, browser }) => {
    test.fail();
    const { openCal } = await setUp(page);
    const phone = await newContext(browser, { storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE, hasTouch: true, isMobile: true });
    const pp = await phone.newPage();
    await openCal(pp);
    expect((await clickableSize(pp.locator(".cv-cal-chip").first())).h).toBeGreaterThanOrEqual(44);
    await phone.close();
  });
});
