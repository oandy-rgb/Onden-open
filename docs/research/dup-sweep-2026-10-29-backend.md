# 後端功能重複清單（2026-10-29）

> 狀態：現行（進行中的盤點／計畫，完成後移到 docs/archive/）（最後確認 2026-11-01）

範圍：`packages/backend/src`（不含測試與 migrations）。`jscpd` 只抓逐字複製；這份清單找的是「同一件事寫了兩套以上」，名稱與寫法不同也算。
前端與跨套件（前後端、markdown、site）由另外兩個任務掃，不在此列。

方法：先用 grep 找同名／同形的函式、同樣的 SQL 片段與重複的輸入驗證；再依 routes、services／spine、modules 三塊分別讀程式確認。
每組記錄：做的是什麼事、位置、該歸誰、行為差異、風險。位置以 2026-10-29 的 `origin/main` 為準，行號會漂移。

結論：共掃到 **27 組**。本 PR 收斂 **8 組**（標「已收斂」），其餘 19 組列在下面，分成 6 批可派工。
權限與交易相關的（B7 空間可讀集合、B11 attribute upsert）只列不改。

驗證環境說明：本機沒有 PGroonga，整合測試的資料庫是 PG16 + AGE + pgvector、無 PGroonga 索引；全文搜尋相關測試的結果見 PR 說明。

---

## 一、已收斂（本 PR）

| # | 做的事 | 原本的位置 | 現在歸誰 | 行為差異 |
| --- | --- | --- | --- | --- |
| A1 | SHA-256 十六進位摘要 | `agentTokens.hash`、`actorInvites.hashInviteToken`、`blobs.putBlob`、`media`、`embeddings`、`backupRestore.contentFingerprint`、`importers/shared/identity`、`sync/membership`、`rss/fetch`、`website/publishing/{siteBundle,servedSite,siteDiff}` 共 12 處各自 `createHash("sha256")…digest("hex")` | `utils.ts` `sha256Hex` | 無（輸出逐位元相同）。base64 的 CSP 摘要是另一種格式，留在原處 |
| A2 | 每個工作區的「事件附加鎖」`pg_advisory_xact_lock(hashtext('event-append:<ws>'))` | `db.ts` 與 `spine/eventTransaction.ts` 各寫一份（現為 db.ts、eventTransaction 共用 `spine/eventLock.ts`），註解寫「keep the key identical」 | `spine/eventLock.ts` `lockEventAppend` | 無。鎖鍵只剩一個定義，不可能一邊改了另一邊沒改而讓事件 id 順序失效 |
| A3 | 新的區塊 id（`randomBytes(4)…slice(0,6)`） | `blockNodes.newBlockId`、`agentSessions` 私有一份、`modules/tasks/placement.newRef` 又一份 | `services/blockNodes.ts` `newBlockId` | 無 |
| A4 | 已存檢視的排序（釘選再名稱） | `noteViews.ts`、`tagViews.ts` 各一份 `byPinThenName` 與 `StoredView` | `tagViews.ts`（noteViews 本來就已 import 它） | 無 |
| A5 | 「哪些事件算一次儲存」`event_type IN (…) AND payload ? 'body_hash'` | `routes/nodes.ts` `/:id/history`、`routes/versions.ts` `/recent` 手寫；`services/history/bodyEvents.ts` 的檔頭寫著「規則只在這裡」 | `services/history` 的 `bodyEventSql` | 無。新增一種改內文的事件時，兩個路由不會漏 |
| A6 | 復原拒絕物件 `history_incomplete`／`state_conflict`（409、`force_available:false`） | `eventRestore/attributes.ts`、`tags.ts` 各一個 `incomplete`，`restore.ts` 內 8 處手寫物件 | `eventRestore/refusals.ts` `historyIncomplete`／`stateConflict` | 無（純物件建構）。仍有帶 `reason` 的幾處手寫，列在 B10 |
| A7 | 路徑／請求中的 bigint 事件 id 驗證（`/^\d+$/`）與 400 訊息 | `routes/events.ts` 4 處、`routes/inbox.ts` 5 處 | `routes/params.ts` `parseBigintId` | **修 bug**：`/api/events/99999999999999999999/preview` 等 9 個入口原本通過 `\d+` 後撞 `::bigint` 轉型回 500，現在是與其他壞 id 一致的 400。`boundarySweep.integration.test.ts` C2b 證明（拿掉範圍檢查就紅：expected 500 to be 400）。訊息文字不變 |
| A8 | 「新筆記沒指定空間時落在哪」（個人空間，否則預設空間）的 SQL | `services/spaces.ts` 內 `newNoteSlugScope` 與 `newNoteSpace` 兩份相同查詢 | `spaces.ts` 私有 `personalOrDefaultSpaceId` | 無，仍走呼叫端交易的 `q()` |

