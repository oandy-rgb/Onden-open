# 同步回應的快照修復

> 狀態：歷史紀錄（最後確認 2026-11-01）

日期：2026-09-13。開始時基線為 `719ce80` 加既有未提交工作；本批保留其他重構。
工作期間 HEAD 由外部更新為 `0e93619`，包含本批程式變更；本次沒有執行 git commit 或回退該提交。
案例：PER-03／PER-04、GAP-04 的單次回應部分。全功能盤點仍未完成。

## 已重現的問題

同步先計算可讀集合，再分別向 pool 查事件、epoch、正文、屬性和關聯；任務查詢也沒有共同快照。
用兩條 PostgreSQL 連線在「已取得可讀集合」後暫停讀取，另一條連線提交撤權和內容更新：

- POST `/sync` 及 `/sync/nodes` 都能用舊集合帶出新正文、屬性、任務和關聯。
- 再把暫停點放在角色政策與 scope 關聯查詢之間：先前角色允許但 human scope 不符；
  同一寫入交易收緊角色政策並加入 scope 標籤。舊實作把兩份讀取拼起來，帶出一筆
  **在變更前後都不應可讀**的節點。測試同時保有 token 與 human scope 的交集限制。
- membership 原先的前後版本核對在交錯修改時會要求重試；該行為本身不是內容洩漏。
  本批改成直接回傳單一快照的頁面，不再為頁內的並行提交重試。

這是已重現的授權／資料一致性缺陷，可能暴露撤權後才加入的文字，優先於外觀調整。
沒有正式環境已遭讀取的證據。測試注入可信任 ActorCtx，並未繞過正式 auth 來測 bearer HTTP：
正式 bearer 憑證仍被入口限制在 MCP；scope 案驗證的是底層組合規則。

## 設計取捨與遷移

| 草圖 | 呼叫與需要理解的知識 | 代價 |
| --- | --- | --- |
| 回應前後核對並重試 | 每個入口須把所有 read-set／projection 查詢納入重試，確認版本涵蓋每種可讀集合變更 | 新增通道容易漏包，內容編輯也可能觸發整組重查；仍要另處理 ActorCtx |
| `withReadSnapshot(async () => …)`，本批採用 | 入口選一次快照範圍，helper 用既有 `q()`；DB 保證範圍內讀取固定版本 | 一次回應占用同一連線，各通道依序讀；只限本次 DB 讀取 |

`db.ts` 新增 `withReadSnapshot`，使用 `REPEATABLE READ READ ONLY`，重用既有交易清理、
COMMIT 確認與通知機制。已有任何外層交易時拒絕開始快照，不能默默降為 READ COMMITTED，
也不為巢狀呼叫再占一條連線。普通 `withTransaction` 的加入外層行為保持不變。

已遷移：

- GET／POST `/sync`：同一份角色政策、scope 關聯、事件頁、membership epoch、節點、屬性、關聯、任務及 workspace。
- GET `/sync/membership`：單頁 ids 與 epoch；`expected_epoch` 不符仍回 `retry_required`。
- POST `/sync/nodes`：可讀集合和完整 projection；edges／tasks 仍檢查兩端可讀。
- `visibleNodeIdsForActor` 改用 `q()`，使其加入呼叫者的快照；沒有更改 SQL 的允許／拒絕規則。
  token／human 關聯及 tasksStore 本來就用 `q()`，沿用其介面。

因此 caller 不再管理每個通道的獨立版本核對；新增通道仍須使用 `q()` 並放在既有快照範圍。
未新增同步服務、授權旗標或版本語言。前端只有更正一段跨頁核對註解，行為與 wire shape 不變。

## 可觀察契約

若撤權與正文變更在第一個快照查詢之後提交，進行中的回應可回傳舊內容、舊 epoch 及已掃描事件。
它不得帶出稍後才提交的內容。下一次請求重新核對，排除失去權限的內容；legacy known[] 路徑
仍回傳撤權刪除，membership 舊 expectation 明確要求重試，by-id 不能重新取得不可讀資料。

