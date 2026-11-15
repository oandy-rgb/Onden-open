# 深模組審查：資料層與同步（2026-10-24）

> 狀態：歷史紀錄（最後確認 2026-11-01）

審查方式：只讀程式碼（`.ts/.tsx/.js/.json`、測試、設定），沒有讀任何 `.md`；沒有修改程式。
基準：`origin/main`（6f1b2cbc）。本環境沒有安裝 `node_modules`，所以沒能實際跑 eslint / tsc；
凡是靠「讀設定推論」的結論都標了「推測」。

## 一句話結論

資料層是真的深：前端 `lib/data` 用一個 barrel（97 個匯出名字）當唯一入口，139 個檔案經它進出，
元件／hooks／pages 裡**沒有**任何一處直接 import `api()` 或本機資料庫；後端 `services/sync` 只有 2 個路由消費者、
12 個匯出名字。真正的洞在三處：**`modules/**` 被 lint 整個豁免（14 檔、20 處自己打 `/api`）**、
**同步協定型別前後端各寫一份（靠契約測試而非共用定義）**、以及**一條 lint 守門規則疑似被後面的設定蓋掉**。

## 模組地圖

### M1. 前端資料層入口 `lib/data`

- 入口：`packages/frontend/src/lib/data/index.ts:1-2`（註解：「Import from lib/data, never from a file inside it」）。
- 介面大小：barrel 共 97 個匯出名字（我用腳本數 `export {…}` 清單）。多數是領域 writer（`noteWriter`、`tagWriter`…，
  `domainWriters.ts:48-65`）、`reads`（6 組，`reads.ts:196`）、`dataSync`／`localCopy`／`recovery` 三組（`sync.ts:21-96`）。
  介面不算「小」，但每個名字都是領域動詞，不是底層零件。
- 呼叫端：139 個檔案 `from "…/lib/data"`（不含 `lib/data` 自己與測試）。
- 內部規模：`lib/data` 共 7,551 行；`syncEngine.ts` 1,191 行、17 個模組層級 `let` 狀態（`syncEngine.ts:42,43,102,164,165,340,416,460-462,524,530,531,540,550,582,736`）。

### M2. 同步引擎 `dataSync`（boot／refresh／sync／lazy body／reconnect）

- 入口：`lib/data/sync.ts:21-59` 的 `dataSync`（約 20 個 getter），實作在 `syncEngine.ts`。
- 呼叫端（`lib/data` 以外）：`dataSync.*` 共約 22 處呼叫，分散在 `useAppData.ts`、`hooks/useWorkspaceLive.ts:40,44`、
  `FailedWriteRecovery.tsx:30`、`settings/registry.tsx` 等；沒有任何元件自己 `setOnline`／`setBootstrapped`
  （搜尋 `setOnline(|setBootstrapped(|setMembershipGated(|setAccessRevoked(` 在 `lib/data`、`appStore` 之外 0 筆）。

### M3. 離線寫入佇列 `writeQueue` ＋ 線上寫入 `onlineWrite` ＋ 錯誤 `writeErrors`

- 入口：`submitWrite`／`sendOrQueue`（`writeQueue.ts:108,162`）、`sendWrite`（`onlineWrite.ts:99`）、
  `onlineOperation`（`onlineWrite.ts:44`）；失敗恢復 `recovery.*`（`sync.ts:80-96`）。
- 呼叫端（`lib/data` 之外）：`sendWrite` 約 20 處呼叫（`modules/rss`、`modules/review`、`hooks/useInboxGovernance.ts`、
  `settings/**`、`lib/spaces.ts` 等）、`sendOrQueue` 2 處（`modules/rss/RssReaderPanel.tsx:316,365`）。
  `queueWrite`／`addPendingWrite`／`submitWrite` 在 `lib/data` 之外 0 處（只有測試 helper `test/helpers/saveWorld.ts:175`）。

### M4. 本機資料庫 `localDb`（sql.js worker）

