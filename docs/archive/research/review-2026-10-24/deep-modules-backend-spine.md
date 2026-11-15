# 深模組審查：後端主幹（寫入、讀取、權限）

> 狀態：歷史紀錄（最後確認 2026-11-01）

審查日期：2026-10-24　範圍：`packages/backend/src/spine`、`routes`、`services`（sync、publishing 除外）、`modules` 只看呼叫主幹的方式。
方法：只讀 `.ts`、設定檔與測試，沒讀任何 `.md`；數字都是 grep 算的（可能把註解裡的字樣算進去，已盡量扣掉），沒有跑測試或 tsc。`檔案:行號` 都相對於 `packages/backend/src`（除非另寫路徑）。

## 一句話結論

**寫入端有一個真正的深模組 `mutate()`，讀取端有一個真正的深模組 `readPolicy`，兩者都被 lint／測試守著而且例外清單很短，整合度整體良好；主要的洞在「守門是以檔案為單位」（一個檔案只要碰過 mutate，裡面的零星裸寫就看不到）、復原引擎自己重組了一條平行的寫入軌，以及部分 route 還在自己組權限＋交易＋查詢，不夠薄。**

## 模組地圖

| 深模組 | 入口檔 | 介面大小 | 呼叫端 |
|---|---|---|---|
| 寫入閘 `mutate` | `spine/mutate.ts:149` | 1 個主函式，參數 `Mutation<T>` 有 8 個欄位（`actor, workspaceId, authority, event{type,targetType,targetId,payload,txMeta,external,triggeredBy}, timing, affectsMembership, visibilityChanged, idempotencyKey, apply`，`spine/mutate.ts:87-140`）；另匯出 `runCascade`(`:74`)、`withIdempotencyKey`、`requireActor`、`spineErrorStatus` | 約 114 處呼叫、46 個檔案（services 37、routes 3、modules 2、其餘 4）。其中 `routes/inbox.ts` 3 處、`routes/collections.ts:161`、`modules/website/routes.ts:53,176` 是路由直接呼叫 |
| 級聯入口 `runCascade` | `spine/mutate.ts:74` | 1 函式 | 10 處：`tagDispatcher.ts:123`、`nodeTrash.ts:125,162`、`fieldDefaults.ts:49`、`agentTools/registry.ts:167`、`agentSessions.ts:571`、`templateExpander.ts:111`、`nodes.ts:163`、`backupRestore.ts:722` 等 |
| 權限判斷 `assertAuthority` | `spine/authority.ts:145` | 1 函式＋ 11 種 `Authority`（`:47-104`） | `mutate` 內部必走；另有 62 處外部直接呼叫（見問題 5）。各種 kind 使用次數（非 spine、非測試）：node 55、principal_admin 42、cascade 23、space 17、any_space_write 15、retained_node 7、tag 5、tag_membership 3、review 3、space_write 1、open 8 |
| 讀取政策 `readPolicy` | `services/readPolicy.ts`（63 行） | 8 個匯出：`readableNodeIdSet`、`readableTrashedNodeIds`、`readableScopeSql`、`restrictRowsToScope`、`canReadNode`、`canReadRetainedNode`、`canSeeTag`、`publiclyReadableNodeIds` | `readableScopeSql` 27 檔、`canReadNode` 24 檔、`readableNodeIdSet` 23 檔、`canSeeTag` 10 檔。規則本體只在 `services/spaceScope.ts`／`spaceAccess.ts`（`spaceAccessSql` 只有 2 個檔案用，`spaceAccess.ts:57`） |
| 現任操作者 `resolveCurrentActor` | `services/currentActor.ts:15` | 1 函式 | 由 `mutate`（`spine/mutate.ts:209`）、`runCascade`、`restoreEvent`（`eventRestore/restore.ts:203`）、dispatcherQueue 等使用 |
| 復原引擎 `restoreEvent` | `services/eventRestore/restore.ts:194`（`index.ts` 只匯出 `restoreEvent`、`previewEventRestore`） | 2 函式，但實作 997 行 | 4 個呼叫端：`routes/events.ts:370`、`services/eventReview.ts:94,159`、`services/backupRestore.ts:580`；全部經過 index |
| 代理工具／MCP | `services/agentTools/registry.ts`（`callTool`、`callPrompt`、`toolsAllowedFor`） | 3 個函式 | MCP 兩條路由 `routes/mcp.ts:53`、`routes/mcpProtocol.ts:134` 都只呼叫 `callTool`，路由內沒有權限／SQL |
| 錯誤映射 | `httpError.ts:54` `apiOnError`、`:123` `toolOnError` | 2 函式 | `spineErrorStatus` 只剩 `httpError.ts:68` 與 `services/eventReview.ts:126` 使用，路由不再各自 catch 權限錯誤 |

