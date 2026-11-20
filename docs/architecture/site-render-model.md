# 網站的呈現模型（W38）

> 狀態：現行
> 涵蓋：packages/backend/src/modules/website/publishing/servedSite.ts, packages/backend/src/modules/website/publishing/publishedSet.ts, packages/backend/src/modules/website/publishing/takenDown.ts, packages/backend/src/modules/website/publishing/snapshot.ts, packages/backend/src/modules/website/publishing/preview.ts, packages/backend/src/modules/website/publishing/siteDiff.ts, packages/backend/src/modules/website/publishing/handwritingPages.ts, packages/backend/src/modules/website/publishing/pagesPush.ts, packages/backend/src/services/siteDefault.ts, packages/frontend/src/components/siteFrame/**

何時讀：改發布、網站上有哪些筆記、下架、發布前預覽、網站的 Markdown 輸出或手寫頁時。
W38 開工前的「現況」（兩套渲染器、快照與即時資料混用）、選項比較與實作順序已移到 [site-render-model-history.md](site-render-model-history.md)。
發布改版的整體設計見 [發布改版](proposals/publish-redesign-2026-10-24.md)（分享連結、學員 token、集合、`pageLayouts`、`site.json`、`dist-published` 都已刪除）；
版面是「盒子與零件」，見 [網站的盒子模型](proposals/site-boxes-2026-11-01.md)；舊網址轉址見 [舊網址轉址](proposals/site-stable-urls-2026-11-04.md)；
流程圖與狀態圖在發布時排好版，見 [發布時預先排好的圖表](precompiled-diagrams.md)。

## 呈現模型：快照為準，下架即時（使用者 2026-10-14 決定，選項 B）

- 網站的內容與設定是最近一次發布的快照（`publish_snapshots` 一列，`publishing/snapshot.ts buildAndEnqueueSnapshot`）：筆記的 Markdown 原文（id、標題、slug、正文、父層、標籤）、edges、首頁，
  先做 redaction（未發布的 wikilink 變成「(private)」、未發布的父層拿掉）。快照另帶 `redirects`。
- 即時資料只能**撤下**，不能新增或修改內容：服務出去的是「最近快照 − 下架」（`servedSite.ts loadServedSite`；下架判斷見下面的「拿下來的內容不會自己回來」）。
  快照之後新發布的筆記、改過的正文與設定，等下一次發布才生效；沒有快照時網站是空的。
- 同一份「快照 − 下架」是所有出口的來源：自架的 `/site/...`（`packages/frontend/src/pages/site/`，Astro SSR，讀 `GET /api/site`）、zip 匯出（`GET /api/export-static`）、外部靜態主機（`pagesPush.ts`，用 `loadServedSite`）、
  單篇匯出（`singleNoteHtml.ts`）。zip 與靜態主機存的是同一份已渲染的 HTML（`siteBundle.ts`）。
- 媒體：匿名讀者看圖時，`canReadMedia`（`services/mediaAccess.ts`）檢查擁有它的筆記是否仍在「快照 − 下架」裡（`servedSiteShowsMedia`）；靜態主機只打包網站引用到的檔案（`mediaBundle`）。

## 網站上有哪些筆記（業主 2026-11-10，2026-11-13、2026-11-14 補充）

2026-11-10：網站上有哪些筆記改成**以空間決定**（業主，參考 Obsidian Publish 的包含資料夾、Notion 的頁面樹、Logseq 的全部公開）：空間打開「發布到網站」，裡面的筆記都在網站上，除非被排除——筆記自己的「不發布」（`_published` = `false`，優先於空間）、空白筆記（沒有文字、底下沒有筆記、旁邊沒存東西）、從訂閱存下的文章（`source_type = rss`）。「發布」（`true`）讓空白筆記或存下的文章照樣上去；在不發布的空間裡沒有作用。唯一條件在 `publishing/publishedSet.ts publishedNodeIds`。首頁沒指定時，用網站頁數最多的那個空間的最上層筆記（`siteHome.ts`）。新工作區的預設空間發布開關是關的；migration 186 把從沒發布過東西的空間關掉。下文寫的「`_published` 的筆記」都改讀成「網站上的筆記」。

2026-11-13（業主）：**在「不發布」的筆記底下新建的筆記，預設也「不發布」。** 只看**直接上層**自己的 `_published`：上層是 `false`，新筆記就帶 `false`；上層的上層不發布、但上層已被「放回網站」，照一般筆記算。決定只在「新建」那一刻（`noteCreate.ts createNote`，另有複製與範本子項兩個不經 `createNote` 的 INSERT，都呼叫 `services/siteDefault.ts`），前後端共用 `@onden/markdown` 的 `newNoteSiteDefault`，離線建立時前端先畫出同樣的結果。**不改既有筆記**（沒有 migration，不補標記）；**搬動筆記不套用這條**（跟不跟著變待業主決定）。怎麼分辨「自己標的」與「繼承預設的」：繼承時除了 `_published`＝`false`，再寫一個系統屬性 `_published_by_parent`＝`true`；之後任何對 `_published` 的寫入（不發布、發布、放回網站＝移除）都會移除它，所以帶著它的「不發布」一定是預設來的。發布前預覽的 `left_out` 多一個原因 `kept_off_by_parent`（舊版前端不認得時，與 `kept_off` 一樣當成「不發布」顯示）；筆記的網站列與預覽對話框用白話說明原因，旁邊有「放回網站」。

2026-11-14（業主，「按建議」）三條發布規則：

1. **拿下來的內容不會自己回來。** 筆記離開網站（不發布、刪除、所在空間的發布關掉），之後又符合條件（「放回網站」、還原、重新打開空間開關），**不會**立刻用舊快照的文字重新上線，要等業主下一次按發布。做法：服務出去的是「最近快照 − 下架」，所以在**會讓東西下架的同一個交易**裡（網站模組的 hook 本來就在那裡要求重建，`requestSiteRebuild`）先把「快照裡有、現在已不在發布集合」的筆記 id 記進**那份快照自己的 payload**（`taken_down`，`publishing/takenDown.ts recordTakedowns`）。讀者面的所有出口（`loadServedSite`、媒體閘門 `servedSiteShowsMedia`、筆記的網站狀態 `noteSiteState`）用 `servedNodeIds` ＝ 發布集合 − `taken_down`；新快照與預覽仍用 `publishedNodeIds`，所以下一次發布會把它們（以現在的文字）帶回來，記錄隨舊快照作廢，不需要清除、也**沒有 migration**。發布前預覽的 `diff.returning` 列出這些筆記（不再重複列在 `changed`）；前端在「放回網站」與空間開關旁說明「下次發布時才會回到網站上」。已知限制：筆記被清空變成空白又重新寫字，這條路沒有 hook，不在記錄內（空白期間本來就不在發布集合；之後文字回來時仍照舊快照的版本，需另案決定要不要掛 body hook）。
2. **「不發布這則」遇到底下還有網站上的筆記時問一次**：「底下 N 則要不要一起不發布？」（一起不發布／只有這則）。「一起」走 `POST /api/publish/keep-off-subtree`（`services/siteDefault.ts keepSubtreeOffSite`）：同一個交易裡，根的 `ATTRIBUTE_SET` 是原因，每則底下的 live 筆記各自的 `ATTRIBUTE_SET` 都 `triggered_by` 它，各自用自己的 `set_attribute` 權限判斷（任何一則不行就全部不寫），所以一次 `restoreEvent(根事件, { cascade: true })` 就是一次復原。「只有這則」維持原行為：底下的筆記仍在網站上，`scrubUnpublishedParents` 把它們的上層拿掉（不洩漏不發布的上層）；該筆記的網站列顯示「底下 N 則仍在網站上」。**搬動**筆記到「不發布」的筆記底下：目前沒有相關對話框，維持原樣（搬動不套用此規則）。
3. **網站是工作區擁有者的。** 非擁有者不能把自己的個人空間打開「發布到網站」（`services/spaces.ts updateSpace` 回 403 `owner_only`；設定 › 空間與成員不顯示該開關）；`spine/spaceScope.ts publishableSpaceNodeIds`（發布集合的共同底線）也**永遠不含**非擁有者個人空間的筆記，即使開關早已是開的，所以不需要 migration。擁有者自己的個人空間照舊可以。


## 一套 Markdown 管線

網站、匯出與 App 用同一份管線 `ondenMarkdown(profile)`（`@onden/markdown`，說明見其 README），只有兩種 profile：`app`（編輯器、卡片、複習、RSS 閱讀器）與 `published`（網站、匯出）。
後端 `publishing/htmlUtils.ts md2html` 是 `published` profile 的靜態 HTML 輸出；前端 `components/MarkdownRenderer.tsx` 用同一份管線，由 `profile` 選擇。

- **`published` 不吃內嵌 HTML**：筆記裡的 HTML 顯示成文字；匯出跟著網站走，因為匯出就是網站的離線版本。放行的是 Onden 編輯器自己會寫出的標籤（底線 `<u>`、螢光筆 `<mark>`、`<audio>`、`<video>`、`<source>`，
  以及圖說用的 `<figure>`／`<figcaption>`、白名單主機的嵌入 `<iframe>`），屬性仍經 sanitize 過濾（例如 `onerror`、`style` 會被拿掉）。sanitize schema 只有一份（`markdown/src/sanitizeSchema.ts`），快照測試把關。
- **mermaid 不打包進匯出**：網站載入後再畫；zip 與單篇 HTML 輸出 `<pre class="mermaid">`，離線開啟時顯示原始碼。流程圖與狀態圖例外，見 [發布時預先排好的圖表](precompiled-diagrams.md)。
- 網站有 callouts；數學由 remark-math + KaTeX 渲染。`math` 選項只在 RSS 閱讀器關掉（外部文章裡的 `$5 to $10` 是價格）。
- class 只允許管線自己用的（callout、math、程式語言、`md-`），避免筆記或 RSS 文章借用 App 的 CSS 偽裝畫面。

## 發布前預覽：預覽就是候選快照

- `POST /api/publish/preview`（唯讀，與發布同一個權限）用和 `buildAndEnqueueSnapshot` 同一個建構函式（`buildCandidate`）產生候選快照，不寫入、不排推送，回傳：
  與**上次發布的快照**的差異（新增、移除、內容有改、順序有動、連結有變、設定有變）、會變成「(private)」的連結、不會公開或不會打包的圖片、候選內容的 hash，以及 `left_out`。
  差異是跟上次快照比，不是跟讀者現在看到的比：下架立即生效，讀者看到的永遠是候選的子集，拿來比的話「移除」永遠是空的；已經下架、這次才正式移除的筆記標成「讀者已經看不到」（`taken_down`）。
- `left_out`：不會上線、但業主可能想知道的筆記與原因：標了「發布」卻被擋（`hidden`＝隱藏；`space_not_published`＝所在空間未開發布，附空間種類與名稱），以及發布中的空間裡被排除的
  （`kept_off`＝自己設成不發布；`kept_off_by_parent`＝建立時上層不發布而預設不發布；`blank`＝空白；`saved_article`＝從訂閱存下的文章）。與 `publishedNodeIds` 同一條件，只列操作者讀得到的筆記，不洩漏他人私人空間的標題。
  `POST /api/publish` 的回應也帶同一份，所以「發布成功但網站是空的」一定有說明。對話框據此給動作：搬到可發布的空間（先顯示搬過去誰會多看到，確認後才搬）或開啟該空間的發布設定；不改新筆記預設在「只有我」。
- **`preview_hash` 必填**：`POST /api/publish` 不帶 hash 回 400，不發布；帶了但伺服器重建的候選內容 hash 不同，回 409 `preview_stale`（「內容在預覽後變了，請重新預覽」）。使用者確認的就是實際發布的。
  不新增內容的內部重建（`republishSite`，取消發布後的重新部署）不經過這條路，只用已經發出去的快照重做輸出。介面上的發布路徑都先預覽再帶 hash（`usePublishReview`）。
- **同樣內容一定得到同樣的 hash**：候選內容的每個查詢都有完整排序（`created_at` 相同時以 id 決定，標籤列也排序）。
- **差異與 hash 用同一份「讀者看得到的內容」**（`publishing/siteDiff.ts`）：每則筆記的標題、網址、內文、上層、標籤、它在兄弟筆記間的順序（`moved`），以及它兩端的已發布連結（`links_changed`，Related／反向連結／導覽連結），加上網站設定。
  hash 只算這些，所以預覽說「沒有變動」時發布不會 409，409 時新預覽一定列得出變了什麼。`updated_at`、原始 `sort_order` 數值、`node_type`、`side_effects` 不算；
  快照仍存確認當下的 `updated_at`，網站上的日期、sitemap 的 lastmod 和 feed 的 pubDate 都讀它。設定的差異用 canonical JSON 比對，因為 jsonb 會重排 key。

## 讀者功能：連結預覽、連到這裡的那一句、閱讀時間、分享圖（feat/site-reading）

都在同一份 SSR 頁面裡完成，不打 API，所以 zip 與 GitHub Pages 副本一樣能用。

- **連結預覽**（設計的 `reading.preview`）：文章頁帶一段 `<script type="application/json" id="s-previews">`，
  只放「這一頁連到的、且在網站上的筆記」（內文連結 + 連到這裡的來源，最多 50 篇），以筆記 id 為鍵；
  內文與「連到這裡」的連結帶 `data-note`，`SitePreview.astro` 的小腳本據此取卡片。
  文字（更新日、閱讀時間）在伺服器端就依網站語言組好，腳本沒有自己的字串。
  卡片的「打開這篇」用觸發連結自己的 `href`，副本裡是相對路徑，不必在 JSON 裡改寫。
- **連到這裡的那一句**：`backlinksOf` 回傳 `{ node, places }`；句子由 `@onden/markdown` 的 `linkPlaces`
  從來源筆記的 Markdown 取出（段落或清單項、去語法、連結字標 `<mark>`、約 80 字）。
  `![[…]]` 內嵌在發布時已變成 `[[…]]` 連結，所以伺服器端的 `serveDrawingEmbeds` 把「變成連結的內嵌」本文留在
  節點的 `embeds`，頁面才分得出「內嵌了這篇的一段」與一般連結。
- **閱讀時間**（筆記頁的 `note.meta` 盒子可顯示）：`readingMinutes`，中日韓字 ÷ 400 + 其他字詞 ÷ 200，至少 1，程式碼區塊不算。
- **分享圖**：文章第一張圖（`coverImage`）→ `og:image`（絕對網址）＋ `summary_large_image`；沒有就用網站標誌；
  再沒有就維持小卡片。靜態副本換主機時，`retargetStaticSite` 把 `og:image` 換成新網址的 `media/…`。
  **沒有做「自動產生 1200×630 的圖」**：repo 沒有 CJK 字型檔（只有 Fraunces／Plex），要產生中文標題必須新增
  數 MB 的 Noto Sans TC 與 resvg，並在發布時為每篇產圖、再讓副本爬進去，超出本批範圍。
- **不洩漏**：頁面只由「已在網站上的節點與邊」組成（`servedSite.applyTakedown`）；預覽資料、連到這裡、head 都從同一份節點算，
  沒有另一條取得筆記的路。測試：`siteReading.test.tsx`。

截圖（本機 SSR + 假 API，Chromium 桌面與手機尺寸，非真機）：
（截圖未隨公開庫附上：桌面懸停卡片）、
（截圖未隨公開庫附上：手機底部卡片）、
（截圖未隨公開庫附上：連到這裡的那一句）。

## 手寫筆記自己的那一頁（feat/site-handwriting-page）

已發布的手寫筆記（有 `ink_data`、不是 PDF）在自己的頁面上畫出手寫。做法跟 `![[手寫]]` 嵌入走同一條路，一樣是「發布時凍結、提供時再變成內文」：

- **發布**（`publishing/handwritingPages.ts prepareHandwritingPages`，由 `buildCandidate` 呼叫，只讀已發布集合）：節點上只記 `ink_pages`（每頁一個 `/api/media/ink-<雜湊>.svg`）。**這一步不畫圖**：一萬筆的手寫約 2 秒、17 MB，而 `buildCandidate` 每次預覽、發布、分享選單狀態都會跑。檔名由「畫法版本號（`INK_PAGE_RENDER_VERSION`）＋工作區＋筆記＋`ink_data` 的雜湊＋頁的 key」而來，所以不用畫就知道名字，同一份手寫重複發布也是同一個檔；候選快照只帶每個檔的 `render`（`Candidate.handwritingPages`），圖不進快照。
- **存檔**（`storeHandwritingPages` → `services/media.ts storeGeneratedMedia`）：檔案不存在才畫，畫完原子寫入並記成那篇筆記的媒體。預覽（交易外）、發布路由與核准後的發布（`warmHandwritingPages`，交易外）都會先存好，所以發布交易裡通常只剩寫一列資料。改畫法就要升 `INK_PAGE_RENDER_VERSION`（`handwritingPage.test.ts` 釘住一張固定圖的雜湊，沒升會失敗）。
- **回收**：發布記好新快照後，`forgetReplacedPages` 把這個工作區中新快照沒有用到的 `ink-*.svg`（改過手寫留下的舊檔、預覽產生但沒發布的檔）忘掉，走 `services/media.ts removeMediaFiles`（與永久刪除共用同一個「刪紀錄、提交後刪檔」）；永久刪除筆記時 `purgedContent` 也把這篇擁有的檔案列入，一起收掉。
- **提供**（`serveHandwritingPages`，在下架過濾之後、與預覽）：`ink_pages` 變成內文後面的 `![][ink-page-N]`，其位址 `/api/media/….svg#ink-page-N` 帶穩定記號（`@onden/markdown` 的 `handwritingPageMarkdown`／`handwritingPageNumber`），之後就是一般 Markdown 圖片，網站、RSS、分享連結、zip、靜態主機都不必認識手寫。alt 不寫在伺服器：它依網站語言，由網站的 renderer 產生（`siteLocale` 的 `handwritingPage`）。預覽與發布後一樣用網址讀圖（預覽的圖只有能讀那篇筆記的人打得開），回應不再內嵌每頁約 22 MB 的 base64。
- **下架即時**：圖是媒體檔，能不能讀走 `canReadMedia` → 擁有筆記是否仍在網站上（`snapshot_media`），所以下架後頁面與圖片網址同時消失；靜態主機打包時用同一個檢查（`mediaBundle.ts`）。私人筆記不在已發布集合裡，筆畫不會進快照。
- **畫法**：每頁是整張紙（寬 1000、從 x=0 起，高度到最後一筆再留邊，最多到頁高），底色固定淺色紙（`INK_PAPER_COLOR`）。筆跡顏色是照淺色頁存的（深色模式在畫面上才反相），所以紙一律淺色；紙畫在 SVG 裡，不靠 CSS，RSS 閱讀器、zip 與靜態主機看到的一樣。
- **頁面**：`MarkdownRenderer` 只在收到 `handwritingAlt`（網站的 `makeSiteMarkdown` 才傳）時認得位址上的記號，加上 `md-image--ink-page`（`MarkdownRenderer.css` 讓它滿寬、頁間留距）並給網站語言的 alt；App 的 renderer 與使用者自己寫的圖不受影響。網站上所有圖片本來就是 `loading="lazy"`，所以第二頁起是 lazy。RSS 內文只放第一頁（`withoutHandwritingPages`），alt 同樣依網站語言；文章封面與分享圖不取手寫頁（SVG 不是分享圖，也避免跟內文重複）。搜尋索引只讀標題與文字，圖片沒有文字，不受影響。

## 中文網站、搜尋、資料夾頁（feat/site-zh-search-folders，業主 2026-11-20「功能與體驗能追上 Quartz」）

業主量到的網站（60 則繁中筆記、課程資料夾）是英文介面、搜不到中文內文、約 20 則空頁。原因與處理：

- **語言與簡介的根因在寫入端**：「建立第一個網站」（`modules/website/introSite.ts`）把 Onden 自己的 `INTRO_SITE_CONFIG`（品牌、副標、`locale: "en"`、產品簡介）整包寫進使用者的網站設定，而且蓋掉原有的值。現在只寫名稱、副標、主色，且只在使用者沒設時寫（`introSiteConfig`）；**語言與簡介一律不寫**。沒有語言的網站是 zh-TW（`siteLang`／`makeT` 同一預設）。
  已經被寫成英文的網站不會自動改回，要在設定 › 網站改語言（沒有 migration：無法分辨「選了英文」與「被寫成英文」）。
- **搜尋索引的語言就是頁面的 `<html lang>`**：Pagefind 只在頁面語言是 zh／ja 時用 CJK 斷詞，所以網站語言錯了，內文就搜不到（`siteSearchIndex.test` 釘住 zh-TW 的兩字詞可搜到內文、單字查詢不報錯）。
  搜尋改成頁首的按鈕＋全螢幕面板（`<dialog>`，Ctrl／⌘+K，手機點擊目標 44px），腳本一執行按鈕就顯示；索引還沒建好時面板明說「搜尋還沒準備好」，不再整個藏起來。索引在發布後由 `site_bundle` 背景工作建，失敗會重試並出現在系統狀態。
- **簡介**：網站自己的 `description`，沒有就用首頁筆記的第一段，再沒有就不寫（`siteDescription`）。
- **日期**：`formatSiteDay`（`siteLocale.ts`）依網站語言寫（zh／ja「2026年11月20日」，en 仍是 ISO）。「更新於」的來源改為內容最後一次編輯（`services/history/bodyEvents.ts lastContentEditSql`：寫字或手寫的儲存事件，沒有就用建立時間）；
  快照的 `updated_at` 是這個值，所以網站頁面、sitemap `lastmod`、RSS `pubDate` 一起改。移動、加標籤、匯入或修復造成的 `content_nodes.updated_at` 變動不算。
- **資料夾頁**：沒有正文、底下有筆記的筆記，頁面列出底下的筆記（標題、日期、第一行）；有正文又有底下的筆記時，正文之後接「這篇底下的筆記」。沒有正文也沒有底下的筆記（例如內容只是 PDF）顯示「這一頁沒有文字內容」，不再是空文章。首頁「最新一篇」跳過沒有正文的筆記。
- **分辨同名**：每個筆記頁有路徑列（麵包屑），搜尋結果帶 `path` 欄；清單中標題重複的筆記旁邊顯示所在資料夾（`pathIfAmbiguous`）。沒命名的筆記以正文第一行當標題（`lib/noteLabel.ts firstLine`，同 App），位址不變。首頁「最近 10 篇」其餘的收在「顯示全部 N 篇」（`<details>`，不用腳本）。
- **舊的訂閱筆記**（標了 `_rss_kind = source`，migration 145 之前每個訂閱是一則筆記）與存下的文章同樣預設不上網站（`publishedSet.ts FEED_SOURCE_SQL`），預覽的 `left_out` 以 `saved_article` 說明。
- **封面要自己選**：筆記屬性 `cover: true`（第一張圖）或 `cover: <圖片位址>`；第一張圖不再自動變封面（`coverOf`）。分享圖仍用第一張圖。
- **圖示**：沒設圖示的網站用名稱第一個字加主色的內嵌 SVG（`letterFavicon`），不再讓瀏覽器要 `/favicon.ico` 得到 404。

未做：漏掉 `]]` 的內嵌（`![[Pasted image …jpg`）照原樣當文字顯示；匯入與編輯器沒有標記它的地方，只回報。「(private)」佔位字仍是英文（`redaction.ts` 由另一個 PR 處理，那邊接上網站語言後再接）。
