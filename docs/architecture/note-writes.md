# 筆記寫入模組

> 狀態：現行（最後確認 2026-11-01）
> 涵蓋：packages/backend/src/services/nodeUpdate.ts, packages/frontend/src/lib/data/noteWriter.ts

這次局部重構把「畫面想改什麼」與「如何可靠保存」分開。主要入口是
`packages/frontend/src/lib/data/noteWriter.ts`，不是要求每個按鈕自行組合
API、SQLite、離線佇列、回復與錯誤提示。

## 邊界與責任

| 模組 | 責任 |
| --- | --- |
| `nodeMutations.ts` | 新增、複製、重新命名、刪除、移動與提升筆記的 UI 操作及成功提示 |
| `draftActions.ts` | 草稿、1.5 秒 debounce、節點切換、手動儲存、頁面離開，以及目前草稿的保存指示（只進離線佇列時顯示「等待同步」；佇列清空後，只有這則筆記的重播沒被拒絕才轉成「已儲存」） |
| `noteWriter.ts` | 接受 `create / patch / remove / promote`，管理樂觀更新、本機副本、提交、伺服器回應合併與拒絕回復 |
| `writeQueue.ts` | 提交與重播排序、持久化確認、固定冪等鍵、重試政策與同步計數 |
| `writeErrors.ts` | 初次提交與重播共用的錯誤分類及使用者訊息 |
| `writeRecovery.ts` | 未確認寫入的退出副本，以及直接／重播拒絕的持久復原輸入 |
| `FailedWriteRecovery.tsx` | 顯示復原內容、複製、重試與清除；不再自行管理儲存格式 |

一般操作只需要表達意圖，例如 `writer.patch(id, { title })`。編輯器可以另傳
`baseMarkdown` 保留伺服器三方合併所需資訊，以及 `keepalive` 表示頁面離開保存。

## 保存契約

`submitWrite` 只在兩種情況下成功：

- `{ status: "synced", value }`：收到伺服器成功回應。
- `{ status: "queued" }`：本機佇列的持久化已完成。

佇列持久化失敗會拋出 `WriteStorageError`，並保留原始要求及同一個冪等鍵供復原。
因此 `sendOrQueue` 的舊式 `undefined` 回傳也代表**已確認持久化**，不代表正在嘗試。
`queueWrite` 保留 boolean 相容介面；舊呼叫端仍須等待 `true` 才能宣告已保存。

筆記操作層統一回報錯誤。編輯器仍能觀察 Promise 失敗，保留草稿並啟用 Retry，
不需要自行推測 HTTP 狀態。已接入的操作不再自行判斷網路斷線、產生重試鍵或呼叫 SQLite。

## 排序與復原

同一個筆記的操作依呼叫順序提交，畫面仍立即更新。舊回應只更新仍符合該次樂觀值的欄位，
避免覆蓋後續編輯；本機副本使用目前狀態，不使用排隊時捕捉的過期整列。

新提交和佇列重播共用一條執行順序。若佇列尚有舊變更，新變更排在其後；
使用實際佇列判斷，避免依賴尚未初始化的畫面計數。重播單次執行並共用 Promise，
支援 Web Locks 的瀏覽器也沿用跨分頁鎖。這不是跨裝置衝突解決或新的多分頁資料庫協議。

刪除立即反映在畫面，但等伺服器接受或佇列持久化後，才刪除本機副本及其關聯資料。
即時拒絕會恢復筆記、任務和連結，不會先破壞本機資料再做不完整的還原。

頁面離開不能等待 Worker 或鎖，因此在第一個 await 前同步留下復原副本；確認保存後才清除。
若頁面提早結束，下次開啟可用既有復原面板重試，仍使用原始冪等鍵。若瀏覽器連
localStorage 也拒絕寫入，只能保留記憶體副本，無法承諾關閉頁面後仍可復原。

## 錯誤政策

| 情況 | 初次提交 | 重播 |
| --- | --- | --- |
| 401 | 持久排入佇列 | 保留佇列、提示重新登入並停止本輪 |
| 網路錯誤、408、425、429、5xx | 持久排入佇列 | 保留佇列並停止本輪，避免跳過尚未建立的依賴 |
| 連續 5xx | 同上 | 第六次提示，之後仍保留，不再因重試次數而刪除 |
| 其他 HTTP 拒絕，例如 403、422 | 保存原請求為不可重播的復原輸入，仍拋出原拒絕；筆記操作回復受影響欄位 | 保存原請求為復原輸入，成功後退出重播；不自動重送 |
| 佇列持久化失敗 | 拋出儲存錯誤、保留復原副本 | 本機確認失敗時停止；下次以同一冪等鍵重播 |
| 筆記副本更新失敗但提交成功 | 保留提交結果，額外提示本機副本未更新 | 不把本機錯誤當成伺服器拒絕 |