空事件頁仍保留輸入 `since`。非空頁只確認該頁掃描的最後事件；快照之後的普通編輯留待後續同步。
一般讀取錯誤透過既有 API 錯誤映射，不回傳半份內容或假成功。唯讀範圍若意外寫入，PostgreSQL 拒絕並回滾。

## 實際驗證

全部 DB 案使用新建隔離庫 `onden_sync_snapshot_test`，由專案 schema 建立。
Hono 真實路由與 PostgreSQL 查詢執行；測試只控制 workspace、ActorCtx 和 barrier 排程。
另條連線提交實際狀態及事件，不用延遲時間猜測交錯，也不拿 mock 回傳值冒充授權結果。

| 驗證 | 結果 |
| --- | --- |
| 修正前競態 | 兩個內容入口及分段 role／scope 案均重現不應送出的新內容；另有 membership 新契約的預期失敗 |
| 新增 syncSnapshot 7 案 | delta／by-id 撤權、membership epoch、普通編輯下一頁、重新授權、頁內建立、角色與 scope 交錯皆通過 |
| 新增 readSnapshot 4 案 | 外部提交後仍讀舊值、拒絕寫入並釋放連線、拒絕巢狀降級、吞 SQL 錯誤後不假成功皆通過 |
| 後端專項 | 11 檔／107 項通過，包括既有游標、政策等價、membership、結構同步及外層回滾／COMMIT 遺失 |
| 前端同步契約 | membershipReconcile／useAppDataSync 共 2 檔／20 項通過 |
| 完整後端 | 209 檔／1,716 項全通過，0 跳過，124.15 秒 |
| 靜態與建置 | backend TypeScript、lint、build 通過 |

第一輪完整回歸有 5 項 classTagScope 單元測試失敗：其 fixture 依 pool／q 決定回傳 ids 或 policy，
移至共同交易後因此拿錯假資料。已改成依 SQL 查詢提供資料，8 項全通過，沒有為 fixture 改正式授權。
最終完整回歸全部通過。此次沒有瀏覽器、真機、登入端到端或真實本機 mirror 清除驗證。

本機執行紀錄（`/tmp` 不是永久保存）：

- `/tmp/onden-sync-snapshot-red.log`：修正前重現，亦記錄當時測試清理遇 append-only 保護；已改為只清 fixture 節點。
- `/tmp/onden-sync-snapshot-targeted.log`、`/tmp/onden-sync-snapshot-class-tags.log`：關聯測試。
- `/tmp/onden-sync-snapshot-backend-first.log`、`/tmp/onden-sync-snapshot-backend-full.log`：第一次與最終完整回歸。
- `/tmp/onden-sync-snapshot-frontend.log`、`/tmp/onden-sync-snapshot-types.log`、`/tmp/onden-sync-snapshot-lint.log`、`/tmp/onden-sync-snapshot-build.log`。

## 仍未完成

GAP-04 保留「部分」，不以本次 11 個新增測試宣告整體同步正確：

- **ActorCtx 新鮮度**：角色與 allowlist 在快照之前由 auth 取得；native actor 還有既有快取。
  本批固定的是此 ActorCtx 下的資料庫政策／關聯／內容，不保證角色降級與憑證撤銷和內容共用快照。
- **跨請求協定**：membership 多頁、最後確認、by-id 及本機提交不是同一交易。
  相同 membership epoch 不代表節點建立／刪除沒有改變；完整跨頁與事件游標交接仍須專項驗證。
- **其他讀取入口**：bootstrap 與其他 pool 查詢未遷移，不能把本契約推及全專案。
- **裝置行為**：本批沒有重新驗證 SSE 遺失、離線冷啟動、重連、本機撤權隔離、手機或雙裝置。
- **效能**：未做代表性大型工作區量測，沒有宣稱快照化更快；讀取期間會持有連線與 MVCC 快照。

邊界決定同步寫入 [AGENTS.md](../../AGENTS.md)，盤點見 [完整清單](../research/full-feature-audit.md)。

後續進度：同日下一批已在同步快照內重讀 actor／token 授權，並驗證 session 解析與 native 快取入口，
見 [操作者快照修復](actor-snapshot-fixes-2026-09-13.md)。以上保留第十三批的覆蓋時點。
