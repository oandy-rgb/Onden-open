# 網站的盒子模型：預設就好看、使用者只換「這一格放什麼」（2026-11-01）

> 狀態：現行（最後確認 2026-11-01）
> 涵蓋：packages/site/src/boxes.ts, packages/site/src/widgets.ts, packages/site/src/designV3.ts, packages/frontend/src/components/siteFrame/SiteWidgets.tsx

> 業主 2026-10-31 看完 demo 第 4 版後決定（「直接開始」）：網站改成**很多小盒子**，參考 Shopify Online Store 2.0 的 sections / blocks。
> 這份文件定義盒子、零件、資料形狀與搬遷；第 1 步（本文＋ `@onden/site` 的盒子模型＋唯一一套畫法）與第 2 步（設定畫面）的實作狀態寫在 §10。
> 接續 [發布改版](publish-redesign-2026-10-24.md)（§5.2 的設計形狀、§5.4 的預設設計在這裡被取代）與 [網站呈現模型](../site-render-model.md)（快照為準、下架即時，不變）。

## 1. 為什麼改

v2 的首頁是一整塊 Puck 畫布，筆記頁和標籤頁則只有幾個開關（`frames`）。結果是：

- 不碰任何設定時，首頁是「首頁筆記第一段＋最多文章的標籤清單」，像一般部落格，不像筆記花園。
- 想改一個地方，要先懂「堆疊、側欄、並排」這些版面詞；筆記頁和標籤頁則完全不能改版面，只能開關。
- 同一個概念（「列出最近的筆記」）在首頁、標籤頁各有一套畫法。

新模型把責任分開：**Onden 決定每種頁面有哪些盒子（位置、大小、手機上怎麼折疊）；使用者只決定每個盒子放哪個零件、哪個樣式，或留空。**
沒有自由排版，所以預設一定好讀，使用者也不可能排出手機上壞掉的版面。

## 2. 盒子（Onden 決定，使用者不改）

| 盒子 id | 頁面 | 接受的類別 | 最多幾格 | 寬螢幕 | 窄螢幕 |
|---|---|---|---|---|---|
| `header` | 每一頁 | `header`（導覽樣式） | 1 | 頁首 | 同左 |
| `home.hero` | 首頁 | `hero` | 1 | 首頁開頭 | 同左 |
| `home.list` | 首頁 | `section` | **8** | 依序往下 | 同左 |
| `note.meta` | 筆記頁 | `meta` | 1 | 標題下一行 | 同左 |
| `note.left` | 筆記頁 | `side` | 1 | 內文左邊的欄 | **不畫**（`hide`） |
| `note.right` | 筆記頁 | `side` | 1 | 內文右邊的欄 | **移到內文後面**（`after`）；標了 `narrow: hide` 的零件（目錄、側註）不畫 |
| `note.end` | 筆記頁 | `noteEnd` | **4** | 文末依序往下 | 同左 |
| `tag.desc` | 標籤頁 | `tagDesc` | 1 | 標題下 | 同左 |
| `tag.list` | 標籤頁 | `tagList` | 1 | 標籤的筆記 | 同左 |
| `tag.end` | 標籤頁 | `tagEnd` | **3** | 列表之後 | 同左 |
| `foot` | 每一頁 | `foot` | **4** | 頁尾一列，會換行 | 同左 |

固定、不是盒子的東西：筆記頁的**標題與內文**、標籤頁的**標題**。文章第一張獨立成段的圖是封面（`reading.cover`），連結預覽卡（`reading.preview`）是兩個不佔盒子的閱讀行為，各有開關。

定義在 `@onden/site` 的 `boxes.ts`（`BOX_SPECS`）；上表是它的文字版，測試（`designV3.test.ts`）檢查兩者一致。

### 窄螢幕怎麼折疊

只用 CSS，靜態網站不靠 JS 排版。折疊看**頁面自己的寬度**（`.site-scope` 是 `container-type: inline-size`，`@container site (min-width: 1200px)`），不看視窗寬度，所以設定畫面裡的「平板／手機」預覽放在較寬的視窗裡也會照真的窄螢幕折疊。

