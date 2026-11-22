# 提案：版本歷史跟著同步走（一台壞掉，舊版本還在）

> 狀態：提案（2026-11-22；第 10 節八題業主已於 2026-11-22 決定；第 1 批已做（#1938），其餘還沒做）。**只寫文件，不含程式、測試、migration。** 沒有在正式伺服器量任何數字（第 2.4 節列出要量的唯讀查詢）。
> 完成後：歸檔
> 上層文件：[節點同步](node-sync-channels-2026-11-14.md)（§5 歷史要跟著走、§8、§9 第 9 項）、[加入裝置的快照](add-device-snapshot-2026-11-15.md)（快照的分層、§10 第 6 題）、
> [合併核心與修改包](../../../packages/backend/src/spine/stampedMerge/README.md)（同步引擎的規格；也讀了 PR #1907 的分支 `origin/fix/merge-space-follows-parent` 上的版本）、
> [同步的信任界線](../../decisions/sync-trust-line.md)、[備份與搬移](../backup-move.md)（備份格式 3）、[內文合併以歷史為主](body-history-merge-2026-11-14.md)（§5、§9）。
> 不依據已被取代的 [第一版分散式同步](../distributed-sync.md)（`ds_ops`）。
> **修訂（2026-11-22，第 1 輪審查，PR #1935 的留言）**：十一點全部查證屬實並改進本文；逐點的對照在第 12 節。主要改動：每個版本只由一台鑄一次（第 2.2 節）、歷史的數字追內容（第 3.3 節）、身分與這台的紀錄分開（第 2.5 節）。
> **修訂（2026-11-22，第 2 輪審查）**：審查的結論是「第 1 批可以派」；它列出的十二點性質寫進新的第 4.4 節，第 4.1、8、9 節跟著改。其中一處改變了第 1 輪的做法：版本改由程式鑄，資料庫在提交時檢查有沒有漏（第 4.1 節），因為觸發器沒辦法安全地存內容。對照在第 12 節。
> 標記：**【讀到】**＝我在程式或文件裡看到（附 `檔案:行`）；**【推論】**＝我由此推出、沒執行；**【沒量】**＝要在正式機或測試裡量。

## 0. 結論（先看這裡）

1. **今天的情形，查證後成立，有兩處要更正。** 伺服器壞掉、只剩一台用快照加入的裝置時，每則筆記的版本清單都是空的；手寫的舊版本沒了；「連同一起刪除的一起還原」只剩被點的那一則，其他的要一則一則還原。
   兩處更正：
   - 「一起刪除的」不是共用同一個事件編號。每個子筆記各有自己的刪除事件，用 `triggered_by_event_id` 串到最上面那一則的刪除。
   - 手寫的**目前**內容會跟著走（它是有標記的屬性列），丟掉的只有舊版本。
2. **新增一張複製的表 `note_versions`**：一列是一個版本，內文與手寫共用這張表。表裡只放身分與說明，內容照舊放在 `blobs`、`ink_manifests`、`ink_chunks`，用雜湊指名。
   - **每個版本只由一台鑄一次，別台照抄**，所以身分每台都一樣。新的版本用（筆記、內容種類、寫入那筆交易的來源標記：來源節點＋序號＋這筆交易裡的第幾次）指名。今天已有的版本（每一個都是）用內容算出的固定編號。基準版本只由工作區最初的那台鑄。
   - 版本一旦寫下就不再改，所以合併規則只有一條：**每台握有的版本集合＝所有節點的聯集**，不會有衝突。
3. **快照帶全部歷史**，不只帶一個基準版本、其餘等用到再抓。順序照 2026-11-15 第 6 題：先送筆記，裝置可以開始用；歷史隨後送完，畫面顯示還剩多少。
   只帶基準版本、其餘晚點抓的話，伺服器在加入後隔天壞掉，那些舊版本就永遠沒了，違反業主 2026-11-19 的目標。
4. **修改包也帶版本，走同一個接收入口與同一份 `sync_origins.have` 紀錄**，但歷史要佔**另一個標籤的數字**，不和列的數字取最小值。
   原因很具體：一台剛加入、歷史還沒收完的裝置，列已經完整，歷史還沒有。如果兩者共用一個數字，它轉送修改包時會讓第三台誤以為已經收到全部歷史（第 3.3 節）。
   歷史的數字只在**內容**也到齊、驗過之後才前進。
5. **收到的版本不重新產生。** 版本由寫入的程式鑄，資料庫在提交時檢查：每一筆改到內文或手寫的本機寫入都有版本，不管有沒有事件。合併與匯入時不鑄、也不檢查，收的那台照身分存下，不另鑄一份。
   - 合併時算出、兩邊都沒寫過的新內文，是一個作者為「合併」的版本，身分由各個頭、基底、規則版本與結果算出。
   - 衝突中輸掉的值是一個**頭**，同時也是一個版本，因為寫它的那台存過它。
   - 本機衝突時被放到一邊的內容（被蓋掉的畫、要讓人拿回的字），另記成「放到一邊」的版本。
6. **版本清單、回到某一天、還原舊版、段落歷史、手寫歷史，都改讀 `note_versions`。**
   - 排序用寫入時的邏輯時鐘；舊版本用原始時間。
   - 顯示的時間是寫的那台記下的時間。另一台做的版本加註「在另一台裝置上」。
   - 操作紀錄（事件）仍然各台各自保存，照 2026-11-14 的決定。
7. **一定要一起改的地方：清理。** `prune.ts` 今天判斷「沒有事件引用就刪」。收到的版本在收的那台沒有任何事件，照現在的規則會被當成孤兒刪掉。今天沒有東西自動跑它，所以風險是潛在的，但第 1 批就要改。
8. **「一起刪除的」改用每台都有的事實判斷**：最上面那則筆記與子筆記的「已刪除」欄位，是不是同一個寫入標記（同一筆交易＝同一個序號）。
   在有標記之前刪除的，由記下它的那台在遷移時寫一份很小、同樣會複製的分組紀錄。
9. **分八批，每批一個 PR**（第 9 節）。**第 1 批已做（#1938）**，另外還欠一小批 1b：復原手寫事件也鑄版本。#1907 與 #1939 已合併，所以第 1–5 批都不必再等它們；第 6 批等 2b-2b，第 7 批等第 4 批，第 8 批等第 2 批。
10. 第 10 節的八題，業主 2026-11-22 回覆「都按建議 不行之後改」：全部照建議。另外決定標籤說明也要有版本歷史，排在第 8 批。

---

## 1. 今天：哪裡存著歷史、誰寫、誰讀、會不會跟著走

### 1.1 逐表

| 存的東西 | 表 | 誰寫 | 誰讀 | 快照 | 修改包 | 備份 |
| --- | --- | --- | --- | --- | --- | --- |
| **內文版本**：帶 `body_hash` 的 `NODE_CREATED`／`NODE_UPDATED`／`NODE_RESTORED` 事件 | `domain_events`（`001_baseline.sql:85-95`；`body_hash`、`base_hash` 是 migration 162 加的：`162_event_body_hash_base.sql:15-16`；`device_id` 是 187 加的：`187_domain_events_device_id.sql:6`） | 所有事件都從 `db.ts:742-766` 這一處寫入：一般編輯 `nodeUpdate.ts:466-487`、建立 `noteCreate.ts:169,201`、複製 `noteDuplicate.ts:133-142`、範本 `templateExpander.ts:135-149`、Notion 匯入 `importers/notion/database.ts:414-427`、事件復原 `eventRestore/restore.ts:811-830`、還原舊版 `nodeUpdate.ts:167-197`。唯一不經 `db.ts` 的是備份帶進來的歷史：`spine/importedHistory.ts:106-111` | 「哪些事件算一次存檔」只有一個定義：`history/bodyEvents.ts:20-25`。其他讀者見 1.2 | **不帶**：快照只讀列，「從不讀 structure_log 或 domain_events」（`services/stampedSnapshot.ts:27-30`）；歷史層直接拒絕（`:134`） | **不帶**：`domain_events` 是 node-local（`spine/syncClasses.json:176-178`），修改包只讀 `UNIT_SOURCES` 的單位（`spine/stampedBundle.ts:1-10`） | 格式 3 帶，但要勾選，而且只有「搬整個工作區」進**新**工作區時會讀（`backupHistory.ts:1-9`、`backupRestore.ts:1000-1003`、`:790-797`） |
| **內文本身** | `blobs`（`030_blob_layer.sql:26-31`：hash、content、size_bytes、created_at） | `services/blobs.ts:29-38` `putBlob`：在**另一條連線**上寫，事件提交之前就寫下；另一處是 `importedHistory.ts:103` | `history/bodyEvents.ts:97-101` `bodiesByHash`；版本清單直接 join（`noteVersions.ts:190-198`） | 不帶；加入的那台還必須是空的（`snapshotTables.json:14` 檢查 `rows_of_blobs`） | 不帶（`syncClasses.json:256-258`：「每台要不要各存一份，上線後再決定」） | 格式 3 把內文寫進每一行（`backupHistory.ts:66-93`） |
| **手寫的舊版本**：`ink_data`／`board_ink`／`note_ink` 的 `ATTRIBUTE_SET`／`ATTRIBUTE_DELETED` 事件，payload 只帶 `value_ref` | `domain_events`；內容放在 `blobs`（小於 192 K 字元），或 `ink_manifests`＋`ink_chunks`（`203_ink_chunks.sql:13-36`，兩張表的主鍵都是 `(node_id, hash)`） | `attributeChange.ts:212-224` 寫事件；`eventLog/attributeSnapshot.ts:36-40` 依大小選 `putBlob` 或 `putInkChunks`（`inkChunks.ts:35-52`）；門檻 `inkChunks.ts:20`，每塊約 8 KB（`inkChunker.ts:4-8`） | `nodeReads.ts:16-33` 列出最新 50 筆；`history/inkChanges.ts:29-48,143-158`；路由 `routes/nodes.ts:291`（清單）、`:677`（還原，用事件編號）；手寫存檔的定義在 `bodyEvents.ts:52-59` | 不帶 | 不帶（`syncClasses.json:260-266`：上線後再決定） | 不帶（`docs/agents/decisions-canvas.md:121`） |
| **手寫的目前內容** | `node_attributes.value`，整份直接存在列裡；這張表沒有 `value_ref` 欄位 | 屬性寫入 | 畫面 | **帶**（有標記的列） | **帶**（有標記的單位） | 帶 |
| **「一起刪除的」** | `content_nodes.deleted_by_event_id`，指向本機的 `NODE_DELETED` 事件（`033_soft_delete_nodes.sql:51`）；子筆記用 `triggered_by_event_id` 串到上層的刪除 | `nodeTrash.ts:457-461` `markTrashed`；串接在 `trashLive`（`nodeTrash.ts:112-117`） | `nodeTrash.ts:80-108` `restorePlan`（事件 join 兩次）；`eventRestore/restore.ts:533,613-616`；畫面文字在 `i18n.zh-TW.late.ts:2437` | **不帶**（`snapshotTables.json:133` 的 `exclude`） | 不帶；跟著走的只有 `deleted_at`（`stampedMerge/dbUnits.ts:167`） | 不帶，只帶 `deleted_at`（`backupArchive.ts:9-13`） |
| **位置、標籤、空間成員的變化** | `structure_log`（`190_sync_stamps.sql:10,53-68`） | 標記觸發器（`190_sync_stamps.sql:216-240`、`194_stamps_s2.sql:21`、`199_stamps_s3.sql:26`）；合併時寫收到的那一行（`stampedMerge/dbRows.ts:158-170`） | **沒有產品程式讀它**，只有測試（`test/helpers/structureReplay.ts`） | 不帶（`stampedSnapshot.ts:30`） | 不帶（`stampedBundle.ts:21`、`syncClasses.json:236-238`） | 不帶 |
| **操作紀錄**（復原、AI 執行、審閱） | `domain_events` 的其他事件 | 每個領域操作 | 歷史頁、復原、AI 執行清單、日子視角 | 不帶 | 不帶 | 不帶（`backupWorkspaceMove.ts:154-159` 一律列為「沒搬」） |