## 分數表

| 子模組 | 深度(1-5) | 整合度(1-5) | 理由 |
|---|---|---|---|
| 寫入閘 `spine/mutate` | 4 | 4 | 一個函式藏住鎖、重讀 actor、權限、事件歸屬、同交易、冪等、級聯（`mutate.ts:1-26` 的五條保證都在程式裡實作）；扣分在 `Mutation` 欄位偏多，且 12 個檔案仍直接 `event()`（見問題 2） |
| 權限 `spine/authority` | 4 | 4 | 單一 switch 把所有「誰能做什麼」收在一處（`authority.ts:145-235`），`cascade` 在 `mutate` 開頭被擋成不能當根（`mutate.ts:159-164`）；扣分在 62 處外部預檢與 8 處 `open` |
| 讀取政策 `readPolicy`＋`spaceScope` | 5 | 4 | 63 行介面、全部呼叫端經它；lint 規則涵蓋全 `src`（`require-read-gate.js`）；扣分在 INTERNAL 豁免 58 筆只靠文字理由，且 route 先 `canReadNode` 再自己下 SQL |
| 復原引擎 `eventRestore` | 4 | 3 | 對外只有 2 個函式、4 個呼叫端全經過；但內部用 `event()`＋`withTransaction` 自組一條與 `mutate` 平行的軌（問題 2） |
| 代理工具／MCP `agentTools` | 3 | 4 | 工具本身是薄轉接（`agentTools/updateNode.ts` 直接呼叫 `nodeUpdate.updateNode`，與 REST PATCH 同一操作），0 個工具自己下 SQL 寫表；因是註冊表而非深模組故深度 3；registry 內自己 5 次 `event()` 寫稽核（`registry.ts:106,132,137,171,186`），屬已登記的 audit 類 |
| 路由層 `routes/*` | 2 | 3 | 34 個路由檔共 3978 行，寫入 SQL 為 0（`no-route-writes` 規則空例外清單），但 9 個檔案仍直接 `pool.query` 讀（31 處），6 處在路由內自組 `mutate`（問題 3） |
| 派送／背景（`dispatcher`、`dispatcherQueue`、`taskScheduler`） | 3 | 3 | dispatcher 的 handler 走 `mutate`（`dispatcher/builtinHandlers.ts:85,184`）、`tagDispatcher` 走 `runCascade`；但 `dispatcherQueue`（2 處）與 `taskScheduler`（2 處）直接 `event()`（system 類，已登記），`taskScheduler.ts:149` 還裸 UPDATE 屬性（問題 1） |
| harness／maintenance | 3 | 5 | `services/harness/*` 沒有寫入 SQL、沒有 mutate／event（純讀，且讀取走 `readableNodeIdSet`／`readableScopeSql`）；`maintenance/prune.ts` 只有一條孤兒 blob 的 `DELETE`，且已列在服務層裸寫清單 |

## 問題清單（依嚴重度）

### 1. 【中高】「寫入必經 spine」的守門是以檔案為單位，一個檔案只要出現過 `mutate(` 或 `withEventTransaction(`，裡面的裸寫就看不到
- 現況：`test/spineGate.test.ts:198-247` 的清單 `SERVICE_RAW_WRITE_ALLOWLIST`（29 筆）只列「有寫入 SQL 且整檔沒有 `SPINE_ENTRY`」的檔案（`SPINE_ENTRY` 定義在 `:234`）。測試檔自己也承認「file-level: once a file calls the spine, a stray raw write in it passes」（`:195` 註解）。
- 證據：
  - `services/nodes.ts:112` `reslug()` 直接 `UPDATE content_nodes SET slug`，不開事件、不檢權限；呼叫端 `eventRestore/restore.ts:841`、`services/collections.ts:338`（推測：這兩處都在外層 mutate／restore 交易內，所以實際安全，但函式本身沒有任何機制要求這點，`nodes.ts` 因檔內有其他 spine 字樣而過關）。
  - `services/taskScheduler.ts:149` 裸 `UPDATE node_attributes SET value='cancelled'`，同函式內用 `event(..., "system", "system-task-scheduler")`（`:143,170`）寫事件；是「系統行為」類（`test/spineEventGate.test.ts:41` 已登記），但狀態變更不在 `mutate` 內、沒有權限檢查。
  - `services/blockNodes.ts:116-208` 對 `block_nodes`、`node_attributes` 的 INSERT/UPDATE，靠呼叫端在儲存交易內（登記理由在 `spineGate.test.ts:206`）。
  - 清單理由的準確度：`boardStore.ts` 的登記理由寫「written inside the board's own CANVAS/BOARD_UPDATED mutate()」（`spineGate.test.ts:204`），但 `routes/nodes.ts:635` 的 `setNodePosition` 是路由直接呼叫、不在任何 mutate 內（路由註解 `:612-614` 說這是刻意的「拖動不進事件」）。理由只對一半的呼叫路徑成立。
