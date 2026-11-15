# 同步與離線審查（2026-10-24）

> 狀態：歷史紀錄（最後確認 2026-11-01）

範圍：前端 `localDbWorker.ts`、`localDbJournal.ts`、`localDbPersist.ts`、`localMirror.ts`、`data/syncEngine.ts`、
`writeQueue.ts`、`onlineWrite.ts`、`membershipReconcile.ts`、`connectivity.ts`、`liveInvalidation.ts`、`public/sw.js`；
後端 `routes/sync.ts`、`services/sync/*`、`spine/idempotency.ts`、`routes/events.ts`、`services/realtime.ts`。

方法：只讀程式碼（沒有讀任何 `.md`），再用 vitest 寫了丟棄式重現測試確認。測試**沒有提交**；
重現步驟寫在各項「重現」欄，可照做。使用情境假設：Android（Brave PWA）與桌機同時使用、常部署、client 不關。

標記：**CONFIRMED** = 我跑出了結果；**SUSPECTED** = 只有程式碼推理，下面寫出推理。
嚴重度：P0 = 資料遺失／外洩；P1 = 使用者會碰到的錯誤行為；P2 = 風險或技術債。

## 總表

| # | 嚴重度 | 狀態 | 一句話 |
| --- | --- | --- | --- |
| 1 | P0 | CONFIRMED | 兩個分頁／PWA 與瀏覽器分頁並存時，過期分頁的整庫快照會蓋掉已壓縮的離線佇列寫入 |
| 2 | P1 | CONFIRMED | 慢的 bootstrap 回來時蓋掉較新的 delta、刪掉期間新增的筆記，游標又不倒回，直到重開才好 |
| 3 | P1 | CONFIRMED | 寫入請求沒有逾時，一個卡住的請求讓所有儲存與 `sync()` 永遠等待 |
| 4 | P1 | CONFIRMED | 佇列頭一筆持續 5xx 會擋住後面全部寫入與所有「僅線上」操作，只有一次提示 |
| 5 | P1 | SUSPECTED | 主要同步沒有「回到前景／網路恢復／輪詢」補拉，SSE 心跳又是看不到的註解，殭屍連線讓手機靜默過期 |
| 6 | P1 | SUSPECTED | 任何標籤新增／移除都會 bump `membership_epoch`，其他裝置因此升起不透明的閘門並重跑 reconcile |
| 7 | P1 | SUSPECTED | 本機 DB worker 死掉或卡住沒有重啟也沒有逾時，所有 `call()` 永遠 pending |
| 8 | P1 | SUSPECTED | 本機 DB 初始化失敗時，伺服器明明連得上，畫面卻是空的「離線」且完全不能存 |
| 9 | P2 | CONFIRMED | `applySync`／`setLastEventId` 無條件覆寫游標，不單調 |
| 10 | P2 | CONFIRMED | 游標比伺服器還前（伺服器資料庫回溯）時 client 永遠不會降回 |
| 11 | P2 | SUSPECTED | 實驗性事件修剪開啟時，離線超過寬限期的 client 沒有缺口偵測 |
| 12 | P2 | SUSPECTED | 快照存檔失敗（配額）事件沒人聽，且每約 2 秒重試一次 35–100 MB 的匯出 |
| 13 | P2 | SUSPECTED | reconcile 的事件位置釘選讓「有差異」的情況在對方持續寫入時重啟到用盡 |
| 14 | P2 | SUSPECTED | 本機 schema 只加欄位、沒有版本章，新欄位在暖啟動後最久 24 小時是 NULL |
| 15 | P2 | SUSPECTED | 沒有 build／API 版本協商，長壽的手機 PWA 分頁可能一直跑舊程式對新 API |
| 16 | P2 | SUSPECTED | 沒有快取又連不上時，畫面套用 `fallbackData`（admin／owner、空的「Onden MVP」）當成真資料 |
| 17 | P2 | SUSPECTED | `refresh()` 的 catch-all 把任何錯誤（含本機儲存、解碼）都當成離線 |
| 18 | P2 | SUSPECTED | `blocks` 通道 client 完全不用，伺服器每個 delta 白算；`isEmptyDelta` 又不看它 |
| 19 | P2 | SUSPECTED | 白板鏡像修剪拿伺服器的 `created_at` 跟 client 時鐘比，時鐘快就誤刪 |
| 20 | P2 | SUSPECTED | `bootCursorReady` 在第二次 `boot()` 時被換掉，等第一個的 `sync()` 永遠不醒 |
| 21 | P2 | SUSPECTED | `sendWrite` 預設每次新金鑰；冪等鍵 30 天清除；重試語意靠呼叫者自己傳鍵 |
| 22 | P2 | SUSPECTED | 被移出工作區（401 `membership_removed`）會連同未送出的離線輸入一起清空 |
| 23 | P2 | SUSPECTED | 快照匯出與 IDB 存檔佔著 worker 的單一 FIFO，期間所有 RPC（含 `addPendingWrite`）排隊 |