守門：`src/test/guards/dupSweep.guard.test.ts`，一條規則對應一個唯一入口；第二套出現就失敗。
`npm run dup:baseline` 已降低（數字見 PR 說明）。

---

## 二、尚未處理（依價值與風險排序）

### B1. 「哪些節點引用了這個媒體檔」的 SQL 字串比對　價值高／風險中（涉授權）
- 位置：`services/mediaOwners.ts` `mediaReferences`（UNION markdown、presentation、屬性值）；`services/purgedContent.ts` `mediaStillReferenced` 與更新 `media_uploads.node_id` 的語句；`services/backupRestore.ts` `ownerlessReferences`。
- 歸誰：`mediaOwners.ts`（已有 `mediaUrl`），新增「節點 n 引用網址 $k」SQL 片段，三種用法（列出、取最舊、是否存在）共用。
- 差異：`purgedContent` 還掃 `title` 與已存版本、用 `<> ALL` 排除；`backupRestore` 要 `markdown IS NOT NULL` 與 `max(created_at)`；`mediaOwners` 回傳垃圾桶列並帶 `deleted` 旗標。比對規則必須維持 `strpos(lower())`（`mediaAccess.ts` 註解說明不能改 ILIKE，PGroonga）。
- 風險：`mediaAccess` 用它做存取判斷，合併須保持三個欄位與大小寫處理一致；`purgedContent` 掃 title 是刻意還是漂移要先問。

### B2. 路由內直接寫 SQL，繞過服務層　價值中／風險低到中
- `routes/tags.ts` `delete-preview`（約 90 行商業邏輯、7 次 `pool.query`）→ 應為 `services/tagDeletePreview.ts`，與 `trashSubtreeIds` 放一起。
- `routes/nodes.ts` `/:id/ink-versions`、`/:id/export.html` 的取列、`/:id/attributes`、`GET /:id`；`routes/canvases.ts` `findCanvasNode`（與 `boardStore.findBoardNode` 同形，只差節點型別條件）與列表查詢；`routes/inbox.ts` 的 `pending_approval` 查詢（兩處）與 `loadGroupMembers`；`routes/events.ts` cascade-preview 的查詢；`routes/tags.ts` `GET /:id`。
- `routes/edges.ts` 刪除與 `routes/pointers.ts` 刪除：先 `SELECT` 列再把欄位傳給 mutator，兩次查詢之間有空窗；應併進 `deleteEdge`／`deletePointer` 並回傳不存在。
- 差異：讀取皆已先過 `canReadNode`／`canSeeTag`；搬進服務時保持「看不到＝不存在」的 404。
- 風險：不改行為的搬移，但 `edges`／`pointers` 的合併會改變競態行為（變好），需整合測試。

### B3. 路徑 uuid 驗證有五種寫法，部分入口沒有驗證　價值高／風險低到中
- `isUuid`（boards、canvases、sync）、內嵌 regex（`nodes.ts` GET）、`z.string().uuid().safeParse`→404（history）、`.parse`→400（nodes promote／children、spaces、backup、agentSessions）、完全沒驗證（`edges.ts` DELETE、`pointers.ts`、`tags.ts` `/:id`、`nodes.ts` 部分 GET）。另有兩份私有 uuid regex：`services/history/agentRuns.ts`、`services/backupFile.ts`。
- 壞 uuid 的結果不一致：boards／canvases／history 回 404，nodes／spaces 回 400，`canvases` DELETE 回 `{ok:true}`。
- 歸誰：`routes/params.ts`（本 PR 新建，已有 `parseBigintId`）加 `uuidParam`，並明確決定 404 或 400。
- 風險：改壞 uuid 的狀態碼是可觀察的行為，前端與測試可能依賴；沒驗證的入口是否真的 500 要逐一重現（尚未驗證，不在本 PR 宣稱）。