- 入口：`lib/localDb.ts`（513 行，約 60 個匯出函式），實際工作在 `localDbWorker.ts`（1,351 行）。
- 呼叫端：`lib/data` 內 21 個檔案 import 它；`lib/data` 外只有 `lib/pendingNoteProjection.ts:2`（`import type`）。
  lint 擋住其他人（`eslint.config.js:243-250`）。`new Worker` 全專案只有 `localDb.ts:53` 一處。

### M5. 共享記憶體狀態 `appStore`

- 入口：`lib/appStore.ts`（471 行）；寫入 `data` 的 `setData` 被 lint 限制（`eslint.config.js:252-255`）。
- 呼叫端：119 處 value import 來自 `lib/data` 之外（多為 `useAppSelector`／`addToast`，屬讀取與 UI 狀態）。

### M6. 後端同步服務 `services/sync`

- 入口：`packages/backend/src/services/sync/index.ts:6-10`，匯出 12 個名字
  （`buildSyncDelta`、`membershipPage`、`membershipDigest`、`nodesFor`、`bodiesFor`、`drawingIndex`、`drawingsFor`、`buildBootstrap`…）。
- 呼叫端：只有 2 個路由——`routes/sync.ts:6`、`routes/bootstrap.ts:4`（合計 157 行，純解析請求＋回傳 JSON，
  `routes/sync.ts:9-11` 註解寫明）。
- 每個對外函式都包 `withActorReadSnapshot`（`bodies.ts:22`、`bootstrap.ts:75`、`delta.ts:78,96`、`drawings.ts:23,43`、
  `membership.ts:107,136,176` 共 9 處），讀取走 `readPolicy`；後端 `eslint-rules/require-read-gate.js:41-45` 要求這三個檔必須出現 `readableNodeIdSet`。

## 分數表

| 子模組 | 深度 | 整合度 | 理由 |
| --- | --- | --- | --- |
| M1 `lib/data` 入口 | 4 | 4 | 139 檔只走一個 barrel，領域 writer 命名成「使用者要做的事」；但 97 個名字偏多，且有 1 個 lint 豁免與 2 個 `eslint-disable` 繞路。 |
| M2 同步引擎 `dataSync` | 4 | 4 | 約 20 個動詞藏住 boot／delta／membership／lazy body；外界 0 處自管連線旗標。扣分在 `syncEngine.ts` 是 1,191 行、17 個模組層級狀態的單檔。 |
| M3 寫入佇列／線上寫入 | 3 | 3 | 離線安全入口乾淨（外部 0 處碰佇列），但「寫入」有三種入口（`sendWrite`／`sendOrQueue`／`onlineOperation`）要呼叫端自己選，語意差異（會不會排隊、有沒有 idempotency 重用）外洩給使用者。 |
| M4 `localDb` | 4 | 5 | 單一 worker、單一入口，lint 守得住（外部只剩一個 type import）。60 個匯出偏寬，但那是儲存層的本分。 |
| M5 `appStore` | 3 | 3 | 讀取任意處可用是設計；但 `getAppState().data` 在 `lib/data` 外有 33 處、`setAppState` 有 1 處（`lib/buildVersion.ts:34`），沒有守門。 |
| M6 後端 `services/sync` | 4 | 5 | 2 個消費者、薄路由、每個入口自帶讀取快照與讀取政策、另有 lint 規則要求讀取閘門。 |
| 前後端協定型別（跨 M1／M6） | 2 | 2 | 同一份協定各寫一份（見問題 2），只有契約測試（事後比對形狀）保護。 |

## 問題清單（依嚴重度）

### 1. 【高】`modules/**` 整個豁免讀取守門：14 檔、20 處自己組 `/api` URL

- 現況：`reads-through-data` 規則對 `src/modules/**` 關閉（`eslint.config.js:226`，註解「a module owns its own endpoints」）。
  於是 `modules/` 底下 14 個檔案直接 import `api`／`apiFetch`／`postRead`，共 20 個呼叫點。
