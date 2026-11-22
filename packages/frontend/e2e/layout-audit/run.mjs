#!/usr/bin/env node
// 版面規則檢查：用程式量元素位置，檢查通用規則（不存基準截圖）。對象是瀏覽器版（npm run build:browser 的 dist-browser）。
//   node e2e/layout-audit/run.mjs [--widths 1280,pixel5] [--screens note-long,daily] [--rules R1,R3] [--jobs 3]
//        [--update-baseline] [--shots <dir>] [--json <file>] [--dir dist-browser]
// 結果與 baseline.json 比對：基準外的新違規 → exit 1；基準裡已修好的 → 提示刪掉那筆（不失敗）。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { here, launch, startSite, openApp, VIEWPORTS } from "./env.mjs";
import { SCREENS, Skip } from "./screens.mjs";
import { RULES } from "./rules/index.mjs";
import { baselineReason } from "./reasons.mjs";

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const flag = (name) => process.argv.includes(name);
const list = (name) => arg(name)?.split(",").filter(Boolean) ?? null;
const widths = VIEWPORTS.filter((v) => !list("--widths") || list("--widths").includes(v.id));
const screens = SCREENS.filter((s) => !s.census).filter((s) => !list("--screens") || list("--screens").includes(s.id));
const rules = RULES.filter((r) => !list("--rules") || list("--rules").includes(r.id));
const jobs = Number(arg("--jobs") ?? 3);
const shotsDir = arg("--shots");
const BASELINE = join(here, "baseline.json");
const t0 = Date.now();

if (flag("--rewrite-reasons")) { // 只改基準裡的原因（reasons.mjs 改過之後用），不跑審核
  const b = JSON.parse(readFileSync(BASELINE, "utf8"));
  for (const e of b.violations) e.reason = baselineReason(e);
  writeFileSync(BASELINE, JSON.stringify(b, null, 2) + "\n");
  console.log(`已重寫 ${b.violations.length} 筆原因`); process.exit(0);
}
const site = await startSite(arg("--dir") ?? "dist-browser");
const browser = await launch();
const found = [];           // every violation, merged by key
const status = [];          // one row per screen × width
const failures = [];        // things that went wrong in the audit itself

const keyOf = (v) => `${v.rule}|${v.screen}|${v.viewport}|${v.element}`;

async function shoot(page, v, n) {
  if (!shotsDir || !v.box || n >= 3) return;
  mkdirSync(shotsDir, { recursive: true });
  const b = v.box, pad = 36;
  const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
  const vp = page.viewportSize();
  const w = Math.min(vp.width - x, Math.max(b.w + pad * 2, 160)), h = Math.min(vp.height - y, Math.max(b.h + pad * 2, 90));
  if (w < 10 || h < 10) return;
  await page.evaluate((b) => { const d = document.createElement("div"); d.id = "__audit_box"; d.style.cssText = `position:fixed;left:${b.x - 2}px;top:${b.y - 2}px;width:${b.w + 4}px;height:${b.h + 4}px;border:2px solid #e11d48;pointer-events:none;z-index:2147483647;box-sizing:border-box`; document.body.appendChild(d); }, b);
  await page.screenshot({ path: join(shotsDir, `${v.rule}-${v.screen}-${v.viewport}-${n + 1}.png`), clip: { x, y, width: w, height: h }, scale: "css" }).catch(() => {});
  await page.evaluate(() => document.getElementById("__audit_box")?.remove());
}

async function auditWidth(vp) {
  const { context, page, errors } = await openApp(browser, site, vp);
  // phone = the app's phone layout (bottom bar, pages instead of side panels); it starts at 900 wide and below.
  const h = { page, site, vp, phone: !!vp.mobile || (vp.width ?? 9999) <= 900 };
  for (const screen of screens) {
    const row = { screen: screen.id, viewport: vp.id, state: "ok", counts: {} };
    status.push(row);
    try {
      await screen.go(h);
    } catch (e) {
      if (e instanceof Skip) { row.state = "skip"; row.why = e.message; continue; }
      row.state = "error"; row.why = String(e.message).split("\n")[0]; failures.push(`${screen.id} @ ${vp.id}：畫面打不開（${row.why}）`); continue;
    }
    for (const rule of rules) {
      if (rule.when && !rule.when(vp)) { row.counts[rule.id] = null; continue; }
      let hits;
      try { hits = await rule.run(page, { vp, screen }); } catch (e) { failures.push(`${rule.id} 在 ${screen.id} @ ${vp.id} 出錯：${String(e.message).split("\n")[0]}`); continue; }
      const merged = new Map();
      for (const hit of hits) {
        const v = { rule: rule.id, severity: hit.severity ?? rule.severity, screen: screen.id, viewport: vp.id, element: hit.selector, text: hit.text, detail: hit.detail, box: hit.box, count: 1 };
        const k = keyOf(v);
        if (merged.has(k)) merged.get(k).count++; else merged.set(k, v);
      }
      let n = 0;
      for (const v of merged.values()) { found.push(v); await shoot(page, v, n++); }
      row.counts[rule.id] = merged.size;
    }
  }
  if (errors.length) failures.push(`頁面有腳本錯誤 @ ${vp.id}：${errors[0]}`);
  await context.close();
}