計數：P0 1、P1 7、P2 15；CONFIRMED 6、SUSPECTED 17。

---

## P0

### 1. 過期分頁的整庫快照蓋掉已壓縮的佇列寫入（P0，CONFIRMED）

位置：`localDbWorker.ts:143-161`（`saveSnapshot`：只蓋自己知道的 `journal_applied`，整份 `idbSave`）、
`localDbJournal.ts:133-140`（`journalDrop` 壓縮後刪紀錄）、`indexedDbStorage.ts:36-45`（固定鍵 `put`）、
`writeQueue.ts:28-37`（Web Lock 只保護送出，不保護佇列內容）。

情境：每個分頁／PWA 視窗各有自己的 worker 與記憶體 sql.js，卻寫同一個 IndexedDB 鍵。
(1) 分頁 A、B 都載入同一份快照。(2) A 離線存了一筆（journal 紀錄 `A:1`）。
(3) A 的壓縮把快照存成「含這筆、`applied={A:1}`」並刪掉 `A:≤1` 的 journal。
(4) 還沒看過這筆的 B 照常因 sync 或啟動而髒，存整庫快照，覆蓋 A 的。
(5) A 若在送出前被關閉或被 Android 回收，下次冷啟動快照沒有這筆、journal 也沒有。這筆輸入永久遺失；
被拒絕後保留在復原面板的輸入（`rejection` 列）走同一條路，同樣會被抹掉。
Brave 的已安裝 PWA 與同網域的瀏覽器分頁共用 IndexedDB，所以這不只是「開兩個分頁」。

重現（CONFIRMED）：用既有的 worker 測試 harness（`journalAvailable=true` 並以記憶體實作 journal）開兩個 worker A、B（皆載入空快照）；
A：`addPendingWrite("POST","/api/nodes",…,"key-1")` → `setLastEventId(5)` → `flushLocalDbSync`（等於壓縮，journal 變空）；
B：`setLastEventId(6)` → `flushLocalDbSync`；再開第三個 worker 冷啟動：`getPendingWrites()` 長度 0（預期含 `key-1`）。

建議：快照存檔改成帶世代的比較交換（讀回 IDB 裡的 `journal_applied`／世代，不是自己上次的就先重載合併，或放棄存檔）；
或用 Web Lock（`onden-local-db-owner`）讓同一時間只有一個 context 可存檔。`journalDrop` 只刪「已確認寫入且仍是目前快照」所含的紀錄。

---

## P1

### 2. 慢的 bootstrap 蓋掉較新的 delta（P1，CONFIRMED）

位置：`syncEngine.ts:151-172`（`refresh`）、`:242-260`（`refreshOnReopen`、`hydrateFullBootstrap`）、`:96-100`（`setWholeBootstrap`）、
`localMirror.ts:38-62`（`upsertNodeInto` 無版本比較）、`localDbPersist.ts:229`（完整路徑 `DELETE FROM nodes`）、`localDbWorker.ts:435-441`（既有游標 `DO NOTHING`）。
並行來源：暖啟動後的閒置 `refreshOnReopen`／`hydrateFullBootstrap`（`syncEngine.ts:963`、`:996`），
以及各領域寫入完成後呼叫的 `refresh()`，它們都不與 `sync()` 互斥。

