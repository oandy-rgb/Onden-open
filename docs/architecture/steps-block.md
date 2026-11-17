# 逐步圖（```steps 區塊）

> 狀態：現行（最後確認 2026-11-02）。第 1、2 層已實作並測試；第 3 層（樹／圖／陣列的補間動畫）只預留介面，尚未實作。
> 涵蓋：packages/markdown/src/stepsBlocks.ts, packages/markdown/src/lineAlign.ts, packages/markdown/src/stepsNav.ts, packages/markdown/src/stepsEnhance.ts, packages/frontend/src/components/StepsFigure.tsx, packages/frontend/src/components/siteFrame/SiteSteps.astro

給資工學生在筆記裡「一步一步」講演算法或程式。原則（2026-10-22 記錄、2026-11-02 決定做）：
**寫狀態，不寫動畫**——使用者寫每一步的內容，App 負責播放與過場；不執行使用者的程式碼。

## 語法

````
````steps
整組的說明（可空）。

## 第一步
```js
let total = 0;
```

## 第二步
```js
let total = 0;
for (const n of list) total += n;
```
````
````

- 語言名 `steps`。`## 標題` 分步；第一個 `##` 之前是整組的說明。每一步是一般 Markdown（程式碼、mermaid、圖片、清單、表格）。
- 步驟裡有 ``` 時，外層用四個（以上）反引號（CommonMark）。編輯器 `/` 的「逐步圖」插入帶兩步範例、外層已是四個反引號的樣板，使用者不必自己算。
- 只有圍欄之外的 `## ` 才分步；步驟內程式碼裡的 `## ` 不分。`###` 不分。空標題、空內容的步驟保留。
- 沒有 `##` 的區塊只顯示說明，不出播放器。步驟裡再放 `steps` 不會再變成播放器（顯示為程式碼）。

解析在 `@onden/markdown`（`stepsBlocks.ts`），App、發布網站、匯出共用這一份；登記在 `scripts/entrypoints.catalog.json` 的 `steps-block`。

## 各顯示面

| 顯示面 | 做法 |
| --- | --- |
| App 閱讀畫面（`MarkdownRenderer`） | `code` 覆寫遇到 `steps` 就畫 `StepsFigure`（`lazyWithReload`，沒有逐步圖的筆記不下載）。每一步用同一個 `MarkdownRenderer` 畫（`steps={false}`，不遞迴；步驟內的任務框唯讀）。畫好後 `StepsFigure` 的 effect 動態載入 `@onden/markdown/steps-enhance` 把它接成播放器。 |
| 編輯器 | 第一版編輯時看原文，和 mermaid 一樣；只多了 `/` 插入樣板。 |
| 卡片（白板） | `CardNode` 傳 `steps={false}`：維持程式碼區塊。理由：白板一次畫上百張卡，每張再載入播放器與逐步內容不划算，且卡片不能操作播放器。 |
| 發布網站 | `siteMarkdown.tsx` 傳 `stepsView={StepsFigure}`：伺服器端把每一步依序畫成清單（標題＋內容），沒有 JavaScript 就是這樣。有逐步圖的網站（`usesStepsBlocks`）才帶 `SiteSteps.astro` 的小程式，它載入 `steps-enhance` 把清單變播放器；不依賴 React。 |
| 匯出（HTML／PDF／Word） | 這些是給其他程式讀的檔案：`expandSteps` 把區塊展開成「說明＋每步一個 `###` 標題＋內容」。`md2html`（單篇與 zip／靜態主機的 HTML）與 `noteExportDocx` 都先展開。 |
| Onden 自己的匯出／備份（Markdown 檔、zip 內的 .md） | 保留原本的 fence，能原樣匯回。既有匯出選項只有 Markdown／HTML／PDF／Word，沒有另外「給其他 App 用的 Markdown」，所以沒有新增選項。 |
| 列印 | `@media print`：隱藏控制列，全部展開、避免步驟被切半。 |

### 發布網站與 CSP／sanitize

- 步驟內容和其他內容一樣經過 `published` profile 的 rehype-sanitize；步驟標題由 React 當文字輸出。測試確認步驟裡的 `<script>` 只會變成文字。
- 播放程式是網站自己的模組（`/_astro/*.js`，`'self'`），沒有新增內嵌程式，靜態頁 `script-src` 仍只允許 `'self'` 與內嵌程式的 hash（`withCsp` 對最終 HTML 內的內嵌 `<script>` 算 hash），政策沒有放寬。匯出的 HTML 不帶任何程式。
- 控制列的文字來自 `data-l-*` 屬性（站台語言的字串，伺服器寫入），不是在瀏覽器端組 HTML。

## 播放器（`stepsEnhance.ts`，唯一一份）

標記契約：`.md-steps[data-steps]` > `.md-steps-stage` > `section.md-step[data-step-title]`。播放器加上 `.is-player`、控制列（◀ 狀態文字 ▶ 全部展開）、`.is-active`。

