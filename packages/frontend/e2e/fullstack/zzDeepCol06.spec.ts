// Feature-audit deepening (2026-10-07): COL-06 — the saved-view Calendar:
// a real date change reaching an open calendar, year boundary navigation,
// rows without a date, crowded days ("+N more"), a date field whose name does
// not hint at a date, a negative-UTC timezone, reopening, and phone viewport.
import { test, expect, type Page } from "@playwright/test";
import { ready, openSavedViewTab, BASE, H } from "./helpers";


test("COL-06: calendar date change, year boundary, undated, crowded day, timezone, reopen, phone", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, string> = {};
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
    if (due) out[`put_${title.split(" ")[0]}`] = String((await page.request.put(`/api/nodes/${n.id}/attributes/due`, { ...H, data: { value: due, value_type: "date" } })).status());
    if (exam) await page.request.put(`/api/nodes/${n.id}/attributes/exam`, { ...H, data: { value: exam, value_type: "date" } });
    return n.id as string;
  };
  const idOct = await mk(`Mid15 ${stamp}`, `${ym}-15`, `${ym}-20`);
  await mk(`Dec31 ${stamp}`, `${year}-12-31`);
  await mk(`Jan01 ${stamp}`, `${year + 1}-01-01`);
  await mk(`Undated ${stamp}`);
  for (let i = 1; i <= 5; i++) await mk(`Crowd${i} ${stamp}`, `${ym}-22`);
  const view = await (await page.request.post(`/api/tags/${tag.id}/views`, { ...H, data: { name: "Cal", layout: "calendar", visible_fields: ["title", "due"], layout_config: { date_field: "due" } } })).json();
  const vPath = `/api/tags/${tag.id}/views/${view.id}`;

  const openCal = async (p: Page) => {
    await ready(p, `/?view=notes&node=${tag.id}`);
    await openSavedViewTab(p);
    await expect(p.locator(".cv-cal")).toBeVisible({ timeout: 15_000 });
    await p.waitForTimeout(600);
  };
  // Map of in-month day -> chip titles (first word).
  const grid = async (p: Page) => p.evaluate(() => {
    const res: Record<string, string[] | string> = {};
    res._title = (document.querySelector(".cv-cal-title") as HTMLElement)?.innerText ?? "";
    for (const c of Array.from(document.querySelectorAll(".cv-cal-cell"))) {
      if (c.classList.contains("cv-cal-cell--out")) continue;
      const chips = Array.from(c.querySelectorAll(".cv-cal-chip")).map((b) => (b as HTMLElement).innerText.split(" ")[0]);
      const more = (c.querySelector(".cv-cal-more") as HTMLElement | null)?.innerText;
      if (chips.length || more) res[(c.querySelector(".cv-cal-daynum") as HTMLElement).innerText] = more ? [...chips, more] : chips;
    }
    return res;
  });
  const step = async (p: Page, label: "Next month" | "Previous month", n = 1) => { for (let i = 0; i < n; i++) await p.getByRole("button", { name: label }).click(); };

  try {
    await openCal(page);
    out.tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    out.field = await page.locator(".cv-cal-field").innerText();
    out.october = JSON.stringify(await grid(page));
    out.undatedNote = JSON.stringify(await page.locator(".cv-cal-note").innerText().catch(() => ""));
    // Crowded day: is the "+N more" reachable?
    const more = page.locator(".cv-cal-more").first();
    out.moreTag = await more.evaluate((e) => `${e.tagName} role=${e.getAttribute("role")} tabindex=${e.getAttribute("tabindex")}`).catch(() => "none");
    await more.click().catch(() => null);
    await page.waitForTimeout(400);
    out.moreClickShowsAll = String((await page.locator(".cv-cal-chip", { hasText: /^Crowd/ }).count()) >= 5);

    // Year boundary: this month → December → January → back.
    await step(page, "Next month", monthsToDec);
    out.dec = JSON.stringify(await grid(page));
    await step(page, "Next month");
    out.jan = JSON.stringify(await grid(page));
    await page.locator(".cv-cal-today").click();
    out.todayBack = (await grid(page))._title as string;

    // Real date change while the calendar is open (another client changes due).
    await page.request.put(`/api/nodes/${idOct}/attributes/due`, { ...H, data: { value: `${ym}-03`, value_type: "date" } });
    let moved = false;
    try {
      await expect.poll(async () => JSON.stringify((await grid(page))["3"] ?? []), { timeout: 12_000 }).toContain("Mid15");
      moved = true;
    } catch { /* recorded below */ }
    out.liveMove = `moved=${moved} grid=${JSON.stringify(await grid(page))}`;
    // Change in the UI: open the note via the chip, edit the due field in the Table layout of the same view.
    // The layout is switched in the view's 「View options」 menu (a checked item per layout), not by toolbar buttons.
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
    await page.waitForTimeout(800);
    const cell = page.locator(".cv-table tr", { hasText: `Mid15 ${stamp}` }).locator("td").nth(1);
    await cell.click();
    const inp = page.locator(".cv-table input").first();
    out.cellInputType = await inp.getAttribute("type").catch(() => "none");
    await inp.fill(`${ym}-09`).catch(async () => { await inp.press("Control+a"); await inp.type(`${ym}-09`); });
    await inp.press("Enter");
    await page.waitForTimeout(1200);
    const attrsRes = await (await page.request.get(`/api/nodes/${idOct}/attributes`)).json() as Array<{ key: string; value: string }>;
    out.uiEditSaved = attrsRes.find((a) => a.key === "due")?.value ?? "none";
    await layout("Calendar");
    await page.waitForTimeout(800);
    out.afterUiEdit = JSON.stringify(await grid(page));
    // Click chip → opens that note.
    await page.locator(".cv-cal-chip", { hasText: `Mid15 ${stamp}` }).click();
    await page.waitForTimeout(800);
    out.chipOpens = String(page.url().includes(idOct));

    // Reopen: navigate away to December, reload — which month shows?
    await openCal(page);
    await step(page, "Next month", 2);
    await openCal(page);
    out.reopenMonth = (await grid(page))._title as string;

    // A date-typed field whose name has no date hint ("exam").
    await page.request.patch(vPath, { ...H, data: { layout_config: { date_field: "exam" } } });
    await openCal(page);
    out.examField = `${await page.locator(".cv-cal-field").innerText()} grid=${JSON.stringify(await grid(page))}`;
    await page.request.patch(vPath, { ...H, data: { layout_config: { date_field: "due" } } });

    // Negative-UTC timezone: date-only "YYYY-MM-15"-style values.
    const la = await browser.newContext({ storageState: await page.context().storageState(), baseURL: BASE, timezoneId: "America/Los_Angeles" });
    const lp = await la.newPage();
    await lp.addInitScript(() => localStorage.setItem("onden.welcomeDismissed", "1"));
    await openCal(lp);
    out.laTz = await lp.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    out.laOctober = JSON.stringify(await grid(lp));
    await step(lp, "Next month", monthsToDec + 1);
    out.laJan = JSON.stringify(await grid(lp));
    await step(lp, "Previous month");
    out.laDec = JSON.stringify(await grid(lp));
    await la.close();

    // Phone.
    const phone = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, baseURL: BASE, hasTouch: true, isMobile: true });
    const pp = await phone.newPage();
    await openCal(pp);
    out.phone = JSON.stringify(await pp.evaluate(() => {
      const g = document.querySelector(".cv-cal-grid") as HTMLElement;
      const cell = document.querySelector(".cv-cal-cell") as HTMLElement;
      const chip = document.querySelector(".cv-cal-chip") as HTMLElement | null;
      const nav = document.querySelector(".cv-cal-navbtn") as HTMLElement;
      const cr = chip?.getBoundingClientRect();
      return { doc: document.documentElement.scrollWidth, win: innerWidth, gridW: Math.round(g.getBoundingClientRect().width), gridScrollW: g.scrollWidth, cellW: Math.round(cell.getBoundingClientRect().width), chip: cr ? `${Math.round(cr.width)}x${Math.round(cr.height)} text=${chip!.innerText.slice(0, 12)}` : null, navBtn: `${Math.round(nav.getBoundingClientRect().width)}x${Math.round(nav.getBoundingClientRect().height)}` };
    }));
    await pp.locator(".cv-cal").screenshot({ path: "/tmp/pw-output/col06-phone-cal.png" });
    const pchip = pp.locator(".cv-cal-chip").first();
    if (await pchip.count()) { await pchip.tap().catch(() => pchip.click()); await pp.waitForTimeout(800); out.phoneChipOpens = String(/node=/.test(pp.url())); }
    await pp.screenshot({ path: "/tmp/pw-output/col06-phone.png", fullPage: true });
    await phone.close();
  } finally {
    console.log(`AUDIT COL-06 ${JSON.stringify(out, null, 1)}`);
  }
});