情境：手機重開，閒置時開始抓完整 bootstrap（4G 約 7 秒，快照在事件 100）。這段時間桌機改了 `n1` 並新增 `n2`，
SSE 觸發 `sync()` 套用事件 105，游標與 store 都變新。慢的 bootstrap 這時才回來：`DELETE FROM nodes` 後寫入 100 時的狀態，
`n1` 回到舊標題、`n2` 消失，store 也被 `setWholeBootstrap` 整份取代。游標留在 105，沒有任何事件會再補它們。
新筆記要等下次重開（冷啟動 reconcile 一定會跑）才找回，舊標題要等該筆下次被改。

重現（CONFIRMED，worker 層級）：`persistBootstrap(boot([n1:"old"],"100"))` → 先留住另一份同內容的 payload →
`applySync(delta([n1:"NEW", n2], 105))` → 再 `persistBootstrap(舊 payload)`；`loadBootstrapList` 結果只剩 `n1:old`，`getLastEventId` 仍是 105。

建議：bootstrap 落地時把游標設成 bootstrap 自己的 `last_event_id`（delta 重播是冪等的，倒回只會多套幾筆）；
或讓「抓 bootstrap → 落地」與 `sync()` 走同一條序列，落地前比對游標，已經更前就丟掉 bootstrap 只留 meta。

### 3. 寫入請求沒有逾時，一個卡住的請求塞住整條車道（P1，CONFIRMED）

位置：`api.ts:657-669`（`api()` 沒有 signal）、`writeQueue.ts:28-37`（`serialized`＋`navigator.locks`）、`:73-103`（直送）、`:138-142`（重播）、
`syncEngine.ts:726`（`sync()` 開頭先 `await flushPendingWrites()`）。只有讀取有 `readWithDeadline`（15 秒，`api.ts:688`）。

情境：Android 從 Wi-Fi 換到行動網路，或連上沒有對外的 Wi-Fi，TCP 停滯、`fetch` 既不成功也不失敗。
第一筆 `submitWrite` 卡在 `api()`；之後每個 `submitWrite` 都在 `writeTail` 後面等；`sync()` 等 `flushPendingWrites()`，連 delta 都不拉；
別的分頁因為 Web Lock 被持有，儲存也卡住。卡住期間沒有進佇列，輸入只在記憶體草稿，此時 App 被回收就遺失（後半段是推理）。

重現（CONFIRMED）：`api` mock 第一次回傳永不 resolve 的 Promise，第二次回傳成功；
`void submitWrite(A); const second = submitWrite(B)` → 1 秒後 `second` 仍未 settle。

建議：直送與重播各加每次嘗試的 deadline（例如 20–30 秒，`AbortController`），逾時視為 retryable 並沿用同一個冪等鍵進佇列
（伺服器已有冪等，所以「逾時但其實成功」是安全的）。

### 4. 頭一筆持續 5xx 擋住後面全部寫入（P1，CONFIRMED）

位置：`writeQueue.ts:154-162`（5xx 或網路錯誤就 `break`，且 `WARN_AFTER_ATTEMPTS === 6` 只提示一次）、`:123`；
`onlineWrite.ts:56`（佇列非空就拒絕所有「僅線上」操作：設定、結構、歷史、發布）。

情境：某筆排隊寫入遇到伺服器 bug 穩定回 500。為了保持順序，後面的寫入永遠不會送；
同時所有僅線上操作都回「Sync pending changes before continuing.」。
使用者看到的只有計數，加一次在第 6 次嘗試時的 toast。網路層錯誤（`TypeError`）甚至不增加 `attempts`，完全不會升級。

重現（CONFIRMED）：佇列 `[poison(500), fine(200)]`，`flushPendingWrites()` 呼叫 30 次：`fine` 從未被送出，`poison.attempts=30`，toast 共 1 次。
另一組：只回 `TypeError("Failed to fetch")` 12 次，`attempts` 仍是 0、toast 0 次。

