# 近期更新算不算深模組：網站發布與工作室

> 狀態：歷史紀錄（最後確認 2026-11-01）

審查日期 2026-10-27。範圍 PR #669 #680 #683 #713 #714 #725 #732 #740 #753 #771 #772 #774 #776。
只讀程式碼（`.ts/.tsx/.astro/.sql/設定/測試`），沒讀任何 `.md`；判斷依據是 `origin/main` 現況。
沒有跑 `tsc`／測試，下面全是讀碼結論。#694 #698 #699 #704 #706 #712 未合併，不計入。

## 一句話結論

**大致算深模組。** 網站、zip、GitHub Pages 確實只有一條 SSR 輸出路徑；首頁設計資料只有 `@onden/site` 一份定義與驗證；
連結預覽、連到這裡的那一句、閱讀時間都走 `@onden/markdown`。
扣分在細節：同一個概念在前端又寫了一份（閱讀時間規則、「標了發布卻不上線」的判斷、設計資料型別、巢狀規則），
以及工作室 UI 幾乎不用 `components/ui`；P5 清舊網站留了少量殘留。

## 每組判定

| 組 | PR | 新模組入口檔 | 介面大小 | 深度 | 整合度 | 判定 |
|---|---|---|---|---|---|---|
| A 靜態輸出（一份 HTML） | #683 #680 #714 | `backend/src/services/publishing/siteBundle.ts`（`ensureSiteBundle`、`storedSiteBundle`、`readSearchIndexFile`）；`staticSite.ts`（`buildStaticSite`、`retargetStaticSite`） | 對外 3 個函式，呼叫端只問「現在的網站副本」 | 5：快取鍵、原子改名、併發共用、淘汰舊副本都藏在裡面（`siteBundle.ts:70-155`） | 4：zip、Pages、站內搜尋三個消費者都走它；`staticSite.ts` 匯出的內部函式偏多 | 算深模組 |
| B 清掉舊網站（P5） | #713 | `134_remove_old_site.sql`、`publishing/index.ts` | 入口收窄成一個 index | 4 | 3：刪得徹底，但有幾處殘留（見問題 5、6） | 部分算 |
| C 工作室 v2 資料 | #669 #771 #732 #753 #776 | `packages/site/src/`（`validate.ts`、`registry.ts`、`design.ts`）；`studio/designModel.ts` | `validateDesign(input)` 一個函式把任何值變成合法設計 | 5：夾限、去重 id、巢狀、CSS 長度都在裡面 | 4：前後端都呼叫同一個；但巢狀規則在 3 處各寫一次，型別 3 處各寫一次 | 算深模組（有重複） |
| D 標誌／素材 | #725 #740 | `studio/SiteImageField.tsx` | `{label, value, onChange}` | 4：格式檢查、上傳、失敗回復桌面與手機共用 | 4：走 `lib/data` 的 `uploadMedia`、`writeErrors` | 算深模組 |
| E 閱讀（預覽、連到這裡、閱讀時間） | #772 #774 | `markdown/src/linkContext.ts`（`linkPlaces`）、`readingTime.ts`（`readingMinutes`）；`siteFrame/siteModel.ts` | `linkPlaces(markdown, {isTarget,isEmbed})`、`readingMinutes(markdown)` | 4：純文字進、片段出；不知道網站 | 3：站內走 markdown，但 app 內另有一套閱讀時間（問題 2） | 部分算 |

## 你問的五個問題

1. **網站、zip、GitHub Pages 是不是同一個 SSR 渲染入口？是，沒有第二條路。**
   `staticSite.ts:1-16` 開頭就說明每頁都是向前端 SSR（`SITE_SSR_URL`）要的同一份 HTML；
   `buildStaticSite` 只負責抓頁、把 `/site/…` `/_astro/…` 改成相對路徑、打包媒體（`staticSite.ts:162-262`）。
   zip（`modules/website/routes.ts:195-226`，`ensureSiteBundle` + `archiver.directory(bundle.tree)`）、
   Pages 推送（`pagesPush.ts:30-31`，`ensureSiteBundle` + `retargetStaticSite`）、站內搜尋（`routes.ts:165-180`，`storedSiteBundle`）全讀同一份存好的副本。
   舊的 `blockRenderer.ts`、`staticBuilders.ts`、`seoFiles.ts`、`siteJson.ts` 已在 #683 刪除，main 上不存在。
   唯一還在的「另一種 HTML」是**單篇筆記匯出**（`singleNoteHtml.ts:42` → `md2html`），它不是整站，但有自己的一套樣式（問題 6）。
