# 深模組審查：內容管線（Markdown 解析、序列化、渲染）

> 狀態：歷史紀錄（最後確認 2026-11-01）

審查日期：2026-10-24　範圍：`packages/markdown`、`packages/site`、`packages/frontend/src/published`、編輯器內解析、block nodes、匯入匯出、發布快照、後端解析筆記內容之處。
方法：只讀程式碼（.ts/.tsx/.astro/設定/測試），未讀任何 .md；以 `git grep`／`grep` 與閱讀為準。未跑測試，故「測試守得住」是讀測試內容的判斷，不是執行結果。標「推測」者為未能由程式碼直接證實。

## 一句話結論

**渲染的「規則」只有一份，但「渲染器」有兩個，而且各種小語法（`[[連結]]`、`^id`、`{標籤}`、frontmatter）的 regex 在管線外還有十幾處自己的版本（見語法逐項盤點）。**
`@onden/markdown` 的 `ondenMarkdownCore` 是真正的深模組：前端與後端各只呼叫它一次（`MarkdownRenderer.tsx:586`、`htmlUtils.ts:279`），外掛清單與消毒 schema 全在裡面。但沒有任何 lint 規則或架構測試守這條邊界；`unified`／`remark-parse` 仍是前後端的直接相依，邊界是靠自律與「固定測資」維持的。

## 模組地圖

### 1. 渲染管線核心：`ondenMarkdownCore`
- 入口：`packages/markdown/src/index.ts:176`（`ondenMarkdownCore`）；伺服器版 `packages/markdown/src/full.ts:13`（`ondenMarkdown`，預先註冊 KaTeX 與全部語法）。
- 介面大小：一個函式、2 個參數（`{profile, math, wikilinkHref, embeds, footnoteLabels}` 與 `{highlight, katex}`），回傳 `{prepare, remarkPlugins, remarkRehypeOptions, rehypePlugins}`（`index.ts:141-156`）。只有兩種 profile（`app`／`published`，`index.ts:101`）。**介面小、背後藏了十幾個外掛與消毒規則，是標準的深模組。**
- 呼叫端：**2 個，0 個繞過**。`frontend/src/components/MarkdownRenderer.tsx:586`、`backend/src/services/publishing/htmlUtils.ts:279`。`react-markdown` 只在 `MarkdownRenderer.tsx:1` 被 import（1 個檔案）。
- `MarkdownRenderer` 本身被 23 個檔案引用（`grep MarkdownRenderer`，含 `.css` import 與測試外），都經過它，沒有人自己 new 一個 ReactMarkdown。

### 2. 兩個「繪製端」（同一份管線設定，不同的元素繪製）
- 前端 React：`MarkdownRenderer.tsx`（645 行），負責 wikilink、mermaid、嵌入、勾選框的 React 元件。
- 後端靜態 HTML：`htmlUtils.ts` 的 `md2html`（`htmlUtils.ts:293`）+ `rehypeExportElements`（`htmlUtils.ts:157`），給匯出 zip 與靜態頁用。`md2html` 的呼叫端：`blockRenderer.ts`（5 處：91、134、140、196、197）、`staticBuilders.ts`（2 處：46、250），共 7 處，全部經它。
- 這是**兩個渲染器共用一份規則**，不是「只有一個渲染器」。兩邊各自實作：wikilink 指向哪裡（前端 `MarkdownRenderer.tsx:366` 起的 `wikilinkHref`；後端 `htmlUtils.ts:262` 的 `siteHref`）、媒體／iframe 嵌入（前端 `MarkdownRenderer.tsx:570-585`；後端 `htmlUtils.ts:162-189`）、凍結的查詢區塊、mermaid。