建議：嘗試次數對網路錯誤也計；超過門檻後把該筆標記為「卡住」，在同步狀態晶片持續顯示（筆數＋最舊時間＋原因），
並提供「移到復原區」讓使用者解開頭端；同一目標的相依寫入一起移，順序不變。

### 5. 主要同步沒有補拉訊號，SSE 殭屍連線靜默過期（P1，SUSPECTED）

位置：`hooks/useWorkspaceLive.ts:32`（只給 `{ onReconnect: false, collapseEcho: true }`）；
`liveInvalidation.ts:34-46`（`onVisible`、`onOnline`、`pollMs` 都已存在卻沒被這個註冊用到）；
`hooks/useLiveEvents.ts:20-23`（說明寫著有約 60 秒的備援輪詢，但此註冊沒有）、`:83-102`；
`backend/routes/events.ts:190-219`（心跳是 `: hb` 註解，`EventSource` 看不到）；`services/realtime.ts` 檔頭（單程序）。

推理：手機回到前景時，若 SSE 在背景或換網路時變成半開（沒有 `onerror`），`useLiveEvents` 沒有任何 watchdog，
也沒有 `visibilitychange` 補拉，所以不會收到 tick，也不會 `sync()`；重疊部署（兩個後端程序）時另一程序的寫入同樣不會推到這條連線，且沒有輪詢備援。
`connectivity.ts` 的 `online` 事件只在瀏覽器回報網路狀態改變時才跑。

建議：同步註冊加上 `onVisible: true, onOnline: true, pollMs: 60_000`（程式已支援）；伺服器改送 `data:` 形式的心跳 tick，
client 超過約 60 秒沒收到任何框就關掉重連。

### 6. 每次標籤新增／移除都 bump `membership_epoch`（P1，SUSPECTED）

位置：`backend/db/schema.sql:159-171`、`:1493`（`node_tags` 上每個 INSERT／DELETE 都 `membership_epoch + 1`，不分是不是權限標籤）；
`syncEngine.ts:572-580`（epoch 不同就升起閘門並 reconcile）、`:646-648`（`restart-exhausted` 時拋錯、閘門留著）；
`membershipReconcile.ts:84-158`；`components/BuilderWorkspace.tsx:296-303`（閘門＝不透明遮罩＋`inert`）。

推理：桌機給一則筆記加普通標籤 → epoch＋1 → 手機下一次 `sync()` 看到 epoch 不同 → 整個工作區 `inert` 加遮罩，直到 digest 往返完成。
digest 相同時只要一個 RTT，但每次標籤操作都會閃一次，輸入靠 `GateTypingBuffer` 兜底；批次套標籤（匯入）時 epoch 連續跳，
進行中的 reconcile 一直重啟（#13）。這條路徑不經 `affectsMembership`，所以也沒有 SSE 的 `membership_changed` tick（只有 `pg_notify`，程式裡沒有 LISTEN），
是下一個 `changed` tick 的 `sync()` 才發現。

建議：觸發器只在標籤參與讀取政策（權限標籤）時 bump；client 的閘門改成「digest 不相等才升起」，而不是 epoch 不等就升起。

### 7. worker 死掉或卡住沒有重啟與逾時（P1，SUSPECTED）

位置：`localDb.ts:25-47`（只有 `onerror` 會 reject 進行中的呼叫，沒有 `messageerror`、沒有重建 worker）、`:49-56`（`call()` 沒有逾時）。

推理：100 MB 級的 `db.export()` 加上 structured clone 在手機上可能讓 worker 被系統回收，這種終止通常不會觸發 `onerror`。
之後每個 `call()` 永遠 pending，包含 `submitWrite` 等的 `addPendingWrite`，進而塞住 #3 的車道。

建議：`call()` 加逾時；逾時或 `error` 時 `terminate()` 並重建 worker（初始化會重載快照＋journal，已經有重播機制），
並在 UI 顯示「本機副本暫時不可用」。

### 8. 本機 DB 失敗時，應用程式變成「空的離線」且完全不能存（P1，SUSPECTED）