### 1.2 內文版本的讀者（之後全部要改讀新表）

| 讀者 | 檔案 | 排序依據 | 用本機事件編號的地方 |
| --- | --- | --- | --- |
| 版本清單 `GET /api/nodes/:id/versions` | `routes/nodes.ts:274-279` → `history/noteVersions.ts:190-198`（`raw`）、`:207-281`（合併後） | `created_at`，相同時再比 `id` | 每一列的 `id` 就是事件編號（`:191`、`:268`）；「還原自」靠 `payload.version_id` 找（`:213-215`） |
| 還原某一版 | 前端 `useVersionRestore.ts:17-29` → `noteHistoryWriter.ts:21-22` → `routes/nodes.ts:325` → `nodeUpdate.ts:167-197` | — | 只收數字編號（`:176`）；用 `e.id = $1::bigint` 找（`:177-181`） |
| 段落歷史 | `BlockHistorySheet.tsx:44` → `?raw=1`（`lib/data/reads.ts:92`）；最多 50 筆（`lib/history/blockHistory.ts:13-25`） | 照伺服器順序 | 同版本清單 |
| 回到某一天 | `routes/history.ts:139,147` → `history/pointInTime.ts:79-94` | `created_at` | — |
| 倒回（rewind） | `history/rewind.ts:68-103,185-196,321-328` | 狀態用 `created_at`；一步一步退回用 `id` | `id` |
| 日子視角、最近的版本 | `dayLens.ts:103-151`、`history/recentVersions.ts:17-31` | `created_at` | — |
| 備份匯出 | `backupHistory.ts:66-93` | `(created_at, id)` | 每個版本的 `id` |

作者怎麼顯示：
- 伺服器只送作者種類與名稱，不送 id（`noteVersions.ts:201-203`）。
- 工作階段寫的不顯示名字（`authorName.ts:29-42`）。
- 前端顯示「你」「AI」「自動」「臨時工作階段」或名字（`lib/history/historyAuthor.ts:20-26`）。
- **裝置從來不顯示**；後端也不讀 `device_id`，只有寫入時用到（`db.ts:765`）。

### 1.3 逐條查證

| 說法 | 結果 | 證據 |
| --- | --- | --- |
| 快照與修改包都不帶 `domain_events` 與 `blobs` | **成立** | 見 1.1；快照的 `history`／`blobs` 兩層已經留了名字但拒絕（`stampedSnapshot.ts:53,134`） |
| 加入時不寫基準版本 | **成立** | `markJoinDone`（`spine/stampedImport.ts:440-470`）不寫任何事件。註解說的「baseline」是 migration 202 的起始程序替結構寫的起始行（`202_stamps_genesis.sql:303,319`），不是內文版本 |
| 收到修改包的那台，不為收到的修改記下領域事件 | **成立**，已用預期失敗的測試釘住 | `test/stampedBundle.integration.test.ts:603`（`it.fails("domain events (note-96 B3)…")`），比對 `:572` 那個查詢 |
| 手寫的版本歷史沒了 | **成立，要補一句** | 舊版本只存在事件與 blobs／塊裡，三者都不帶。**目前**的那一份會帶（`node_attributes` 是有標記的表，`syncClasses.json` 的 `node_attributes`） |
| 「連同一起刪除的一起還原」沒了 | **成立，要更正機制** | 子筆記**不共用**上層的事件編號，各有自己的 `NODE_DELETED`，用 `triggered_by_event_id` 串起來（`nodeTrash.ts:84-104,112-117`）。在加入的那台 `deleted_by_event_id` 是空的（快照排除它），所以 `restorePlan` 的 join 找不到子筆記，子筆記只能一則一則還原【推論，由 SQL 讀出】 |
| 版本清單會是空的 | **成立** | 清單只讀 `domain_events`（`noteVersions.ts:190-198`）；加入的那台沒有任何存檔事件（`stampedImport.ts` 的匯入入口不寫事件，`:1-10`） |
| （新增）清理會把收到的版本刪掉 | **之後的設計必須處理** | `maintenance/prune.ts:12-19,31-47`：沒有事件引用的 blob 都刪。今天沒有任何呼叫者（檔頭說是操作者手動執行），但規則本身會刪掉複製來的版本 |
| （第 1 輪審查補）有寫內文、事件卻沒有 `body_hash` 的寫入 | 成立 | 帶內容建立任務（`services/tasksStore.ts:327-331` 寫 `markdown`，`:484-500` 的 `NODE_CREATED` 沒有 `body_hash`）、週期任務滾下一筆（`modules/tasks/scheduler.ts:150-171`）。今天它們不在版本清單裡；第 4.1 節的設計涵蓋它們 |
| （新增）事件清理不會刪掉存檔 | 成立 | 帶 `body_hash` 的事件一律不能刪（`052_append_only_by_body_hash.sql:24-27`）；`pruneEvents` 預設不開，而且跳過帶 `body_hash` 或 `value_ref` 的事件（`db.ts:572-594`、`server.ts:59-66`） |

---

## 2. 一個被複製的版本長什麼樣

### 2.1 兩種設計

| | 甲（採用）：新表 `note_versions`，內文與手寫共用 | 乙：沿用 `domain_events`，把事件改成會複製 |
| --- | --- | --- |
| 和已定的決定相不相容 | 相容：「操作紀錄（事件）仍然不外傳」（節點同步 §5，`node-sync-channels-2026-11-14.md:59`） | 違反這條；不然就要把事件拆成「會傳的」與「不會傳的」兩種，也就是兩本帳 |
| 身分 | 每台相同（2.2） | 事件編號是各台自己的 bigserial，兩台不同（`001_baseline.sql:85`） |
| 讀者要改多少 | 1.2 的七個讀者改讀一張表。日子視角裡算「AI 的工作」的部分仍讀事件 | 不用改讀者，但每個讀者都要先分清楚本機事件和複製來的事件 |
| 代價 | 寫入時多寫一列；舊資料要遷移（第 8 節） | 復原、審閱收件匣、AI 執行清單都會看到別台的事件，要逐一排除；備份格式 3 已經為了這個把作者改寫成 `user`（`importedHistory.ts:10-13`） |

**甲**：本機寫入的那筆交易同時寫事件（本機的帳）與版本（會複製的事實）。事件可以用 `version_key` 指到它記下的版本；反過來，版本裡不放事件編號。

### 2.2 版本的身分

`note_versions` 的鍵是（工作區、`note_id`、`unit`、`version_key`）。`unit` 是 `body`、`ink_data`、`board_ink` 或 `note_ink`。

**一條總規則（審查第 1 輪第 1、2、9 點）**：
- 每個版本**只由一台鑄造一次**，別台只複製，從不自己重算。
- 所以「每台相同」不靠各台各自算出同樣的東西，只靠「複製的就是原樣」。
- 能讓兩台**各自**算出版本的情形只有一種：合併結果 `m:`，所以它的鍵含所有會影響結果的輸入。

`version_key` 有五種寫法：

| 種類 | `version_key` | 誰鑄造 | 為什麼唯一、為什麼每台相同 |
| --- | --- | --- | --- |
| **寫入**（第 1 批之後所有本機的存檔） | `s:<來源節點>:<序號>:<第幾次>` | 寫的那台，在寫入的同一筆交易，由第 4.1 節的 `recordVersion` 鑄 | 序號是這筆交易的標記序號。巢狀的 `mutate` 沿用第一個標記（`spine/mutate.ts:96,122`、`spine/stamps.ts:101-108`），連鎖還原也在父層的交易裡跑子還原（`services/eventRestore/restore.ts:307-323`），所以一筆交易裡同一則筆記、同一個 unit 可以被寫兩次以上。**`<第幾次>`** 是這筆交易裡對（筆記、unit）的第幾次寫入，從 1 起，照寫入的先後給，也存在 `ordinal` 欄（第 2.3 節）。鑄的只有寫的那台，別台照抄，所以每台相同 |
| **舊版本**（遷移前的每一個，正式機上的全部） | `g:<sha256("onden version 1" ＋ note_id、unit、種類、內容雜湊、標題、原始時間（微秒）各自帶長度前綴)>`（編碼見 4.4 第 9 點） | **記下那個事件的那台**，在遷移時算一次 | 由內容算，所以同一份資料庫的兩份拷貝（例如用 pg_dump 還原出來的）算出同一個鍵，聯集之後不重複（非鍵欄位怎麼辦見 2.5）。同一則筆記同一微秒、同一標題、同一內容的兩次存檔會變成一個版本；這種版本在畫面上本來就分不出來 |
| **遷移之後才從備份帶進來的版本** | 同 `g:` 的算法 | 做還原的那台 | 傳送位置用**那筆還原交易的標記序號**（`importedHistory.ts:106-111` 在還原的交易裡跑；交易沒有標記時，先取一個）（審查第 7 點） |
| **基準**：一則筆記目前的內容，在**整個工作區的歷史**裡沒有任何版本指到 | `b:<sha256(note_id ‖ unit ‖ 內容雜湊)>`；`at`＝鑄造時那則筆記的 `updated_at` | **只有歷史的根**，也就是沒有 `sync_join` 紀錄的那台（工作區最初的那台）。它在遷移時鑄一次，之後跟著歷史走。用快照加入的節點**從不鑄 `b:`**（審查第 1 點） | 加入的那台沒有事件，要是它也鑄，就會替來源已經有 `g:`／`s:` 的內容再多一個身分。今天加入的節點都是空的時候加入的（`stampedImport.ts:1-26`），它握有的每一份內容都是根已經握有的，所以由根鑄就夠了 |
| **合併的結果**（第 6 批，2b-2b 把合併結果存下來之後才有） | `m:<sha256(排序後的各頭標記 ‖ 基底內容雜湊 ‖ 合併規則版本 ‖ 結果內容雜湊)>` | 每台握有那些頭時自己算 | `resolveBody` 的結果還取決於呼叫端給的基底與規則版本（`spine/stampedMerge/body.ts:1-13,29-45`），所以三者都進鍵，結果的雜湊也進鍵（審查第 5 點）。`merged` 與 `conflict` 兩種都產生沒人寫過的字，都是 `m:` 版本；`needs-decision` 不產生新字，不鑄。兩台用不同基底算出不同的字時，得到的是**兩個不同的版本**，不會相撞 |

另外有一種不是新鍵、而是新種類的版本：**被放到一邊的內容**（審查第 10 點，第 4.1 節）。它用的是寫入的 `s:` 鍵，種類記為 `set_aside`。