- 證據（檔案：行）：
  `modules/read_later/useReadLater.ts:16`；`modules/citations/api.ts:13,21,28`；`modules/review/ReviewSettings.tsx:100`、
  `useLiveResource.ts:14`、`ReviewPanel.tsx:131`；`modules/rss/RssReaderPanel.tsx:161,228`、`useRssUnread.ts:70`；
  `modules/website/WebsiteDesignPanel.tsx:38`、`usePublishReview.ts:55`、`PublishShareAction.tsx:50`、`PublishedSnapshots.tsx:28`、
  `CollectionsManager.tsx:583,597`、`useWebsiteMode.ts:74,86`、`websiteWriter.ts:72`。
  另外 `RssOpmlWidget.tsx:45`、`WebsiteStudio.tsx:181`、`HomeStudio.tsx:327` 自己用 `getApiBase()` 拼下載網址。
- 好消息：這 20 處**全是讀取**；寫入 37 個 module 檔案都走 `sendWrite`／`sendOrQueue`（`lib/data` 內建 Idempotency-Key），
  `writes-through-data` 規則對 modules **沒有**豁免（`eslint.config.js:214`），所以寫入守得住。
- 影響：這 20 處各自承擔「離線時怎麼辦」「錯誤怎麼分類」「是否去重」，例如 `useLiveResource.ts:14` 自己吞錯誤並保留舊值、
  `CollectionsManager.tsx:583,597` 重複兩次同一個 GET；`lib/data/reads.ts` 與 `queryCache.ts` 的存在就是為了消除這種重複。
- 一句話修法：在 `reads.ts` 加一組 `reads.modules`（或每個 module 一個讀取檔放進 `lib/data`），並把 `eslint.config.js:226` 的 `src/modules/**` 拿掉。

### 2. 【高】同步協定的型別前後端各寫一份，沒有共用定義

- 現況：`SyncDelta` 在後端 `services/sync/delta.ts:28` 與前端 `lib/localDb.ts:468` 各定義一次，欄位型別不同
  （後端 `Row[]`，前端 `ContentNode[]`；`last_event_id` 前端是 `number | string`，後端是 `number`）；
  `Bootstrap` 只在前端 `lib/api.ts:362`；成員資格型別（`MembershipPage`／`MembershipDigest`）只在前端 `membershipReconcile.ts:9-34`；
  分桶摘要演算法（`MEMBERSHIP_BUCKET_CHARS = 2`）前後端各寫一份（`lib/data/membershipDigest.ts:12`、`services/sync/membership.ts:55`）；
  壓縮 bootstrap 的編碼在後端 `services/sync/bootstrapWire.ts`，解碼在前端 `lib/data/bootstrapWire.ts`，兩邊各自一份測試。
- 保護機制：有契約測試——後端記錄每個回應的形狀到 `packages/markdown/contract/api-shapes.json`
  （`backend/src/test/apiContract.integration.test.ts:257-267`），前端 `frontend/src/test/apiContract.test.ts:41-52`
  用 TypeScript 編譯器 API 檢查「必填欄位一定有送」。它擋得住「少送必填欄位」，但擋不住「型別含意改了」（例如游標字串 vs 數字）
  與「演算法兩邊漂移」（摘要分桶規則）。
- 影響：協定改動要同時改兩個套件的型別與演算法；契約測試要跑整合測試資料庫才會失敗（本次沒跑，不確定 CI 是否每次都跑）。
- 一句話修法：把 `SyncDelta`／`MembershipPage`／分桶摘要／壓縮 wire 的常數與型別放進 workspace 共用套件（已有 `@onden/markdown`、`@onden/site` 先例，`frontend/package.json:46-47`）。

### 3. 【中】守門規則疑似被後面的設定蓋掉，且指向不存在的檔案（推測）

