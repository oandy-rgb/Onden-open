# 提案：核心資料表要有「管家」（節點儲存的所有權）

> 狀態：提案（2026-11-14）。**只寫計畫與一個只准減少的守門測試，不改任何產品程式。**
> 守門：`packages/backend/src/test/guards/nodeStoreOwnership.guard.test.ts`（基準 `nodeStoreOwnership-baseline.json`）。
> 數字都是 2026-11-14 在 `origin/main` 量的，量法在第 2 節；另一個 PR 正在把各處的 `deleted_at IS NULL`／`class_tag` 判斷換成共用 helper，本計畫不碰那些檔案，等它合併後再接。

## 一頁版（給業主）

**現在哪裡不對。** 筆記、屬性、標籤這些核心資料表沒有「管家」：`content_nodes` 有 22 個檔案會寫、138 個檔案會讀（其中 25 個在 `modules/`）；
`node_attributes` 8 寫／55 讀，`node_tags` 5 寫／36 讀，`block_nodes` 7 寫／15 讀。現有的檢查只確認「寫入發生在交易裡」，不管「是誰在寫」。
結果是：每次想改一條規則（例如什麼叫「還活著的筆記」），要改的不是一個地方，而是上百個檔案；新來的人也不知道該不該自己寫一段 SQL。
另外 `db.ts` 把資料庫連線、交易、遷移、領導者鎖、清理事件和「直接寫一筆事件」的 `event()` 全放在一起，有 11 個檔案直接拿 `event()` 來寫事件，繞過 `spine/mutate.ts`；
寫入的入口也有兩個（`mutate(` 88 處、`withEventTransaction(` 93 處），哪些寫入該走哪個沒有明文。

**做完長什麼樣。** 寫核心表的檔案降到「管家」一處加少數有理由的例外（匯入、備份還原、同步）；
讀的人在常見的幾種情形（用 id 取一筆、某筆的子節點、空間裡還活著的筆記、某筆的標籤與屬性）用管家的一小組函式，
報表、搜尋、同步增量這幾種本來就要自己組 SQL 的，留著寫 SQL，但共用同一組「還活著」「讀得到」的片段。使用者看不出差別，行為不變；
改規則時只改管家一處，守門測試保證不會再變多。

**代價。** 不重寫、不換 ORM。是 6 個各自可以單獨合併、行為不變的小 PR，加一個純文件的分類 PR；
每個 PR 的做法是「把一群既有呼叫搬去用管家函式」，每合併一個，守門的數字就降一格。
最大的風險是查詢效能（搬 SQL 時不能讓索引失效）與 pglite 與 Postgres 的行為差異，第 7 節列了怎麼擋。

**順序。** ① 先定義管家的讀取介面（接在另一個 PR 的 helper 之後）→ ② 事件寫入收斂（`event()` 不再外洩）→ ③ 屬性與標籤的寫入 →
④ 節點本身的寫入 → ⑤ 區塊與任務的寫入 → ⑥ 讀取者分批遷移。②③⑤ 可以平行。細節見第 6 節。

## 1. 現況與要保留的東西

- 值得照著做的縫：`spine/mutate.ts`（寫入、權限、事件、交易一起）、`services/readPolicy.ts`（讀取範圍，含集合 SQL）、
  `services/eventRestore`（復原）、`services/sync/delta.ts`（同步增量）。本計畫**沿用並擴充它們，不另起一層**。
- `coreWriteSql.ts` 目前只判斷「這句 SQL 寫了核心表，是否在交易內」。第 6 節 PR 4 之後它可以多檢查「呼叫端是不是登記過的管家」。
- 規則不變：`spine/` 不得 import `services/`（ESLint 擋），所以「寫入管家」要放 `spine/` 底下，「讀取管家」放 `services/`，兩者不互相需要。

## 2. 量測（(a)）