為什麼不用「筆記 id＋內文那個單位的標記（來源＋序號）＋內文雜湊」：
- 只改標題的存檔也是一個版本（`nodeUpdate.ts:464-467`），可是它不動內文單位。
- 內文單位在 `sync_stamps` 只留最新的一筆標記，比它早的寫入沒有標記可指。
- 所以用的是**那筆交易**的標記，而不是單位的標記。
- 內容雜湊當成欄位放著，並且要檢查：同一個 `version_key` 卻帶著不同雜湊，整包拒收（`history_version_clash`），和 `bundle_stamp_clash` 一樣的處理。

### 2.3 欄位

| 欄位 | 內容 | 規則 |
| --- | --- | --- |
| `kind` | `created`／`updated`／`restored`／`merged`／`baseline`／`set_aside`；手寫多一個 `removed`（整份移除） | 和備份格式 3 同一組字，加上新的 |
| `title` | 存檔當時的標題；手寫是 null | — |
| `content_hash` | 內文：`blobs.hash`。手寫：整份值的 sha256，也就是今天的 `value_ref`；它存在 `blobs`，或存在 `ink_manifests`（`203_ink_chunks.sql:24-36`） | 刪除的版本是 null |
| `at` | 寫的那台記下的時間，存成微秒文字 | 格式沿用 `importedHistory.ts:46` 的 `IMPORTED_AT` |
| `clock_wall`、`clock_counter` | 那筆交易的邏輯時鐘；舊版本是 null | 排序用（第 5 節） |
| `ordinal` | 同一個時間點裡的先後。`s:`：`<第幾次>`。`g:`：這則筆記、這個 unit 的事件依 `(created_at, id)` 排的名次（4.4 第 3 點） | 鑄的那台決定，別台照抄 |
| `recorded_by` | 鑄造它的節點 id | 只拿來判斷「另一台」；**裝置 id（`device_id`）不離開那台**。這是這台的紀錄，不是身分（2.5） |
| `author_kind` | `person`／`ai`／`automatic`／`session`／`merge` | 工作階段、AI、背景工作都只留種類 |
| `author_id` | 只有 `person` 而且是工作區的人才填 | 人的 `actors` 列本來就跟著快照走（`syncClasses.json` 的 `actors`：`identity`）；工作階段的 id 不離開那台（[信任界線](../../decisions/sync-trust-line.md)第二層、`carriedActorId`） |
| `restored_from` | 被還原的那一版的 `version_key` | 必須是同一則筆記、同一個 unit 的版本；收的時候還沒到可以先存下，畫面顯示「還原自較早的一版」 |
| `source_name` | 只給從備份帶進來的版本：來源寫的作者名稱 | 照 `importedHistory.ts:109`。「這是備份帶進來的」本身是本機的事，不複製 |

手寫的單位是**整份畫**，就是一個屬性鍵。理由：
- 它是有標記的那一個單位（`node_attributes` 每個（筆記、鍵）一個單位）。
- 今天的事件與還原都以整份為單位（`inkChanges.ts:143-158`）。
- 依頁、依塊切開會變成和寫入的單位不同的第二種身分。

塊只是**傳送與儲存**的單位：內容雜湊指到 manifest，manifest 指到塊（每個 32 bytes，`203_ink_chunks.sql:29`）。所以重複的塊不用再傳。

**migration 172 之前的 `ink_data` 事件，`unit` 寫哪一個**（審查第 4 點）：
- 它屬於白板還是手寫頁，今天是讀的時候才判斷：看 `board_ink_moves`（`services/history/bodyEvents.ts:44-58`）。
- 那張表的分類是「未定」（`syncClasses.json:313-315`），而且搬動被復原之後，判斷會翻過來。
- **遷移時照那一刻的判斷寫死**：用同一個 `inkEventSql` 決定 `unit`，寫進版本，之後不再改。版本本來就不再改，別台照抄，所以每台顯示在同一個地方。
- 代價：遷移之後才復原 172 的搬動，舊版本**不會**跟著搬回手寫頁。第 1 批要在 PR 說明寫出這件事。今天正式機有幾筆這種搬動，用第 2.4 節的查詢 8 數。

### 2.4 大小：程式與測試裡量得到的，以及正式機要量的

【讀到】已經量過的數字：
- 一筆筆畫約 2.0 KB；1,000 筆的值約 1.8 MB（`docs/research/pdf-ink-save-measure-2026-11-15.md:27`）。
- 每次存檔上傳約 6.5 KB（同檔 `:20-24`）。
- 1,000 筆、969 個版本的歷史：`ink_chunks` 42.7 MB、`ink_manifests` 14.2 MB、`blobs` 2.1 MB，合計約 64 MB，也就是一筆筆畫約 64 KB 的歷史（同檔 `:33-41`）。
- 5,000 筆那一輪沒跑完（`:46`）。
- 內文沒有量過版本總量。備份裡版本歷史超過 200 MB 時預設不帶（[備份與搬移](../backup-move.md)）；歷史檔的上限是 1 GB（`backupFile.ts:65`）。

【沒量】正式機。操作者可以照下面執行：只回數字，一律在 `BEGIN READ ONLY` 裡跑，不印 id 與內容。
備份已經有一個只回數字的端點 `GET /api/backup/history-size`（`routes/backup.ts:59`），可以先用它。

```sql
BEGIN READ ONLY;
-- 1 內文版本：幾個、幾則筆記有、單篇最多幾個
SELECT count(*) AS versions, count(DISTINCT target_id) AS notes FROM domain_events
 WHERE event_type IN ('NODE_CREATED','NODE_UPDATED','NODE_RESTORED') AND payload ? 'body_hash';
SELECT max(n) AS most_versions_one_note FROM (SELECT count(*) n FROM domain_events
 WHERE event_type IN ('NODE_CREATED','NODE_UPDATED','NODE_RESTORED') AND payload ? 'body_hash' GROUP BY target_id) x;
-- 2 內文的內容：不重複的 blob 幾個、共幾 bytes
SELECT count(*) AS blobs, coalesce(sum(size_bytes),0) AS bytes FROM blobs b
 WHERE EXISTS (SELECT 1 FROM domain_events e WHERE coalesce(e.body_hash, e.payload->>'body_hash') = b.hash);
-- 2b 內容已經不在的存檔事件：不鑄版本，只數（4.4 第 2 點）
SELECT count(*) AS saves_without_text FROM domain_events e
 WHERE e.event_type IN ('NODE_CREATED','NODE_UPDATED','NODE_RESTORED') AND e.payload ? 'body_hash'
   AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.hash = coalesce(e.body_hash, e.payload->>'body_hash'));
-- 3 單篇筆記的內文歷史最大幾 bytes（重複的內容算多次，是傳送的上限）
SELECT max(s) AS largest_note_history_bytes FROM (SELECT sum(b.size_bytes) s FROM domain_events e JOIN blobs b ON b.hash = e.payload->>'body_hash'
 WHERE e.event_type IN ('NODE_CREATED','NODE_UPDATED','NODE_RESTORED') GROUP BY e.target_id) x;
-- 4 手寫版本：幾個；不切塊的 blob 幾 bytes；塊與清單
SELECT count(*) AS ink_versions FROM domain_events WHERE event_type IN ('ATTRIBUTE_SET','ATTRIBUTE_DELETED') AND payload->>'key' IN ('ink_data','board_ink','note_ink');
SELECT count(*) AS ink_blobs, coalesce(sum(size_bytes),0) AS bytes FROM blobs b
 WHERE EXISTS (SELECT 1 FROM domain_events e WHERE e.payload->>'value_ref' = b.hash AND e.payload->>'key' IN ('ink_data','board_ink','note_ink'));
SELECT count(*) AS chunks, coalesce(sum(size_bytes),0) AS bytes FROM ink_chunks;
SELECT count(*) AS manifests, coalesce(sum(size_bytes),0) AS bytes FROM ink_manifests;
SELECT max(s) AS largest_note_ink_chunk_bytes FROM (SELECT sum(size_bytes) s FROM ink_chunks GROUP BY node_id) x;
-- 5 會變成基準版本的筆記數（目前的內文沒有任何存檔指到它）
SELECT count(*) AS notes_without_own_version FROM content_nodes n WHERE NOT EXISTS (
 SELECT 1 FROM domain_events e WHERE e.target_id = n.id::text AND e.payload->>'body_hash' = encode(sha256(convert_to(n.markdown,'UTF8')),'hex'));
-- 6 垃圾桶：幾則、幾次刪除（「一起刪除的」分組數）
SELECT count(*) AS trashed, count(DISTINCT deleted_by_event_id) AS deletes FROM content_nodes WHERE deleted_at IS NOT NULL;
-- 7 會變成手寫基準的畫（目前的值沒有任何手寫事件指到它；例如 172 搬動時沒寫事件的）
SELECT count(*) AS drawings_without_own_version FROM node_attributes a WHERE a.key IN ('ink_data','board_ink','note_ink') AND NOT EXISTS (
 SELECT 1 FROM domain_events e WHERE e.target_id = a.node_id::text AND e.payload->>'key' = a.key
   AND e.payload->>'value_ref' = encode(sha256(convert_to(a.value,'UTF8')),'hex'));
-- 8 migration 172 的搬動：幾則筆記被搬過、幾則之後被復原（第 2.3 節）
SELECT count(*) FILTER (WHERE action = 'moved') AS moved, count(*) FILTER (WHERE restored_at IS NOT NULL) AS moved_back FROM board_ink_moves;
-- 9 寫了內文、卻沒有帶 body_hash 的事件的筆記（任務）：第 4.1 節要補的版本
SELECT count(*) AS notes_with_unversioned_body FROM content_nodes n WHERE n.markdown <> '' AND NOT EXISTS (
 SELECT 1 FROM domain_events e WHERE e.target_id = n.id::text AND e.payload ? 'body_hash');
ROLLBACK;
```

第 7 句的 `node_attributes` 欄位名（`node_id`、`key`、`value`）以 `db/schema.sql:546-558` 為準，執行前再對一次。

**手寫清單（manifest）的總量大約是畫的筆畫數的平方**【推論】（審查第 11 點）：
- 每個版本的 manifest 和那時整份畫的大小成正比（每 8 KB 一個 32 bytes 的雜湊，`inkChunker.ts:4-6`）。
- 版本數又和筆畫數成正比，所以總量約和筆畫數的平方成正比。
- 1,000 筆、969 個版本是 14.2 MB（`pdf-ink-save-measure-2026-11-15.md:33-41`），推到 5,000 筆約 25 倍，也就是約 300–360 MB。
- 第 10 節第 4 題的門檻要用「塊＋清單」的總量來量，不能只量塊。

`body_hash` 欄只在 migration 162 之後的事件才有，之前的只在 payload 裡（`162_event_body_hash_base.sql:8-9`），所以一律寫 `coalesce(e.body_hash, e.payload->>'body_hash')`，和 `db.ts:750` 同一種寫法（審查第 2 輪第 8 點）。

第 5 句的雜湊算法，要先確認和 `putBlob` 一樣是對 UTF-8 算 sha256【推論，由 `utils.ts` 的 `sha256Hex` 推出】。

### 2.5 哪些欄位是身分，哪些是這台的紀錄（審查第 9 點）