- 現況：`eslint.config.js:157-175` 用 `no-restricted-syntax` 禁止在 `catch` 裡呼叫 `queueWrite`，套用在
  `draftActions.ts`、`nodeMutations.ts`、`graphMutations.ts`；其中 `graphMutations.ts` 在 repo 裡**不存在**（`ls` 確認），
  註解還提到已不存在的 `offline.ts`（`sendOrQueue` 實際在 `writeQueue.ts:162`）。
  接著 `eslint.config.js:183-206` 對 `src/**/*` 又設一次 `no-restricted-syntax`，flat config 同名規則後者**整組取代**前者（不合併）。
- 推測：因此 `draftActions.ts`、`nodeMutations.ts` 實際上已沒有「catch 內不得 queueWrite」的檢查。我沒能執行 `eslint --print-config` 驗證（沒有 node_modules）。
- 目前沒有違規：這兩個檔案裡根本沒有 `queueWrite`（grep 0 筆），所以沒出事；但守門失效時，下次有人寫就不會被擋。
- 一句話修法：把兩組 selector 合併成同一個 `no-restricted-syntax`，並把 `files` 改成實際存在的檔案（或直接改成對整個 `src/lib/data/**` 套用）。

### 4. 【中】「寫入」有三個入口，選錯不會被發現

- 現況：線上就好用 `sendWrite`（`onlineWrite.ts:99`，單次 idempotency key）；要等伺服器確認且要多步驟用 `onlineOperation`
  （`onlineWrite.ts:44`，內建 resource 排序、重試重用 key、離線擋下）；可離線用 `sendOrQueue`／`submitWrite`（`writeQueue.ts:108,162`）。
  `writes-through-data` 規則只確認「不是裸 `api()`」（`eslint-rules/writes-through-data.js:46-58`），不確認選對哪一個。
- 證據：呼叫者自己決定，例如 `RssReaderPanel.tsx` 同一個檔案混用 `sendWrite`（178,206,337,403,420）與 `sendOrQueue`（316,365）；
  `writeQueue.ts:151` 的 `queueWrite` 與 `writeQueue.ts:160` 的 `sendOrQueue` 註解都寫著 "Compatibility"，代表舊入口還留著。
- 影響：`sendWrite` 失敗時**不排隊也不進 recovery**，離線時資料會丟；是否合理要看每個呼叫點的意圖，lint 無法驗證。
- 一句話修法：把三者收成一個「寫入意圖」參數（例如 `write({ durability: "online-only" | "queue" })`），並把 "Compatibility" 的舊入口遷移掉。

### 5. 【中】增量套用邏輯在記憶體與 SQL 各實作一次

- 現況：同一份 `SyncDelta` 被套用兩次——記憶體樹 `storeOps.applySyncDelta`（`storeOps.ts:145-`），SQL 鏡像 `localDb.applySync`
  → `localDbWorker.ts`。`storeOps.ts:34-51,148-152` 的註解直接寫「mirrors dropNode + the worker's cascade」，
  即「刪節點時連帶刪 edges/tasks/pointers」這條規則在兩處各寫一次，靠註解維持一致。
- 保護：有 fuzz 測試 `frontend/src/test/syncDelta.fuzz.test.ts`（我只確認它存在且引用 delta，沒有逐行驗證它比對兩個實作）。
- 影響：新增一個 delta 欄位（如 `canvas_memberships`、`pointers`）要改兩處加前後端型別，漏一處就是「重新整理後才對」的 bug。
- 一句話修法：讓記憶體樹從 SQL 套用結果回讀（`AppliedSyncDelta` 已有此雛形，`localDb.ts:513`），規則只留在 worker 一份。

### 6. 【中】同步引擎單檔過大、狀態散在 17 個模組層級變數