- 所有步驟疊在同一個 grid 格子，高度＝最高一步，切換不跳動；非作用中的步驟 `visibility:hidden` 且 `inert`、`aria-hidden`。
- 聚焦時 ←→（PageUp／PageDown、Home、End）換步；手機左右滑（`touch-action: pan-y`，位移夠大且橫向為主才算，垂直捲動不受影響）；「全部展開」切換成一欄列出所有步驟。規則在 `stepsNav.ts`（純函式）。
- 淡入淡出用 CSS transition；`prefers-reduced-motion` 時不播過場（CSS 關掉 transition，程式碼過場不啟動）。「減少動態」目前只有作業系統這一個來源。
- **App 與網站共用同一個播放器**（App 的 `StepsFigure` 只畫標記並接上它）。取捨：播放器用原生 DOM 建控制列，因此沒有用 `components/ui` 的按鈕（那是 React 元件，網站沒有 React）；樣式用 `--ac-*` 變數、尺寸與觸控目標與 ui 按鈕一致。換來的是兩邊的行為不可能分歧。

### 已知限制

- 步驟裡的 mermaid 圖與 onden-query／onden-base 區塊：發布時的預排（流程圖）與凍結查詢只掃整篇筆記的頂層區塊，不會進到步驟內文；步驟裡的查詢區塊在網站上會顯示「結果未包含」，mermaid 維持程式碼。需要時再讓預排／凍結流程遞迴讀 `parseSteps` 的步驟。
- 步驟內的任務框唯讀（索引會對不上整篇筆記）。
- 手機上觸控從「可橫捲的程式碼區塊」開始，是捲程式碼，不換步；從其他地方橫滑才換步。聚焦在步驟內容裡時，Home／End／Page 鍵留給頁面，只有方向鍵換步。
- 發布網站的深色：樣式讀網站自己的 `--s-*`（跟網站的淺深色走），不讀固定淺色的 `--ac-*`。
- `/` 樣板的步驟標題是英文（樣板是共用字面值，維持開機包不變大）。

## 程式碼平滑變化（第 2 層）

相鄰兩步中「位置相同（第 n 個程式碼區塊）、語言相同」的程式碼區塊：沒變的行從舊位置滑到新位置，新增的行淡入並短暫標註（淡色背景約 1.4 秒），刪掉的行淡出（FLIP：量前後位置，用 transform 過場）。其他內容照第 1 層淡入淡出。

- **行對應**在 `@onden/markdown` 的 `lineAlign.ts`（`alignLines`），App 與網站的播放器是同一個播放器，所以同一份。做法：去掉頭尾相同行 → 最長共同子序列保持順序 → 剩下文字相同的行配對（「搬移」的行滑過去，不是淡出再淡入）。比較時去掉前後空白，所以包進迴圈而縮排改變的行仍視為同一行。超過 25 萬格的 DP 跳過（仍會配對相同文字）。
- **為什麼不用現有的差異程式**：`textPatch.ts` 是字元層級、為雜湊與修補而生（產出 hunks），拿不到「新行 n 對應舊行 m」；前端 `lib/lineDiff.ts` 正由 `feat/text-compare` 刪除，不複製。行對應需要的是配對表而不是修補，所以另寫（約 60 行），放在共用套件、有測試，之後文字比較若需要行配對可以重用。
- **畫法**：不改步驟自己的節點（React 的樹保持完整）。`flipCode` 把新步驟的程式碼切成一行一個元素（`splitCodeLines`，跨行的上色 span 在每行重新開啟），疊一個覆蓋層：保留行從舊位置 `translateY` 到 0，新行淡入，刪掉的行以舊位置絕對定位後淡出；覆蓋層期間原本的 `<code>` 隱藏，結束或被新的選擇打斷時移除並還原。每行高度＝程式碼區塊高度／行數（等寬、不折行）。
- **上色**：沿用既有 highlight.js 管線（`highlight.ts`、`lazy.ts`），沒有引入其他上色套件；步驟是用同一個 `MarkdownRenderer` 畫的，過場只是搬已上色的 DOM。

## 第 3 層的預留（尚未實作）

樹／圖／陣列的補間動畫會需要「這個元素在前後兩步是同一個東西」。已留的介面：

- `playStepChange(from, to, reduced)`（`stepsEnhance.ts`）是兩個 `.md-step` 之間的過場總入口，現在只配對程式碼；第 3 層在這裡加配對器（例如 mermaid 節點以 id/標籤配對）。
- `pairedCodes` 與 `alignLines` 是「前後兩步配對 → 位置差 → FLIP」的樣板：配對表是純資料，過場只讀配對表。
- 步驟內容是普通 Markdown，不需要新語法；若要明確指定配對，預留在步驟標題後的行內屬性（沿用 `remarkInlineAttrs`），尚未定義。

## 測試

- `@onden/markdown`：`stepsBlocks.test.ts`（分步、說明、四反引號內含程式碼、空步驟、一步、展開、偵測）、`lineAlign.test.ts`（插入、刪除、搬移、重複行、縮排）、`stepsNav.test.ts`。
- 前端：`test/stepsEnhance.test.ts`（按鈕、鍵盤、滑動、全部展開、減少動態、行切分、過場）、`test/stepsBlock.test.tsx`（App、卡片、發布站伺服器端、sanitize）。
- 後端：`test/stepsExport.test.ts`（匯出展開、無程式）。
