# 跨套件「概念重複」清單（2026-10-30）

> 狀態：現行（進行中的盤點／計畫，完成後移到 docs/archive/）（最後確認 2026-11-01）

範圍：`frontend`、`backend`、`markdown`、`site` 之間，**同一條規則各寫一份、名字和寫法都不同**。
`dup:check`（逐字複製）與 `dup:names`（同名匯出）抓不到這些。只查、不改程式碼。
UI 元件（底部 sheet）另案處理，不在此列。

做法：先逐項確認 [dup-sweep-2026-10-29-cross.md](dup-sweep-2026-10-29-cross.md) 的待辦現況，再用 grep 找新的
（連結 scheme、URL 正規式、`startsWith("_")`、`localeCompare`、`maxLength`／`.max(`、frontmatter 圍欄、`…` 截字、
語言清單、副檔名清單、UUID 正規式、「must stay／twin／mirrors」註解），最後讀兩邊程式確認差異。
行號是 2026-10-30 的 origin/main。「讀程式推得的差異」指我讀程式碼得到的結論，沒有在瀏覽器或資料庫實際跑過；
需要實測的在各條的「待驗證」寫明。

## 總表

依「嚴重度高、工作量小」優先排序。份數＝實際找到的獨立實作數（不含測試）。

| # | 概念 | 份數 | 嚴重度 | 工作量 | 守門方式 |
| --- | --- | --- | --- | --- | --- |
| 1 | 網站語言清單 | 5 | 中（設定頁少一個語言） | 小 | guard test＋共用常數 |
| 2 | 前端「是否在 frontmatter 內」自己判斷 | 3＋1 | 中（邊界輸入結果不同） | 小 | guard test（只准 markdown 的判斷） |
| 3 | 發布頁／預覽的標題與同層排序 locale | 7 | 中（預覽與發布順序可能不同） | 小 | ESLint `no-restricted-syntax` |
| 4 | 名稱長度上限（標籤、檢視、任務標題） | 6 | 中（前端放行、後端拒絕或相反） | 小 | `sharedContract.ts`＋guard test |
| 5 | 連結／圖片 URL 的 scheme 允許清單 | 7＋ | 高（同一個 `tel:` 各處結果不同） | 中 | guard test＋ESLint |
| 6 | 字數（B1-1 仍未收） | 2 | 高（使用者看得到數字） | 中 | guard test |
| 7 | 筆記「一行摘要」／純文字 | 8 | 中 | 中 | guard test（正規式剝語法只准在 markdown） |
| 8 | 系統屬性（`_` 開頭）是否給使用者看／改 | 8＋11 | 中 | 中 | ESLint `no-restricted-syntax` |
| 9 | 自訂 CSS 消毒（B1-2 仍未收） | 2 | 中（安全、需產品決定） | 小（決定後） | guard test |
| 10 | 自訂網域主機名稱規則 | 2 | 低（現在相同，靠註解） | 小 | 共用或對齊測試 |
| 11 | 圖片副檔名／MIME 清單殘餘 | 5 | 低 | 小 | guard test |
| 12 | 鬆散 UUID 檢查（B1-3 仍未收） | 6 | 低 | 小 | guard test |
| 13 | 小常數 B2 系列（任務狀態、保留標籤 key、`newBlockId`、`^id` 長度） | 8 | 低 | 小 | guard test |
| 14 | 手寫「截字加 …」 | 2 | 低 | 小 | ESLint |
| 15 | 註解寫「與某檔相同」但對方已改名／不存在 | 3＋ | 低 | 小 | guard test（註解中的路徑必須存在） |

---

## 1. 網站語言清單