量法：`nodeStoreOwnershipScan.ts` 對 `packages/backend/src` 的產品程式（排除 `test/`、`*.test.ts`、`vendor/`、`dbSchema.generated.ts`）去掉註解後比對 SQL 文字：
寫＝`INSERT INTO`／`UPDATE`／`DELETE FROM`／`MERGE INTO`／`TRUNCATE` 後接表名，或 Kysely 的 `insertInto`／`updateTable`／`deleteFrom`；
讀＝`FROM`／`JOIN` 後接表名，或 Kysely 的 `selectFrom`／各種 `…Join`（`DELETE FROM` 不算讀）。
一個檔案同時讀寫會兩邊都算。看不到的：執行時才組出來的表名（`sqlIdentifier(...)`）。純文字比對，不含型別資訊；數字是上限內的近似，用來比較前後而不是當帳。

| 表 | 寫的檔案 | 讀的檔案 |
|---|---:|---:|
| `content_nodes` | 22 | 138 |
| `node_attributes` | 8 | 55 |
| `node_tags` | 5 | 36 |
| `block_nodes` | 7 | 15 |
| `domain_events` | 2（`db.ts`、`services/purgedContent.ts`） | 42 |
| 直接 import `db.ts` 的 `event()` | 11（含 `spine/mutate.ts`） | — |

其他量測：`services/` 177 個檔案；原始 `q(` 約 803 處、Kysely `db.` 約 165 處（`be-raw-sql` 守門逐檔只減不增，本計畫不改它）。

**誰在寫**（完整清單可用 `npx tsx` 跑 scan 函式取得；以下是依責任分組）：

- `content_nodes`：建立與複製（`noteCreate`、`noteDuplicate`、`templateExpander`）、更新（`nodeUpdate`、`nodes`）、垃圾桶與搬位置（`nodeTrash`、`nodePromote`）、
  標籤節點（`tagIdentity`、`tagMerge`、`tagWrites`、`reservedTags`）、空間與網站設定（`spaces`、`siteConfig`）、白板（`canvasNodes`、`boardWrites`）、
  任務（`tasksStore`）、復原（`eventRestore/restore`、`eventRestore/tags`）、匯入與備份（`importers/notion/database`、`backupRestore`）、
  其他（`blockIdMigration`、`functionRefs`）。
- `node_attributes`：`attributeChange`、`eventRestore/attributes`、`blockNodes`、`boardStore`、`siteConfig`、`standaloneTasks`、`tasksStore`、`importers/shared/identity`。
- `node_tags`：`tagMembership`／`tagMembershipWrites`（已是標籤的主人）、`tagMerge`、`noteDuplicate`、`siteConfig`。
- `block_nodes`：`blockNodes`、`blockChildNote`、`blockIdMigration`、`blockAnchors/store`、`blockAnchors/blockNodeLink`，以及**繞過區塊主人直接更新的** `modules/tasks/blockTasks.ts`、`modules/tasks/placement.ts`。

**誰在讀，依實際需要的形狀分**（以下數字是「138 個 `content_nodes` 讀者」裡含該特徵的檔案數，會重疊）：

| 讀取形狀 | 約略檔案數 | 管家要不要提供 |
|---|---:|---|
| 用 id 或 id 清單取一筆／多筆 | 101 | 要：`getNode`／`getNodes` |
| 限制在工作區與空間（`workspace_id`／`space_id`） | 132／133 | 要：是所有函式的必要參數，不是選項 |
| 只要還活著的（`deleted_at IS NULL`） | 93 | 要：預設行為；另一個 PR 的 helper 是它的 SQL 片段 |
| 某節點的子節點（`parent_id`） | 60 | 要：`childrenOf` |
| 依 `class_tag` 篩類型 | 65 | 要：過濾條件之一 |
| 已套用 `readPolicy` 的可見範圍 | 65 | 沿用 `readPolicy`，管家函式內部呼叫，不再由呼叫端各自組 |
| 帶屬性（`node_attributes` JOIN） | 46 | 要：`attributesOf(nodeIds, keys)`；單一屬性值查找 |
| 帶標籤（`node_tags` JOIN／EXISTS） | 37 | 要：`tagsOfNodes`、`nodesWithTag` |
| 與事件表一起查（歷史、動態） | 27 | 否：留在 `services/history` |
| 垃圾桶內的節點（`deleted_at IS NOT NULL`） | 16 | 要：`retainedNode`（對應 `canReadRetainedNode`） |
| 遞迴取子樹（`WITH RECURSIVE`） | 4 | 要：`subtreeIds` |
| 全文搜尋 | 4 | 否：留在 `services/textSearch.ts`／`nodeSearch` |