- 寬（≥ 1200px）：筆記頁是三欄 `左欄 | 內文 | 右欄`；只有一側有零件時就是兩欄；欄是 sticky。
- 窄：單欄。`note.left` 整個不畫；`note.right` 接在內文後面（在 `note.end` 之後）；零件上標了 `narrow: "hide"`（目錄、側註）的在窄螢幕不畫。
- 側註只在寬螢幕出現時才把內文末的註腳區塊藏起來（`:has(.s-w--sidenotes)`），窄螢幕註腳仍在文末，不會兩邊都沒有。
- 首頁、標籤頁、頁首、頁尾沒有欄，窄螢幕只是自然換行、堆疊。

## 3. 零件註冊表（`@onden/site` 的 `widgets.ts`）

零件 = 一格裡可以放的東西。本文與程式一律叫「零件」（widget）；`registry.ts` 裡舊的 `PartDef` 是 Puck 版面零件（堆疊、側欄…），只剩舊首頁畫布用。

```ts
type WidgetDef = {
  id: string; label: string; blurb: string;
  classes: BoxClass[];           // 哪些類別的盒子接受它
  variants: { id: string; label: string }[];   // 樣式；第一個是預設
  needs?: string;                // 沒資料時，編輯畫面用的一句白話
  ready?: (facts: WidgetFacts) => boolean;     // 站台有沒有它需要的資料
  narrow?: "hide";               // 窄螢幕不畫
  module?: string;               // 提供它的功能模組；內建的沒有
};
createWidgetRegistry(extra: WidgetDef[]): WidgetRegistry   // 內建 + 模組提供的；同 id 以內建為準
```

模組提供零件：模組把 `WidgetDef`（資料）交給 `createWidgetRegistry`，畫法放進 `BoxContext.renderers`（`widgetId → 畫法`），頁面程式不用改。
例：「閱讀」模組的 RSS 訂閱 → 「部落卷」（`classes: ["section"]`）。**這一步只定好介面，沒有接任何模組**（測試 `designV3.test.ts` 用假的「部落卷」驗證可擴充與不能覆蓋內建）。

### 第一批零件

| 零件 | id | 放得進的盒子類別 | 樣式 | 需要的資料（沒有就不畫） |
|---|---|---|---|---|
| 導覽 | `nav` | header | 靠左一列／置中／只有名稱與搜尋 | 一定有 |
| 自我介紹 | `intro` | hero, section | 第一段／第一句 | 首頁筆記，或標題為「關於／About」的筆記，且有內文 |
| 最新一篇 | `latest` | hero, section | 標題與摘要／只有標題 | 至少一篇文章 |
| 最近更新 | `recent` | section | 標題與更新日／附一句話 | 至少一篇文章；依更新時間排，10 篇，顯示「更新於…」 |
| 全部文章 | `all` | section | **依年份**／最近 10 篇／標上成熟度 | 至少一篇文章 |
| 主題 | `topics` | section | 清單／一排標籤 | 至少一個網站上有頁面的標籤；標籤加篇數 |
| 精選 | `featured` | section | 清單／卡片 | 至少一篇標了「精選」的文章 |
| 訂閱 | `subscribe` | hero, section | RSS | 一定有（電子報這次不做） |
| 資訊行 | `meta` | meta | 日期・閱讀時間／日期・標籤／全部／成熟度・日期 | 一定有 |
| 目錄 | `toc` | side | 清單 | 文章有 **3 個以上**標題（`TOC_MIN_HEADINGS`）；窄螢幕不畫 |
| 側註 | `sidenotes` | side | 放在旁邊 | 文章有註腳；窄螢幕不畫 |
| 檔案樹 | `tree` | side | 階層 | 有筆記放在另一篇之下 |
| 反向連結 | `backlinks` | noteEnd | **附引用的那一句**／只有標題 | 有其他已發布筆記連到這篇 |
| 上一篇／下一篇 | `prevnext` | noteEnd | 兩個連結 | 有前篇或後篇 |
| 標籤說明 | `tagdesc` | tagDesc | 文字 | 標籤自己那篇筆記已發布且有內文 |
| 文章列表 | `tagnotes` | tagList | 依年份／附一句話／標題與日期／照標籤的檢視 | 一定有（標籤頁一定有成員） |
| 只訂閱這個標籤 | `tagfeed` | tagEnd | RSS | 一定有 |
| 版權 | `copyright` | foot | © 年份 名稱 | 一定有 |
| RSS | `rss` | foot | 連結 | 一定有 |
| 讀者切換深淺 | `scheme` | foot | 按鈕 | 配色是「跟隨讀者的系統」（固定淺色／深色就沒東西可切） |