## 範圍與後續

普通筆記與編輯器保存是第一批；後續任務、屬性、標籤、關聯與白板已接入同一個
寫入生命週期。完整邊界、錯誤契約與尚未遷移的範圍見 [領域寫入模組](./domain-writes.md)。

2026-09-13 已將永久拒絕的重播請求改為持久保留，契約見下方「離線重送遭拒絕」。
尚未被拒絕的相依佇列、bootstrap／membership 合併與多分頁仍需另批審核。

回歸測試集中在 `writeQueue.test.ts`、`noteWriter.test.ts`、
`useOverviewModeAutosave.test.tsx`、`failedWriteRecovery.test.tsx` 與 `apiHeaders.test.ts`：
驗證持久化等待、失敗復原、冪等鍵、HTTP 分類、重播順序、並行編輯、三方合併及頁面離開。

### 本次驗證（2026-09-08）

- 前端完整測試：160 個檔案、1,124 個測試通過。
- `tsc --noEmit`、ESLint、Astro production build 通過；建置仍有既有的大型 chunk 與空 docs collection 提示。
- 桌面 1280 × 900：建立「深模組重構驗證」、修改標題及正文、重新載入確認。
- 手機尺寸 390 × 844：中斷測試 API 連線、修改正文、等待保存、離線重新載入，正文保留。
- 恢復測試 API 後以重新整理觸發同步，佇列從 1 筆回到全部儲存；直接查詢隔離 PostgreSQL，
  確認 `fa8f7b29-bb68-4cc8-aff0-8ab1c325fd03` 已保存手機離線版本。
- 手機驗證使用瀏覽器 viewport，未將其當成 Android/iOS 真機關閉程序或儲存壓力測試。
- 開發伺服器熱更新及斷線切換期間曾出現本機佇列提示與 React 重複 key 紀錄；
  最後正常重新載入後無提示、無新增錯誤紀錄。未能穩定重現其來源，沒有將它列為已修復問題。

## 後端編輯操作（2026-09-13）

REST `PATCH /api/nodes/:id` 與 agent `updateNode` 現在共用
[`services/nodeUpdate.ts`](../../packages/backend/src/services/nodeUpdate.ts)。入口只解析欄位、可信任操作者與追蹤來源；
操作擁有當前狀態、權限、三方合併、父層循環檢查、逆向歷史、索引、backup／embed 與 dispatcher 意圖。
所有判斷在既有事件交易鎖內進行，dispatcher 在提交後啟動。只有請求明確提供的欄位會更新。

普通 PATCH 不允許把 class_tag 改成 content（422），避免內容編輯停用成員的政策。
舊歷史的身分逆向變更另由復原操作要求 principal_admin，成功增加 membership epoch。
`NodeUpdateError` 統一經 `httpError.ts` 映射；未知儲存錯誤不吞掉。更多驗證與限制見
[核心修復紀錄](../archive/core-design-fixes-2026-09-13.md)。

agent `updateNode` 改正文時必須帶 `base_markdown`（getNode 讀到的原文，D87）；沒帶就以
`invalid_args` 拒絕，不再拿 agent 手上的舊稿整篇蓋掉使用者後來的修改。正文照 App 編輯器的方式三方合併，
兩邊都改到的行在結果的 `conflicts` 回給 agent，並和 App 一樣記成 BODY_CONFLICT 進收件匣；
結果的 `markdown` 是存下的正文，也是下一次的 base。只改標題不需要 base。

同日後續已修正外層晚回滾的請求 claim：`updateNode` 自己的 savepoint 即使已成功 release，
更外層交易失敗也會使記憶體 claim 失效。重試沿用原鍵；若實際已提交但回應遺失，仍由資料庫
去重而不再寫入。領域入口不自行登記 rollback callback，詳見
[外層回滾與冪等修復](../archive/idempotency-rollback-fixes-2026-09-13.md)。

## 離線重送遭拒絕（2026-09-13）