| | 欄位 | 規則 |
| --- | --- | --- |
| **身分**（進摘要、兩台要相同；同一個鍵而這些不同＝`history_version_clash`，整包拒收） | `note_id`、`unit`、`version_key`、`content_hash`、`kind`、`title`、`at`（`b:` 除外）、`clock_wall`、`clock_counter`、`author_kind`、`author_id`、`restored_from` | 都由鑄造的那台決定，別台照抄。`g:` 的這些欄位都由事件算出，所以 pg_dump 拷貝算出的也相同 |
| **這台的紀錄**（不進摘要、不比對、不拒收） | `recorded_by`；`b:` 的 `at`（第 4.3 節）；**傳送位置**（來源、序號）的集合 `note_version_positions` | 同一個 `g:` 在原本那台與它的 pg_dump 拷貝上，會有不同的 `recorded_by` 與不同的 s0。收的那台把收到時帶著的**每一個**位置都記下（集合，只增不減）；送的時候，任何一個位置落在範圍內就送。`recorded_by` 留第一個收到的 |

為什麼位置要記成集合：
- 反例（只記一個位置時）：E 先從 Y 收到 g（位置 Y），F 先從 X 收到 g（位置 X）。
- D 從 F 拿 Y 的範圍、從 E 拿 X 的範圍，兩個數字都越過了 g，D 卻沒有收到它。
- 記成集合之後：F 的 Y 數字越過 g 的時候，一定收過 Y 範圍裡的 g，所以 F 也記下位置 Y，送給 D 的時候就會帶上【推論，第 4 批的性質測試要涵蓋】。

---

## 3. 版本怎麼傳

### 3.1 快照：全部歷史，分層送

快照今天只有 `rows` 這一層，`history`、`blobs` 兩層名字已經留好但會拒絕（`stampedSnapshot.ts:53,134`）。
[加入裝置的快照](add-device-snapshot-2026-11-15.md)排好的順序是：①筆記列 → ②內容（依雜湊）→ ③其餘版本歷史，每層可以分開續傳（`:233`）。

| | A（建議）：全部歷史 | B：基準版本＋用到再抓 |
| --- | --- | --- |
| 加入時送什麼 | 每個版本（第 2.3 節的欄位）＋它們指到的每份內容 | 每則筆記目前的那一版；其他版本在有人打開清單時，才向來源要 |
| 大小 | 版本列：每列約 0.3 KB【推論】×版本數。內容：第 2.4 節第 2、4 句的總和（不重複的 blob＋塊＋清單） | 只有目前的內容，本來就在筆記列裡 |
| **伺服器在加入隔天壞掉** | 新裝置握有全部歷史；只會缺「加入完成到伺服器壞掉之間」還沒傳完的部分。畫面一直顯示還剩多少，第 3.5 節 | **沒打開過的筆記，舊版本永遠沒了** |
| 和業主決定 | 符合 2026-11-19「任何一台壞掉，資料和歷史都不會丟」；也符合 2026-11-15 第 6 題「筆記先到，新裝置先能用」 | 違反 2026-11-19；而且要一直有一台可以抓的來源，等於依賴外部 |

**業主的目標推出來的答案是 A。** B 只在「歷史大到某些裝置放不下」時才有意義，那是第 10 節第 4 題，不是預設。

送的方式：
- 版本列跟筆記列用同一種頁（`StampedPage` 的 `layer: "history"`），一樣在同一個唯讀快照讀，一樣有摘要（`spine/snapshotSql.ts` 的 `computeSnapshotDigest` 加上 `note_versions`）。
- 內容另成 `blobs` 層，依雜湊送。

接收的那台 `markJoinDone` 的條件**不變**：筆記列到齊就算加入完成，裝置可以開始用。
歷史另外記一個狀態：`sync_join` 加 `history_through`（收到第幾頁）與 `history_done`。歷史收完、摘要相同，才把歷史標籤的數字寫成來源的切點（第 3.3 節）。

### 3.2 修改包：同一個入口，帶上這段期間的版本

- 修改包裡多一種項目 `{kind: "version", …}`。讀包的那一端在**同一個唯讀快照**裡讀版本，條件是：每個來源 o，版本有一個傳送位置（2.5）的來源是 o、序號落在 (`historyBase[o]`, `historyHolds[o]`] 之間。`g:`、`b:` 的位置是記下它的那台的 s0（第 8 節）。
  - 因為版本和它那筆寫入的標記同一筆交易提交、序號相同，第 2b-1 批證明過的「切點不會漏」照樣成立（`stampedBundle.ts:12-17`）【推論：要用 `stampedBundleCut.integration.test.ts` 那種兩條連線的測試再證一次】。
  - 被後來的寫入蓋掉的內文，它的標記不在 `sync_stamps`。版本列還留著序號，所以**中間的每一個版本都會送**，不只最新的。
- 接收只走 `applyChangeBundle`（`spine/stampedImport.ts:703`），不另開入口。版本在同一筆交易裡「沒有就寫入」，不需要合併。
- 合併的結果（`m:`）：只要有一包送了它那則筆記的列，就跟著那包送。理由見第 4.2 節。

### 3.3 歷史為什麼要佔另一個數字

`sync_origins.have` 本來就是「每個標籤一個數字」（`206_sync_change_bundles.sql:6-12`）。**#1939（2026-11-22 合併，migration 222，`SYNC_DATA_SHAPE_VERSION` 升到 6）之後，請求的 `have` 與包頭的 `base`／`upTo`／`holds` 也都是每個標籤、每個來源各一個數字**（`spine/stampedBundle.ts:1-12,46`），不再取最小值送出去。

**只用同一個數字會錯**（具體情形）：
1. C 用快照從伺服器 S 加入。筆記列完成、歷史還在傳，C 的 `have[S]` 已經是切點。
2. C 和第三台 D 交換。C 轉送 S 的修改時，D 的 `have[S]` 跟著前進。
3. D 從此不會再要 S 在切點之前的版本，可是 C 也沒有那些版本。
4. S 壞掉之後，D 永遠缺那一段。

**做法**：
- 歷史是另一個標籤 `note_versions`。因為 #1939 之後請求與包頭本來就是每個標籤各一個數字，**不需要另一份請求格式**：下面寫的 `historyHave`／`historyHolds`／`historyBase`，就是 `have`／`holds`／`base` 在 `note_versions` 這個標籤上的那一個數字。
- 它和其他標籤不同的只有：前進的規則看內容（下面），而且要排除在「一次把每個標籤寫成同一個數字」的地方之外。自己的來源握有到 `next_seq - 1`，條件同樣是內容都在。
- 收的人只把歷史的數字推進到 `historyHolds`，所以歷史收不完全的那台，只能把別人推進到它自己有的地方。
- 平常兩個數字相同，只有在加入的那段空檔，或內容還沒到齊時不同。
- 信任界線的要求「來源自己報的數字不得高於它實際送來的」（`sync-trust-line.md:37`）照樣適用：`historyHolds[o]` 不得高於 `holds[o]`。

**數字追的是內容，不只是列**（審查第 6 點）。不然第 3.4 節「列先到、內容後到」會把同一個洞推到下一層：C 把 D 的數字推過去之後 S 壞掉，兩台都列得出那個版本，卻都還原不了。所以：
- **不變條件**：一台的歷史數字越過某個版本 ⇒ 這台握有它的內容，而且雜湊驗過（內文 blob；手寫的 manifest 與它指到的每一塊）。
- 送的人的 `historyHolds[o]`＝最大的 n，使得每一個位置在 o、序號 ≤ n 的版本，內容這台都握有。缺內容的版本照樣可以當列送出，但數字停在它前面。
- 快照的 `history_done` 與歷史層的摘要都**涵蓋內容**（每個版本的內容雜湊都在這台、驗過），不只是 `note_versions` 的列數。
- 第 3.5 節的「這台有別處沒有的舊版本」提醒，也照這個數字算，所以不會在內容還沒傳完時讓人放心。
- **已經加入的節點，歷史數字從 0 開始**，不從 `have` 抄：到第 4 批時 `have[S]` 早已超過第 1–3 批寫下的 `s:`，從 `have` 抄就會永遠不再要那些版本。
- 寫 `have` 的地方今天會把**每一個**標籤都寫成同一個數字（`spine/stampedBundle.ts:113` 的 `haveOfAll`，用在 `spine/stampedImport.ts:536,541`）。新標籤要從 `CARRIED_LABELS` 與 `haveOfAll` 排除，只由歷史那一段寫。

**收斂**：版本一旦寫下就不再改，身分唯一，收的時候「沒有才寫」。所以每台的版本集合是只增不減的集合，最後一定等於所有節點的聯集；沒有衝突，也沒有順序問題。
要證明的性質（第 9 節）：任何到達順序、任何重送之後，每台的 `version_key` 集合都等於所有節點寫過的聯集。

### 3.4 內容依雜湊傳

| 項目 | 規則 |
| --- | --- |
| 去重 | 內文：`blobs.hash` 是全域的，收的時候「沒有才寫」。手寫：塊的鍵是（筆記、雜湊）（`203_ink_chunks.sql:13-22`），只傳那則筆記還沒有的塊 |
| 怎麼送 | 修改包裡，**內文直接附上**：通常很小，而且最新一版本來就在列的值裡。**手寫的 manifest 附上，塊另外依雜湊取**：一份 PDF 的值可以到 30 MB（`pdf-ink-save-measure-2026-11-15.md:20-24`），不能塞進 4 MiB 一頁的包（`stampedBundle.ts` 的 `PAGE_BYTES`）。快照的 `blobs` 層也走同一條取的路 |
| 先到列、後到內容 | 版本列可以比內容先到。內容還沒到的版本照樣列在清單上，標成「還在從另一台複製」，不能還原；到了之後才能用。這只是缺東西、不是錯誤，可以續傳 |
| 續傳 | 以雜湊為單位：中斷之後，問「這些雜湊我還缺哪些」。已經寫下的不再要 |
| 收件檢查（信任界線第一層） | 內文：sha256 和它說的雜湊一樣（`importedHistory.ts:75` 已有同樣的檢查）。塊：sha256(內容)＝鍵；組回來的整份值，sha256 要等於 manifest 的雜湊 |
| 大小上限 | 一份內文最多和筆記的上限相同；一塊最多 64 KB（`inkChunker.ts:8`）；manifest 的長度必須是 32 的倍數 |
| 版本指到的筆記 | 必須在收的那台、在範圍內：活著，或在垃圾桶。指到這台已經永久刪除的筆記（握有它的墓碑）：不存、記在回報。指到這台從沒見過的筆記：整包拒收（`history_unknown_note`） |
| `restored_from` | 必須是同一則筆記、同一個 unit |
| 時間 | `at` 必須是合法時間（`isImportedAt`）；`clock_wall` 適用和標記一樣的時鐘超前上限（`stamps.ts` 的 `FOREIGN_CLOCK_BOUND_MS`） |
| 作者 | `author_kind` 只有五個值；`author_id` 只能是那個工作區、種類為人的 actor。是工作階段就拒收（第二層） |

任何一項不合，**整包拒收、什麼都不寫**，和現有的修改包拒收規則一樣。
這份檢查的程式要和信任界線列出的其他收件檢查放在一起（`dbUnits.ts` 那種 `check`）。

