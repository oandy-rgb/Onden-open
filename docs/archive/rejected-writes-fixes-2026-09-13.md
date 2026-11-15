# 離線重送遭拒絕時保留輸入

> 狀態：歷史紀錄（最後確認 2026-11-01）

日期：2026-09-13。延續 membership 審核，本批處理 NOTE-03、DATA-08、PER-03、SYS-03 的一個完整案例：
已持久化的離線修改在重連後被永久拒絕，輸入仍可取回、停止重送，且不能讓已撤權筆記繼續出現在可讀集合。
沒有開子代理；保留前幾批未提交變更。本批產品修改限前端，沒有更動後端授權政策。

## 缺陷與行為改變

舊 `writeQueue.drain()` 收到永久拒絕會刪除待送請求，只顯示 discarded toast。
若本機內容副本接著因撤權清除，尚未被伺服器接受的文字也可能失去唯一持久副本。登錄為 **GAP-18**。
新回歸在舊實作確實失敗，記錄 `/tmp/onden-rejected-writes-red.log`。

現在永久拒絕會把原請求保留為復原輸入，持久化後才退出 pending 計數與自動重送。
重載後可讀取、複製或明確移除本機副本；不提供原樣重送被拒請求的按鈕。
401、網路失敗、408／425／429 和 5xx 沿原有登入／重試策略，沒有改成永久拒絕。

實測另修正三項回饋問題：

- 403 透過共用 `writeErrors` 顯示「目前沒有權限進行這項修改」，不直接展示內部角色與節點 ID。
- 筆記標題若已是正文第一行，復原預覽和複製內容不再重複加上標題。
- 頂欄零筆 pending 不能證明全部保存成功，連線圓點改成只表示「已連線」。

## 設計比較與責任

比較過兩種設計：先複製到既有 localStorage recovery 再刪 SQLite queue；以及在原 SQLite 列記錄拒絕狀態。
選第二種，避免需要理解兩份儲存的提交順序、重複資料與清理失敗。沒有新增儲存平台或另一套復原 UI。

```ts
// Queue only decides that the server has permanently refused this request.
await preserveRejectedWrite(write, writeFailureMessage(error));

// The recovery surface waits for local persistence before hiding the entry.
await removeRecoveryWrite(entry.id);
```

- `localDb`／worker 擁有列狀態、舊資料庫 migration、SQLite 匯出保存與失敗回復。
  `rejectPendingWrite(write, reason)` 保留原 body、method、path 和冪等鍵；`rejection IS NULL` 才參與 replay。
  拒絕及移除以原請求核對身份，避免備份更換後整數 ID 重用讓舊回應／卡片改動另一筆輸入。
- `writeRecovery` 統一既有未確認輸入與 SQLite 拒絕輸入的穩定 UI snapshot。
  後者不再複製到 localStorage；UI 不需知道資料表或先複製再清除的步驟。
- `writeQueue` 沿既有錯誤分類，在永久拒絕分支等待保存；保存失敗中止本輪 drain，保留原 pending 列。
- `FailedWriteRecovery` 只處理閱讀、複製、收合和等待移除結果。移除失敗保留卡片，忙碌時停用移除按鈕。
  手機面板限制高度、允許捲動、按鈕至少 44px 高；收合後顯示復原輸入數量，不刪除或重送。
- 撤權隔離和 slim bootstrap 仍可清除普通內容副本。已拒絕請求不再保護 mirror；
  recovery 只保留原請求，不另外下載或補存不可讀的伺服器內容，也不成為授權依據。

呼叫者現在只需理解「保存被拒輸入」及「移除本機副本」，不必各自安排 queue 刪除、第二份持久化與通知。
決定同步記在 [AGENTS.md 第十六批](../../AGENTS.md)。

## 自動驗證

- 新增 `rejectedWritePersistence.test.ts` **10 項**：真實 sql.js 和正式 worker RPC，模擬 IDB 保存邊界；
  匯出 bytes 後建立全新 worker 重開，驗證保存／拒絕／移除持久化、失敗回復、舊 schema、
  stale success 不刪拒絕副本、backup ID 重用守衛、撤權清除各 mirror channel 與 slim bootstrap。
  這不是 OPFS、資料夾 adapter 或真機儲存驗證。
- `writeQueue.test.ts` **26 項**：拒絕先持久化、不再 replay，保留原冪等鍵；保存失敗停止後續請求。
  原有登入、限流及 transient 保留策略一起回歸。
