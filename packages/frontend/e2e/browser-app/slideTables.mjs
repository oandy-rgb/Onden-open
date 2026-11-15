#!/usr/bin/env node
// 簡報裡的表格 in a real browser (happy-dom cannot lay anything out): a table must sit inside the slide's content
// area, never be cut off, keep a short Chinese cell on one line — in the slides tab's big picture, its thumbnail
// and the full-screen player, in all three themes.
//   node e2e/browser-app/slideTables.mjs [chromium|mobile-chrome] [--shots <dir>]
// mobile-chrome is a Pixel 5 size emulation, not a phone. Needs `npm run build:browser` first.
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const playwright = (() => { try { return require("playwright"); } catch { return require(join(process.env.PLAYWRIGHT_LIB ?? "/opt/node-tools/node_modules", "playwright")); } })();
const engine = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "chromium";
const shotsFlag = process.argv.indexOf("--shots");
const shots = shotsFlag > 0 ? resolve(process.argv[shotsFlag + 1]) : null;
if (shots) mkdirSync(shots, { recursive: true });
const device = playwright.devices[engine === "mobile-chrome" ? "Pixel 5" : "Desktop Chrome"];
const site = await serve(resolve(here, "../..", "dist-browser"));
const results = [];
const themeBg = {};
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

const table = (head, rows) => [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
const CASES = {
  report: { md: `## 各類原因的占比\n\n${table(["原因", "Lexis", "Westlaw", "Practical Law"], [["檢索太天真", "47%", "20%", "34%"], ["引用不適用的法源", "38%", "23%", "34%"], ["推理錯誤", "28%", "61%", "49%"], ["附和使用者", "6%", "0%", "3%"]])}\n\n表中數字是各類原因在該工具所有幻覺中的占比。\n` },
  wide: { md: `## 八欄的寬表\n\n${table(["項目", "第一季", "第二季", "第三季", "第四季", "全年", "去年", "成長"], [["營收", "120", "135", "150", "170", "575", "480", "20%"], ["成本", "80", "85", "90", "95", "350", "310", "13%"], ["利潤", "40", "50", "60", "75", "225", "170", "32%"]])}\n` },
  tall: { md: `## 十五列的高表\n\n${table(["名稱", "數量", "狀態"], Array.from({ length: 15 }, (_, i) => [`第 ${i + 1} 項`, String(i * 3 + 1), i % 2 ? "完成" : "進行中"]))}\n` },
  tallest: { md: `## 三十列的高表\n\n${table(["名稱", "數量"], Array.from({ length: 30 }, (_, i) => [`第 ${i + 1} 項`, String(i)]))}\n`, mayOverflow: true },
  long: { md: `## 長句儲存格\n\n${table(["問題", "說明"], [["檢索太天真", "查詢只用了字面上的關鍵字，沒有同義詞，也沒有改寫成法律上的用語，所以漏掉了真正相關的判決。"], ["引用不適用的法源", "引用的判決已被推翻，或管轄權不同，卻被當成有效的先例直接套用。"], ["推理錯誤", "前提正確但推論跳步，結論在法律上站不住腳。"]])}\n` },
  // Too wide only while every short cell is held on one line: wrapping them fits (4 × 14 characters; 12 × 6).
  fourWide: { wraps: true, relax: 1, md: `## 四欄長詞\n\n${table(["一二三四五六七八九十甲乙丙丁", "戊己庚辛壬癸子丑寅卯辰巳午未", "天地玄黃宇宙洪荒日月盈昃辰宿", "金木水火土東南西北中發白春夏"], [["檢索太天真的問題真的很多", "引用不適用的法源真的不少", "推理錯誤造成的幻覺不算少", "附和使用者造成的幻覺很少"]])}\n` },
  twelve: { wraps: true, relax: 1, md: `## 十二欄\n\n${table(Array.from({ length: 12 }, (_, i) => `欄位標題${i + 1}`), [Array.from({ length: 12 }, (_, i) => `數值${i + 1}號甲`), Array.from({ length: 12 }, (_, i) => `數值${i + 1}號乙`)])}\n` },
  url: { relax: 2, wraps: true, fontSensitive: true, md: `## 長網址\n\n${table(["名稱", "網址"], [["說明文件", "https://example.com/a/very/long/path/without/any/natural/break/points/that/keeps/going/and/going/and/going/forever/and/ever/index.html?query=1234567890abcdefghijklmnopqrstuvwxyz"]])}\n` },
  // The table is on the second page: its thumbnail is the second one, and the player starts there.
  second: { page: 2, md: `## 開場\n\n- 第一點\n- 第二點\n\n## 各類原因的占比\n\n${table(["原因", "Lexis", "Westlaw"], [["檢索太天真", "47%", "20%"], ["推理錯誤", "28%", "61%"]])}\n` },
  // A picture beside the table leaves it half a page: when it does not fit, Paragraphs is offered.
  picture: { mayOverflow: true, expectHint: "段落", md: `## 圖加表格\n\n![x](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==)\n\n${table(["名稱", "數量", "狀態"], Array.from({ length: 24 }, (_, i) => [`第 ${i + 1} 項的說明文字`, String(i * 3 + 1), i % 2 ? "完成" : "進行中"]))}\n` },
  // Long English sentences in 5 columns: they wrap at the spaces, no word is broken, no relaxing is needed.
  english: { md: `## English sentences\n\n${table(["Question", "Lexis answer", "Westlaw answer", "Practical Law", "Notes"], [["Naive retrieval", "The query only used literal keywords and missed the relevant decision", "No synonyms were tried, so the relevant case was never returned", "A rewrite into legal terms would have found it", "Common"], ["Inapplicable authority", "The cited decision had been overturned in a later appeal", "The court had no jurisdiction over the dispute at hand", "Treated as good law although it was not", "Frequent"]])}\n` },
  // Too tall, not too wide: the short cells must stay on one line (relaxing cannot help a table that is too tall).
  tallLong: { mayOverflow: true, md: `## 又高又有長句\n\n${table(["原因", "占比", "說明"], Array.from({ length: 22 }, (_, i) => [`第 ${i + 1} 類`, `${i * 3 + 1}%`, "這一格是一句比較長的說明文字，會自己換行而不影響其他欄位的短詞"]))}\n` },
  // A picture and ordinary text: not a table, so it must not shrink or complain (the media row is as tall as the area).
  pictureText: { noTable: true, md: `## 圖加文字\n\n![x](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==)\n\n- 第一點的說明文字\n- 第二點的說明文字\n- 第三點的說明文字\n` },
  mixed: { md: `## 表格加條列\n\n${table(["原因", "Lexis", "Westlaw"], [["檢索太天真", "47%", "20%"], ["推理錯誤", "28%", "61%"], ["附和使用者", "6%", "0%"]])}\n\n- 數字是占比\n- 一筆幻覺可能有多個原因\n- 所以加總不會是 100%\n` },
};
const THEME_NAME = { dark: /深色/, paper: /紙本/ };
// A phone-size run repeats one theme (the themes are the same CSS at any size); ALL_THEMES=1 runs all three.
const THEMES = process.env.THEME ? [process.env.THEME] : engine === "mobile-chrome" && !process.env.ALL_THEMES ? ["site"] : ["site", "dark", "paper"];

const browser = await playwright.chromium.launch();
const context = await browser.newContext({ ...device, ...(engine === "chromium" ? { viewport: { width: 1280, height: 800 } } : {}), locale: "zh-TW" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

/** The table's place against its slide, in the slide's own 1920×1080 pixels (the canvas is scaled, so divide by the scale). */
const measure = (root) => page.evaluate((selector) => {
  const canvas = document.querySelector(selector);
  if (!canvas) return null;
  const c = canvas.getBoundingClientRect();
  const k = c.width / 1920;
  const rel = (r) => ({ left: (r.left - c.left) / k, top: (r.top - c.top) / k, right: (r.right - c.left) / k, bottom: (r.bottom - c.top) / k });
  const tbl = canvas.querySelector("table");
  if (!tbl) return { noTable: true };
  const fit = canvas.querySelector(".sv-fit").getBoundingClientRect();
  const cells = [...tbl.querySelectorAll("th, td")].map((cell) => {
    const range = document.createRange();
    range.selectNodeContents(cell);
    return { rect: rel(cell.getBoundingClientRect()), lines: new Set([...range.getClientRects()].map((r) => Math.round(r.top / k / 4))).size, short: [...cell.textContent].length <= 8, text: cell.textContent };
  });
  const fitBox = rel(fit);
  return {
    table: rel(tbl.getBoundingClientRect()), fit: fitBox, cells, bg: getComputedStyle(canvas).backgroundColor, relax: canvas.dataset.relax ?? "0", shrunk: canvas.classList.contains("sv-shrunk"), min: canvas.classList.contains("sv-shrunk-2"),
    fontPx: parseFloat(getComputedStyle(tbl).fontSize) , scale: k,
  };
}, root);

const inside = (m) => {
  const t = m.table, f = m.fit, eps = 2;
  return t.left >= f.left - eps && t.right <= f.right + eps && t.bottom <= f.bottom + eps && m.cells.every((c) => c.rect.right <= f.right + eps && c.rect.bottom <= f.bottom + eps);
};

try {
  await page.goto(site.base);
  await page.getByText("歡迎來到 Onden 試用版").first().waitFor({ state: "attached", timeout: 90_000 });
  const api = (path, method = "GET", body) => page.evaluate(async ([p, m, b]) => {
    const r = await fetch(p, { method: m, headers: { "content-type": "application/json" }, ...(b ? { body: JSON.stringify(b) } : {}) });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [path, method, body]);
  for (const theme of THEMES) {
    for (const [name, c] of Object.entries(CASES)) {
      if (process.env.ONLY && !process.env.ONLY.split(",").includes(name)) continue;
      const title = `表格 ${name} ${theme} ${Date.now()}`;
      const created = await api("/api/nodes", "POST", { title, markdown: c.md });
      const id = created.json?.id;
      if (!id) { check(`${name}/${theme}: note created`, false, JSON.stringify(created).slice(0, 160)); continue; }
      // The new note is opened from the sidebar (a address typed straight in is read before the page's data is).
      await page.goto(site.base);
      if (engine === "mobile-chrome") { await page.getByRole("button", { name: "筆記列表" }).first().click(); await page.waitForTimeout(700); }
      await page.getByText(title, { exact: true }).first().click();
      await page.getByRole("button", { name: "更多動作" }).first().waitFor({ timeout: 60_000 });
      // The slides tab is added from the note's own view row (＋; on a phone the note's ⋯ menu), then it is a tab of its own.
      if (await page.getByRole("button", { name: "新增檢視" }).count() === 0) {
        await page.getByRole("button", { name: "更多動作" }).first().click();
        await page.getByText("新增檢視", { exact: true }).first().click();
      } else await page.getByRole("button", { name: "新增檢視" }).first().click();
      await page.locator("[role=menu],[role=dialog],[role=listbox]").getByText("簡報", { exact: true }).first().click();
      await page.locator(".sp-big .sv-canvas").waitFor({ timeout: 60_000 });
      if (theme !== "site") {
        await page.locator(".sp-bar").getByRole("button", { name: /跟網站一樣/ }).click();
        await page.getByRole("menuitem", { name: THEME_NAME[theme] }).click();
      }
      await page.waitForTimeout(1200);
      const tag = `${name}/${theme}`;
      const pageNo = c.page ?? 1;
      if (pageNo > 1) { await page.locator(`.sp-thumbs li:nth-child(${pageNo}) .sp-hit`).click(); await page.waitForTimeout(800); }
      if (c.noTable) {
        const own = await page.evaluate(() => { const cv = document.querySelector(".sp-big .sv-canvas"); return { cls: cv.className, hint: !!document.querySelector(".sp-hint") }; });
        check(`${name}/${theme}: an ordinary picture-and-text page is left alone (not shrunk, no hint)`, !own.cls.includes("sv-shrunk") && !own.hint, own.cls);
        continue;
      }
      const big = await measure(".sp-big .sv-canvas");
      check(`${tag}: big picture has the table`, big && !big.noTable);
      if (!big || big.noTable) continue;
      const wide = (big.fit.right - big.fit.left);
      check(`${tag}: table sits inside the slide's content area`, c.mayOverflow ? true : inside(big), JSON.stringify({ t: big.table, f: big.fit }));
      if (!c.expectHint) check(`${tag}: the table uses the content width`, big.table.right - big.table.left >= wide * 0.97, `${Math.round((big.table.right - big.table.left) / wide * 100)}%`);
      if (!c.fontSensitive) check(`${tag}: relaxing step is ${c.relax ?? 0} (only a too-WIDE table relaxes)`, big.relax === String(c.relax ?? 0), `got ${big.relax}`);
      const wrapped = big.cells.filter((x) => x.short && x.lines > 1).map((x) => x.text);
      if (!c.wraps) check(`${tag}: short cells stay on one line`, wrapped.length === 0, wrapped.join(","));
      else check(`${tag}: relaxing is what made it fit`, inside(big), "");
      themeBg[theme] = big.bg;
      const first = await measure(`.sp-thumbs li:nth-child(${pageNo}) .sv-canvas`);
      check(`${tag}: the thumbnail matches the big picture`, first && !first.noTable && Math.abs(first.table.right - big.table.right) < 3 && Math.abs(first.table.bottom - big.table.bottom) < 3 && first.min === big.min && first.shrunk === big.shrunk);
      const hint = await page.locator(".sp-hint").allInnerTexts();
      if (c.expectHint) check(`${tag}: offers ${c.expectHint}`, hint.join().includes(c.expectHint), hint.join("|"));
      else if (c.mayOverflow) check(`${tag}: too big says so`, hint.join().includes("拆成兩頁"), hint.join("|"));
      else check(`${tag}: no hint when it fits`, hint.length === 0, hint.join("|"));
      console.log(`      ${tag}: table ${Math.round(big.table.right - big.table.left)}×${Math.round(big.table.bottom - big.table.top)} in ${Math.round(wide)}×${Math.round(big.fit.bottom - big.fit.top)}, font ${big.fontPx.toFixed(1)}px ${big.min ? "(smallest)" : big.shrunk ? "(shrunk)" : ""}`);
      if (shots) await page.screenshot({ path: join(shots, `${name}-${theme}-pane.png`) });
      // The player
      await page.getByRole("button", { name: /播放/ }).first().click();
      await page.locator(".presentation .sv-canvas").first().waitFor({ timeout: 20_000 });
      await page.waitForTimeout(700);
      if (process.env.DEBUG_PLAYER) console.log(await page.evaluate(() => [...document.querySelectorAll(".sv-canvas")].map((c) => `${c.closest(".presentation") ? "player" : "pane"} ${c.className} fit=${c.querySelector(".sv-fit")?.clientHeight}/${c.querySelector(".sv-fit")?.scrollHeight} font=${getComputedStyle(c).fontSize}`).filter((x) => x.startsWith("player"))));
      if (process.env.DEBUG_PLAYER) console.log(tag, await page.evaluate(() => [...document.querySelectorAll('.sv-canvas')].map((cv) => { const f = cv.querySelector('.sv-fit'); const t = cv.querySelector('table'); return `${cv.closest('.presentation') ? 'player' : 'pane'} relax=${cv.dataset.relax} fit=${f?.scrollWidth}/${f?.clientWidth} table=${t?.offsetWidth} font=${getComputedStyle(cv).fontFamily.slice(0, 40)}`; })));
      const played = await measure(".presentation .sv-canvas");
      if (c.fontSensitive) check(`${tag}: the player fits the table too (its steps may differ by a font that finished loading later)`, played && !played.noTable && inside(played), "");
      else check(`${tag}: the player draws the same table`, played && !played.noTable && Math.abs(played.table.right - big.table.right) < 3 && Math.abs(played.table.bottom - big.table.bottom) < 3 && played.min === big.min, played ? `player ${Math.round(played.table.right)}x${Math.round(played.table.bottom)} relax ${played.relax}, pane ${Math.round(big.table.right)}x${Math.round(big.table.bottom)} relax ${big.relax}` : "none");
      if (shots && (theme !== "site" || name === "report" || name === "wide" || name === "tall")) await page.screenshot({ path: join(shots, `${name}-${theme}-play.png`) });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }
  }
  check("the themes are different looks", new Set(Object.values(themeBg)).size === THEMES.length, JSON.stringify(themeBg));
  check("no script errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  site.close();
}
console.log(`${engine}: ${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