- 現況：`syncEngine.ts` 1,191 行，17 個 `let`（列表見 M1），同時負責 boot、refresh、hydrate、body／drawing 下載、membership 重驗、
  防抖（`membershipSettle`）、digest 預取（`digestPrefetch`）、reconnect。函式之間用旗標互相知道（`syncDirty`、`bootCursorReady`、
  `reconciledRejectionRevision`、`syncInFlight`）。
- 影響：這是前端最複雜的檔案，也是最需要「一個人能讀懂」的檔案；入口介面（`dataSync`）很乾淨，但內部不深。
- 一句話修法：先把 body／drawing 離線下載（`syncEngine.ts:414-520`）切成獨立模組，因為它們與 delta 流程只共用 `backgroundFetchAllowed`。

### 7. 【低】`appStore` 的寫入只擋了 `setData`，其他欄位無守門

- 現況：lint 只擋 `setData`（`eslint.config.js:252-255`）；`setAppState` 在 `lib/data` 與 `appStore` 之外仍有 1 處（`lib/buildVersion.ts:34`）；
  `getAppState().data` 在 `lib/data` 外有 33 處讀取（`hooks/useBoardWorkspace.ts` 6 處最多，`modules/website/introSite.ts` 3 處、`hooks/useWorkspaceFocus.ts` 3 處…）。
- 影響：讀是安全的，但這 33 處是「不透過 hook／selector 的快照讀取」，不會在資料變動時重繪，且繞過 `selectOverviewNodes` 等 selector 的過濾（推測，未逐處檢查）。
- 一句話修法：把常用的 `getAppState().data.nodes.find(...)` 收進 `reads.local.*` 或 selector，再用 `no-restricted-properties` 擋 `getAppState().data`。

### 8. 【低】「目前這篇筆記」概念單一，但名稱散亂

- 現況：單一來源是 `appStore.selectedId`（`appStore.ts` 的 `AppState.selectedId`，註解「Focused node id (URL-synced)」）；
  selector `selectSelectedNode`（`appStore.ts:369`，17 處使用）與 `selectOverviewSelectedNode`（`:375`，帶「無選取時落到第一篇」的特例）。
  寫入端經 `nodeMutations`／`domainWriters.ts:78-80`（`get selectedId`／`select`／`clear`）。`setSelectedId` 共 26 個呼叫點、分在 13 個檔案
  （`hooks/useWorkspaceFocus.ts` 6 處最多），沒有人自己維護第二份。
- 散亂處：另有 `openNote`（65 次出現，多為函式參數名）、`activeNode`（`modules/website/WebsiteStudio.tsx:43` 自己的本地狀態，與 `selectedId` 無關）、
  白板的 `activeCanvas`（`appStore.ts`）、`lib/newNoteTarget.ts` 的「新筆記放在」偏好（另一個概念，刻意獨立）。
- 影響：不是 bug，是「同一概念多個名字」；`selectedId` 的 26 個寫入點分散，URL 同步在哪裡發生要跨檔案找（我沒追完）。
- 一句話修法：把 `setSelectedId` 的 26 個呼叫點收成 `navigate.toNote(id)` 一個領域動詞，並統一命名。

### 9. 【低】兩處註解承認的循環 import 與兩個 `eslint-disable`

- 現況：`components/FailedWriteRecovery.tsx:10-11` 與 `lib/share/shareInbox.ts:19-20` 繞過 barrel 直接 import
  `lib/data/sync`、`lib/data/reads`，原因是「經 index 會讓 Rollup 警告跨 chunk 循環」；`lib/data/index.ts:27` 也有「After domainWriters: dayNotes reads lib/spaces, which imports this entry」的順序註解。
  `syncEngine.ts:24` 還 import `../spaces`（`noteMembershipEpoch`，`spaces.ts:79`），而 `lib/spaces.ts:10` 反向 import `./data`。
- 影響：入口邊界出現 2 筆例外（這是整個前端唯一的 module-entry 例外）；循環使得「入口」其實不是純單向。
- 一句話修法：把 `noteMembershipEpoch` 移進 `lib/data`，讓 `spaces` 單向依賴 data。

