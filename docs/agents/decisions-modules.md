# 模組分類的決定

> 狀態：現行（最後確認 2026-11-01）
> 涵蓋：packages/backend/src/modules/index.ts, packages/backend/src/modules/types.ts, packages/frontend/src/modules/index.ts, packages/frontend/src/modules/types.ts, packages/backend/src/modules/importers/**, packages/backend/src/modules/capture/**, packages/backend/src/modules/semantic/**, packages/frontend/src/modules/graph/**, packages/frontend/src/modules/capture/**, packages/backend/src/modules/rss/sources.ts, packages/backend/src/modules/website/index.ts

何時讀：新增或搬動模組、決定一個能力該不該有開關、改 `modules/index.ts` 兩邊的註冊表時。

## 業主決定（2026-10-28）：模組分三種

| 種類 | 是什麼 | 程式上 | 例子 |
| --- | --- | --- | --- |
| **功能** | 透過標籤引入，會讓筆記多出資料或行為（可勾選、日期、複習、RSS、網站） | 後端 `ModuleDefinition.library`、前端 `FrontendModule.library`；可開關，列在 設定 › 功能 | 複習、RSS、網站、任務 |
| **內建模組** | 程式上是模組（清楚邊界、懶載入、註冊表），但永遠可用、沒有開關、不出現在 設定 › 功能 | 後端 `ModuleDefinition` **不帶** `library`；前端 `BuiltInModule`（`BUILT_IN_MODULES`） | 匯入、關係圖 |
| **核心** | 存放、同步、歷史、備份還原、空間權限 | 不做成模組 | — |

判斷：能力是否讓筆記多出資料或行為、或使用者合理想關掉它？是→功能。只是一條永遠要有的入口、
邊界清楚但沒有理由關閉→內建模組。其他系統依賴它才能成立→核心，不要放進模組（核心不得依賴模組）。

## 內建模組的規則

- 後端：`modules/<id>/index.ts` 匯出沒有 `library` 的 `ModuleDefinition`，加進 `MODULES`。`mountModules`
  對沒有 `library` 的模組不掛寫入閘（`module_not_imported`），agent 工具與節點 hook 也不被擋——它永遠在。
- 前端：`modules/<id>/index.tsx` 匯出 `BuiltInModule`（`id`、`settings`，純前端的再加 `frontendOnly: true`），加進 `modules/index.ts` 的
  `BUILT_IN_MODULES`。沒有 `library` 卡、沒有「已關閉」狀態，`moduleStatusFor`、設定 › 功能、
  側欄導覽都不認得它；設定列放在它宣告的 `tab`（`BUILT_IN_SETTINGS` 由 `settings/registry.tsx` 展開）。
- 前後端對齊由 `moduleDefinitionsAlign.test.ts` 守住：前端 `MODULES` ＋ `BUILT_IN_MODULES` 的 id 等於後端
  `MODULES`；`BUILT_IN_MODULES` 恰是後端沒有 `library` 的模組。
- 其他程式只經模組的 `index` 進入（eslint `module-entry`、前端 `moduleBoundary.test.ts`）。

## 匯入（importers）屬於內建模組

- 後端 `modules/importers/`：`routes.ts`（`/api/import`，路徑與形狀不變）、`obsidian/`（資料夾匯入編排與資料夾核對）、
  `notion/`、`csv/`、`markdown/`（單筆筆記、任務清單）、`shared/`（來源身分、圖片、圖片連結、關聯對應）。
- 前端 `modules/importers/`：資料夾匯入設定（設定 › 你的資料 › 匯入）、批次上傳規劃、Excalidraw 轉換。
  `reads.modules.importers.sources` 是它的讀取。
- 寫入仍走原本的 `mutate`／`createNote`／`updateNode` 與 spine authority，搬家沒有新增旁路；
  `require-read-gate`、`spineGate`、`attributeWriters`、`bodyWriteGuard` 的檔案清單改成新路徑，沒有放寬。
- 留在 `services/` 的：`importRefusal.ts`（其他模組也用同一條「什麼可以略過並計數」的規則，模組之間不互相 import）；
  `taskListFile.ts`（匯出 `exportZip`／`exportTasks`／`standaloneTasks` 也用，核心不得依賴模組）。
  備份還原與匯出不使用匯入模組的任何檔案。
- `components/ObsidianImport.css` 沒有搬：它其實是 TagsPanel、OverviewPreview、BuilderWorkspace、RSS 共用的樣式表，
  不是匯入元件。

## 關係圖（graph）屬於內建模組（2026-10-28）

- 純前端：圖由前端已有的筆記與關聯畫出，沒有後端程式，所以沒有後端模組；`graphModule` 帶 `frontendOnly: true`，
  前後端對齊測試與 `moduleBoundary.test.ts` 的「同 id 後端模組」只對沒有這個旗標的內建模組要求。
- 前端 `modules/graph/`：`AllCardsGraph`（力導向圖與其樣式）、`LocalGraphLens`（Graph 頁與 `?view=graph&focus=` 的「完整關係」）、
  `graphCap`、`graphRoleForce`，測試放在旁邊。`index.tsx` 匯出 `graphModule` 與懶載入的 `GraphScreen`
  （經 `modules/index.ts` 重新匯出），`SecondaryLensOutlet` 只用 `GraphScreen`；力導向圖仍在獨立 chunk，不進主套件。
- 網址、介面、儲存的設定都沒變，沒有遷移。留在核心的：`noteNeighborhood`（資訊面板「關係」分頁與筆記關聯也用）、
  `edgeKinds`／`edgeRoles`；`useGraphLayout`、`useGraphViewState`、`graphCallbacks` 名稱雖有 graph，其實是白板（canvas）的，沒有搬。

## RSS 訂閱是設定，存在資料表，不是筆記（2026-10-29，migration 145）

- 業主決定：訂閱是「設定」，在閱讀頁管理；筆記樹裡不再有訂閱源筆記。`rss_subscriptions`（工作區、`space_id`、網址、名稱、
  建立者、etag、更新間隔、上次抓取／錯誤、auto_tag、embed、auto_dismiss_days、存到預設、總是載入全文）取代
  `_rss_kind = 'source'` 的筆記與它的 `_rss_*` 屬性。061 當初選筆記是為了跨裝置合併、可從歷史救回、吃空間權限；
  前兩點對設定不重要，第三點保留：表帶 `space_id`，讀取走 `readableSpaceScopeSql`（`services/readPolicy.ts`），
  「訂閱放在哪個空間」（`sourceSpace.ts`）照舊有效。
- 「訂閱來源是誰」只有一個入口：`modules/rss/sources.ts`（`listSources`／`getSource`／`findSource`；表的唯一寫入者）。
  寫入在事件鎖內、用 `resolveCurrentActor` 取當前身分、`space_write` 檢查該空間的 `edit` 權限（`changeSource`
  包了這三步），不產生領域事件（設定沒有可復原的歷史；spineGate 白名單寫明理由）。
- 訂閱的 id 沿用原本那篇筆記的 id：存下來的文章上的 `_rss_source`、`rss_staging`、`rss_seen` 都不用改寫，
  「同一篇文章只存一次」（`rss_staging.saved_node_id`）照舊成立。`rss_staging.source_node_id` 改名 `subscription_id`，
  外鍵改指向新表。outbox 的 `rss_fetch` payload 改用 `subscriptionId`。
- 原訂閱源筆記：底下有子筆記、寫過內文、有標籤／連結／指標／白板卡片的，留成一般筆記（拿掉 `_rss_*`、`source_type`
  改 `manual`，子筆記不動）；其餘軟刪除（`NODE_DELETED` 事件，系統身分 `migration:145`，可從歷史救回）。
  舊的「用訂閱筆記自己的標籤＋ auto_tag、存在訂閱底下」預設，轉成明確的存到預設，存放位置不變。
- 取消訂閱＝刪除那一列（連同它的串流暫存）；已存的文章是筆記，不動。再訂閱同一個網址是新的訂閱、新的串流。
- 前端：閱讀（RSS）「在用」＝至少有一個看得到的訂閱；數量來自閱讀頁既有的訂閱清單輪詢（`useRssSourceCount`），
  經 `modules/index.ts` 的 `useSubscriptionCount` 進 `ModuleUseData.subscriptions`。
- 已知限制：訂閱不在筆記備份／匯出（zip）裡，備份請用 OPML 匯出；新資料表不進 `/api/sync`，前端靠 `GET /api/rss/sources`。

## 捕捉（capture）屬於內建模組（2026-10-29）

業主：「快速捕捉不夠快速，要想該放哪」、「日記是模組，不一定會用到」、「快速捕捉是個功能，沒有預設的時候筆記附著在上面」、「先當內建」。
研究（Drafts、Todoist、Keep、Amplenote、NotePlan、OneNote）的共通點：先寫字，位置在設定裡選一次；目的地用一行小字顯示；不偷偷記住上次的位置；不硬依賴日記。

- **內建模組，有後端孿生**：前端 `modules/capture/`（`captureModule`，在 `BUILT_IN_MODULES`）、後端 `modules/capture/`（沒有 `library`）。
  永遠開著，不列在 設定 › 功能。`BuiltInModule` 因此多了 `screen`（`?view=capture`，在「更多」裡）與 `NavIndicator`
  （待整理數量）；`moduleEntry`、`MODULE_SCREENS`、`importedFeatures`、`moduleFilterFor` 都認得內建模組的頁面（內建模組不會是「未匯入」）。
- **模組標籤＝收件匣**：`tag_schema.module = 'capture'`，第一次需要時由 `POST /api/capture/inbox` 建立（後端 `ensureInboxTag`，
  照任務模組的 `ensureTaskTag`：任何能寫入的成員都可以；根層已有「收件匣」時依序改用「捕捉」「收件匣 (capture)」）。
  沒有 `library`，所以**不走** `workspaceModules.ensureModuleTag`（那是擁有者開啟功能模組用的）——這是最小且與任務模組一致的做法。
  第一次建立需要連線；離線且標籤還不存在時，文字保留並告知，不假成功。
- **收件匣標籤不能手動加**（2026-11-07，業主回報）：帶這個標籤的筆記會離開筆記樹，手動加上去筆記就不見了。`BuiltInModule.appliesOwnTag` → `isAppliedByAppTag`：所有標籤選單都不列，打完整名稱也不列；標籤本身照常顯示，也能從筆記移除。
- **沒有位置的捕捉**＝最上層的一般筆記＋收件匣標籤＋保留屬性 `_captured`＝true（建立筆記的同一個請求帶 `tag_ids`、`attributes`，不會做成一半）。
  `_captured` 在整理（移到筆記底下、拿掉標籤）之後**留著**，這是「某天記下的捕捉」能找到已整理的捕捉的唯一依據
  （`capturesOnDay`，依 `created_at`，先有函式與測試，尚未接畫面）。未整理的捕捉不出現在筆記樹（`lib/sidebarTidy` 用 `isPendingCapture`），
  只在收件匣頁；整理後就是一般筆記。
- **預設收件處只有一個設定**（`captureDestination`，跟帳號走，`createAccountPref`）：`inbox`（預設）｜`today`（日記模組開著才出現）｜某篇筆記的 id。
  日記被關掉、筆記不見或不能寫入時，**用的時候**退回收件匣，不改設定。已移除兩種隱性預設（上次選的位置、正開著的筆記）；
  `lib/newNoteTarget` 只剩側欄 ＋（CreateSheet）使用，不再與捕捉共用。「放進：…」那一行可點、用 `PlacePicker` 改**這一則**，送出後忘記。
- **文字裡的分類不擋送出**：`#標籤` 只套用**已存在**的標籤（不建立，T10 的「`#word` 不建標籤」仍成立，只是現在會套用已有的）；
  `[[筆記名`（到 `]]` 或行尾）用 `reads.notes.search` 找到後放到那篇底下；一行含日期詞（`parseTaskInput`）且任務模組開著，建立獨立任務
  （`quickTaskFromReading`／`createQuickTask`，與任務的快速新增同一個對應）。找不到、解析失敗就照樣存成文字。
- **不另寫第二套**：位置選擇＝`PlacePicker`（新增 `topLabel`，頂列叫「收件匣」）；移動＝`MoveToDialog`＋`nodeActions.assignToGroup`；
  加標籤＝`TitleTagRow`；手寫／檔案／書籤＝`useNodeCreation.create` 的既有種類（照片與檔案同一個 `upload`）；「更多…」＝`CreateSheet`。
  建立之後在收件匣的捕捉再補上標籤與 `_captured`。
- **改名**：筆記頁上方原本叫「收件匣」的分頁其實是 AI 修改的待審清單，改叫「待審」（英文 Review queue），相關句子同步；「收件匣」只屬於捕捉。
- **不搬舊資料**：以前記在日記底下的捕捉維持原樣，沒有 migration。

## 網站開關要擋到伺服器，但不能讓公開的網站下線（2026-11-14）

- 以前網站模組沒有 `routePrefixes`，所以「網站」關閉（或從沒同意過）時，`POST /api/publish`、`/api/publish/include`、`/api/publish/preview`、`/api/preview` 照樣能用。現在 `routePrefixes: ["/api/publish", "/api/preview"]`，這幾條寫入在模組關閉時回 409 `module_not_imported`，與其他模組一樣。
- **不擋的**：所有讀取——`GET /api/site*`、`/api/snapshots`、`/api/export-static`、`/api/git/diff/:hash`——因為「關掉模組只是收起功能，資料保留」，而且已經公開的網站不能因為這次部署就停止提供。公開網站的服務與靜態副本照舊。
- **撤下一律可用**：把筆記標為「不發布」、移到垃圾桶、改空間發布開關，都走核心的筆記／屬性寫入，不經網站路由；它們觸發的 `site_rebuild` 重推原本被 `hooksWhenImported` 擋掉（模組關閉就不排）。網站模組現在宣告 `nodeHooksWhenOff: true`：它的 hook 只會「請求以最新快照減去撤下項目重推」（`republishSite` 不新增任何東西，也不會發布從沒發布過的網站），以及清掉被永久刪除筆記的快照內容，所以關閉時照跑。這個旗標只給「只會移除」的 hook；會新增或對外送出內容的 hook 不得使用。
- 沒有新的路由可以「取消發布整個網站」；撤下是逐篇的，這次沒有新增。

## 語意搜尋要真的對人有用（2026-11-14）

- 開啟模組時，`library.whenTurnedOn`（在 `setModuleImported` 的交易內）排一個 `embed_backfill` outbox 意圖，把已有的筆記補上嵌入：一次 20 則，做完再排下一批（同一個 dedup key，outbox 以 xmin 保證自己排的下一批不會被當成已完成）；待做的筆記由 `node_embeddings` 推導，所以重啟、失敗重試都從停下的地方繼續。伺服器每次啟動時（`startBackground`，測試不跑）也會替「模組開著、還有沒準備好的筆記」的工作區排一次（`resumeIndexing`）——涵蓋這次改動前就已開啟的工作區，以及重試用完而停下的情況；同一個 dedup key，不會重複。沒有新增手動按鈕或寫入路由。全部嵌入後才用「擁有者看得到的筆記」重算每則筆記的相關建議（`suggested_link` 邊）。模組關閉後下一批一開始就結束，不再嵌入。
- 單篇筆記嵌入後（`embed` effect）同樣在伺服器端重算它的建議，所以不需要前端呼叫 `POST /api/nodes/:id/suggested-links`；選擇事件後在伺服器做，是因為嵌入完成才是建議有意義的時間點，而且白板端（`useGraphLayout`）本來就會畫 `status = 'suggested'` 的邊。
- 建議是以工作區擁有者的讀取範圍算的：只建議擁有者讀得到的筆記，擁有者讀不到的筆記不產生建議。邊本身是共用資料，但同步（`sync/bootstrap.ts`）只送出兩端都讀得到的邊，所以別人看不到自己讀不到的筆記。已知限制：多人工作區裡，只有成員自己讀得到的私人筆記沒有建議。
- 一般搜尋（`reads.notes.search`，`lib/data/noteSearch.ts`）在線上、模組開著、查詢有純文字且沒有 `#標籤`／`key:value` 時，於精確結果（與錯字容忍）之後多一層「意思相近」的筆記，最多 5 則，來自 `GET /api/semantic/search`（`semanticSearchNodes`，讀取範圍下推到查詢）。離線沒有這一層。距離門檻 `MEANING_MAX_DISTANCE` 沒有用真實模型校準（模型只在 Docker 映像裡），部署後要看實際結果調整。
- 嵌入的文字是標題＋內文，筆記有 PDF 頁面文字（屬性 `pdf_text`）時接在後面（`indexing.ts` 的 `withPdfText`）；`pdf_text` 改了，`nodeHooks.attributeCommitted` 會替那則筆記重排一次 `embed`。
  已知限制：補嵌入（`embed_backfill`）只挑有標題或內文的筆記（`embeddable`），只有 `pdf_text`、沒有標題與內文的筆記要靠上面那個 hook 才會被嵌入。
- 設定 › 功能 › 語意搜尋顯示「N 則筆記裡有 M 則準備好了」（`GET /api/semantic/status`，只算這位讀者讀得到的筆記），準備中會自動更新。

## 移除標籤自動化（2026-11-15，業主決定）

- **決定**：標籤自動化整個移除。「功能」取代了它；AI 技能是手動按鈕，不由事件觸發。自動化指存在
  `tag_schema.behaviour` 的 `on_apply`／`on_remove`／`on_attribute_change`（原由 `tagDispatcher` 與 `services/dispatcher/*` 執行；
  處理器種類 `set_hidden`／`set_attribute`／`delete_attribute`／`notify`／`when`／`sequence`／`builtin`）。
- **後端**：`tagDispatcher.ts`、`dispatcher/*`、`GET /api/handlers/manifest`、模組的 `dispatcherHandlers`、`invalid_behaviour` 400 都已刪。
  套用／移除標籤的事件由 `tagMembershipWrites` 的 `recordTagEvent` 記錄；屬性寫入、內文屬性同步、欄位預設值不再「通知」任何規則。
  既有的 `dispatcher_pending`／`dispatcherQueue`（內文屬性的提交後派生與重啟補跑）不是自動化，保留；`source = 'dispatcher'` 的屬性來源保留（舊資料與 agent 寫入仍用）。
- **寫入**：`tagWrites.withoutAutomation` 讓每個寫入入口（標籤 PATCH、標籤包匯入、AI 提案、備份還原、事件復原）忽略這三個鍵；
  `keepStoredAutomation` 讓已存的舊規則不被任何寫入改動或清掉。備份還原在報告 `skipped.tag_automation` 計數。
- **舊資料不動**：這批沒有 migration；舊鍵留在 `tag_schema` 裡不動作。之後是否清除由業主決定。
- **前端**：標籤頁沒有「還在執行自動化」與「移除自動化」；標籤刪除預覽、標籤包審核卡片、移除標籤確認不再提自動化。