- `failedWriteRecovery.test.tsx` **13 項**：重開載入、複製、拒絕不提供 retry、等待移除與失敗保留，
  標題去重和收合／展開。此三個檔共 49 項納入完整前端回歸。
- **完整前端：181 檔／1,298 項通過，0 跳過**，43.61 秒。
  `/tmp/onden-rejected-writes-full-final.log`。新增合計 18 項；回歸數量不代表功能完成率。
- 先前一輪全套只因 `TasksModeError` 還期待原始 403 文字而失敗，已同步改為共用可讀說明，
  保留它對伺服器真實狀態重新載入的斷言；上述完整回歸是在修正後執行。
- 最後修正頂欄文字後，`AppTopbarPendingSync` **4 項再次通過**；TypeScript、lint、build 也再次通過。
  日誌 `/tmp/onden-rejected-writes-topbar.log`、`-tsc.log`、`-lint.log`、`-build.log`。
  build 仍有既有大型 chunk 與 docs collection 提示，沒有宣稱效能改善。

前端 pretest 的通用 DB 提醒不代表本次前端測試有跳過。這一批沒有重跑全後端整合測試；
上一批 1,748 項結果見 [membership 紀錄](membership-pages-fixes-2026-09-13.md)，不算成本批新增驗證。

## 真實瀏覽器與伺服器核對

使用隔離 `onden_import_audit_test`、既有測試 editor 帳號和 `127.0.0.1:5100`。
透過快速捕捉建立專用筆記「0913 拒絕修改復原實測」，線上保存基準正文後：

1. 停止測試後端，在編輯器輸入中文追加內容，看到「1 筆變更等待同步」。
2. 僅對該測試筆記套上 read／write_node 限 admin 的測試標籤。政策 fixture 用受測試 DB 名稱與筆記 ID
   限定的 SQL 設置；這不是在驗證標籤設定 UI 或領域事件寫入。
3. 重啟後端並按「立即同步」，正式寫入路由回 403；復原面板保留原輸入，普通筆記從可讀集合移除。
4. 重載桌面後副本仍在。暫時放寬這一筆的政策，伺服器讀出的正文仍只有原基準，沒有混入被拒文字。
5. 再做一次斷線追加與撤權，核對新的 403 顯示可讀中文；桌面與手機都能複製第二輪完整原文。
6. 手機重載仍保留兩筆；收合後可返回筆記清單，重新展開仍可複製，沒有拒絕請求的重試按鈕。

桌面 **1440×900**，手機 **390×844 viewport**。手機 clientWidth／scrollWidth 都是 375（扣除捲軸），
面板位於 y=16、底部約 817，沒有水平溢出；收合入口位於底部導覽列上方。
兩筆長內容預設會佔用大部分手機高度，因此提供可保留資料的收合方式。本次不宣稱真機／軟鍵盤驗收。

最後直接核對 PostgreSQL：原正文仍為「0913 拒絕修改復原實測」加「這段已在伺服器保存。」；
該筆記只有 **1 筆 NODE_CREATED，沒有 NODE_UPDATED**。已解除測試限定關聯，保留測試筆記及本機副本，
關閉本輪測試頁並停止測試伺服器。刻意斷線和 403 的 console 訊息屬本次故障注入。
第一次保存的舊卡片仍有修正前原始錯誤文字；沒有回填既有拒絕原因。

## 剩餘限制

GAP-18 本案例已修，GAP-04 **仍是部分**。完整清單仍為 163 項：4 已盤、104 部分、43 待盤、12 需環境。

- 一般尚未被拒絕的 pending 修改，在 bootstrap／membership 的合併和跨分頁重試建立仍需另批驗證。
- 編輯器尚未入列的記憶體草稿、真正雙裝置、同源多分頁 SQLite 副本協調不在本批保證內。
- 本機保存若持續失敗，無法保證重載後記得「已遭拒絕」；保留原本已持久化的 pending 請求，
  下次仍可能重新詢問伺服器。不能把記憶體標記當成 durable 確認。
- 舊未確認輸入的 localStorage 最佳努力保存契約未全面重寫。復原清單也不是完整操作歷史或伺服器備份。
- 本批只替拒絕／移除加入請求身份守衛，不宣稱所有在途成功回應與備份置換都已協調。
- 本機拒絕快取主要在面板載入／本頁操作時刷新；備份切換、多分頁更新與真機重新啟動須另驗。

下一個適合的案例是「仍有 pending 修改時收到 membership／bootstrap」，先追蹤合併與輸入保存順序，
不把本批拒絕副本的保證延伸成全部離線同步已完成。
