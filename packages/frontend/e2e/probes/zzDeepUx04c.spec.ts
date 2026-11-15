// Feature-audit deepening (2026-10-08): UX-04 follow-up — the dates and labels
// inside the "All versions" history modal (note history) under each app language.
import { test } from "@playwright/test";
import { ready, BASE, H } from "../fullstack/helpers";


test("UX-04c: history modal dates and labels per app language", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const n = await (await page.request.post("/api/nodes", { ...H, data: { title: `HistLoc ${stamp}`, markdown: "v1" } })).json();
  await page.request.patch(`/api/nodes/${n.id}`, { ...H, data: { markdown: "v2 changed" } });
  for (const [mode, pref, locale] of [["zh", "zh-TW", "en-US"], ["en", "en", "zh-TW"]] as const) {
    const c = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json", locale, timezoneId: "Asia/Taipei", viewport: { width: 1440, height: 900 } });
    await c.addInitScript((v) => { try { localStorage.setItem("onden.locale", v); } catch { /* */ } }, pref);
    const p = await c.newPage();
    const r: Record<string, unknown> = {};
    try {
      await ready(p, `/?view=notes&node=${n.id}`);
      await p.waitForTimeout(2000);
      if (!(await p.locator(".ov-history-open").isVisible().catch(() => false))) await p.locator(".notes-inspector-toggle").click().catch(() => {});
      await p.locator(".ov-history-open").click({ timeout: 10_000 });
      await p.locator(".nh").waitFor({ timeout: 10_000 });
      await p.waitForTimeout(2000);
      const txt = (await p.locator(".nh").innerText()).replace(/\s+/g, " ");
      r.modal = txt.slice(0, 700);
      r.dates = [...new Set(txt.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}(, \d{1,2}:\d{2} ?[AP]M)?|\d{1,2}:\d{2} ?[AP]M|\d{1,2}月\d{1,2}日[^ ]*|[上下]午\s?\d{1,2}:\d{2}|(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day|星期.|Today|Yesterday|今天|昨天/g) ?? [])].slice(0, 12);
      r.ariaLabel = await p.locator(".nh").getAttribute("aria-label");
    } catch (e) { r.err = String(e).split("\n")[0].slice(0, 200); }
    out[mode] = r;
    await c.close();
  }
  console.log("UX04C " + JSON.stringify(out, null, 2));
});