### 3. 結構解析（把文字讀成區塊／標題／連結目標）
- 入口：`parseBlocks`／`blockAnchors`（`blocks.ts:105,140`）、`headingAnchors`／`headingFragment`（`headingAnchors.ts`）、`listLinkTargets`（`linkTargets.ts`）、`renderedWikilinks`（`wikilinkSpans.ts:32`）、`queryBlocksIn`（`queryBlocks.ts`）。
- 介面大小：每個 1 個函式，各自簡單；但合在一起是 5 個各自 `unified()` 的 parser，設定不同（見問題 5）。
- 呼叫端：`parseBlocks` 在 backend 2 處（`blockNodes.ts:81`、`taskLines.ts:25`）+ frontend 1 處（`editorBlocks.ts:36`），**0 繞過**。`blockAnchors` 前端 3 處（`fields.tsx:121`、`publishedCore.tsx:124`、`editorParagraphActions.ts:62`），0 繞過。`headingAnchors` 由 `extractTOC`（`publishedCore.tsx:155`）與管線共用。

### 4. 文字層語法掃描器（不經過 parser 的 regex／掃描）
- 入口：`text.ts`（`wikilinkMatches`、`replaceWikilinks`、`HASHTAG_RE`、`TAG_NAME_CHAR`）、`attributeLines.ts`（`key:: value`）、`embeds.ts`（`![[…]]`）、`frontmatter.ts`（讀、寫、去除）、`blockId.ts`（`^id`）、`blockTags.ts`／`blocks.ts`（`{標籤}`）。
- 介面大小：窄而清楚，但 `index.ts` 整個 barrel 一共約 **246 個匯出名稱**（237 個 re-export 名 + 9 個直接宣告，用 regex 粗算）。
- 呼叫端與繞路：見下方「語法逐項盤點」。

### 5. 站台／發布（`packages/site`、`frontend/src/published`、`backend/.../publishing`）
- `packages/site`（26 檔）是**版面設計與區塊註冊表**，不處理 Markdown；對 `@onden/markdown` 只有 1 個 import（`site/src/validate.ts:4`，取 `BLOCK_ID`）。
- 發布 SPA：`frontend/src/published/main.tsx` 直接重用 `SiteTemplate`（檔頭註解 L1-L6，import 在 `main.tsx:9`），與工作室預覽是同一個元件，Markdown 走同一個 `MarkdownRenderer`（`siteFrame/siteMarkdown.tsx:35` 用 `profile="published"`）。這一段整合得好。
- 但後端另有 `blockRenderer.ts`，檔頭自承「A second rendering of the Studio blocks beside the site's React SiteTemplate」（`blockRenderer.ts:1-3`）：站台**區塊**（nav、callout、雙欄…）有兩套渲染。

### 6. 編輯器內的解析（CodeMirror／lezer）
- 編輯器用 `@codemirror/lang-markdown` 加自訂 lezer 擴充（`editorMathSyntax.ts`），與 remark 是兩套 parser，這是必然的。其餘語法（區塊、嵌入、frontmatter、wikilink）多半呼叫 `@onden/markdown`：`editorBlocks.ts:1`、`editorEmbeds.ts:3`、`editorFrontmatter.ts:3`、`wikilinks.ts:1`、`wikilinkTargets.ts:13`。

### 7. 匯入／匯出
- 匯出：`backend/src/services/exportZip.ts`（重寫 `onden://node/<id>` 連結）。匯入：`importedImageLinks.ts`、`importedRelations.ts`、`obsidian*`。
- frontmatter 的讀寫共用 `readFrontmatter`／`writeFrontmatter`（`utils.ts:2`、`importedImageLinks.ts:2`、`importedRelations.ts`）。

## 語法逐項盤點（regex 出現處，標明是否繞過 packages/markdown）

規模參考：非測試檔中 import `@onden/markdown` 的有 frontend 100 檔、backend 89 檔、site 2 檔（`grep -rl`，排除 `*.test.*` 與 `/test/`）。

### `[[連結]]`
共用實作：`text.ts` 的 `wikilinkMatches`／`replaceWikilinks`（線性掃描，`text.ts:7,17,52`）。管線外使用者 8 個檔案：backend `utils.ts`、`importedImageLinks.ts`、`publishing/redaction.ts`、`publishing/queryBlocks.ts`；frontend `basesEval.ts`、`wordStats.ts`、`wikilinks.ts`、`editorLinkFollow.ts`。

