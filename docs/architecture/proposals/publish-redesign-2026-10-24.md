# 發布改版：內容一律來自筆記，Puck 只管排版

> 狀態：提案（最後確認 2026-11-01）

狀態：**已決定，實作中**（2026-10-24 使用者：「照你建議」「全部做完我再驗收」）。
引用的路徑以 `packages/` 為根，以 `a390da88`（main，Puck 0.23 已合併 #595）為準。

示範（不是 Onden 程式）：
- 整體流程（筆記／工作室／網站）：https://claude.ai/artifact/5bgC48YkTAjHpawqqwixoS
- 首頁工作室與四層自由：https://claude.ai/artifact/5iARYwFpKqLP4AcgN3yiNs

## 1. 為什麼要改

使用者：「我認為要大改」、「最主要是組件不好用，跟 onden 無關的感覺」、「想用 Puck 是想多增加自由」。

用途：**數位花園／部落格**、**作品集／個人首頁**。更新方式：**維持整站一起發布**（快照模型 B，見 [site-render-model.md](../site-render-model.md)）。

現況的問題：
- 工作室 24 種組件（`frontend/src/components/templates/blocks.ts:3-6`）的文字都打在屬性面板裡，存在 `presentation.blocks`。筆記只透過「本文」組件進到網站。
- 同一組件兩份實作：前端 `blockRenders/*.tsx`、後端 `modules/website/publishing/blockRenderer.ts`。線上網站和 zip 長得不一樣（W38d 未做）。
- 一份組件清單套全站，個別頁面要靠 `pageBlocks`／`pageLayouts` 覆寫（`SiteTemplate.tsx:291-295`）。
- 集合（`CollectionsManager.tsx`、`/site/[collection]/[item]`）是另一套欄位與檢視，和標籤的檢視模組重複。
- 「刪除頁面」刪掉整篇筆記；分享連結打開是原始 JSON。

## 2. 決定

1. **網站就是已發布的筆記**，加上它們的連結、標籤與反向連結。
2. **只有首頁用 Puck 排版。** 文章頁、標籤頁由框架產生（只有開關）。
3. **首頁組件只指向內容，不存內容。** 筆記、`^id` 段落、標籤檢視、模組組件都只存 id；文字永遠在筆記裡改。
4. **四層自由**（研究與使用者心得見第 9 節）：
   1. 預設就好看，**發布永遠不需要先排版**；
   2. 精選風格（幾套主題預設）；
   3. 版面零件（可巢狀）＋全站設計參數；
   4. 全站與單一零件的 CSS（即時生效、括號不配對就不套用）、模組提供的組件。
5. **巢狀最多 3 層**：頂層零件 → 內層零件 → 內容。用 Puck slot 的 `allow` 擋住，不靠提醒。
6. **區塊範本**：常見組合（介紹＋近況、作品卡片、三欄入口、時間軸）一鍵插入，預設只換內容；要改結構再「展開成零件」。
7. **沒有自由座標，沒有逐斷點覆寫。** 零件依容器寬度自己換排法（Every Layout），手機上不用另外調。
8. **建議不自動套用**：預覽後才套用。
9. 第 8 節原本的 5 個問題全照建議：
   - 只有首頁用 Puck；
   - **移除**分享連結（`/api/share`）與學員 token 模式（`siteAccess.ts` 的 token）；網站一律公開，不想公開就不發布；
   - **保留** GitHub Pages 推送，改推送靜態 HTML；
   - 日期只在「日期標籤」（預設 `#文章`）的筆記顯示；
   - 舊的網站設計資料（24 種組件、`pageBlocks`、集合設定）**不搬**，改版時清掉，部署前照例備份。
10. **移除集合**：作品集與部落格列表由標籤頁與「標籤檢視」組件取代。

## 3. 頁面類型與網址

| 頁面 | 網址 | 怎麼產生 |
|---|---|---|
| 首頁 | `/site/` | Puck 版面（`<Render>`，伺服器端） |
| 文章頁 | `/site/<slug>/` | 文章頁框架 + 筆記本文 |
| 標籤頁 | `/site/tag/<slug>/` | 標籤頁框架 + 該標籤的第一個檢視 |
| 404、搜尋 | 固定 | 主題提供 |

只要筆記已發布就有文章頁；標籤至少有一篇已發布成員、且在網站上可見（`siteShowsTagSql`），就有標籤頁。`/site/[collection]/[item]` 移除。

## 4. 框架

**文章頁框架**的開關：導覽、封面（本文第一張圖）、日期（只限日期標籤）、標籤、資訊卡（標籤欄位，見下）、反向連結、上一篇／下一篇、目錄（寬螢幕右欄）、左欄筆記樹、頁尾。閱讀寬度與字級由框架固定（約 34em），字型與配色跟全站風格。

**標籤頁框架**：導覽、標籤名稱與說明（標籤筆記的本文）、該標籤第一個檢視的已發布成員、頁尾。

