# 深入審查：發布成網站（2026-11-11）

> 狀態：歷史紀錄（全部處理完；修正見 #1498，最後確認 2026-11-12）

範圍是「發布成網站」，只看程式、只查不修；審查對象是 `origin/main`（commit 見 PR），另用獨立一節讀 `feat/publish-by-space`（PR #1455）的 diff。
方法依任務說明：先讀程式列候選，再逐一寫測試重現；重現到的用 `it.fails` 釘住（測試名稱寫正確行為，註解寫修法方向），沒重現的標「未重現」。沒有改任何產品程式（沒有符合「安全性問題且修法只是補上既有檢查」的項目：修法都要動凍結資料的重新處理，不只是補一行檢查）。

## 一張表

| 編號 | 一句話說明 | 嚴重度 | 狀態 | 測試 |
| --- | --- | --- | --- | --- |
| P1 | 表格區塊（`onden-base`）的儲存格照抄屬性值：值裡寫了 `[[某筆記]]`，那筆**從沒發布**的筆記標題就出現在公開的 `/api/site` | 高 | 已修（PR #1494） | `publishFrozenLeaks.integration.test.ts`（「never names a note that was NOT published」） |
| P2 | 同一個儲存格：筆記取消發布後，別頁凍結的儲存格仍寫著它的標題，要等下次發布才消失 | 中 | 已修（PR #1494） | 同上（「does not keep the title of a note taken down since」） |
| P3 | 首頁／標籤頁列出的每一列都凍結了「摘要」；摘要裡連到的筆記取消發布、丟垃圾桶後，標題仍留在摘要（「永久刪除」只按 id 清、很可能清不掉：讀程式推論，未實測） | 中 | 已修（PR #1494） | 同上（「excerpt a tag page / home listing froze」）、`publishAnonymousView.property.integration.test.ts`（有標籤頁的那條） |
| P4 | 查詢區塊列出「帶標籤的段落」時，列的標題直接取段落原文：原文有 `[[未發布筆記]]` 就洩漏標題 | 中 | 已修（PR #1494） | 同上（「tagged block」） |
| P5 | 網址撞名處理只加一次 `-<id 前六碼>`，不再檢查新網址有沒有撞到別的筆記：三則筆記可以落在同一個網址 | 低 | 已修（PR #1494） | 同上（「never end up at one address」） |
| P6 | 已發布頁面的圖片 `![](data:text/html,…)` 沒被丟掉（`<img>` 不會執行，不是 XSS；但與「絕不允許 data:text/html」的文件規則不一致） | 低 | 已修（PR #1494） | `markdown/src/publishedRenderHostile.test.ts` |
| P7 | 取消發布／垃圾桶／搬走／上層取消：頁面、邊、媒體網址、網址、預覽集合在**下一次讀取**就不見（隨機操作序列 150 次、多個種子都找不到違規） | — | 查過沒問題（安全網） | `publishAnonymousView.property.integration.test.ts` |
| P8 | 渲染安全：50 多種 XSS 向量過已發布版本的真實管線，沒有可執行內容 | — | 查過沒問題（安全網） | `publishedRenderHostile.test.ts` |
| P9 | 首頁設計資料收到惡意值（CSS 逃出 `<style>`、`@import`、原型污染、極深巢狀、百萬筆清單） | — | 查過沒問題（安全網） | `site/src/designHostile.test.ts` |
| B1 | （PR #1455）空間一打開，裡面**所有**筆記（含其他成員寫的、AI 寫的）下次發布全上網站；排除旗標在匯出入／備份複本會掉 | 高（上線風險） | 讀程式推論，未實測 | — |
| B2 | （PR #1455）沒指定首頁時，首頁挑選的 SQL 是平方成本：6,000 則筆記 8.5 秒（PGlite；每次匿名讀 `/api/site` 都會跑） | 中 | 已量測（把該 SQL 原文複製出來跑，沒有跑分支程式） | 量測紀錄見下 |
| B3 | （PR #1455）migration 186 讓「已有一則發布筆記」的空間整間公開；任何空間內編輯都會排站點重推 | 中 | 讀程式推論，未實測 | — |

「嚴重度」依任務說明：高＝資料外洩／越權／常用路徑壞；中＝特定條件下結果錯；低＝瑕疵、不一致。P1 評為高是因為洩漏的是**從沒公開過**的筆記標題；P4 同類但條件更窄（要有帶標籤的段落且段落原文含連結），所以評中。