幾個要說清楚的定義：

- **文章** = 網站上已發布的筆記，扣掉首頁筆記和「標籤自己的筆記」（`tag_pages` 的 id）。「最近更新」「全部文章」「最新一篇」都從這組取。
- **成熟度**目前**沒有儲存的屬性**。第一版用標籤名稱判斷：幼苗（`幼苗`／`seedling`）、生長中（`生長中`／`budding`）、常青（`常青`／`evergreen`），取最高的一個；沒有就不標。要改成正式屬性時只換 `maturityOf`。
- **精選** = 標了 `精選`／`Featured` 的文章，同樣先用標籤，之後可換成屬性。
- **日期**沿用 `date_tags`（預設 `文章`）：筆記帶其中一個標籤才顯示建立日；沒有就顯示「更新於 …」。
- **側註**：`@onden/markdown` 已支援註腳（`[^id]`，含 `footnoteLabels`）。側註零件從筆記原文取出註腳定義，依內文第一次提到的順序列在旁邊（不是逐段對齊的邊註）；寬螢幕時文末那一區藏起來，窄螢幕不畫旁邊那一份。
- **只訂閱這個標籤**：新增 `/site/tag/<slug>/feed.xml`（同一份 RSS 產生器，只列那個標籤頁上的筆記），靜態副本與 Pages 會一起存這些檔。

### 沒有資料時的規則

- 讀者看到的網站：零件的 `ready` 為否 → 這一格**不畫**；一個盒子裡所有零件都不畫 → 整個盒子不畫（沒有空框、沒有標題）。頁首或頁尾盒子空了就沒有頁首／頁尾。
- 設定畫面（`editing`）：同樣的位置改畫一格虛線框，寫零件名稱和 `needs`（例：「需要一篇『關於』筆記」）；空盒子寫「留空」。畫法是同一套，只多 `editing` 這個參數。
- 這一條讓「預設設計」對任何工作區都安全：新工作區什麼都沒有，網站只剩該有的骨架。

## 4. 資料形狀：`SiteDesign` v3

```ts
type BoxPick = { widget: string; variant: string };
type SiteDesign = {
  v: 3; rev: string; studio_draft: true;
  preset: "simple" | "garden" | "newsletter" | "index" | null;  // 最後選的首頁樣式；null + legacy_home = 畫舊首頁
  boxes: {                                  // 每個盒子放什麼
    header: BoxPick | null;
    "home.hero": BoxPick | null;  "home.list": BoxPick[];
    "note.meta": BoxPick | null;  "note.left": BoxPick | null;  "note.right": BoxPick | null;  "note.end": BoxPick[];
    "tag.desc": BoxPick | null;   "tag.list": BoxPick | null;   "tag.end": BoxPick[];
    foot: BoxPick[];
  };
  style: SiteStyle;      // 沿用 { preset: 氣質, accent, scheme }
  css: string;           // 進階：全站 CSS（沿用）
  date_tags: string[];   // 沿用 frames.date_tags
  reading: { cover: boolean; preview: boolean };
  legacy_home: PuckData | null;             // 舊的 Puck 首頁（v2 的 home）
};
```