- 影響：新增或改動這類「列程式 helper」時，不會被測試擋下來；權限與事件是否包住，只能靠人讀。
- 建議修法：把「列程式 helper」改成函式簽名要求一個交易憑證（例如只接受 `mutate` 的 `apply` 傳入的 context），測試改成找「不在憑證內呼叫的寫入 SQL」而不是看整檔有沒有 mutate 字樣。

### 2. 【中】復原引擎自己重組了一條與 `mutate` 平行的寫入軌
- 現況：`restoreEvent` 用 spine 的零件（`withEventTransaction`、`withIdempotencyClaim`、`resolveCurrentActor`，`eventRestore/restore.ts:53-55,200-203`），但寫事件時直接 `event()`＋`withTransaction`：`restore.ts:588,632,788`（以及 `record.ts:19`）。成員資格版本號的遞增也手寫一份（`restore.ts:259-272`，條件是 `node_type` 被還原），不是用 `mutate` 的 `affectsMembership` 欄位。
- 證據：直接 `event()` 的檔案共 12 個、20 處呼叫，清單在 `test/spineEventGate.test.ts:30-41`；其中 restore 類 2 個檔案、4 處呼叫（`restore.ts` 3、`record.ts` 1）。`event()` 的 actor 型別是 `RestoreActor = { id; type: "user" | "ai_agent" }`（`restoreContract.ts:13`），直接傳 `actor.type`，沒有走 `mutate` 的 `eventActorType(actor.type)`（`mutate.ts:164`）——「actor_type 由 actor 推導、呼叫端無法指定」這條保證在此沒有型別上的強制。
- 影響：`mutate` 以後再加新保證（例如新欄位、新的版本號規則）時，復原引擎不會自動拿到，要記得另外補；兩邊 `affectsMembership` 判斷是兩份。
- 建議修法：讓 `mutate` 接受「由復原提供的事件內容與 triggered_by」（或提供 `mutateRestore` 包裝），把成員資格判斷、actor 歸屬收回同一處，保留領域衝突判斷在 restore。

### 3. 【中】路由不夠薄：部分路由自己組權限＋交易＋查詢
- 現況：寫入 SQL 在路由層確實是 0（`eslint-rules/no-route-writes.js` 空例外清單、`spineGate.test.ts:130` 也驗），這點做得好。但：
  - 9／34 個路由檔直接 `pool.query` 讀表，共 31 處（`canvases.ts` 2、`collections.ts` 6、`edges.ts` 1、`events.ts` 2、`inbox.ts` 3、`nodes.ts` 8、`pointers.ts` 1、`tags.ts` 9、`versions.ts` 1）；`modules/*/routes.ts` 另有 9 處 `pool.query`。典型寫法是先 `canReadNode(...)` 再自己下 SQL，例如 `routes/nodes.ts:211-231,285-298,455-469,525-540`。
  - 路由自己組 `mutate`：`routes/inbox.ts:113,183,212`（含 `apply` 內的狀態保護邏輯）、`routes/collections.ts:161`、`modules/website/routes.ts:53,176`；`modules/website/routes.ts:129` 直接拿 `withIdempotencyClaim`＋`withTransaction` 自組交易（`:7-8` 引用 `spine/idempotency.js`）。
  - 路由自己做「權限預檢＋裸寫」：`routes/nodes.ts:633-635`（`assertAuthority` 之後直接 `setNodePosition`，沒有在事件鎖內重讀 actor）。
  - `routes/nodes.ts:354` 的 `withTransaction` 包兩個 mutate（`:346` 註解說明原因），`routes/nodes.ts:15` 匯入了 `mutate` 但整檔沒有呼叫（死匯入）。