2. **P5 清掉舊網站後有沒有殘留？有，量小。** 見問題 5、6、7。
3. **首頁設計資料是不是一個模組定義與驗證？是。** 型別、元件登錄、預設、驗證都在 `packages/site/src/`
   （`design.ts`、`registry.ts`、`defaults.ts`、`validate.ts`）。後端在 `siteConfig.ts:226` 寫入時驗證、`frozenDesign.ts:37` 凍結時驗證；
   前端 `designModel.ts:25,31`、`HomeStudio.tsx:269`、`PhoneHomeStudio.tsx:279`、`siteModel.ts:52`（發布頁）都呼叫同一個 `validateDesign`。
   沒有前後端各一份驗證。重複的是型別與巢狀規則（問題 3、4）。
4. **連結預覽、連到這裡的那一句、閱讀時間是否走 `@onden/markdown`？是。**
   `siteModel.ts:8` 從 `@onden/markdown` 取 `linkPlaces`、`readingMinutes`、`noteSummary`、`plainText`；
   site 與 backend 沒有 import `unified/remark`（唯一例外 `htmlUtils.ts:11-14`，是 eslint 明文放行的組裝點，見「做得好」）。
   但有兩個小的手寫 regex 例外（問題 8）。
5. **「標了發布卻不會上線」的判斷是不是只有一處？後端是，前端另有一份。**
   後端單一來源 `publishedNodeIds`（`publishedSet.ts:~81`）：快照（`snapshot.ts:78`）、服務時下架（`servedSite.ts:95,188`）都用它，
   `leftOutNotes`（`publishedSet.ts:115`）用「標記的 − 已發布的」，由構造保證一致。
   前端 `publishBlocker.ts:18` 自己重寫了一遍「隱藏／空間不能發布」（問題 2 之外的問題 4），伺服器沒回 `left_out` 時才用（`PublishPreviewDialog.tsx:45`）。

## 問題清單（依嚴重度）

**1. 閱讀時間在 app 內與網站是兩套規則（中）**
- 現況：網站用 `readingMinutes`（`markdown/src/readingTime.ts:25`，四捨五入 `Math.round`、僅標準處理）；
  app 編輯器用 `lib/wordStats.ts:19-56`（`Math.ceil`、自己的一組 regex 去掉語法）。
  `readingTime.ts:1` 自稱「the one rule」，但 `wordStats.ts:2` 的檔頭也說自己服務「published pages」。
- 證據：同一篇 450 個字，網站與編輯器可能差 1 分鐘（`round` vs `ceil`）；兩邊的 CJK 範圍與每分鐘字數常數也各抄一份。
- 影響：作者在編輯器看到「3 分鐘」，發布後網站顯示「2 分鐘」。
- 建議：讓 `wordStats.ts` 的 `minutes` 改呼叫 `@onden/markdown` 的 `readingMinutes`，只留 `countWords`。

**2. 「發布會不會上線」前端重寫一份，且有死碼與過期註解（中）**
- 現況：`publishBlocker.ts:18-29` 在前端重算「隱藏／空間不能發布」，註解還指向已不存在的
  `backend services/publishing/collections.ts`（檔案已刪）。`onSiteNotes`（`publishBlocker.ts:27`）在 production 零呼叫端（只有 `publishBlocker.test.ts:3,32`）。
  `"_published"` 字串在前端 3 處各寫一次（`PublishShareAction.tsx:24`、`introSite.ts:29`、`studio/editorData.ts:18`），後端是 `PUBLISHED_KEY`（`systemAttributes.ts:7`）。
