# 外觀普查（style-census）

量「整個 app 實際長什麼樣」：每個畫面 × 寬度 × 淺色／深色，把算出來的樣式（computed style）依
[appearance-rules.md](../../../../docs/agents/appearance-rules.md) 的種類收集、判定在不在刻度上，再和原始碼的靜態數字並排。
**手動執行，和 `layout:audit` 一樣，不在預設測試或任何 CI 工作裡：哪裡都不會自動跑。** 有機器看守的是之後加的靜態守門（見 appearance-rules.md §五）。 它只讀、不改產品程式。

```sh
npm run build:browser                         # 根目錄；普查讀 packages/frontend/dist-browser
cd packages/frontend
npm run style:census                          # 全部：4 個寬度 × 2 個主題 × 所有畫面
npm run style:census -- --sizes 390,1440 --themes light --screens note-long,daily --jobs 2
npm run style:census -- --sheets <資料夾>      # 另外輸出每個畫面×寬度×主題一張 PNG、index.md、每個寬度×主題一張拼貼圖
npm run style:census:selftest                 # 工具自己的測試（假頁面；不需要建置；也檢查規則文件有每一種的列）
```

輸出：`e2e/style-census/report.json`（完整；每次重跑整檔改寫，已在 `.gitignore`，不進版本庫）與 `docs/research/style-census-<日期>.md`（可讀；不含圖片）。
`--allow-failures` 讓有畫面打不開時仍結束碼 0。

**成本**（全部 8 組寬度×主題、約 50 個畫面，3 個並行）：約 15–25 分鐘；Node 約 200 MB，
Chromium 全部程序合計峰值約 1.2–3 GB（3 個並行時）。機器小就用 `--jobs 1`。

**最後一次實跑**：完整普查（8 組寬度×主題 × 51 個畫面）在 2026-11-17 跑，結果就是 `docs/research/style-census-2026-11-17.md`（當時的程式是 `22966c4ab`）。2026-11-19 把 main 合進來（`dc225d8e7`）、重建 `build:browser` 之後，又實跑了 5 個畫面（`note-long`、`ai-panel`、`tasks`、`settings-3`、`note-pdf`）× 2 個寬度（1280×800 觸控、1440），全部量到、沒有出錯；完整普查沒有在合併後的 main 上重跑。之後 main 往前走，工具能不能跑沒有人守，要用時先跑一個小範圍確認。

## 檔案

| 檔案 | 責任 |
| --- | --- |
| `run.mjs` | 進入點：每個寬度×主題開一個瀏覽器環境，逐畫面量測、判定、彙整、寫報告與（選用）聯絡表 |
| `scale.mjs` | A 方向的刻度（機器可讀）與 `classify`；人讀版是 appearance-rules.md |
| `collect.mjs` | 在頁面裡跑：走過畫面上的元素，收集每一種算出來的值、次數、三個例子，以及它宣告在哪條 CSS 規則 |
| `static.mjs` | 原始碼的靜態數字（.css 宣告、.tsx 的 `size={n}`）與「選擇器 → 原始檔:行」索引 |
| `report.mjs` | report.json → 可讀的 Markdown |
| `sheets.mjs` | index.md 與每個寬度×主題一張拼貼圖（用瀏覽器排版，不需要圖片函式庫） |
| `viewports.mjs` | 寬度：手機 390、平板橫 1280×800、平板直 800×1280、桌面 1440；觸控裝置是觸控模擬 |
| `aiStandIn.mjs` | AI 面板的替身（瀏覽器版沒有 AI 角色）：一段固定的對話 |
| `selftest.mjs` | 工具自己的測試 |

**畫面清單和 layout-audit 共用**：`../layout-audit/screens.mjs` 的 `SCREENS`。只有普查用的畫面標了 `census: true`
（layout-audit 跳過它們，所以它的基準與時間不變），它們的資料在 `../layout-audit/seed.mjs` 的 `seedCensusData`。