位置：`syncEngine.ts:163`、`:258`、`:931`（伺服器資料要先 `await persistBootstrap` 才進畫面）、`:1004-1021`（catch：`setOnline(false)`，沒快取就 `setData(fallbackData)`）；
`writeQueue.ts:77`（讀不到佇列時假設有積壓，然後 `enqueue` 失敗丟 `WriteStorageError`）；`initializationGate.ts` 每次呼叫會重試，但持續失敗就一直失敗。

推理：IndexedDB 被阻擋、快照讀取失敗，或 `verifySnapshotOwner` 擋下，都會讓伺服器可達的情況下顯示空工作區、標成離線，連線上儲存也被拒。
伺服器資料已經抓回來了卻被丟掉。

建議：持久化失敗時退到「僅記憶體模式」：照樣顯示伺服器資料、允許直送，並明確標示「這台裝置沒有離線副本」。

---

## P2

### 9. 游標不單調（P2，CONFIRMED，目前不易觸發）

位置：`localDbWorker.ts:581-585`、`:636-644`（`ON CONFLICT … DO UPDATE SET value=excluded.value`）；`syncEngine.ts:581-586`（reconcile 先讀 `lastId` 再經過很多網路等待後套用）。
重現：`setLastEventId(200)`，`applySync(delta([],150))` → `getLastEventId()` 變成 150。
目前同一分頁內 `sync()` 單飛所以碰不到；任何新增的並行呼叫者或 #1 的修法都會變成問題。建議 SQL 用 `MAX`。

### 10. 游標領先伺服器時永遠降不回（P2，CONFIRMED）

位置：`localDbWorker.ts:435-441`（既有游標 `DO NOTHING`）、`backend/services/sync/delta.ts:150-152`（沒有事件時回傳 `since` 本身）、
`syncEngine.ts:563-571`（epoch 倒退會 reconcile，但不處理事件游標）。
重現：`setLastEventId(9000)` 再 `persistBootstrap(last_event_id:"120")`，游標仍是 9000。
情境：伺服器資料庫從備份還原後事件 id 回到較小值，手機 `since=9000` 會一直拿到空 delta，直到新事件 id 超過 9000。
建議：回應帶 `head_event_id`，client 發現 `since > head` 就重置游標並做完整 bootstrap。

### 11. 實驗性事件修剪沒有缺口偵測（P2，SUSPECTED）

位置：`backend/db.ts:297-337`、`index.ts:380-386`（僅在 `EVENT_PRUNE_EXPERIMENTAL=on`）、`delta.ts:108-116`。
預設不開，所以只是風險：開啟後，離線超過 7 天的 client 要求 `since` 以前被修剪的非 body 節點事件（標籤、隱藏、屬性等）會直接略過，伺服器不會說「你落後太多」。
目前靠每日完整 bootstrap 補，但大型工作區（≥2000 筆）走 slim 路徑不更新已存的內文。建議 delta 回應在 `since` 小於最舊保留事件時回 `resync_required`。

### 12. 快照存檔失敗沒人聽，還會連續重試（P2，SUSPECTED）

位置：`indexedDbStorage.ts:34`、`:46-57`（在 worker 的 `self` 上 dispatch，全專案沒有任何地方監聽）；
`localDbWorker.ts:143-168`（失敗就 `scheduleSave()`，退避只有 2 秒的 debounce）。
推理：配額滿了，鏡像快照停止更新但沒有任何提示；worker 每隔約 2 秒重新匯出 35–100 MB 再失敗，加重記憶體壓力（連到 #7）。佇列因為有 journal 暫時沒事，但冷啟動要重播越來越長的 journal。
建議：指數退避；失敗時 `postMessage` 到主執行緒，顯示「本機副本無法儲存」。

### 13. reconcile 的事件位置釘選容易用盡重啟（P2，SUSPECTED）