**資訊卡**：標籤欄位要在網站上顯示，必須在標籤頁把該欄位勾成「公開」，預設不公開（Tana 的教訓）。這一項排在後續，不在本次 P1–P5。

## 5. 首頁：Puck

### 5.1 組件

| 類別 | 組件 | 屬性（只能選，不能打字） | slot |
|---|---|---|---|
| 零件 | 堆疊 `stack` | 背景、標題（自動用內部標籤名稱／不顯示） | 1 |
| 零件 | 側欄 `sidebar` | 側欄在左／右、寬度窄／中 | 2（側欄、主要） |
| 零件 | 並排 `switcher` | 2–4 塊 | 2–4 |
| 零件 | 卡片格 `cards` | 卡片大小小／大 | 1 |
| 零件 | 主視覺 `cover` | 高度中／高 | 1 |
| 零件 | 置中 `center` | 寬度窄／寬 | 1 |
| 內容 | 筆記 `note` | 哪篇、整篇或某一段（`^id`）、全文／第一段／卡片 | — |
| 內容 | 標籤檢視 `tag_view` | 哪個標籤、它已有的哪個檢視、最多幾篇、排序 | — |
| 模組 | 例：時間軸 `timeline` | 哪個標籤、最多幾篇 | — |
| 固定 | 導覽 | 無（網站設定、釘選頁面） | — |

- 每個零件另有「進階」：一個 class 名稱與一段只作用在該零件的 CSS。
- **巢狀規則**：頂層什麼都能放，內容直接放在頂層（2026-10-26 起；原本會自動包一層堆疊，見 `docs/agents/decisions-ui.md`）；零件的 slot 可放內容或「內層零件」；內層零件只允許 `stack`、`cards`、`switcher`，它們的 slot 只能放內容。主視覺、側欄、置中只能在頂層。
- **區塊範本**：用 Puck 的 `defaultProps`（預先填好 slot）做成的組件；插入後只換內容，面板上有「展開成零件」。
- 筆記組件指向未發布的筆記時：畫布上標「未發布」，發布預覽列出並提供「一起發布」。
- 筆記內容在面板上唯讀，附「到筆記裡改」；在畫布上雙擊文字直接改，存回那篇筆記（和點嵌入時編輯來源段落是同一個做法）。

### 5.2 資料存在哪裡

沿用現有 chrome 的存放與防覆蓋機制：**網站設定筆記（`#workspace-config` 節點）的 `presentation`**，寫入走 `setChromeBlocks` 的 `rev`／`ChromeStale` 保護（`backend/src/services/siteConfig.ts:220-`），前端走 `workspaceWriter.saveDesign`（autosave、離線副本、持久化確認，見 [website-writes.md](../website-writes.md)）。整份設計一次替換，不做行合併，所以不會有「JSON 被合併壞掉」的問題。

新形狀（`v: 2`）：

```ts
type SiteDesign = {
  v: 2;
  rev: string;                 // 既有的版本號
  studio_draft: true;          // 既有：真正的編輯草稿
  home: PuckData;              // 只存 id，不存內容
  style: { preset: string | null; base: number; ratio: number; density: "tight" | "mid" | "loose";
           head: "serif" | "sans" | "mono"; body: "serif" | "sans" | "mono"; accent: string; radius: number };
  css: string;                 // 全站 CSS
  frames: { article: Record<string, boolean>; tag: Record<string, boolean>; date_tags: string[] };
};
```

`v` 不是 2 的舊資料一律當成「沒有設計」，用預設設計（第 5.4 節），不轉換。

### 5.3 發布時固定（取代原本的 `resolveAllData` 構想）

網站從不執行查詢（D113）。發布時後端走一遍 `home`：
- `note`：確認在這次的發布集合；不在就列為「未發布引用」（預覽顯示），網站上那格不顯示。
- `tag_view`／`timeline`：用 App 的同一個查詢（`services/collectionViewQuery.ts` 的 `executeView`，以發布者身分），**只留已發布的筆記**，結果列（id、標題、slug、日期、檢視要的欄位、本文第一張圖）存進 `presentation.resolved[<組件 id>]`。
- 每個會出現在網站上的標籤：第一個檢視的已發布成員存進 `presentation.tag_pages[<標籤 id>]`。
- `siteDiff.ts` 的讀者 hash 納入 `home`、`style`、`css`、`frames`、`resolved`、`tag_pages`。

後端**不需要 React**：只是走 JSON、查資料。畫面一律由前端畫。

### 5.3a P1b 實作的 `presentation.design`（`/api/site` 的契約）

`payload.presentation.design = { v: 2, home, style, css, frames, resolved, tag_pages, tag_names }`，與網站設定（品牌、導覽、SEO）並存。
設計永遠取自設定筆記上已儲存的 `v: 2` chrome，沒有就用預設設計；請求 body 的 `presentation` 不影響設計。