**自己寫 regex、繞過共用掃描的：套件外 7 處、套件內 3 處（共 10 處）**
| 位置 | 性質 |
|---|---|
| `frontend/src/modules/slides/slides.ts:16` `^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$` | 整行是連結 |
| `frontend/src/lib/noteSplit.ts:70` | 拆筆記時辨認清單裡的連結行 |
| `frontend/src/lib/utils.ts:5` `wikilinkLabel` | 剝掉 `[[ ]]` |
| `frontend/src/lib/editorCompletion.ts:103` | 輸入中的 `[[xxx` 自動完成（編輯情境，合理） |
| `backend/src/services/importedRelations.ts:29` `LINK` | frontmatter 值整個是連結 |
| `backend/src/services/importedImageLinks.ts:80` | frontmatter 值是 `[[a.png]]` |
| `backend/src/services/wikilinkEdges.ts:178` | 在 SQL 的 `~*` 裡手組 `\[\[…` pattern，另有 `LIKE '%[[%'`（同檔 candidates 查詢內） |
| `markdown/src/linkTargets.ts:116` | 套件內，自己 `.replace` |
| `markdown/src/headingAnchors.ts:228` `WIKILINK` | 套件內，自己一個 regex |
| `markdown/src/mentions.ts:142` | 套件內，`/[[…]]` 提及語法 |
另有 `backend/src/modules/rss/htmlToMarkdown.ts:82`：序列化時把 `[[` 跳脫，是反向（寫出）的規則，也在管線外。

**同一概念「這個 `[[x]]` 指向哪篇筆記」有三套解析**：SQL（`wikilinkEdges.ts:25` `linkMatchesNodeSql`）、前端 `resolveWikilink`（`lib/wikilinks.ts:41`，內部用 `linkNamesNote`）、套件的 `servedLinkTarget`（`sitePath.ts:44`，用 `wikilinkNames` 建索引）。`wikilinkEdges.ts` 的註解與 `utils.ts` 說兩邊共用 `linkNamesNote` 規則，但 SQL 版是手寫的對照（推測：沒有一個測試把 SQL 版與 JS 版逐案比對；我沒找到）。

**「連結」本身有兩個定義**：`wikilinkMatches` 掃原始文字（連 code 裡的 `[[x]]` 也算），`renderedWikilinks` 走 parser（code 裡的不算）（`wikilinkSpans.ts:1-8` 自己寫明）。`renderedWikilinks` 套件外 **0** 個呼叫端，只有 `sitePath.ts:108` 用。也就是說：反向連結（edges，用 raw 掃描）可能出現「頁面上並未畫成連結」的連結。註解說這是刻意的（edges 與遮罩寧可多不可漏），但呼叫端必須知道這個差別才用得對（資訊外洩）。

### `![[嵌入]]`
**乾淨。** 套件外 6 個使用處全走 `parseEmbed`／`embedMatches`／`embedLine`：`HomeStudio.tsx:8`、`lib/embeds.ts:19`、`agentTools/attachmentRefs.ts:3`、`publishing/drawingEmbeds.ts:27`（2 處）。我找不到任何自己寫的 `!\[\[` regex（`grep` 只在 `embeds.ts` 命中）。**0 繞過。**

### `^block-id`
共用：`BLOCK_ID`、`BLOCK_ID_PATTERN`、`trailingBlockId`（`blockId.ts`）；`site/validate.ts:4` 也用。
繞過 3 處：`backend/src/services/blockNodes.ts:162`（`/\s\^[A-Za-z0-9-]+\s*$/`，字元集自己寫，沒用 `BLOCK_ID_CHARS`）；`markdown/src/linkTargets.ts:119`（`\^[a-zA-Z0-9-]{1,64}$`，同上，註解寫「the markers block nodes end a line with」）；`frontend/src/lib/editorLinkFollow.ts:165`（用字串組 `\^id` 比對，id 來自已解析的 anchor，風險低）。
`editorCompletion.ts:86` 用 `BLOCK_ID_CHARS` 組 regex，是正確用法。