`node_attributes` 的讀者形狀主要是兩種：依鍵取值（約 35 檔）、對值做 JSON 比較或篩選（約 20 檔，集中在檢視與篩選）。
`node_tags` 是：某節點的標籤（約 14 檔）、某標籤下的節點（約 14 檔）、`EXISTS` 篩選（約 9 檔）。

## 3. 管家（(b)）——兩種草圖與選擇

**草圖 A：新增一個 `store/` 層**，所有人都經過它讀寫。優點是單一入口；缺點是要為 138 個讀者一次建好完整介面、與 `spine/`、`readPolicy` 重疊、要處理 `spine/` 不得 import `services/` 的方向。**不採用。**

**草圖 B（採用）：沿用現有縫，各補缺口。**

- **寫入管家 `spine/nodeStore.ts`**（新檔，放 `spine/` 因為它是 `mutate` 的內部零件，不依賴 `services/`）。只提供目前寫入者實際做的幾件事，約 10 個：
  `insertNode`、`updateNodeColumns`（白名單欄位）、`moveNode`、`trashNode`／`untrashNode`／`purgeNode`、
  `setAttribute`／`clearAttribute`（沿用完整快照語意）、`linkBlockNode`／`setBlockTask`（區塊與任務的 `block_nodes` 更新）。
  標籤關聯已有 `services/tagMembershipWrites.ts`，本批不動，只把 `tagMerge`、`noteDuplicate`、`siteConfig` 的直接寫入改走它。
  每個函式內部檢查必須在交易內、並沿用 `coreWriteSql`；契約：**只負責「這一列怎麼寫」，不判斷權限、不寫事件**（權限與事件仍由 `mutate`／領域操作負責，避免變成第四種責任）。
- **讀取管家 `services/nodeReads/`**（`services/nodeReads.ts` 已存在，擴充為資料夾或在原檔加函式，PR 1 時決定）：`getNode`、`getNodes`、`childrenOf`、`liveNodesInSpace`、
  `subtreeIds`、`retainedNode`、`tagsOfNodes`、`nodesWithTag`、`attributesOf`、`nodesByAttribute`，約 10 個。每個都吃 `ActorCtx`＋工作區，內部用 `readPolicy`，
  集合型回傳在 SQL 內套範圍（沿用 `readableScopeSql`），**不先全量取出再過濾**。
- **同時提供 SQL 片段**（`liveNodeSql(alias)` 一類，接另一個 PR 的 helper）給「必須自己組 SQL」的讀者，讓它們至少共用「活著」「讀得到」的定義。

**刻意保留原始 SQL 的地方，與理由：**

| 地方 | 理由 |
|---|---|
| 同步增量與啟動（`services/sync/*`） | 有自己的快照與 membership 核對協議（`withReadSnapshot`），形狀與批次大小是為協議調的；`sync/delta.ts` 本身就是被稱讚的縫 |
| 搜尋（`textSearch`、`nodeSearch`） | 依賴 pgroonga／全文索引運算子，已被 `portableBackend` 守門限定在一檔 |
| 檢視與篩選（`collectionViewQuery`、`filter/sqlClauses`） | 使用者可組合的條件，要動態生成 SQL |
| 報表與歷史（`services/history/*`、`dayLens`、`maintenance/prune`） | 事件表與節點表的時間聯結，形狀多樣、各自只用一處 |
| 匯出、備份、還原（`exportZip`、`backup*`） | 整批讀寫，繞過逐筆函式是為了效能，且有自己的完整性檢查 |
| 復原（`eventRestore/*`） | 需要看舊狀態與衝突判斷，由 `restoreEvent` 擁有 |

這些仍列入守門計數，但它們是**最後才處理或永遠留下的「有理由的例外」**；目標值不是 0，是「例外清單明列、其餘走管家」。

## 4. `withEventTransaction` 呼叫者分類（(c)）

