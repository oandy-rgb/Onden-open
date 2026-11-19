# 一致的錯誤與保存契約

> 狀態：現行（最後確認 2026-11-18）
> 涵蓋：packages/backend/src/httpError.ts, packages/frontend/src/lib/data/writeLifecycle.ts, packages/frontend/src/lib/data/writeQueue.ts, packages/frontend/src/lib/data/writeErrors.ts, packages/frontend/src/lib/data/backgroundWrite.ts

何時讀：改前端保存／離線佇列／錯誤處理、依成功才關閉的表單，或後端 HTTP 錯誤映射之前。
原文自 2026-10-22 之前的 AGENTS.md 逐字搬入，只調整相對連結與標題層級。

## 一致的錯誤與保存契約

- 設計操作時先考慮能否消除不必要的失敗情形。例如契約是「確保關聯不存在」，在完成必要授權後，
  關聯本來就不存在可以是正常結果；這與保證刪掉一筆既有資料的操作不同，不得擅自改變既有 API 語意。
- 將錯誤按處理方式集中：能在擁有完整資訊的層安全恢復就恢復，需要呼叫者選擇的情形則明確回傳或拋出。
  「消除錯誤」不能用來吞掉授權失敗、儲存失敗、資料損壞或未知例外；恢復必須保有原本的行為保證。
- 後端共用錯誤由 `packages/backend/src/httpError.ts` 映射為 API 回應。
  路由只捕捉自己確實能處理的清理、衝突或部分成功情形，其他錯誤向上傳遞。
- 前端沿用領域 writer、`writeLifecycle.ts`、`writeQueue.ts` 與 `writeErrors.ts`。
  新功能不得各自發明 HTTP 分類、通知、重試或離線成功的定義。
- 每次保存先寫成佇列的一列（`writeQueue.recordWrite`），之後才更新本機副本、才送出；頁面沒有任何事件就結束，
  重開時寫入不是在伺服器就是在會送出或看得到的地方（[筆記寫入：送出前先記下](../architecture/note-writes.md#送出前先記下2026-11-18)）。
- 保存確認必須來自伺服器接受，或離線佇列已持久化；兩者在 UI 上須能區分。
  只有記憶體更新不能顯示已保存，待同步也不能顯示已同步。
- 區分永久拒絕、登入失效、可重試失敗與本機儲存失敗，採用既有對應策略。
  回復只影響本次操作，保留較新的修改及可恢復輸入。
- 已收到提交確認後，本機副本更新失敗不能把整次寫入改判成未提交，或誘發重複建立。
- 已收到提交確認後，確認之前讀的伺服器回答不能把它蓋掉：寫入回應帶事件位置，任何帶資料列的回答讀的位置低於
  這台裝置確認過的最高位置，就整份不套用、再問一次（`lib/data/writePositions.ts` 的 `takeAnswer`，見
  [decisions-core-sync.md](decisions-core-sync.md)）。回答連續被拒時，下一筆寫入會先等一份回答被收下或同步回合結束
  才送；寫入已在本機佇列，不算保存失敗，頁面關閉時的 keepalive 不等。
- 依賴成功才能關閉、清空或跳頁的表單必須等待結果；失敗保留輸入。同一錯誤避免重複通知。
  `backgroundWrite` 僅用於不依賴成功後續動作的事件處理。
- 手機、桌面、快捷操作與不同資料檢視共用保存和錯誤契約；布局可以不同。

錯誤設計依據：作者的 [Exception Handling](https://web.stanford.edu/~ouster/cgi-bin/cs190-spring16/lecture.php?topic=exceptions)
講義；具體保存與授權語意以 Onden 的契約為準。