- `resolved[<組件 id>]`：`tag_view`／`timeline` 的列，`SiteRow = { id, title, slug, date, fields, image, excerpt }`
  （`slug` 是網站實際的網址；`date` 是建立日 `YYYY-MM-DD`；`fields` 是檢視的可見欄位；`image` 只有 `https://`、`http://`、`/…`；
  `excerpt` 是已遮蔽私人連結的 Markdown 的第一段純文字，最多 140 字）。
- `tag_pages[<標籤 id>] = { name, slug, viewKind, rows }`：網站上可見且有已發布成員的標籤，第一個檢視（沒有就是成員新到舊），最多 100 列。
- `tag_names[<標籤 id>]`：首頁與標籤頁提到的標籤名稱（只有網站上可見的標籤）。
- 未發布的筆記引用只出現在 `POST /api/publish/preview` 的 `unpublished_refs`，不進 payload。
- 下架（`servedSite.applyTakedown` → `siteRows.takeDownDesign`）立即從 `resolved`、`tag_pages` 拿掉不再發布的筆記；`home` 不改。

### 5.4 預設設計

沒有設計（新工作區、舊資料）時：主視覺放首頁筆記第一段，下面一個堆疊放「最多文章的標籤」的清單檢視；風格用「安靜」。保證什麼都不做也能直接發布。

## 6. 畫面：一套渲染

新 workspace 套件 **`packages/site`（`@onden/site`）**：
- `@onden/site`（不含 React，前後端共用）：`SiteDesign` 型別、驗證（未知組件、巢狀超過規則、slot 數量）、走訪工具、預設設計、風格 → CSS 變數、CSS 範圍化與括號檢查。
- `@onden/site/react`（只有前端用）：Puck 組件設定（欄位、`allow`、範本）與**伺服器可畫**的 render 組件（不用 hooks、不碰 `window`），以及零件的 CSS。

| 出口 | 改成 |
|---|---|
| 線上 `/site/` | Astro SSR：框架由 Astro 畫；首頁版面用 `@puckeditor/core/rsc` 的 `<Render config data metadata>`，**不加 `client:`**，輸出純 HTML。`metadata` = 快照的 `nodes`、`resolved`。 |
| 文章頁、標籤頁 | Astro SSR + 框架組件，同一套風格變數。 |
| 互動 | 搜尋是頁首一支無框架的小腳本，查 Pagefind 索引（P4 第二輪）。首頁組件第一版全部靜態（月曆、看板檢視先畫成清單）。 |
| zip 下載、GitHub Pages | 由前端伺服器把每一頁的 SSR HTML 存成靜態檔（含 CSS、圖片），zip 與 Pages 用同一份輸出。刪除後端 `blockRenderer.ts` 與 `staticBuilders.ts` 的版型部分（W38d 完成）。 |
| RSS | 全文，`published` profile。 |

已驗證（2026-10-24）：`@puckeditor/core/rsc` 的 `Render` 與 `resolveAllData` 在一般 Node 的 `renderToString` 下可用，slot 巢狀與 `metadata` 正常（0.21.3 實測；0.23 同一入口）。

## 7. 工作室

三欄：左「素材」（筆記、標籤、區塊範本、版面零件、模組組件、大綱）、中「畫布」（桌面／手機寬度切換）、右「屬性｜風格｜建議」。

- **素材拖進畫布**：用 Puck 的 composition（`Puck.Preview`、`Puck.Fields`、`Puck.Outline`）與 `Drawer.Item`，筆記和標籤清單來自本機資料。
- **風格**：四套精選風格（安靜、報刊、作品集、手作）；參數：內文字級 14–20、標題比例 1.2／1.25／1.333／1.414、間距緊／中／鬆、標題與內文字體（明體／黑體／等寬）、重點色、圓角；全站 CSS 與可用變數清單。
- **建議**（預覽後才套用）：未發布的引用、手機上卡片太多、空的 slot、全站 CSS 括號不配對、頂層超過 5 塊。
- **介面中文化**：Puck 0.23 的 `dictionary`。
- **頁面清單與「刪除頁面」移除**：哪些筆記上網站由筆記的發布開關決定；工作室只列出已發布的筆記，「從網站移除」= 取消發布，永遠不刪筆記。
- **手機**（使用者 2026-10-24）：手機可以發布（先看預覽）。手機上**不載入 Puck 編輯器**，改用 Onden 自己的清單介面，改的是同一份設計資料；畫面下方用同一套 render 組件畫預覽。手機上只有：
  - 換一篇筆記、換標籤檢視；
  - 上下調整順序、刪掉一塊；
  - 插入區塊範本；
  - 換精選風格、調內文字級；
  - 發布。
  建立零件、巢狀、拖曳、CSS、單一零件的進階設定在手機上**完全不顯示**，也不放「到電腦上調整」的提示。

## 8. 實作階段

每一階段一個 PR，雲端代理（Sonnet 5.5）實作，我在本機跑 e2e 驗收後合併；全部完成後由使用者一次驗收，**說「部署」才部署**。現在只有擁有者在用，不做新舊並存的相容層；P2、P3 合併後網站與工作室一起切換。