位置：`services/sync/membership.ts:85-97`（版本含 `MAX(domain_events.id)`）、`membershipReconcile.ts:84-158`（預設最多重啟 5 次）、`syncEngine.ts:646-648`。
推理：digest 相同時是兩次請求所以沒事；真有差異時（例如權限改動後）要分頁讀，20k 筆約 20 頁。另一台裝置持續自動儲存（每次都有事件）會讓每一頁後的版本比對失敗，重啟到用盡後閘門一直不降。
建議：頁間只釘 epoch；新增／刪除交給緊接著的事件 delta，或在伺服器端保存一份集合快照給分頁讀。

### 14. 本機 schema 沒有版本章（P2，SUSPECTED）

位置：`localDbSchema.ts:41-42`、`:125-133`（`ALTER TABLE … catch {}`，只加不記版本）、`syncEngine.ts:188`、`:944-963`（暖啟動只靠 delta，完整 bootstrap 最多每 24 小時一次）。
推理：新版本加一欄（例如 `created_at`、`space_id`、`actor_is_owner`）後，舊列在下一次完整 bootstrap 前都是 NULL：同層排序、空間歸屬、owner 介面都可能暫時不對。
建議：`sync_state` 存 `mirror_schema_version`，遷移加欄位時清掉 `full_refresh_at`，第一次重開就走完整 bootstrap。

### 15. 沒有 build／API 版本協商（P2，SUSPECTED）

位置：`lib/lazyWithReload.ts:44-55`（只靠 lazy chunk 404 才觸發重載）、`public/sw.js`（`skipWaiting`＋`clients.claim`）、
後端沒有 build id 回應標頭（只有 `X-Onden-Bootstrap: lean2` 這種功能協商）。
推理：手機 PWA 分頁可以一整週不重載，只要它不再開新的 lazy 功能，就一直用舊 JS 面對新 API，而且沒有任何提示。
建議：API 回應帶 `X-Onden-Build`，client 比對 `BUILD_ID`，不同就顯示「有新版，重新載入」並重用現有的 `setBeforeChunkReload` 草稿保存流程。

### 16. `fallbackData` 被當成真實資料（P2，SUSPECTED）

位置：`api.ts:538-549`（`actor_role:"admin"`、`actor_is_owner:true`、`can_review:true`、名稱「Onden MVP」）、`syncEngine.ts:1014`。
推理：IndexedDB 被清掉（Android 儲存壓力或使用者清除資料）後又在離線冷啟動，會看到一個空的 owner 工作區；此時的建立會進佇列，擁有者專屬設定也會顯示。
建議：改成明確的「尚無資料」狀態，權限旗標用 `null`／最小權限。

### 17. `refresh()` 把任何錯誤都當成離線（P2，SUSPECTED）

位置：`syncEngine.ts:167-169`、`bootstrapWire.ts:126`（遇到未知 `wire` 版本丟一般 `Error`）。
本機持久化失敗、解碼錯誤、`AbortError` 之外的任何例外都會 `setOnline(false)`，之後 `connectivity` 的 online 翻轉邏輯依此判斷。
client 送 `lean2` 標頭，所以未知 `wire` 目前只會在伺服器不尊重標頭時發生。建議只有 `isServerUnreachable(error)` 才設離線，其餘顯示對應錯誤。

### 18. `blocks` 通道 client 不用（P2，SUSPECTED）

位置：`backend/services/sync/delta.ts:468`、`bootstrap.ts:216`（每個 delta、每個 bootstrap 都查）、`frontend/lib/data/storeOps.ts:121-130`（`isEmptyDelta` 不看 `blocks`）、`localDb.ts` 的 `SyncDelta` 型別沒有 `blocks`。
目前只是白費伺服器查詢；日後 client 若開始使用，只含 `blocks` 的 delta 會被當成空 delta、游標前進但沒套用。

### 19. 白板鏡像修剪用 client 時鐘比伺服器時間（P2，SUSPECTED）

位置：`syncEngine.ts:58-61`（`listedAt = new Date().toISOString()`）、`data/canvasWriter.ts:404`（`row.created_at >= listedAt` 才保留）。
推理：手機時鐘比伺服器快幾分鐘時，另一台剛建立、還不在清單裡的白板會被誤判為已刪，離線佈局被移除（下次開啟才重抓）。建議由伺服器回 `server_time`。