### 10. 【低】小重複：媒體網址前綴

- `components/OverviewEditor.tsx:372-373` 與 `components/QuickCapture.tsx:91-93` 各自把 `uploadMedia` 回傳網址加上 `getApiBase()` 前綴；
  `uploadMedia`（`lib/data/media.ts:28`）已知道這件事卻沒做。一句話修法：讓 `uploadMedia` 回傳可直接寫進 Markdown 的完整網址。

## 做得好、值得保留

- **`lib/data` 的邊界真的守得住**：元件、hooks、pages 中直接 import `api()`／`apiFetch`／`postRead` 的檔案數為 0（`modules/**` 除外）；
  直接碰本機資料庫 0 處（`eslint.config.js:243-250`）；直接 `new Worker` 只有 1 處；`READS_ALLOWLIST` 是空陣列（`eslint.config.js:37`），沒有被偷偷加例外。
- **三層 lint 分工清楚**：`writes-through-data`、`reads-through-data`、`no-restricted-imports(localDb／setData)`，各自有註解說明為何（`eslint-rules/*.js`）。
- **寫入的「確認」語意被集中處理**：`submitWrite` 註解（`writeQueue.ts:106-107`）寫明「只有伺服器確認或佇列持久化才算完成」；拒絕輸入保存 `preserveDirectRejection`；
  `onlineOperation` 明確區分「已確認但讀結果失敗」（`AfterAcknowledgementError`，`onlineWrite.ts:37`）。
- **後端 `services/sync` 是教科書式的深模組**：12 個匯出、2 個消費者、路由 130 行純薄層、每個入口自己取讀取快照與當前 actor（`withActorReadSnapshot`），
  並有 lint 規則要求出現 `readableNodeIdSet`（`eslint-rules/require-read-gate.js:41-45`）。`MAX_KNOWN_IDS` 超過上限採 fail-closed `resync_required`（`delta.ts:56-65`）。
- **有契約測試**把前後端形狀連起來（問題 2 提到的 `apiContract` 雙邊測試），而且寫了 `EXPECTATIONS` 清單說明前端讀哪些回應。
- **前端模組寫入走資料層**：`modules/**` 20 處直接 API 呼叫全是讀取；37 個 module 檔案的寫入都用 `sendWrite`／`sendOrQueue`。

## 不確定、需要人確認的點

1. **問題 3 是推測**：沒能跑 `eslint --print-config src/lib/data/draftActions.ts` 驗證 `no-restricted-syntax` 是否被覆蓋，請在有 `node_modules` 的環境確認。
2. **`modules/**` 豁免是刻意的嗎？** 設定註解寫「a module owns its own endpoints」，我判斷是產品決定而非疏忽；但 20 處讀取沒有離線退路，請決定這些模組要不要支援離線讀取。
3. **契約測試在 CI 是否每次跑？** 後端的 `apiContract.integration.test.ts` 需要資料庫，本次沒執行；若 CI 跳過，問題 2 的保護就比文字上弱。
4. **記憶體樹與 SQL 兩份 delta 套用是否有逐行對照的測試？** 我只看到 `syncDelta.fuzz.test.ts` 存在，沒驗證它比對的內容。
5. **`sendWrite`（不排隊）的約 20 個呼叫點是否都該是「線上才能做」？** 我沒逐一判斷離線意圖（例如 `lib/navLayoutStore.ts:29`、`lib/sidebarTagsStore.ts:39` 的偏好存檔離線時會丟，可能是刻意的）。
6. **`src/data/`（`exampleNotes.ts`、`starterPacks.ts`、`introSite.ts`）不是資料層**：只是種子內容，被 7 處直接 import；審查範圍列了它，但它與同步無關，我未評分。
7. **`getAppState().data` 的 33 處讀取是否都該用 selector**：問題 7 是推測，沒逐處檢查。