### 3.5 畫面上怎麼說

- 加入完成、歷史還沒收完：設定的裝置頁顯示「舊版本還在複製（還有 N 個）」。版本清單最上面一行寫「較早的版本還在從另一台複製」。
- 一台裝置握有別處沒有的版本時（它的歷史數字高於每一個已知節點從它收到的）：要移除或重設那台裝置前，先提醒「這台裝置上有其他裝置還沒有的舊版本」（`node-sync-channels-2026-11-14.md:63`）。

---

## 4. 本機寫入：誰產生版本，收的那台怎麼得到同一個

### 4.1 寫的那台

**性質**（審查第 3 點）：每一筆讓內文或手寫變成新值的本機寫入都留下一個版本；守門從「寫 `content_nodes.markdown`／`title` 與手寫屬性的地方」數，不從事件數。

第一版寫的是「在 `db.ts` 寫事件的那一處產生」，這個做法**有反例**：
- 帶內容建立任務時，`services/tasksStore.ts:327-331` 寫了 `markdown`，可是 `:484-500` 的 `NODE_CREATED` 沒有 `body_hash`。
- 週期任務滾出下一筆也一樣（`modules/tasks/scheduler.ts:150-171`）。
- 第 1 批之後，在 A 建的任務內文要是被 B 勝出的寫入蓋掉，那段字就不在任何一台的任何版本裡。

三種設計比較（第 1 輪改成甲；第 2 輪審查第 1 點指出甲的內容沒有人存，改採丙）：

| | 甲：觸發器鑄版本 | 乙：在 `db.ts` 寫事件處鑄 | 丙（採用）：程式鑄版本，資料庫在提交時檢查 |
| --- | --- | --- | --- |
| 涵蓋 | 每一筆改到內文、標題或手寫值的寫入 | 只有帶 `body_hash` 的事件；任務是反例 | 和甲相同：每一筆改到內文、標題或手寫值的本機寫入，提交時都要找得到它的版本，找不到就讓**那筆交易失敗**。所以漏掉的寫入點在測試裡就會紅，不會在正式機默默少一個版本 |
| 內容由誰存 | **沒有人**：觸發器裡寫 `blobs` 會撞上 `services/blobs.ts:15-28` 說的鎖與死結（所以 `putBlob` 才在另一條連線上寫） | 寫事件的那一方已經 `putBlob` | 程式在寫入**之前**照今天的方式 `putBlob`／`putInkChunks`（另一條連線），再鑄版本 |
| 手寫的雜湊 | 每存一筆就在 SQL 裡對整個值（1.8–30 MB）算一次 sha256，SQL 也不能分塊 | 已經由 `encodeSnapshot` 算好（`eventLog/attributeSnapshot.ts:36-40`） | 同乙：沿用已經算好的 `value_ref`，**不多算一次** |
| 作者 | 只有標記的 `author`；略過標記的寫入沒有作者（`schema.sql:4078-4081` 的 `bypass`），`system` 又把 AI、工作階段、系統混在一起（`stamps.ts:112`） | 事件的 `actor_type` | 程式手上有 `ActorCtx`，作者種類照 `actors.type` 推出 |
| 「還原自哪一版」 | 要靠交易內的設定，而且每次寫完要重設 | 直接可得 | 直接當參數傳，沒有要重設的全域狀態 |

**丙的做法**（第 1 批）：
- 一個入口 `recordVersion(tx, { note, unit, contentHash, kind, title, restoredFrom })`，放在新的 `services/history/versions.ts`。
- 它取這筆交易的標記與 `<第幾次>`（同一筆交易對同一個（筆記、unit）已經有幾個 `s:`，加一），寫 `note_versions`，並寫這台的對照 `note_version_events`（見 4.4 第 4 點）。
- 每個會寫內文、標題或手寫值的地方都呼叫它。
  - 經過 `updateNode`／`createNote`／`setNodeAttribute` 的，呼叫在那幾個入口裡，只有一處。
  - 直接寫的：`tasksStore.ts:327-331`、`setTaskTitleTx`（`:363-366`）、`canvasNodes.ts:24-27`。第 1 批把它們改成先 `putBlob` 再呼叫入口。
- **資料庫的檢查**：一個在提交時跑的觸發器（`DEFERRABLE INITIALLY DEFERRED` 的 constraint trigger），掛在 `content_nodes` 的 `title`／`markdown` 變更與手寫屬性的變更上。
  - 它在提交時確認：這筆交易的每一個改變，都有一個 `note_versions` 列的 `content_hash` 等於現在的值，而且內容找得到（`blobs`，或 `ink_manifests`）。
  - 內容不在：交易失敗。漏鑄版本：**第 1 批做成的是計數**（`sync_clock.version_misses`，開機時記一行），不是失敗；見第 9 節第 1 批「和本文不同的地方」。
  - 跳過的情形見 4.4 第 5、6、11 點。
- **每次存檔多出的成本**（4.4 第 1 點）：程式這邊不多算任何雜湊。
  - 內文：`putBlob` 今天就算。手寫：`value_ref` 今天就算。
  - 多的是：一列 `note_versions`、一列 `note_version_events`、`note_version_positions` 一列，加上提交時每個改到的列一次按鍵查詢。
  - 和改到幾則筆記成正比，與內容大小無關。
  - 第 1 批要量：在 `stampedBundleScale` 那種資料規模下，一次 `updateNode` 前後的時間與寫的列數。

- 備份帶進來的歷史另外寫（`importedHistory.ts:106-111`），身分是 `g:`，位置是那筆還原交易的序號（第 2.2 節）。
- **被放到一邊的內容也是版本**（審查第 10 點；我的判斷和審查的傾向相同：被蓋掉、而且某個人寫過的內容，就是一個版本）：
  - 手寫：`ATTRIBUTE_CONFLICT` 裡被蓋掉的那份畫，今天只有本機事件引用（`services/attributeWrites.ts:253-272`）。
  - 內文：`BODY_CONFLICT` 留下、要讓人拿回的另一位寫的人的字（`services/nodeUpdate.ts:400-410` 的註解；它存在哪裡要在第 1 批查清楚【推論】）。
  - 兩者都在寫衝突紀錄的同一筆交易裡另寫一列 `set_aside` 版本（同一個 `s:` 序號、下一個 `<第幾次>`），作者是被蓋掉的那一位的種類。
  - 這兩段字都從沒寫進 `content_nodes`，所以觸發器看不到，要明寫。
  - 第 1 批的守門要列出這兩處。

### 4.2 收的那台

- 收的那台**不產生**任何版本：合併時觸發器讓開（`stamps.ts:160`，`reason: "merge"`），而收包不寫事件與衍生資料（`stampedImport.ts:697-702` 的檔頭註解）。所以第 1.3 節釘住的那個預期失敗**本來就應該這樣**。
- **要釘住這件事**（審查第 8 點）：2b-2b 做衍生資料時，如果收包改走 `updateNode`，觸發器就不讓開，會多鑄一份版本。第 1 批加一個守門：收包的路徑（`applyChangeBundle` 與它呼叫的一切）不呼叫 `updateNode`／`createNote`；另加一個兩節點測試：收一包之後，收的那台的 `note_versions` 只多了包裡帶的那些。
- 第 7 批要把它改成兩個一般的測試：「收的那台不記下事件」（照 2026-11-14 的決定）與「收的那台有同樣的版本」。
- **合併出一份沒人寫過的內文**（2b-2b 把 `resolveBody` 的 `merged` 存下來之後，`spine/stampedMerge/body.ts:1-6`）：每台握有同樣的頭，就算出同樣的文字和同一個 `m:` 身分，作者種類 `merge`。
- 握有頭的那台自己記下它；只收到後來寫入的那台，也會從那一包拿到它（第 3.2 節）。理由【推論，第 6 批要用性質測試證明】：
  - 會產生那個後來寫入的那台，畫面上顯示的是合併後的文字，所以它握有 `m:`。
  - 那個寫入會讓列被送出，`m:` 就跟著走。
  - 沒收到任何後來寫入的那台，必須自己握有那些頭才能顯示內文，於是自己算得出 `m:`。
- **衝突中輸掉的值**：它是一個頭，留在 `sync_stamp_heads`，跟著修改包走（`node-sync-channels-2026-11-14.md:60`）。它也是一個版本，因為寫它的那台存檔時寫下了 `s:` 版本。所以不另外記。
- 「衝突」是目前狀態的事，「版本」是歷史的事。頭被下一個人的存檔解決之後，版本還在。
- 「要人決定」（沒有共同基底、`needs-decision`）時不產生新版本，兩邊的文字都已經是版本了。

### 4.3 加入時的基準版本

帶全部歷史（3.1 的 A），所以**加入本身不寫版本**；新裝置拿到的就是來源握有的那一組。

基準版本（`b:`）**只由歷史的根鑄**，在遷移時補上「目前的內容沒有任何版本指到」的筆記與畫（第 2.4 節查詢 5、7）。根是沒有 `sync_join` 紀錄的那一台。
第一版寫「每台各自算、算出同一個」是錯的（審查第 1 點）：
- 來源 S 有事件，內容 T 已經有 `g:`／`s:`。
- 用快照加入的 C 沒有事件，遷移時會替每則筆記鑄一個 `b:(N, body, T)`。
- 聯集之後，每則筆記多出一筆「最早留下的樣子」，內容其實是已經有的版本。
- 而且各台遷移的時間不同，C 抓的是它那時握有的字。

**反例檢查**（改之前替新做法找的）：
- 加入的那台在加入之後、遷移之前自己寫過內文：那些寫入有本機事件，遷移時成為它自己的 `g:`，不需要 `b:`。
- 加入的那台握有、根卻沒有的內容：只能來自修改包，可是今天 `routes/` 裡沒有任何路由呼叫 `readChangeBundle`／`applyChangeBundle`（2026-11-22 在 main 89abe4666 上 grep），所以沒有這種內容。等第 4 批接上傳輸時，所有新內容都經 `recordVersion` 有 `s:`。
- #1939 之後，加入的節點也能當快照的來源（`routes/stampedSnapshot.ts:19-21`）。從它加入的第三台也有 `sync_join` 列，所以也不是根，也不鑄 `b:`。
- 根被還原（pg_dump）：拷貝也是根，會鑄出同樣的 `b:` 鍵（只由筆記、unit、內容算）；`at` 可能不同，這是身分欄位的衝突。所以 `b:` 的 `at` 改成**不進身分**：顯示時一律寫「最早留下的樣子」，不寫時間。2.5 的表要把 `b:` 的 `at` 列為這台的紀錄。

### 4.4 第 1 批必須守住的性質（第 2 輪審查）

審查的結論是第 1 批可以派。下面十二點是那一批的完成條件：每一點寫出性質、做法與要附的測試。實作照這一節與 PR #1935 第 2 輪的留言。migration 放在 `packages/backend/db/migrations`。

1. **內容一定找得到，成本有上界。**
   - 性質：提交時，每一列 `s:`／`b:` 的 `content_hash` 都指到已經存好的內容。
   - 做法：第 4.1 節的丙。程式先 `putBlob`／`putInkChunks`，再 `recordVersion`；提交時的檢查也驗內容在不在。
   - `b:` 由遷移寫，內容在同一個 migration 裡從 `content_nodes`／`node_attributes` 寫進 `blobs`／`ink_manifests`。遷移時沒有並行的寫入，不會有第 4.1 節說的死結。
   - 成本：第 4.1 節的「每次存檔多出的成本」，要量出數字。