### 20. `bootCursorReady` 被換掉（P2，SUSPECTED）

位置：`syncEngine.ts:479-480`、`:864`（每次 `boot()` 都建新 Promise 與新的 `releaseBootCursor`）、`:725`（`sync()` 先 `await bootCursorReady`）。
第二次 `boot()` 發生時，等待第一個 Promise 的 `sync()` 永遠等不到 resolve，`syncInFlight` 就永遠不清，之後所有 `sync()` 都回同一個卡住的 Promise。
`connectivity.ts` 目前避免了重複 boot，所以觸發面很窄（換主機／重新附加）。建議 `boot()` 先 resolve 舊的再換新的。

### 21. 冪等重試語意（P2，SUSPECTED）

位置：`onlineWrite.ts:99-115`（`sendWrite` 預設 `randomUUID()`，重試要呼叫者自己傳同一把）、`:20-30`（註解承認其他寫入會讓鍵作廢而可能重複套用）、
`backend/index.ts:387-398`（冪等鍵 30 天清除）。
這是已知取捨，列出來是因為「回應遺失但伺服器已提交」在部署時最容易發生：非佇列的 `sendWrite` 呼叫者若不保存鍵，重試就是新請求。

### 22. 被移出工作區會清掉離線輸入（P2，SUSPECTED）

位置：`syncEngine.ts:1094-1100`（`forgetWorkspace` → `wipeWorkspaceMirror`）、`localDbWorker.ts` 的 `wipeWorkspaceMirror`（含 `pending_writes`、`sync_state`、journal）、`accessRevoked.ts:15-20`（旗標全程序有效、不重設）。
安全上合理，但離線一週後才收到 401 `membership_removed` 的人，所有尚未送出的輸入與復原區輸入一起消失，沒有匯出機會；再被邀請回來也要重新載入頁面。

### 23. 快照匯出佔著 worker 的單一佇列（P2，SUSPECTED）

位置：`localDbWorker.ts:64-68`（`enqueueDatabaseWork`）、`:163-165`、`:1238-1258`（所有 RPC 與快照同一條 FIFO）。
`saveSnapshot` 在佇列內 `await idbSave(...)`，期間 `getPendingWrites`、`addPendingWrite`（`submitWrite` 等的就是它）都排隊；同步爆量時每約 2 秒一次，手機上可能出現數秒的輸入停頓。
`db.export()` 本身是同步的無法切開，但 `idbSave` 的等待可以移出佇列。

---

## 做得好、不要動的地方

1. **事件游標與套用的原子性**：寫入端全都先取 `event-append:<workspace>` 的 advisory lock（`db.ts:409-415`、`spine/eventTransaction.ts`），事件 id 順序＝提交順序；
   `delta.ts:148-152` 只確認「這一頁真的掃過的最後一個 id」，不用之後的 `MAX(id)`；讀取走 `REPEATABLE READ READ ONLY` 快照（`db.ts:100-103`）；
   前端 `applySync` 把資料與 `last_event_id` 放在同一個 SQLite 交易（`localDbWorker.ts:543-586`）。我沒有找到游標缺口或重複套用。
2. **Journal 與佇列設計**：`pw.put`／`pw.del` 以 (session, seq) 排序重播、用冪等鍵而不是自增 id 對應（`localDbJournal.ts:188-212`），
   被拒絕的寫入進復原區而不是丟掉（`writeQueue.ts:145-152`），有積壓時新寫入一律排在後面（`writeQueue.ts:77`）。#1 是這套設計外面的洞（快照覆寫），不是設計本身有問題。
3. **membership reconcile 與部署相容**：`retry_required` 絕不當成「全部撤銷」（`membership.ts:139-142`）、digest／bucket 捷徑、版本在每頁與套用後都再檢查、失敗時閘門保持升起（`membershipReconcile.ts`）；
   舊 chunk 404 時先存草稿再重載、有守門避免迴圈（`lazyWithReload.ts`）；`lean2` 以請求標頭協商，舊伺服器與新 client 互相退讓（`syncEngine.ts:78-83`）。首次執行的範例筆記也只在伺服器確認「真的是空工作區」時才建立（`useFirstRunSeeding.ts`）。