| 階段 | 內容 | 依賴 |
|---|---|---|
| **P1a** `@onden/site` | 套件骨架（建置、Docker、workspace）、型別、驗證、預設設計、風格與 CSS 工具、Puck 設定與 render 組件、零件 CSS；用 `renderToString` 的單元測試 | 無 |
| **P1b** 後端 | 設計 v2 的讀寫（沿用 chrome 存放與 `rev`）、發布時固定（`resolved`、`tag_pages`、未發布引用）、`/api/site` 新形狀、預覽差異與 hash | P1a |
| **P2** 網站 | Astro 首頁 `<Render>`、文章頁與標籤頁框架、`/site/tag/[slug]`、風格變數與 CSS 注入、日期標籤 | P1a、P1b |
| **P3** 工作室 | 新的 Puck 工作室（素材拖曳、範本、巢狀規則、屬性、風格、建議、中文化、雙擊改筆記、手機模式）；移除頁面清單 | P1a、P1b，可與 P2 並行 |
| **P4** 輸出 | zip 與 GitHub Pages 改用 SSR HTML；RSS 全文；刪 `blockRenderer.ts`、`staticBuilders.ts` 版型部分 | P2 |
| **P5** 清除 | 舊 24 組件、`pageBlocks`／`pageLayouts`、集合、分享連結、學員 token 模式；相關 e2e 換成新的 | P2、P3、P4 |

### P2 實作備註（網站頁面）

- 首頁、文章頁、標籤頁都是 SSR HTML，沒有 `client:`；頁首搜尋在 P2 是一個 island（`SiteSearch.tsx`），P4 第二輪換成無框架的 `SiteSearch.astro` 加 Pagefind（見下）。
- 標籤頁與首頁的標籤檢視共用 `@onden/site/react` 的 `RowsView`，沒有第二份清單／卡片／表格實作。
- 內文的 `[[連結]]` 與凍結查詢結果一律是 `<a href>`（`MarkdownRenderer` 的 `linkHref`），不再是按鈕。
- 頁面沒有 script，所以 mermaid 圖留成程式碼、程式碼區塊的「複製」按鈕隱藏；P4 以極小的漸進增強腳本恢復（見下）。
- `/site/<集合>/` 格狀頁隨集合一起不再提供（P5 移除集合）；`/site/<集合>/<項目>` 這一階段不動；`feed.xml` 在 P4 改為全文。
- canonical 與 sitemap 用 `APP_URL`（`lib/siteOrigin.ts`；compose 的 frontend 服務已帶入），沒設才退回請求的 origin。

### P4 實作紀錄（輸出，2026-10-24）

- **一份靜態輸出**：`backend/src/modules/website/publishing/staticSite.ts` 的 `buildStaticSite` 是 zip（`GET /api/export-static`）與 Pages 推送共用的唯一入口。
  它向前端 SSR 伺服器（`SITE_SSR_URL`；`compose.yaml` 預設 `http://frontend`，本機 `http://localhost:4321`）取每一頁的 HTML，不再有第二個渲染器。
  頁面清單來自前端的 `/site/static-pages.json`（`lib/siteStatic.ts` 的 `sitePagePaths`，與頁面讀同一份已發布快照扣掉下架），
  所以輸出只有網站實際提供的頁面，下架的筆記沒有頁面。沒有採「前端一次回傳整包」：那需要在前端另做打包與圖片處理，而逐頁取已經是同一份 HTML。
- **輸出內容**：`site/index.html`、`site/<slug>/index.html`、`site/tag/<slug>/index.html`、`404.html`（取自不存在的位址，必須回 404）、`site/feed.xml`、`site/sitemap.xml`、
  `robots.txt`、根目錄 `index.html`（導向 `site/index.html`）、`.nojekyll`、頁面實際引用的 `_astro/*`（樣式、字型；舊格式 woff／ttf 不放，woff2 在前）、`media/*`（沿用 `bundleSiteFiles`）。
- **位址一律相對**：`localizeHtml` 把 `href`／`src` 的 `/site/…`、`/_astro/…` 改成相對該頁的路徑，頁面連結寫成 `…/index.html`（zip 從磁碟開、任何靜態主機、Pages 子路徑都能用）；
  `/api/media/…` 由既有的 `bundleSiteFiles` 改成 `media/…`。`404.html` 可能在任意深度被主機回傳，有 Pages 網址時改成該網址下的絕對路徑，否則相對於根目錄。
- **Pages 推送**：保留既有的 repo／token／CNAME 設定；推送內容與 zip 相同。Pages 有自己的網址時（`expectedPagesUrl`），canonical、sitemap、feed、robots 的網站位址換成 Pages 網址。
  學員 token 模式（P5 才移除）的網站，推送仍是空白且 noindex 的一頁；zip 帶其中一個 token 取頁。
  不再讀取 `dist-published`（SPA 外殼）與 `site.json`：`pagesPush.ts` 的 SPA 組裝、`seoFiles.ts`、`siteJson.ts` 刪除。`dist-published`／`build:published`／`published_bundle` 磁碟區已在 P5 刪除。