2. **內容已經不在的舊存檔不鑄。**
   - 今天的清單用 inner join 略過它們（`services/history/noteVersions.ts:193`、`bodyEvents.ts:97-101`）。
   - 要是鑄了，它會永遠「還在複製」，而且照第 3.3 節讓歷史的數字永遠停住。
   - 遷移跳過它們，預覽用查詢 2b 數出來，PR 說明寫出數目。
3. **遷移後的順序不變。**
   - 事件的 `created_at` 預設是交易開始的 `now()`（`schema.sql:423`），所以同一筆交易的事件時間相同（例如連鎖還原），今天靠 `id` 分先後。
   - 性質：一則筆記的 `g:` 版本，在每一份複本上都維持它們在記下那台的 `(created_at, id)` 順序。
   - 做法：`ordinal` 存這則筆記、這個 unit 的名次（第 2.3 節），排序把它放在鍵之前（第 5 節）。
   - 測試：同一筆交易裡兩次存檔，遷移後在新清單裡的先後與舊清單相同。第 2 批的逐列比對也靠這一點。
4. **舊資料的「還原自」與事件對照。**
   - `NODE_RESTORED` 帶的是被還原的那一版（`payload.version_id`）；事件復原帶的是被復原的**事件**（`tx_meta.restored_from`），不是版本（`noteVersions.ts:213-215`）。
   - `domain_events` 不能更新（`schema.sql:159`），所以對照另放一張**這台自己的**表 `note_version_events(event_id, note_id, unit, version_key)`：不複製，`syncClasses.json` 分類為 node-local。
   - 遷移時：`payload.version_id` 經這張表換成那一版的鍵。事件復原的 `restored_from`，換成「被復原的事件**之前**那一個版本」的鍵，條件是它的內容等於這次寫回的內容；不相等就留空。
   - 第 2 批的數字網址也查這張表。
5. **合併與加入時不鑄、不檢查。**
   - 合併與加入時，`sync_stamp_trigger` 照樣在跑，只有 `sync_stamp_put*` 會提早返回（`schema.sql:5274`）；`sync_stamp_current` 回的是佔位的來源 `merge`／`import`、序號 0（`spine/stamps.ts:158-162`）。
   - 所以 `recordVersion` 與提交時的檢查都要自己看 `sync_import_active`：是的話，前者拒絕，後者跳過。
   - 測試：快照加入之後版本數是 0；收一包之後，只多了包裡帶的。
6. **範圍：沒動過的空殼什麼都沒有。**
   - `content_nodes` 的標記觸發器對每一種節點都跑（`schema.sql:4839-4850`）：標籤、系統筆記、空殼的列都算。
   - 版本只給有內文版本清單的那些節點種類，第 1 批照今天會寫帶 `body_hash` 事件的節點種類列出，並加守門。基準 `b:` 也只給這些種類，而且只給內容不是空字串的。
   - 啟動的種子與空殼（`ensureShellWorkspace`，`db.ts:471-475`）不呼叫 `recordVersion`。它的寫入以交易內的設定 `onden.no_versions` 標明，提交時的檢查跳過。否則空殼會有 `s:<加入者>` 的版本與 blob，`rows_of_blobs`（`snapshotTables.json:14`）不為 0，加入就會被拒。
   - 性質與測試：沒動過的空殼有 0 個版本、0 個 blob；加入的節點不握有不是自己寫的版本。
7. **「根」是每個工作區各自的。**
   - `sync_join` 的主鍵是工作區（`schema.sql:5123-5126`）。
   - 定義：對工作區 W，這台沒有 W 的 `sync_join` 列，它就是 W 的根。
   - 正式站：沒有列，是根。
   - 用 pg_dump 還原出來的根：連 `sync_join` 一起還原，仍然沒有列，是根；它鑄的 `b:` 鍵和原本那台相同（第 4.3 節）。
   - 搬整個工作區、或還原到新工作區：新的工作區 id，沒有列，是那個工作區的根。帶進來的歷史是那個工作區自己的 `g:`。
   - 遷移時某個工作區正在 `joining`：**當成加入的節點**，什麼都不鑄。加入之後完成，就照加入的規則；被取消，`cancelJoin` 會重建空殼，空殼照第 6 點也沒有版本。
8. **預覽的算術**：見第 8 節最後一段。用同一個算鍵的函式 `count(DISTINCT 鍵)`；查詢 2 用 `coalesce(body_hash, payload->>'body_hash')`。
9. **`g:` 鍵的編碼，SQL 與 JS 一致。**
   - 遷移用 SQL 算；之後的匯入在 `spine/importedHistory.ts` 用 JS 算。
   - 編碼：每個欄位寫成 `<UTF-8 位元組數>:<內容>`，空值寫成 `-`，欄位依第 2.2 節的順序直接接起來。時間是 UTC 微秒文字 `YYYY-MM-DDTHH:MM:SS.ffffffZ`（`importedHistory.ts:46`）。前面加上 `onden version 1`，再算 sha256 的十六進位。
   - 測試：同一組輸入（含空標題、空雜湊、非 ASCII 標題、同一微秒），SQL 與 JS 算出同一個鍵。
10. **守門數的是什麼，作者怎麼來。**
    - 還原成**相同內容**時，今天仍寫一個帶 `body_hash` 的事件（`restore.ts:811`），可是內容沒變，所以沒有新版本。
    - 守門數的是「**改變了值**的寫入」，不是事件：每一個改變值的寫入剛好一個版本；內容沒變的存檔事件在 `note_version_events` 指到既有的那一版。
    - 作者由程式的 `ActorCtx` 依 `actors.type` 推出，不用標記的 `system` 旗標。「還原自」是參數，沒有要重設的設定（第 4.1 節的表）。
11. **資料 migration 不鑄版本。**
    - 改寫標題的資料 migration（先例：`193_remove_citations_module.sql:94-97`）在每台各自執行，要是鑄了，就會在每台各鑄一個不同的 `s:`。
    - 規則：`migrate()` 在每個 migration 的交易內設定 `onden.no_versions`，提交時的檢查跳過，也沒有程式呼叫 `recordVersion`。這條寫進 [migrations.md](../../agents/migrations.md) 的規則（第 1 批）。
12. **接受的限制：** 根在第 3–4 批做完之前壞掉時，加入的那台沒有 `b:`，也沒有根的歷史，每則筆記第一次修改之前的字沒有版本。這和今天一樣，不會更差。

第 2 輪審查也沒有查的，第 1 批要量、要測：
- 15,000 個事件的規模下，遷移要多久、鎖住什麼。
- 遷移重跑是冪等的：s0 只在真的插入了列時才取，重跑不再取。

---

## 5. 讀者

| 讀者 | 改成 |
| --- | --- |
| 版本清單、段落歷史（`noteVersions.ts`、`?raw=1`） | 讀 `note_versions`＋內容；回應的 `id` 換成 `version_key`。合併成一列（同一作者 5 分鐘內）的規則不變，只把「同一作者」換成（`author_kind`、`author_id`、`recorded_by`） |
| 還原某一版（`nodeUpdate.ts:167-197`） | 用 `version_key` 找。還原本身是一個新的寫入，依目前的權限執行，產生新的版本，`restored_from` 指回去（[復原寫入](../restore-writes.md)的契約不變）。舊的數字網址在記下它的那台照舊可用，查事件對應到的 `version_key`，過渡一個版本後刪掉 |
| 回到某一天、倒回（`pointInTime.ts`、`rewind.ts`） | 「某個時間點之前的最後一版」改用版本的排序鍵。倒回一步一步退回時用的 `id` 順序也改成這個鍵 |
| 手寫歷史（`nodeReads.ts:16-33`、`inkChanges.ts`、`routes/nodes.ts:291,677`） | 讀 `note_versions` 中 `unit` 是手寫的那些；還原用 `version_key` |
| 日子視角「這天改過的筆記」、最近的版本 | 讀 `note_versions`。「AI 的工作」與審閱仍讀事件，是本機的帳 |
| 備份匯出（`backupHistory.ts`） | 讀 `note_versions`；檔案格式 3 不變，`id` 寫 `version_key` |

**排序**：依（`coalesce(clock_wall, at 換成毫秒)`, `clock_counter`, `ordinal`, `version_key`）。`ordinal` 讓同一筆交易裡的版本照寫入的先後排（4.4 第 3 點）。
- 邏輯時鐘的牆上部分在時鐘正常時就等於時間，而且一定排在它看過的寫入之後。所以兩台的清單順序相同，也不會出現「回覆排在原文前面」。
- 舊版本沒有時鐘，用原始時間。
- **顯示的時間**一律是 `at`，也就是寫的那台記下的時間。

**畫面文字**（不出現裝置 id、節點 id、序號）：
- 作者照舊：「你」「AI」「自動整理」「臨時工作階段」或人名。
- `recorded_by` 不是這台時，在後面加「・在另一台裝置上」。
- 合併的版本寫「兩台裝置的修改合在一起」。
- 基準版本寫「最早留下的樣子」。
- 內容還沒到的寫「還在從另一台複製」，還原按鈕不能按，並說明原因。
- 裝置名稱（「在你的筆電上」）：第 10 節第 6 題已決定，先不寫，等裝置清單那一批。

---

## 6. 清理與保留

- **`collectOrphanBlobs`**（`maintenance/prune.ts:31-69`）與 **永久刪除時的清理**（`purgedContent.ts:176-196`）都要把 `note_versions.content_hash` 當成引用：一個 blob、manifest 或塊，只要有任何版本指到，就不刪。
- 這兩處今天各自列出同樣五種引用（`prune.ts:12-19` 的註解說明了這點），要合成一個定義，並加守門測試。
- 這個風險**今天是潛在的**（審查第 11 點）：`collectOrphanBlobs`（`prune.ts:30`）在產品裡沒有呼叫者，檔頭說是操作者手動執行；只有永久刪除時的清理會自動跑。但只要有人跑一次，收到的版本的內容就會被刪，所以第 1 批就要改，不等傳送。
- **版本不因為時間而刪**：照 2026-11-15「修改先全部永久保留，不壓縮」（`body-history-merge-2026-11-14.md` §9 第 4 點）。
- 唯一會刪版本的是**永久刪除筆記**。那是一個會複製的墓碑，每台收到時連同那則筆記的版本與內容一起刪：`note_versions` 對 `content_nodes` 設 `ON DELETE CASCADE`，和 `ink_chunks` 一樣（`203_ink_chunks.sql:15`）。
- 所以清理**不需要另外複製**：每台刪的都是同一組，原因是同一個複製的事實。
- 之後如果要做「把很久以前的壓成存檔點」，那會是一種寫入（有標記、會複製），不是各台各自的清理；現在不設計。
- **瀏覽器版**是記憶體裡的 PGlite，每次存檔都把整份資料庫存一份。
  - OPFS 約 60 MiB 未壓縮、約 0.2 秒；IndexedDB 約 6 MiB gzip、約 1 秒（`docs/architecture/browser-app.md:75-76`、`packages/backend/src/browser/snapshotStore.ts:26-27`）。
  - 歷史會**原樣加進每一次存檔的大小與時間**。一份畫了 1,000 筆的畫，它的歷史約 57 MB（塊＋清單），可以讓 OPFS 的那份大約變成兩倍【推論，由上面兩組數字相加】。
  - 第 10 節第 4 題已決定：先量正式站，在 50 MB 以內就全部存。