### `{標籤}` 與 `#標籤`
- `#標籤`：共用 `HASHTAG_RE`／`TAG_NAME_CHAR`（`text.ts:117,124`）；使用於 `blocks.ts:441`、`frontend/lib/hashtags.ts:16`、`backend/services/searchQuery.ts:23`。**0 繞過。**
- `{a, b}`：解析在 `blocks.ts`（`blockTagSlot` 等），套件外 **0** 個自己 parse 的 regex。但規則散在註解：`backend/src/services/tagHierarchy.ts:110-118` 用文字描述「標籤名稱必須能寫成 `{…}`」，`editorParagraphActions.ts:48` 用 `/[{},]/g` 清輸入。`linkTargets.ts:119` 自己 `\{[^{}]*\}$` 剝尾（套件內 1 處）。

### `key:: value`
`attributeLines.ts:30,31` 是唯一的 regex 定義（共用 `ATTRIBUTE_KEY`）；`linkTargets.ts:110` 另有 `HIDDEN_ATTRIBUTE_LINE = /^\S+::(?:\s|$)/`（套件內 1 處，自己的寬鬆版，與 `ATTRIBUTE_KEY` 規則不同：推測可能對 key 字元集判斷不一致）。套件外 **0 繞過**。

### frontmatter
唯一的編解碼：`frontmatter.ts`（`FENCE` 在 `:23`，`writeFrontmatter` 在 `:60` 附近）。
繞過 4 處：`frontend/src/lib/editorFrontmatter.ts:19`（`CLOSED_FENCE`，註解 L15 說明為了逐行掃描、避免複製整份文字，刻意重做）；`frontend/src/lib/ink/excalidraw.ts:62,65`（自己剝 `---` 圍欄再手組 `---\n…\n---\n`，雖有先呼叫 `frontmatterLength`）；`backend/src/services/harness/index.ts:82`（手組 SKILL.md 的 `---\nname:…\n---`，而套件內已有 `skillFile.ts` 的 `skillNoteMarkdown`，推測可以統一）；`frontend/src/modules/slides/slides.ts:62`（以 `---` 切投影片，需避開 setext，語意不同，可接受）。

### 直接用 remark／unified 另做 parser
套件外 2 處：`frontend/src/lib/taskLines.ts:13-15`（用完整 `remarkGfm`，註解說明是為了與渲染器同答案）、`backend/src/services/importedImageLinks.ts:3-5`（`remarkParse + remarkGfm`）。套件內 5 處各自 `unified()`：`wikilinkSpans.ts:25`、`linkTargets.ts:50`、`headingAnchors.ts:50`、`queryBlocks.ts:62`、`blocks.ts:88`。`unified`／`remark-parse` 在 `frontend/package.json:67`、`backend/package.json:39` 都是直接相依，所以隨時可再多一處。

## 分數表

| 子模組 | 深度 (1–5) | 整合度 (1–5) | 理由 |
|---|---|---|---|
| 1. 渲染管線核心 `ondenMarkdownCore` | **5** | **4** | 一個函式兩個參數藏起十幾個外掛與消毒；只有 2 個呼叫端且 0 繞過。扣一分：沒有 lint／架構測試守住，且仍有直接 `unified` 相依。 |
| 2. 兩個繪製端（`MarkdownRenderer` ／ `md2html`） | 3 | 3 | 規則共用，但 wikilink 指向、媒體、查詢區塊、mermaid 各寫一份；`md2html` 靠模組層級全域變數傳參（問題 4）。 |
| 3. 結構解析（blocks／headingAnchors／linkTargets） | 4 | 3 | 呼叫端都經過它（0 繞過），介面窄；但套件內 5 個 parser 設定不一致，且內部各自又有 regex（問題 5）。 |
| 4. 文字層掃描（wikilink／`^id`／`{}`／frontmatter） | 4 | 3 | 嵌入、`#標籤`、`key::` 做得乾淨（0 繞過）；`[[ ]]` 有 10 處自寫 regex、frontmatter 有 4 處、`^id` 3 處。 |
| 5. 站台／發布（`packages/site`、published SPA、`publishing/`） | 3 | 3 | SPA 重用 `SiteTemplate` 很好；但區塊另有 `blockRenderer.ts` 第二套渲染；`packages/site` 本身與 Markdown 幾乎無關（1 個 import）。 |
| 6. 編輯器內解析（CodeMirror） | 3 | 3 | 兩套 parser 必然存在；區塊／嵌入／frontmatter 都委託套件，數學語法有共用測資釘住；frontmatter 與 wikilink 補全自帶 regex。 |
| 7. 匯入／匯出 | 3 | 3 | frontmatter 編解碼共用；`exportZip.ts` 的 `CODE` regex（:74）與 `importedImageLinks`／`importedRelations` 各有自己的連結形狀判斷。 |
| `@onden/markdown` 作為整體（barrel） | 3 | 3 | 單一概念都很深，但 `index.ts` 約 246 個匯出，且裝了與「Markdown」關係遠的東西（Bases 評估、墨跡、GA4 腳本、技能檔、屬性型別）；呼叫端需要知道要挑哪一個。 |