### B4. 手寫的 404／401／403 回應本文　價值高／風險中（契約）
- 404 本文至少六種拼法：`"not found"`、`"node not found"`、`"not_found"`、`"tag not found"`、`"target/parent/edge/pointer not found"`、`"job_not_found"`；`httpError.ts` 其實已把 `StatusError(404)` 轉成 `{error: message}`。
- 401：`if (!actor) return c.json({error:"unauthorized"},401)` 在 `pointers`、`bookmark`、`me`、`mcp`、`events` 手寫，其餘 16 個路由檔用 `requireActor`，兩者回應相同。
- 403：`inbox.ts` 回 `{error:"forbidden", detail}`，`AuthorityError` 經 `httpError` 只回 `{error: message}`，本文不同。
- 歸誰：`httpError.ts`＋`statusError.ts`（已有）。`CodedStatusError` 目前只允許 400／404／409，要補 403／410／422 才能收斂其餘。
- 風險：前端依訊息文字翻譯（`lib/serverErrors.ts`），改拼法是契約變更；要先與前端任務對過。先做「本文不變」的機械替換。

### B5. 形狀相同的錯誤類別　價值中／風險低
- `NodeTrashError`、`NoteDuplicateError`、`NodeUpdateError(msg,status)`（引數順序相反）、`TagModuleError`、`NoteCreateError`、`TagMembershipError`、`AgentRunError`、`TaskUpdateRefusal`、`SpaceMoveError`、`AttributeWriteError`、`CitationError`、`DestinationError`、`SourceSpaceError`、`RewindError`、`SyncRequestTooLarge`、`ScopeUnavailable`、`InvalidSkillRequest` 都是「訊息＋狀態碼（＋代碼）」。
- 歸誰：`statusError.ts` 的 `StatusError`／`CodedStatusError`；各類別保留名稱與 `instanceof`，改為繼承。`httpError.ts` 約 12 個 `instanceof` 分支可縮成一個。
- 差異：各類別回應本文不同（`{error:message}`、`{error:code,detail}`），必須逐類保留。

### B6. 標籤路徑／名稱解析　價值中／風險中
- `tagHierarchy.tagIdForWrittenName`（NFC＋不分大小寫，多筆時退回精確比對，可建立缺的段）、`backupRestore.tagByPath`（手動 split，精確比對、不建立）；`tag.path` 在 `backupRestore` 兩處又自己 split。
- 疑似潛在 bug：`harness/noteSkills.ts`、`workspaceModules.ts` 用 `lower(title)` 而未做 NFC，分解形式的標題會對不上；`tagHierarchy.memberTagIdsNamed`、`wikilinkEdges` 有做。
- `workspaceModules.cleanTagName` 是第二份名稱清理，與 `isTagNameShape` 的禁用字元集合不同。
- 歸誰：`tagHierarchy.ts`，匯出切段函式與 `tagIdForPath(ws, path, {caseSensitive})`。復原要精確比對是刻意的，保留成選項。

### B7. 空間可讀集合在空間模組外重推導　價值中／風險高（權限）——只列不改
- `eventVisibility.eventAudience`、`sync/delta.purgesReadableBy`、`backupArchive.backupSpaces`、`spaces.spacesForActor`、`agentSessions.agentCanWriteSpace`（註解自承是重述 `spaceScope` 的 token 規則）。
- 歸誰：`spine/spaceAccess.ts`。差異在擁有者與 token 分支，各處語意不同；只有「成員空間清單」可安全合併。需先做新舊實作對照測試（逐筆與集合）。