- **概念**：已發布網站可選哪些語言。
- **各自的寫法**
  - `packages/frontend/src/modules/website/siteBasics.ts:11` `SITE_LOCALES`：只有 `zh-TW`、`en`（設定頁的下拉選單）。
  - `packages/frontend/src/components/templates/siteLocale.ts:6` `SiteLocale = "en" | "zh-TW" | "ja"`：網站畫面有日文字典。
  - `packages/markdown/src/siteHead.ts:60` `SITE_LANGS`：`zh-TW`、`en`、`ja`；註解寫「the locales the Design tab offers (siteLocale.ts SITE_LOCALES)」，但那個名稱在 `siteLocale.ts` 不存在（實際在 `siteBasics.ts`）。
  - `packages/backend/src/modules/website/publishing/singleNoteHtml.ts:29`：`locale === "en" ? "en" : locale === "ja" ? "ja" : "zh-Hant"`，**輸出的是 `zh-Hant`**，而 `siteHead` 對同一個 `zh-TW` 輸出 `zh-TW`。
  - 另 `frontend/src/lib/timeZoneSearch.ts:51` 有一份只含 `zh-TW`、`en` 的介面語言清單（用途不同：介面語言，不是網站語言，列在此以免誤併）。
- **差異**：設定頁選不到日文，但三處程式都支援；同一個站，單篇 HTML（backend）的 `<html lang>` 是 `zh-Hant`，整站 head（markdown）是 `zh-TW`。
- **建議的唯一入口**：`@onden/markdown` `siteHead.ts` 匯出 `SITE_LOCALES`（值、標籤另放）與 `siteLang()`；`singleNoteHtml.ts` 改呼叫 `siteLang`；設定頁從同一份清單產生選項。是否開放日文是產品決定，先決定再收。
- **怎麼擋住**：guard test 掃四個套件，字串 `"ja"` 與 `"zh-TW"` 同時出現在一個陣列／聯集的檔案只准 `siteHead.ts`（目前違規 4 處：siteBasics、siteLocale、singleNoteHtml，加 siteHead 本身為主人）。
- **嚴重度**：中。**工作量**：小。

## 2. 前端「是否在 frontmatter 內」自己判斷

- **概念**：哪些行屬於筆記開頭的 `---` 設定區塊。
- **各自的寫法**
  - `packages/markdown/src/frontmatter.ts:44` `readFrontmatter`：用 `FENCE` 正規式，**必須有收尾的 `---`** 才算 frontmatter。
  - `packages/frontend/src/lib/editorEmbeds.ts:200` `inFrontmatter`：第 1 行是 `---`（`trimEnd()` 後相等）就往下找收尾，**找不到收尾就一路算在 frontmatter 內**（迴圈到 `lineNo` 都沒遇到第二條 `---` 就回傳 true）。
  - `packages/frontend/src/lib/editorFrontmatter.ts:19` `CLOSED_FENCE = /^---[ \t]*$/`、`frontmatterRange`：逐行找，註解說「Same fences as readFrontmatter」，需要收尾，與 `readFrontmatter` 一致。
  - `packages/frontend/src/modules/slides/slides.ts:61`：`l.trim() === "---"` 當分隔線處理（用途不同，只列出）。
- **差異（讀程式推得）**：一篇以 `---` 水平線開頭、後面沒有第二條 `---` 的筆記，`readFrontmatter` 說「沒有 frontmatter」，`editorEmbeds.inFrontmatter` 說「整篇都是」，編輯器於是不把之後的 `![](…)` 畫成圖片（見 `editorEmbeds.ts:237`、`:294`）。`---` 後面帶空白、tab：`trimEnd()` 與 `[ \t]*$` 一致；帶 ` ` 則兩邊不同。待驗證：在編輯器貼入此內容看圖是否顯示。
- **建議的唯一入口**：`markdown/frontmatter.ts` 補一個不複製全文的「行範圍」函式（`frontmatterRange(lines)`），`editorFrontmatter.ts` 的 `frontmatterRange` 本來就是要做這件事，`editorEmbeds` 改用它，不再自己找圍欄。
- **怎麼擋住**：guard test：`frontend/src` 內字面量 `"---"`、`/^---/` 只准出現在 `editorFrontmatter.ts`、`slides/slides.ts`、`whatsNew.ts`（changes/ 檔格式，另有自己的規則）；目前違規 1 處（`editorEmbeds.ts:201-202`）。
- **嚴重度**：中（邊界輸入）。**工作量**：小。

## 3. 發布頁／預覽的標題與同層排序 locale