- 影響：權限與可見性的新規則（例如撤權後重讀）要改到這些路由逐一確認；也是 `canReadNode` 之後拼 SQL 的模式——只要新增一條 GET，就得自己記得 `canReadNode`（有 lint 擋「完全沒有」，擋不了「少一支」）。
- 建議修法：把 `routes/nodes.ts` 的版本歷史、屬性、位置、`inbox.ts` 的決定／重送操作各收成一個 service 函式（路由只剩 parse→呼叫→回應），`require-read-gate` 的 GATED 清單裡 `routes/*` 項目逐步搬到 services。

### 4. 【中】spine 反向依賴 services（層次倒置）
- 現況：`spine/*` 引用 `services/` 共 7 處：`authority.ts:17-19`（`reservedNodes`、`spaceScope`、`spaceAccess`）、`idempotency.ts:3`（`txHooks`）、`mutate.ts:29,35,38`（`nodeHooks`、`toolScope`、`currentActor`）。反過來 `services/currentActor.ts:2` 又引用 `spine/actor.ts`。
- 影響：「spine 是底層、services 是上層」的想像不成立；目前沒有循環（推測：靠 `actor.ts` 獨立成檔避開），但以後在 `services/spaceScope.ts` 加依賴，容易繞回 spine 形成循環。`restoreHandlers.ts:9-11` 的註解也寫到相同類型的循環需要懶載入。
- 建議修法：把 `spaceScope`／`spaceAccess`／`currentActor`／`toolScope`／`txHooks`／`nodeHooks` 這幾個 spine 必須知道的規則搬到 `spine/` 底下（或獨立 `policy/`），讓依賴方向單向。

### 5. 【低中】權限預檢：62 處在 spine 之外直接呼叫 `assertAuthority`，同一個權限常見宣告兩次
- 現況：`mutate` 內部必檢；另有 62 處外部呼叫（`grep "assertAuthority("`）：routes 2（`nodes.ts:633`、`tags.ts:189`）、modules 7（`citations/papers.ts:109`、`semantic/routes.ts:16`、`rss/save.ts:127`、`rss/routes.ts:132,307`、`website/routes.ts:47,316`）、其餘在 services（`spaces.ts` 9、`noteDuplicate.ts` 7、`nodeTrash.ts` 3、`obsidianFolders.ts` 3、`eventRestore/policy.ts` 4 等）。
- 影響：預檢有些是必要（dry-run、拒絕要先於查詢以免洩漏存在與否，例如 `ownerTransfer.ts:36`），但也有「route 檢一次、`mutate` 又檢一次」造成兩個地方可能不同步，例如 `routes/tags.ts:189` 與 `tagWrites.ts:359`、`tagIdentity.ts:29`。
- 建議修法：盤點這 62 處，凡是「為了在 mutate 前先拒絕」的，改成提供 dry-run／precheck 版本的 `mutate` 選項；只保留必須在查詢前拒絕（防探測）的少數。

### 6. 【低】已登記但已失效的例外
- `test/spineEventGate.test.ts:30` 把 `routes/tags.ts` 登記成可以 `event()`，實際上 `routes/tags.ts:4` 只匯入了 `event`，整檔沒有呼叫（`grep "event("` 在該檔 0 筆）；清單的「過期檢查」只看有沒有匯入（`spineEventGate.test.ts:89` 起），所以抓不到。同理 `routes/nodes.ts:15` 匯入 `mutate` 未使用。
- 建議修法：把過期檢查改成找「呼叫」而不是「匯入」；刪掉死匯入。

### 7. 【低】讀取政策介面有殘留與重複
- `readableScopeSql(actor, _workspaceId, alias, params)` 的 `_workspaceId` 參數沒有被使用（`readPolicy.ts:34`），但 27 個檔案的呼叫端都得傳（資訊外洩的小例子：呼叫端以為需要）。
- `canSeeTag` 與 `canReadNode` 實作完全一樣（`readPolicy.ts:48-62` 都是 `spaceCanRead(actor, id, "live")`），差別只有名稱；分兩個名字合理（語意不同），但容易讓人以為規則不同。
- 建議修法：移除未用參數並批次改呼叫端；在 `canSeeTag` 的註解寫明「與 canReadNode 同規則，僅為語意」。

### 8. 【低】讀取閘的「豁免」靠文字理由，沒有機制驗證
- `eslint-rules/require-read-gate.js` 把 108 個讀 `content_nodes` 的檔案分三桶：GATED 45、INTERNAL 58、DEFERRED 6（共 109）。GATED 會驗證檔案有引用指定的 primitive；INTERNAL 只是一段理由文字（例如 `agentSessions.ts`、`mediaOwners.ts`、`nodeUpdate.ts`）。GATED 檢查也是檔案層級：檔案有一處引用 `canReadNode`，另一處漏掉就不會被抓（推測：靠審查）。
- 建議修法：INTERNAL 的函式簽名限制為只回 id／boolean（型別上不回 row），讓「不外送內容」成為型別保證。

