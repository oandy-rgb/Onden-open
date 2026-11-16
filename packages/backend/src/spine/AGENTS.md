# spine/

寫入、授權、事件與交易的共用機制。全域規則見[根目錄 AGENTS.md](../../../../AGENTS.md)與 [backend-rules.md](../../../../docs/agents/backend-rules.md)。
**`spine/` 不得 import `services/`**（ESLint 擋）；spine 需要的規則放在 `spine/`。

| 要做的事 | 一律用 | 守門 |
| --- | --- | --- |
| 寫入狀態並留下事件 | `mutate.ts` | ESLint；規則 `docs/agents/backend-rules.md` |
| 寫一個人自己的資料或設定（偏好、複習進度、已讀、訂閱設定、行事曆），不留事件 | `mutate.ts` 的 `mutatePersonal`（同一把鎖、同一個交易、同一個來源標記；測試中 `q()` 在它之外寫已標記的個人資料表會丟錯，例外用 `allowUnstampedWrite`，次數只減不增） | `stampedWrites.guard.test.ts` |
| 判斷操作者能不能做 | `authority.ts`（`requirePerson` 是「只准人」的唯一拒絕） | `dup-b2-responses.guard.test.ts` |
| 事件鎖後重讀當前 actor | `currentActor.ts` | 無專屬守門，靠審查 |
| 工作區事件附加鎖 | `eventLock.ts` 的 `lockEventAppend` | `dupSweep.guard.test.ts` |
| 系統 actor | `systemActor.ts` | `systemActor.guard.test.ts` |
| 交易與 savepoint | `eventTransaction.ts`、`txHooks.ts` | 無專屬守門，靠審查 |
| 重試去重（冪等鍵） | `idempotency.ts` | 無專屬守門，靠審查 |
| 兩個節點各自改過的、帶來源標記的資料合成同一個結果（單位、列、欄位、JSON 鍵、跨列規則；純函式，還沒接線） | `stampedMerge/`（說明在它的 README.md；證明在 `test/stampedMergeSim.test.ts`；下一批「修改包」才有產品呼叫者） | `test/stampedMerge.test.ts`、`test/stampedMergeSim.test.ts` |
| 把別處的版本歷史（帶原始時間的內文版本）寫進新工作區 | `importedHistory.ts` 的 `appendImportedVersions`（只准擁有者；驗雜湊、去重） | 靠審查；契約 [backup-move.md](../../../../docs/architecture/backup-move.md) |
| 把一個工作區連同每筆的來源標記原樣寫入**空的**資料庫（加入第二台裝置的快照） | `stampedImport.ts`（唯一入口；只有 `services/stampedJoin.ts` 呼叫；沒有 `sync_join` 的加入中狀態一律拒絕；本機 `next_seq` 不動） | `stampedImport.guard.test.ts` |
| 收下另一個節點的修改包（content_nodes 的單位，一包一個交易；拒收規則與錯誤碼見 `stampedMerge/README.md`「修改包」） | `stampedImport.ts` 的 `applyChangeBundle`（讀：`../services/stampedBundle.ts` 的 `readChangeBundle`；格式與切點：`stampedBundle.ts`；資料形狀版本：`syncDataShape.ts`） | `stampedMergeCallers.guard.test.ts`、`stampedBundle.guard.test.ts` |
| 收下別台的標記前檢查時鐘 | `stamps.ts` 的 `assertForeignClockWithinBound`（超前 10 分鐘整批拒收） | 無專屬守門；整合測試 stampClockBound 驗證 |
| 匯出前補沒有任何標記的列（開機種子寫的）的創世標記 | `stamps.ts` 的 `stampUnstampedRowsAsGenesis`（只有 `services/stampedSnapshot.ts` 呼叫） | 整合測試 stampedSnapshotTwoProcess 驗證 |
| 哪些表被快照帶走、怎麼讀怎麼寫 | `syncClasses.json` 的 `snapshot` 欄位＋`snapshotTables.json`（匯出、匯入、摘要都只讀這兩份） | `syncClasses.guard.test.ts`；整合測試 syncClasses 驗證兩份清單一致 |

守門測試在 `src/test/guards/`。