### B8. 祖先／子樹走訪　價值中／風險中
- `nodeTree.ancestorIds`、`wouldCreateParentCycle`、`nodeAttributes.computeInheritedAttributes`（只看活的、深度 10）、`tagHierarchy.fullTagPath`（JS 迴圈、每層一次查詢、上限 16，N+1）、`blockRefLookup` 的 `up` CTE。
- 歸誰：`nodeTree.ts`；`fullTagPath` 改用 `ancestorIds`＋一次標題查詢是明確的贏面。垃圾桶祖先是否計入、深度上限、環處理各處不同；`tagHierarchy`／`nodeTree` 互相 import，改前確認不產生循環。

### B9. HTML 轉文字／標題擷取／實體解碼　價值中／風險低到中
- `pageMeta.extractTitle`（`[^<]+`）與 `harness/scope.stripHtml`（`[\s\S]*?`，標題不解碼實體）；`rss/sanitize.htmlToText`（不去掉 script／style，摘要可能帶出程式碼文字）；三者都做去標籤、解碼、收空白、截字。
- 實體解碼兩套：`@onden/markdown decodeHtmlEntities` 與 `rss/htmlToMarkdown.decodeEntities`（自己的表，nbsp 變一般空格）。
- 歸誰：`pageMeta.ts` 或新 `services/htmlText.ts`。先確認 `@onden/markdown` 的表是否為超集再刪本地那份；nbsp 處理不同會改變 RSS 文章文字。
- `rss/routes.firstImageUrl(html)` 與 `website/publishing/siteRows.firstImageUrl(markdown)` 同名但處理不同輸入，不合併，只改名（`firstImgSrc`）。

### B10. 不寫事件的保留屬性 upsert　價值中／風險中（交易）——只列不改
- `rss/fetch.setOpAttr`（`source='dispatcher'`，衝突時不更新 source）與 `importers/shared/identity.stamp`（`source='derived'`，更新 source，還有 `_import_retyped` 的 DELETE）是同一件事；`eventRestore/attributes` 另有一份必須帶完整欄位的 upsert（復原需要，不併）。
- 歸誰：`systemAttributes.ts`，介面 `setSystemAttribute(ws, nodeId, key, value|null, source)`。兩處都刻意不走有事件的寫入路徑（否則 RSS 每小時刷事件並觸發模組 hook），合併須保留。
- 同組殘餘：`eventRestore/restore.ts`／`attributes.ts` 仍有帶 `reason` 或額外欄位的手寫拒絕物件，可擴充 `refusals.ts` 收掉。

### B11. 空間查詢的其他重複　價值低到中
- `spine/mutate.ts` 的個人空間 `set_config` 子查詢（刻意不退到預設空間，系統工作要被觸發器拒絕，勿合併）；`spaces.personalSpaceOf` 與 `spaces.ts` 內另一處個人空間查詢；`rss/sourceSpace.ts` 內的個人空間條件。
- 命名撞名：`rss/subscriptions.targetSpace(actor, ws)`（選訂閱落點，不檢查權限）與 `backupRestore.targetSpace(actor, ws, spaceId)`（需 `manage` 權限）是兩件事，只改名。

### B12. note／tag 檢視的雙胞胎　價值低／風險低
- `noteViews.lockedView` 與 `tagViews.lockedView`（只差 `node_type` 條件）、`OWNER_SQL`、`readableNoteUnderLock` 與 `visibleTagUnderLock`。`noteViews.ts` 檔頭已寫明是 `tagViews` 的雙胞胎。可抽 `lockedView(ws, ownerId, viewId, ownerKind)`。
- 「活的標籤」`node_type='class_tag' AND deleted_at IS NULL` 手寫約 55 處、「活的筆記」約 18 處；不建議全面替換，只在新程式碼用 `LIVE_TAG_SQL`／`LIVE_NOTE_SQL`（放 `nodeRowProjection.ts`）。

