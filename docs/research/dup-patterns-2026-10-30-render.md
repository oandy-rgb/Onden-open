# 各寫各的清單：內容顯示、markdown 衍生文字、i18n、測試與腳本（2026-10-30）

> 狀態：現行（進行中的盤點／計畫，完成後移到 docs/archive/）（最後確認 2026-11-01）

範圍：同一份內容在多處被畫出來（編輯器、閱讀預覽、白板卡片、嵌入、發布網站、匯出、RSS、歷史、搜尋摘要、投影片），
加上 `packages/markdown`／`packages/site` 內部、i18n、測試／e2e 輔助、`scripts/`。
**只查、只寫報告，沒有改任何程式碼。** 其他區（fe-ui、fe-interaction、fe-logic、be、cross）由別份報告負責。
上一輪 `dup-sweep-2026-10-29-*.md` 已列的不重報。

查證方式：A 區全部由我讀原始碼確認（每條至少兩個 `檔案:行`）。B 區 i18n 與測試／腳本交給兩個唯讀子代理掃描，
我抽查了其中的 `i18n.zh-TW.ts:1022/1526/1599`、`noteHistoryWriter.ts:62`、`approvalGate.spec.ts:10`（285 個 `const BASE =`）等，都對得上；
其餘 B 區引用為子代理讀過原檔的結果，**未逐條重讀**，已在各條標「子代理查證」。
行號為 2026-10-30 `origin/main`（058ed739）當下；「未驗證」會標明。

## 先講好消息：核心已經是單一來源

不要重做的部分（已查證）：

- 所有 markdown→畫面都從 `ondenMarkdownCore`（`markdown/src/index.ts:206`）這一條 remark/rehype 管線出來，profile 只有 `app`／`published` 兩種。
  前端 `MarkdownRenderer.tsx:3` 是唯一 import `react-markdown` 的地方，後端 `htmlUtils.ts:300` 是唯一組 `unified()` 的地方；
  `frontend/eslint.config.js:85`（`MARKDOWN_OWNERS`）與 `backend/eslint.config.js:29` 已經用 **允許清單 + no-restricted-imports** 擋住其他檔案 import `unified`／`remark-*`／`rehype-*`／`micromark*`。
- 媒體位址：`mediaUrl`／`mediaSrc`／`mediaRefs`／`rewriteMediaRefs`（`markdown/src/mediaRefs.ts`）一份文法，前後端都用。
- hashtag：`TAG_NAME_CHAR`／`HASHTAG_RE`（`markdown/src/text.ts:134,141`）被 `hashtags.ts:16`、`hashtagScopeHint.ts:9`、`searchQuery.ts:27`、`blocks.ts:33` 共用。
- 數學：`KATEX_OPTIONS` 前後端同一份（`editorMath.ts:94` 與 `index.ts:230`），編輯器的 Lezer 文法另有 fixture 對齊（`editorMathSyntax.ts:5`）。
- 勾選方塊：`taskLines`（`frontend/src/lib/taskLines.ts:1`）用渲染器自己的 `parseGfmTree`，渲染、點擊、編輯器共用一個答案。
- 標題 slug 與筆記 slug 規則不同（`slug.ts:14` vs `headingAnchors.ts:140`），是刻意的，不算重複。

下面是**還沒收斂**的。

## 總表（依「嚴重度高且工作量小」排序）

嚴重度：高＝使用者看得到的不一致；低＝維護成本。工作量：小／中／大。

| # | 概念 | 嚴重度 | 工作量 | 份數 | 來源 |
| --- | --- | --- | --- | --- | --- |
| A8 | 沒有標題時的顯示名（`Untitled`／`未命名`）；網站工作室寫死中文、不翻譯 | 高 | 小 | 69 處 `\|\| t("Untitled")`＋15 處寫死 `未命名` | 我 |
| A5 | callout 標記 `[!type]` 三種認法；渲染只認 5 種，標籤卻吃任何 `[!x]` | 高 | 小 | 3 | 我 |
| A9 | 自訂 CSS 清理兩套（一套沒擋 `@import`），註解指向已不存在的檔案；hex 色驗證 3 種 | 高 | 小 | 2＋3 | 我 |
| A1 | 「markdown 轉純文字」摘要／摘錄／標籤名 9 種寫法（底線被吃掉、連結不一致） | 高 | 中 | 9 | 我 |
| A3 | `MarkdownRenderer` 各畫面各傳不同 props；白板卡片未解析連結也當成已解析、複習卡不畫 `[[ ]]`／`![[ ]]` | 高 | 中 | 11 個呼叫點 | 我 |
| B1 | zh-TW 同一動作用不同字：復原／還原／撤銷、保存／儲存、發佈／發布、`⋯`／`…` | 高 | 小 | 見內文 | 子代理 |
| B2 | 「已存在本機、連線後同步」同一句有 7 種英文 | 高 | 小 | 8 | 子代理 |
| A11 | 判斷「在程式碼圍欄裡」的程式 11 份，規則各異 | 高 | 中 | 11 | 我 |
| A2 | 發布網站（React）與匯出／單篇 HTML（hast）兩套元素渲染 | 高 | 大 | 2＋1 | 我 |
| B5 | 後端英文句子＋錯誤碼＋前端 zh 三層文字 | 中 | 中 | 3 層 | 子代理 |
| B6 | 筆記長度上限數字寫死在 3 處、同一條件兩個代碼名 | 中 | 小 | 3 | 子代理 |
| B3 | 「需要連線」約 15 個 key，句點不一致 | 低 | 小 | 15 | 子代理 |
| B4 | 複製到剪貼簿的提示文字三種、層級不一 | 低 | 小 | 8 | 子代理 |
| B7 | 「AI」的稱呼 5 種英文 | 低 | 小 | 7 | 子代理 |
| A4 | 編輯器圖片列 vs 渲染器 `MdImage`；勾選方塊偵測 4 處正則 | 低 | 小 | 4 | 我 |
| A6 | `[[wikilink]]` 的正則變體（繞過線性掃描器） | 低 | 小 | 2 | 我 |
| A7 | 標記區間 `<mark>`：閉區間 vs 半開區間，4 個元件 | 低 | 小 | 4 | 我 |
| T1–T11 | e2e／後端／前端測試輔助各寫一份（261 份 `H`、203 檔直接 POST） | 低 | 中 | 見內文 | 子代理 |
| S1–S5 | scripts：DB 名稱安全檢查 4 種、等待服務 4 份、repo root 14 種 | 低（S1 可能中） | 小～中 | 見內文 | 子代理 |