## `syncEngine.ts` 與 `localDbWorker.ts` 的切分接縫（只談接縫）

`syncEngine.ts`（1100 行）現在有七個責任，共享狀態散在模組層級（`wholeBootstrapGeneration`、`drawingsComplete`、`bootCursorReady`、`syncInFlight`、`syncDirty`、`reconciledRejectionRevision`）：

- **使用者資料夾匯出／匯入**（`:37-52`、`:877-896`）：獨立，沒有共享狀態，最容易先搬。
- **bootstrap 取得與落地**（`fetchBootstrap`、`refresh*`、`hydrateFullBootstrap`、`paintThenPersist`、`loadLocalRest`，`:73-260`）：#2 的修法應該住在這裡，需要和 delta 共用一條序列。
- **筆記內文**（`hydrateNode`、LRU、`downloadBodiesForOffline`，`:277-388`）與 **離線繪圖副本**（`:390-469`）：兩者各只靠 `getAppState().online` 與 worker RPC。
- **delta 拉取迴圈**（`sync()`、髒標記、`membershipChanged`、`liveStreamReconnected`，`:471-843`）：單飛與髒標記要留在同一個檔案。
- **membership 銜接**（digest 預取、`maybeReconcileMembership`、`membershipDelta`，`:506-651`）：已經有純邏輯的 `membershipReconcile.ts`，這裡只是接線，可獨立成薄檔案。
- **生命週期**（`boot`、`reconnect`、`wentOffline`、`forgetWorkspace`，`:856-1100`）：只負責順序，`connectivity.ts` 已經是它的呼叫者。

`localDbWorker.ts`（1261 行）：

- **傳輸與分派**（`self.onmessage`、`ops` 表、`enqueueDatabaseWork`、`storageScope` 釘選，`:1175-1261`）。
- **持久性**（快照、journal、壓縮、`initLocalDb`、`replayJournal`、`adoptLegacyStore`、`importDatabase`、`wipeWorkspaceMirror`，`:82-294`、`:1114-1173`）：#1、#12、#23 的修法都在這一層，需要它對外只露出「讓這個變更持久」與「目前世代」。
- **伺服器資料套用**（`persistBootstrap`、`applySync`、`replaceTouching*`、`persistRemoteNode`、內文與繪圖副本，`:410-830`）：#2、#9、#10 的游標與版本規則放這裡。
- **佇列**（`addPendingWrite`…`bumpPendingWriteAttempt`，`:952-1052`）：只依賴持久性層。
- **讀取模型**（`loadBootstrapCore`、關聯、屬性分頁、白板、搜尋，`:296-408`、`:937-950`、`:1054-1112`）：純讀，最容易切。
- **本機樂觀寫入**（`upsertNode/Edge/Task/Canvas`、`removeNode`、memberships、graph positions）：只呼叫鏡像寫入器與持久性層。

---

## 附：重現測試摘要（未提交）

用既有的 `bootstrapEventCursor.test.ts`／`localDbJournal.test.ts` 的 harness（`vi.mock` 掉 `indexedDbStorage`、`localDbJournal`，自己 `import("../lib/localDbWorker")` 後直接送 RPC），
以及 `writeQueue.test.ts` 的 mock 配置。實際結果：

| 重現 | 結果 |
| --- | --- |
| R1（#2） | `loadBootstrapList` → `["n1:old"]`；`getLastEventId` → 105 |
| R2（#1） | 冷啟動後 `getPendingWrites().length` → 0 |
| R3（#9） | 游標 200 → 150 |
| R4（#10） | 游標維持 9000 |
| Q1（#4） | 30 次 flush：`fine` 從未送出，`poison.attempts=30`，toast 1 次 |
| Q2（#4） | 12 次網路錯誤：`attempts=0`，toast 0 次 |
| Q3（#3） | 第二個 `submitWrite` 1 秒後仍未 settle |