---

## 7. 「一起刪除的」

- **要複製的事實**：一則筆記的「已刪除」欄位（`content_nodes` 的 `deleted` 單位，`dbUnits.ts:167`）勝出的那個寫入標記。
- `trashLive` 在一筆交易裡刪掉整棵子樹，一筆交易只有一個序號（`stamps.ts:110-112`），所以**同一次刪除的每一則，標記的（來源、序號）都相同**。這份資料每台本來就有，不用新增。
- **規則**：「和 X 一起刪除的」＝ X 的子孫中，`deleted` 單位勝出的標記和 X 的相同，而且仍在垃圾桶裡的。
  - 之後單獨被刪的子孫，標記不同，留在垃圾桶，和今天 `nodeTrash.ts:87` 的說明一樣。
  - 之後被還原又再刪的，標記也會不同。
- **之前的刪除**：今天垃圾桶裡的每一則都是起始標記（`origin = genesis`），分不出來。
  - 遷移時，記下那些刪除的那台，從 `deleted_by_event_id` 與 `triggered_by_event_id` 的串接，寫一份**只增不減、會複製**的分組 `trash_groups(note_id, root_id)`。
  - 它和舊版本一樣只寫一次，跟著歷史層走。
  - 讀的時候：標記相同，或在同一個舊分組裡，就算一起刪除。
- 原來的事件串接在記下它的那台照舊存在，不刪；`restorePlan` 改成只看上面兩個事實，每台算出同樣的答案。
- 還原本身仍是新的寫入，依目前的權限執行（`nodeTrash.ts:161-201`）。

---

## 8. 遷移既有資料

在一個 migration 裡（第 1 批），每台做一樣的事：

1. 建 `note_versions`（第 1 批已做）；`trash_groups` 移到第 5 批（讀它的那一批）。
2. 把這台每一個存檔事件，以及每一個手寫存檔事件，各寫成一列 `g:` 版本。身分照第 2.2 節由內容算出，`recorded_by` 是這台的節點 id。
   - 備份帶進來的事件，作者種類取 `tx_meta.history_import`（`bodyEvents.ts:31-32`）。
   - migration 172 之前的 `ink_data` 事件，`unit` 照那一刻 `inkEventSql` 的判斷寫死（第 2.3 節）。
   - `ATTRIBUTE_CONFLICT`、`BODY_CONFLICT` 裡被放到一邊的內容，也各寫一列 `g:`，種類 `set_aside`（第 4.1 節）。
   - 內容已經不在的存檔不寫（4.4 第 2 點）。`ordinal` 照 `(created_at, id)` 給（4.4 第 3 點）。同時寫 `note_version_events`，並換算「還原自」（4.4 第 4 點）。
   - 正在 `joining` 的工作區跳過（4.4 第 7 點）；只處理有版本清單的節點種類（4.4 第 6 點）。
3. **替這些舊版本取一個真的序號**：在這台的工作區鎖下取一個 `next_seq`，叫 s0。這台所有的 `g:` 版本都記這個序號，於是它們成為這台「第 s0 號寫入」的一部分，之後照第 3.2 節的範圍規則跟著修改包走，也能被轉送。
   - 理由：如果舊版本只能經快照傳，那麼已經加入的裝置，在加入與遷移之間自己存的舊版本，就永遠只在那台。
   - s0 這個序號沒有任何單位的標記。序號本來就會有空缺（被蓋掉的寫入），所以不影響切點【推論：要用測試證明 `bundle_own_origin_ahead` 等拒收不受影響】。
4. **只在根上**（這台沒有那個工作區的 `sync_join` 列）替「目前的內容沒有任何版本指到、而且不是空字串」的筆記與畫寫 `b:` 版本，內容同時寫進 `blobs`／`ink_manifests`（第 4.3 節；4.4 第 1、6、7 點；查詢 5、7、9）。加入的節點這一步什麼都不做。
5. 從事件串接寫 `trash_groups`（第 7 節），也記 s0。**移到第 5 批**做（#1938 決定）。

**為什麼兩台算出來一樣**：
- `g:` 由記下它的那台算一次，之後只複製，不重算。
- `b:` 只由根鑄一次，之後只複製。
- 今天能和別台交換的節點都是空的時候用快照加入的（`stampedImport.ts:1-26`），所以同一組舊版本只會在一台。

**遷移前的唯讀預覽**：第 2.4 節的查詢。第 1 輪寫的「預估＝幾句相加」是錯的（審查第 2 輪第 8 點）：
- 查詢 9 是查詢 5 的子集，不能相加。
- 撞鍵的 `g:` 會讓列數變少。
- 內容不在的存檔不鑄（查詢 2b）。

所以「遷移後的數目等於預覽」要用**同一個算鍵的 SQL 函式**：預覽直接 `count(DISTINCT 鍵)`。這個函式由第 1 批的 migration 定義，預覽在 migration 之前要用同一段 SQL 的唯讀版本。

- **被放到一邊的內容今天看不到**（審查 #1948 第 2 輪）：衝突時留下現況、把另一份字放到一邊（`set_aside`），那份字在歷史清單、「那時的字」、近期變動、備份裡都沒有（它不是筆記有過的狀態）；它也不會被清理刪掉（有版本指到）。衝突收件匣仍留著當時留下的行（讀事件，沒變）。要讓人拿回那份字，需要清單上一列「被放到一邊的」側枝（標示清楚、可還原成新的一版、手機與桌面都要畫面）。這**不在批 2**：列為**第 5 批之前的一個小批**（有人要拿回那份字之前，也先於「一起還原」讀它）。
  - **問題（業主決定）**：備份要不要帶它？傾向**帶**：它是使用者的字，備份是搬家，搬完就永遠拿不回來是無聲的損失；帶的方式是歷史檔多一種行（舊讀取者會拒絕那一篇的歷史，和第 9 節批 2 已記的限制同一類）。

---

## 9. 分批（每批一個 PR）

> **已經合併、本文依賴的同步批**（另一系列「自己的裝置之間的交換」）：**傳輸第 0 批 #1907 已做**（3c64672bf，migration 218，資料形狀 5）；**第 2 批 #1939 已做**（89abe4666，migration 222，資料形狀 6，`have` 每個標籤一個）。
> `SYNC_DATA_SHAPE_VERSION` 今天在 main 是 6（`spine/syncDataShape.ts:24`）。下面「升版」指的是那時的下一個數字。
> migration 編號用那時的下一個空號：main 今天到 222。
> 共八批：第 1–7 批之外，第 8 批是標籤說明的版本（第 10 節的另外決定）。

| 批 | 內容 | 檔案 | migration | 升版 | 必須附的證明 | 什麼時候能開始 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 新表、本機寫入、遷移 | `services/history/versions.ts` 的 `recordVersion` 與提交時檢查的觸發器（第 4.1 節的丙）、`updateNode`／`createNote`／`setNodeAttribute` 與直接寫內文的三處（`tasksStore.ts`、`canvasNodes.ts`）、`db.ts` 的 `migrate()` 與空殼（`onden.no_versions`）、`spine/importedHistory.ts`、`services/attributeWrites.ts` 與 `services/nodeUpdate.ts` 的衝突紀錄（`set_aside`）、新的 `services/history/versions.ts`、`spine/syncClasses.json`（新表分類為 `separate`，附說明）、`maintenance/prune.ts`、`purgedContent.ts` | 一個：`note_versions`、`note_version_positions`、`note_version_events`（這台自己的）、提交時的檢查、算鍵的函式、第 8 節第 1–5 步 | 不升（還不傳） | **每一筆改到內文、標題或手寫值的本機寫入剛好一個版本**：守門從寫 `content_nodes.markdown`／`title` 與手寫屬性的地方數，帶內容建立任務、週期任務滾下一筆都要有測試；一筆交易裡同一則筆記寫兩次（連鎖還原）得到兩個不同的鍵；收包的路徑不呼叫 `updateNode`／`createNote`（守門）；遷移後的數目等於預覽；加入的節點遷移後沒有任何 `b:`；同一份資料庫的兩份拷貝各自遷移，身分欄位相同；清理不刪任何版本指到的內容；永久刪除會連同版本一起刪；**第 4.4 節十二點各自的測試**（含 SQL 對 JS 的鍵、同一交易的先後、空殼 0 個版本與 0 個 blob、`joining` 中的工作區、資料 migration 不鑄、遷移重跑不再取 s0）；每次存檔多出的時間與列數 | **已做（#1938，4c66a2eae，migration 220）** |
| 2 | 讀者改讀新表 | 1.2 的讀者、前端歷史元件（`version_key`、「在另一台裝置上」）、`changes/` 一則 | 無 | 不升 | 舊的清單與新的清單在同一份資料上逐列相同（作者、時間、合併）；數字網址的還原在過渡期仍可用；手機與桌面截圖 | 現在 |
| 3 | 快照帶歷史層與內容層 | `services/stampedSnapshot.ts`、`stampedSnapshotStream.ts`、`spine/snapshotSql.ts`、`spine/stampedImport.ts`（同一個入口）、`sync_join` 的歷史狀態 | 一個（`sync_join` 加欄位） | 升 | 用快照加入的第三台，版本集合與來源相同；傳到一半中斷再續傳，結果相同而且不重寫；雜湊不符整頁拒收、資料庫不變；歷史沒收完就能用；歷史沒收完的那台不能當快照來源 | 現在（#1907 已合併） |
| 4 | 修改包帶版本、歷史的數字、依雜湊取內容 | `spine/stampedBundle.ts`、`services/stampedBundle.ts`、`spine/stampedImport.ts`、`sync_origins` 的歷史標籤 | 視需要 | 升 | 兩台、兩種到達順序，版本集合相同；整份重送什麼都不存；第 3.3 節那個情形（C 歷史不完整時轉給 D）不會讓 D 漏版本；內容還沒到的版本不會讓數字越過它；第 2.5 節那個「兩個位置」的反例；已加入節點的歷史數字從 0 起；性質測試：任意順序與重送後，每台集合＝聯集；收件檢查每一項各一個拒收測試；切點的兩條連線測試 | 現在（#1907 已合併） |
| 5 | 「一起刪除的」改用標記與舊分組 | `services/nodeTrash.ts`（#1907 也改了它）、`eventRestore/restore.ts` | 無（表在第 1 批建好） | 不升（不改單位）；分組的傳送在第 3、4 批已含 | 兩台：A 刪一棵樹、B 收到後「連同一起還原」結果和 A 相同；單獨刪的子孫不跟著回來；舊刪除走分組 | 現在（#1907 已合併） |
| 6 | 合併結果的版本（`m:`，`merged` 與 `conflict` 兩種） | 跟 2b-2b 一起 | — | 跟 2b-2b | 兩台各自算出同一個 `m:`；兩台用不同基底或不同規則版本算出不同的字時，得到兩個不同的鍵，不拒收；只收到後來寫入的第三台也有它（性質測試） | 等 2b-2b |
| 7 | 收尾 | `stampedBundle.integration.test.ts:603` 改成兩個一般測試（4.2）；「這台有別處沒有的舊版本」提醒；`syncClasses.json` 把 `blobs`、`ink_chunks`、`ink_manifests` 的「上線後再決定」改成已決定 | 無 | 不升 | 移除裝置前的提醒有測試 | 等第 4 批 |
| 8 | 標籤說明的版本（第 10 節的另外決定） | `recordVersion` 與提交時的檢查加上標籤這一種節點；標籤說明的歷史清單改讀新表；遷移補上標籤說明的舊版本與基準 | 一個（只補資料與檢查的範圍） | 不升（第 3、4 批已經會帶任何 `note_versions` 列） | 改標籤說明剛好一個版本；遷移後標籤說明的清單與改之前逐列相同；兩台之間照第 4 批的規則一樣收斂 | 第 2 批之後 |