## A 區：元素 × 顯示地點矩陣

欄＝顯示地點；格＝實際用的函式／元件。**【不一致】**＝與同列多數格行為不同（細節在 A 節）。

| 元素 | 編輯器（CodeMirror） | 閱讀預覽 `OverviewPreview` | 白板卡片 `CardNode` | 嵌入 `embedDom` | 發布網站（live） | 匯出／單篇 HTML／zip | RSS 輸出 | 複習卡 `ReviewPanel` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 管線 | Lezer（`MarkdownEditor.tsx:895`）| `MarkdownRenderer` app | 同左，`diagrams=false`，**無 `nodes`** | 同左＋`nodes/from` | `makeSiteMarkdown`→`MarkdownRenderer` published（`siteMarkdown.tsx:29`）| `md2html`→`mdProcessor`（`htmlUtils.ts:300`）| 同 live，`renderToStaticMarkup`（`siteFeedBody.ts:19`）| 同左，**無 `nodes`、無 `onNavigate`** |
| 圖片 | `ImageWidget`，eager、只收 https／`/api/media/`（`editorEmbeds.ts:195,257-263`）**【不一致】** | `MdImage`（`MarkdownRenderer.tsx:351`）lazy、`md-image` | 同左 | 同左 | 同左＋`resolveImage=mediaSrc`（`siteMarkdown`）| 原生 `<img>`，不加 class／lazy（`htmlUtils.ts:172-182` 只處理影音）**【不一致，未驗證 CSS 補償】** | 同 live | 同左 |
| 影音 | 不畫（當圖片，載入失敗退成 alt 字，`editorEmbeds.ts:263-270`）**【不一致】** | `MediaPlayer`（`:340-345`）| 同左 | 同左 | 同左 | `<video>/<audio controls>`（`htmlUtils.ts:175`）| 同 live | 同左 |
| 外部嵌入（YouTube） | 當連結文字 | `EmbedIframe`（`:149`，外層 `div`）| 同左；另有 CardNode 自己的 `<iframe>`（`CardNode.tsx:405-413`）**【不一致：第三份】** | 同左 | 同左 | `embedFrame`（`htmlUtils.ts:145`，外層 `span`，標題寫死英文）**【不一致】** | 同 live | 同左 |
| `![[note#^id]]` 嵌入 | `EmbedWidget`（`editorEmbeds.ts:62`→`embedDom`）| `EmbedBlock`（`:171`→`embedDom`）| 同左 | 同左 | 伺服器預先展開（`excerptEmbeds.ts`）| 同左 | 同 live | **不畫**（`embeds: profile==="app" && linksOn`，`MarkdownRenderer.tsx` 內；此處 `linksOn=false`）**【不一致】** |
| `[[wikilink]]` | `editorLinks.ts` 依語法樹上色 | `a` 覆寫→`resolveWikilink`（`:421-449`）| 同左，**無 `nodes` 時 `known` 恆為 true**（`:465`）**【不一致】** | 同左 | `linkHref`（`siteMarkdown.tsx:16`）| `siteHref`（`htmlUtils.ts:265-283`）| 同 live | **純文字 `[[x]]`**（`wikilinkHref` 未設，`index.ts:158`）**【不一致】** |
| 任務核取 | `taskLines`＋`MarkdownEditor.tsx:819` 正則 | `input` 覆寫→`md-checkbox` 按鈕（`:513-538`）| 同左 | 同左（唯讀）| 唯讀 span | 原生 `<input disabled>`（remark-gfm 預設，匯出未覆寫）**【不一致，未驗證 CSS】** | 同 live | 同左 |
| 程式碼區塊／上色 | Lezer＋`mdHighlight`（`:289`）| `CodeBlock`＋rehype `highlight.ts` | 同左 | 同左 | 同左；複製鈕由 `SiteCopyCode.astro` | 同管線；複製鈕靠頁內腳本 | 渲染後用正則剝掉鈕（`siteFeedBody.ts:20`）| 同左 |
| 數學 | `editorMath.ts`（KaTeX，同 `KATEX_OPTIONS`）| rehype-katex | **程式註解說「刻意不畫」（`CardNode.tsx:386`），實際 `math` 預設為 true，只關了 `diagrams`（`:444-446`）** **【註解與行為不符】** | 同左 | 同左 | 同管線 | 同 live | 同左 |
| 表格 | Lezer 標示 | remark-gfm | 同左 | 同左 | 同左 | 同管線 | 同 live | 同左 |
| callout | **不上色**（只有選單插入 `> [!note]`，`editorCompletion.ts:88`）| `remarkCallouts`（5 種，`callouts.ts:9`）| 同左 | 同左 | 同左 | 同左 | 同 live | 同左 |
| 標題錨點／目錄 | 無 | `remarkHeadingIds` | 同左 | 同左 | `headingAnchors`（`publishedCore.tsx:55`）| 同管線 | 同 live | 同左 |
| #標籤 | `TAG_NAME_CHAR` | 管線不渲染 #標籤，另由 `NoteTagCards`／標籤列 | 同左 | 同左 | 標籤頁 | 無 | 無 | 無 |
| 摘錄 excerpt | `excerptBlock` 文字，渲染成 blockquote | 同左 | 同左 | 同左 | 同左 | `expandExcerptEmbeds`（`noteExport.ts:5`）| — | — |
| 手寫 | `InkNodeView` | 縮圖 `inkToSvg`（`embedSources.ts:59`）| 同左 | `drawingSvg`→`inkToSvg` | `drawingEmbeds.ts:92`→`inkToSvg` | 同左 | — | `inkThumbnailSvg` |
| 純文字摘要 | — | — | — | — | `noteSummary`（`siteModel.ts:214`）| `noteSummary`（`siteRows.ts:42`）| `noteSummary`（`siteFeed.ts:50`）| — |
| 搜尋結果摘要 | `snippetAround`→`snippetPlainText`（`snippet.ts:60`）| — | — | — | — | — | — | — |
| 歷史比對 | — | — | — | — | — | — | — | `RewindNoteDiff.tsx:36` 直接把原始 markdown 放進 `<p>` **【不一致：不渲染】** |