- 影響：前端離線預測可能與後端不一致（例如後端已有「讀取限制標籤」，註解自己承認前端不評估）。
- 建議：刪 `onSiteNotes`；三個 `_published` 常數收成一個匯出；註解改指 `publishedSet.ts`。前端預測可保留（離線要用），但標明「只是預測」。

**3. 首頁資料型別 3 處各定義（中）**
- 現況：`SiteRow` 在 `site/src/react/meta.ts:7`（`fields?: Record<string,string>`）與 `backend/.../siteRows.ts:14`（`fields: Record<string,string|null>`）各一份且不相同；
  `TagPageData`（`frontend/.../siteModel.ts:13`）對 `SiteTagPage`（`siteRows.ts:29`）；`FrozenDesign`（`siteRows.ts:119`，`home/style/frames` 用 `unknown`）對 `SiteDesignData`（`siteModel.ts:15`）。
- 影響：改一邊欄位，另一邊編譯不會報錯，直到畫面出錯；`string|null` 與 `string` 的差已經是現成的不一致。
- 建議：把 `SiteRow`、`SiteTagPage`、`FrozenDesign` 搬進 `@onden/site`（它已被前後端共用），兩端 import。

**4. 巢狀規則在 3 處各寫一次（中低）**
- 現況：`registry.ts:180-184` 匯出 `TOP_ALLOW/OUTER_SLOT_ALLOW/INNER_SLOT_ALLOW`，但 `validate.ts:97-100` 沒用，自己用 `kind` 與 `INNER_PART_TYPES` 再判一次；
  `designModel.ts:62-79` 的 `nestingViolation` 又用這三個 allow 清單依深度判一次。
- 影響：新增一種零件要同時改驗證器與編輯器兩套條件，漏一處就是「編輯器允許、儲存時被丟掉」。
- 建議：在 `@onden/site` 提供 `allowedAt(place, type)`，`validateDesign` 與 `nestingViolation` 都呼叫它。

**5. 舊網站殘留（低）**
- 現況：`overlaySiteConfig` 仍組出 `custom_css`、`site_bg`、`tokens.{accent,font,darkMode}`（`publishedSet.ts:31-32,56-60`），
  註解承認只有單篇匯出讀（`publishedSet.ts:28-29`）；`Manifest`（`types.ts:11-33`）仍是 `[key: string]: unknown` 的舊形狀。
  `publishInput.side_effects`（`routes.ts:58`）全前端無人傳，卻一路存進快照（`snapshot.ts:156,200`）。
  `backend/src/index.ts:21,38` 留了兩行「legacy router removed」註解。
- 建議：`side_effects` 欄位與兩行註解刪除；單篇匯出改用站台樣式後，連同 `Manifest.tokens` 一起收掉。

**6. 單篇匯出是第二套樣式（低）**
- 現況：`css.ts`（190 行）是另一套主題 CSS（`buildNoteExportCss`，`css.ts:100`），與站台的 `site-tokens.css` + `style.ts` 的 `styleCss` 並存；唯一呼叫端是 `singleNoteHtml.ts:12`。
- 影響：站台改風格（安靜／紙本／書冊／手寫），單篇匯出不跟著變。
- 建議：先確認要不要保留這個功能；要保留就用 `@onden/site` 的 `styleCss`。

**7. 工作室 UI 沒用 `components/ui`（低中）**
- 現況：`studio/`、`phone/` 零個 import `components/ui`（只有 4 個發布對話相關檔案有，`PublishLeftOut.tsx:5` 等）；
  但有 `<button` 約 52 處（`PhoneHomeStudio.tsx` 20、`HomeStudio.tsx` 9、`fields.tsx` 7…）。
  `InsertMenu.tsx:22` 自己做 popover 並加 `eslint-disable onden/modals-through-ui-modal`（理由寫了：非模態）。
  `InsertMenu.tsx`、`BlocksPanel.tsx`、`StyleChoices.tsx`、`fields.tsx` 等 11 個檔案 0 次 `useT`，中文直接寫死（如 `InsertMenu.tsx:22,31`）。
- 影響：焦點、鍵盤、手機尺寸行為各畫各的；新增一個 Popover 規則時工作室不會跟到。
- 建議：把 `InsertMenu` 改用 `usePopover`/`Popover`，其餘 `<button>` 換成 `Button`；先處理 `InsertMenu` 與 `SiteImageField` 兩個最獨立的。