93 處呼叫、約 55 個檔案（不含 `spine/`、`db.ts`）。依「是否也寫核心表」交叉：

- **A 類：寫核心表、又手動拿事件鎖，應走 `mutate`（或至少走寫入管家）**，共 21 個檔案：
  `nodeUpdate`、`nodes`、`noteCreate`、`noteDuplicate`、`nodeTrash`、`spaces`、`siteConfig`、`tagIdentity`、`tagMerge`、`tagWrites`、`reservedTags`、`functionRefs`、
  `attributeChange`、`tagMembershipWrites`（本身已是標籤主人，只需確認走管家）、`tasksStore`、`boardStore`、`blockChildNote`、`blockIdMigration`、`blockAnchors/blockNodeLink`、`importers/notion/database`、`tasks/placement`；
  其中 `nodeTrash`、`noteDuplicate`、`spaces`、`siteConfig`、`tagMerge`、`tagWrites`、`reservedTags`、`functionRefs`、`tagIdentity`、`tasksStore`、`notion/database` 同一檔**已經同時用 `mutate`**，
  代表同一個領域裡兩種入口並存，是最先該收斂的（PR 4）。`nodeUpdate` 與 `noteCreate` 是「先取事件鎖再讀、查政策、保存」的既定路徑，只需讓底層寫入走管家，不必改成 `mutate`。
- **B 類：不寫核心表，派生或設定性寫入，保持現狀**（約 34 個檔案）：`external_calendars/store`、`rss/*`、`review/service`、`workspaceTime`、`workspaceModules`、`aiSetup`、`embeddings`、`media`、`ownerTransfer`、
  `agentSessionStore`、`agentSessions`、`dispatcherQueue`、`tagPacks`、`tagViews`、`noteViews`、`tasks/create|focus|scheduler|update` 等。它們用鎖是為了讓事件序號跟狀態同交易，沒有繞過權限；
  只要它們不碰核心表就不納入本計畫。注意 `tasks/*` 與 `rss/*` 雖不直接寫核心表，卻透過別的服務寫，改動時看被呼叫的服務是否已遷移。
- **C 類：沒有 `mutate` 也沒有 `withEventTransaction` 的核心寫入者**（12 個）：`backupRestore`、`canvasNodes`、`eventRestore/restore`、`eventRestore/tags`、`nodePromote`、`importers/shared/identity`、`blockNodes`、
  `eventRestore/attributes`、`standaloneTasks`、`tagMembership`、`modules/tasks/blockTasks`、`blockAnchors/store`。這些由呼叫者的交易承擔，要逐一確認呼叫鏈：`eventRestore/*` 與 `backupRestore` 是有意由 `restoreEvent` 或還原流程擁有，
  `blockNodes`／`blockAnchors/store` 是「由某次儲存派生」（已列在 `spineEventGate` 的 cascade／audit 類）；`blockTasks`、`standaloneTasks`、`canvasNodes`、`nodePromote` 需要先查清呼叫鏈再分類（PR 0 的工作）。

分類本身是文件工作（PR 0）；本提案**不**要求把 B 類改成 `mutate`。

## 5. `db.ts` 與任務 SQL 片段（(d)）

**`event()`。** `spineEventGate.test.ts` 已有一份「誰可以直接用 `event()`」的允許清單並要求寫理由，這是好的；缺的是**數量只准減少**（新守門 `rawEventImporters` 基準 11，含 `spine/mutate.ts`）。處理方式：

1. 把 `event()` 搬到 `spine/eventAppend.ts`，`db.ts` 不再匯出它（`db.ts` 的 `insertEvent` 用到 `q`、`afterCommit`、`notifyChanged`，搬時只動 import）。
2. 10 個外部呼叫者各自歸類：`agentSessionStore`、`adminAccounts`、`dispatcherQueue`、`agentTools/registry`（system／audit，保留但改走一個具名的 `appendSystemEvent`／`appendAuditEvent`）；
   `attributeWrites`、`nodeUpdate`、`blockNodes`、`blockAnchors/store`、`tagPacks`、`website/publishing/snapshot`（衍生或外部，逐一確認能否用 `mutate` 的 cascade／external 選項）。