- **概念**：同一份清單依標題排序、同層前後篇的順序。
- **各自的寫法**
  - `packages/frontend/src/components/siteFrame/siteModel.ts:112-113` `bySort`：`sort_order` 再 `title.localeCompare(…, "zh-Hant")`，決定上一篇／下一篇。
  - `packages/site/src/react/render.tsx:139`：`localeCompare(b.title, "zh-Hant")`（首頁元件依標題排）。
  - `packages/backend/src/modules/website/publishing/siteDiff.ts:99-103`：同一種「同層順序」（`sort_order`、`created_at`、再 `title.localeCompare` **不帶 locale**），用來判斷哪些頁的前後篇連結變了。
  - `packages/frontend/src/modules/website/studio/editorData.ts:70`：標籤依筆數再 `localeCompare(…, "zh-Hant")`。
  - 不帶 locale 的：`components/OverviewSidebar.tsx:152`、`components/tagPage/membersModel.ts:19`、`lib/tagTree.ts:26`、`lib/tagSuggestions.ts:29` 等約 30 處（`grep -rn localeCompare` 共 40 處）；另有 ISO 時間用 `localeCompare` 比（`lib/noteOrder.ts:4`、`modules/daily/journal.ts:31`、`capture/inbox.ts:46`），比字串碰巧對，但不是「比時間」。
- **差異（讀程式推得）**：不帶 locale 的 `localeCompare` 用執行環境的語系（Node 在伺服器上通常是 `en-US`），帶 `"zh-Hant"` 的用注音排序；同一批標題在 backend 判斷「前後篇有沒有變」與在網站顯示的前後篇，順序可能不同，造成多重發布或漏重發。待驗證：用幾個中文標題分別在兩邊排序比較。
- **建議的唯一入口**：`@onden/markdown` 新增 `compareTitles(a, b)`（固定 `zh-Hant`）與 `compareIso(a, b)`；`bySort` 的 `sort_order → title` 規則也放進去，供 `siteModel`、`siteDiff`、`render.tsx` 共用。App 內部不影響發布的清單（側欄）可以先不動，但要走 `compareTitles`，由守門逼出決定。
- **怎麼擋住**：ESLint `no-restricted-syntax`：`CallExpression[callee.property.name='localeCompare']` 在 `src` 內禁止（例外檔寫在規則裡，只准減少）。目前違規約 40 處，其中 3 處（siteModel、render、siteDiff）要先收。
- **嚴重度**：中。**工作量**：小（前 3 處）／中（全部）。

## 4. 名稱長度上限（標籤、檢視、任務標題）

- **概念**：一個名稱最長幾個字。
- **各自的寫法**
  - 標籤名稱：前端輸入框 `components/CreateTagForm.tsx:53` `maxLength={100}`；後端 `routes/tags.ts:86` `.max(200)`；代理工具 `services/agentTools/proposeTagPack.ts:23,28` `.max(80)`；標籤檢視 `services/tagViews.ts:50` `.max(80)`。
  - 任務標題：`modules/tasks/fields.ts:20`、`modules/tasks/update.ts:36` 各寫 `.max(500)`，`blockTasks.ts:30` 的 `TITLE_MAX = 500`；筆記標題另有 `@onden/markdown` `noteLimits.ts` 的 `NODE_TITLE_MAX = 500`（四個套件共用，這個是對的）。
  - 空間名稱兩邊都是 80（`SpaceList.tsx:104`、`routes/spaces.ts:35`），一致但各寫各的。
- **差異**：標籤名稱前端最多 100、後端 200、代理 80：代理工具建議的名稱若 81–200 字，後端收、前端輸入框不收（改名時會被截）。
- **建議的唯一入口**：`sharedContract.ts` 新增 `TAG_NAME_MAX`、`SPACE_NAME_MAX`、`TASK_TITLE_MAX`（= `NODE_TITLE_MAX`）；前端 `maxLength`、後端 `.max()` 都引用。先決定標籤名稱到底多少（建議 100）。
- **怎麼擋住**：guard test：`src` 內 `.max(<數字>)` 與 JSX `maxLength={<數字>}` 的數字字面量，在一份「名稱類」白名單檔以外禁止；目前「名稱類」違規約 9 處（上列）。更機械的版本：zod `.max(` 只准接常數名。
- **嚴重度**：中。**工作量**：小。