| 1b | 復原一個手寫事件也鑄版本（還欠的一小批，審查者另派） | 手寫事件的復原路徑（`services/eventRestore/attributes.ts`）與它在 `attributeRestore.test.ts` 的模擬資料庫 | 無 | 不升 | 復原手寫事件後剛好一個版本、`version_misses` 不增加 | 現在 |

**第 1 批（#1938）和本文不同的地方**（以程式為準）：
- `recordVersion` 在 `spine/noteVersions.ts`，不是本文寫的 `services/history/versions.ts`。
- 漏鑄版本是**數出來的，不是失敗**：提交時的檢查把「改了筆記或畫卻沒鑄版本」的寫入計進 `sync_clock.version_misses`（並記一個 WARNING），開機時記一行。理由：既有測試在根寫入裡用 SQL 直接寫筆記。內容不在的版本仍然讓交易失敗。
- `trash_groups` 移到第 5 批，也就是讀它的那一批。
- 範圍＝筆記與白板：`note_version_in_scope` 是節點種類 `content`、`canvas`，而且不是系統筆記（migration 220）。標籤不在內。
- 復原手寫事件還沒鑄版本（計數），由第 1b 批補。

每批照 [testing.md](../../agents/testing.md) 回報實際跑了哪些資料庫測試；兩節點的測試用現有的 `test/helpers/stampedBundleWorld.ts`。

---

## 10. 已決定（2026-11-22）

業主 2026-11-22 的回覆：「**都按建議 不行之後改**」。這是審查者 note-91 在 PR #1935 的留言轉述的；業主是在 note-91 的工作階段裡回答的。下面每一題都照建議；「不行之後改」的意思是：之後量到或做到不行時，再回來改這一題。

1. **加入第二台時，把所有舊版本都複製過去。**
   - 筆記先到，裝置先能用；舊版本隨後補完，畫面顯示還剩多少（第 3.1 節的 A、第 3.5 節）。
2. **位置與標籤的變化紀錄（`structure_log`）之後再做**，不在這一系列。
   - 換主之後，「這則筆記以前在哪」的紀錄會留在舊主上，直到那一批做出來。
3. **操作紀錄（復原、AI 執行、審閱）不同步**，仍然各台各自保存。
   - 換裝置之後，在舊裝置做的動作不能在新裝置按「復原」；可以用「還原這一版」拿回內容。
4. **瀏覽器版的手寫舊版本：先量正式站。**
   - 用塊加清單的總量量（第 2.4 節查詢 4；清單的總量約和筆畫數的平方成正比）。
   - 在 50 MB 以內，瀏覽器版就全部存。
   - 超過的話，先只存內文歷史，並在畫面上說明。
   - 量的結果寫進第 3 批的 PR 說明。
5. **歷史還沒複製完的裝置，不能拿來加入第三台。**
   - 畫面寫「這台的舊版本還在複製，完成後才能加入其他裝置」（第 9 節第 3 批的證明已含）。
6. **版本上先只寫「在另一台裝置上」**（第 5 節）。裝置名稱等裝置清單那一批再加。
7. **保留遷移以前就在垃圾桶裡的「連同一起刪除的一起還原」**：寫 `trash_groups`（第 7 節），在第 5 批做。
8. **舊的數字版本網址保留一個版本，之後刪掉**（第 5 節；查 `note_version_events`）。

**另外決定（同一天，照審查者的建議）：標籤說明也要有版本歷史，放在後面的批次補。**
- 第 1 批的版本只給今天有內文版本清單的節點種類（4.4 第 6 點），不含標籤。
- 第 2 批把讀者改讀新表時，**標籤說明的歷史清單繼續讀事件**。
- 第 8 批（第 9 節）把標籤說明接上 `recordVersion` 與提交時的檢查，補遷移，再把它的歷史清單改讀新表。
- **標籤說明的舊歷史只能在 `domain_events` 還在寫的期間回填成 `g:`；第 2 批改讀新表之前，標籤說明的歷史清單繼續讀事件，直到補標籤的那一批。**

**審查者在 #1938 先定的三件，業主沒有異議**（那個 PR 的內容不在本文範圍；第 1 批實作時以 #1938 為準）：
- 漏記只計數並顯示。
- 復原手寫也鑄版本。
- 屬性跟著包走。

## 11. 我沒有驗證的

- 沒有執行任何程式、沒有量測。第 2.4 節的查詢沒有在任何資料庫跑過，語法以 PostgreSQL 16 為準【沒量】。
- 版本列每列約 0.3 KB 是推估。
- 「s0 序號不影響切點與拒收規則」、「`m:` 版本跟著列走就會收斂」是推論，各在第 9 節對應的批要用測試證明。
- 第 1.3 節「加入的那台按『連同一起還原』只會還原一則」是由 SQL 讀出，沒有執行。
- `BODY_CONFLICT` 留下的那段字存在哪裡（事件 payload 或 `blobs`），以及 `blockChildNote.ts` 的兩處 `updateNode` 是否在同一筆交易，都沒有逐行查（第 12 節第 2、10 點）。
- 第 4.1 節的觸發器做法沒有雛形：標記觸發器能不能在同一個語句裡數出 `<第幾次>`、讀到 `onden.version_restored_from`，第 1 批先做小實驗。
- 本文最初依據 PR #1907 分支 2026-11-20 的版本；2026-11-22 併入 main（89abe4666，含 #1907 與 #1939）之後，第 3.3 節已照 #1939 的「每個標籤一個數字」改寫，第 9 節的行號與 migration 編號也已對過。其他引用的行號只在這次對過檔案與函式，沒有逐行重查。

---

## 12. 審查的對照（PR #1935）

### 第 1 輪（2026-11-22）

| 點 | 審查要的性質 | 查證 | 本文怎麼改 |
| --- | --- | --- | --- |
| 1 | 同一份內容、同一個來歷，每台只有一個身分 | 屬實：加入的那台沒有事件（`stampedImport.ts:1-10`），會替來源已經有的內容再鑄 `b:` | `b:` 只由根鑄，加入的節點從不鑄；`b:` 的 `at` 不進身分（第 2.2、4.3、8 節） |
| 2 | 一筆交易裡對同一則筆記的每次寫入各有身分 | 屬實：巢狀 `mutate` 沿用第一個標記（`spine/mutate.ts:96,122`），連鎖還原在同一筆交易（`restore.ts:307-323`）。`blockChildNote.ts` 的兩處 `updateNode`（`:164`、`:272`）是否在同一筆交易我沒有逐行追；第 1 批的鍵不依賴答案 | 鍵加 `<第幾次>`，由寫的那台給，別台照抄（第 2.2 節；第 2 輪改由 `recordVersion` 給） |
| 3 | 每一筆讓內文變成新值的寫入都留下版本 | 屬實：`tasksStore.ts:327-331` 寫了 `markdown`，`:484-500` 的事件沒有 `body_hash`；`scheduler.ts:150-171` 同 | 版本改在標記觸發器旁產生（第 2 輪改成丙：程式鑄、提交時檢查）；守門從寫入處數（第 4.1 節、第 9 節第 1 批） |
| 4 | 172 之前的手寫版本，每台顯示在同一處 | 屬實：分類讀 `board_ink_moves`（`bodyEvents.ts:44-58`），該表「未定」（`syncClasses.json:313-315`），復原後會翻 | 遷移時照那一刻的判斷寫死；手寫也補基準（查詢 7、8）（第 2.3、2.4 節） |
| 5 | `m:` 每台相同、誠實的兩台不會互相拒收 | 屬實：結果取決於基底與規則版本（`body.ts:1-13,29-45`） | 鍵含基底雜湊、規則版本、結果雜湊；`conflict` 也鑄（第 2.2 節） |
| 6 | 數字越過一個版本 ⇒ 握有它驗過的內容 | 屬實 | 數字追內容；`history_done` 與摘要涵蓋內容；初值 0；新標籤排除在 `haveOfAll`（`stampedBundle.ts:113`、`stampedImport.ts:536,541`）之外（第 3.3 節） |
| 7 | 遷移之後匯入的歷史送得到 | 屬實：`importedHistory.ts:106-111` 不取序號 | 用那筆還原交易的序號當位置（第 2.2 節） |
| 8 | 收包不多鑄版本 | 屬實：今天收包不寫事件與衍生資料（`stampedImport.ts:612-617`） | 守門與兩節點測試寫進第 1 批（第 4.2 節） |
| 9 | 寫明哪些欄位是身分 | 屬實：pg_dump 拷貝的 `recorded_by` 與 s0 不同 | 新增第 2.5 節；傳送位置記成集合，附反例 |
| 10 | 被蓋掉的內容是不是版本 | 手寫屬實（`attributeWrites.ts:253-272`）；內文的那段字存在哪裡要在第 1 批查（`nodeUpdate.ts:400-410`） | 是：種類 `set_aside`（第 4.1、8 節） |
| 11 | 照實寫風險；量法算進清單 | 屬實：`collectOrphanBlobs` 沒有呼叫者（`prune.ts:30`）；清單總量約為筆畫數的平方 | 第 6 節寫成潛在風險；第 2.4 節加推估；第 10 節第 4 題的門檻改用「塊＋清單」 |

### 第 2 輪（2026-11-22）

審查的結論：第 1 批可以派。我重新打開了它引用的每一處，都屬實。十二點全部寫進第 4.4 節，下面只列改變了本文設計的地方：

| 點 | 改了什麼 |
| --- | --- |
| 1 | 第 1 輪採用的「觸發器鑄版本」存不了內容（`blobs.ts:15-28` 的鎖），手寫還要在 SQL 裡重算整個值的雜湊。改成丙：程式鑄、資料庫在提交時檢查（第 4.1 節）。第 1 輪第 3 點要的涵蓋性質不變，由提交時的檢查保證 |
| 3 | 新增 `ordinal` 欄，排序放在鍵之前（第 2.3、5 節） |
| 4 | 新增這台自己的 `note_version_events`（4.4 第 4 點） |
| 6、7、11 | 新增交易內的設定 `onden.no_versions`（空殼、種子、資料 migration）；根的定義改成「每個工作區」 |
| 8 | 第 8 節的預估改成同一個函式的 `count(DISTINCT 鍵)`；查詢 2 修正、加 2b |
| 9 | `g:` 的編碼改成每個欄位帶長度前綴（4.4 第 9 點） |

