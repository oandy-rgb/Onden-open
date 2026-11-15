# 外層回滾與請求冪等修復（2026-09-13）

> 狀態：歷史紀錄（最後確認 2026-11-01）

本批處理 GAP-06／SYS-05：操作自己的 claim wrapper 已返回成功，外層交易才回滾時，
資料庫中的 key 消失，但同一請求記憶體中的 claimed 仍為 true。接著重試會漏存 key，
使後續重送失去去重保護。修改前用真實 PostgreSQL 重現 root transaction、外層 savepoint、
已 release 子 savepoint 三種情況；三案均在「有效重試後應有一筆 key」得到 0 而失敗。
對照案例「child 失敗不清掉 parent 的 key」原本通過。

## 設計與實作

比較兩種方案：

| 方案 | 呼叫方式與需要理解的事 | 取捨 |
| --- | --- | --- |
| 每次 claim 查 DB，或由 caller 在 catch 重設 | 每個操作須辨識目前交易／savepoint 邊界及 key 是否仍存在 | 重複處理生命週期，容易再漏掉外層回滾或錯清 parent 的 claim |
| 既有交易層管理結果通知（採用） | 領域維持 `updateNode(...)`、`restoreEvent(...)`；claim 內部登記 `afterRollback` | 只調整共用機制，實際 SQL 單位擁有快取失效時機 |

`db.withTransaction`／`withSavepoint` 將 SQL 完成與錯誤清理一起放在 `withTxHookScope` 中。
已 release 的 child 將 commit 與 rollback callbacks 都移交 parent；root 確認 COMMIT 才通知成功。
失敗在清理嘗試後使本單位的記憶體判斷失效，再向 caller 拋出原錯誤。

`withIdempotencyClaim` 只在本次實際取得 key 時登記回滾失效，不再靠自己的 catch 猜測 DB 是否回滾。
因此晚於 wrapper 的外層回滾也適用，child 拒絕則不能清除建立在其 savepoint 之前的 key。
一般 mutate、nodeUpdate、eventRestore 自動沿用，路由與領域不增加清理 callback。

`afterRollback` 的用途是同步失效記憶體，不能執行補償寫入或外部副作用。COMMIT 回應不明時，
資料可能已提交；下一次同鍵 INSERT 會詢問 PostgreSQL，而不是由記憶體判斷可以重做。
callback 自己出錯只記錄，不得把已提交改成失敗，或蓋掉原本交易失敗。

另補上同一保存確認邊界的缺口：若 caller 吞掉 SQL 例外，PostgreSQL 可能把 COMMIT 回成
`ROLLBACK`。交易層現在拒絕這種結果、丟棄成功通知，讓既有 API 錯誤流程處理。
SQL 清理失敗的損壞連線驅逐、savepoint AggregateError、授權、事件與 outbox 契約維持原樣。

## 實際驗證

隔離資料庫：`onden_idempotency_rollback_test`，由目前 schema 建立。未修改日常資料庫。

- 修改前：4 案中 3 個晚回滾案例失敗，1 個 parent 保護對照通過；
  `/tmp/onden-idempotency-rollback-red.log`。
- 修改後專項：5 個檔案、43 項全通過；`/tmp/onden-idempotency-rollback-targeted.log`。
- 新增 12 個 PostgreSQL 案例，涵蓋三種晚回滾、parent／child claim、deferred constraint 在 COMMIT 才失敗、
  COMMIT 實際回 ROLLBACK、已真實提交後注入回應遺失、損壞 rollback 連線被驅逐後重試、
  前一交易已提交而後一交易失敗、實際 nodeUpdate／eventRestore、SQL 清理與 caller 恢復的順序。
- 真實提交後遺失回應案例：DB 保留一筆 key、一筆成功事件、一次內容變更；同請求重試得到
  IdempotentReplay，沒有第二次寫入。注入的是 driver 回應錯誤，SQL 與 COMMIT 都實際執行。
- 新增 6 個通知生命週期案例及 1 個 claim 對照：通知交接／逆序失效、child 隔離、autocommit、
  callback 例外，以及「捕捉錯誤但沒有 SQL 回滾」不能清除仍存在的 key。
- 完整後端：207 個檔案、1,705 項全通過，0 skipped，117.86 秒；
  `/tmp/onden-idempotency-backend-full.log`。TypeScript、lint、backend build 通過。

## 範圍

GAP-06 的 managed transaction／savepoint 契約已驗證。此批沒有更改 UI，因此沒有重新做桌面／手機
瀏覽器或前端回歸；上一批的 UI 結果不能當作本批新測試。

同一個 request holder 與同一 PG client 的 savepoint 分支仍須循序等待。
不支援繞過共用 owner 手寫 BEGIN／ROLLBACK，或把未等待的工作留在結束後的交易情境。
多個獨立交易不會因此自動全有全無；已提交的第一筆仍可能讓整個請求重播被去重，複合領域操作
必須自行選擇一個完整外層交易。這也不解決前端跨重載 online 重試（GAP-05）或同步快照（GAP-04）。