## 5. 連結／圖片 URL 的 scheme 允許清單

- **概念**：哪些網址 scheme 可以當連結或圖片使用。
- **各自的寫法**
  - `packages/markdown/src/sanitizeSchema.ts:45`：以 rehype-sanitize `defaultSchema` 為底（href：`http https irc ircs mailto xmpp`，**沒有 `tel`**），`src` 另外加 `data`。閱讀畫面、發布頁共用。
  - `packages/frontend/src/lib/editorLinkFollow.ts:38` `SAFE_URL = /^(?:https?:|mailto:|tel:)/i`：編輯器點連結可開 `tel:`。
  - `packages/backend/src/modules/website/publishing/htmlUtils.ts:34` `safeUrl`：允許 http、https、mailto 與沒有 scheme 的相對路徑；**`tel:` 變 `#`**。
  - `packages/backend/src/modules/rss/sanitize.ts:92`：允許 `https? data mailto tel #`。
  - `packages/backend/src/modules/website/publishing/siteRows.ts:23` `safeImageUrl`：只收 `http(s)://` 與站內 `/…`（拒絕 `//host`）。
  - `packages/frontend/src/lib/editorEmbeds.ts:196` `editorImageSrc`：`^https?:` 或 `/api/media/`。
  - `packages/frontend/src/lib/siteShareImage.ts:12`：`^https?://`；`modules/gallery/GalleryLayout.tsx:31` `IMAGE_URL_RE`（`http(s)://` 或 `/`，加副檔名）。
  - 其餘 `^https?:` 檢查：`routes/bookmark.ts:33`、`rss/feedUrl.ts:17`、`rss/htmlToMarkdown.ts:143`、`lib/api.ts:405,504`、`lib/invite.ts:75`、`lib/auth-client.ts:21`、`CardNode.tsx:262`、`MarkdownEditor.tsx:1039`（用途多半是「這是不是網址」，不是安全判斷，要分開）。
- **差異（讀程式推得）**：同一個 `tel:` 連結，編輯器可以點開、閱讀畫面（sanitize）移除連結、發布頁（`safeUrl`）變成 `#`、RSS 保留。`data:` 在 RSS 與 sanitize 的 `src` 可以，`safeUrl` 沒有「可以放什麼」的圖片規則（`siteRows.safeImageUrl` 與 `editorImageSrc` 各是一種）。待驗證：在筆記寫 `[打電話](tel:0912345678)`，分別看編輯器、閱讀、發布預覽。
- **建議的唯一入口**：`@onden/markdown` 新增 `urlSchemes.ts`：`isSafeLinkHref(url)`、`isSafeImageSrc(url)`（兩種用途各一個函式，allowlist 各一份），`sanitizeSchema`、`safeUrl`、`safeImageUrl`、`editorLinkFollow`、`editorImageSrc` 都改用。先決定 `tel:` 要不要在所有地方開放。
- **怎麼擋住**：guard test：`src` 內含 `/\^?\(?:?https\?:/` 這類 scheme 正規式、或字串 `"javascript:"`、`"mailto:"`、`"tel:"` 的檔案，必須在白名單（`markdown/urlSchemes.ts` 加「只是判斷是不是網址」的幾個檔，如 `api.ts`、`invite.ts`），其餘違規；目前違規約 12 處（不含白名單）。
- **嚴重度**：高。**工作量**：中。

## 6. 字數（B1-1，上一輪待辦，仍未收）

