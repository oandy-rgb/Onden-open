// Feature-audit deepening (2026-10-08): UX-04 — app language (zh-TW / English
// / system), dates and time zones, string interpolation and mixed language.
// Harvests the visible chrome of each main surface in both languages and flags
// leftovers in the other language, other-locale dates, raw {placeholders} and
// "1 notes" plurals; checks <html lang>, the system-language mapping, a server
// error, CJK word counts, and the published site's date (server time zone).
import { test, type Page, type BrowserContext } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { psql, ready, openPublishRow, BASE, H, syncLabel, publishRequest } from "../fullstack/helpers";

const ALLOW = /\b(Onden|Markdown|PDF|RSS|AI|URL|API|MCP|Excalidraw|OPFS|ZIP|JSON|CSV|OPML|HTML|CSS|Git|GitHub|Ctrl|Shift|Alt|Esc|Enter|Tab|Cmd|SVG|PNG|ID|UUID|OK|Email|Pages|LaTeX|KaTeX|Mermaid|WebDAV|S3|Base|Kanban)\b/g;
const CJK = /[㐀-鿿豈-﫿]/;

type Harvest = { text: string[]; attrs: string[]; lang: string };

async function harvest(p: Page, root = "body"): Promise<Harvest> {
  return p.evaluate((rootSel) => {
    const rootEl = document.querySelector(rootSel) ?? document.body;
    const skip = ".cm-content, .cm-editor, .obsidian-page-button, .react-flow__node, .obsidian-preview, .markdown-body, textarea, [contenteditable='true'], .obsidian-title-input";
    const vis = (el: Element) => { const r = el.getBoundingClientRect(); if (!r.width || !r.height) return false; const cs = getComputedStyle(el); return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0; };
    const text = new Set<string>();
    const w = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = w.nextNode())) {
      const el = n.parentElement; if (!el || el.closest(skip) || !vis(el)) continue;
      const s = (n.textContent ?? "").replace(/\s+/g, " ").trim(); if (s) text.add(s);
    }
    const attrs = new Set<string>();
    rootEl.querySelectorAll("[placeholder],[title],[aria-label]").forEach((e) => {
      if (e.closest(".cm-content, .obsidian-page-button, .react-flow__node") || !vis(e)) return;
      for (const a of ["placeholder", "title", "aria-label"]) { const v = e.getAttribute(a); if (v && v.trim()) attrs.add(`${a}=${v.trim()}`); }
    });
    rootEl.querySelectorAll("select").forEach((s) => { if (vis(s)) for (const o of Array.from((s as HTMLSelectElement).options)) attrs.add(`option=${o.text.trim()}`); });
    return { text: [...text], attrs: [...attrs], lang: document.documentElement.lang };
  }, root);
}

