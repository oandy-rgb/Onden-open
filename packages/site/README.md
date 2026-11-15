# @onden/site

網站改版（`docs/architecture/proposals/publish-redesign-2026-10-24.md`）中，不只一處要用的部分。
這個階段（P1a）只有套件本身，應用程式還沒有用它。

## 兩個出口

**`@onden/site`**（沒有 React，也不引入 Puck；後端與前端共用，建置成 `dist/`）

| 匯出 | 用途 |
| --- | --- |
| `SiteDesign`、`SiteBoxes`、`PuckData` | 設計 v3 的型別（網站由「盒子」裝「零件」組成；舊首頁的 `PuckData` 只在 `legacy_home` 留存） |
| `validateDesign(input, fallback?)` | 任何儲存的值 → 合格的設計＋問題清單；不丟例外；v2 會搬遷成 v3，其他版本回預設設計 |
| `walkHome(home, fn)` | 走過首頁每個組件（深度、父層、slot 名稱） |
| `defaultDesign()` | 沒有設計時的預設（設計 v3：簡單首頁＋筆記花園的筆記頁與標籤頁；不必先指定首頁筆記或標籤） |
| `defaultDesignV2({ homeNoteId, topTagId })`、`migrateV2(v2)` | 舊的 v2 預設與 v2 → v3 搬遷（沒改過的首頁成為新預設，改過的留作 `legacy_home`） |
| `STYLE_PRESETS`、`styleVars(style, { mode, viewport })`、`styleCss(style, selector)` | 四種氣質；字級、間距、字體與淺／深兩套顏色（`--s-*`）都由「氣質、重點色、配色」三個選擇算出 |
| `schemeColors(accent, mode, tint)`、`contrastRatio` | 一個重點色算出淺或深一套顏色；內文對比 ≥ 7、連結與按鈕字 ≥ 4.5（`palette.test.ts`） |
| `bracesBalanced`、`scopedCss(design)` | 全站／零件 CSS 的括號檢查與範圍化 |
| 註冊表（`PARTS`、`CONTENT`、`PATTERNS`、`OUTER_SLOT_ALLOW`…） | 組件、slot、屬性與巢狀規則的資料 |
| `expandPattern`、`patternDefaultSlots` | 區塊範本的「展開成零件」與預填內容 |
| `withImplicitStacks(home)` | 頂層內容的預設 `stack`（只用來畫，不存） |

**`@onden/site/react`**（前端專用，從原始碼打包）

- `createPuckConfig(opts)`：Puck `Config`（欄位、`allow`、範本、中文標籤、分類）。`opts.fields` 換掉筆記／標籤／檢視的欄位（工作室用它接選擇器）。
- `SITE_CLASSES`：`siteParts.css` 裡所有 `.s-*` class（工作室列給使用者寫 CSS 時參考；測試比對樣式表，不會漂移）。
- 渲染組件在 `puck.metadata`（`SiteRenderMeta`）讀內容，可在 `react-dom/server` 輸出，沒有 hooks。
- `@onden/site/react/siteParts.css`：零件與內容的樣式，尺寸全來自 `--s-*` 變數，不用 media query。

## 巢狀規則（`validateDesign` 與 Puck `allow` 同一份資料）

- 頂層什麼都能放：內容（筆記、標籤檢視、時間軸）直接放在頂層，版面（零件、範本）是想排版時才加。
  頂層的內容沒有 slot，不會巢狀。畫面上（發布的網站、編輯器預覽）把每個頂層內容當成包在一個預設 `stack` 裡來排
  （`withImplicitStacks`，只用來畫，不存），所以長相與舊版自動包 `stack` 的結果一致（`render.test.tsx` 逐字比對 HTML）。
- 舊資料不 migrate、不改寫：已被包進 `stack` 的內容照原樣顯示；只有新放在頂層的內容是平放。
- 頂層零件的 slot 放內容或內層零件；內層零件只有 `stack`、`cards`、`switcher`，它們的 slot 只放內容。
- 範本的 slot 只放內容。`sidebar`、`cover`、`center` 只能在頂層。最多 3 層（零件→內層零件→內容），整份最多 200 個組件。
- Puck 的 slot `allow` 只讀靜態 `fields`，每種組件一份，分不出深度；`resolveFields` 收窄的欄位**不影響拖放**（P3a 在 Puck 0.23 原始碼與測試確認）。
  所以 `createPuckConfig` 的 `allow` 是「頂層零件」那一份，內層的限制由資料檢查擋：前端工作室的 `nestingViolation`
  （`packages/frontend/src/modules/website/studio/designModel.ts`）在資料變成不合規時還原並提示，存檔前 `validateDesign` 再把關。

## 測試

`npm test`（在這個目錄）；建置 `npm run build`（會先建置 `@onden/markdown`）。
