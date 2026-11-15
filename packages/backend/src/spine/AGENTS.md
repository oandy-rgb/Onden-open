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
| 把別處的版本歷史（帶原始時間的內文版本）寫進新工作區 | `importedHistory.ts` 的 `appendImportedVersions`（只准擁有者；驗雜湊、去重） | 靠審查；契約 [backup-move.md](../../../../docs/architecture/backup-move.md) |

守門測試在 `src/test/guards/`。
