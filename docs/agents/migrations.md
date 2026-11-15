# Migration 與升級規則（給代理）

何時讀：新增或修改 `packages/backend/db/migrations/*.sql`、改 `db.ts` 的 `migrate()`、改升級／回退腳本，或準備發布版本前。
（若另有 `docs/agents/release.md`，發布流程以它為準；本檔只管資料庫與升級路徑。）

## 為什麼要有這些規則

自架的人只跟發布版本，升級＝把映像換成新版再重啟，**新版後端開機時自己跑 migration**（`migrate()`：advisory lock、每個 migration 一個交易）。
migration 只能往前：回退映像不會讓資料庫退回去。所以安全網放在三處：升級前備份、舊程式拒絕碰新資料庫、升級路徑演練。

| 機制 | 位置 |
| --- | --- |
| 升級前一定有剛做好的備份；失敗就什麼都不動 | `scripts/upgrade.sh`、`docker/backup/run.sh once` |
| 回退＝還原升級前備份 + 切回舊映像，需輸入 `yes` | `scripts/rollback.sh`（`upgrade.sh rollback`） |
| 資料庫有程式不認得的 migration → 拒絕啟動 | `db.ts` `DatabaseNewerThanCodeError`、`index.ts` 開機 |
| 從上一個發布版本升到目前的演練 | `scripts/upgrade-drill.sh` |
| 使用者文件 | [upgrade.md](../self-host/upgrade.md) |

## 規則

1. **發布版本之間必須能直接升級**：任何資料庫停在上一個發布版本（甚至更早的支援版本，見 release notes）的狀態，
   新版 `migrate()` 都要能一路跑完。不要求跳過發布版本；不得要求使用者先升到某個中間版本，除非 release notes 明寫。
2. **只能新增，不可刪除或改名既有 migration 檔**。`schema_migrations` 記著已套用的檔名；檔案不見，已升級過的資料庫會被判成
   「比程式新」而拒絕啟動。要修正舊 migration 的錯，寫一個新的。`scripts/upgrade-drill.sh` 第 1 步會檢查。
3. **新增 migration 就要更新 `db/schema.sql` 的 `schema_migrations` 種子**（`schemaDrift.test.ts` 守門）。
4. **破壞性資料變更**（刪表／刪欄／改寫或搬移使用者內容、DROP、不可逆的 UPDATE）：
   - 先有使用者（repo 擁有者）明確同意；
   - 在 SQL 檔頭註解寫清楚刪什麼、為什麼安全，並在 release notes 的「需注意」標出；
   - 若改寫筆記內文或標題，依[還原演練](deploy.md)寫 `-- drill: allows note-bodies`（或對應名稱），演練才不會當成失敗；
   - 升級腳本的升級前備份是唯一的回頭路，所以這類 migration 不要拆成「先刪後補」跨兩個發布版本。
5. **拒絕啟動不可誤觸發**：只有「資料庫已套用、但這個版本沒有對應檔案」才拒絕。資料庫落後（新程式碰舊資料庫）一律照常 migrate。
   拒絕時只印白話說明並以結束碼 1 退出，不改任何資料。
6. 每個 migration 在自己的交易內完成，不用 `CONCURRENTLY` 或自帶 `BEGIN/COMMIT`（`migrate()` 已包交易）。
7. 長時間回填要能在 `statement_timeout = 0` 下跑完（`migrate()` 已設），並在 PR 說明大資料表的預估時間。

## 發布前要做

- 跑 `scripts/upgrade-drill.sh`（Docker），基準預設是最新的 `v*` tag；還沒有任何發布版本時用腳本裡的 `BASELINE_COMMIT`。
  第一個正式 tag 出現後它會自動改用該 tag，不需改腳本；之後每個發布前都對「上一個 tag」跑一次。
- 動了升級／回退腳本：`scripts/upgrade-selftest.sh`（假 docker，不需 Docker 與 Postgres）。
- 動了拒絕啟動邏輯：`cd packages/backend && npx vitest run src/test/migrationNewerDb.test.ts`（資料庫部分需 `*_test` 資料庫）。
- release notes 列出：新增的 migration 編號、是否有破壞性變更、是否需要先升到哪個版本。

## 與 VPS 部署的關係

擁有者自己的 VPS 流程（[deploy.md](deploy.md)）不經過 `upgrade.sh`，但同樣受拒絕啟動保護：
回滾映像後若資料庫已含新 migration，舊後端會拒絕啟動；要先用部署前備份還原資料，再切回舊映像（deploy.md「回滾」）。