## 問題清單（依嚴重度）

### 1. 沒有任何東西守這條邊界（中高）
- 現況：前端與後端 ESLint 設定都沒有限制 `unified`／`remark-*`／`react-markdown` 的 import（`frontend/eslint.config.js` 的 `no-restricted-imports` 只管 `localDb`、`appStore`，約 L245；`backend/eslint.config.js` 無相關規則；`grep` 的 `no-restricted` 命中只有這些）。`eslint-rules/` 下的規則（`writes-through-data`、`reads-through-data`、`module-entry`…）沒有一條涉及 Markdown。也沒有檢查「regex 含 `\[\[`」的測試。
- 證據：`frontend/package.json:67`、`backend/package.json:39` 把 `remark-parse` 當直接相依；已有 2 個檔案在套件外新建 parser（`taskLines.ts:13`、`importedImageLinks.ts:3`）。
- 影響：下一個人可以輕易再加一處；而且沒有人會被提醒。
- 建議：加一條 `no-restricted-imports`（`unified`、`remark-*`、`rehype-*`、`react-markdown` 只允許在 `packages/markdown` 與 `MarkdownRenderer.tsx`／`htmlUtils.ts`），現有 2 處改成套件匯出的 `parseMarkdown` 之類的入口或列入有理由的例外清單。

### 2. `[[連結]]` 的語法與指向規則散落（中高）
- 現況：10 處自寫 regex（見上表）；「這個連結指向哪篇」有 SQL、JS `linkNamesNote`、`servedLinkTarget` 三套。
- 證據：`wikilinkEdges.ts:25,178`；`lib/wikilinks.ts:41`；`sitePath.ts:44`；`slides.ts:16`；`noteSplit.ts:70`；`importedRelations.ts:29`；`importedImageLinks.ts:80`；`linkTargets.ts:116`；`headingAnchors.ts:228`；`mentions.ts:142`。
- 影響：改 `[[ ]]` 語法（例如允許巢狀或新跳脫）時，要記得改 10 處；SQL 版與 JS 版若分歧，反向連結會與畫面不一致（推測：目前沒有跨 SQL／JS 的逐案比對測試）。
- 建議：套件補一個「整行是不是一個連結」的小函式（涵蓋 slides／noteSplit／importedRelations／importedImageLinks），並把 `linkTargets`、`headingAnchors` 改用 `replaceWikilinks`；SQL 與 JS 解析規則用一份固定測資同時驗。

### 3. 「連結」有兩個定義，呼叫端必須知道（中）
- 現況：`wikilinkMatches`（原文掃描，連 code 內也算）對 `renderedWikilinks`（parser，code 內不算）。
- 證據：`wikilinkSpans.ts:1-8`；`renderedWikilinks` 套件外 0 個呼叫端，`sitePath.ts:108` 是唯一使用。
- 影響：反向連結會出現「文字裡在 code 區塊、頁面不是連結」的來源；呼叫端若選錯函式不會有錯誤，只會悄悄不一致。
- 建議：兩個名稱改成表達保證的名字（如 `wikilinkMentions` 與 `drawnWikilinks`），並在 `wikilinkMatches` 的 JSDoc 開頭就寫「包含 code 內」。