- **搜尋**：第一輪先在靜態副本隱藏；第二輪改為 Pagefind，線上與靜態同一份索引（見「P4 第二輪」）。
- **mermaid 與複製按鈕**：兩者在線上與靜態輸出用同一份（`components/siteFrame/SiteCopyCode.astro`、`SiteDiagrams.astro`），沒有框架。
  複製按鈕：一個委派的 click 處理（腳本執行後才顯示按鈕）。mermaid：只有在已發布的筆記含 mermaid 圍欄時（`usesDiagrams`）頁面才帶腳本，腳本再動態載入 mermaid 並取代圍欄；語法錯誤的圖維持程式碼。
  靜態輸出會抓取該腳本與 mermaid 的延遲載入區塊（約 3 MB，沒有圖表的網站為 0），並把 Vite 預載輔助函式的根路徑 `"/"+dep` 改成相對自身。
  限制：模組腳本不能從 `file://` 開，圖表需經由靜態主機或本機伺服器；沒有圖表的網站在 `file://` 完全可用。
- **CSP**：靜態主機沒有標頭，`withCsp` 為每頁加 meta CSP（`script-src 'self'`＋頁面自己的 inline 腳本以雜湊放行＋擁有者選的分析主機），延續既有的第二道防線。
- **RSS 全文**：`feed.xml.ts` 每則帶 `content:encoded`（CDATA），內容是文章頁同一個渲染器（`siteMarkdown` 的 published profile）畫出的已發布筆記本文，
  站內相對位址以 `APP_URL` 轉為絕對；複製按鈕不放。來源是 `/api/site`（最新快照扣掉下架），未發布的內容不會出現。
- **單篇 HTML 匯出沒有搬**：`singleNoteExport` 輸出的是筆記「現在」的文字（可能還沒發布，query 區塊以匯出者身分計算），SSR 頁面只畫已凍結的快照、以網址取頁，
  所以保留 `singleNoteHtml.ts` 這條最小路徑（`md2html` ＋ 為它精簡的 `buildNoteExportCss`）。
- **刪除**：`blockRenderer.ts`、`staticBuilders.ts`（含舊 fallback 靜態站）、`seoFiles.ts`、`siteJson.ts`、`siteHome.homeSlugIn`、`css.ts` 的樣板主題與區塊版型 CSS，
  以及只測它們的後端測試（`blockStyle`、`staticExportNav`、`seoFiles`、`siteJson`，其餘改測新輸出）。
- **測試**：`staticSite.test.ts`（頁面集合只含清單內的頁、相對位址、資產抓取、CSP、Pages 位址換置）、`publishedCsp.test.ts`、前端 `siteStatic`／`siteFeedBody`／`usesDiagrams`；
  整合測試（`pagesPush`、`oneSiteSource`、`siteHomeAndMedia`、`publishRedaction.property`）改用 `helpers/fakeRenderer.ts`（依已發布網站回答前端合約的替身），但本環境沒有 Postgres，**未實際執行**。
  e2e（`zzDeepSite10`）改取 `site/index.html`，未能在此環境執行。

### P4 第二輪（輸出只做一次、Pagefind 搜尋，2026-10-24）

擁有者核准的兩個改動。

**1. 輸出發布時做一次，之後重用**（`modules/website/publishing/siteBundle.ts`）

- 內容只在發布時變（快照模型 B），所以每次下載 zip／推送 Pages 都重爬是白工。現在 `ensureSiteBundle` 是 zip、Pages 推送與線上搜尋唯一取得輸出的入口。
- **key** ＝ sha256（格式版本、`ONDEN_BUILD_ID`、快照 id、`loadServedSite` 的 payload）。payload 已經是「快照扣掉下架」，所以下架（或取消下架）一定換 key，
  舊輸出不可能被當成現在的網站；前端重新部署也會換 key（輸出帶的是前端的 CSS／腳本）。不另建資料表：每份輸出一個資料夾，`manifest.json` 最後寫入。
- **存放**：內容磁碟區 `content/site-bundles/<key>/{tree,manifest.json}`（沿用 `content_data`，無新磁碟區、無 migration）。先在 `.tmp-<key>-<隨機>/` 做完，再以一次 `rename` 換上；
  讀取端只認 32 位十六進位資料夾，因此看不到半成品。完成後只留最新 2 份（目前這份＋一份供正在讀取的下載），超過一小時的 `.tmp-*` 一併清除。備份腳本排除此資料夾（快取）。