3. 完成後 `db.ts` 只剩連線、交易、遷移、領導者鎖、清理事件；677 行再拆成「連線與交易」與「遷移與維運」兩檔，**只在前兩步完成後做**，避免為拆而拆。

**任務 SQL 片段。** `services/tasksStore.ts` 匯出 `TASK_JOIN_SQL`／`TASK_COLUMNS_SQL`／`TASK_HOST_LIVE_WHERE`，被 `modules/tasks/agenda.ts`、`pushReminders.ts`、`scheduler.ts`、`services/dayLens.ts` 使用；
`blockTasks.ts` 與 `placement.ts` 直接 `UPDATE block_nodes`。處理方式：片段留在 `tasksStore`（agenda 的 SQL 與 `taskBucket` 規則由 `taskBucketRule.integration.test.ts` 對齊，不能拆散），
但**命名並限制使用者**（`tasksStore` 匯出一個 `taskRowsSql(...)` 或在 `owners.ts` 登記這四個使用者）；`block_nodes.task_id` 的更新改成寫入管家的 `setBlockTask`（PR 5）。

## 6. 分階段 PR（(e)）

每個 PR 都：行為不變、不改權限政策、單獨可合併、通過既有測試與 `scripts/guard-lane.sh`，並把守門基準降低。
規模（S＜200 行、M 200–600、L＞600 行含測試）與風險為估計，不是承諾。

| # | 內容 | 降低的數字 | 規模／風險 | 可平行 |
|---|---|---|---|---|
| 0 | 本 PR：計畫＋守門 | 設基準 | S／無 | — |
| 1 | 讀取管家：定義 `nodeReads` 的函式與 SQL 片段（接另一個 PR 的 helper）；遷移 3–5 個最簡單的 `modules/` 讀者當範例（`daily`、`rss/items`、`rss/fetch`） | `content_nodes.readers` 約 −5 | M／低；風險在索引（第 7 節） | 在另一個 PR 合併後；之後與 2、3 可平行 |
| 2 | `event()` 搬出 `db.ts`，外部呼叫者改走具名的 system／audit 函式 | `rawEventImporters` 11 → 約 3 | M／中（事件順序與鎖不能變）；需事件回滾與冪等測試 | 與 1、3 平行 |
| 3 | 屬性與標籤寫入收斂：`tagMerge`、`noteDuplicate`、`siteConfig` 改走 `tagMembershipWrites`；`node_attributes` 寫入集中到 `attributeChange`（`boardStore`、`standaloneTasks`、`tasksStore`、`siteConfig` 改呼叫它） | `node_attributes.writers` 8 → 約 3；`node_tags.writers` 5 → 2 | M／中（屬性是完整快照，`null` 表示不存在） | 與 1、2 平行 |
| 4 | 節點寫入管家 `spine/nodeStore.ts`＋遷移 A 類中同檔已用 `mutate` 的 11 個檔案 | `content_nodes.writers` 22 → 約 12 | L／中高；每個領域逐檔遷，一個 PR 一個領域也可 | 在 3 之後 |
| 5 | 區塊與任務：`blockTasks`、`placement` 的 `UPDATE block_nodes` 改走 `setBlockTask`；`blockChildNote`、`blockIdMigration` 的 `block_nodes` 寫入改走區塊主人（`blockNodes`） | `block_nodes.writers` 7 → 約 2 | S–M／低 | 與 2、3 平行 |
| 6a–6n | 讀者分批遷移：`modules/website`（9）、`modules/tasks`（7）、`modules/rss`（5）、`agentTools`、`canvas*`、`block*`……每批只遷同一類形狀 | `content_nodes.readers` 逐批降 | 每批 S–M／低 | 彼此平行 |
| 7 | `coreWriteSql` 加「寫入者必須是登記的主人」，把 `owners.ts` 風格的允許清單套到寫核心表 | 把基準從「數量」變成「名單」 | S／低（等前面完成後） | 最後 |

不做：把 C 類的 `eventRestore/*`、`backupRestore`、同步相關檔案硬塞進管家；它們有自己的擁有者，列為有理由的例外。

## 7. 風險（(f)）