// A small pool: widths run side by side, each in its own browser context (its own database).
const queue = [...widths];
await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
  while (queue.length) {
    const vp = queue.shift();
    const t = Date.now();
    try { await auditWidth(vp); console.log(`  ${vp.label}：完成（${Math.round((Date.now() - t) / 1000)} 秒）`); }
    catch (e) { failures.push(`${vp.id} 整個寬度失敗：${String(e.message).split("\n")[0]}`); }
  }
}));
await browser.close(); site.close();

// ── compare with the baseline ────────────────────────────────────────────
const current = new Map(found.map((v) => [keyOf(v), v]));
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : { violations: [] };
const entryKey = (e) => `${e.rule}|${e.screen}|${e.viewport}|${e.element}`;
const known = new Map(baseline.violations.map((e) => [entryKey(e), e]));
const full = !list("--widths") && !list("--screens") && !list("--rules");
const inScope = (e) => widths.some((w) => w.id === e.viewport) && screens.some((s) => s.id === e.screen) && rules.some((r) => r.id === e.rule)
  && status.some((r) => r.screen === e.screen && r.viewport === e.viewport && r.state === "ok");

if (flag("--update-baseline")) {
  if (failures.length) { console.log("審核本身有問題，不更新基準：\n  " + failures.join("\n  ")); process.exit(2); }
  const kept = baseline.violations.filter((e) => !inScope(e));
  const next = [...kept, ...[...current.values()].map((v) => ({ rule: v.rule, screen: v.screen, viewport: v.viewport, element: v.element, reason: known.get(keyOf(v))?.reason ?? baselineReason(v) }))];
  next.sort((a, b) => entryKey(a).localeCompare(entryKey(b)));
  writeFileSync(BASELINE, JSON.stringify({ about: "版面規則檢查的已知違規；只准變少（見 e2e/layout-audit/README.md）", violations: next }, null, 2) + "\n");
  console.log(`基準已更新：${next.length} 筆（本次 ${current.size} 筆）`);
}
if (arg("--json")) writeFileSync(arg("--json"), JSON.stringify({ widths: widths.map((w) => w.id), status, violations: found, failures }, null, 1));

const fresh = [...current.values()].filter((v) => !known.has(keyOf(v)));
const fixed = baseline.violations.filter((e) => inScope(e) && !current.has(entryKey(e)));
console.log(`\n版面檢查：${widths.length} 個寬度 × ${screens.length} 個畫面 × ${rules.length} 條規則，${current.size} 筆違規（基準內 ${current.size - fresh.length}，基準外 ${fresh.length}），耗時 ${Math.round((Date.now() - t0) / 1000)} 秒`);
const skipped = status.filter((r) => r.state === "skip");
if (skipped.length) console.log(`略過 ${skipped.length} 個畫面×寬度（這個寬度沒有該畫面）：` + [...new Set(skipped.map((r) => `${r.screen}(${r.why})`))].join("、"));
for (const f of failures) console.log("審核本身的問題：" + f);
for (const v of fresh.sort((a, b) => a.severity - b.severity)) {
  console.log(`\n新違規 ${v.rule} ${v.screen} @ ${v.viewport}\n  元素：${v.element}${v.text ? ` 「${v.text}」` : ""}${v.count > 1 ? ` ×${v.count}` : ""}\n  量到：${JSON.stringify(v.detail)}`);
}
if (fixed.length) {
  console.log(`\n基準裡有 ${fixed.length} 筆已經修好了，請從 baseline.json 刪掉（重跑 --update-baseline 或手動刪）：`);
  for (const e of fixed.slice(0, 30)) console.log(`  ${e.rule} ${e.screen} @ ${e.viewport}  ${e.element}`);
}
process.exit(fresh.length || failures.length ? 1 : 0);
