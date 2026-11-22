// Contact sheets: index.md (grouped by screen) and one montage per size × theme (every screen as a thumbnail, so the whole
// app can be seen at a glance). Montages are drawn by the browser itself (an HTML grid), so no image library is needed.
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { launch } from "../layout-audit/env.mjs";
import { SIZES } from "./viewports.mjs";

const MAX = 1024 * 1024;
const TILE = { "390": 150, "800x1280": 150, "1280x800": 300, "1440": 300 };

export async function writeSheets(dir, shots, status, combos) {
  const lines = ["# 外觀聯絡表", "", "> 產生的資料；每張圖是一個畫面在一個寬度與主題下的樣子（裝置像素比 1）。每個寬度與主題另有一張拼貼圖（`montage__<寬度>__<主題>.png`）。", ""];
  lines.push("## 拼貼圖（所有畫面一眼看完）", "");
  const browser = await launch();
  for (const size of SIZES.map((s) => s.size)) for (const theme of ["light", "dark"]) {
    const tiles = shots.filter((s) => s.size === size && s.theme === theme).sort((a, b) => a.screen.localeCompare(b.screen));
    if (!tiles.length) continue;
    const name = `montage__${size}__${theme}.png`;
    const cols = size === "390" || size === "800x1280" ? 10 : 6;
    const html = `<body style="margin:0;background:#888;font:11px sans-serif"><div style="display:grid;grid-template-columns:repeat(${cols},${TILE[size]}px);gap:6px;padding:6px">${tiles.map((t) =>
      `<figure style="margin:0;background:#fff"><img style="width:100%;display:block" src="data:image/png;base64,${readFileSync(join(dir, t.file)).toString("base64")}"><figcaption style="padding:2px 3px;background:#222;color:#fff;overflow:hidden;white-space:nowrap">${t.screen}</figcaption></figure>`).join("")}</div></body>`;
    for (const dsf of [1, 0.75, 0.5, 0.35]) {
      const ctx = await browser.newContext({ viewport: { width: cols * TILE[size] + (cols + 1) * 6, height: 400 }, deviceScaleFactor: dsf });
      const page = await ctx.newPage(); await page.setContent(html); await page.waitForLoadState("load");
      await page.screenshot({ path: join(dir, name), fullPage: true }); await ctx.close();
      if (statSync(join(dir, name)).size < MAX) break;
    }
    lines.push(`- ${size} ${theme}：\`${name}\`（${tiles.length} 個畫面，${Math.round(statSync(join(dir, name)).size / 1024)} KiB）`);
  }
  await browser.close();
  lines.push("", "## 每個畫面", "");
  const screens = [...new Set(status.map((r) => r.screen))];
  for (const id of screens) {
    const rows = status.filter((r) => r.screen === id);
    lines.push(`### ${id}｜${rows[0].name}`, "");
    for (const s of SIZES) for (const theme of ["light", "dark"]) {
      const f = `${id}__${s.size}__${theme}.png`; const r = rows.find((x) => x.combo === `${s.size}__${theme}`);
      if (!r) continue;
      lines.push(r.state === "ok" ? `- ${s.size} ${theme}：[${f}](${f})` : `- ${s.size} ${theme}：沒有圖（${r.state === "skip" ? "略過：" : "出錯："}${r.why}）`);
    }
    lines.push("");
  }
  writeFileSync(join(dir, "index.md"), lines.join("\n"));
  const big = shots.filter((s) => statSync(join(dir, s.file)).size >= MAX);
  if (big.length) console.log(`超過 1 MiB 的圖：${big.map((b) => b.file).join("、")}`);
}