- **概念**：編輯器顯示的字數，與發布頁閱讀時間所算的字。
- **各自的寫法**：`packages/frontend/src/lib/wordStats.ts:20,36,39`（自己的 `CJK` 與剝語法規則，`countWords` 在 `:45`）；`packages/markdown/src/readingTime.ts`（`CJK`、`proseOf`）。閱讀時間已共用 `readingMinutes`，字數沒有。
- **差異**：同上一輪（`~~~` 圍欄、frontmatter、`ー`、Jamo）。現況確認：`wordStats.ts` 仍只剝 ``` 圍欄、不剝 frontmatter；`markdown` 沒有 `countWords`。
- **建議的唯一入口**：`@onden/markdown` `countWords`，與 `readingMinutes` 共用 `proseOf`（上一輪批次 B）。
- **怎麼擋住**：guard test：`/\\p\{Script=Han\}|\\u4e00|一-鿿/` 只准在 `markdown/` 內；目前違規 1 處（`wordStats.ts:20`）。
- **嚴重度**：高。**工作量**：中（要先決定長音算不算）。

## 7. 筆記「一行摘要」／純文字

- **概念**：把 Markdown 變成一行可讀文字（收件匣、成員列表、RSS、發布頁、側欄標籤）。
- **各自的寫法**
  - `@onden/markdown` 內有 5 套：`summary.ts:86` `plainInline`、`paragraphs.ts:297` `plainInline`、`linkContext.ts:94` `plainRun`／`:127` `plainText`、`snippet.ts:67` `plainFromBody`／`snippetPlainText`、`wordStats` 用的剝語法。四者剝的東西不同：`summary.ts` 去掉 `>`；`paragraphs.ts` 處理 `==高亮==` 與 `~~`；`linkContext.ts` 另剝 `<html>`、`[^1]`；`snippet.ts` 只去 `*`、`` ` ``、標題 `#`。
  - 前端 `modules/capture/InboxScreen.tsx:26` `excerpt`：直接取原始 Markdown 第二行起、**不剝語法**，`## 標題`、`**粗體**` 會原樣顯示。
  - 前端 `components/MemberList.tsx:34` `bodyExcerpt`：用 `snippetPlainText` 再自己去 `#tag`、去標題前綴。
  - 前端 `lib/noteLabel.ts:17`：自己的正規式去 `>`、`#`、清單、`[ ]`。
  - 前端 `lib/tagTree.ts:181`、`lib/editorLinkFollow.ts:181`：各自 `replace(/^\s*#{1,6}\s+/…)`。
  - 後端 `publishing/siteRows.ts:40` `excerptOf` 與前端 `lib/siteFeed.ts:49` `feedSummary` 都走 `noteSummary`（正確，是樣板）。
- **差異**：收件匣一則「`## 今天要做`」顯示成 `## 今天要做`，成員列表顯示成「今天要做」。待驗證：實機看收件匣。
- **建議的唯一入口**：`noteSummary`（`markdown/summary.ts`）當「一行」的主人；`snippetPlainText`／`plainText` 當「全文純文字」的主人；markdown 內部 4 套先判斷是否能化為一個 `plainInline`（需要逐項比對輸出的測試）。
- **怎麼擋住**：guard test：前端、後端 `src` 不准出現「剝標題記號」的正規式 `/#\{1,6\}\\s/` 組合；目前違規 7 處（noteLabel、tagTree、editorLinkFollow、reviewExtract:21、slides:45、editorFormat:106-125（編輯用，非剝語法，列例外）、site `render.tsx:24`）。
- **嚴重度**：中。**工作量**：中。

## 8. 系統屬性（`_` 開頭）是否給使用者看／改

- **概念**：屬性鍵以 `_` 開頭是系統用的，使用者介面不顯示、匯出不帶、客戶端不可寫（除少數白名單）。
- **各自的寫法**
  - 後端 `services/systemAttributes.ts:32` `isWritableAttributeKey`：`!startsWith("_") || key in VALUE_RULES`（`_published`、`_pinned`、`_color`、`_captured` 例外可寫）。
  - 後端另 10 處各自 `startsWith("_")`：`nodes.ts:192,221`、`nodeQuery.ts:112`、`childAttributes.ts:47`、`backupRestore.ts:120`、`exportZip.ts:163,174`、`importers/shared/relations.ts:41`、`siteRows.ts:65`、`nodes.ts:87`（slug）。
  - 前端 6 處：`components/NodeAttributesPanel.tsx:142,209,349`（另加 `INTERNAL_ATTRIBUTE_KEYS` 集合）、`lib/childFields.ts:20`（另加 `MACHINERY_KEYS`）、`tagPage/promotable.ts:20`、`modules/website/studio/editorData.ts:133`。
  - 常數 `_published`：前端 `modules/website/publishBlocker.ts:15` `PUBLISHED_ATTR`、後端 `systemAttributes.ts:9` `PUBLISHED_KEY`；`publishedSet.ts:93,125`、`noteDuplicate.ts:113` 直接寫字串。