### B13. 查詢參數文法　價值中／風險低
- 天數 `history.countParam`（拒絕超過上限、用 `Number()`）、`mcpSessions` 的 `wait`（寬鬆夾限，刻意）、`sync` 的 `since`（`parseInt`，NaN→0，刻意寬鬆）、`events` 的 `since`（嚴格）。三種「時間點」文法：`isCalendarDay`、zod `datetime`、`Date.parse`（`inbox` 最寬）。
- 歸誰：`services/paging.ts` 加 `parseCount`；時間點文法統一會拒絕目前通過的輸入，需決定。布林旗標有 `=== "1"`／`"true"`／`!== "0"` 五種約定（外觀問題）。
- `inbox.ts` 的 `reviewer()` 與 `approvals` 路由內聯各做一次「requireActor＋reviewerDenied＋403」，可成 `requireReviewer`；`AuthorityError` 本文沒有 `detail`，合併會改本文。

### B14. 小工具　價值低／風險低
- `iso(d)`：`history/noteVersions`、`rss/subscriptions`、`website/publishing/siteDiff`（三種略有不同）；另 `siteRows.isoDateOf` 用 UTC 日期，23:30 本地建立的筆記可能顯示隔天，疑似 bug，需擁有者確認。
- 批次迴圈 `for (at += BATCH)`：`backupRestore` 6 處（500）、`exportZip`（100），沒有 `chunk()`。
- `oneLine`：`bookmarkMarkdown`（收所有空白）與 `taskListFile`（只收換行）行為不同，不合併，只改名避免混淆。
- 「活的節點是否存在」`SELECT 1 FROM content_nodes WHERE … deleted_at IS NULL` 在 `history/rewind` 5 次、`tagMembershipWrites`、`tagViews`。
- `harness/index.skillFileName` 是私有 ASCII slug（僅 ASCII、64 字），與 `@onden/markdown slugify` 規則不同，先確認是否可用後者。

---

## 三、檢查過、不算重複
- 分頁：`services/paging.ts` 已是唯一入口；`rss/routes` 與 `sync/membership` 的 keyset 游標是刻意不同協定。
- agent 工具（`applyTag`、`removeTag`、`createNode`、`updateNode`、`searchNodes`）都呼叫共用的領域操作，沒有複製 REST 邏輯。唯一待查：`queryView` 自己組 `readableNodeIdSet`，需確認與 REST 檢視路由同規則。
- slug：後端只從 `@onden/markdown` import `slugify`，沒有第二份（`skillFileName` 見 B14）。
- `safeFetch` 是唯一的外部抓取入口；重試只在 outbox；限流只有 `agentTools/rateLimit.ts`。
- 事件 payload：`NODE_CREATED` 在 5 處內聯組裝，`body_hash` 都來自 `putBlob`，各自很小，不值得抽。
- `events` 與 `sync` 的 `since` 游標是不同協定，不合併。

---

## 四、建議批次（每批一個 PR 大小）

| 批 | 內容 | 風險 | 前置 |
| --- | --- | --- | --- |
| 1 | B5 錯誤類別改繼承 `StatusError`／`CodedStatusError`（保留名稱與本文）＋ B12 檢視雙胞胎 | 低 | 無 |
| 2 | B2 路由 SQL 搬進服務（先 `delete-preview`、`ink-versions`、`findCanvasNode`；`edges`／`pointers` 併進 mutator） | 低到中 | 整合測試覆蓋 404／可讀性 |
| 3 | B3 uuid 參數統一（先查出沒驗證的入口哪些真的 500，寫失敗測試）＋ B13 `parseCount` | 中 | 與前端任務確認壞 id 狀態碼 |
| 4 | B4 404／401 本文不變的機械替換；之後再談 403 與拼法統一 | 中 | 前端錯誤翻譯對照表 |
| 5 | B9 HTML 轉文字／實體解碼／標題擷取；B14 小工具 | 低到中 | 確認 `@onden/markdown` 解碼表 |
| 6 | B1 媒體引用片段；B6 標籤路徑解析；B8 `fullTagPath` | 中 | 授權與大小寫意圖確認；`mediaAccess` 測試 |
| 不派 | B7、B10 先寫新舊對照測試與契約草圖，再決定 | 高 | 依 AGENTS.md「新公共介面先比較兩種草圖」 |