`queued` 只確認本機持久化，不能預先保證伺服器之後接受。重送遇到永久拒絕時，
`writeQueue` 經 `writeRecovery` 將原請求標記為 rejected，保存成功才停止自動重送並通知。
`getPendingWrites` 只回傳仍待送出的列；recovery 讀取 rejected 列，保存原 body 和冪等鍵。
403 使用共用可讀說明。401、網路、限流和 5xx 保留原重試策略。

拒絕的輸入不保護 live mirror：membership 刪除、slim bootstrap 清除仍可移除不可讀的
筆記／任務／關聯／屬性；使用者輸入在獨立的 recovery 面板取回。面板對已拒絕項目只提供
複製與明確移除，不把原請求直接再排入佇列。保存失敗保留原列，舊回應／卡片也必須匹配
原請求，不能因備份還原重用了相同整數 ID 就改動另一份資料。

範圍不包含仍 pending 的所有 merge、尚未入列的編輯器草稿及多分頁資料庫協調。
見 [實測與剩餘限制](../archive/rejected-writes-fixes-2026-09-13.md)。

## 直接送出遭拒絕（2026-09-17）

`submitWrite` 對直接 HTTP 拒絕也呼叫 `preserveDirectRejection`，等待 worker 的
`storeRejectedWrite(request, reason)` 保存原請求與原鍵。資料從建立起就是 rejected，
不先排入 pending；同鍵只能指向同一方法、路徑及正文，不能覆蓋另一個請求。
仍拋出原伺服器錯誤，領域回復及表單保留的語意不變。呼叫端不自行保存另一份草稿協定。

等待落盤時先以帳號分區的 localStorage 作 best-effort 退出副本，標示 rejection／unpersisted。
磁碟成功後由 SQLite 副本取代；失敗明確提示尚未確認，原拒絕仍往上傳，不能變成 queued。
晚到 pagehide 不能將已知拒絕降回可重試。只保留 method／path／body／原鍵及可讀原因，不複製 headers 或 RequestInit。

卡片離開後從已接受內容重新開啟，被拒文字在復原面板取回；不默默蓋回遠端正文。
後來用新請求保存成功不自動刪掉舊拒絕副本。同帳號多分頁 SQLite 協調、尚未交接 writer 的草稿、
直接被殺掉的程序以及本機兩種儲存都失敗仍不能宣稱可靠。實測與範圍見
[直接拒絕復原盤點](../archive/direct-rejection-recovery-audit-2026-09-17.md)。

## 待同步文字與載入（2026-09-13）

既有筆記的 title／markdown 在 queue 仍 pending 時，由 `pendingNoteProjection` 按請求順序
投影到伺服器仍允許讀取的節點；metadata 保持遠端值，不因請求參照而保留撤權副本。
bootstrap、sync、membership、單筆讀取和本機冷啟動沿同一規則，空字串為有效編輯。
UI 使用 `persistBootstrap`／`applySync`／`persistRemoteNode` 的回傳投影；快取排程保存不算新提交確認。

桌／手已驗證 503 期間刷新、重載、繼續編輯與恢復後依序提交；API 完全不可達的重載仍會先落到登入頁，
因此沒有完成整條離線冷啟動 UI。pending 建立、其他領域與已提交寫入的晚到 GET 另驗，
見 [待同步文字審核](../archive/pending-note-text-fixes-2026-09-13.md)。

## 待同步新筆記與啟動（2026-09-15）

新增 `missingPendingNoteCreations` 處理已落盤 POST 的 content／canvas：遠端快照沒有新 ID 時，
從請求重建必要內容並套用後續文字，不保留相同 ID 的舊鏡像 metadata／關聯；後續 DELETE 不再重建。
worker 的 full／slim、sync 與冷啟動共用此契約；slim 清除進保存交易，失敗回滾。
`AppliedSyncDelta.pendingCreations` 是本機結果，在遠端刪除與相依清除後套用，不能由服務端欄位指定。
UI 使用回傳投影，因此今日啟動不必各自查 queue，也不因重開遺漏新筆記而再建立。

建立仍遵循原本 synced／queued／rejected 契約；自己輸入可見不代表伺服器已接受或授權。
新筆記 503、手機重開及續寫、桌面重開、恢復後單筆提交已驗證；其他領域相依建立、
跨裝置唯一、完全離線登入與同帳號多分頁仍有限制，見 [完整證據](../archive/startup-pending-create-fixes-2026-09-15.md)。
