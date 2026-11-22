// report.json → the readable Markdown report (docs/research/style-census-<date>.md). No images.
import { KINDS } from "./scale.mjs";

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const cell = (s) => String(s ?? "").replace(/\|/g, "／").replace(/\n/g, " ");
const short = (s, n = 70) => (s.length > n ? "…" + s.slice(-n) : s);
const srcText = (x) => (x.source ? `${x.source.file}${x.source.line ? `:${x.source.line}` : ""}` : "—");
const valueText = (v) => cell(v.length > 48 ? v.slice(0, 48) + "…" : v).replace(/^(raw|token|alpha|ok|off):/, (m) => (m === "token:" ? "" : m));

export function renderReport(r) {
  const out = [];
  const L = (s = "") => out.push(s);
  const kindMeta = Object.fromEntries(KINDS.map((k) => [k.id, k]));
  const ok = r.status.filter((s) => s.state === "ok");
  const screenIds = [...new Set(r.status.map((s) => s.screen))];
  L(`# 外觀普查 ${r.date}`);
  L();
  L("> 狀態：歷史紀錄（2026-11-17 的一次測量，由 `npm run style:census` 寫出，之後不再更新；工具與判定標準見 [e2e/style-census/README.md](../../packages/frontend/e2e/style-census/README.md) 與 [appearance-rules.md](../agents/appearance-rules.md)）");
  L();
  L(`範圍：${screenIds.length} 個畫面 × ${r.combos.length} 個「寬度×主題」，實際量到 ${ok.length} 個畫面×寬度×主題；在瀏覽器版（\`dist-browser\`，資料是產生的）量的是**算出來的樣式**（computed style），不是原始碼寫的。`);
  L(`成本：${r.cost.seconds} 秒（${r.cost.jobs} 個並行）；Node 峰值記憶體約 ${r.cost.nodeMaxRssMb} MB，Chromium 全部程序加總峰值約 ${r.cost.chromePeakRssMb} MB。`);
  L();
  L("「次數」是（元素 × 屬性）出現的次數，不是宣告數：同一個 `padding: 8px` 在 40 個按鈕上算 4×40。「不在刻度上」依 appearance-rules.md 的草案判定（業主還沒看過，數字會變）。");
  L();
  L("## 一、每種值：量到幾種、幾種不在刻度上");
  L();
  L("| 種類 | 有沒有守門 | 量到的次數 | 不同的值 | 不在刻度上的次數 | 不在刻度上的值 | 原始碼：寫死的宣告／用 token 的宣告 |");
  L("| --- | --- | ---: | ---: | ---: | ---: | --- |");
  for (const k of KINDS) {
    const d = r.kinds[k.id]; const st = r.static.css.kinds[k.id];
    L(`| ${k.label}（\`${k.id}\`） | ${k.guard ?? "**沒有**"} | ${d.total} | ${d.distinct} | ${d.off}（${pct(d.off, d.total)}） | ${d.offDistinct} | ${st ? `${st.rawDecls}／${st.tokenDecls}` : "—（動態量不到靜態）"} |`);
  }
  L();
  L("靜態那欄對不到 1:1：一個 `border: 1px solid var(--x)` 同時算邊框粗細、樣式與顏色；`calc()`、`em` 之類相對值算寫死。圖示尺寸另見第六節。");
  L();
  if (r.taps && Object.keys(r.taps).length) {
    L("## 一之二、觸控目標（`pointer: coarse` 下，實際可點的大小）");
    L();
    L("對照業主 2026-11-17 在 Galaxy Tab S9（視窗 1204×714）上量的真機數字：同樣把「寬或高任一邊小於 44 CSS px」算不到。這裡的「可點大小」是用 `elementFromPoint` 從四邊往外量出來的，**畫面上看不見的擴大點擊範圍會算進去**。只量視窗內完整看得到的 button、連結、tab、輸入框等（淺色主題；捲到視窗外的沒有量）。觸控模擬不是真機。");
    L();
    L("| 寬度 | 量到的控制項 | 不到 44 | 比例 |");
    L("| --- | ---: | ---: | ---: |");
    for (const [size, per] of Object.entries(r.taps)) {
      const t = Object.values(per).reduce((a, b) => a + b.total, 0), o = Object.values(per).reduce((a, b) => a + b.off, 0);
      L(`| ${size} | ${t} | ${o} | ${pct(o, t)} |`);
    }
    L();
    for (const [size, per] of Object.entries(r.taps)) {
      L(`### ${size}：每個畫面（控制項／不到 44）`);
      L();
      L("| 畫面 | 控制項 | 不到 44 |");
      L("| --- | ---: | ---: |");
      for (const [id, v] of Object.entries(per).sort((a, b) => b[1].off - a[1].off).slice(0, 15)) L(`| \`${id}\` | ${v.total} | ${v.off} |`);
      L();
      L(`最小的控制項（可點大小由小到大；「畫出來」是看得到的框，「可點」是含擴大範圍）：`);
      L();
      L("| 元素 | 畫出來 | 可點 | 次數 | 出現在 |");
      L("| --- | --- | --- | ---: | --- |");
      for (const x of (r.tapSmallest?.[size] ?? []).slice(0, 12)) L(`| \`${cell(short(x.sel, 70))}\` | ${x.drawn} | ${x.hit} | ${x.n} | ${x.screens.join("、")} |`);
      L();
    }
  }
  L("## 二、各種類的值（次數前 14 名；❌＝不在刻度上）");
  for (const k of KINDS) {
    const d = r.kinds[k.id];
    L();
    L(`### ${k.label}（\`${k.id}\`）`);
    L();
    if (!d.values.length) { L("沒有量到（見第七節的說明）。"); continue; }
    L("| 值 | 次數 | 畫面數 | 判定 | 例子（元素；屬性；來源） |");
    L("| --- | ---: | ---: | --- | --- |");
    for (const v of d.values.slice(0, 14)) {
      const e = v.examples[0];
      L(`| \`${valueText(v.value)}\` | ${v.n} | ${v.screens} | ${v.nOff === 0 ? "✔" : v.nOff === v.n ? `❌ ${cell(v.why)}` : `部分❌（${v.nOff}／${v.n}）${cell(v.why)}`} | ${e ? `\`${cell(short(e.sel))}\`；${e.prop}；${srcText(e)}` : ""} |`);
    }
    if (d.values.length > 14) L(`\n（另有 ${d.values.length - 14} 種值，完整清單在重跑後產生的 report.json，那個檔不進版本庫。）`);
  }
  L();
  L("## 三、哪個畫面最不整齊");
  L();
  L("每個畫面所有種類的「不在刻度上的次數」加總，與佔該畫面量到總次數的比例（所有寬度與主題加總）。");
  L();
  L("| 畫面 | 不在刻度上 | 量到總數 | 比例 |");
  L("| --- | ---: | ---: | ---: |");
  const screens = Object.entries(r.byScreen).map(([id, kinds]) => ({ id, off: Object.values(kinds).reduce((a, k) => a + k.off, 0), total: Object.values(kinds).reduce((a, k) => a + k.total, 0) })).sort((a, b) => b.off - a.off);
  for (const s of screens.slice(0, 20)) L(`| \`${s.id}\` | ${s.off} | ${s.total} | ${pct(s.off, s.total)} |`);
  L();
  L("## 四、哪個原始檔最常是來源");
  L();
  L("把不在刻度上的值，依「最後勝出的規則」（近似層疊）歸給它所在的 CSS 檔。`(找不到：…)` 是瀏覽器裡的規則沒對到原始碼（例如編輯器自己注入的樣式）。");
  L();
  L("| 來源檔 | 不在刻度上的次數 | 其中最多的種類 |");
  L("| --- | ---: | --- |");
  const files = Object.entries(r.bySource).map(([f, kinds]) => ({ f, off: Object.values(kinds).reduce((a, b) => a + b, 0), top: Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} ${n}`).join("、") })).sort((a, b) => b.off - a.off);
  for (const f of files.slice(0, 20)) L(`| \`${cell(f.f)}\` | ${f.off} | ${f.top} |`);
  L();
  L(`規則對應：精確 ${r.resolution.exact}、近似（只對到類別名）${r.resolution.approx}、行內 style ${r.resolution.inline}、沒對到 ${r.resolution.none}。`);
  L();
  L("## 五、同時有最多種類不在刻度上的 20 個地方");
  L();
  L("「地方」＝一種元素（標籤＋角色＋前兩個類別），跨畫面合併。依「幾種不同的種類不在刻度上」排序，再依次數。");
  L();
  L("| # | 元素 | 不在刻度上的種類 | 次數 | 出現在 | 來源檔 |");
  L("| ---: | --- | --- | ---: | --- | --- |");
  r.places.forEach((p, i) => L(`| ${i + 1} | \`${cell(short(p.sel, 80))}\` | ${p.kindsOff.length}：${p.kindsOff.map((k) => `${k}=${cell(p.values[k]).slice(0, 16)}`).join("、")} | ${p.offN} | ${p.screens.slice(0, 4).join("、")}${p.screens.length > 4 ? `…等 ${p.screens.length} 個` : ""} | ${p.sources.slice(0, 2).map((s) => `\`${cell(s)}\``).join("、") || "—"} |`));
  L();
  L("## 六、原始碼的靜態數字");
  L();
  L(`掃了 ${r.static.css.declarations} 條 CSS 宣告（\`src/\` 下所有 .css，不含測試）與 ${r.static.tsx.files} 個 .tsx。`);
  L();
  L("| 種類 | 寫死的宣告 | 用 token 的宣告 | 寫死的值有幾種 | 最常見的寫死值 |");
  L("| --- | ---: | ---: | ---: | --- |");
  for (const k of KINDS) {
    const st = r.static.css.kinds[k.id]; if (!st) continue;
    L(`| ${k.label} | ${st.rawDecls} | ${st.tokenDecls} | ${Object.keys(st.raw).length} | ${Object.entries(st.raw).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v, n]) => `${cell(v).slice(0, 24)}×${n}`).join("、")} |`);
  }
  L();
  const t = r.static.tsx;
  L(`圖示（.tsx 的 \`size={n}\`，共 ${t.sizeUses} 處）：${Object.entries(t.iconSize).sort((a, b) => b[1] - a[1]).map(([v, n]) => `${v}×${n}`).join("、")}。`);
  L(`\`strokeWidth={…}\`：${Object.entries(t.stroke).map(([v, n]) => `${v}×${n}`).join("、") || "無"}。行內 \`style={{…}}\`：${t.inline.total ?? 0} 處（只算同一行寫得出的；多半只是設自訂屬性）。`);
  L();
  L(`媒體查詢寬度：${Object.entries(r.static.css.media).map(([m, n]) => `\`${m}\`×${n}`).join("、")}；其他條件：${Object.entries(r.static.css.mediaOther).map(([m, n]) => `\`${m}\`×${n}`).join("、")}。`);
  L();
  L("## 七、沒量到的畫面與原因");
  L();
  const notOk = r.status.filter((s) => s.state !== "ok");
  if (!notOk.length) L("全部畫面在全部寬度都量到了。");
  else {
    const grouped = new Map();
    for (const s of notOk) { const k = `${s.state === "skip" ? "略過" : "出錯"}｜${s.screen}｜${s.why}`; grouped.set(k, [...(grouped.get(k) ?? []), s.combo]); }
    L("| 狀態 | 畫面 | 原因 | 寬度×主題 |");
    L("| --- | --- | --- | --- |");
    for (const [k, combos] of grouped) { const [st, sc, why] = k.split("｜"); L(`| ${st} | \`${sc}\` | ${cell(why)} | ${combos.length === r.combos.length ? "全部" : combos.join("、")} |`); }
  }
  L();
  for (const f of r.failures.filter((x) => !/@/.test(x) || /腳本錯誤|整個/.test(x))) L(`- ${f}`);
  L();
  L("**畫面有量到，但內容不是真的**（不是工具壞了，是瀏覽器版叫不出來）：");
  L();
  L("- 離線：瀏覽器版的資料存在本機，不會出現「離線」橫幅；`offline` 只量到 AI 分頁裡「離線時不能問 AI」那一句。");
  L("- 儲存失敗、同步失敗、`RegionErrorBoundary`、`AppErrorBoundary`、提示訊息（toast）：要伺服器失敗或元件壞掉才會出現，沒有量；錯誤類只量了「筆記不存在」。");
  L("- AI 面板用替身（固定的兩輪對話），不是真的 AI 回答；待審建議（接受／全部捨棄）的畫面沒有量。");
  L("- 書籤、推播、登入與帳號閘門：瀏覽器版沒有（回 501 或不存在）。");
  L("- 平板直放 800×1280 的 `canvas`：打不開（60 秒逾時），原因沒有查。");
  L("- 「這次更新」卡片（已關掉）與試用版提示（被隱藏）不在畫面裡；簡報播放、鍵盤彈出、輸入法組字中、拖曳中的狀態沒有量。");
  L();
  L("## 八、這份測量的限制");
  L();
  L("- 量的是瀏覽器版的 Chromium、裝置像素比 1、基礎字級 14px、預設密度；使用者自己調的字級、密度、顏色不在內。手機與平板是 Playwright 的觸控模擬，不是真機。");
  L("- 只量畫面上顯示出來的元素（`display:none`、`visibility:hidden`、透明度 0 的子樹不算）；對話框或選單打開時只量那一層（和 layout-audit 相同）。捲到畫面外的內容有量，但要先被渲染出來（長清單可能是虛擬化的）。");
  L("- 外距 `auto` 沒辦法從算出來的值分辨，用啟發式略過（置中、推到邊的），可能少算。");
  L("- 「來源」是依層疊順序最後一條有宣告該屬性、又符合該元素的規則，不處理優先權與 `!important`，所以是近似。");
  L("- 畫布（手寫的筆跡）、圖片、PDF 頁面內容、使用者的螢光筆顏色是內容，不是介面，沒有量。`filter: drop-shadow` 與 `text-shadow` 沒量。");
  L("- 動畫時間量的是算出來的 `transition-duration`／`animation-duration`（測試環境允許動態）；從狀態變化才出現的 hover／active 樣式沒有被觸發，所以沒量到。");
  L("- 焦點框只在每個畫面按三次 Tab 取樣，不是全部可聚焦元素。");
  return out.join("\n") + "\n";
}