**8. 站台手寫兩個 Markdown regex（低）**
- 現況：`siteModel.ts:244-246` 的 `coverImage` 用 regex 取第一張圖；後端 `siteRows.ts:53` 的 `firstImageUrl` 又寫一次（還處理 `<img>`），
  兩者規則不同（前者不略過程式碼區塊，後者會）。`siteModel.ts:253` `usesDiagrams` 亦手寫 mermaid 偵測。
- 影響：文章封面與卡片圖可能選到不同張圖。
- 建議：在 `@onden/markdown` 加一個 `firstImage(markdown)`，前後端共用。

**9. `staticSite.ts` 的 regex 改寫 HTML（推測：低）**
- `localizeHtml`、`localizeScript`（`staticSite.ts:121-146`）以 regex 改寫 SSR 輸出與 Vite 打包後的程式碼片段（`function(e){return"/"+e}`）。
  這是壓縮後輸出格式的耦合，建置工具升級時可能失效；目前有 `liveOnlyRefs`（`staticSite.ts:140`）與測試守住「不可殘留絕對路徑」。屬風險而非現有錯誤。

## 做得好、值得保留

- **單一輸出入口 + 內容鍵快取**：`currentBundleKey`（`siteBundle.ts:60-66`）把格式版本、前端建置、快照、下架後內容一起雜湊，下架立即讓舊副本失效；先寫臨時資料夾再 `rename`（`siteBundle.ts:130-139`），讀者只看到完整副本。介面小、藏的複雜度很大，是這批最深的模組。
- **下架優先於舊快照**：`applyTakedown`（`servedSite.ts:46-90`）在服務時只減不增，連首頁區塊與標籤頁都過濾。
- **後端單一出口**：`publishing/index.ts` 把內部檔案藏起來，路由只 import 一個入口（`routes.ts:13-24`）。
- **`@onden/site` 的 registry as data**：驗證器、Puck 設定、渲染共用同一份登錄（`registry.ts:1-3`），新增零件基本只改一處。
- **Markdown 邊界有 lint 守住**：前後端 `eslint.config.js`（前端 `:99,:275`、後端 `:31,:56`）禁止 `unified/remark-*/rehype-*`，例外只有 `MARKDOWN_OWNERS`；`htmlUtils.ts` 的 `unified()` 是用 `ondenMarkdown` 的外掛清單組裝，不是自己的解析器。
- **`linkPlaces` 不認識網站**：由呼叫端傳 `isTarget/isEmbed`（`linkContext.ts:1-9`），所以是可測的純函式。
- **工作室走資料層**：`websiteWriter.ts` 全走 `lib/data` 的 `writersFor`／`reads`；website 模組沒有直接 `fetch`；樂觀鎖用 `design_stale`（`websiteWriter.ts:16-21`）。
- **新增的 eslint-disable 很少且都有理由**：整個範圍只 6 處（`HomeStudio.tsx:321`、`useHomeStudio.ts:86`、`InsertMenu.tsx:22`、`siteModel.ts:112`、`siteMarkdown.tsx:24`、`validate.ts:71`），沒有新增例外清單。

## 不確定、需要人確認

- 單篇匯出（`singleNoteHtml.ts`）是否還要保留獨立樣式？這決定問題 5、6 要刪還是改接站台樣式。
- `wordStats.ts` 的「字數」是否刻意與網站閱讀時間不同（例如編輯器想用 `ceil`）？若是，建議至少共用常數。
- 前端 `publishBlocker` 在離線時是否仍需要？若 `left_out` 永遠由伺服器提供，可整檔移除。
- 未合併 PR 的影響（推測，沒讀它們的內容）：#694 #698 #699 #704 #706 #712 若動 `lib/data` 或 `components/ui`，與問題 7（工作室改用 `components/ui`）會改到同一批檔案，建議先合重構再改工作室 UI。
- 沒有執行測試與 `tsc --noEmit`；以上「測試守住」只依檔案存在與內容判斷。