### 9. 【低】`pool.query` 與 `q()` 並存
- services 內有 111 處 `pool.query`，其中寫入約 10 處，全是記帳類表（`outbox.ts:125,607,632,868,872`、`dispatcherQueue.ts:176`、`embeddings.ts:53`、`blobs.ts:32`、`agentTools/rateLimit.ts:136`、`agentTokens.ts:132`、`maintenance/prune.ts:29`），沒有寫 `content_nodes`／`node_attributes`。`spineGate.test.ts:129-153` 的 `pool.query` 寫入凍結只涵蓋 routes 與 modules，不含 services。
- 影響：目前沒有實際違規，但 services 層之後新增 `pool.query` 寫內容表，不會被擋。
- 建議修法：把該測試的範圍擴到 `services/`，用既有 12 個記帳檔做例外清單。

## 做得好、值得保留的地方

- `mutate` 的「by construction」保證有真的寫進程式：`cascade` 權限不能當根（`mutate.ts:159-164`）、嵌套呼叫繼承根 actor（`:151-153`）、事件鎖與重讀 actor 在權限檢查之前（`:208-219`）、事件與狀態同交易、冪等認領放在根交易內（`:239-244`）。
- 寫入邊界有四層測試／lint 守著：`no-route-writes`（空例外）、`spineEventGate`（12 檔例外、每條有分類理由、有過期檢查）、`spineGate` 的服務層清單與 `pool.query` 凍結、`principal_admin` 次數凍結（`spineGate.test.ts:262-297`）。
- 路由寫入 SQL 為 0、`eslint-disable` 全專案只有 6 處且都不涉及這些邊界（`githubBackup.ts:38`、`embedder.ts:70,72,77`、`backupFile.ts:91`）。
- 讀取權限只有一個規則來源：`spaceAccessSql`（`spaceAccess.ts:57`）寫一次，其餘都是它加不同過濾；`readableScopeSql` 把範圍壓進 SQL，LIMIT 落在已授權列上；`require-read-gate` 對全 `src` 要求「讀 `content_nodes` 的檔案必須分類」，新的未分類檔案會 lint 失敗。
- 代理工具與 REST 共用同一操作（`agentTools/updateNode.ts` → `nodeUpdate.updateNode`），MCP 兩條路由都只有 `callTool`，工具檔案沒有一個直接下 SQL 寫表；工具授權與速率限制在 `admitCall` 一處（`registry.ts:79-125`），拒絕也會被稽核。
- 錯誤映射集中在 `httpError.ts`，路由不再各自 catch 權限錯誤。

## 不確定、需要人確認的點

1. 問題 1 的 `reslug`、`blockNodes`、`boardStore` 等 helper，我只確認「呼叫端看起來都在交易內」，沒有逐一追蹤所有路徑；需要擁有者決定是否補一個「必須在 mutate 內」的型別憑證。
2. 問題 2 的 restore 軌道：是否刻意不用 `mutate`（例如歸屬規則不同），或只是歷史包袱？`affectsMembership` 判斷（`restore.ts:259-272`）與 `mutate` 的宣告式欄位是否應合一。
3. `taskScheduler.ts:149` 的系統取消屬性是否應走 `mutate`（actor 為 system）或維持現狀；`mutate.ts:21-23` 註解寫明 system 不在 spine 範圍，但狀態變更本身沒有權限也沒有事件鎖外的保護。
4. `routes/nodes.ts:635` 的位置寫入刻意不產生事件，我沒有判斷這個設計是否與「寫入走 spine」的規則衝突（`boardStore.ts` 的登記理由與實際不完全一致）。
5. 問題 5 的 62 處預檢，我只抽看了其中一部分（約 15 處）判斷用途，其餘是 grep 計數；比例（必要 vs 重複）是推測。
6. 沒有執行 `tsc`、lint 或測試；所有「測試會過」的判斷都是讀測試程式得到的，沒有實際跑過，也沒有確認哪些整合測試在隔離資料庫實際執行。
7. `modules/` 只看了呼叫主幹的部分（`mutate`／`assertAuthority`／`pool.query`／SQL 寫入），沒有審查 module 內部設計。