欄位未列的畫面（Journal、投影片 `PresentationPlayer`、RSS 閱讀器）也是 `MarkdownRenderer`，傳的 props 見 A3。

---

## A1　「markdown 轉純文字」9 種寫法

- **概念**：從 markdown 取出人看得到的一行字（卡片摘要、搜尋摘錄、清單標籤、區塊標題、反向連結前後文）。
- **各自的寫法**：
  - `summary.ts:48-78` `noteSummary`＋`plainInline`：圖片→空白；wikilink 無別名時顯示**整個 body**（含 `#標題`、`#^id`）；`.replace(/[*_~`>]/g, "")` **會把單字內的底線刪掉**（`snake_case_name`→`snakecasename`）；不剝 HTML 標籤、不剝 `[^1]`。
  - `snippet.ts:60-100` `snippetPlainText`：wikilink 取 `alias ?? target`（含 `#^id`）；**只刪 `*` 和反引號**，`_`、`~` 留著；`[文字](url)` 與圖片**原樣保留**（含 URL）。
  - `linkContext.ts:127`＋`:86-125` `plainText`：剝圖片、`[^x]`、連結→標籤、HTML 標籤、`*_~\``；wikilink 用 `linkLabel`（拿掉 `#^id`，`#`→` › `）；表格 `|`→空白。
  - `linkTargets.ts:116-125`：wikilink 取 `alias ?? target`、剝 `^id`、`{tags}`、callout 標記。
  - `frontend/src/lib/noteLabel.ts:17-19` `firstLine`：自己的正則剝標題／清單／任務標記，`[*_`~]` 全刪。
  - `blockChild.ts:193-201` `titleOf`：再一套（連結、圖片、wikilink、`=`、`[]|#^\\` 全轉空白）。
  - `blockCard.ts:58-63` `stripMarker`、`blocks.ts:553-560` `clean`（60 字）、`paragraphs.ts:293,304` `LINE_MARKER`／行內去強調。
  - `MemberList.tsx:36`：`snippetPlainText` 之後**再用自己的正則**刪 `#tag`。
  - 清單標記寫法不一：`\d+[.)]`（`noteLabel`、`blockCard`、`blocks`）vs `\d{1,9}[.)]`（`summary`、`linkContext`、`blockChild`）；`[ \t]` vs `\s`。