- `null` = 使用者留空；整個 key 不存在 = 用預設。清單盒子是陣列，超過上限就切掉並回報 `problems`。
- `validateDesign(input)` 是**唯一**入口（前後端相同）：接受 v3；v2 → `migrateV2`；其他 → 預設。盒子只收它的類別（不合的零件換回預設或從清單拿掉）、樣式不合改成第一個樣式。永不丟例外。
- 儲存路徑**沿用**現有的：設定筆記（`#workspace-config`）的 `presentation`，走 `setChromeBlocks` 的 `rev`／`ChromeStale`，前端走 `websiteWriter`。**沒有資料庫 migration**：chrome 是 jsonb，舊的 v2 在讀取與寫入時就地搬成 v3（`siteConfig.cleanedChrome`、`frozenDesign.savedDesign`），所以不用新的編號。
- 發布時的凍結（`presentation.design`）：`{ v: 3, preset, boxes, style, css, date_tags, reading, legacy_home, resolved, tag_pages, tag_names }`。新零件從已發布的筆記本身取資料（`nodes`、`edges`、`tag_pages`），**沒有新的後端查詢，也沒有新的洩漏面**：網站上看得到的只有快照裡的筆記。`legacy_home` 只在它是被畫的那一個時才凍結（`resolved` 只為它而存）。
- 下架（`takeDownDesign`）照舊：`resolved`、`tag_pages`、`tag_names` 即時過濾；`legacy_home` 裡指向已下架筆記的組件清空。盒子裡沒有筆記 id，不需要處理。
- `@onden/site` 輸出的 `defaultDesign()` 不再需要工作區資料（沒有首頁筆記或標籤時零件自己不畫），所以 `topPublishedTag`／`defaultDesignFor` 刪除。

## 5. 畫法只有一套

`components/siteFrame` 的 `SiteHeader`、`HomeBody`、`ArticleFrame`、`TagFrame`、`SiteFoot` 用 `Box`（`SiteWidgets.tsx`）畫盒子，每個零件一個畫法。下面幾個出口都走它：

| 出口 | 怎麼走 |
|---|---|
| 自架 `/site` | Astro SSR：`SiteLayout.astro` 畫 `<head>`、樣式變數，頁首與頁尾也是 React（`SiteHeader`／`SiteFoot`）；頁面主體是 `HomeBody`／`ArticleFrame`／`TagFrame`。 |
| 靜態快照（Pages）、zip 匯出 | 後端的 `buildStaticSite` 抓同一個 SSR 輸出存成檔案（不變）。 |
| 發布前預覽的「看網站」 | `modules/website/SiteRender.tsx`：同一批元件，包在 `SiteScope`（設計的樣式變數）裡。 |
| 設定畫面（第 2 步） | 同一個 `SiteRender`，加 `editing`。 |
| 舊的首頁畫布（Studio） | 仍用 Puck 編輯 `legacy_home`；它的預覽也走 `SiteRender`。 |

v2 的 `frames` 畫法（`ArticleFrame`／`TagFrame` 裡的開關、`SiteLayout` 裡的頁首頁尾）已移除，沒有兩套並存。舊首頁（`legacy_home`）只在 `usesLegacyHome(design)`（`preset === null` 且有內容）時畫，用的還是 Puck 的 `Render`。

預設外觀：安靜氣質（無襯線、留白多）、重點色 app 的綠（`#3f7d6e`）、配色跟著讀者的系統，並且讀者可以用頁尾的按鈕自己切換——選擇寫在 `<html data-theme>`，色彩規則（`styleCss`）讀它，記在讀者自己的裝置上（`localStorage`，失敗就只管這一次）。

## 6. 首頁樣式（預設內容）

「首頁樣式」只是兩個首頁盒子（`home.hero`、`home.list`）預先選好的內容，不改其他盒子：