### 4. `md2html` 用模組層級全域變數傳參（中低）
- 現況：`let currentLinks`、`let currentMarkdown`（`htmlUtils.ts:277-278`）在 `md2html`（`:293`）呼叫前後設定、`finally` 還原；`siteHref`（`:262`）與 `rehypeExportElements`（`:197`）讀它們。
- 影響：同步執行下正確；但任何在 `wikilinkHref` 內再次呼叫 `md2html`（重入），或之後改為非同步，就會讀到錯誤的連結表（推測：目前沒有這種呼叫；我只看到 7 個外部呼叫端，都是頂層）。
- 建議：把 links 與原文放進 `VFile.data`，processor 就不必綁全域。

### 5. 套件內 5 個 parser 設定不一，且各自內建小 regex（中低）
- 現況：`blocks.ts:88` 與 `headingAnchors.ts:50`、`linkTargets.ts:50` 用 `remarkGfmBlocks`（無自動連結，為效能）；`wikilinkSpans.ts:25` 用完整 `remarkGfm` + wiki-link + math；`queryBlocks.ts:62` 只用 `remarkParse`；`blocks.ts` 的 parser 沒有 `remarkMath`，`headingAnchors`／`linkTargets` 有。
- 影響：同一份文字被解析 5 次、規則略有不同；「這行是不是在 `$$` 數學塊裡」可能因 parser 而異（推測：對 `blocks` 與 `headingAnchors` 的差異未驗證）。
- 建議：一個內部 `parserFor(feature)` 工廠，說明各 parser 為何少某個外掛。

### 6. 站台區塊有兩套渲染（中低，已知）
- 現況：`blockRenderer.ts:1-3` 自承是 `SiteTemplate` 的第二個渲染；`staticBuilders.ts` 與 `blockRenderer.ts` 合計 7 處 `md2html`。
- 影響：動站台區塊要改兩處；文字內容共用管線，但版面可能不同（匯出與線上網站）。
- 建議：已在註解標記要取代（W38d），不必另開工；進度請確認（見「不確定」）。

### 7. frontmatter／技能檔的手組輸出（低）
- 證據：`harness/index.ts:82`、`excalidraw.ts:62,65`、`editorFrontmatter.ts:19`。
- 影響：frontmatter 跳脫或圍欄規則改動時漏改；SKILL.md 已有套件內的 `skillNoteMarkdown`（`index.ts:47` 匯出的 `skillFile.ts`）。
- 建議：`renderSkillMd` 改用套件的寫出函式，excalidraw 改用 `writeFrontmatter`。

### 8. 套件 barrel 過寬、混入不相干功能（低）
- 證據：`index.ts` 約 246 個匯出，含 Bases 評估（`basesEval`、`basesParser`）、墨跡（另有子路徑 `./ink`）、GA4（`siteHead.ts` 的 `ga4InlineScript`）、技能檔、屬性型別。子路徑匯出（`./slug`、`./ink`、`./cite`、`./snippet`、`./block-id`、`./full`）與根匯出混用，同一個符號有時兩處都能拿（例如 `slugify`：`pendingNoteProjection.ts:6` 走 `/slug`，其他走根）。
- 影響：找對入口要翻 298 行；沒有「哪些名字是對外穩定契約」的標記。
- 建議：先按領域分段註解（已有一部分），再把非 Markdown 的（Bases、GA4）搬離。

### 9. 小重複（低）
- `htmlHazards.ts` 在 `markdown/src/test/` 與 `backend/src/test/` 各一份（各 124 行，差一行 import；檔頭互相說明是複本）。
- `exportZip.ts:74` 的 `CODE` regex（找 fenced／inline code）自己實作一份「跳過 code」，套件內也有 parser 可答。