測試怎麼放：`it.fails` 的測試現在是綠的；修好對應問題後它們會變紅，那時把 `it.fails` 改成 `it`。

---

## P1　表格區塊的儲存格洩漏未發布筆記的標題（高，已重現）

**對使用者的意思**　一則公開筆記裡放了一個表格（`onden-base`，例如「專案列表」），欄位是某個屬性，例如「相關」。如果某列的屬性值寫著 `看 [[薪資談判筆記]]`，而「薪資談判筆記」是私人的、從來沒發布過，這段原文會原封不動進到公開網站的資料裡，任何人打開 `/api/site` 就看得到標題。同一則筆記的內文則會被正確改成「(private)」，只有表格儲存格漏掉。

**觸發步驟**　1. 私人筆記 S（標題含關鍵字）。2. 已發布筆記 A 有文字屬性 `related = "see [[S 的標題]]"`，帶標籤 T。3. 已發布筆記 H 內文放 ` ```onden-base ` 區塊，篩選標籤 T、`views: table`、`order: [file.name, related]`。4. 發布。5. 讀 `/api/site`，H 的 `query_blocks[0].rows[].values` 內有 `see [[S 的標題]]`。

**程式位置**　`packages/backend/src/modules/website/publishing/queryBlocks.ts` 的 `frozenBase`（約 190–205 行）：`values: columns.map((key) => String(n.frontmatter?.[key] ?? ""))` 沒有經過 `inertUnpublishedWikilinks`。對照：首頁／標籤頁的列欄位值有做（`frozenDesign.ts` 的 `asRow`），所以這是「兩條凍結路徑只有一條有遮蔽」。伺服端取下（`keepServedQueryRows`）只按 id 濾列，也不重新遮蔽。

**建議修法**　凍結時把每個儲存格過 `inertUnpublishedWikilinks(value, publishedNames)`；取下時（`keepServedQueryRows`）對仍在網站上的列再過一次，對象是「現在還在網站上的頁面」。工作量：小（半天含測試）。

## P2　儲存格的取下延遲（中，已重現）

同一處。對「**曾經公開、後來取消**」的筆記：頁面本身在 `applyTakedown` 會重新遮蔽內文（有對照組測試證明），但凍結的儲存格不會，所以 `[[Beta]]` 的標題留到下次發布。使用者以為「取消發布＝立刻不見」，在這裡不成立。修法與 P1 同一個（取下時重新遮蔽）。

## P3　凍結的「摘要」留著已取下筆記的標題；永久刪除也清不掉（中，已重現）

**對使用者的意思**　首頁與標籤頁的每一列有一句摘要（取內文第一段）。第一段若寫「這跟 [[B 筆記]] 密切相關」，摘要會是「這跟 B 筆記 密切相關」。B 取消發布（或丟垃圾桶）後，頁面內文會變成「(private)」，但標籤頁／首頁那一列的摘要仍寫著「B 筆記」，直到下次發布。使用者按「永久刪除」B 時，系統清 snapshot 的方式是「刪掉所有提到 B 的 id 的列」（`purgedContent.ts` `withoutNodes`），摘要是純文字、沒有 id，所以依程式推論 B 的標題會留在已儲存的快照裡——**這一段我沒有寫測試實跑，只有「取下」那一段已重現**。

**觸發步驟**　B、A 都已發布；A 帶一個顯示中的標籤、第一段含 `[[B]]`；發布；取消 B 的發布；讀 `/api/site`：`presentation.design.tag_pages.<tag>.rows[].excerpt` 仍含 B 的標題。

**程式位置**　`siteRows.ts` `siteRowOf`（凍結時產生 `excerpt`）與 `takeDownDesign`（只按 id 濾列、不動內容）；`servedSite.ts` `applyTakedown` 呼叫它。`resolved`（首頁元件）與 `tag_pages` 共用這條路徑。

**建議修法**　兩個方向擇一：(a) 不凍結摘要，列只存 id，摘要由前端用已重新遮蔽的內文算；(b) `takeDownDesign` 收到服務中的頁面後，用該頁面的 markdown 重算 `excerpt`。(a) 同時解掉永久刪除（快照裡沒有散文可殘留）。工作量：中（(b) 約 1 天；(a) 要動前端 `siteFrame`，約 2 天）。

**修後補記**　取下時摘要與 `fields` 已用該頁重新遮蔽的內文重算；永久刪除實測確認快照會留下標題，已改成刪除後把儲存的快照也重新遮蔽（`purgedContent.ts`），測試見 `publishFrozenLeaks.integration.test.ts`。

**沒有再單獨測的**　列的 `fields`（檢視欄位值）在凍結時已遮蔽，但取下時同樣不重算——與 P3 同一原因，我沒另外寫測試，標「未重現」：要先有一個含 `node_ref`／文字欄位的標籤檢視，我只讀了程式沒跑。

## P4　查詢區塊的「段落列」直接用段落原文當標題（中，已重現）

`onden-query` 以標籤查詢時，會把「帶該標籤的段落」也列成列（`nodeQuery.ts` 的 `blockQuerySql`），列的標題是段落的 `label`。`queryBlocks.ts` `frozenQuery` 直接取 `row.block.label`，沒有遮蔽。段落原文含 `[[未發布筆記]]` 時，標題就洩漏在公開 JSON 的 `query_blocks[].rows[].title`。測試用直接寫入 `block_nodes` 的方式重現（沒走編輯器產生標籤段落）；真實使用需要「標籤段落的文字裡有連結」，所以評中。修法同 P1（對 label 過 `inertUnpublishedWikilinks`；取下時重新遮蔽）。工作量：小。

## P5　網址撞名的「後綴」不檢查自己有沒有再撞（低，已重現）

`publishedSet.ts` `uniquePublishedSlugs`：同一網址有多則時，保留一則（預設空間優先），其餘改成 `<slug>-<id 前六碼>`，但之後不再檢查新網址是否已被別則使用。A、B 同網址 `x`，C 的網址剛好是 `x-<B 的前六碼>`，B 與 C 就同網址，網站只會顯示其中一則。真的要發生需要有人把筆記取成特定名字、而且知道另一則的 id 前六碼，實際風險低；用直接呼叫函式重現。**建議修法**：沿用 `services/nodes.ts` 的 `uniqueSlug` 邏輯（對整個集合檢查、撞了就加長）。工作量：小。

**沒有問題的部分（同一題目的其他情境）**：兩則筆記搶同一個網址時，預設空間那則保留（有測試）；改名後舊網址會轉址、取下的筆記舊網址不再轉址、不會轉到帶標題的新網址（`siteRedirects.ts`，既有測試 `siteRedirects.*` 涵蓋；我讀過程式、屬性測試的「網址唯一」也通過）。

## P6　`![](data:text/html,…)` 不被丟掉（低，已重現）

`@onden/markdown` 的清理設定允許 `src` 用 `data:`（為了內嵌圖片與音訊），只在 React 渲染的 `urlTransform` 另外限制成 `data:image|audio|video`。匯出 HTML、靜態站、RSS 用的是純管線，輸出 `<img src="data:text/html,…">`。`<img>` 不會執行內容、瀏覽器也擋最上層 `data:` 導覽，所以**不是可執行的 XSS**；只是 `urlSchemes.ts` 寫「never data:text/html」的規則在這條管線不成立。建議修法：在 published 管線補一個 rehype 步驟丟掉非 image/audio/video 的 data 型別。工作量：小。

---

## 查過沒問題的（有測試當安全網）

- **取消之後是不是真的不見**（隨機操作序列：初版 150 次一個種子；最終版預設 12 次、三個不同種子各跑一次；每次 3–14 步，先從「3 則已發布且互相連結」的站開始）：
  `publishAnonymousView.property.integration.test.ts` 在每一步操作後（發布／取消發布／丟垃圾桶／還原／搬空間／改名／改內文／換上層／開關空間發布）檢查：公開頁面 ⊆ `publishedNodeIds`；邊與上層不指向集合外；集合外筆記的標題／內文／id 不出現在匿名可見資料；匿名讀者的媒體閘（`canReadMedia(null)`）只對「現在在網站上的筆記」所擁有的圖片放行；`publishedUrlFor` 只對公開筆記回網址；`buildCandidate` 的集合與 `publishedNodeIds` 完全相同（預覽與發布是同一個算法）；網址唯一。找不到違規（無標籤頁的那組是綠的）；有標籤頁的那組找到 P3，所以用 `it.fails` 釘住。
- **預覽與實際發布是同一套算法**：`buildPublishPreview` 與 `buildAndEnqueueSnapshot` 都呼叫 `buildCandidate`，屬性測試也斷言集合相同。
- **搜尋索引、sitemap、RSS**：搜尋索引檔是「目前上線站點的雜湊」為鍵的靜態副本（`siteBundle.ts`），取下後鍵改變、舊副本不再被提供（路由回 404 並在背景重建）；sitemap／RSS／`static-pages.json` 都讀同一個 `/api/site`（已扣除取下）。我讀過程式，沒有為搜尋索引另寫測試（需要前端渲染器與 Pagefind，這次沒有跑）。
- **媒體**：未發布筆記的圖片匿名讀不到、取消發布後已發布筆記的圖片也讀不到（屬性測試涵蓋）；`/api/media` 對匿名回應快取 5 分鐘（`PUBLIC_MEDIA_CACHE`，程式註解與設計寫明）——瀏覽器／CDN 最多晚 5 分鐘才失效，這是已知取捨，不算問題。
- **別名**：別名屬性不會進公開資料；用別名連結會被改寫成網址（有控制測試）。
- **標籤隱藏、查詢列取下、內文連結取下**：有控制測試（取下後立即不見）。
- **摘錄內嵌**（`![[筆記#^段]]` 把私人日記的一段放進公開頁）：這是 2026-10-29 業主明確決定（`excerptEmbeds.ts`），不算問題；只擷取該段、不帶來源標題與 id。取下**來源是已發布筆記**的情況不在這個決定內，但摘錄只對「摘錄」型筆記展開，我沒發現能觸發。
- **渲染安全**（P8）：`publishedRenderHostile.test.ts` 把 50 多種向量（`javascript:`／`vbscript:`／實體編碼、`<iframe srcdoc>`、`<base>`、`<meta refresh>`、KaTeX `\href`／`\htmlClass`／`\htmlId`、表格與 callout 裡的 HTML…）送過真正的 published 管線，逐元素檢查沒有事件屬性、沒有 `srcdoc`、`href` 一律是安全協定、`src` 只有 http(s)／相對／`data:image|audio|video`、元素在白名單內、ID 一律加 `user-content-` 前綴。只有 P6 一項不符。
- **首頁設計資料**（P9）：`site/src/designHostile.test.ts`：惡意 accent／preset／scheme 回到預設；10 種 CSS 逃逸（`</style>`、`@im\70ort`、`@@import;import` …）經 `scopedCss` 後沒有 `<`、沒有 `@import`，且再清理一次內容不變；`__proto__`／`constructor` 不污染；5,000 層巢狀與 100 萬筆清單不丟例外、在 5 秒內、元件數不超過上限；400 組隨機垃圾輸入從不丟例外且結果再驗證不變。
- **只有網站擁有者能動後台**（發布、預覽、快照、匯出）：`siteAdmin` 以目前角色重驗（既有測試涵蓋），我沒有改動。

## 這次沒查到的範圍

- 搜尋索引的實際內容（Pagefind 對渲染後頁面建索引）沒有跑；只確認了取下後舊副本不再被提供。
- GitHub Pages 推送：程式註解寫「分支變成恰好是這批檔案、無父提交」，取下後舊檔不會留在分支（讀過 `mirrorToBranch`）；推送失敗被 outbox 放棄時，外部站會停在舊內容，沒有測。外部 Git 歷史、fork 不在 Onden 控制內。
- 前端「發布預覽」對話框與工作室畫面（`packages/frontend/src/modules/website/`）沒審；只讀了後端資料流。
- 離線、多裝置同步與「發布」交會的情境（本機副本改 `_published` 後重連）沒查。
- 真 Postgres：所有整合測試在 PGlite 上跑；沒有需要第二條連線的測試，所以沒有「需在真 Postgres 補跑」的項目。B2 的耗時是 PGlite 數字，真 Postgres 會快但複雜度仍是平方。
- `handwritingPages`、`diagrams`、`drawingEmbeds` 的取下：讀過程式（取下時依服務中的節點過濾），沒有另寫新測試，既有測試 `publishHandwritingPages`／`publishDrawingEmbeds`／`publishDiagrams` 涵蓋。

---

## 獨立一節：分支 `feat/publish-by-space`（PR #1455）會改變或新增的風險

這一節只讀 `git diff origin/main...origin/feat/publish-by-space`（62 個檔案），**沒有在那個分支上跑測試或提交**，除 B2 的 SQL 量測是把該分支的 SQL 原文複製到主線測試資料庫跑的。

這個分支把「發布」的意義從「每則筆記自己勾選」改成「空間打開發布開關，裡面的筆記全上網站，單則可標不發布」。對「什麼會變成公開」這個核心問題，這是把預設從**關**改成**開**；以下是我讀出來的風險。

**B1　預設變開之後，沒被排除的東西都會公開（高，讀程式推論）**
- `publishedSet.ts` 的新規則：空間公開 ∧ 非隱藏 ∧ 非垃圾桶 ∧（`_published = 'true'` 或「沒被排除」）。排除只有三種：自己的 `_published = 'false'`、完全空白、`source_type = 'rss'`。`source_type = 'ai'`（AI 寫的筆記）、其他成員在共享空間寫的筆記、範本建立的筆記、匯入的筆記都不在排除裡，下次發布就上網站。預覽會列出，但最常見的路徑「核准的 AI 代理發布請求」（`buildAndEnqueueSnapshot` 沒帶 `expectedHash`）不經預覽，等於核准「發布」就是核准「發布整個空間」。
- 「不發布」是一個存在筆記上的**排除旗標**，而不是白名單，所以**任何會掉屬性的路徑都會把筆記變公開**：(1) 匯出成 Markdown／Obsidian 資料夾再匯入（`exportZip.ts` 一律略過底線開頭屬性），(2) 備份還原成「備份複本」（`backupSystemAttrs.ts` 註解寫明「never a 備份 copy」不寫回 `_published`；而該檔案的註解仍說「`_published` 只是 opt-in、沒有公開之虞」，在新規則下已不成立，這個分支沒有改它），(3) 從範本建立。以上我只讀了程式，**沒有寫測試重現**，因為這是 PR 還沒合併的行為；合併前應各寫一個「排除旗標在這條路徑存活」的測試。
- 建議：把「不發布」做成會跟著筆記走的內容而不是屬性，或至少讓匯出／備份複本／範本建立保留 `_published = 'false'`；核准的代理發布請求也要出預覽並要確認。

**B2　首頁預設挑選的 SQL 是平方成本（中，已量測）**
`siteHome.ts` 新的 fallback：`ORDER BY (SELECT count(*) FROM content_nodes m WHERE m.id = ANY($2::uuid[]) AND m.space_id IS NOT DISTINCT FROM n.space_id) DESC …`，對每一個候選筆記再掃一遍全部已發布 id。在「沒有指定首頁」（新手最常見）的站上，`loadServedSite` 每次（匿名、每個頁面請求都會呼叫 `/api/site`）都會走這一條。我把該 SQL 原文在 PGlite 上量：500 則 110 ms、2,000 則 845 ms、6,000 則 8,564 ms（空間打開發布後，一個空間上千則筆記並不罕見）。主線的舊寫法是一次掃描。建議修法：用 `GROUP BY space_id` 先算每個空間的數量，再 join；或把挑選結果寫進快照（快照本來就有 `home_node_id`）。工作量：小。

**B3　migration 186 與重推（中，讀程式推論）**
- 186 只關掉「沒有任何已標示發布的筆記」的空間；只要空間裡有一則 `_published = 'true'` 的筆記，開關保持打開，下次發布整個空間的筆記都出去。使用者升級後第一次按「發布」就會看到一大串「新增」清單——預覽有列，但沒有任何升級時的提示（只有 `changes/` 一則說明）。
- `modules/website/index.ts` 的 `touchesSite` 現在對「空間公開的任何筆記」都為真，任何一次編輯都會排 `site_rebuild`（每個工作區去重）→ 外部站（GitHub Pages）重推。編輯頻繁的使用者會造成不必要的推送。
- 另有一個小的對外行為：`leftOutNotes` 回報的 `reason` 新增三種（`kept_off`／`blank`／`saved_article`），契約型別已一併改（`packages/contract/src/publish.ts`），舊前端若不認得新值要有預設文案——我沒查前端。

---

## 新增的測試檔

| 檔案 | 內容 |
| --- | --- |
| `packages/backend/src/test/properties/publishAnonymousView.property.integration.test.ts` | 隨機操作序列的性質測試（匿名可見內容只來自現在公開的筆記）；一組綠、一組（有標籤頁）`it.fails` 釘 P3 |
| `packages/backend/src/test/publishFrozenLeaks.integration.test.ts` | 凍結資料與取下：P1／P2／P3／P4／P5 的 `it.fails` 與 4 個控制測試 |
| `packages/markdown/src/publishedRenderHostile.test.ts` | 已發布管線對 50 多種惡意輸入的輸出檢查；P6 `it.fails` |
| `packages/site/src/designHostile.test.ts` | 首頁設計資料的惡意值與隨機垃圾輸入 |