| 樣式 | `home.hero` | `home.list` |
|---|---|---|
| **簡單**（預設，筆記花園味道） | 自我介紹 | 最近更新 → 主題 → 全部文章（依年份） |
| 花園 | 自我介紹 | 主題 → 全部文章（標成熟度） |
| 電子報 | 訂閱 | 最新一篇 → 精選 → 最近 10 篇 |
| 目錄 | 自我介紹 | 主題 → 最近 10 篇 |

預設的其餘盒子：筆記頁 `meta` = 日期・閱讀時間、`left` = 目錄、`right` = 側註、`end` = 反向連結（附引用句）→ 上一篇／下一篇；標籤頁 `desc` = 標籤說明、`list` = 依年份、`end` = 只訂閱這個標籤；`header` = 導覽（靠左一列）；`foot` = 版權 → RSS → 讀者切換深淺。
`applyHomePreset(boxes, id)` 只換首頁兩格；使用者改過的其他盒子保留。

**網站語言**預設跟著帳號語言（`accountSiteLocale()`：中文帳號 → 繁體中文，其餘 → 英文）。調查「預設成英文」的結果：
(1) 發布網站的 Markdown 管線沒有收到註腳區塊的文字（`footnoteLabels` 只給 `app` profile），所以任何語言的網站，文章裡的註腳標題與「回到內文」都是英文；現在由網站語言給（`makeSiteMarkdown({ locale })`，含 RSS 的內文）。
(2) 設定與發布永遠把「沒設定過」當成 `zh-TW`，與帳號語言無關；現在預設取帳號語言。後端在完全沒有語言時仍退回 `zh-TW`（舊快照、直接呼叫 API 的人）。

## 7. 舊設計怎麼搬（`migrateV2`，純函式）

| v2 | v3 |
|---|---|
| 首頁是 `defaultDesign` 做的（沒被改過）且 frames 都是預設 | 就是新的預設設計；保留 `style`、`css`、`date_tags`、`rev` |
| 首頁是使用者改過的 | `legacy_home` = 原本的 `home`、`preset: null`（繼續畫舊首頁，直到使用者選一種首頁樣式；選了之後 `legacy_home` 仍保留，可從進階回去） |
| frames 改過 | 開關轉成盒子內容（見下） |
| `frames.date_tags` | `date_tags` |
| `frames.article.cover`、`preview` | `reading.cover`、`reading.preview` |

frames 的對應（frames 不是預設時）：

- `nav`：文章頁與標籤頁**兩個都關**才是 `header = null`，否則導覽（靠左一列）。
- `footer`：同上，都關才是 `foot = []`，否則 版權 → RSS（不加切換按鈕：舊站沒有，不替它加新東西）。
- `date` / `readingTime` / `tags` → `note.meta`：有標籤且有閱讀時間 → 全部；有標籤 → 日期・標籤；只有日期或閱讀時間 → 日期・閱讀時間；都關 → 留空。
- `tree` → `note.left` = 檔案樹；`toc` → `note.left` = 目錄（兩個都開時，檔案樹左、目錄 `note.right`）。`note.right` 其他情況留空（不加側註）。
- `backlinks`、`prevnext` → `note.end` 對應零件；`description` → `tag.desc`；標籤頁的列表照舊跟著標籤的檢視（`tagnotes` 的「照標籤的檢視」樣式，所以卡片、表格不變）。
- `card`（v2 預設關、尚未有資料）沒有對應，丟掉。

搬遷發生在 `validateDesign`（讀）和 `cleanedChrome`（寫），所以：舊的客戶端寫 v2 也會被存成 v3；已發布的快照是 v2 時，前端 `readSiteData` 讀到一樣會搬。
舊首頁 Studio 繼續編輯一份 v2 形狀的工作副本（`legacyDesignOf` ↔ `withLegacyDesign`，兩個純函式是它與 v3 的全部接縫）；它改了首頁，才會把 `preset` 設成 `null`。

## 8. 「只有這篇」的例外

一篇筆記可以只在自己的頁面換掉四個筆記盒子（`note.meta`、`left`、`right`、`end`）。型別與清理器曾定義在 `noteBoxes.ts`（沒有人使用，2026-11-14 刪除；做這一步時再寫）：