- **已造成的不一致**：同一則筆記在卡片摘要（`noteSummary`）、搜尋結果（`snippetAround`）、反向連結（`plainText`）、側欄標題（`noteLabel`）上，連結、底線、wikilink 的樣子都不同；`noteSummary` 對含底線的英文單字顯示會壞。
- **建議的唯一入口**：`@onden/markdown` 新增一個 `plainTextOf(markdown, { keep: ... })`，以 `parseGfmTree`（已存在，`taskLines` 在用）走 AST 取文字；`noteSummary`／`snippetPlainText`／`plainText`／`firstLine`／`titleOf` 變成對它的薄包裝，只負責各自的裁切。
- **怎麼擋（允許清單）**：
  1. 守門測試 `markdown/src/test/guards/plainText.guard.test.ts`：下列正則字面量（`\[[ xX]\]`、`#{1,6}\s`、`[*_~`]` 組合）**只准出現在** `markdown/src/{plainText,blocks,paragraphs,taskParse,mentions,attributeLines}.ts`，其餘檔案 0 容忍；現況違規 **9 處**（上列加 `MemberList.tsx:36`、`editorFormat.ts:106-125`、`taskRefs.ts:139`、`MarkdownEditor.tsx:819`，編輯器行編輯那幾處可進例外並寫理由）。
  2. `snippet.ts`、`summary.ts` 不得再各自 `.replace(/[*_~`>]/g` 的字元集，改由同檔匯出的常數。
- **嚴重度／工作量**：高／中。

## A2　發布網站（React）與匯出（hast）兩套元素渲染

- **概念**：published profile 的「影音、嵌入框、mermaid、凍結查詢、核取方塊、複製鈕」由兩套程式分別畫。
- **各自的寫法**：
  - React：`MarkdownRenderer.tsx:149-163` `EmbedIframe`（外層 `div`，`title` 預設 `t("Embedded media")`）、`:351-367` `MdImage`、`:108` `MermaidBlock`、`FrozenQueryResult`、`CodeBlock`。
  - hast：`htmlUtils.ts:145-157` `embedFrame`（外層 `span`，標題寫死英文 `"Embedded media"`，`:179,197`）、`:167-219` `rehypeExportElements`、`:247` `frozenQueryHast`（註解自承「the same rule as the site's MarkdownRenderer」）。
  - 逐字重複的常數：iframe 的 `allow="accelerometer; autoplay; …"`（`MarkdownRenderer.tsx:158` 與 `htmlUtils.ts:153`）。
  - 只有匯出有的行為：連到 `/media/*.svg` 的連結改成 `<img>`（`htmlUtils.ts:159,192`）；app 的 `a` 覆寫沒有。
  - RSS：以 `renderToStaticMarkup` 輸出 React 版，再用正則 `/<button[^>]*\bmd-codeblock-copy\b…/` 剝掉複製鈕（`siteFeedBody.ts:20`）——渲染器改 class 名就悄悄失效。
- **已造成的不一致**：嵌入框外層元素不同（`div` vs `span`）；英文使用者在匯出裡的嵌入 title 是英文、在 app 是翻譯後的；核取方塊在 app 是 `md-checkbox` 按鈕、在匯出是原生 `<input>`（**未驗證**匯出 CSS 是否補齊）。
- **建議的唯一入口**：不建議強行合併成一份（React vs 靜態字串各有理由）。改成：
  1. 共用常數（`EMBED_IFRAME_ALLOW`、referrer policy、title 預設、`isMediaSvgHref`）放 `@onden/markdown/mediaEmbed.ts`（已有 `EMBED_IFRAME_SANDBOX`）。
  2. 加**對拍測試**：同一組 fixture（影音、YouTube、`.svg` 連結、核取方塊、mermaid、凍結查詢）分別經兩邊渲染，正規化 DOM（忽略 class 順序）後比對。
- **怎麼擋**：`<iframe`、`EMBED_IFRAME_SANDBOX` 的使用處允許清單＝`MarkdownRenderer.tsx`、`htmlUtils.ts`；現況多 **1 處違規**：`CardNode.tsx:405,408,413`（白板卡片自己的網頁嵌入）。`toEmbedUrl`／`classifyMedia` 允許清單再加 `rss/sanitize.ts`（有理由：RSS 轉換前處理）。用 `findUses`（`test/guards/sources.ts:27`）寫成 guard。
- **嚴重度／工作量**：高／大（對拍測試＋常數搬家為中，不含合併）。

## A3　`MarkdownRenderer` 各畫面各傳不同 props

- **概念**：「這個畫面要不要解析連結、嵌入、數學、圖表」由每個呼叫點自己組合 props。
- **各自的寫法**（`<MarkdownRenderer` 呼叫點）：
  `OverviewPreview.tsx:52`（`nodes`+`from`+`onToggleTask`）、`CardNode.tsx:444`（無 `nodes`、`diagrams={false}`）、`ReviewPanel.tsx:396,412`（皆無）、`RssReaderPanel.tsx:848`（`math:false` 展開自 `articleMarkdown.ts:3`）、`PresentationPlayer.tsx:73`、`JournalScreen.tsx:273,282`、`siteMarkdown.tsx:29`、`embedDom.ts:143`，另有 `makeMarkdownRenderer` 的 3 個使用點（`HomeStudio`／`PhoneHomeStudio`／`PublishedHomePreview`）。
  `linksOn = nodes !== undefined || !!onNavigate`（`MarkdownRenderer.tsx` 內）同時決定**連結解析與 `![[ ]]` 嵌入**（`index.ts:158` 的 `embeds`），所以「沒傳 nodes」會連帶關掉兩件事。
- **已造成的不一致**：
  - 白板卡片沒有 `nodes` → `known = !nodes || …`（`MarkdownRenderer.tsx:465`）恆為 true → 指向不存在筆記的 `[[x]]` 在卡片上樣式與已存在的一樣，閱讀預覽則會淡化。
  - 複習卡（`ReviewPanel.tsx:390` 註解寫「renderer parity matters here」）因為沒傳 `nodes`／`onNavigate`，`[[x]]` 顯示成**帶括號的純文字**、`![[x]]` 不畫嵌入。
  - `CardNode.tsx:386` 註解說卡片「DELIBERATELY no math/mermaid/callouts」，但程式只關 `diagrams`；數學與 callout 實際會畫（`math` 預設 true、callout 在核心管線）。註解已與行為不符。
- **建議的唯一入口**：`components/markdownSurfaces.tsx` 匯出具名畫面（`NotePreview`、`CardPreview`、`ReaderArticle`、`ReviewCard`、`SlideBody`、`JournalBody`、`EmbedBody`、`SitePage`），每個固定 props 組合並寫明理由；`MarkdownRenderer` 本體不再被直接 import。
- **怎麼擋**：`no-restricted-imports` 的允許清單——只有 `components/markdownSurfaces.tsx`（與 `siteFrame/siteMarkdown.tsx`）准 import `components/MarkdownRenderer`；現況違規 **9 個檔案**（上列去掉 `siteMarkdown`）。把 `frontend/eslint.config.js:85` 的 `MARKDOWN_OWNERS` 模式照抄成 `RENDERER_OWNERS`。
- **嚴重度／工作量**：高／中。

## A4　編輯器圖片列 vs 渲染器 `MdImage`；勾選方塊偵測

- **圖片**：`editorEmbeds.ts:193-197` `editorImageSrc` 自己判斷「https 或 `/api/media/`」，且 `mediaSrc(raw)` 沒傳 `apiBase`；`MarkdownRenderer.tsx:351-367` 先 `classifyMedia`（影音／iframe），`GalleryLayout.tsx:34`、`PageImageLayer.tsx:106`、`editorData.ts:137` 則傳 `apiBase: getApiBase()`。三種呼叫法，兩種對自訂 API 位址的處理不同（**未驗證**非同源 apiBase 部署是否受支援）。編輯器遇到 `![](x.mp4)` 會當圖片載入失敗再退成 alt 字。
- **勾選方塊**：`taskLines.ts` 是唯一正解，但 `taskRefs.ts:139`、`MarkdownEditor.tsx:819`、`editorFormat.ts:141-142` 仍各用正則（只收 `-*+`，不處理有序清單）。
- **建議**：`editorImageSrc` 改呼叫 `@onden/markdown` 的 `classifyMedia`＋`mediaSrc`（`apiBase` 由單一 helper 取）；行編輯情境的正則留在 `editorFormat.ts` 一處。
- **怎麼擋**：`mediaSrc(` 的呼叫必須透過 `lib/mediaAddress.ts`（新）注入 `apiBase`；允許清單＝該檔；現況 **4 處**直接呼叫（上列＋`siteShareImage.ts:11`）。
- **嚴重度／工作量**：低／小。

## A5　callout 標記三種認法

- **概念**：`> [!type]` 的辨識。
- **各自的寫法**：`callouts.ts:9,13`（只認 `note|tip|warning|important|caution`，不認折疊 `+`／`-`）；`linkTargets.ts:125`（`[\w-]+` 且認 `[+-]?`）；`blocks.ts:557`（`[a-zA-Z]+` 且認 `[-+]?`）。
- **已造成的不一致**：`> [!info] 標題` 在畫面上是**一般引言，字面顯示 `[!info]`**（不在 5 種內），但反向連結前後文與區塊標籤會把 `[!info]` 悄悄吃掉。反之 `[!note]-` 這種折疊寫法在渲染器不被認成 callout（正則在 `\]` 後直接接 `\s*`）。
- **建議的唯一入口**：`callouts.ts` 匯出 `CALLOUT_MARKER`（含折疊，型別集合決定是否渲染）與 `calloutMarkerLength(text)`，另兩處改用；「是否認得型別」與「是否剝掉標記」同一份。
- **怎麼擋**：字面量 `\[!` 正則只准出現在 `markdown/src/callouts.ts`；現況違規 **2 處**（`linkTargets.ts:125`、`blocks.ts:557`）。
- **嚴重度／工作量**：高／小。

## A6　`[[wikilink]]` 的正則變體

- `text.ts:7-21` 明說正則 `/\[\[([^\]]+)\]\]/g` 會二次方時間，所以做了線性掃描器 `scanWikilinks`。但仍有繞過者：`blockChild.ts:196`（`\[\[([^\]|]*)\|([^\]]*)\]\]`）、`readingTime.ts:22`（`{0,200}` 上限版本）。`editorCompletion.ts:140`（輸入中的 `[[` 偵測）與 `wikilinkEdges.ts:186`（SQL 模糊樣式）、`htmlToMarkdown.ts:82`（跳脫）用途不同，列為合理例外。
- 差異：`readingTime` 的 200 字上限讓超長連結被當成非連結；`blockChild` 沒有行界限。
- **建議／怎麼擋**：`\[\[` 字面量只准出現在 `markdown/src/text.ts`、`editorCompletion.ts`、`wikilinkEdges.ts`、`htmlToMarkdown.ts`；現況違規 **2 處**。
- **嚴重度／工作量**：低／小。

## A7　`<mark>` 標記區間：閉區間 vs 半開區間

- `HighlightedText.tsx:3-13` 用**閉區間** `[start, end]`（Fuse／`matchTitle`），`SnippetText.tsx:14-22` 與 `snippet.ts:155` 用**半開** `[start, end)`；型別都是 `[number, number]`，傳錯不會報錯。`BlockRefRow.tsx:25` 把自己組的閉區間（`blockRefSearch.ts:62-65`）餵給 `HighlightedText`，目前正確但靠人記得。另有 `NoteRelations.tsx:39-46`、`SiteFrames.tsx:78` 各自畫 `<mark>`。
- **建議**：區間型別分成 `InclusiveRange`／`SnippetRange`（brand type），或讓 `matchTitle` 也改半開，一個元件。
- **怎麼擋**：JSX `<mark` 只准出現在 `HighlightedText.tsx`、`SnippetText.tsx`、`SiteFrames.tsx`（網站，不同套件樣式）；現況多 **1 處**（`NoteRelations.tsx:44`）。
- **嚴重度／工作量**：低／小。

## A8　沒有標題時顯示什麼

- **概念**：未命名筆記的顯示名。
- **各自的寫法**：
  - 共用的 `noteLabel`（`lib/noteLabel.ts:25`，沒標題時退到內文第一行）只有 3 個呼叫者（`OverviewSidebar.tsx:726`、`nodeActions.ts:35` 等）。
  - 其餘 `x.title || t("Untitled")` **69 處、50 個檔案**（例：`TaskRow.tsx:52`、`ReviewPanel.tsx:377`、`PublishPreviewDialog.tsx:55`）。
  - **寫死中文、不翻譯**：網站工作室 15 處（`PhoneHomeStudio.tsx:69,187,188`、`phoneHome.ts:45,50`、`suggestions.ts:81,92`、`fields.tsx:64,71,119`）。
  - 後端：`activity.ts:24` `PLACEHOLDER_TITLES = ["Untitled","未命名","New Note","New note","新筆記"]`；`singleNoteHtml.ts:30` 單篇匯出寫死英文 `"Untitled"`。
- **已造成的不一致**：英文介面的使用者在網站工作室看到「未命名」；側欄顯示內文第一行、其他清單顯示「Untitled」，同一則筆記兩個名字。
- **建議的唯一入口**：`noteLabel`（前端）；後端佔位標題清單從 `@onden/markdown` 常數匯出，前端 `noteLabel` 與 `activity.ts` 共用。
- **怎麼擋**：`t("Untitled")` 只准出現在 `lib/noteLabel.ts`（含 i18n 表）；`未命名` 字面量禁止出現在 `src/**` 非 i18n 檔。現況違規 **69＋15 處**，用棘輪基線（只減不增）。
- **嚴重度／工作量**：高／小（機械式替換；69 處可分批）。

## A9　自訂 CSS 清理、hex 色驗證

- **概念**：把使用者的 CSS／顏色放進 `<style>` 前的清理與驗證。
- **各自的寫法**：
  - `htmlUtils.ts:51-55` `sanitizeCustomCss`：只上限 50k＋`<`→`\3c `；**不擋 `@import`**。
  - `site/src/css.ts:41-46` `sanitizeSiteCss`：另擋 `@import` 與 `@\`；上限 `SITE_CSS_MAX = 50_000`（`css.ts:9`）。
  - 兩者註解互相指向「frontend `lib/customCss.ts`」（`htmlUtils.ts:50`、`css.ts:2`），**該檔已不存在**（`ls` 確認）。
  - hex 顏色：`markdown/src/color.ts:1` `isHexColor`（`#rrggbb`，AGENTS 指定入口）；`site/src/validate.ts:19` 自己的 `HEX_COLOR`（同規則，但 site 已依賴 markdown）；`publishing/css.ts:117` `/^#[0-9a-f]{3,8}$/i`（接受 5、7 位等無效長度）。
- **已造成的不一致**：舊的 `custom_css` 路徑可帶 `@import url(外部)`，與 `css.ts:110-111` 註解「published site makes no third-party request」矛盾；靜態版有 CSP（`publishedCspContent`）擋，SSR `/site` 是否也擋**未驗證**。
- **建議的唯一入口**：`sanitizeSiteCss` 當主人（backend 已依賴 `@onden/site`，`backend/package.json:29`），`sanitizeCustomCss` 改為薄包裝；`site_bg` 改用 `isHexColor`；刪掉兩處指向不存在檔案的註解。
- **怎麼擋**：`\\3c ` 字面量只准出現在 `site/src/css.ts`；`#[0-9a-f]{` 的 hex 正則只准出現在 `markdown/src/color.ts`；現況違規 **1＋2 處**。
- **嚴重度／工作量**：高（安全相關）／小。

## A10　行首標題判斷、圍欄判斷（見 A11）

- 標題 `^#{1,6}\s` 在 `reviewExtract.ts:21`、`slides.ts:45`、`editorFormat.ts:106,115,125` 各一份，用途是行編輯與投影片切片，低風險；併入 A1 的守門清單即可。
- `RewindNoteDiff.tsx:36` 把 `markdown_then` 直接放 `<p>`（含 `**`、`[[`），與其他預覽不同；是否刻意（顯示原文便於比對）**未確認**，列為待產品決定。

## A11　「這行在程式碼圍欄裡」11 份

- **概念**：判斷一行是否位於 ``` 或 ~~~ 圍欄內，避免把程式碼中的連結／標籤／任務當成真的。
- **各自的寫法**：`mentions.ts:72`（縮排 0–3）、`needs.ts:22`（允許引言／清單前綴）、`firstImage.ts:6`（`/```[\s\S]*?```|~~~…/`，**不看行首、未關閉的圍欄不算**）、`attributeLines.ts:42`（`trim` 後比對）、`paragraphs.ts:70`（`\s*`，不要求 3 以內）、`linkContext.ts:38`、`editorEmbeds.ts:132`、`slides.ts:14`、`reviewExtract.ts:27`（`inFence` 布林）、`taskListFile.ts:217`、`editorCompletion.ts:116`。
- **已造成的不一致**：`firstImage` 對未關閉圍欄與縮排圍欄的判斷和 `linkContext`／`mentions` 不同，同一個「圍欄裡的圖片」會被封面圖取到、反向連結卻忽略。`needs.ts` 認得引言內的圍欄，其他多數不認。**未逐一實測**，上為從正則差異推得。
- **建議的唯一入口**：`markdown/src/blocks.ts` 已有區塊切分；匯出 `fenceRanges(markdown): Array<[from,to]>`（一次掃描，行首／引言／清單前綴規則一致），各處改用 `isInFence(offset)`。
- **怎麼擋**：字面量 `` `{3,} `` 的圍欄正則只准出現在 `markdown/src/{fences,blocks,needs}.ts`；現況違規 **11 處**，棘輪基線。
- **嚴重度／工作量**：高／中。

---

## B 區：i18n、測試、腳本（子代理查證）

### i18n（每條都是子代理讀過原檔；我抽查 `i18n.zh-TW.ts:1022,1526,1599`、`noteHistoryWriter.ts:62`）

**B1　zh-TW 用字漂移**（高／小）
- 復原：`Revert`→復原（`i18n.zh-TW.ts:164`）、`Undo`→復原（`:865`）、`Restore`→復原（`:1434`），但 `Undoing needs a connection`→**撤銷**（`:1599`，呼叫處 `noteHistoryWriter.ts:62`、`blockChildWriter.ts:77`）、`Undo restore`→撤銷（`:3416`）、`Restoring needs a connection`→還原（`:1600`）。全表 還原 60／復原 66／撤銷 31。
- 保存／儲存：`Saved`→已儲存（`:560`）、`Save failed`→儲存失敗（`:1526`）、`Saving…`→**保存**中…（`:1022`）；全表 保存 23／儲存 43。發佈 2 處（`:1010,1011`）vs 發布 54 處。`⋯` 5 處（`:1443-1445`）vs `…` 117 處。
- **唯一入口**：詞彙表（英文 key 樣式→必用中文）。**怎麼擋**：擴充 `test/zhTwBannedWords.test.ts`（目前只擋 模組|LWW|token|schema|JSON 等，檔頭已寫「one idea has one word」卻只編碼了技術詞），加入：禁「保存」「發佈」「⋯」，`/^Undo/` 的 key 值須含「復原」。

**B2　「已存在本機，連線後同步」7 種英文**（高／小）：`ReviewSettings.tsx:47`、`RssReaderPanel.tsx:333,392,495,573`、`useNodeCreation.ts:102`／`useCreateTag.ts:20`、`QuickAddTask.tsx:142`、`RssDefaultsWidget.tsx:42`、`ViewBuilder.tsx:167`。前兩種在 zh 同值（`:1543`／`:2666`）證明是同一句。儲存失敗也有兩句（`writeErrors.ts:51-53,92`）。**唯一入口**：`lib/data` 的 `queuedMessage(subject?)`。**怎麼擋**：`on this device` 字面量只准出現在 `lib/data/*Messages.ts`。

**B3　「需要連線」約 15 個 key**（低／小）：`taskWriter.ts:204,218`、`viewWriter.ts:47,53`、`blockChildWriter.ts:36,77`、`propertyWriter.ts:75`、`noteHistoryWriter.ts:19`、`websiteWriter.ts:50,58`、`useAgentMentions.ts:105,124`、`RewindPreview.tsx:84`／`RewindConfirm.tsx:111`（同一句在兩檔）。句點有無不一。**唯一入口**：`offlineRefusal(actionLabel)`。**怎麼擋**：`onlineOperation`／`online` 的訊息參數必須是該 helper 的回傳值。

**B4　複製到剪貼簿提示**（低／小）：`Copied`／`Copied to clipboard`／`Link copied`（`copyUrl.ts:11`、`MarkdownRenderer.tsx:88`、`FailedWriteRecovery.tsx:52`、`useNoteExport.ts:73`、`PublishNoteRow.tsx:147`），toast 層級 info／預設／success 三種；失敗句 3 種。（前一輪 I 項只列了份數，這裡補上文字與層級的實際差異。）**怎麼擋**：`navigator.clipboard.writeText` 只准出現在 `lib/copyToClipboard.ts`。

**B5　後端英文句＋錯誤碼＋前端 zh 三層**（中／中）：`serverErrors.ts:24-246` 約 220 個碼；另外 `i18n.zh-TW.ts:2485` 起約 107 個 key 是後端**原文句子**（`"node not found"`、`"malformed JSON body"`…）。後端丟句子處：`nodeTrash.ts:210,297,301`、`tagModules.ts:34,124`、`spaces.ts:205,212,219,251`、`review/service.ts:193,422`。`not_found`／`note_not_found` 文字相同；`bad_request`／`invalid_args`／`bad_idempotency_key` 同句。**怎麼擋**：守門——後端 `new \w+Error(\d{3}, "…")` 的字串必須是 `SERVER_ERROR_MESSAGES` 的碼或已登記的細節句；`SERVER_ERROR_MESSAGES` 值重複須列例外。（`serverErrors.test.ts` 目前只檢查「碼有條目」單向。）

**B6　長度上限寫死在句子裡**（中／小）：`NODE_MARKDOWN_MAX=2_000_000`、`NODE_TITLE_MAX=500`（`noteLimits.ts:12-13`）；句子寫死數字在 `serverErrors.ts:101-103` 與 `FolderImportSetting.tsx:164-165,243`；同一條件兩個碼 `contains_nul` vs `invalid_text`（`importers/markdown/note.ts:31`）。**怎麼擋**：`/2,000,000|500 characters/` 禁止出現在 `serverErrors.ts` 以外。

**B7　「AI」稱呼**（低／小）：`AI`（`NoteHistory.tsx:116`、`WorkspaceHistoryChanges.tsx:112`）、`AI agent`（`BlockHistorySheet.tsx:64`、`InboxReview.tsx:221`）、`agent`（`InboxReview.tsx:298`）、`{name} (AI)`（`MovePreviewSummary.tsx:17`）。**唯一入口**：`actorLabel(actor)`。

**B8　重試鈕文字**（低／小）：`Try again`／`Retry`／`Retry connection`／`Retry saving`（6 處草稿被拒）。**唯一入口**：共用 `RetryButton`。

**B9　唯讀標籤**（低／小）：`Read only`（`NoteMetaLine.tsx:40`）、`Read-only`（`HelperKeys.tsx:91`）、`Can read`（`SpaceChip.tsx:75`）；`Can view`（`i18n.zh-TW.ts:409`）已是死 key；`AddAiRoleWizard.tsx:53` 與 `HelperKeys.tsx:42` 重複同一段標籤運算。

**既有 i18n 守門與缺口**：`i18nKeys.test.ts`（字面量 `t()` 必須有 zh key；非字面量、死 key、同義不同 key 不檢查）、`zhTwBannedWords.test.ts`、`serverErrors.test.ts`；佔位符不符 0 筆；約 321 個 key 在原始碼中找不到（待逐一確認，未刪除驗證）。

### 測試／e2e（子代理查證；`dup:names` 因 `scripts/dupLib.mjs:73-74` 跳過 test 目錄，**完全看不到**以下重複）

- **T1** e2e 的 `BASE`／`H`（`{headers:{origin:BASE,"content-type":"application/json"}}`）：285 個 `const BASE =`、261 個 `const H =`（`approvalGate.spec.ts:10`、`canvasAddNote.spec.ts:10`、`faults/faultKit.ts:22`、`helpers.ts:143`）；`canvasExcerpts.spec.ts:8` 用 `Content-Type`。**入口**：`e2e/fullstack/helpers.ts` 匯出。**擋**：`process.env.E2E_BASE` 與頂層 `const BASE|H|WRITE` 只准出現在 `helpers.ts`、`faultKit.ts`、`global-setup.ts`。
- **T2** 造筆記：203 個 spec 直接 `request.post("/api/nodes"`，約 25 個本地 helper（`seed`／`seedNote`／`mkNote`，例 `imeCompletion.spec.ts:29`、`inkTouch.spec.ts:35`、`personas2.spec.ts`）。有的檢查 `res.ok()`、有的沒有；有的帶 `space_id`、有的沒有（根筆記不在預設空間「never publishes」）。**入口**：`helpers.ts` 的 `createNote`。**擋**：`.post("/api/nodes"` 只准出現在 `helpers.ts`，棘輪基線。
- **T3** 等待 `.membership-gate`：58 個檔提到，約 6 種逾時（15／60／90／120 秒）與固定睡眠（1.5–8 秒），多處 `.catch(()=>{})` 吞掉失敗（`personas.spec.ts:19`、`zzDeepAcc08.spec.ts:17`、`zzDeepData06-crossbrowser.spec.ts:11`…）。**入口**：`helpers.ts:68` `ready()`。**擋**：`.membership-gate` 與 `waitForTimeout(` 只准出現在 `helpers.ts`。
- **T4** 註冊／登入／關掉儲存選擇器：41 個 spec＋`global-setup.ts:21`、`scripts/persona/pw.mjs:23`；順序相反（先登入 vs 先註冊）。
- **T5** `docker exec … psql` 20 個檔 4 種寫法（`-At -c` vs `-tAc`；`zzDeepPerf01.spec.ts:15` 用字串 `execSync` 有注入風險）。**入口**：`helpers.ts` 的 `psql()`。
- **T6** 輪詢：`pollBootstrap`（`helpers.ts:43`）vs 手寫迴圈回傳 -1／null（`zzDeepSys06.spec.ts:23`、`zzDeepNote02.spec.ts:26`），逾時被呼叫端漏檢就靜默通過。
- **T7** 後端整合測試造節點：約 25 個名稱、3 種機制（直接 `INSERT INTO content_nodes`：`eventRestoreAtomicity.integration.test.ts:33`、`membershipEpoch.integration.test.ts:72` 等 9 檔；HTTP：`publishWorkflow.integration.test.ts:49` 等 7 檔；`mutate`：`syncEventOrdering.integration.test.ts:43`）。直接 SQL 繞過事件與 spine，可造出真實寫入路徑不允許的狀態。**入口**：`backend/src/test/helpers/nodeFixtures.ts`（`spaceFixtures.ts` 已有 `makeSpace` 但沒有節點）。**擋**：`INSERT INTO content_nodes` 在測試中只准出現在 `helpers/**`，棘輪基線。
- **T8** 後端測試等待：6 個命名（`waitFor` 回傳 boolean vs 其他丟例外）＋約 30 處行內 `new Promise(r=>setTimeout(r,N))`。**擋**：`node:timers/promises` 與 `setTimeout` Promise 只准出現在 `helpers/waitUntil.ts`。
- **T9** 前端 vitest 的 `ContentNode` 工廠：89 個檔 63 個手寫（`note`×28、`node`×15、`makeNode`×7、`mk`×4），三種參數慣例，預設值不同（`sidebarTagDrop.test.tsx:16`、`inspectorI18n.test.tsx:12`、`noteTasks.test.ts:12`）。**入口**：`src/test/fixtures/nodes.ts`。
- **T10** `mockFetch` 同名兩份（`ReviewPanel.test.tsx:31`、`NodeAttributesPanel.test.tsx:13`）＋37 個 `vi.stubGlobal("fetch"`；local-db worker 的 `ok(op,…)` 在 10 個測試檔各一份（`loadBootstrapPhases.test.ts:22` 等）。
- **T11** 「讓非同步做完」7 種寫法（真實 60ms、`advanceTimersByTimeAsync(700)`、40 次 `await Promise.resolve()`…）。

### scripts（子代理查證；未實跑腳本）

- **S1** 資料庫名稱安全檢查 4 種：`testDatabase.ts:18`（`_test$`，**不檢查本機主機**）、`bench/common.ts` `assertBenchDatabase`（`_bench$`）、`drillInvariants.ts:132`（`_drill`＋本機）、`test-isolated.sh:20`、`restore-drill.sh:55`。`databaseName`（回 ""）與 `databaseNameOf`（丟例外）對壞網址的處理不同。可能是中等嚴重（`_test` 資料庫在遠端主機會被接受）。**入口**：一個 `assertDisposableDb(url, suffix, {localOnly})`。**擋**：`_test$|_bench$|_drill` 正則只准出現在該模組與三支 bash。
- **S2** 等待服務就緒 4 份（`persona/common.sh:35` `wait_http`、`e2e/fullstack/run.sh:92-98`、`bench/siteCache.ts:93`、`restore-drill.sh:97`；`persona/boot.sh:47` 的 `pg_isready` 逾時不失敗）；兩處各自把 401 當成已啟動。
- **S3** 找 repo root 14 種（bash `dirname`／`cd ../../..`、node `import.meta.url` 加魔術數量的 `../`、`check-md-links.mjs:10` 用 `git rev-parse`）。**入口**：`scripts/lib/paths.mjs`＋`scripts/lib/root.sh`。
- **S4** bench 參數解析 3 份逐字相同（`scripts/bench/run.mjs:21`、`backend/scripts/bench/run.ts:21`、`siteCache.ts:16`）、`.bench` 路徑 3 處。
- **S5** 備份保留策略 3 套（`backup.sh:132-141` 與 `docker/backup/run.sh:16-22` 為數量制、`backup-vps.sh:42-44` 為時間制）；傾印格式 2 種不相容（純 SQL gz vs `-Fc`），沒有一支還原腳本兩種都讀（`restore.sh` 只讀 `.sql.gz`、`restore-drill.sh:129-136` 只讀 `database.dump`）。**這條可能是真的維運風險，建議先確認備份實際用哪一種。**

---

## 查了但沒問題／刻意不同

- slug：`slugify` vs `headingSlug` 規則不同，是刻意的（各有註解）。
- 數學語法：編輯器與渲染器用兩個解析器，但有 fixture 對拍（`fixtures/math.json`），屬已受控的重複。
- `unified`／`remark` import：已有允許清單，目前沒有違規。
- 圖片 `mediaUrl`／`mediaSrc` 文法：單一來源；唯一差別是 `apiBase` 是否傳入（A4）。

## 建議的守門總設計

原則：**把「哪些檔案准做這件事」寫成資料，預設拒絕，現況違規用棘輪基線（只減不增）。** 三層，成本由低到高：

1. **允許清單表（一個檔案）**：新增 `packages/frontend/src/test/guards/owners.ts`（與 `sources.ts` 同層），內容是 `{ concept, pattern, allowed: string[], baseline?: number }[]`。
   一個通用 guard 測試遍歷它，用既有的 `findUses`（`sources.ts:27`）掃 `src/**`，列出 `rel:line`。markdown 與 backend 各有一份同結構的表（`markdown/src/test/guards/`、`backend/src/test/guards/`）。
   表中第一批概念：callout 標記（A5）、圍欄（A11）、`\[\[`（A6）、`<iframe`／`EMBED_IFRAME_SANDBOX`（A2）、`<mark`（A7）、`t("Untitled")`／`未命名`（A8）、`navigator.clipboard.writeText`（B4）、`on this device`（B2）、`.membership-gate`／`INSERT INTO content_nodes`／`.post("/api/nodes"`（測試）、`pg_dump`（S5）。
2. **ESLint `no-restricted-imports`／`no-restricted-syntax` 的依資料夾區塊**：沿用 `eslint.config.js:85,282-292` 的 `*_OWNERS` 模式，用在「import 某模組」型的規則（A3 `MarkdownRenderer`、`node:child_process` 在 e2e、`node:timers/promises` 在後端測試）。編輯器即時提示，比測試早。
3. **對拍測試（取代「合併」）**：A2 的 React／hast 對拍、A1 的「同一輸入經各摘要函式」表格測試（至少斷言底線、連結、wikilink 三種輸入的差異是**登記過的**），任何新分歧要在表裡寫理由。

通用規則：基線檔 `scripts/owners-baseline.json` 記每條規則的現況數字，沿用 `dup-baseline.json` 的 `dup:baseline` 流程（降低用指令，增加則失敗）；測試目錄要納入（目前 `dup:names` 跳過它們，`scripts/dupLib.mjs:73-74`）。

建議先做的順序（價值／成本）：A8、A5、A9（小且使用者看得到或有安全意涵）→ B1、B2（詞彙表與 helper）→ A3（具名畫面）→ A1、A11（需設計草圖，依 AGENTS.md 先比較兩種）→ A2 對拍測試 → 測試／腳本的棘輪。

## 查了哪些目錄、用了哪些 grep

目錄：`packages/markdown/src`、`packages/site/src`、`packages/frontend/src/{components,lib,modules,hooks}`、`packages/backend/src/{modules/website/publishing,services,modules/rss,modules/importers}`、`packages/frontend/e2e`、`packages/*/src/test`、`scripts/`、`packages/*/scripts`、`docker/backup`。

主要 grep（rg）：
- 管線／渲染：`unified\(|fromMarkdown\(|micromark\(|remark-|rehype-`、`<MarkdownRenderer`、`ondenMarkdownCore|react-markdown`、`classifyMedia|toEmbedUrl|EMBED_IFRAME_SANDBOX`、`accelerometer; autoplay`、`Embedded media`
- 媒體：`/api/media|mediaUrl|mediaSrc`、`getApiBase`
- 純文字／語法變體：`\[[ xX]\]`、`\\\[\\\[`、`\[!`、`HASHTAG_RE|TAG_NAME_CHAR|WORD_CHARS`、`^#{1,6}`、`inFence|inCode|FENCE`、`noteSummary|snippetPlainText|plainText|noteLabel` 呼叫者
- CSS／色：`sanitizeCustomCss|CUSTOM_CSS_MAX`、`isHexColor|HEX_COLOR`
- 其他：`\|\| t\("Untitled"\)`、`未命名`、`zh-Hant|zh-TW`、`HighlightedText|SnippetText`、`headingAnchors\(|headingFragment\(`
- i18n、測試、腳本：由子代理執行，其 grep 清單見各自回報（i18n 以 python 腳本比對 `t("…")` 字面量與 zh 表鍵；測試／腳本以 `const BASE =`、`membership-gate`、`psql`、`INSERT INTO content_nodes`、`stubGlobal("fetch"`、`dirname|BASH_SOURCE|import.meta.url` 等掃描）。

## 限制

- 沒有執行任何程式或測試，也沒有開瀏覽器；矩陣中標「未驗證」的格是從原始碼推得，沒有實際畫面比對。
- 件數是 grep 計數，可能含少數誤判；做守門基線時要重算。
- B 區子代理查證的條目，我只抽查了上述幾處。