function classify(mode: "zh" | "en", h: Harvest) {
  const all = [...h.text, ...h.attrs.map((a) => a.replace(/^[a-z-]+=/, ""))];
  const english: string[] = [], mixed: string[] = [], enDates: string[] = [], zhDates: string[] = [], placeholders: string[] = [], plurals: string[] = [];
  for (const s of all) {
    if (/\d{9,}/.test(s)) continue; // stamped probe titles = user content
    if (/\{[A-Za-z_]+\}/.test(s)) placeholders.push(s);
    if (mode === "zh") {
      const stripped = s.replace(ALLOW, "");
      if (/[A-Za-z]{3,}/.test(stripped) && !CJK.test(s)) english.push(s);
      else if (/[A-Za-z]{4,}/.test(stripped) && CJK.test(s)) mixed.push(s);
      if (/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b|\b(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day\b|\b[AP]M\b/.test(s)) enDates.push(s);
    } else {
      if (CJK.test(s)) mixed.push(s);
      if (/\d+年|\d+月\d+日|上午|下午|星期|週[一二三四五六日]|\d{4}\/\d{1,2}\/\d{1,2}/.test(s)) zhDates.push(s);
      if (/(^|[^\d.,])1 (notes|items|words|results|tasks|cards|tags|files|changes|edits|minutes|hours|days|members|comments|links|backlinks|feeds|articles|versions|events|errors|writes|seconds|rows|entries|pages|mins)\b/i.test(s)) plurals.push(s);
    }
  }
  const uniq = (a: string[]) => [...new Set(a)].slice(0, 45);
  return { english: uniq(english), mixed: uniq(mixed), enDates: uniq(enDates), zhDates: uniq(zhDates), placeholders: uniq(placeholders), plurals: uniq(plurals), lang: h.lang, total: all.length };
}

async function newCtx(browser: import("@playwright/test").Browser, pref: string, locale: string, timezoneId = "Asia/Taipei"): Promise<BrowserContext> {
  const ctx = await browser.newContext({ baseURL: BASE, storageState: process.env.E2E_STORAGE || "/tmp/pw-auth.json", locale, timezoneId, viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((v) => { try { localStorage.setItem("onden.locale", v); } catch { /* */ } }, pref);
  return ctx;
}

async function surfaces(p: Page, mode: "zh" | "en", nodeId: string, cjkId: string) {
  const res: Record<string, unknown> = {};
  const L = (en: string, zh: string) => (mode === "zh" ? zh : en);
  const grab = async (name: string, root?: string) => {
    try { res[name] = classify(mode, await harvest(p, root)); } catch (e) { res[name] = `ERR ${String(e).slice(0, 120)}`; }
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { res[name] = `ERR ${String(e).split("\n")[0].slice(0, 160)}`; }
  };
  const go = async (url: string) => { await ready(p, url); await p.waitForTimeout(2500); const m = p.getByRole("button", { name: /Minimize recovery panel|最小化/ }); if (await m.isVisible().catch(() => false)) await m.click().catch(() => {}); };

  await step("note", async () => { await go(`/?view=notes&node=${nodeId}`); await grab("note"); });
  await step("noteHistory", async () => {
    if (!(await p.locator(".overview-activity").isVisible().catch(() => false))) await p.locator(".notes-inspector-toggle").click();
    await p.locator(".overview-activity").waitFor({ timeout: 8000 });
    await p.waitForTimeout(800);
    await grab("noteHistory", ".overview-activity");
  });
  await step("cjkWordCount", async () => {
    await go(`/?view=notes&node=${cjkId}`);
    res.cjkWordCount = (await p.locator(".overview-editor, .obsidian-editor").first().innerText().catch(() => "")).split("\n").filter((l) => /min read|閱讀約|word|詞/.test(l)).slice(0, 3);
  });
  await step("timeline", async () => {
    await go("/?view=timeline");
    await grab("timelineVersions");
    const tabs = p.locator(".tl-tab");
    if (await tabs.count() >= 3) {
      await tabs.nth(1).click(); await p.waitForTimeout(1500); await grab("timelineEvents");
      await tabs.nth(2).click(); await p.waitForTimeout(1500); await grab("trash");
    }
  });
  for (const v of ["tasks", "tags", "graph", "rss", "website", "review"]) {
    await step(v, async () => { await go(`/?view=${v}`); await grab(v); });
  }
  await step("settings", async () => {
    await go(`/?view=notes&node=${nodeId}`);
    await p.locator(`button[title="${L("Settings", "設定")}"]`).first().click();
    await p.locator(".settings-modal").waitFor({ timeout: 8000 });
    const items = p.locator(".settings-nav-item");
    const n = await items.count();
    for (let i = 0; i < n; i++) {
      const name = (await items.nth(i).innerText()).trim();
      await items.nth(i).click(); await p.waitForTimeout(900);
      await grab(`settings:${name}`, ".settings-modal");
    }
    await p.keyboard.press("Escape");
  });
  await step("palette", async () => {
    await go(`/?view=notes&node=${nodeId}`);
    await p.keyboard.press("Control+k");
    await p.locator(".palette-input-wrap input").waitFor({ timeout: 5000 });
    await grab("paletteEmpty", "[role='dialog']");
    await p.locator(".palette-input-wrap input").fill("se");
    await p.waitForTimeout(800);
    await grab("paletteSe", "[role='dialog']");
    await p.keyboard.press("Escape");
  });
  await step("publishRow", async () => {
    const { row } = await openPublishRow(p);
    await grab("publishRow", ".info-publish");
    await row.scrollIntoViewIfNeeded();
  });
  await step("capture", async () => {
    await p.evaluate(() => window.dispatchEvent(new Event("onden-open-quick-capture")));
    await p.locator(".quick-capture-sheet").waitFor({ timeout: 5000 });
    await grab("capture", ".quick-capture-sheet");
    await p.locator(".quick-capture-close").click().catch(() => {});
  });
  await step("serverError", async () => {
    await go(`/?view=notes&node=${nodeId}`);
    await p.route("**/api/nodes/**", (r) => (r.request().method() === "PATCH" ? r.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "forbidden", message: "You do not have write access to this note" }) }) : r.continue()));
    await p.locator(".cm-content").first().click();
    await p.keyboard.press("Control+End");
    await p.keyboard.type(" locale probe edit");
    await p.waitForTimeout(5000);
    res.serverErrorTexts = {
      toasts: (await p.locator(".toast").allInnerTexts().catch(() => [])).map((s) => s.replace(/\s+/g, " ").slice(0, 160)),
      recovery: (await p.locator(".failed-write-recovery").allInnerTexts().catch(() => [])).map((s) => s.replace(/\s+/g, " ").slice(0, 300)),
      sync: (await syncLabel(p)).replace(/\s+/g, " ").slice(0, 80),
    };
    await p.unroute("**/api/nodes/**");
  });
  return res;
}

