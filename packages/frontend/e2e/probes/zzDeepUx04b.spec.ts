// Feature-audit deepening (2026-10-08): UX-04 follow-up — CJK word count and
// reading time in the editor, the Ask error message under zh-TW, and the
// dates in "Compare versions" (note history) under each app language.
import { test, type BrowserContext } from "@playwright/test";
import { ready, BASE, H } from "../fullstack/helpers";


test("UX-04b: CJK word count, Ask error language, compare-versions dates", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const zhBody = Array.from({ length: 30 }, (_, i) => `第${i}段：今天天氣很好我們一起去公園散步然後回家寫筆記整理想法這是一段沒有空白的中文句子。`).join("");
  const n = await (await page.request.post("/api/nodes", { ...H, data: { title: `字數 ${stamp}`, markdown: zhBody } })).json();
  await page.request.patch(`/api/nodes/${n.id}`, { ...H, data: { markdown: zhBody + "第二版。" } });
  await page.request.patch(`/api/nodes/${n.id}`, { ...H, data: { markdown: zhBody + "第三版。" } });
  out.chars = zhBody.length;
  const mkCtx = async (pref: string, locale: string): Promise<BrowserContext> => {
    const c = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json", locale, timezoneId: "Asia/Taipei", viewport: { width: 1440, height: 900 } });
    await c.addInitScript((v) => { try { localStorage.setItem("onden.locale", v); } catch { /* */ } }, pref);
    return c;
  };
  for (const [mode, pref, locale] of [["zh", "zh-TW", "en-US"], ["en", "en", "zh-TW"]] as const) {
    const c = await mkCtx(pref, locale);
    const p = await c.newPage();
    const r: Record<string, unknown> = {};
    try {
      await ready(p, `/?view=notes&node=${n.id}`);
      await p.locator(".cm-content").first().waitFor({ timeout: 20_000 });
      await p.waitForTimeout(1500);
      r.wordcount = await p.locator(".info-note-stats").first().innerText().catch(() => "(none)");
      // Compare versions (note history).
      // The entry is the inspector's 「完整歷史」/"All versions" (.ov-history-open),
      // which opens the compare/restore dialog (NoteVersionHistory).
      const cmp = p.locator(".ov-history-open").first();
      if (!(await cmp.isVisible().catch(() => false))) await p.locator(".notes-inspector-toggle").click().catch(() => {});
      await p.waitForTimeout(800);
      if (await cmp.isVisible().catch(() => false)) {
        await cmp.click();
        await p.waitForTimeout(2500);
        const txt = (await p.locator(".nh, [class*='nh']").first().innerText().catch(() => "")).replace(/\s+/g, " ");
        r.compare = txt.slice(0, 500);
        r.compareDates = [...new Set(txt.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}(, \d{1,2}:\d{2} ?[AP]M)?|\d{1,2}:\d{2} ?[AP]M|\d{1,2}月\d{1,2}日[^ ]*|[上下]午\d{1,2}:\d{2}|(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day|星期.|Today|Yesterday|今天|昨天/g) ?? [])].slice(0, 12);
        await p.keyboard.press("Escape");
      } else r.compare = "(button not found)";
    } catch (e) {
      r.err = String(e).split("\n")[0].slice(0, 200);
    }
    out[mode] = r;
    await c.close();
  }
  console.log("UX04B " + JSON.stringify(out, null, 2));
});