- **查詢效能與索引。** 現有 SQL 多半是為某個索引調過的（例如 `(workspace_id, space_id, parent_id)` 上的活節點掃描）。管家函式必須保持同一個 WHERE 形狀；
  每個遷移 PR 要附 `EXPLAIN` 前後比對（取代的那條查詢），遇到 `ANY($1)` 批次改成逐筆查詢的情形不准通過。`getNodes(ids)` 一律用單一 `= ANY`。
  「以效能為由改設計要先量測」的規則在這裡反過來用：不量測就不准改形狀。
- **pglite 與 Postgres。** 兩者都要跑：管家函式用 `q()`／Kysely（共用交易），不用只有其中一邊有的函式；`jsonb` 運算與 `WITH RECURSIVE` 在 pglite 上的行為要有測試。
  `portableBackend` 守門已限制 `process`／Node 內建與 pgroonga 的位置，管家不得新增例外。
- **關著的 `distributedSync`。** `distributedSync/bridge/*` 目前讀 `content_nodes`、`node_tags`、`domain_events`（共 4 個讀者、`capture`／`replica` 讀事件表）。
  它關著所以現在不遷移也不新增檔案；但寫入管家改變列的寫法時（例如欄位白名單），`bridge/capture` 看到的事件與列必須一致，
  `decisions-core-sync.md` 提到 `materialize` 會重算內文，改合併相關行為前先重讀。它的讀者計數留在基準內，等啟用時再處理。
- **同步協議。** 同步增量靠 `membership_epoch`、事件游標與 `withReadSnapshot`；管家不得在快照內開 `pool.query`、不得改變寫入與事件的同交易關係。
  凡動到寫入的 PR 都要驗證：撤權後重連、事件回滾後游標不前進。
- **守門本身的限制。** 計數是純文字比對：換表名寫法、動態組表名看不到；一個檔案從「寫」變「讀」不會被抓到。
  它防的是「更多檔案直接碰這些表」，不是證明遷移正確；正確性仍靠各領域的整合測試。

## 8. 如何使用守門

`npx vitest run src/test/guards/nodeStoreOwnership`（約 1 秒，已在 `scripts/guard-lane.sh` 的「backend guards」內）。某個計數**變大**就失敗；**變小不會失敗**
（否則同時開著的 PR 會互相卡住），但請順手把 `nodeStoreOwnership-baseline.json` 對應的數字降下來，這樣進度才留得住。
基準檔屬於 `npm run ratchet:check` 的對象，數字調高會被擋，除非 commit 訊息帶 `ratchet-override`。
基準量的是當時的 `origin/main`；多個 PR 同時進行時，後合併的 PR 要先合併最新 main、重跑 `npx tsx` 掃描（或直接看失敗訊息的實際數字）再更新基準。

## 9. 管家做出來之前，新功能需要直接讀寫核心表怎麼辦

管家（第 3 節）還不存在，守門不能擋住正常工作。暫行規則，依序：

1. **放進已經做同一件事的既有檔**，不開新檔：節點本身 → `services/nodes.ts`／`nodeUpdate.ts`／`nodeReads.ts`；
   屬性 → `services/attributeChange.ts`／`nodeAttributes.ts`；標籤關聯 → `tagMembershipWrites.ts`／`tagReads.ts`；區塊與任務 → `blockNodes.ts`／`tasksStore.ts`；
   事件 → 一律走 `spine/mutate.ts`，不要新增 `db.ts` `event()` 的使用者（沒有例外，除非加進 `spineEventGate.test.ts` 的允許清單並寫理由）。
   在既有檔加查詢不會讓計數變大。
2. **新檔真的比較合理**（例如新功能模組自己的查詢）：把基準對應數字加上新檔案數，並在 commit 訊息加一行
   `ratchet-override: <為什麼需要新的直接讀／寫者，以及為何不能放進既有檔>`；PR 說明寫同樣的理由。這是正常、被允許的路，只是要留下紀錄，之後遷移批次會把它收回來。
3. **寫入**另外必須走 `mutate`／`withEventTransaction`（第 4 節），這不因守門而改變。

守門失敗訊息也寫了同樣的兩步。