- **何時做**：`enqueueSiteOutput` 在發布交易（`buildAndEnqueueSnapshot`）與下架重建（`republishSite`）中一起排入 `site_bundle` 與 `pages_push`，
  走既有 outbox（有重試、同工作區合併、不擋發布回應；`effectKindLabel` 顯示「網站下載副本」）。`pages_push` 不再自己爬頁，只讀存好的輸出再換上 Pages 網址
  （`retargetStaticSite`：canonical／sitemap／feed 的來源網址、絕對路徑的 404、robots、重算 meta CSP）；沒設 Pages 時直接略過。
- **按需補建**：zip 請求遇到缺或過期的輸出（部署後第一次、請求比排程工作早到）當場建；同一 key 同時多個請求共用一次建置（`inflight`）。
  建置途中網站又變了（下架）就丟掉這份重建，最多 3 次，不把可能混了兩個狀態的輸出存在任一 key 下。
- 線上 `/site` 仍是 SSR，**沒有改成讀存好的輸出**。

**2. Pagefind 搜尋**（`siteSearchIndex.ts`、`SiteSearch.astro`、`lib/siteSearch.ts`）

- 產生輸出時用 `pagefind` 的 Node API（`createIndex` → `addDirectory` → `writeFiles`，不用 CLI）把輸出索引，寫到輸出裡的 `site/search.idx/`，所以 zip 與任何靜態主機都帶著索引。
  資料夾名含句點：slug 不可能含句點，筆記不會佔到這個網址（Astro 以 `_` 開頭的資料夾不會成為路由，所以不用 `_pagefind`）。
- **索引範圍**：只索引筆記頁（`site/*/index.html`），且只索引文章框架標記 `data-pagefind-body` 的 `<article>`（標題、標籤、內文）；頁首、樹狀、目錄在 article 之外，反向連結、上一篇／下一篇用 `data-pagefind-ignore`。
  首頁與標籤頁只是筆記清單，索引它們只會讓同一篇出現兩次，所以不索引。標籤精確搜尋（舊的 `#tag`）不再支援；標籤頁仍可從文章的標籤瀏覽。
- **中文**：Pagefind 依頁面 `<html lang>`（網站語系，預設 `zh-TW`）斷詞，中文逐字索引，所以「資料結構」「二元」「演算法」不靠空白就能搜到（測試以真實二進位檔驗證）。
  限制：英文語系的網站若有中文筆記，中文不會逐字索引（語言跟頁面走）；Pagefind 在中文上有時只標出部分字，前端改標出使用者輸入的整段（`markTypedText`）。
- **線上與靜態同一份**：前端 `/site/search.idx/*`（`pages/site/search.idx/[...file].ts`）轉給 backend `GET /api/site/search.idx/*`，後者每次以「現在的網站」算 key 取存好的輸出，
  所以下架後舊索引立刻不再回答（回 503、背景開始建新的）；套用與 `/api/site` 相同的學員存取閘門，`ETag`＝key、`no-cache`。
  搜尋框預設 `hidden`，只有 `pagefind-entry.json` 讀得到才顯示；從 `file://` 開啟、線上尚無輸出、或沒有 script 時維持隱藏，不顯示壞掉的框。
- **CSP**：靜態頁的 meta CSP 只多一個 `script-src 'wasm-unsafe-eval'`（Pagefind 要編譯 WebAssembly）；它的 worker 與索引檔都是同源，由既有的 `script-src 'self'`／`connect-src 'self'` 涵蓋（worker-src 會 fallback 到 script-src），
  沒有加 `unsafe-eval` 或 `blob:`。線上 `/site` 目前只有 `frame-ancestors` 標頭，沒有 script-src，不受限，所以不用改。
- **刪除**：`SiteSearch.tsx` 與其測試（把整站內文當 island 屬性塞進每一頁）、`?static=1` 與 `wantsStaticCopy`（靜態與線上現在是同一份 HTML）。
- **驗證**：`pagefind` 1.5.2 的 `@pagefind/linux-x64`／`linux-arm64` 是靜態連結的 musl 執行檔，glibc（runtime 映像 bookworm-slim）與 alpine 都能跑；
  以 `npm ci --workspace=packages/backend --omit=dev` 在乾淨目錄重現 Dockerfile 的安裝，確認有裝到平台套件、Node API 能建索引，`ldd` 顯示 statically linked。沒有實際 `docker build`（本環境無 docker）。
- **測試**：`siteBundle.test.ts`（兩次 zip 只爬一次、同時請求共用、下架換 key 並重建、建置中只有暫存資料夾、失敗不留殘骸、只留最新 2 份、
  索引含中文且找得到、下架文字不在索引也不在任何檔案、線上讀法與靜態讀法同一結果、路徑不可跳出資料夾）、`staticSite.test.ts`（Pages 網址後處理、CSP、索引網址）、前端 `siteSearch.test.ts`。
  另以暫時的 mock 後端＋真實建置的 SSR＋Chromium 實測線上、Pages 子路徑 `/garden/`、`file://`、下架前後（不進版控）。
  需 Postgres 的整合測試（`publishReplay`、`outboxApproval` 等會排入 `site_bundle` 的）本環境無法執行。