## 做得好、值得保留的地方

1. **渲染規則真的只有一份**：`ondenMarkdownCore` 的 profile、外掛順序、`sanitizeSchema`、`KATEX_OPTIONS`；前後端各 1 個呼叫點（`MarkdownRenderer.tsx:586`、`htmlUtils.ts:279`）。
2. **用固定測資讓各端「對同一份答案」**：`markdown/src/fixtures/` 有 `math.json`、`headingAnchors.json`、`blockAnchors.json`、`blockTagInheritance.json`、`searchSnippets.json`；前端（`headingAnchorsParity.test.tsx`、`blockAnchorsParity.test.tsx`、`editorMathSyntax.test.ts`、`searchSnippets.test.tsx`）與後端（`headingAnchorsParity.test.ts`、`blockAnchorsParity.test.ts`）都載入同一份。編輯器的 lezer 數學語法與 remark-math 因此被釘在一起（`editorMathSyntax.ts:15` 註解明講）。
3. **嵌入、`#標籤`、`key::` 三種語法 0 繞過**，全部經過套件。
4. **發布 SPA 重用 `SiteTemplate` 原元件**（`published/main.tsx:1-6`），預覽即所見即所發。
5. **安全面有測試**：`pipeline.test.ts` 逐 profile 驗消毒；`markdownPipeline.fuzz.test.ts`、`embedUrls.fuzz.test.ts`、`publishing.fuzz.test.ts`、`htmlHazards` 檢查不可有的 HTML；`micromarkLinear.test.ts`／`bodyParsersLinear.test.ts` 守線性時間。
6. **註解會講「為什麼不是 parser」**（`text.ts:7`、`wikilinkSpans.ts:1-8`、`blocks.ts:74-82`、`taskLines.ts` 檔頭）：繞路多數有寫理由，不是偷懶。
7. **frontmatter 讀寫、媒體型別、屬性值序列化各只有一份**（`frontmatter.ts`、`mediaTypes.ts`、`attributeValue.ts`），匯入匯出都共用。

## 不確定、需要人確認的點

1. **「同一份內容在編輯器預覽、發布網站、匯出三處結果一致」沒有整篇比對的測試。** 我只找到對「標題 id、區塊 id、數學、callout／mermaid」的固定測資（見上）。沒找到把同一份複雜筆記同時丟進 `MarkdownRenderer` 與 `md2html`、比較 DOM 結構的測試（`MarkdownRendererParity.test.tsx` 只比 app／published profile 與卡片，沒有 `md2html`）。如果有，可能在我沒搜的 e2e 目錄；請確認。
2. **沒有 round-trip（解析→序列化→解析）整體測試。** 有局部的：`attributeValue(s).test.ts`、`html.test.ts`、`ink.test.ts`、`blocksAndCodecs.fuzz.test.ts`（名稱暗示 codec 往返，我沒逐行驗證）。frontmatter 往返我只看到單元測試，沒有確認。
3. **SQL 與 JS 的 wikilink 指向規則是否有跨實作比對**：沒找到，但可能在整合測試（`publishAliasLinks.integration.test.ts` 之類）。我沒執行測試，也沒有逐一讀完。
4. **W38d（用 SiteTemplate 取代 `blockRenderer.ts`）目前進度**：檔頭只說「replaces it」，我沒從程式碼看出時程。
5. **`linkTargets.ts:110` 的寬鬆 `key::` 判斷是否與 `ATTRIBUTE_KEY` 一致**：未驗證，推測可能對特殊字元的 key 不同。
6. **`frontend/src/modules/slides/slides.ts` 以 `---` 切片**是否應該與 frontmatter 邊界共用一個定義：語意不同，我傾向可以保留，但需要作者確認。
7. 本報告的 regex 清單用 `grep` 找 `\[\[`、`\^`、`::`、`---`、`#` 等模式，**可能漏掉用字串拼出來、或用 `indexOf`／`split` 手動掃描的版本**（例如 `slides.ts` 的逐行掃描就是靠人讀才發現）。數字是下限。
