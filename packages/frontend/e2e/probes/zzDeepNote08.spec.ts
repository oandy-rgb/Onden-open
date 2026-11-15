// Feature-audit deepening (2026-10-08): NOTE-08 — the Today button across
// local midnight (emulated clock, Asia/Taipei), a quick double press, two
// devices pressing Today for the same new day, offline Today, and the phone.
import { test, type Page } from "@playwright/test";
import { ready, BASE, syncLabel } from "../fullstack/helpers";


test("NOTE-08: Today across midnight, double press, two devices, offline, phone", async ({ page, browser, context }) => {
  test.setTimeout(240_000);
  const out: Record<string, unknown> = {};
  const dayNotes = async (date: string) => ((await (await page.request.get("/api/bootstrap?slim=1")).json()).nodes as Array<{ id: string; title: string; slug: string; hidden?: boolean }>).filter((n) => n.title === date);
  const todayBtn = (p: Page) => p.locator(".app-topbar").getByRole("button", { name: /Today/ }).first();
  const title = (p: Page) => p.locator(".obsidian-title-input, [aria-label='Note title']").first().inputValue().catch(() => "?");
  // Pick a far-future New Year's Eve this account has never used.
  let year = 2040;
  while ((await dayNotes(`${year}-12-31`)).length || (await dayNotes(`${year + 1}-01-01`)).length) year++;
  const d1 = `${year}-12-31`, d2 = `${year + 1}-01-01`;
  out.days = [d1, d2];
  try {
  await page.clock.install({ time: new Date(`${d1}T23:59:00+08:00`) });
  await ready(page, "/?view=notes");
  await todayBtn(page).click();
  await page.waitForTimeout(2500);
  out.beforeMidnight = { title: await title(page), server: (await dayNotes(d1)).length, url: page.url().replace(BASE, "").slice(0, 60) };
  // Cross midnight without reloading.
  await page.clock.fastForward("02:00");
  await page.waitForTimeout(500);
  await todayBtn(page).click();
  await page.waitForTimeout(2500);
  out.afterMidnight = { title: await title(page), d1: (await dayNotes(d1)).length, d2: (await dayNotes(d2)).length };
  // Quick double press on a brand-new day (the next one).
  const d3 = `${year + 1}-01-02`;
  await page.clock.fastForward("24:00:00");
  await page.waitForTimeout(500);
  await todayBtn(page).dblclick();
  await page.waitForTimeout(3000);
  out.doublePress = { title: await title(page), d3: (await dayNotes(d3)).length };

  // Two devices pressing Today for the same new day before either syncs.
  const d4 = `${year + 1}-01-03`;
  await page.clock.fastForward("24:00:00");
  const devB = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json" });
  const pb = await devB.newPage();
  await pb.clock.install({ time: new Date(`${d4}T09:00:00+08:00`) });
  await ready(pb, "/?view=notes");
  await Promise.all([todayBtn(page).click(), todayBtn(pb).click()]);
  await page.waitForTimeout(4000);
  out.twoDevices = { d4: (await dayNotes(d4)).length, aTitle: await title(page), bTitle: await title(pb) };
  await devB.close();

  // Offline Today for a new day, then reconnect.
  const d5 = `${year + 1}-01-04`;
  await page.clock.fastForward("24:00:00");
  await page.waitForTimeout(2000);
  await context.setOffline(true);
  await page.waitForTimeout(800);
  await todayBtn(page).click();
  await page.waitForTimeout(1500);
  out.offlineUi = { title: await title(page), sync: (await syncLabel(page)).replace(/\s+/g, " ").slice(0, 60) };
  await context.setOffline(false);
  await page.waitForTimeout(8000);
  out.offlineReplay = { d5: (await dayNotes(d5)).length };
  } finally {
    await context.setOffline(false).catch(() => {});
  }

  // Phone: the Today entry.
  const phone = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pp = await phone.newPage();
  await ready(pp, "/?view=notes");
  const entries = pp.getByRole("button", { name: /Today/ }).filter({ visible: true });
  out.phoneTodayButtons = await entries.count();
  if (await entries.count()) {
    const bb = await entries.first().boundingBox();
    out.phoneTodayBox = bb ? `${Math.round(bb.width)}x${Math.round(bb.height)}` : null;
    await entries.first().click();
    await pp.waitForTimeout(2500);
    const local = await pp.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
    out.phoneOpened = { expect: local, title: await title(pp), sameDayNotes: (await dayNotes(local)).length };
  }
  await phone.close();
  console.log("NOTE08 " + JSON.stringify(out, null, 2));
});