### P3a 實作紀錄（桌面首頁工作室，2026-10-24）

- 工作室在 `frontend/src/modules/website/studio/`；`WebsiteScreen` 桌面載入它，手機仍載入舊工作室（`PhoneWebsiteScreen`，P3b 取代）。
- **Puck 0.23 實測**：slot 的 `allow` 只讀靜態 `config.components[type].fields`（拖放與外框都是），`resolveFields` 收窄的欄位不影響拖放，
  所以「內層零件只能放內容」擋不住拖曳。做法：工作室移除 `resolveFields`，`Bridge` 監看資料，不合 `nestingViolation` 就還原並提示
  「這裡不能放零件」；頂層的內容不再包堆疊（2026-10-26）；存檔前一律 `validateDesign`。
- **素材拖進畫布**：Puck 的 `Drawer.Item` 沒有屬性，也只有拖放才會觸發 `resolveData` 的 `insert`。做法：按下素材時記下要預填的
  筆記／標籤（`prefillRef`），Puck 回報 `insert`（`onAction`）時用 `replace` 補上；點一下則直接在選取之後插入（`insertAfter`）。
- 畫布只畫「會發布的內容」：未發布的筆記只顯示「未發布」，標籤檢視只列已發布成員。
- 雙擊畫布上有 `^id` 的筆記段落開既有的 `EmbedEditSheet` 改來源；沒有 `^id`（整篇、第一段）則開那篇筆記。

### P3b 實作紀錄（手機首頁工作室，2026-10-24）

- 手機在 `frontend/src/modules/website/phone/`：`PhoneWebsiteScreen` 載入 `PhoneHomeStudio`，**不載入 Puck 編輯器**（預覽用 `@puckeditor/core/rsc` 的 `Render`，與網站同一批 `@onden/site/react` 組件）。舊工作室只有手機會進入，所以一起刪掉：`WebsiteStudio`、`PuckStudioCanvas`、`WebsiteDesignPanel`、`CollectionsManager`、`useWebsiteMode`、`puckDictionary`、`editor.css` 與它們的測試。集合的後端、`introSite`、`PublishedSnapshots` 等仍被別處使用，留給 P5。
- 資料與儲存：和桌面是同一個 `useHomeStudio`（同一份設計、同一個 writer、`rev`／`design_stale` 處理、離線副本）；每個動作先過 `validateDesign` 再交給 `changeDesign`。發布走同一個 `PublishPreviewDialog`／`usePublishReview`，一定先預覽。
- 動作都在 `phone/phoneHome.ts`（純資料）：換筆記、換標籤檢視（標籤＋它的檢視）、上下移、刪除、插入區塊範本；風格＝四套精選風格＋內文字級 14–20。其他（建立零件、巢狀、拖曳、CSS、進階、零件內部結構）手機上完全沒有，也沒有「到電腦上調整」。
- 列：頂層一塊一列，用白話命名（筆記標題／「標籤檢視：名稱」／範本或零件名）；一塊裡**剛好只有一個**筆記或標籤檢視（巢狀也算）才出現「換筆記」／「換標籤檢視」，否則只能移動或刪除。時間軸只能移動或刪除。
- 插入範本：範本的內容槽（筆記、標籤檢視）要在插入前選好才能按「插入」，因為手機沒有零件內部編輯，插入空的範本之後沒辦法補。位置用「放在哪裡」選單（最前面／某一塊之後）。
- 換筆記只能從已發布的筆記選；換掉後原本選的 `^id` 段落一併清掉（段落屬於舊筆記）。未發布的筆記在預覽顯示「未發布」，標籤檢視只列已發布成員（與桌面畫布同一個 `buildEditorMeta`）。
- 共用：標籤的已存檢視清單抽成 `studio/savedViews.ts`，桌面欄位與手機選單共用（桌面行為不變）。

### P5 實作紀錄（清除，2026-10-24）

- **刪除（前端）**：舊 24 組件與舊頁面模型（`components/templates` 只留網站頁面還在用的型別與小工具）、SPA 發布包（`src/published`、`vite.published.config.ts`、`build:published` 等腳本、`intro-site.json`）、
  集合的網站頁（`/site/[collection]/[item]`、`PublishedCollectionPage`、`collectionWriter`）、學員 token（`sitePageAccess`、`?access=`、cookie、存取碼提示），以及隨之變死的 CSS、i18n 鍵、測試與 e2e。
  簡介網站流程改成存設定後以預設設計發布；發布請求只帶 `title`、`home_node_id?`、`presentation.site`。
- **刪除（後端）**：`/api/collections`、`/api/share`、`/api/site/access` 與 `/api/site`、搜尋索引、媒體的存取閘門；`publishing/share.ts`、`siteAccess.ts`；快照不再帶 `collections`、
  `template`／`tokens`／`blocks`／`pageLayouts` 等舊欄位（`presentation` 只剩 `site`、`design`）；`logPath.ts` 與 nginx 的 token 遮蔽。`publishing/collections.ts` 改名 `publishedSet.ts`，只留已發布集合、網站設定覆蓋與「被略過的筆記」。
  Notion／CSV 資料庫匯入原本借用集合服務建立列，改為自己的 `createImportedRow`（不再寫 `_status`）。