- **差異**：前端「隱藏」把所有 `_` 一律隱藏（`_color` 使用者其實能設，`_pinned` 由選單設），後端「可寫」有白名單；另有非 `_` 開頭的系統鍵（`ink_data`、`page_text`、`pdf_*` 等）前端靠 `MACHINERY_KEYS`、`INTERNAL_ATTRIBUTE_KEYS` 兩份集合，後端沒有對應清單。新增一個系統鍵要同時記得改 3 處以上，漏了就會在屬性面板或匯出出現。
- **建議的唯一入口**：`@onden/markdown` `sharedContract.ts` 的 `SYSTEM_ATTRIBUTE`：`isSystemAttributeKey(key)`（含 `_` 前綴與機器鍵清單）、`PUBLISHED_ATTR`，前後端都引用；後端的「可寫白名單」留在 `systemAttributes.ts`。
- **怎麼擋住**：ESLint `no-restricted-syntax`：`startsWith("_")`（字面量 `"_"`）在 `src` 禁止，例外只列 `systemAttributes.ts`；目前違規 17 處。
- **嚴重度**：中。**工作量**：中。

## 9. 自訂 CSS 消毒（B1-2，仍未收）

- **概念**：站主 CSS 放進 `<style>` 前的處理。
- **各自的寫法**：`backend/.../publishing/htmlUtils.ts:52` `sanitizeCustomCss`（截 50,000、`<`→`\3c `、保留 `@import`）；`site/src/css.ts:41` `sanitizeSiteCss`（另去 `@import`、`@\`）。兩邊註解仍指向已不存在的 `frontend lib/customCss.ts`（`htmlUtils.ts:50`、`css.ts:3`）。
- **差異**：`@import url(https://…)` 後端保留、site 去掉。
- **建議的唯一入口與擋法**：同上一輪批次 E，先決定 `@import` 是否允許。擋法：guard test 掃 `replace(/</g, "\\3c ")` 只准在 `site/src/css.ts`；目前違規 2 處（`css.ts:44`、`htmlUtils.ts:54`）。
- **嚴重度**：中（安全）。**工作量**：小（決定後）。

## 10. 自訂網域主機名稱規則

- **概念**：自訂網域能填什麼。
- **各自的寫法**：`frontend/src/modules/website/siteBasics.ts:50` `HOSTNAME`＋`parseCustomDomain`（`:54`）；`backend/.../publishing/cname.ts:13` `HOSTNAME`＋`normalizeCustomDomain`（`:21`）。正規式與「去 scheme、去路徑、小寫」的步驟逐字相同，靠註解「Same rule as the server's」維持（`siteBasics.ts:48`）。
- **差異**：目前沒有；任何一邊改了另一邊不會報錯。
- **建議的唯一入口**：`@onden/site`（site 套件已是 backend／frontend 共用）新增 `customDomain.ts`。
- **怎麼擋住**：guard test：`(?=.{1,253}$)` 這串只准出現一次；目前 2 處。
- **嚴重度**：低。**工作量**：小。

## 11. 圖片副檔名／MIME 清單殘餘

- **概念**：哪些副檔名是圖片。`markdown/mediaTypes.ts` 已是唯一表。
- **各自的寫法**：`frontend/.../gallery/GalleryLayout.tsx:31`（`png|jpe?g|gif|webp|avif|svg`）；`frontend/.../website/studio/SiteImageField.tsx:14-15`（只收 png、jpg、webp、svg）；`backend/src/services/media.ts:131,134,151`（`OPTIMIZE_EXTS`、副檔名→sharp 格式）；`backend/.../agentTools/getAttachment.ts:28`（`DIRECT_IMAGE_MIMES`）。
- **差異**：站台圖片欄位不收 gif／avif，但 `mediaTypes` 都收；`getAttachment` 不收 avif。多半是刻意（站台圖示需要小而穩的格式），但沒有註明。
- **建議的唯一入口**：`mediaTypes.ts` 補 `isImageExt(ext)`、`imageMimes()`；有意縮小的清單（站台圖示）命名為子集合並註明理由。
- **怎麼擋住**：guard test：`png|jpe?g`、`"image/png"` 字面量只准在 `markdown/mediaTypes.ts`、`services/media.ts`（sharp 格式表）；目前違規 3 處。
- **嚴重度**：低。**工作量**：小。

## 12. 鬆散 UUID 檢查（B1-3，仍未收）

- **概念**：字串是不是 UUID。`isUuid`／`UUID_SOURCE` 已在 markdown。
- **各自的寫法**（現況確認，非測試程式 6 處）：`backend/src/modules/rss/routes.ts:204`、`services/tasksStore.ts:254`、`services/githubBackup.ts:132`、`services/agentSessions.ts:98`、`services/backupRestore.ts:458`、`services/exportZip.ts:69`。
- **差異**：`[0-9a-f-]{36}` 接受 36 個連字號，通過後在資料庫 `::uuid` 才失敗。
- **建議／擋法**：同上一輪批次 C。guard test：`{36}` 與 `[0-9a-f-]` 同行出現禁止，目前違規 6 處。
- **嚴重度**：低。**工作量**：小。

## 13. 小常數 B2 系列（現況確認）

全部仍未收，位置沒變：
- 任務狀態：前端 `lib/tasks/noteTasks.ts:24`（5 個）、`lib/api.ts:100`（6 個，含 `later`）；後端 `modules/tasks/agenda.ts:14`（6 個）、`modules/tasks/noteUpdate.ts:21`（5 個）。
- 保留標籤 key：前端 `lib/systemNodes.ts:9`（含已不保留的 `"task"`）、後端 `spine/reservedTagKeys.ts`。
- `newBlockId`：前端 `lib/data/draftActions.ts:125`（8 字）、後端 `services/blockNodes.ts:31`（6 字）；`agentSessions.ts` 另有一份。
- `^id` 長度：`BLOCK_ID_MAX = 64`（`markdown/blockId.ts:10`）後端 `placement.ts`、`taskListFile.ts` 沒套用。
- **擋法**：guard test 掃 `"waiting"` 與 `"cancelled"` 同一個陣列字面量、`randomBytes(4).toString("hex")`；目前各 2–3 處。
- **嚴重度**：低。**工作量**：小（批次 A）。

## 14. 手寫「截字加 …」

- **概念**：把字串截短並加 `…`。`markdown/graphemes.ts:88` `ellipsize` 是主人（上限含 `…`）。
- **各自的寫法**：`frontend/src/components/history/BlockHistorySheet.tsx:31` `clip`、`frontend/src/lib/noteLabel.ts:20`：`cutToUnits(s, N) + "…"`，結果比 N 多 1 個單位；`lib/blockRefSearch.ts:68` 手動窗口加 `…`（用途是窗口，不併）。
- **差異**：上限差 1；其餘都已用 `ellipsize`（5 檔）。
- **擋法**：ESLint `no-restricted-syntax`：`TemplateLiteral` 含 `cutToUnits(` 後接 `…` 難寫；改 guard test：同一行同時有 `cutToUnits(` 與 `"…"` 禁止，目前 2 處。
- **嚴重度**：低。**工作量**：小。

## 15. 註解寫「與某檔相同」但對方已不存在

- **概念**：靠註解維持一致時，路徑會過期。
- **例**：`backend/.../htmlUtils.ts:50` 與 `site/src/css.ts:3` 指向 `frontend lib/customCss.ts`（不存在）；`frontend/src/lib/data/taskAgenda.ts:12` 寫後端是 `services/taskAgenda.ts`，實際在 `modules/tasks/agenda.ts`（測試 `taskAgendaDone.test.ts:33` 讀的是正確路徑，所以測試有效、只有註解過期）；`markdown/src/siteHead.ts:59` 指 `siteLocale.ts SITE_LOCALES`（實際在 `siteBasics.ts`）。
- **擋法**：guard test：掃註解中符合 `\b(lib|services|modules|components)/[\w/.-]+\.(ts|tsx)\b` 的路徑，必須存在於任一套件的 `src/`；目前至少 4 處違規。
- **嚴重度**：低。**工作量**：小。

---

## 上一輪待辦現況（dup-sweep-2026-10-29-cross.md）

| 項目 | 現況 |
| --- | --- |
| B1-1 字數 | 未收（第 6 條） |
| B1-2 自訂 CSS | 未收，註解更過期（第 9 條） |
| B1-3 鬆散 UUID | 未收（第 12 條） |
| B2-1～B2-5 | 未收（第 13 條） |
| B3-1 `canPlaceUnder` | 本輪未重查 |
| B3-2、B3-3 | 本輪未重查 |

## 查過、已對齊、不需要動

- 任務 bucket：前端 `lib/data/taskAgenda.ts:30` 走 `@onden/markdown` `taskBucket`，後端有 `taskBucketRule.integration.test.ts` 對齊。
- 搜尋詞切分：`localDbWorker.ts:1181,1192` 與 `services/nodeSearch.ts` 都用 `snippetAround`；詞的切法 `queryTerms` 只在前端／markdown，後端用 pgroonga 自己的關鍵字抽取（`nodeSearch.ts:121`），兩邊命中集合不同是刻意（本地 FTS5／LIKE 對伺服器 pgroonga）。
- Bases 篩選評估：`frontend/src/lib/basesEval.ts` 只是 `markdown/basesEval.ts` 的接線層。
- 發布的邊類型、標籤名稱字元：已在 markdown（`TAG_NAME_CHAR`、`HASHTAG_RE`）；標籤名稱形狀 `TAG_NAME_FORBIDDEN` 只在後端 `tagHierarchy.ts:121`（前端靠 `writtenTagNameParity` 測試對齊）。
- API 型別：`frontend/src/lib/api.ts` 與後端回應形狀由 `apiContract.test.ts`＋`markdown/contract/api-shapes.json` 對齊；`SiteConfig` 在兩邊各一份（`api.ts:215`、`services/siteConfig.ts:131`）屬同一機制涵蓋範圍。
- 時間：沒有再找到 `new Date().toISOString().slice(0, 10)` 當「今天」的用法（剩下的是把某個時間戳轉日期：`sitemap.xml.ts:23`、`siteRows.ts:51`）。

---

## 建議的守門總設計

**放 ESLint（寫在單一檔案、能就地報錯、IDE 看得到）**
- `localeCompare` 呼叫（第 3 條）、`startsWith("_")`（第 8 條）：`no-restricted-syntax`，例外以 `overrides.files` 列出。
- 例外名單放在 `eslint.config` 內一個陣列，PR 只准刪除項目；用既有 `scripts/*baseline.json` 同款方式管理（數字下降時降低基準）。

**放 guard test（要跨檔案、跨套件掃描，或需要讀註解／路徑的）**
- 第 1、2、4、5、6、7、9、10、11、12、13、14、15 條。寫法沿用 `frontend/src/test/guards/sources.ts` 的掃檔函式；跨套件的放在 `packages/markdown/src/test/guards/crossPackage.guard.test.ts`（它已掃四個套件）。
- 每條規則格式相同：`{ id, pattern, allow: [{file, reason}] }`，違規＝符合 pattern 且檔案不在 allow。

**例外名單怎麼管（只准減少）**
- 一律寫在 `scripts/guard-allow.json`（新檔，一個規則 id 對一份清單）；每筆要有 `file` 與 `reason`。
- guard test 同時檢查兩件事：(a) 清單外出現新違規 → 失敗；(b) 清單內某檔已不違規 → 也失敗，要求把它刪掉。這樣名單只會變短，不會留下死例外。
- 規則數量上限：每個 PR 的 `allow` 筆數不得增加（和 `dup:check` 同樣的基準檔機制，CI 比對 `origin/main`）。

**建議的收斂順序**：先做第 1、2、3、4 條（小而使用者可能看到差異），同一批加守門；第 5 條先做產品決定（`tel:`／`data:`），再一次收；第 6、7、8 條各自一批；其餘併入先前的批次 A、C、E、F。