test("UX-04: language, dates/time zones, interpolation, mixed language", async ({ page, browser }, testInfo) => {
  test.setTimeout(900_000);
  const stamp = Date.now();
  const out: Record<string, unknown> = {};
  const mk = async (title: string, markdown: string) => (await (await page.request.post("/api/nodes", { ...H, data: { title, markdown } })).json()) as { id: string; slug: string };
  const note = await mk(`Locale ${stamp}`, `Body with a [[Locale ${stamp}]] self link and #localetag\n\n- [ ] a task due tomorrow\n\nApples are red.`);
  const cjkBody = Array.from({ length: 30 }, (_, i) => `第${i}段：今天天氣很好我們一起去公園散步然後回家寫筆記整理想法這是一段沒有空白的中文句子用來測試字數與閱讀時間的計算方式。`).join("");
  const cjk = await mk(`中文字數 ${stamp}`, cjkBody);
  out.cjkChars = cjkBody.length;
  try {
    // ── 1) zh-TW app on an English browser; English app on a zh-TW browser ──
    const zh = await newCtx(browser, "zh-TW", "en-US");
    const pz = await zh.newPage();
    out.zh = await surfaces(pz, "zh", note.id, cjk.id);
    await zh.close();
    const en = await newCtx(browser, "en", "zh-TW");
    const pe = await en.newPage();
    out.en = await surfaces(pe, "en", note.id, cjk.id);
    // Live switch: does <html lang> follow the language setting?
    await ready(pe, `/?view=notes&node=${note.id}`);
    const langBefore = await pe.evaluate(() => document.documentElement.lang);
    await pe.locator('button[title="Settings"]').first().click();
    await pe.locator(".settings-row", { hasText: "Language" }).locator("select").selectOption("zh-TW");
    await pe.waitForTimeout(800);
    out.liveSwitch = { langBefore, langAfterZh: await pe.evaluate(() => document.documentElement.lang), title: await pe.locator(".settings-title").innerText().catch(() => "") };
    await en.close();

    // ── 2) "System" mapping for several browser languages ───────────────────
    const sys: Record<string, unknown> = {};
    for (const loc of ["zh-CN", "zh-HK", "zh-SG", "ja-JP", "en-GB", "fr-FR"]) {
      const c = await newCtx(browser, "system", loc);
      const pg = await c.newPage();
      await ready(pg, "/?view=notes");
      sys[loc] = { firstTab: (await pg.locator(".sidebar-tab").first().innerText().catch(() => "?")).trim(), lang: await pg.evaluate(() => document.documentElement.lang) };
      await c.close();
    }
    out.systemMapping = sys;

    // ── 3) Same edit, two time zones: times shown in each viewer's zone? ───
    const tzRes: Record<string, unknown> = {};
    for (const tz of ["Asia/Taipei", "Pacific/Pago_Pago"]) {
      const c = await newCtx(browser, "zh-TW", "en-US", tz);
      const pg = await c.newPage();
      await ready(pg, `/?view=notes&node=${note.id}`);
      await pg.waitForTimeout(2000);
      if (!(await pg.locator(".overview-activity").isVisible().catch(() => false))) await pg.locator(".notes-inspector-toggle").click().catch(() => {});
      await pg.waitForTimeout(1200);
      tzRes[tz] = {
        activity: (await pg.locator(".overview-activity").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 260),
        todayTitle: await pg.locator(".app-topbar").getByRole("button", { name: /Today|今天/ }).first().getAttribute("title").catch(() => null),
        localDate: await pg.evaluate(() => new Date().toLocaleString("sv")),
      };
      await c.close();
    }
    out.timezones = tzRes;

    // ── 4) Published site: date of an edit made at 04:30 Taipei time ──────
    await page.request.put(`/api/nodes/${note.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
    await page.request.put(`/api/nodes/${cjk.id}/attributes/_published`, { ...H, data: { value: "true", value_type: "bool" } });
    // Isolated e2e DB only: pretend the author last edited at 2026-10-08 04:30 (Asia/Taipei).
    psql(`update content_nodes set updated_at='2026-10-08 04:30:00+08' where id='${note.id}'`);
    out.publish = (await publishRequest(page.request, {})).status();
    const anon = await browser.newContext({ baseURL: BASE, storageState: { cookies: [], origins: [] }, locale: "zh-TW", timezoneId: "Asia/Taipei" });
    const ap = await anon.newPage();
    await ap.goto(`${BASE}/site/${note.slug}`, { waitUntil: "load" });
    await ap.waitForTimeout(2500);
    const html = await (await ap.request.get(`/site/${note.slug}`)).text();
    out.site = {
      lang: await ap.evaluate(() => document.documentElement.lang),
      datesInHtml: [...new Set(html.match(/\d{4}年\d{1,2}月\d{1,2}日|[A-Z][a-z]+ \d{1,2}, \d{4}/g) ?? [])],
      datesShown: (await ap.locator("body").innerText()).match(/\d{4}年\d{1,2}月\d{1,2}日|[A-Z][a-z]+ \d{1,2}, \d{4}/g) ?? [],
      minRead: ((await ap.locator("body").innerText()).match(/\d+\s*分鐘閱讀|\d+ min read/g) ?? []).slice(0, 2),
    };
    await ap.goto(`${BASE}/site/${cjk.slug}`, { waitUntil: "load" });
    await ap.waitForTimeout(1500);
    out.siteCjkMinRead = ((await ap.locator("body").innerText()).match(/\d+\s*分鐘閱讀|\d+ min read/g) ?? []).slice(0, 2);
    await anon.close();
  } finally {
    writeFileSync(testInfo.outputPath("ux04.json"), JSON.stringify(out, null, 2));
    console.log("UX04 written " + testInfo.outputPath("ux04.json"));
  }
});