- 存成筆記屬性 `_site_boxes`（值是 JSON；key = 盒子 id，值 = 零件或陣列，`null` = 這篇留空）。
- `cleanNoteBoxes(raw)` 丟掉不是這四個盒子的 key 與不合類別的零件；`boxesForNote(boxes, own)` 把它蓋在網站的設定上。
- **這一步沒有介面、發布路徑也還沒讀這個屬性**（寫在第 3 步）。

## 9. 進階

- **自己寫樣式**：沿用 `css`（全站 CSS，`scopedCss`）。盒子與零件有穩定的 class（`s-box--<盒子>`、`s-w--<零件>`、`s-w--<樣式>`）和 `data-box`／`data-widget`／`data-variant`，不是設計 token。
- **舊的首頁畫布**：現有的 Puck 首頁 Studio（`modules/website/studio`）**這次不刪**，收進「進階」當舊的自由排版（第 2 步的設定畫面放入口），不再加功能。
  想寫自由內容的人，將來用「一篇筆記」零件（第 4 步）。

## 10. 分批計畫

| 批次 | 內容 | 狀態 |
|---|---|---|
| 1 | 本文、盒子與零件註冊表、v3 與搬遷、唯一一套畫法、預設與四種首頁樣式、語言預設與註腳語言、每個標籤的 RSS | 本批（PR A） |
| 2 | 設定畫面：頁面分頁、寬度切換、首頁樣式／氣質／重點色、點一塊「換成…」（停在選項上先預覽、按「套用」才換）、清單盒子的加一格／上下移／移除、進階區 | PR B（`feat/site-boxes-ui`，已實作；截圖在 `docs/research/site-boxes-ui-shots-2026-11-01/`） |
| 3 | 筆記裡的「網頁」分頁、「只有這篇」的介面與讀取；成熟度、精選改成正式屬性 | 之後 |
| 4 | 部落卷（「閱讀」模組提供零件）、「一篇筆記」零件、電子報 | 之後 |

## 11. 這一批沒有做、或和要求不同的地方

- **後端整合測試沒能在這個環境跑**（需要 Apache AGE 擴充，環境沒有）。`siteDesignFreeze.integration.test.ts` 已照新形狀改寫，但沒執行；其餘後端單元測試（含 `siteRows`、`staticSite`）有跑。
- 成熟度、精選暫時用標籤名稱（§3）。
- 側註是「放在旁邊的註腳清單」，不是逐段對齊的邊註。
- 電子報（寄信）不做；「電子報」首頁樣式只是版面，訂閱仍是 RSS。

## 參考

- **Shopify Online Store 2.0**：sections 與 blocks、每個 section 定義它接受的 block 類型與上限、theme editor 裡「點一塊就換」。本文的盒子／零件／上限／樣式就是這個模型，把「由主題定義」改成「由 Onden 定義」。
- **WordPress 的範本零件替換**（block themes 的 template parts 與 Site Editor 的 replace）：只列出這個位置能放的零件、換掉而不是重排。
- **Quartz 5 的 layout**（`quartz.layout.ts` 的 `left`／`right`／`beforeBody`／`afterBody`／`footer` 與窄螢幕時側欄的折疊）：筆記花園的現成分區，目錄、反向連結、檔案樹放左右欄。
- **Bear Blog**：預設就是一個好讀的頁面，文章列表依日期、幾乎沒有版面選項；「預設好看比選項多重要」。
- **Steph Ango（stephango.com）**：安靜的筆記站、以標籤與時間組織、簡單的導覽。
- **Gwern（gwern.net）**：側欄目錄、側註（sidenotes）、依成熟度標示文章（"epistemic status"／"importance"），也是成熟度標籤的由來。
- **Maggie Appleton（maggieappleton.com）**：數位花園的成熟度標示（seedling／budding／evergreen）、主題先於時間的首頁。