- **基礎設施**：`compose.yaml` 的 `published_bundle` 磁碟區與 `PUBLISHED_BUNDLE_DIR`、`deploy-site.yml`、`docs/deploy-static-site.md`、`dist-published` 的忽略規則；Pages 推送的行為改寫進 `docs/agents/deploy.md`。
- **資料**：migration 134（唯一一支，聲明 `-- drill: allows attributes`）：刪除分享連結／存取設定與舊設計設定屬性、非 v2 的網站設計、`#page` 筆記的版型屬性、全部 `_status`，並清掉快照內的集合與舊設計欄位及 `snapshot_media` 的 `item` 列。
  筆記、標籤、連結、v2 設計不動。**刻意未動**：標籤 schema 內的 `publish_collection`／`views`（標籤資料，無程式再讀）、保留的 `#page` 標籤本身、歷史事件（`SITE_SHARE_UPDATED`、`COLLECTION_SCHEMA_*` 仍可在歷史中顯示與復原）。
- **驗證**：見 PR。本環境沒有 Postgres 擴充（age／pgroonga／vector），整合測試未執行；migration 134 另以暫時的 PostgreSQL 16 與合成資料驗證（含重跑冪等）。

## 9. 依據

- **研究**：Jacobs 等（SIGGRAPH 2003）樣板與內容流分離；Lee 等（CHI 2010）範例幫助新手；Nouraei 等（Adobe 2024）樣板不能改會卡住；Reinecke 等（CHI 2013）第一印象由視覺複雜度決定；O'Donovan 等（CHI 2015）建議要讓人控制；Walsh 等（ISSTA 2017）響應式版面常壞；Archiwaranguprok & Toahchoodee（HT 2024）68 個數位花園的導覽方式。
- **設計方法**：Every Layout 的版面零件、Utopia 的字級與間距級距、Refactoring UI 的固定級距、WordPress `theme.json` 風格變體與 `contentOnly` 鎖定、Nathan Curtis「常用的做成選項，少用的才讓人組」、巢狀約 3 層的業界慣例。
- **使用者心得**：Bear Blog 作者與 Josh Tronic（改設計會吃掉寫作）、Squarespace 與 Wix 的比較（精選樣板較受好評）、Fluid Engine／Webflow／Framer（自由拖放在手機上壞、學習曲線陡）、Notion Sites 與 Ghost（自由太少使用者出走）、Obsidian Publish 的 CSS 抱怨（要可靠、要有介面）、WordPress 網站編輯器（一次存多個部分讓人困惑）。

## 10. 不在這次範圍

- 資訊卡的公開欄位、段落滑過預覽、2-hop 連結、白板地圖頁、成熟度模組、最近更新頁（下一輪）。
- 網站版本歷史與回滾、讓模組新增全新網站組件的通用機制（時間軸先內建示範）。

## 工作室 v2（2026-10-25）：取代 §7 的「素材」「風格」

- **版面分工**：左欄「區塊」只列區塊種類（內容、排版、文字與圖片、現成區塊），有搜尋；右欄「屬性」決定選到的那一格是哪一篇筆記或哪個標籤，並可篩選已發布／未發布、直接「發布這篇」。畫布上選取的格子旁有一直看得見的「＋」，`/` 開同一份區塊選單。
- **不能發布的空間**：`capabilities.publish !== true` 的空間的筆記不出現在工作室任何清單（選擇器、搜尋、標籤成員數、預設設計的候選）；已放在格子裡又被移進去的筆記，在畫布上顯示標題與「未發布」，「建議」仍提示換一篇。
- **風格只剩三個選擇**：氣質（安靜、紙本、書冊、手寫）、重點色、配色（跟隨訪客系統／淺色／深色）。`SiteStyle = { preset, accent, scheme }`；字級（360–1240px 連續縮放）、間距（一行高的倍數）、字體、圓角、行寬與淺深兩套顏色全由公式算出（`@onden/site` 的 `style.ts`、`palette.ts`）。舊資料由 `validateDesign` 轉換：舊 preset 名稱照對，其他值為安靜，重點色保留，其餘丟掉，配色預設跟隨系統。
- **畫布淺｜深**：預覽用的切換，不存進設計；預設跟網站的配色設定，設定為跟隨系統時跟 Onden 本身的淺深。
- **楷書**：「手寫」用系統楷書（`"Kaiti TC", "BiauKai", "DFKai-SB", serif`）。自架的霞鶩文楷 TC（`@fontsource/lxgw-wenkai-tc`，400 字重）一頁只有 333 個不同字就要載入約 0.9 MB，一般首頁會超過 1 MB，所以不打包。

